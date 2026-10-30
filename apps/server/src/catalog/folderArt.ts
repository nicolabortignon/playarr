import { parseFile } from 'music-metadata';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const NAMES = ['cover', 'folder', 'front', 'album'];
const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

/** A folder file's artwork: the picture embedded in it, else cover/folder/front/album.(jpg|png|webp) beside it. */
export async function copyCover(path: string): Promise<{ body: Buffer; mime: string } | null> {
  try {
    const picture = (await parseFile(path, { duration: false })).common.picture?.[0];
    if (picture) return { body: Buffer.from(picture.data), mime: picture.format };
  } catch {
    // unreadable tags: try the folder
  }
  const dir = dirname(path);
  const names = await readdir(dir).catch((): string[] => []);
  for (const want of NAMES) {
    const hit = names.find((n) => new RegExp(`^${want}\\.(jpe?g|png|webp)$`, 'i').test(n));
    if (hit) return { body: await readFile(join(dir, hit)), mime: MIME[hit.split('.').pop()!.toLowerCase()]! };
  }
  return null;
}
