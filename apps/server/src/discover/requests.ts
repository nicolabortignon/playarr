import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AlbumRef, AlbumRequest, Availability } from '@playarr/shared';
import { LidarrError, type LidarrClient } from '../lidarr/client.ts';
import type { LidarrAlbum, LidarrCommand, LidarrLookupAlbum, LidarrQueueItem } from '../lidarr/types.ts';
import type { Library } from '../library/library.ts';
import { albumKey, baseTitle, normalize } from '../library/search.ts';
import { coverArtArchive, remoteArtUrl } from './art.ts';
import { creditName, releaseGroupRank, type MusicBrainz } from './musicbrainz.ts';

interface StoredRequest {
  mbid: string;
  /** albumKey() of the album as named by Lidarr and by the requester (e.g. Deezer's title). */
  keys: string[];
  lidarrAlbumId: number;
  title: string;
  artistName: string;
  coverUrl?: string;
  requestedAt: string;
  commandId?: number;
}

export interface RequestDefaults {
  rootFolderPath?: string;
  qualityProfileId?: number;
  metadataProfileId?: number;
}

export class RequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** Lidarr's queue can be megabytes and Lidarr is often busy; don't ask more than this often. */
const STATUS_TTL_MS = 15_000;

/**
 * Turns "I want this album" into Lidarr actions (add → monitor → AlbumSearch)
 * and reports progress by combining Lidarr's command status, download queue and album stats.
 */
export class Requests {
  private requests = new Map<string, StoredRequest>();
  private loaded: Promise<void>;
  private statusCache: { at: number; data: Map<string, Availability> } | null = null;
  private statusInflight: Promise<Map<string, Availability>> | null = null;

  constructor(
    private readonly lidarr: LidarrClient,
    private readonly mb: MusicBrainz,
    private readonly library: Library,
    private readonly file: string,
    private readonly overrides: RequestDefaults,
  ) {
    this.loaded = readFile(file, 'utf8')
      .then((raw) => {
        for (const r of JSON.parse(raw) as StoredRequest[]) this.requests.set(r.mbid, { ...r, keys: r.keys ?? [] });
      })
      .catch(() => {});
  }

  private async save() {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(`${this.file}.tmp`, JSON.stringify([...this.requests.values()], null, 2));
    await rename(`${this.file}.tmp`, this.file);
  }

  /** Root folder and profiles for new artists: env overrides, else the root folder's defaults. */
  private async defaults(): Promise<Required<RequestDefaults>> {
    const roots = await this.lidarr.rootFolders();
    const root = roots.find((r) => r.path === this.overrides.rootFolderPath) ?? roots[0];
    if (!root) throw new RequestError('Lidarr has no root folder configured', 500);
    return {
      rootFolderPath: root.path,
      qualityProfileId: this.overrides.qualityProfileId ?? root.defaultQualityProfileId ?? 1,
      metadataProfileId: this.overrides.metadataProfileId ?? root.defaultMetadataProfileId ?? 1,
    };
  }

  async request(ref: AlbumRef): Promise<AlbumRequest> {
    await this.loaded;
    if (!this.lidarr.configured) {
      throw new RequestError('Requests need a Lidarr source. Add one in Settings → Sources.', 409);
    }
    const lookup = ref.mbid
      ? await this.lookupByMbid(ref.mbid)
      : ref.releaseMbid
        ? await this.lookupByRelease(ref)
        : await this.lookupByName(ref);
    const mbid = lookup.foreignAlbumId;
    const known = await this.library.albumByMbid(mbid);
    if (known?.albumId !== undefined) {
      throw new RequestError('This album is already in your library', 409);
    }

    let albumId = known?.lidarrId ?? lookup.id;
    if (albumId) {
      // Lidarr already tracks it (e.g. part of a monitored artist's discography): just want it.
      await this.lidarr.monitorAlbums([albumId], true);
    } else {
      albumId = (await this.addToLidarr(lookup)).id;
    }

    const command = await this.lidarr.command('AlbumSearch', { albumIds: [albumId] });
    const cover = lookup.images.find((i) => i.coverType === 'cover')?.remoteUrl;
    const keys = [albumKey(lookup.artist.artistName, lookup.title)];
    if (!ref.mbid) keys.push(albumKey(ref.artistName, ref.albumTitle));
    const stored: StoredRequest = {
      mbid,
      keys: [...new Set(keys)],
      lidarrAlbumId: albumId,
      title: lookup.title,
      artistName: lookup.artist.artistName,
      coverUrl: remoteArtUrl(cover) ?? remoteArtUrl(coverArtArchive(mbid, 500)),
      requestedAt: new Date().toISOString(),
      commandId: command.id,
    };
    this.requests.set(mbid, stored);
    this.statusCache = null;
    await this.save();
    this.library.refreshSoon();
    return { ...this.publicFields(stored), availability: { state: 'searching', message: 'Searching indexers…' } };
  }

