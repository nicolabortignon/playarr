import { z } from 'zod';

const schema = z.object({
  LIDARR_URL: z.url().transform((u) => u.replace(/\/+$/, '')),
  LIDARR_API_KEY: z.string().min(1, 'LIDARR_API_KEY is required'),
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default('0.0.0.0'),
  LIBRARY_REFRESH_MINUTES: z.coerce.number().positive().default(10),
  CACHE_DIR: z.string().default('.cache'),
  WEB_DIST: z.string().optional(),

  MEDIA_SOURCE: z.enum(['none', 'local', 'sftp', 'ssh']).default('none'),
  // Comma-separated "lidarrPrefix=playarrPrefix" pairs.
  PATH_MAP: z.string().default(''),

  // Requests: where new artists go in Lidarr (defaults: the root folder's own defaults).
  LIDARR_ROOT_FOLDER: z.string().optional(),
  LIDARR_QUALITY_PROFILE_ID: z.coerce.number().int().optional(),
  LIDARR_METADATA_PROFILE_ID: z.coerce.number().int().optional(),
  // MusicBrainz asks API clients to identify themselves with a contact (URL or email).
  MUSICBRAINZ_CONTACT: z.string().default('self-hosted'),

  // Used by MEDIA_SOURCE=sftp and MEDIA_SOURCE=ssh.
  SSH_HOST: z.string().optional(),
  SSH_PORT: z.coerce.number().int().default(22),
  SSH_USER: z.string().optional(),
  SSH_PRIVATE_KEY_PATH: z.string().optional(),
  SSH_PASSWORD: z.string().optional(),
});

export type Config = z.infer<typeof schema> & { pathMap: [from: string, to: string][] };

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
  return { ...parsed.data, pathMap };
}
