import type { MixSettingsInfo } from '@playarr/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { CatalogStore } from '../catalog/store.ts';
import type { History } from '../mixes/history.ts';
import { MixError, type Mixes } from '../mixes/mixes.ts';
import { MIX_KINDS, MIXES_KEY, readMixSettings } from '../mixes/settings.ts';
import { validTimeZone } from '../mixes/time.ts';
import { PlaylistError } from '../playlists.ts';
import { requireLocal } from './settings.ts';

const playsInput = z.object({
  plays: z
    .array(
      z.object({
        trackId: z.number().int().nonnegative(),
        recordingId: z.string().min(1).max(100),
        at: z.iso.datetime({ offset: true }),
        hour: z.number().int().min(0).max(23),
        weekday: z.number().int().min(0).max(6),
        seconds: z.number().min(0).max(24 * 3600),
        skipped: z.boolean(),
      }),
    )
    .max(500),
});

const settingsInput = z.object({
  enabled: z.partialRecord(z.enum(MIX_KINDS as [string, ...string[]]), z.boolean()).optional(),
  length: z.union([z.literal(25), z.literal(50), z.literal(75), z.literal(100)]).optional(),
  adventurous: z.number().min(0).max(1).optional(),
  blastDays: z.union([z.literal(30), z.literal(90), z.literal(180), z.literal(365)]).optional(),
  genreMixes: z.number().int().min(0).max(4).optional(),
  decadeMixes: z.number().int().min(0).max(4).optional(),
  recordHistory: z.boolean().optional(),
  analyzeLibrary: z.boolean().optional(),
  timeZone: z
    .string()
    .refine((tz) => !!validTimeZone(tz), 'Unknown time zone')
    .optional(),
});

const KEY = /^[a-z]+(-[a-z0-9]+)?$/;

async function handle(reply: FastifyReply, fn: () => unknown) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof MixError || err instanceof PlaylistError) return reply.code(err.status).send({ error: err.message });
    throw err;
  }
}

/** Listening history in, generated mixes out, and Settings → Mixes. */
export function mixRoutes(
  app: FastifyInstance,
  deps: {
    mixes: Mixes;
    history: History;
    store: Pick<CatalogStore, 'appSetting' | 'setAppSetting'>;
    /** The server can measure sound (ANALYSIS=on). */
    analysisAvailable: boolean;
    /** Measure the whole library's sound, when that setting is turned on. */
    analyzeLibrary: () => void;
  },
) {
  const { mixes, history, store } = deps;
  type Tz = { Querystring: { tz?: string } };
  type KeyTz = Tz & { Params: { key: string } };
  const tz = (q: { tz?: string }) => validTimeZone(q.tz);

  /** Songs heard on a device. Ignored (but accepted) when history is turned off. */
  app.post('/api/plays', async (req, reply) => {
    const parsed = playsInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid plays' });
    if (!readMixSettings(store).recordHistory) return reply.code(202).send({ recorded: 0 });
    return { recorded: await history.record(parsed.data.plays) };
  });

  app.get<Tz>('/api/mixes', (req) => mixes.list(tz(req.query)));

  app.get<KeyTz>('/api/mixes/:key', (req, reply) =>
    handle(reply, () => {
      if (!KEY.test(req.params.key)) throw new MixError('Unknown mix', 404);
      return mixes.get(req.params.key, tz(req.query));
    }),
  );

  app.post<KeyTz>('/api/mixes/:key/regenerate', (req, reply) =>
    handle(reply, () => {
      if (!KEY.test(req.params.key)) throw new MixError('Unknown mix', 404);
      return mixes.regenerate(req.params.key, tz(req.query));
    }),
  );

  app.post<KeyTz>('/api/mixes/:key/save', (req, reply) =>
    handle(reply, async () => {
      if (!KEY.test(req.params.key)) throw new MixError('Unknown mix', 404);
      return reply.code(201).send(await mixes.saveAsPlaylist(req.params.key, tz(req.query)));
    }),
  );

  const info = (): MixSettingsInfo => ({
    ...readMixSettings(store),
    analysisAvailable: deps.analysisAvailable,
    history: history.stats(),
  });

  // Settings → Mixes: for everyone, changed from the home network like every setting.
  const editable = { onRequest: requireLocal };

  app.get('/api/settings/mixes', editable, () => info());

  app.put('/api/settings/mixes', editable, (req, reply) => {
    const parsed = settingsInput.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    const current = readMixSettings(store);
    const patch = parsed.data;
    const next = { ...current, ...patch, enabled: { ...current.enabled, ...patch.enabled } };
    store.setAppSetting(MIXES_KEY, JSON.stringify(next));
    if (patch.analyzeLibrary && !current.analyzeLibrary) deps.analyzeLibrary();
    return info();
  });

  /** Forget everything played; the mixes are made again from scratch. */
  app.delete('/api/settings/mixes/history', editable, async () => {
    history.clear();
    await mixes.reset();
    return info();
  });
}
