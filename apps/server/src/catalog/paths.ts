import { posix } from 'node:path';

/** True if `path` is `root` or inside it, comparing whole segments after normalizing ("..", "//"). */
export function isInside(path: string, root: string): boolean {
  const p = posix.normalize(path);
  const r = posix.normalize(root).replace(/(.)\/+$/, '$1');
  return p === r || p.startsWith(r === '/' ? '/' : `${r}/`);
}
