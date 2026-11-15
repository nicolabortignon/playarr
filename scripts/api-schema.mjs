// The API's types as JSON Schema, for the apps' model generators: Swift (apps/ios/scripts/gen-models.mjs) and Kotlin
// (apps/tv/scripts/gen-models.mjs). ts-json-schema-generator reads the shared TypeScript types; each generator turns
// the definitions into its own language, by the same rules (docs/ios/README.md, docs/tv/README.md).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGenerator } from 'ts-json-schema-generator';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INPUTS = ['packages/shared/src/index.ts', 'packages/mix/src/types.ts'];
/** Exported, but not part of the API. */
const SKIP = new Set(['parseRange', 'ByteRange', 'wavFallbackOf']);
/** Numbers that are whole: what the server stores as SQLite integers or counts. */
const INTEGERS = new Set([
  'albums', 'albumsComplete', 'albumsIncomplete', 'albumsUnknown', 'analyzed', 'artists', 'audioFiles', 'background', 'batchId', 'beatModel', 'bits', 'channels',
  'count', 'currentStreak', 'days', 'decadeMixes', 'disc', 'discNumber', 'earlier', 'era', 'expiresIn', 'failed', 'files', 'freeSpace', 'genreMixes',
  'have', 'heapTotalBytes', 'heapUsedBytes', 'hour', 'ignored', 'interval', 'lastCheck', 'lastUpdate', 'latest', 'longestStreak', 'loudnessWaiting', 'loudnessWorking', 'matches',
  'matched', 'matching', 'moved', 'newArtists', 'pending', 'plays', 'playlists', 'port', 'position', 'profile', 'queued', 'ready',
  'recorded', 'restored', 'review', 'rssBytes', 'sampleRate', 'sent', 'size', 'sizeBytes', 'songs', 'songsComplete', 'songsIncomplete', 'songsUnknown', 'sources',
  'status2xx', 'status3xx', 'status4xx', 'status5xx', 'tagsWaiting', 'total', 'trackNumber', 'trackTotal', 'tracks', 'variant', 'version', 'waiting', 'weekday',
  'working', 'year', 'years',
]);
export const isIntegerName = (name) => name === 'id' || /(Id|Ids|Count)$/.test(name) || INTEGERS.has(name);

/** Every exported type of the inputs, by name. */
export function loadDefinitions() {
  const definitions = {};
  for (const input of INPUTS) {
    const schema = createGenerator({
      path: resolve(root, input),
      type: '*',
      expose: 'export',
      topRef: true,
      jsDoc: 'extended',
      skipTypeCheck: true,
      additionalProperties: false,
    }).createSchema('*');
    for (const [name, def] of Object.entries(schema.definitions ?? {})) {
      if (SKIP.has(name)) continue;
      if (definitions[name]) throw new Error(`${name} is exported by two inputs`);
      definitions[name] = def;
    }
  }
  return definitions;
}

export const pascal = (s) => s.replace(/(^|[^A-Za-z0-9]+)([A-Za-z0-9])/g, (_, __, c) => c.toUpperCase());
export const camel = (s) => {
  const p = pascal(s);
  return p.charAt(0).toLowerCase() + p.slice(1);
};
export const refName = (schema) => schema.$ref?.replace('#/definitions/', '');
export const trimEnd = (lines) => {
  while (lines.at(-1) === '') lines.pop();
  return lines;
};
const nonNull = (types) => (Array.isArray(types) ? types.filter((t) => t !== 'null') : [types]);

/** Strips `null` from a schema: { schema, nullable }. */
export function splitNull(schema) {
  if (Array.isArray(schema.type) && schema.type.includes('null')) {
    const rest = nonNull(schema.type);
    return { schema: { ...schema, type: rest.length === 1 ? rest[0] : rest }, nullable: true };
  }
  const options = schema.anyOf;
  if (options?.some((o) => o.type === 'null')) {
    const rest = options.filter((o) => o.type !== 'null');
    return { schema: rest.length === 1 ? { ...rest[0], description: schema.description } : { ...schema, anyOf: rest }, nullable: true };
  }
  return { schema, nullable: false };
}

export const isStringEnum = (s) => s.type === 'string' && Array.isArray(s.enum);
export const isNumberEnum = (s) => s.type === 'number' && Array.isArray(s.enum);
export const isObject = (s) => s.type === 'object' && s.properties;
export const isRecord = (s) => s.type === 'object' && !s.properties && typeof s.additionalProperties === 'object';
/** The string property every object of a union has, with a constant value in each: the union's tag. */
export const tagOf = (s) => {
  const options = s.anyOf;
  if (!options?.length || !options.every(isObject)) return undefined;
  const tag = Object.keys(options[0].properties).find((key) => options.every((o) => typeof o.properties[key]?.const === 'string'));
  return tag;
};

/** The MIX_MAP_VERSION constant, which JSON Schema doesn't carry. */
export function mixMapVersion() {
  const match = /export const MIX_MAP_VERSION = (\d+);/.exec(readFileSync(resolve(root, 'packages/mix/src/types.ts'), 'utf8'));
  if (!match) throw new Error('MIX_MAP_VERSION not found in packages/mix/src/types.ts');
  return Number(match[1]);
}
