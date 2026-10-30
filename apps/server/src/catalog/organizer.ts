import type { OrganizePlan, OrganizeResult, OrganizeSkip } from '@playarr/shared';
import { accessSync, constants, type Dirent, lstatSync, realpathSync, type Stats } from 'node:fs';
import { mkdir, readdir, rename, rmdir } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { isAudioFile } from './folderSource.ts';
import { planMoves } from './organize.ts';
import { isInside } from './paths.ts';
import type { CatalogStore } from './store.ts';

const COMPANION = /\.(jpe?g|png|webp|gif|cue|log|nfo|txt|m3u8?)$/i;
const LOCAL_ONLY = 'Organizing works for folders on this server only';

export class OrganizeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function isWritable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** The entry at `path` itself (a symlink, even a dangling one, counts), or null. */
function entry(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** The real location of `path`'s nearest existing ancestor (or itself), following symlinks. */
function realAncestor(path: string): string | null {
  for (let p = path; ; p = dirname(p)) {
    try {
      return realpathSync(p);
    } catch {
      if (dirname(p) === p) return null;
    }
  }
}

/** Moves a folder source's files into Artist/Album/NN Title.ext, within the folder, with undo. */
export class Organizer {
  constructor(private readonly store: CatalogStore) {}

  plan(sourceId: number): OrganizePlan {
    const { root, local } = this.folder(sourceId);
    const lastBatch = this.store.lastMoveBatch(sourceId);
    if (!local) return { writable: false, reason: `${LOCAL_ONLY}.`, moves: [], skipped: [], lastBatch };
    const { moves, skipped } = planMoves(this.store.organizeFiles(sourceId, root), (rel) => entry(join(root, rel)) !== null);
    return { writable: isWritable(root), moves, skipped, lastBatch };
  }

  async apply(sourceId: number, fromRels: string[]): Promise<OrganizeResult> {
    const root = this.localRoot(sourceId);
    if (!isWritable(root)) throw new OrganizeError('Playarr can’t write to this folder', 409);
    const wanted = new Set(fromRels);
    // The server decides where files go: the client only picks which of the planned moves to make.
    const fresh = this.plan(sourceId);
    const plan = fresh.moves.filter((m) => wanted.has(m.from));
    const batchId = this.store.nextMoveBatch();
    // Chosen files that can't move any more (e.g. a file appeared at their target since planning).
    const skipped: OrganizeSkip[] = fresh.skipped.filter((s) => wanted.has(s.from));
    const movedFrom = new Map<string, string>(); // from dir → target dir ('' if mixed)
    let moved = 0;

    for (const m of plan) {
      const result = await this.move(root, m.from, m.to);
      if (result !== true) {
        skipped.push({ from: m.from, to: m.to, reason: result });
        continue;
      }
      this.store.renameFolderFile(sourceId, m.from, m.to, join(root, m.to));
      this.store.logMove(sourceId, batchId, m.from, m.to);
      moved++;
      const fromDir = posix.dirname(m.from);
      const toDir = posix.dirname(m.to);
      const seen = movedFrom.get(fromDir);
      movedFrom.set(fromDir, seen === undefined || seen === toDir ? toDir : '');
    }

    for (const [fromDir, toDir] of movedFrom) {
      // Covers and the like follow when all of a folder's audio went to one place.
      const items = await readdir(join(root, fromDir), { withFileTypes: true }).catch((): Dirent[] => []);
      if (toDir && toDir !== fromDir && !items.some((i) => isAudioFile(i.name))) {
        for (const item of items.filter((i) => i.isFile() && COMPANION.test(i.name))) {
          const from = posix.join(fromDir, item.name);
          const to = posix.join(toDir, item.name);
          if ((await this.move(root, from, to)) === true) this.store.logMove(sourceId, batchId, from, to);
        }
      }
      await this.removeEmpty(root, fromDir);
    }
    return { batchId, moved, skipped };
  }

  async undo(sourceId: number, batchId: number): Promise<{ restored: number; skipped: OrganizeSkip[] }> {
    const root = this.localRoot(sourceId);
    if (!isWritable(root)) throw new OrganizeError('Playarr can’t write to this folder', 409);
    const moves = this.store.movesOf(sourceId, batchId).reverse();
    const done: number[] = [];
    const skipped: OrganizeSkip[] = [];
    const dirs = new Set<string>();
    for (const m of moves) {
      const result = await this.move(root, m.to, m.from);
      if (result !== true) {
        skipped.push({ from: m.to, to: m.from, reason: result });
        continue;
      }
      this.store.renameFolderFile(sourceId, m.to, m.from, join(root, m.from));
      done.push(m.id);
      dirs.add(posix.dirname(m.to));
    }
    this.store.markUndone(done);
    for (const dir of dirs) await this.removeEmpty(root, dir);
    return { restored: done.length, skipped };
  }

  /** Rename within the folder; true, or why not. Never overwrites. */
  private async move(root: string, fromRel: string, toRel: string): Promise<true | string> {
    const from = join(root, fromRel);
    const to = join(root, toRel);
    if (!isInside(from, root) || !isInside(to, root)) return 'Outside the folder';
    // Symlinked folders must not lead out of the folder either.
    const realRoot = realAncestor(root);
    const realFrom = realAncestor(dirname(from));
    const realTo = realAncestor(dirname(to));
    if (!realRoot || !realFrom || !realTo || !isInside(realFrom, realRoot) || !isInside(realTo, realRoot)) {
      return 'Outside the folder';
    }
    const source = entry(from);
    if (!source) return 'The file is gone';
    const target = entry(to);
    // Only a case-only rename may find its target taken, and only by the file itself.
    const sameFile = target && fromRel.toLowerCase() === toRel.toLowerCase() && target.dev === source.dev && target.ino === source.ino;
    if (target && !sameFile) return 'A file is already there';
    try {
      await mkdir(dirname(to), { recursive: true });
      await rename(from, to);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return code === 'EXDEV' ? 'On a different drive' : code === 'EACCES' || code === 'EPERM' ? 'Not allowed to move it' : (err as Error).message;
    }
  }

  /** Remove `rel` and its parents while empty, stopping at the root. */
  private async removeEmpty(root: string, rel: string) {
    let dir = rel;
    while (dir && dir !== '.' && isInside(join(root, dir), root)) {
      if ((await readdir(join(root, dir)).catch(() => ['?'])).length) return;
      await rmdir(join(root, dir)).catch(() => {});
      dir = posix.dirname(dir);
    }
  }

  /** The folder's root, and whether it is on this server (only those can be organized). */
  private folder(sourceId: number): { root: string; local: boolean } {
    const source = this.store.source(sourceId);
    const settings = source?.kind === 'folder' ? (source.settings as { path?: string; access?: string }) : undefined;
    if (!settings?.path) throw new OrganizeError('Not a folder source', 404);
    return { root: settings.path, local: (settings.access ?? 'local') === 'local' };
  }

  private localRoot(sourceId: number): string {
    const { root, local } = this.folder(sourceId);
    if (!local) throw new OrganizeError(LOCAL_ONLY, 409);
    return root;
  }
}
