import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Keep a cache folder under `maxBytes`: what was used least recently goes first (anything removed is
 * made again when it's needed). Files belong together by the part of their name before the first
 * '.', so an item and its companions (an image and its `.mime`; a transition's `.flac`, `.rest.flac`
 * and `.json`) are counted and removed as one: half an item would be worse than none.
 */
export async function trimCacheDir(dir: string, maxBytes: number): Promise<{ removed: number; bytes: number }> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const items = new Map<string, { bytes: number; used: number; files: string[] }>();
  for (const name of names) {
    const info = await stat(join(dir, name)).catch(() => null);
    if (!info?.isFile()) continue;
    const item = name.split('.')[0]!;
    const entry = items.get(item) ?? { bytes: 0, used: 0, files: [] };
    entry.bytes += info.size;
    entry.files.push(name);
    // Reading a file moves its access time on (where the disk keeps it); otherwise, when it was made.
    entry.used = Math.max(entry.used, info.atimeMs, info.mtimeMs);
    items.set(item, entry);
  }
  let bytes = [...items.values()].reduce((sum, e) => sum + e.bytes, 0);
  let removed = 0;
  for (const entry of [...items.values()].sort((a, b) => a.used - b.used)) {
    if (bytes <= maxBytes) break;
    for (const file of entry.files) await rm(join(dir, file), { force: true });
    bytes -= entry.bytes;
    removed++;
  }
  return { removed, bytes };
}
