import { isIP } from 'node:net';
import { posix } from 'node:path';
import { z } from 'zod';

const schema = z.object({
  // Optional: copied into Settings → Sources on first start, then managed there.
  LIDARR_URL: z
    .url()
    .transform((u) => u.replace(/\/+$/, ''))
    .optional(),
  LIDARR_API_KEY: z.string().optional(),
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default('0.0.0.0'),
  LIBRARY_REFRESH_MINUTES: z.coerce.number().positive().default(10),
  CACHE_DIR: z.string().default('.cache'),
  // The artwork cache is trimmed to this size, least recently used first.
  ART_CACHE_MB: z.coerce.number().positive().default(2048),
  // Rendered transitions (DJ mix) are trimmed to this size the same way.
  TRANSITIONS_CACHE_MB: z.coerce.number().positive().default(1024),
  // User data (favorites…). Unlike the cache, don't delete this.
  DATA_DIR: z.string().default('data'),
  WEB_DIST: z.string().optional(),
  // This server's address as people reach it (e.g. https://music.example.com), for setup-code links.
  PUBLIC_URL: z
    .url({ protocol: /^https?$/, error: 'must be an http:// or https:// URL' })
    .transform((u) => u.replace(/\/+$/, ''))
    .optional(),
  // Behind a reverse proxy: which proxies to believe about the visitor (X-Forwarded-For, -Host, -Proto).
  // true, or comma-separated addresses/CIDRs (see trustProxyOf).
  TRUST_PROXY: z.string().optional(),
  // The folder shared with the updater container (Settings → Updates). docker/compose.yaml sets /update.
  UPDATE_DIR: z.string().optional(),

  MEDIA_SOURCE: z.enum(['none', 'local', 'sftp', 'ssh']).default('none'),
  // Comma-separated "lidarrPrefix=playarrPrefix" pairs.
  PATH_MAP: z.string().default(''),
  // Folders that folder sources may use and Settings may browse (comma-separated absolute paths).
  // The Docker image sets /host, where a broad read-only mount of the host goes.
  FOLDER_ROOTS: z.string().default('/'),

  // Requests: where new artists go in Lidarr (defaults: the root folder's own defaults).
  LIDARR_ROOT_FOLDER: z.string().optional(),
  LIDARR_QUALITY_PROFILE_ID: z.coerce.number().int().optional(),
  LIDARR_METADATA_PROFILE_ID: z.coerce.number().int().optional(),
  // MusicBrainz asks API clients to identify themselves with a contact (URL or email).
  MUSICBRAINZ_CONTACT: z.string().default('self-hosted'),

  // Audio analysis (tempo, energy, …) for generated playlist covers. ffmpeg runs where the
  // files are: on the SSH host for MEDIA_SOURCE=ssh, locally for MEDIA_SOURCE=local.
  ANALYSIS: z.enum(['on', 'off']).default('on'),
  FFMPEG_PATH: z.string().default('ffmpeg'),
  /** Chromaprint's fpcalc, for identifying songs by their sound (optional). */
  FPCALC_PATH: z.string().default('fpcalc'),
  /** rclone, for folders on SMB shares (optional). */
  RCLONE_PATH: z.string().default('rclone'),

  // Used by MEDIA_SOURCE=sftp and MEDIA_SOURCE=ssh.
  SSH_HOST: z.string().optional(),
  SSH_PORT: z.coerce.number().int().default(22),
  SSH_USER: z.string().optional(),
  SSH_PRIVATE_KEY_PATH: z.string().optional(),
  SSH_PASSWORD: z.string().optional(),
});

/** Fastify's `trustProxy`: false (no proxy), true (any), or the proxies' addresses. */
export type TrustProxy = boolean | string[];

export type Config = z.infer<typeof schema> & { pathMap: [from: string, to: string][]; folderRoots: string[]; trustProxy: TrustProxy };

/** proxy-addr's names for address ranges, accepted in TRUST_PROXY's list. */
const RANGES = new Set(['loopback', 'linklocal', 'uniquelocal']);

/**
 * TRUST_PROXY as Fastify takes it; throws on anything else. Not a hop count: Fastify 5 refuses those as
 * unsafe (a visitor reaching the server directly could forge the hops) and would trust nobody.
 */
export function trustProxyOf(value: string | undefined): TrustProxy {
  const v = value?.trim() ?? '';
  if (v === '' || v === 'false') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) throw new Error('Invalid configuration:\n  TRUST_PROXY: a hop count isn’t supported; give the proxy’s address (or true)');
  const list = v.split(',').map((a) => a.trim()).filter(Boolean);
  for (const entry of list) {
    const [address, bits, extra] = entry.split('/');
    const ok = RANGES.has(entry) || (isIP(address!) !== 0 && extra === undefined && (bits === undefined || /^\d{1,3}$/.test(bits)));
    if (!ok) throw new Error(`Invalid configuration:\n  TRUST_PROXY: "${entry}" is not true, a hop count, an address or a CIDR`);
  }
  return list;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Treat empty strings in .env as "unset" so defaults and optionals apply.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const pathMap = parsed.data.PATH_MAP.split(',')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf('=');
      if (idx <= 0) throw new Error(`Invalid PATH_MAP entry "${pair}" (expected from=to)`);
      return [pair.slice(0, idx), pair.slice(idx + 1)] as [string, string];
    });
  const folderRoots = parsed.data.FOLDER_ROOTS.split(',')
    .map((r) => r.trim())
    .filter((r) => r.startsWith('/'))
    .map((r) => posix.normalize(r).replace(/(.)\/+$/, '$1'));
  return { ...parsed.data, pathMap, folderRoots: folderRoots.length ? folderRoots : ['/'], trustProxy: trustProxyOf(parsed.data.TRUST_PROXY) };
}
