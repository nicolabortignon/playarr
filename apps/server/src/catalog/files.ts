import { posix } from 'node:path';
import { mapPath, type MediaSource } from '../media/index.ts';
import type { FileRecord } from './build.ts';
import type { FolderFs } from './folderFs.ts';
import { isInside } from './paths.ts';
import type { CatalogStore } from './store.ts';

export class FileAccessError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface ResolvedFile {
  media: MediaSource;
  path: string;
}

/**
 * Where a copy's bytes are and how to read them: Lidarr files through MEDIA_SOURCE and PATH_MAP,
 * folder files through their source's filesystem (this server, SSH or SFTP). Never outside the configured folders.
 */
export class FileResolver {
  constructor(
    private readonly store: CatalogStore,
    private readonly lidarr: { media: MediaSource; pathMap: [string, string][] },
    private readonly folders: { get(sourceId: number): FolderFs | undefined },
  ) {}

  resolve(file: FileRecord): ResolvedFile {
    const source = this.store.source(file.sourceId);
    if (!source) throw new FileAccessError('This file’s source was removed', 404);
    if (source.kind === 'folder') {
      const root = (source.settings as { path?: string }).path;
      const path = posix.normalize(file.path);
      if (!root || !isInside(path, root)) throw new FileAccessError('File is outside the source folder', 403);
      const fs = this.folders.get(file.sourceId);
      if (!fs) throw new FileAccessError('This file’s source was removed', 404);
      return { media: fs.media, path };
    }
    const path = mapPath(file.path, this.lidarr.pathMap);
    const roots = this.lidarr.pathMap.map(([, to]) => to);
    if (roots.length && !roots.some((root) => isInside(path, root))) {
      throw new FileAccessError('File is outside the configured music folders', 403);
    }
    return { media: this.lidarr.media, path };
  }

  /**
   * Whether the source answers (catalog/health.ts): a folder's connection, and its folder there with something in
   * it (an unmounted disk leaves an empty folder behind); for Lidarr, its music folders as PATH_MAP gives them.
   * Undefined when there's nothing to ask: a source removed, or Lidarr's files without PATH_MAP.
   */
  probe(sourceId: number): Promise<void> | undefined {
    const source = this.store.source(sourceId);
    if (!source) return undefined;
    if (source.kind === 'folder') {
      const root = (source.settings as { path?: string }).path;
      const fs = this.folders.get(sourceId);
      if (!root || !fs) return undefined;
      return (async () => {
        await fs.media.check();
        if (!(await fs.stat(root))?.dir) throw new Error(`${root} isn’t there`);
        if (!(await fs.readdir(root)).length) throw new Error(`${root} is empty`);
      })();
    }
    const roots = [...new Set(this.lidarr.pathMap.map(([, to]) => to))];
    if (!roots.length) return undefined;
    return Promise.all(roots.map((root) => this.lidarr.media.check(root))).then(() => {});
  }
}
