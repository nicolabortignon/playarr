import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { folderSync, type FolderEntry } from './folder.ts';
import type { FolderFs, FoundFile } from './folderFs.ts';
import type { MbReleaseInfo } from './mbRelease.ts';
import type { CatalogStore } from './store.ts';
import type { TagInfo } from './tags.ts';
import type { CatalogSource, SourceSync } from './types.ts';

export const AUDIO_EXTENSIONS = new Set(['flac', 'mp3', 'm4a', 'm4b', 'aac', 'ogg', 'oga', 'opus', 'wav', 'aif', 'aiff']);

export const isAudioFile = (name: string) => AUDIO_EXTENSIONS.has(name.split('.').pop()?.toLowerCase() ?? '');

/** A folder (on this server or another machine) as a catalog source. Tags are re-read only for files that changed. */
export class FolderSource implements CatalogSource {
  readonly kind = 'folder' as const;

  constructor(
    private readonly opts: {
      sourceId: number;
      root: string;
      store: CatalogStore;
      /** The folder's filesystem: this server's disk, or another machine over SSH or SFTP. */
      fs: FolderFs;
      readTags?: (path: string, size: number) => Promise<TagInfo | null>;
      /** How many files to read at once; defaults to what the filesystem handles. */
      concurrency?: number;
      /** After each scan: hand new and changed files to the matcher. */
      onScanned?: (sourceId: number) => void;
    },
  ) {}

  async sync(): Promise<SourceSync> {
    const { sourceId, root, store, fs } = this.opts;
    const read = this.opts.readTags ?? ((p: string, size: number) => fs.readTags(p, size));
    // A missing folder usually means a drive, mount or host is offline: fail, so the last scan stays.
    if (!(await fs.stat(root))?.dir) throw new Error(`Folder not found: ${root}`);

    const files = await fs.listAudio(root);
    const cache = store.folderFiles(sourceId);
    const changed: { rel: string; size: number; mtimeMs: number; tags: TagInfo | null }[] = [];
    const entries: FolderEntry[] = [];
    await forEachLimit(files, this.opts.concurrency ?? fs.concurrency, async (f) => {
      const cached = cache.get(f.rel);
      let tags: TagInfo | null;
      if (cached && cached.size === f.size && cached.mtimeMs === f.mtimeMs) {
        tags = cached.tags;
      } else {
        tags = await read(f.path, f.size).catch(() => null);
        changed.push({ ...f, tags });
      }
      if (tags) entries.push({ ...f, tags });
    });
    store.saveFolderFiles(sourceId, changed, files.map((f) => f.rel));
    const sync = this.catalog(entries);
    this.opts.onScanned?.(sourceId);
    return sync;
  }

  /**
   * The catalog from the last scan, without touching the folder: for when only matches changed. Walking
   * a big share again (and re-reading Lidarr) after every few matched albums kept the server busy.
   */
  cached(): SourceSync {
    const { sourceId, root, store } = this.opts;
    const entries: FolderEntry[] = [];
    for (const [rel, f] of store.folderFiles(sourceId)) {
      if (f.tags) entries.push({ rel, path: posix.join(root, rel), size: f.size, mtimeMs: f.mtimeMs, tags: f.tags });
    }
    return this.catalog(entries);
  }

  private catalog(entries: FolderEntry[]): SourceSync {
    const { sourceId, store } = this.opts;
    // Matches lay MusicBrainz ids over the files' own tags; matched releases bring their track lists.
    const matches = store.matches(sourceId);
    const releases = new Map<string, MbReleaseInfo>();
    for (const e of entries) {
      const m = matches.get(e.rel);
      if (!m?.overlay || (m.state !== 'auto' && m.state !== 'manual')) continue;
      e.tags = { ...e.tags, ...m.overlay };
      const id = m.overlay.releaseId;
      const release = id && !releases.has(id) ? store.cachedRelease(id) : undefined;
      if (release) releases.set(release.id, release);
    }
    return folderSync(entries, store.nameIndex(), releases);
  }
}

/** Audio files under `root`, skipping hidden files and folders, not following symlinks. */
export async function listAudioFiles(root: string): Promise<FoundFile[]> {
  const found: FoundFile[] = [];
  async function walk(dir: string, rel: string) {
    const items = await readdir(dir, { withFileTypes: true }).catch((): Dirent[] => []);
    for (const item of items) {
      if (item.name.startsWith('.')) continue;
      const path = join(dir, item.name);
      const itemRel = rel ? `${rel}/${item.name}` : item.name;
      if (item.isDirectory()) await walk(path, itemRel);
      else if (item.isFile() && isAudioFile(item.name)) {
        const s = await stat(path).catch(() => null);
        // birthtimeMs is 0 where the filesystem (or an old kernel) doesn't record it.
        if (s) {
          found.push({
            rel: itemRel,
            path,
            size: s.size,
            mtimeMs: Math.floor(s.mtimeMs),
            ...(s.birthtimeMs > 0 ? { createdMs: Math.floor(s.birthtimeMs) } : {}),
          });
        }
      }
    }
  }
  await walk(root, '');
  return found.sort((a, b) => a.rel.localeCompare(b.rel));
}

async function forEachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}
