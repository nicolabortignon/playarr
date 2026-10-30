import { posix } from 'node:path';
import type { FolderFs } from './folderFs.ts';

const NAMES = ['cover', 'folder', 'front', 'album'];
const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

/** A folder file's artwork: the picture embedded in it, else cover/folder/front/album.(jpg|png|webp) beside it. */
export async function copyCover(fs: FolderFs, path: string, size: number): Promise<{ body: Buffer; mime: string } | null> {
  try {
    const picture = await fs.picture(path, size);
    if (picture) return picture;
  } catch {
    // unreadable tags: try the folder
  }
  const dir = posix.dirname(path);
  const names = (await fs.readdir(dir).catch(() => [])).filter((e) => e.file).map((e) => e.name);
  for (const want of NAMES) {
    const hit = names.find((n) => new RegExp(`^${want}\\.(jpe?g|png|webp)$`, 'i').test(n));
    if (hit) return { body: await fs.readFile(posix.join(dir, hit)), mime: MIME[hit.split('.').pop()!.toLowerCase()]! };
  }
  return null;
}
