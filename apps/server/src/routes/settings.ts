import type {
  FolderAccessOptions,
  MatchingSettings,
  RequestSettings,
  RequestSettingsInfo,
  SourcesResponse,
} from '@playarr/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Matcher } from '../catalog/matcher.ts';
import { OrganizeError, type Organizer } from '../catalog/organizer.ts';
import { SourceError, type SourceManager } from '../catalog/sources.ts';
import type { CatalogStore } from '../catalog/store.ts';
import type { LidarrClient } from '../lidarr/client.ts';
import type { Library } from '../library/library.ts';
import { isLocalAddress } from '../net.ts';

/** Where a folder is, and how to reach it over SSH, SFTP or SMB. */
const connectionFields = {
  host: z.string().trim().max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  user: z.string().trim().max(100).optional(),
  password: z.string().max(500).optional(),
  privateKeyPath: z.string().trim().max(4096).optional(),
  domain: z.string().trim().max(100).optional(),
};
const folderAccess = z.enum(['local', 'ssh', 'sftp', 'smb']);
const sourceInput = z.object({
  kind: z.enum(['lidarr', 'folder']).optional(),
  name: z.string().trim().max(80).optional(),
  enabled: z.boolean().optional(),
  settings: z
    .object({
      url: z.url().optional(),
      apiKey: z.string().trim().max(200).optional(),
      path: z.string().trim().max(4096).optional(),
      access: folderAccess.optional(),
      ...connectionFields,
    })
    .optional(),
});
const browseInput = z.object({
  path: z.string().max(4096).optional(),
  id: z.number().int().optional(),
  connection: z.object({ access: folderAccess, ...connectionFields }).optional(),
});
const testInput = z.object({
  id: z.number().int().optional(),
  url: z.url().optional(),
  apiKey: z.string().trim().max(200).optional(),
});
const orderInput = z.object({ ids: z.array(z.number().int()) });
const reviewInput = z.object({
  groupKey: z.string().min(1),
  releaseId: z.string().min(1).nullable().optional(),
  search: z.object({ artist: z.string().trim().min(1).max(200), album: z.string().trim().min(1).max(200) }).optional(),
});
const matchingInput = z.object({ acoustidKey: z.string().trim().max(100) });
const organizeInput = z.object({ moves: z.array(z.string()).max(10_000) });
const undoInput = z.object({ batchId: z.number().int() });
const profileId = z.number().int().positive();
const requestsInput = z.object({
  enabled: z.boolean().optional(),
  searchOnAdd: z.boolean().optional(),
  // null clears a choice: back to .env, else Lidarr's default.
  rootFolderPath: z.string().trim().min(1).max(4096).nullable().optional(),
  qualityProfileId: profileId.nullable().optional(),
  metadataProfileId: profileId.nullable().optional(),
});

/** Where the AcoustID key is saved (app settings). */
export const ACOUSTID_KEY = 'acoustid.key';
/** Where Settings → Requests is saved (app settings), as one JSON value. */
export const REQUESTS_KEY = 'requests';

const REQUEST_DEFAULTS: RequestSettings = { enabled: true, searchOnAdd: true };
/** Lidarr's lists are only for the panel: don't keep it waiting on a slow Lidarr. */
const OPTIONS_TIMEOUT_MS = 5000;

/** Settings → Requests as saved, keeping only well-formed values. */
export function readRequestSettings(store: Pick<CatalogStore, 'appSetting'>): RequestSettings {
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(store.appSetting(REQUESTS_KEY) ?? '{}');
    if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>;
  } catch {
    // A damaged value reads as the defaults.
  }
  const settings: RequestSettings = {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : REQUEST_DEFAULTS.enabled,
    searchOnAdd: typeof raw.searchOnAdd === 'boolean' ? raw.searchOnAdd : REQUEST_DEFAULTS.searchOnAdd,
  };
  if (typeof raw.rootFolderPath === 'string' && raw.rootFolderPath) settings.rootFolderPath = raw.rootFolderPath;
  for (const key of ['qualityProfileId', 'metadataProfileId'] as const) {
    if (profileId.safeParse(raw[key]).success) settings[key] = raw[key] as number;
  }
  return settings;
}

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
    if (err instanceof OrganizeError) return reply.code(err.status).send({ error: err.message });
    throw err;
  }
}

