import type { FastifyInstance, FastifyReply } from 'fastify';
import type { CoverLayout } from '@playarr/shared';
import type { CoverArt, PlaylistCovers } from '../cover/index.ts';
import type { Recommendations } from '../discover/recommendations.ts';
import { PlaylistError, type Playlists } from '../playlists.ts';

const RECORDING_ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|track:\d+)$/i;

function recordingIds(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1000) return null;
  return value.every((v) => typeof v === 'string' && RECORDING_ID.test(v)) ? (value as string[]) : null;
}

const LAYOUTS: CoverLayout[] = ['currents', 'colonies', 'horizon', 'ridges', 'grooves', 'blocks'];
const coverLayout = (value: unknown) => LAYOUTS.find((l) => l === value);

async function handle<T>(reply: FastifyReply, fn: () => T | Promise<T>) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PlaylistError) return reply.code(err.status).send({ error: err.message });
    throw err;
  }
}

export function playlistRoutes(
  app: FastifyInstance,
  deps: { playlists: Playlists; recommendations: Recommendations; covers: PlaylistCovers },
) {
  const { playlists, recommendations, covers } = deps;
  type Id = { Params: { id: string } };
  const id = (raw: string) => Number.parseInt(raw, 10);

  type ArtQuery = { size?: string; v?: string; format?: string; title?: string };
  // Snap to a few sizes so the image cache stays small.
  const snap = (raw?: string) => [64, 96, 128, 192, 256, 384, 512, 768, 1024].find((b) => b >= (Number(raw) || 600)) ?? 1024;
  const sendCover = async (reply: FastifyReply, cover: { art: CoverArt; name: string }, query: ArtQuery, immutable: boolean) => {
    const title = query.title === '0' ? undefined : cover.name;
    // Versioned URLs never change (the version covers art and title); the bare URL revalidates.
    reply.header('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    if (query.format === 'svg') return reply.type('image/svg+xml').send(await covers.svg(cover.art, title));
    return reply.type('image/webp').send(await covers.image(cover.art, title, snap(query.size)));
  };

  /** The playlist's cover: WebP at `size` (default 600), `title=0` without the title, `format=svg` for the source. */
  app.get<Id & { Querystring: ArtQuery }>('/art/playlist/:id', (req, reply) =>
    handle(reply, async () => {
      const cover = await playlists.cover(id(req.params.id));
      return sendCover(reply, cover, req.query, req.query.v === cover.version);
    }),
  );

  /** A candidate cover from the playlist's current songs, for the picker. */
  app.get<Id & { Querystring: ArtQuery & { layout?: string; variant?: string } }>('/art/playlist/:id/preview', (req, reply) =>
    handle(reply, async () => {
      const layout = coverLayout(req.query.layout);
      if (!layout) return reply.code(400).send({ error: 'Unknown layout' });
      const variant = Math.max(0, Math.min(1_000_000, Number.parseInt(req.query.variant ?? '0', 10) || 0));
      return sendCover(reply, await playlists.coverCandidate(id(req.params.id), layout, variant), req.query, false);
    }),
  );

  app.put<Id & { Body: { layout?: string; variant?: number } }>('/api/playlists/:id/cover', (req, reply) => {
    const layout = coverLayout(req.body?.layout);
    const variant = req.body?.variant ?? 0;
    if (!layout || !Number.isInteger(variant) || variant < 0) return reply.code(400).send({ error: 'layout and variant are required' });
    return handle(reply, () => playlists.setCover(id(req.params.id), layout, variant));
  });

  app.get('/api/playlists', () => playlists.list());

  app.post<{ Body: { name?: string; description?: string; recordingIds?: string[] } }>('/api/playlists', (req, reply) => {
    const ids = recordingIds(req.body?.recordingIds);
    if (!ids) return reply.code(400).send({ error: 'recordingIds must be a list of song ids' });
    return handle(reply, async () => reply.code(201).send(await playlists.create(req.body?.name ?? '', req.body?.description, ids)));
  });

  app.get<Id>('/api/playlists/:id', (req, reply) => handle(reply, () => playlists.get(id(req.params.id))));

  app.patch<Id & { Body: { name?: string; description?: string } }>('/api/playlists/:id', (req, reply) =>
    handle(reply, () => playlists.update(id(req.params.id), req.body ?? {})),
  );

  app.delete<Id>('/api/playlists/:id', (req, reply) =>
    handle(reply, () => {
      playlists.remove(id(req.params.id));
      return reply.code(204).send();
    }),
  );

  app.post<Id & { Body: { recordingIds?: string[] } }>('/api/playlists/:id/items', (req, reply) => {
    const ids = recordingIds(req.body?.recordingIds);
    if (!ids?.length) return reply.code(400).send({ error: 'recordingIds must be a non-empty list of song ids' });
    return handle(reply, () => playlists.addItems(id(req.params.id), ids));
  });

  app.delete<{ Params: { id: string; itemId: string } }>('/api/playlists/:id/items/:itemId', (req, reply) =>
    handle(reply, () => playlists.removeItem(id(req.params.id), id(req.params.itemId))),
  );

  app.get<Id & { Querystring: { variant?: string } }>('/api/playlists/:id/recommendations', async (req, reply) => {
    const ctrl = new AbortController();
    reply.raw.once('close', () => !reply.raw.writableFinished && ctrl.abort());
    try {
      return await handle(reply, () =>
        recommendations.forPlaylist(id(req.params.id), Number(req.query.variant) || 0, ctrl.signal),
      );
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.put<Id & { Body: { itemIds?: number[] } }>('/api/playlists/:id/order', (req, reply) => {
    const itemIds = req.body?.itemIds;
    if (!Array.isArray(itemIds) || !itemIds.every(Number.isInteger)) {
      return reply.code(400).send({ error: 'itemIds must be a list of item ids' });
    }
    return handle(reply, () => playlists.reorder(id(req.params.id), itemIds));
  });
}
