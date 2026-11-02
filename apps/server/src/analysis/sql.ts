import type { DatabaseSync } from 'node:sqlite';

/**
 * Rows for `sql` ending in `IN`, the list filled with `ids`: asked 500 at a time, as SQLite caps how
 * many values one statement takes. `params` come before the ids.
 */
export function selectIn<T>(db: DatabaseSync, sql: string, ids: string[], params: (string | number)[] = []): T[] {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const stmt = db.prepare(`${sql} (${chunk.map(() => '?').join(',')})`);
    out.push(...(stmt.all(...params, ...chunk) as T[]));
  }
  return out;
}