export function settingsRoutes(
  app: FastifyInstance,
  deps: {
    sources: SourceManager;
    library: LibraryControl;
    matcher: Pick<Matcher, 'reviewGroups' | 'refreshReviewDetailsSoon' | 'applyRelease' | 'ignore' | 'search' | 'enqueue'>;
    store: Pick<CatalogStore, 'clearMatches' | 'appSetting' | 'setAppSetting'>;
    organizer: Pick<Organizer, 'plan' | 'apply' | 'undo'>;
    /** fpcalc is installed. */
    fingerprints: boolean;
    /** rclone is installed, so folders can be on SMB shares. */
    shares: boolean;
    lidarr: Pick<LidarrClient, 'configured' | 'rootFolders' | 'qualityProfiles' | 'metadataProfiles'>;
  },
) {
  const { sources, library, matcher, organizer } = deps;
  // Sync errors are shown per source in the panel, so a failed background sync needs no handling here.
  const syncInBackground = () => void library.refresh().catch(() => {});
  const editable = { onRequest: requireLocal };

  app.get('/api/settings/sources', (req): SourcesResponse => {
    const canEdit = isLocal(req);
    return { sources: sources.list({ includeSettings: canEdit, syncing: library.refreshing }), canEdit };
  });

  app.post('/api/settings/sources', editable, (req, reply) =>
    handle(reply, async () => {
      const input = parse(sourceInput, req.body);
      // A folder on another machine is checked over its connection before it's saved.
      await sources.verify(input);
      const info = sources.add(input);
      syncInBackground();
      return reply.code(201).send(info);
    }),
  );

  app.patch<Id>('/api/settings/sources/:id', editable, (req, reply) =>
    handle(reply, async () => {
      const id = Number(req.params.id);
      const input = parse(sourceInput, req.body);
      await sources.verify(input, id);
      const info = sources.update(id, input);
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

  // On this server, or over a (possibly unsaved) SSH, SFTP or SMB connection; the saved password never leaves the server.
  app.post('/api/settings/folders/browse', editable, (req, reply) =>
    handle(reply, () => sources.browse(parse(browseInput, req.body))),
  );

  app.get('/api/settings/folders/access', editable, (): FolderAccessOptions => ({ smb: deps.shares }));

  app.post<Id>('/api/settings/sources/:id/rescan', editable, (_req, reply) =>
    handle(reply, () => {
      syncInBackground();
      return reply.code(202).send({});
    }),
  );

  // The review list shows the server's file names, so reading it is local-only too.
  app.get<Id>('/api/settings/sources/:id/review', editable, (req) => {
    const id = Number(req.params.id);
    // Labels, country, formats… of the albums about to be shown arrive in the background; candidates
    // still waiting say so (detailed: false) and the dialog asks again.
    matcher.refreshReviewDetailsSoon(id);
    return matcher.reviewGroups(id);
  });

  app.post<Id>('/api/settings/sources/:id/review', editable, (req, reply) =>
    handle(reply, async () => {
      const id = Number(req.params.id);
      const action = parse(reviewInput, req.body);
      try {
        if (action.search) await matcher.search(id, action.groupKey, action.search.artist, action.search.album);
        else if (action.releaseId === null) matcher.ignore(id, action.groupKey);
        else if (action.releaseId) await matcher.applyRelease(id, action.groupKey, action.releaseId);
        else throw new SourceError('Choose a release, search, or leave it unmatched', 400);
      } catch (err) {
        if (err instanceof SourceError) throw err;
        throw new SourceError((err as Error).message, 409);
      }
      return reply.code(204).send();
    }),
  );

  app.post<Id>('/api/settings/sources/:id/rematch', editable, (req, reply) =>
    handle(reply, () => {
      const id = Number(req.params.id);
      deps.store.clearMatches(id);
      matcher.enqueue(id);
      return reply.code(202).send({});
    }),
  );

  // Organizing: the plan lists the server's file names, so reading it is local-only too.
  app.get<Id>('/api/settings/sources/:id/organize', editable, (req, reply) =>
    handle(reply, () => organizer.plan(Number(req.params.id))),
  );

  // A scan writes the file list it saw; moving files under it would leave the catalog pointing at old paths.
  const notWhileScanning = () => {
    if (library.refreshing) throw new OrganizeError('A scan is running; try again when it finishes', 409);
  };

  app.post<Id>('/api/settings/sources/:id/organize', editable, (req, reply) =>
    handle(reply, async () => {
      const { moves } = parse(organizeInput, req.body);
      notWhileScanning();
      const result = await organizer.apply(Number(req.params.id), moves);
      library.reload();
      return result;
    }),
  );

  app.post<Id>('/api/settings/sources/:id/organize/undo', editable, (req, reply) =>
    handle(reply, async () => {
      const { batchId } = parse(undoInput, req.body);
      notWhileScanning();
      const result = await organizer.undo(Number(req.params.id), batchId);
      library.reload();
      return result;
    }),
  );

  const matchingSettings = (): MatchingSettings => ({
    acoustid: !!deps.store.appSetting(ACOUSTID_KEY),
    fingerprints: deps.fingerprints,
  });

  app.get('/api/settings/matching', editable, () => matchingSettings());

  app.put('/api/settings/matching', editable, (req, reply) =>
    handle(reply, () => {
      deps.store.setAppSetting(ACOUSTID_KEY, parse(matchingInput, req.body).acoustidKey);
      return matchingSettings();
    }),
  );

  const requestSettingsInfo = async (): Promise<RequestSettingsInfo> => {
    const settings = readRequestSettings(deps.store);
    const { lidarr } = deps;
    if (!lidarr.configured) return { ...settings, lidarr: false };
    try {
      const [roots, quality, metadata] = await Promise.all([
        lidarr.rootFolders(OPTIONS_TIMEOUT_MS),
        lidarr.qualityProfiles(OPTIONS_TIMEOUT_MS),
        lidarr.metadataProfiles(OPTIONS_TIMEOUT_MS),
      ]);
      const profiles = (list: { id: number; name: string }[]) => list.map(({ id, name }) => ({ id, name }));
      return {
        ...settings,
        lidarr: true,
        options: {
          rootFolders: roots.map(({ path, freeSpace }) => ({ path, freeSpace })),
          qualityProfiles: profiles(quality),
          metadataProfiles: profiles(metadata),
        },
      };
    } catch (err) {
      return { ...settings, lidarr: true, error: (err as Error).message };
    }
  };

  app.get('/api/settings/requests', editable, () => requestSettingsInfo());

  app.put('/api/settings/requests', editable, (req, reply) =>
    handle(reply, () => {
      const patch = parse(requestsInput, req.body);
      const next: Record<string, unknown> = { ...readRequestSettings(deps.store) };
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete next[key];
        else if (value !== undefined) next[key] = value;
      }
      deps.store.setAppSetting(REQUESTS_KEY, JSON.stringify(next));
      return requestSettingsInfo();
    }),
  );
}