  private async lookupByMbid(mbid: string): Promise<LidarrLookupAlbum> {
    const lookup = await this.lidarr.albumByMbid(mbid).catch((err: Error) => {
      throw new RequestError(`Lidarr couldn't look up this album: ${err.message}`, 502);
    });
    if (!lookup) throw new RequestError('Album not found in Lidarr’s metadata', 404);
    return lookup;
  }

  /** A specific release (e.g. from ListenBrainz) → its release group; falls back to the name. */
  private async lookupByRelease(ref: AlbumRef): Promise<LidarrLookupAlbum> {
    const group = await this.mb.releaseGroupOf(ref.releaseMbid!).catch(() => undefined);
    return group ? this.lookupByMbid(group.id) : this.lookupByName(ref);
  }

  /**
   * Resolve "artist + album title" (e.g. from a Deezer song) to a MusicBrainz release group.
   * MusicBrainz first: its search is reliable and lets us prefer the studio album over a
   * same-named single or remix. Lidarr's own lookup is the fallback if MusicBrainz is down.
   */
  private async lookupByName(ref: AlbumRef): Promise<LidarrLookupAlbum> {
    const title = baseTitle(ref.albumTitle) || ref.albumTitle;
    const wantTitle = normalize(title);
    const wantArtist = normalize(ref.artistName);
    const sameArtist = (name: string) => {
      const n = normalize(name);
      return n === wantArtist || n.includes(wantArtist) || wantArtist.includes(n);
    };
    const sameTitle = (t: string) => normalize(baseTitle(t) || t) === wantTitle;

    let mbError: Error | undefined;
    try {
      const groups = await this.mb.searchReleaseGroups(ref.artistName, title);
      const match = groups
        .filter((g) => sameTitle(g.title) && sameArtist(creditName(g['artist-credit'])))
        .sort((a, b) => releaseGroupRank(a) - releaseGroupRank(b))[0];
      if (match) return this.lookupByMbid(match.id);
    } catch (err) {
      mbError = err as Error;
    }

    const hits = await this.lidarr.search(`${ref.artistName} ${title}`).catch(() => []);
    const album = hits.find((h) => h.album && sameTitle(h.album.title) && sameArtist(h.album.artist.artistName))?.album;
    if (album) return album;

    if (mbError) throw new RequestError(`MusicBrainz is unavailable right now (${mbError.message}). Try again shortly.`, 503);
    throw new RequestError(`Couldn't find “${title}” by ${ref.artistName} on MusicBrainz`, 404);
  }

  private async addToLidarr(lookup: LidarrLookupAlbum): Promise<LidarrAlbum> {
    const album: LidarrLookupAlbum = {
      ...lookup,
      monitored: true,
      anyReleaseOk: true,
      // We start the search ourselves so we can track the command.
      addOptions: { searchForNewAlbum: false },
    };
    if (!lookup.artist.id) {
      const d = await this.defaults();
      album.artist = {
        ...lookup.artist,
        ...d,
        monitored: true,
        // Only the requested album is wanted; the rest of the discography stays unmonitored.
        monitorNewItems: 'none',
        tags: [],
        addOptions: { monitor: 'none', searchForMissingAlbums: false },
      };
    }
    try {
      return await this.lidarr.addAlbum(album);
    } catch (err) {
      const msg = err instanceof LidarrError ? err.message : String(err);
      throw new RequestError(`Lidarr refused to add the album: ${msg}`, 502);
    }
  }

  async list(): Promise<AlbumRequest[]> {
    await this.loaded;
    const statuses = await this.statuses();
    return [...this.requests.values()]
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
      .map((r) => ({ ...this.publicFields(r), availability: statuses.get(r.mbid) ?? { state: 'waiting' } }));
  }

  async remove(mbid: string) {
    await this.loaded;
    this.requests.delete(mbid);
    await this.save();
  }

  /** Availability for an album known only by name (e.g. a Deezer song's album). */
  async availabilityByName(artistName: string, albumTitle: string): Promise<Availability> {
    await this.loaded;
    const albumId = await this.library.albumIdByName(artistName, albumTitle);
    if (albumId) return { state: 'available', albumId };
    const key = albumKey(artistName, albumTitle);
    const req = [...this.requests.values()].find((r) => r.keys.includes(key));
    if (req) return (await this.statuses()).get(req.mbid) ?? { state: 'waiting' };
    return { state: 'none' };
  }

