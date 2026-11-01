import { mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { trimCacheDir } from './cacheDir.ts';
import { tempDir } from './catalog/testFixtures.ts';

let cleanup = () => {};
afterEach(() => cleanup());

describe('trimCacheDir', () => {
  it('counts and removes the files of one item together, grouped by the name before the first dot', async () => {
    const t = tempDir();
    cleanup = t.cleanup;
    mkdirSync(t.dir, { recursive: true });
    const now = Date.now() / 1000;
    const files: Record<string, string[]> = {
      old: ['old.flac', 'old.rest.flac', 'old.json'],
      middle: ['middle.wav', 'middle.json'],
      recent: ['recent.flac', 'recent.json'],
    };
    Object.values(files).forEach((names, i) => {
      for (const name of names) {
        writeFileSync(join(t.dir, name), Buffer.alloc(50));
        utimesSync(join(t.dir, name), now - 3000 + i * 1000, now - 3000 + i * 1000);
      }
    });
    // 350 bytes in all: removing "old" (150) leaves 200, still over; "middle" (100) too leaves 100.
    const result = await trimCacheDir(t.dir, 150);
    expect(result).toEqual({ removed: 2, bytes: 100 });
    expect(readdirSync(t.dir).sort()).toEqual(['recent.flac', 'recent.json']);
  });
});
