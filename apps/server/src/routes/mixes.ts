import type { MixSettingsInfo } from '@playarr/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { CatalogStore } from '../catalog/store.ts';
import { ListenBrainzError, type Scrobbler } from '../listenbrainz/scrobbler.ts';
import type { History } from '../mixes/history.ts';
import { MixError, type Mixes } from '../mixes/mixes.ts';
import { MIX_KINDS, MIXES_KEY, readMixSettings } from '../mixes/settings.ts';
import { isStatsRange, listeningStats } from '../mixes/stats.ts';
import { validTimeZone } from '../mixes/time.ts';
import { stripAlbum, type Library } from '../library/library.ts';
import { PlaylistError } from '../playlists.ts';
import type { Profiles } from '../profiles/profiles.ts';
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
        profile: z.number().int().positive().optional(),
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

const radioInput = z.object({
  seeds: z.array(z.string().min(1).max(100)).min(1).max(20),
  exclude: z.array(z.string().min(1).max(100)).max(2000).optional(),
  count: z.number().int().min(1).max(100).optional(),
});

async function handle(reply: FastifyReply, fn: () => unknown) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof MixError || err instanceof PlaylistError || err instanceof ListenBrainzError) return reply.code(err.status).send({ error: err.message });
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
    library: Pick<Library, 'album' | 'artists' | 'tracksByRecordings'>;
    /** The database the history is in, for stats. */
    db?: DatabaseSync;
    scrobbler?: Pick<Scrobbler, 'info' | 'connect' | 'disconnect' | 'setEnabled' | 'sendEarlier' | 'kick'>;
    profiles?: Pick<Profiles, 'of' | 'ids'>;
  },
) {
  const { mixes, history, store } = deps;
  type Tz = { Querystring: { tz?: string } };
  type KeyTz = Tz & { Params: { key: string } };
  const tz = (q: { tz?: string }) => validTimeZone(q.tz);
  /** The listener a request is for (Settings → Profiles); 1 when there are no profiles. */
  const who = (req: FastifyRequest) => deps.profiles?.of(req) ?? 1;

  /** Songs heard on a device. Ignored (but accepted) when history is turned off. */
  app.post('/api/plays', async (req, reply) => {
    const parsed = playsInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid plays' });
    if (!readMixSettings(store).recordHistory) return reply.code(202).send({ recorded: 0 });
    // Each report says who was listening when it was played; a profile removed since counts as the device's now.
    const ids = new Set(deps.profiles?.ids() ?? [1]);
    const now = who(req);
    const plays = parsed.data.plays.map((p) => ({ ...p, profile: p.profile && ids.has(p.profile) ? p.profile : now }));
    const recorded = await history.record(plays, now);
    if (recorded) void deps.scrobbler?.kick();
    return { recorded };
  });

  /** Jump back in: albums heard lately that are still in the library. */
  app.get('/api/plays/recent-albums', async (req) => {
    const albums = await Promise.all(history.recentAlbums(24, who(req)).map((id) => deps.library.album(id)));
    return albums.flatMap((a) => (a ? [stripAlbum(a)] : [])).slice(0, 12);
  });

  /** Your listening: top artists, albums and songs, when you listen, and each year in review. */
  app.get<{ Querystring: { range?: string } }>('/api/stats', (req, reply) => {
    const range = req.query.range ?? 'month';
    if (!isStatsRange(range)) return reply.code(400).send({ error: 'Unknown range' });
    if (!deps.db) return reply.code(404).send({ error: 'Not available' });
    return listeningStats(deps.db, deps.library, range, Date.now(), who(req));
  });

  /** Songs like these, from the library: to keep playing after the queue, or "Start radio". */
  app.post('/api/radio', async (req, reply) => {
    const parsed = radioInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    return mixes.radio(parsed.data.seeds, parsed.data.exclude ?? [], parsed.data.count ?? 25);
  });

  app.get<Tz>('/api/mixes', (req) => mixes.list(tz(req.query), new Date(), who(req)));

  app.get<KeyTz>('/api/mixes/:key', (req, reply) =>
    handle(reply, () => {
      if (!KEY.test(req.params.key)) throw new MixError('Unknown mix', 404);
      return mixes.get(req.params.key, tz(req.query), new Date(), who(req));
    }),
  );

  app.post<KeyTz>('/api/mixes/:key/regenerate', (req, reply) =>
    handle(reply, () => {
      if (!KEY.test(req.params.key)) throw new MixError('Unknown mix', 404);
      return mixes.regenerate(req.params.key, tz(req.query), new Date(), who(req));
    }),
  );

  app.post<KeyTz>('/api/mixes/:key/save', (req, reply) =>
    handle(reply, async () => {
      if (!KEY.test(req.params.key)) throw new MixError('Unknown mix', 404);
      return reply.code(201).send(await mixes.saveAsPlaylist(req.params.key, tz(req.query), new Date(), who(req)));
    }),
  );

  /** Settings → Mixes: for everyone, with the history of whoever is asking. */
  const info = (req: FastifyRequest): MixSettingsInfo => ({
    ...readMixSettings(store),
    analysisAvailable: deps.analysisAvailable,
    history: history.stats(who(req)),
  });

  // Settings → Mixes: for everyone, changed from the home network like every setting.
  const editable = { onRequest: requireLocal };

  app.get('/api/settings/mixes', editable, (req) => info(req));

  app.put('/api/settings/mixes', editable, (req, reply) => {
    const parsed = settingsInput.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    const current = readMixSettings(store);
    const patch = parsed.data;
    const next = { ...current, ...patch, enabled: { ...current.enabled, ...patch.enabled } };
    store.setAppSetting(MIXES_KEY, JSON.stringify(next));
    if (patch.analyzeLibrary && !current.analyzeLibrary) deps.analyzeLibrary();
    return info(req);
  });

  // Settings → Mixes → ListenBrainz: the token goes in, never out.
  const { scrobbler } = deps;
  if (scrobbler) {
    const lbInput = z.object({ token: z.string().trim().min(1).max(200).optional(), enabled: z.boolean().optional() });
    app.get('/api/settings/listenbrainz', editable, (req) => scrobbler.info(who(req)));
    app.put('/api/settings/listenbrainz', editable, (req, reply) =>
      handle(reply, async () => {
        const parsed = lbInput.safeParse(req.body ?? {});
        if (!parsed.success) return reply.code(400).send({ error: 'Invalid settings' });
        if (parsed.data.token) await scrobbler.connect(parsed.data.token, who(req));
        if (parsed.data.enabled !== undefined) scrobbler.setEnabled(parsed.data.enabled, who(req));
        return scrobbler.info(who(req));
      }),
    );
    app.delete('/api/settings/listenbrainz', editable, (req) => scrobbler.disconnect(who(req)));
    app.post('/api/settings/listenbrainz/earlier', editable, (req) => scrobbler.sendEarlier(who(req)));
  }

  /** Forget everything played; the mixes are made again from scratch. */
  app.delete('/api/settings/mixes/history', editable, async (req) => {
    history.clear(who(req));
    await mixes.reset(who(req));
    return info(req);
  });
}
