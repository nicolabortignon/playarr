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
}