  /** Availability for any release group, whether or not Playarr requested it. */
  async availability(mbid: string): Promise<Availability> {
    await this.loaded;
    const known = await this.library.albumByMbid(mbid);
    if (known?.albumId !== undefined) return { state: 'available', albumId: known.albumId };
    if (this.requests.has(mbid)) return (await this.statuses()).get(mbid) ?? { state: 'waiting' };
    if (known?.monitored) return { state: 'waiting', message: 'Wanted in Lidarr' };
    return { state: 'none' };
  }

  private statuses(): Promise<Map<string, Availability>> {
    if (this.statusCache && Date.now() - this.statusCache.at < STATUS_TTL_MS) {
      return Promise.resolve(this.statusCache.data);
    }
    this.statusInflight ??= this.computeStatuses()
      .then((data) => {
        this.statusCache = { at: Date.now(), data };
        return data;
      })
      .finally(() => {
        this.statusInflight = null;
      });
    return this.statusInflight;
  }

  private async computeStatuses(): Promise<Map<string, Availability>> {
    const result = new Map<string, Availability>();
    const pending: StoredRequest[] = [];
    for (const r of this.requests.values()) {
      const known = await this.library.albumByMbid(r.mbid);
      if (known?.albumId !== undefined) result.set(r.mbid, { state: 'available', albumId: known.albumId });
      else pending.push(r);
    }
    if (!pending.length) return result;

    const [queue, albums, commands] = await Promise.all([
      this.lidarr.queue().catch(() => [] as LidarrQueueItem[]),
      this.lidarr.albumsByIds(pending.map((r) => r.lidarrAlbumId)).catch(() => [] as LidarrAlbum[]),
      Promise.all(
        pending.map((r) =>
          r.commandId ? this.lidarr.commandStatus(r.commandId).catch(() => undefined) : undefined,
        ),
      ),
    ]);
    const albumById = new Map(albums.map((a) => [a.id, a]));

    pending.forEach((r, i) => {
      const album = albumById.get(r.lidarrAlbumId);
      const items = queue.filter((q) => q.albumId === r.lidarrAlbumId);
      result.set(r.mbid, describe(album, items, commands[i]));
      // Files have landed: pull them into Playarr's library.
      if ((album?.statistics?.trackFileCount ?? 0) > 0) this.library.refreshSoon();
    });
    return result;
  }

  private publicFields(r: StoredRequest): Omit<AlbumRequest, 'availability'> {
    return { mbid: r.mbid, title: r.title, artistName: r.artistName, coverUrl: r.coverUrl, requestedAt: r.requestedAt };
  }
}

function describe(
  album: LidarrAlbum | undefined,
  items: LidarrQueueItem[],
  command: LidarrCommand | undefined,
): Availability {
  if (!album) return { state: 'failed', message: 'Album was removed from Lidarr' };
  if ((album.statistics?.trackFileCount ?? 0) > 0 && !items.length) {
    return { state: 'importing', message: 'Adding to your library…' };
  }
  if (items.length) {
    const size = items.reduce((s, q) => s + q.size, 0);
    const left = items.reduce((s, q) => s + q.sizeleft, 0);
    const problem = items.find((q) => q.trackedDownloadStatus === 'error' || q.trackedDownloadStatus === 'warning');
    const problemText =
      problem?.errorMessage ?? problem?.statusMessages?.flatMap((m) => m.messages)[0] ?? undefined;
    const states = items.map((q) => q.trackedDownloadState ?? '');
    if (states.some((s) => s === 'failed' || s === 'failedPending')) {
      return { state: 'failed', message: problemText ?? 'Download failed' };
    }
    if (states.some((s) => s === 'importPending' || s === 'importing')) {
      return { state: 'importing', message: problemText ?? 'Importing…' };
    }
    return {
      state: 'downloading',
      progress: size > 0 ? Math.min(1, Math.max(0, 1 - left / size)) : 0,
      message: problemText ?? (items[0]?.timeleft ? `${items[0].timeleft} left` : items[0]?.status),
    };
  }
  if (command && (command.status === 'queued' || command.status === 'started')) {
    return { state: 'searching', message: 'Searching indexers…' };
  }
  if (command?.status === 'failed') return { state: 'failed', message: command.message ?? 'Search failed' };
  return {
    state: 'waiting',
    message: album.monitored ? 'No release found yet. Lidarr will keep looking' : 'Not monitored in Lidarr',
  };
}
