import type { SourcesResponse } from '@playarr/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SourceError, type SourceManager } from '../catalog/sources.ts';
import type { Library } from '../library/library.ts';
import { isLocalAddress } from '../net.ts';

const sourceInput = z.object({
  kind: z.enum(['lidarr', 'folder']).optional(),
  name: z.string().trim().max(80).optional(),
  enabled: z.boolean().optional(),
  settings: z
    .object({
      url: z.url().optional(),
      apiKey: z.string().trim().max(200).optional(),
      path: z.string().trim().max(4096).optional(),
    })
    .optional(),
});
const testInput = z.object({
  id: z.number().int().optional(),
  url: z.url().optional(),
  apiKey: z.string().trim().max(200).optional(),
});
const orderInput = z.object({ ids: z.array(z.number().int()) });

type LibraryControl = Pick<Library, 'refresh' | 'reload' | 'refreshing'>;
type Id = { Params: { id: string } };

const isLocal = (req: FastifyRequest) => isLocalAddress(req.socket.remoteAddress);

/** Until Playarr has a login, settings can only be changed from the local network. */
async function requireLocal(req: FastifyRequest, reply: FastifyReply) {
  if (!isLocal(req)) return reply.code(403).send({ error: 'Settings can only be changed from your home network' });
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    throw new SourceError(result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), 400);
  }
  return result.data;
}

async function handle(reply: FastifyReply, fn: () => unknown) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SourceError) return reply.code(err.status).send({ error: err.message });
    throw err;
  }
}

export function settingsRoutes(app: FastifyInstance, deps: { sources: SourceManager; library: LibraryControl }) {
  const { sources, library } = deps;
  // Sync errors are shown per source in the panel, so a failed background sync needs no handling here.
  const syncInBackground = () => void library.refresh().catch(() => {});
  const editable = { onRequest: requireLocal };

  app.get('/api/settings/sources', (req): SourcesResponse => {
    const canEdit = isLocal(req);
    return { sources: sources.list({ includeSettings: canEdit, syncing: library.refreshing }), canEdit };
  });

  app.post('/api/settings/sources', editable, (req, reply) =>
    handle(reply, () => {
      const info = sources.add(parse(sourceInput, req.body));
      syncInBackground();
      return reply.code(201).send(info);
    }),
  );

  app.patch<Id>('/api/settings/sources/:id', editable, (req, reply) =>
    handle(reply, () => {
      const info = sources.update(Number(req.params.id), parse(sourceInput, req.body));
      syncInBackground();
      return info;
    }),
  );

  app.delete<Id>('/api/settings/sources/:id', editable, (req, reply) =>
    handle(reply, () => {
      sources.remove(Number(req.params.id));
      library.reload();
      return reply.code(204).send();
    }),
  );

  app.put('/api/settings/sources/order', editable, (req, reply) =>
    handle(reply, (): SourcesResponse => {
      sources.reorder(parse(orderInput, req.body).ids);
      library.reload();
      return { sources: sources.list({ includeSettings: true, syncing: library.refreshing }), canEdit: true };
    }),
  );

  app.post('/api/settings/sources/test', editable, (req, reply) =>
    handle(reply, () => sources.test(parse(testInput, req.body))),
  );

  // Browsing reveals the server's folder names, so it's local-only too.
  app.get<{ Querystring: { path?: string } }>('/api/settings/folders', editable, (req, reply) =>
    handle(reply, () => sources.listFolders(req.query.path || undefined)),
  );

  app.post<Id>('/api/settings/sources/:id/rescan', editable, (_req, reply) =>
    handle(reply, () => {
      syncInBackground();
      return reply.code(202).send({});
    }),
  );
}
