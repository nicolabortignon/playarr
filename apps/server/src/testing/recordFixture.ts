import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where the iOS contract tests read real server answers from. */
export const FIXTURES_DIR = fileURLToPath(new URL('../../../ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/Fixtures/', import.meta.url));

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** Timestamps pinned, so recording again changes a fixture only when its shape changes. */
function pinTimestamps(value: unknown): unknown {
  if (typeof value === 'string') return TIMESTAMP.test(value) ? '2026-11-03T12:00:00.000Z' : value;
  if (Array.isArray(value)) return value.map(pinTimestamps);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, pinTimestamps(v)]));
  return value;
}

type Answer = { statusCode: number; json: () => unknown };

/** Saves a route's JSON answer as <dir>/<name>.json, after `tidy` and with timestamps pinned. */
export function writeFixture(dir: string, name: string, res: Answer, tidy: (body: any) => unknown = (body) => body): void {
  if (res.statusCode < 200 || res.statusCode > 299) throw new Error(`Fixture ${name}: the route answered ${res.statusCode}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(pinTimestamps(tidy(res.json())), null, 2)}\n`);
}

/**
 * With RECORD_FIXTURES=1, saves a route's answer for the iOS contract tests; otherwise does nothing.
 * `tidy` replaces what changes on every run (tokens, random ids, random order).
 */
export function recordFixture(name: string, res: Answer, tidy?: (body: any) => unknown): void {
  if (process.env.RECORD_FIXTURES === '1') writeFixture(FIXTURES_DIR, name, res, tidy);
}
