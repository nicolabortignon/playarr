import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AlbumRef, AlbumRequest, Availability, RequestSettings } from '@playarr/shared';
import { LidarrError, type LidarrClient } from '../lidarr/client.ts';
import type { LidarrAlbum, LidarrCommand, LidarrLookupAlbum, LidarrQueueItem } from '../lidarr/types.ts';
import type { Library, LidarrAlbumRef } from '../library/library.ts';
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
    /** Settings → Requests, read on every request so changes apply at once. */
    private readonly settings: () => RequestSettings,
    /** .env values: used when nothing is chosen in Settings. */
    private readonly env: RequestDefaults = {},
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

  /**
   * Root folder and profiles for new artists: Settings, then .env, then the root folder's defaults.
   * A chosen root folder Lidarr no longer has is skipped.
   */
  private async defaults(settings: RequestSettings): Promise<Required<RequestDefaults>> {
    const roots = await this.lidarr.rootFolders();
    const root =
      roots.find((r) => r.path === settings.rootFolderPath) ??
      roots.find((r) => r.path === this.env.rootFolderPath) ??
      roots[0];
    if (!root) throw new RequestError('Lidarr has no root folder configured', 500);
    return {
      rootFolderPath: root.path,
      qualityProfileId: settings.qualityProfileId ?? this.env.qualityProfileId ?? root.defaultQualityProfileId ?? 1,
      metadataProfileId: settings.metadataProfileId ?? this.env.metadataProfileId ?? root.defaultMetadataProfileId ?? 1,
    };
  }

  async request(ref: AlbumRef): Promise<AlbumRequest> {
    await this.loaded;
    if (!this.lidarr.configured) {
      throw new RequestError('Requests need a Lidarr source. Add one in Settings → Sources.', 409);
    }
    const settings = this.settings();
    if (!settings.enabled) throw new RequestError('Requests are turned off in Settings', 403);
    const lookup = ref.mbid
      ? await this.lookupByMbid(ref.mbid)
      : ref.releaseMbid
        ? await this.lookupByRelease(ref)
        : await this.lookupByName(ref);
    const mbid = lookup.foreignAlbumId;
    const known = await this.library.albumByMbid(mbid);
    // Only some of its songs in the library (a loose song filed under it, say): the rest can be asked for.
    if (known?.albumId !== undefined && known.have === undefined) {
      throw new RequestError('This album is already in your library', 409);
    }

    let albumId = known?.lidarrId ?? lookup.id;
    if (albumId) {
      // Lidarr already tracks it (e.g. part of a monitored artist's discography): just want it.
      await this.lidarr.monitorAlbums([albumId], true);
    } else {
      albumId = (await this.addToLidarr(lookup, settings)).id;
    }

    // "Search right away" off: a new request is only added and monitored, and Lidarr searches on its schedule.
    // Asking again for one Playarr already requested ("Search again", "Retry") always searches.
    const command =
      settings.searchOnAdd || this.requests.has(mbid)
        ? await this.lidarr.command('AlbumSearch', { albumIds: [albumId] })
        : undefined;
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
      commandId: command?.id,
    };
    this.requests.set(mbid, stored);
    this.statusCache = null;
    await this.save();
    this.library.refreshSoon();
    const availability: Availability = command
      ? { state: 'searching', message: 'Searching indexers…' }
      : { state: 'waiting', message: 'Added to Lidarr; it will search on its schedule' };
    return { ...this.publicFields(stored), availability };
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

  private async addToLidarr(lookup: LidarrLookupAlbum, settings: RequestSettings): Promise<LidarrAlbum> {
    const album: LidarrLookupAlbum = {
      ...lookup,
      monitored: true,
      anyReleaseOk: true,
      // We start the search ourselves so we can track the command.
      addOptions: { searchForNewAlbum: false },
    };
    if (!lookup.artist.id) {
      const d = await this.defaults(settings);
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
    const album = albumId ? await this.library.album(albumId) : undefined;
    const songs: Songs | undefined =
      albumId && album && album.trackCount < album.totalTrackCount
        ? { albumId, have: album.trackCount, total: album.totalTrackCount }
        : undefined;
    if (albumId && !songs) return { state: 'available', albumId };
    const key = albumKey(artistName, albumTitle);
    const req = [...this.requests.values()].find((r) => r.keys.includes(key));
    if (req) return withSongs((await this.statuses()).get(req.mbid) ?? { state: 'waiting' }, songs);
    return songs ? { state: 'partial', ...songs } : { state: 'none' };
  }

  /** Availability for any release group, whether or not Playarr requested it. */
  async availability(mbid: string): Promise<Availability> {
    await this.loaded;
    const known = await this.library.albumByMbid(mbid);
    const songs = songsOf(known);
    if (known?.albumId !== undefined && !songs) return { state: 'available', albumId: known.albumId };
    if (this.requests.has(mbid)) return withSongs((await this.statuses()).get(mbid) ?? { state: 'waiting' }, songs);
    if (known?.monitored) return withSongs({ state: 'waiting', message: 'Wanted in Lidarr' }, songs);
    if (songs) return { state: 'partial', ...songs };
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
    const partial = new Map<string, Songs>();
    for (const r of this.requests.values()) {
      const known = await this.library.albumByMbid(r.mbid);
      const songs = songsOf(known);
      if (known?.albumId !== undefined && !songs) result.set(r.mbid, { state: 'available', albumId: known.albumId });
      else {
        if (songs) partial.set(r.mbid, songs);
        pending.push(r);
      }
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
      const songs = partial.get(r.mbid);
      const stats = album?.statistics;
      // Asked for the rest of an album already partly here: done once Lidarr has every track it knows of,
      // even if MusicBrainz lists more (bonus tracks of another edition, say).
      if (songs && stats && stats.trackCount > 0 && stats.trackFileCount >= stats.trackCount && !items.length) {
        result.set(r.mbid, { state: 'available', albumId: songs.albumId });
      } else {
        result.set(r.mbid, describe(album, items, commands[i]));
      }
      // Files have landed: pull them into Playarr's library.
      if ((album?.statistics?.trackFileCount ?? 0) > 0) this.library.refreshSoon();
    });
    return result;
  }

  private publicFields(r: StoredRequest): Omit<AlbumRequest, 'availability'> {
    return { mbid: r.mbid, title: r.title, artistName: r.artistName, coverUrl: r.coverUrl, requestedAt: r.requestedAt };
  }
}

/** Some of an album's songs in the library: which album, how many, out of how many. */
interface Songs {
  albumId: number;
  have: number;
  total: number;
}

function songsOf(known: LidarrAlbumRef | undefined): Songs | undefined {
  return known?.albumId !== undefined && known.have !== undefined && known.total !== undefined
    ? { albumId: known.albumId, have: known.have, total: known.total }
    : undefined;
}

/** A request's progress, plus the songs already here (so the album can still be opened). */
function withSongs(availability: Availability, songs: Songs | undefined): Availability {
  return songs && availability.state !== 'available' ? { ...availability, ...songs } : availability;
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
