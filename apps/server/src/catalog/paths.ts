import type { FolderListing } from '@playarr/shared';
import type { Dirent } from 'node:fs';
import { statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { posix } from 'node:path';
import { isAudioFile } from './folderSource.ts';

/** True if `path` is `root` or inside it, comparing whole segments after normalizing ("..", "//"). */
export function isInside(path: string, root: string): boolean {
  const p = posix.normalize(path);
  const r = posix.normalize(root).replace(/(.)\/+$/, '$1');
  return p === r || p.startsWith(r === '/' ? '/' : `${r}/`);
}

/** Validate a folder source path: absolute, inside a root, an existing folder. Returns it normalized. */
export function checkFolder(path: string, roots: string[]): string {
  if (!path.startsWith('/')) throw new Error('The folder must be an absolute path');
  const normalized = posix.normalize(path).replace(/(.)\/+$/, '$1');
  if (!roots.some((r) => isInside(normalized, r))) {
    throw new Error(`That folder is outside the folders Playarr may use (${roots.join(', ')})`);
  }
  const s = (() => {
    try {
      return statSync(normalized);
    } catch {
      return null;
    }
  })();
  if (!s) throw new Error('That folder doesn’t exist');
  if (!s.isDirectory()) throw new Error('That path is not a folder');
  return normalized;
}

/** A folder's subfolders, for the folder picker. Without a path: the roots. */
export async function listFolders(path: string | undefined, roots: string[]): Promise<FolderListing> {
  if (!path) return { path: null, parent: null, folders: roots.map((r) => ({ name: r, path: r })), audioFiles: 0 };
  const root = roots.find((r) => posix.normalize(r).replace(/(.)\/+$/, '$1') === posix.normalize(path).replace(/(.)\/+$/, '$1'));
  // A root that isn't there (Docker without a /host mount) is shown as empty, with a hint, not as an error.
  if (root && !statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    return { path: posix.normalize(root).replace(/(.)\/+$/, '$1'), parent: null, folders: [], audioFiles: 0, emptyRoot: true };
  }
  const dir = checkFolder(path, roots);
  const items = await readdir(dir, { withFileTypes: true }).catch((): Dirent[] => []);
  const folders = items
    .filter((i) => i.isDirectory() && !i.name.startsWith('.'))
    .map((i) => ({ name: i.name, path: posix.join(dir, i.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const audioFiles = items.filter((i) => i.isFile() && isAudioFile(i.name)).length;
  const atRoot = roots.some((r) => posix.normalize(r).replace(/(.)\/+$/, '$1') === dir);
  return { path: dir, parent: atRoot ? null : posix.dirname(dir), folders, audioFiles, ...(atRoot && items.length === 0 ? { emptyRoot: true } : {}) };
}
