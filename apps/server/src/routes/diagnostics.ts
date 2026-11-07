import type { FolderAccessKind, ServerDiagnostics } from '@playarr/shared';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { requireAdmin } from '../accounts/rights.ts';
import type { Analyzer } from '../analysis/analyzer.ts';
import type { CatalogStore } from '../catalog/store.ts';
import { LATEST_SCHEMA, schemaOf } from '../db.ts';
import type { EncodedStreams } from '../media/encoded.ts';
import type { Transitions } from '../transitions/transitions.ts';
import { VERSION } from '../version.ts';

const ACCESS: readonly FolderAccessKind[] = ['local', 'ssh', 'sftp', 'smb'];

/** What `read` says, or nothing when it can't be read (the database failing): diagnostics answer all the same. */
function ifReadable<T extends object>(read: () => T): T | Record<string, never> {
  try {
    return read();
  } catch {
    return {};
  }
}

/**
 * GET /api/diagnostics: what someone helping with a problem asks first, for admins only. Cheap to answer: counts kept
 * in memory and two small reads of the database, never a pass over the library.
 */
export function diagnosticsRoutes(
  app: FastifyInstance,
  deps: {
    db: Pick<DatabaseSync, 'prepare'>;
    store: Pick<CatalogStore, 'listSources'>;
    analyzer?: Pick<Analyzer, 'queues'>;
    /** Absent without audio analysis (no DJ mixing). */
    transitions?: Pick<Transitions, 'renders'>;
    encoded?: Pick<EncodedStreams, 'counts'>;
    /** The answers since the server started, by status class (requestLog.ts). */
    responses: () => ServerDiagnostics['responses'];
    /** The stall monitor's tally, once it runs. */
    stalls?: () => ServerDiagnostics['stalls'];
  },
) {
  app.get('/api/diagnostics', { onRequest: requireAdmin }, (): ServerDiagnostics => {
    const memory = process.memoryUsage();
    const stalls = deps.stalls?.();
    return {
      version: VERSION,
      ...ifReadable(() => ({ schema: { version: schemaOf(deps.db), latest: LATEST_SCHEMA } })),
      node: {
        version: process.version,
        uptimeSeconds: Math.floor(process.uptime()),
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
      },
      ...ifReadable(() => ({
        // Of their settings, only a folder's access (where it is): never a path, host or secret.
        sources: deps.store.listSources().map((s) => ({
          id: s.id,
          kind: s.kind,
          ...(s.kind === 'folder' ? { access: ACCESS.find((a) => a === s.settings.access) ?? 'local' } : {}),
          enabled: s.enabled,
          lastSyncAt: s.lastSyncAt,
          lastError: s.lastError,
        })),
      })),
      queues: {
        ...(deps.analyzer ? { analysis: deps.analyzer.queues() } : {}),
        ...(deps.transitions ? { transitions: deps.transitions.renders() } : {}),
        ...(deps.encoded ? { encodes: { working: deps.encoded.counts().running } } : {}),
      },
      responses: deps.responses(),
      ...(stalls ? { stalls } : {}),
    };
  });
}
