import type { FastifyInstance, FastifyReply } from 'fastify';
import type { PlaylistCovers } from '../cover/index.ts';
import type { Recommendations } from '../discover/recommendations.ts';
import { PlaylistError, type Playlists } from '../playlists.ts';

const RECORDING_ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|track:\d+)$/i;

function recordingIds(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1000) return null;
  return value.every((v) => typeof v === 'string' && RECORDING_ID.test(v)) ? (value as string[]) : null;
}

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

  /** Generated cover: WebP at `size` (default 600), or the source with `format=svg`. */
  app.get<Id & { Querystring: { size?: string; v?: string; format?: string } }>('/art/playlist/:id', (req, reply) =>
    handle(reply, async () => {
      const { dna, hash } = await playlists.cover(id(req.params.id));
      const svg = req.query.format === 'svg';
      // Snap to a few sizes so the image cache stays small.
      const wanted = Number(req.query.size) || 600;
      const size = [64, 96, 128, 192, 256, 384, 512, 768, 1024].find((b) => b >= wanted) ?? 1024;
      // Versioned URLs never change; the bare URL always revalidates.
      reply
        .header('Cache-Control', req.query.v === hash ? 'public, max-age=31536000, immutable' : 'no-cache')
        .header('ETag', `"${hash}-${svg ? 'svg' : size}"`);
      if (svg) return reply.type('image/svg+xml').send((await covers.svg(dna, hash)).svg);
      return reply.type('image/webp').send(await covers.image(dna, hash, size));
    }),
  );

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
