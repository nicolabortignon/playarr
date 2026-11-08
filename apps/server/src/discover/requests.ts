import { readFile, rename } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import type { AlbumRef, AlbumRequest, Availability, AvailabilityState, RequestSettings } from '@playarr/shared';
import { LidarrError, type LidarrClient } from '../lidarr/client.ts';
import type { LidarrAlbum, LidarrCommand, LidarrLookupAlbum, LidarrQueueItem } from '../lidarr/types.ts';
import type { Library, LibraryView, LidarrAlbumRef } from '../library/library.ts';
import { albumKey, baseTitle, normalize } from '../library/search.ts';
import { coverArtArchive, remoteArtUrl } from './art.ts';
import { creditName, releaseGroupRank, type MusicBrainz } from './musicbrainz.ts';

/**
 * Where a request stands: waiting for an admin's answer (its account asks an admin first), gone to Lidarr (asked for by
 * an account that may request, or approved), or declined.
 */
type RequestStatus = 'waiting' | 'approved' | 'declined';

interface StoredRequest {
  mbid: string;
  /** albumKey() of the album as named by Lidarr and by the requesters (e.g. Deezer's title). */
  keys: string[];
  /** Lidarr's album, once the request has gone to Lidarr. */
  lidarrAlbumId?: number;
  title: string;
  artistName: string;
  coverUrl?: string;
  /** When it was last asked for. */
  requestedAt: string;
  commandId?: number;
  /** The account that asked first. */
  requestedBy?: number;
  status: RequestStatus;
  /** The admin who approved or declined it, or the account whose own request sent it on, and when. */
  decidedBy?: number;
  decidedAt?: string;
  /** When the album was first seen playable (for "it's ready"). */
  arrivedAt?: string;
}

interface RequestRow {
  mbid: string;
  keys: string;
  lidarr_album_id: number | null;
  title: string;
  artist_name: string;
  cover_url: string | null;
  requested_at: string;
  command_id: number | null;
  requested_by: number | null;
  status: RequestStatus;
  decided_by: number | null;
  decided_at: string | null;
  arrived_at: string | null;
}

const fromRow = (r: RequestRow): StoredRequest => ({
  mbid: r.mbid,
  keys: JSON.parse(r.keys) as string[],
  ...(r.lidarr_album_id !== null ? { lidarrAlbumId: r.lidarr_album_id } : {}),
  title: r.title,
  artistName: r.artist_name,
  ...(r.cover_url ? { coverUrl: r.cover_url } : {}),
  requestedAt: r.requested_at,
  ...(r.command_id !== null ? { commandId: r.command_id } : {}),
  ...(r.requested_by !== null ? { requestedBy: r.requested_by } : {}),
  status: r.status,
  ...(r.decided_by !== null ? { decidedBy: r.decided_by } : {}),
  ...(r.decided_at !== null ? { decidedAt: r.decided_at } : {}),
  ...(r.arrived_at !== null ? { arrivedAt: r.arrived_at } : {}),
});

/** An account that asked for a request, and when it last looked at Requests. */
interface Asker {
  mbid: string;
  accountId: number;
  name: string;
  seenAt: string | null;
}

/** Whose requests a list is for: an account's own, or every request (admins, and everyone before setup). */
export interface RequestViewer {
  /** The account asking: without accounts, the owner's. */
  accountId: number;
  everyone: boolean;
  /** The library as the account may see it, when it hears only some sources: no link to an album outside them. */
  library?: LibraryView;
}

/** Without accounts (and in tests): the owner, who sees every request. */
const OWNER: RequestViewer = { accountId: 1, everyone: true };

/**
 * A request waiting for an admin's answer: apps that predate approval show it as Lidarr's "nothing found yet", with
 * this as its message.
 */
const WAITING_FOR_APPROVAL: Availability = { state: 'waiting', message: 'Waiting for approval' };

/** An album in the library but outside the sources the account asking hears. */
const NOT_HEARD = 'In a source this account doesn’t hear';

/** The states of a request still on its way to the library: seen in one again, it hasn't arrived after all. */
const ON_ITS_WAY: ReadonlySet<AvailabilityState> = new Set(['searching', 'downloading', 'importing', 'waiting']);

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
 * Turns "I want this album" into Lidarr actions (add → monitor → AlbumSearch) and reports progress by combining Lidarr's
 * command status, download queue and album stats. A request belongs to every account that asked for it; one from an
 * account that asks an admin first waits for an admin's answer before Lidarr hears of it.
 */
export class Requests {
  private requests = new Map<string, StoredRequest>();
  private loaded: Promise<void>;
  private statusCache: { at: number; data: Map<string, Availability> } | null = null;
  private statusInflight: Promise<Map<string, Availability>> | null = null;
  /** How many files Lidarr had for each request at the last look: the library refreshes when that grows. */
  private filesSeen = new Map<string, number>();

  constructor(
    private readonly lidarr: LidarrClient,
    private readonly mb: MusicBrainz,
    private readonly library: Library,
    /** Requests are kept in the database; `legacyFile` is the cache folder's requests.json of before, imported once. */
    private readonly storage: { db: DatabaseSync; legacyFile?: string },
    /** Settings → Requests, read on every request so changes apply at once. */
    private readonly settings: () => RequestSettings,
    /** .env values: used when nothing is chosen in Settings. */
    private readonly env: RequestDefaults = {},
  ) {
    this.loaded = this.load();
  }

  private async load() {
    if (this.storage.legacyFile) await this.importLegacy(this.storage.legacyFile);
    for (const row of this.storage.db.prepare('SELECT * FROM album_requests').all() as unknown as RequestRow[]) {
      this.requests.set(row.mbid, fromRow(row));
    }
  }

  /**
   * The cache folder's requests.json of before: moved into the database, then renamed out of the way. Those had all gone
   * to Lidarr; as the database's own requests of before, they count as arrived when asked and as seen (see db.ts).
   */
  private async importLegacy(file: string) {
    let list: Omit<StoredRequest, 'status'>[];
    try {
      list = JSON.parse(await readFile(file, 'utf8')) as Omit<StoredRequest, 'status'>[];
    } catch {
      return; // none (or unreadable: left where it is, to look at)
    }
    const { db } = this.storage;
    const now = new Date().toISOString();
    db.exec('BEGIN');
    try {
      for (const r of list) {
        this.save({ ...r, keys: r.keys ?? [], status: 'approved', arrivedAt: r.requestedAt });
        if (r.requestedBy !== undefined) this.addAsker(r.mbid, r.requestedBy, r.requestedAt, now);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    await rename(file, `${file}.imported`);
  }

  /**
   * One request, written at once. Who asked stays the first account that did. An account removed since is left out
   * (its foreign keys would refuse it), as the database itself forgets it.
   */
  private save(r: StoredRequest) {
    this.storage.db
      .prepare(
        `INSERT INTO album_requests (mbid, keys, lidarr_album_id, title, artist_name, cover_url, requested_at, command_id, requested_by,
           status, decided_by, decided_at, arrived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT id FROM accounts WHERE id = ?), ?, (SELECT id FROM accounts WHERE id = ?), ?, ?)
         ON CONFLICT (mbid) DO UPDATE SET keys = excluded.keys, lidarr_album_id = excluded.lidarr_album_id, title = excluded.title,
           artist_name = excluded.artist_name, cover_url = excluded.cover_url, requested_at = excluded.requested_at,
           command_id = excluded.command_id, requested_by = IFNULL(album_requests.requested_by, excluded.requested_by),
           status = excluded.status, decided_by = excluded.decided_by, decided_at = excluded.decided_at, arrived_at = excluded.arrived_at`,
      )
      .run(
        r.mbid,
        JSON.stringify(r.keys),
        r.lidarrAlbumId ?? null,
        r.title,
        r.artistName,
        r.coverUrl ?? null,
        r.requestedAt,
        r.commandId ?? null,
        r.requestedBy ?? null,
        r.status,
        r.decidedBy ?? null,
        r.decidedAt ?? null,
        r.arrivedAt ?? null,
      );
  }

  /** `accountId` asked for the request too (once: asking again keeps when it first did). */
  private addAsker(mbid: string, accountId: number, askedAt: string, seenAt: string | null = null) {
    this.storage.db
      .prepare(
        `INSERT INTO album_request_askers (mbid, account_id, asked_at, seen_at) SELECT ?, id, ?, ? FROM accounts WHERE id = ?
         ON CONFLICT (mbid, account_id) DO NOTHING`,
      )
      .run(mbid, askedAt, seenAt, accountId);
  }

  /** Who asked for each request, the first to ask first. */
  private askers(mbid?: string): Map<string, Asker[]> {
    const rows = this.storage.db
      .prepare(
        `SELECT k.mbid, k.account_id AS accountId, a.name, k.seen_at AS seenAt
         FROM album_request_askers k JOIN accounts a ON a.id = k.account_id
         WHERE ? IS NULL OR k.mbid = ?
         ORDER BY k.asked_at, k.account_id`,
      )
      .all(mbid ?? null, mbid ?? null) as unknown as Asker[];
    const byRequest = new Map<string, Asker[]>();
    for (const row of rows) byRequest.set(row.mbid, [...(byRequest.get(row.mbid) ?? []), row]);
    return byRequest;
  }

  /** Every account's display name, by id. */
  private names(): Map<number, string> {
    const rows = this.storage.db.prepare('SELECT id, name FROM accounts').all() as { id: number; name: string }[];
    return new Map(rows.map((r) => [r.id, r.name]));
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

  /** Settings → Requests, once it's known requests can go anywhere: a Lidarr source, and requests on. */
  private settingsForRequests(): RequestSettings {
    if (!this.lidarr.configured) {
      throw new RequestError('Requests need a Lidarr source. Add one in Settings → Sources.', 409);
    }
    const settings = this.settings();
    if (!settings.enabled) throw new RequestError('Requests are turned off in Settings', 403);
    return settings;
  }

  /**
   * Asks Lidarr for the album, for `requestedBy`. `askFirst` (an account that asks an admin first): it waits for an
   * admin's answer instead, unless it has gone to Lidarr and Lidarr still wants it (asking again then only searches
   * again, as anyone may). Asking for an album someone already asked for joins their request.
   */
  async request(ref: AlbumRef, requestedBy?: number, options: { askFirst?: boolean; library?: LibraryView } = {}): Promise<AlbumRequest> {
    await this.loaded;
    const settings = this.settingsForRequests();
    const lookup = await this.find(ref);
    const mbid = lookup.foreignAlbumId;
    const known = await this.library.albumByMbid(mbid);
    // Only some of its songs in the library (a loose song filed under it, say): the rest can be asked for.
    if (known?.albumId !== undefined && known.have === undefined) {
      throw new RequestError('This album is already in your library', 409);
    }
    const existing = this.requests.get(mbid);
    const keys = [albumKey(lookup.artist.artistName, lookup.title)];
    if (!ref.mbid) keys.push(albumKey(ref.artistName, ref.albumTitle));
    const now = new Date().toISOString();
    const fields = {
      mbid,
      keys: [...new Set([...(existing?.keys ?? []), ...keys])],
      title: lookup.title,
      artistName: lookup.artist.artistName,
      coverUrl: remoteArtUrl(lookup.images.find((i) => i.coverType === 'cover')?.remoteUrl) ?? remoteArtUrl(coverArtArchive(mbid, 500)),
      requestedAt: now,
      requestedBy: existing?.requestedBy ?? requestedBy,
    };

    // Asked again after a no, it waits for an answer again; so does one gone to Lidarr that Lidarr no longer wants (removed
    // there, or no longer monitored), which asking again would add back.
    if (options.askFirst && !(existing?.status === 'approved' && lidarrWants(known, lookup))) {
      const stored: StoredRequest = { ...fields, status: 'waiting' };
      this.save(stored);
      if (requestedBy !== undefined) this.addAsker(mbid, requestedBy, now);
      this.requests.set(mbid, stored);
      const availability = await seenBy(withSongs(WAITING_FOR_APPROVAL, songsOf(known)), options.library);
      return { ...this.publicFields(stored), availability, mine: true, approval: 'waiting' };
    }

    const sent = await this.send(lookup, known, settings, existing, {
      ...fields,
      // Waiting for an answer until now: the account whose request sent it on decided.
      ...(existing && existing.status !== 'approved' ? { decidedBy: requestedBy, decidedAt: now } : {}),
    });
    if (requestedBy !== undefined) this.addAsker(mbid, requestedBy, now);
    return { ...this.publicFields(sent.stored), availability: await seenBy(sent.availability, options.library), mine: requestedBy !== undefined };
  }

  /**
   * Wants the album in Lidarr and has it searched for, then keeps the request as gone to Lidarr. "Search right away"
   * off: a new request is only added and monitored, and Lidarr searches on its schedule; asking again for one already
   * sent ("Search again", "Retry") always searches. Asked for again, it hasn't arrived (yet): it's news when it does.
   * `stillAsked`: false once the request was taken back while Lidarr was being asked (an admin approving it as its asker
   * cancels), when Lidarr keeps the album wanted, as for any request taken back after it went there, but the request
   * isn't kept.
   */
  private async send(
    lookup: LidarrLookupAlbum,
    known: LidarrAlbumRef | undefined,
    settings: RequestSettings,
    existing: StoredRequest | undefined,
    fields: Omit<StoredRequest, 'status' | 'lidarrAlbumId' | 'commandId' | 'arrivedAt'>,
    stillAsked: () => boolean = () => true,
  ): Promise<{ stored: StoredRequest; availability: Availability }> {
    const resent = existing?.status === 'approved';
    let albumId = known?.lidarrId ?? lookup.id;
    if (albumId) {
      // Lidarr already tracks it (e.g. part of a monitored artist's discography): just want it.
      await this.lidarr.monitorAlbums([albumId], true);
    } else {
      albumId = (await this.addToLidarr(lookup, settings)).id;
    }
    const command = settings.searchOnAdd || resent ? await this.lidarr.command('AlbumSearch', { albumIds: [albumId] }) : undefined;
    if (!stillAsked()) throw new RequestError('This request was taken back meanwhile', 409);
    const stored: StoredRequest = {
      ...fields,
      ...(resent ? { decidedBy: existing.decidedBy, decidedAt: existing.decidedAt } : {}),
      lidarrAlbumId: albumId,
      commandId: command?.id,
      status: 'approved',
      arrivedAt: undefined,
    };
    this.save(stored);
    this.requests.set(stored.mbid, stored);
    this.statusCache = null;
    this.library.refreshSoon();
    const availability: Availability = command
      ? { state: 'searching', message: 'Searching indexers…' }
      : { state: 'waiting', message: 'Added to Lidarr; it will search on its schedule' };
    return { stored, availability: withSongs(availability, songsOf(known)) };
  }

  /**
   * An admin's yes: the request goes to Lidarr as one from an account that may request would, still asked for when it
   * was. An album that arrived meanwhile (from another source) needs nothing from Lidarr: whoever asked is told it's ready.
   */
  async approve(mbid: string, admin: RequestViewer = OWNER): Promise<AlbumRequest> {
    await this.loaded;
    const asked = this.requests.get(mbid);
    if (!asked) throw new RequestError('This request isn’t there any more', 404);
    if (asked.status === 'approved') return this.viewed(asked, admin);
    const settings = this.settingsForRequests();
    const known = await this.library.albumByMbid(mbid);
    const arrived = known?.albumId !== undefined && known.have === undefined;
    const lookup = arrived ? undefined : await this.lookupByMbid(mbid);
    // As it is now: taken back, or answered, while that was looked up.
    const existing = this.requests.get(mbid);
    if (!existing) throw new RequestError('This request isn’t there any more', 404);
    if (existing.status === 'approved') return this.viewed(existing, admin);
    const now = new Date().toISOString();
    if (!lookup) {
      const stored: StoredRequest = { ...existing, status: 'approved', decidedBy: admin.accountId, decidedAt: now };
      this.save(stored);
      this.requests.set(mbid, stored);
      this.statusCache = null;
      return this.viewed(stored, admin);
    }
    const { stored, availability } = await this.send(
      lookup,
      known,
      settings,
      existing,
      { ...existing, decidedBy: admin.accountId, decidedAt: now },
      () => this.requests.has(mbid),
    );
    return this.viewed(stored, admin, availability);
  }

  /** An admin's no: Lidarr never hears of it, and whoever asked sees it declined until they take it off their list. */
  async decline(mbid: string, admin: RequestViewer = OWNER): Promise<AlbumRequest> {
    await this.loaded;
    const existing = this.requests.get(mbid);
    if (!existing) throw new RequestError('This request isn’t there any more', 404);
    if (existing.status === 'approved') throw new RequestError('This request has already gone to Lidarr', 409);
    const stored: StoredRequest = { ...existing, status: 'declined', decidedBy: admin.accountId, decidedAt: new Date().toISOString() };
    this.save(stored);
    this.requests.set(mbid, stored);
    return this.viewed(stored, admin);
  }

  private find(ref: AlbumRef): Promise<LidarrLookupAlbum> {
    if (ref.mbid) return this.lookupByMbid(ref.mbid);
    return ref.releaseMbid ? this.lookupByRelease(ref) : this.lookupByName(ref);
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
      // The files may call the artist by another name MusicBrainz knows them by ("N Sync" for *NSYNC),
      // which album search doesn't look at: find the artist, then the album in their discography.
      const artist = (await this.mb.searchArtists(ref.artistName)).find((a) => a.score >= 90);
      if (artist) {
        const theirs = (await this.mb.artistReleaseGroups(artist.id))
          .filter((g) => sameTitle(g.title))
          .sort((a, b) => releaseGroupRank(a) - releaseGroupRank(b))[0];
        if (theirs) return this.lookupByMbid(theirs.id);
      }
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

  /**
   * The requests `viewer` may see, newest first, with progress and whose they are: a member's own, or for an admin every
   * request, those waiting for an answer first.
   */
  async list(viewer: RequestViewer = OWNER): Promise<AlbumRequest[]> {
    await this.loaded;
    await this.settleArrived();
    const statuses = await this.statuses();
    const askers = this.askers();
    const names = this.names();
    const waitingFirst = (r: StoredRequest) => (viewer.everyone && r.status === 'waiting' ? 0 : 1);
    const shown = [...this.requests.values()]
      .filter((r) => viewer.everyone || askers.get(r.mbid)?.some((a) => a.accountId === viewer.accountId))
      .sort((a, b) => waitingFirst(a) - waitingFirst(b) || b.requestedAt.localeCompare(a.requestedAt));
    return Promise.all(
      shown.map(async (r) => {
        const availability = r.status === 'approved' ? (statuses.get(r.mbid) ?? { state: 'waiting' }) : await this.answerOf(r, viewer, names);
        return this.describeFor(r, viewer, await seenBy(availability, viewer.library), askers.get(r.mbid) ?? []);
      }),
    );
  }

  /**
   * Takes a request off `viewer`'s list. An admin (who sees every request) forgets it; anyone else stops asking for it,
   * and it's forgotten once nobody is left asking. Lidarr keeps the album wanted.
   */
  async remove(mbid: string, viewer: RequestViewer = OWNER) {
    await this.loaded;
    const { db } = this.storage;
    if (!viewer.everyone) {
      const { changes } = db.prepare('DELETE FROM album_request_askers WHERE mbid = ? AND account_id = ?').run(mbid, viewer.accountId);
      if (!changes || db.prepare('SELECT 1 FROM album_request_askers WHERE mbid = ?').get(mbid)) return;
    }
    this.requests.delete(mbid);
    this.filesSeen.delete(mbid);
    db.prepare('DELETE FROM album_requests WHERE mbid = ?').run(mbid);
  }

  /**
   * The account has looked at Requests: its own requests among `mbids` (every one of them when not given) are no longer
   * news, for the badge on Requests.
   */
  markSeen(accountId: number, mbids?: string[]) {
    const { db } = this.storage;
    const now = new Date().toISOString();
    if (!mbids) {
      db.prepare('UPDATE album_request_askers SET seen_at = ? WHERE account_id = ?').run(now, accountId);
      return;
    }
    const one = db.prepare('UPDATE album_request_askers SET seen_at = ? WHERE account_id = ? AND mbid = ?');
    for (const mbid of new Set(mbids)) one.run(now, accountId, mbid);
  }

  /**
   * Availability for an album known only by name (e.g. a Deezer song's album). `seen`: the library as the account asking
   * may see it, when that's only some sources.
   */
  async availabilityByName(artistName: string, albumTitle: string, seen?: LibraryView): Promise<Availability> {
    return seenBy(await this.everyonesByName(artistName, albumTitle), seen);
  }

  private async everyonesByName(artistName: string, albumTitle: string): Promise<Availability> {
    await this.loaded;
    const albumId = await this.library.albumIdByName(artistName, albumTitle);
    const album = albumId ? await this.library.album(albumId) : undefined;
    const songs: Songs | undefined =
      albumId && album && (album.trackCount < album.totalTrackCount || album.mayBeIncomplete)
        ? { albumId, have: album.trackCount, ...(album.mayBeIncomplete ? {} : { total: album.totalTrackCount }) }
        : undefined;
    if (albumId && !songs) return { state: 'available', albumId };
    const key = albumKey(artistName, albumTitle);
    // Only requests gone to Lidarr: one waiting for an admin (or declined) is the asker's own news, not the album's.
    const req = [...this.requests.values()].find((r) => r.status === 'approved' && r.keys.includes(key));
    if (req) return withSongs((await this.statuses()).get(req.mbid) ?? { state: 'waiting' }, songs);
    return songs ? { state: 'partial', ...songs } : { state: 'none' };
  }

  /**
   * Availability for any release group, whether or not Playarr requested it. `seen`: the library as the account asking
   * may see it, when that's only some sources.
   */
  async availability(mbid: string, seen?: LibraryView): Promise<Availability> {
    return seenBy(await this.everyones(mbid), seen);
  }

  private async everyones(mbid: string): Promise<Availability> {
    await this.loaded;
    const known = await this.library.albumByMbid(mbid);
    const songs = songsOf(known);
    if (known?.albumId !== undefined && !songs) return { state: 'available', albumId: known.albumId };
    if (this.requests.get(mbid)?.status === 'approved') return withSongs((await this.statuses()).get(mbid) ?? { state: 'waiting' }, songs);
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
        this.noteArrivals(data);
        this.statusCache = { at: Date.now(), data };
        return data;
      })
      .finally(() => {
        this.statusInflight = null;
      });
    return this.statusInflight;
  }

  /** Progress of the requests gone to Lidarr. */
  private async computeStatuses(): Promise<Map<string, Availability>> {
    const result = new Map<string, Availability>();
    const pending: StoredRequest[] = [];
    const partial = new Map<string, Songs>();
    for (const r of this.requests.values()) {
      if (r.status !== 'approved') continue;
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
      this.lidarr.albumsByIds(pending.flatMap((r) => r.lidarrAlbumId ?? [])).catch(() => [] as LidarrAlbum[]),
      Promise.all(
        pending.map((r) =>
          r.commandId ? this.lidarr.commandStatus(r.commandId).catch(() => undefined) : undefined,
        ),
      ),
    ]);
    const albumById = new Map(albums.map((a) => [a.id, a]));

    pending.forEach((r, i) => {
      const album = r.lidarrAlbumId === undefined ? undefined : albumById.get(r.lidarrAlbumId);
      const items = queue.filter((q) => q.albumId === r.lidarrAlbumId);
      const songs = partial.get(r.mbid);
      const stats = album?.statistics;
      const files = stats?.trackFileCount ?? 0;
      // Asked for the rest of an album already partly here: done once Lidarr has every track it knows of,
      // even if MusicBrainz lists more (bonus tracks of another edition, say).
      if (songs && stats && stats.trackCount > 0 && stats.trackFileCount >= stats.trackCount && !items.length) {
        result.set(r.mbid, { state: 'available', albumId: songs.albumId });
      } else {
        result.set(r.mbid, describe(album, items, commands[i], songs?.have));
      }
      // Files have landed: pull them into Playarr's library, once each time more land. An album Lidarr
      // only partly found keeps its few files for good: refreshing at every look would rebuild the
      // library nonstop.
      if (files > (this.filesSeen.get(r.mbid) ?? songs?.have ?? 0)) this.library.refreshSoon();
      this.filesSeen.set(r.mbid, files);
    });
    return result;
  }

  /**
   * Requests waiting for an admin's answer whose album arrived anyway (from a monitored artist, Lidarr's own pages or a
   * folder): nothing is left to approve, and whoever asked is told it's ready.
   */
  private async settleArrived() {
    let settled = false;
    for (const r of [...this.requests.values()]) {
      if (r.status !== 'waiting') continue;
      const known = await this.library.albumByMbid(r.mbid);
      // Only part of it here, or taken back or answered while the library was asked.
      if (known?.albumId === undefined || known.have !== undefined || this.requests.get(r.mbid) !== r) continue;
      const stored: StoredRequest = { ...r, status: 'approved', arrivedAt: new Date().toISOString() };
      this.save(stored);
      this.requests.set(r.mbid, stored);
      settled = true;
    }
    if (settled) this.statusCache = null;
  }

  /**
   * Looks at how the requests gone to Lidarr are doing, once, as the server starts with the catalog it saved: one still
   * on its way then is news when it arrives, though nobody looked at Requests in between (the requests of before an
   * update count as arrived until seen otherwise, see db.ts).
   */
  async lookAtStart(): Promise<void> {
    await this.loaded;
    if (!this.lidarr.configured || ![...this.requests.values()].some((r) => r.status === 'approved')) return;
    await this.statuses();
  }

  /**
   * Keeps when each request was first seen playable, for "it's ready". One seen on its way again hasn't arrived after all
   * (its files were removed and it was asked for again). A failure (Lidarr out of reach, say) changes nothing, except
   * for a request of before that only counted as arrived (`arrivedAt` is when it was asked: see db.ts), which hadn't.
   */
  private noteArrivals(statuses: Map<string, Availability>) {
    const now = new Date().toISOString();
    for (const [mbid, { state }] of statuses) {
      const r = this.requests.get(mbid);
      if (r?.status !== 'approved') continue;
      const assumed = r.arrivedAt !== undefined && r.arrivedAt === r.requestedAt;
      const arrivedAt = state === 'available' ? (r.arrivedAt ?? now) : ON_ITS_WAY.has(state) || assumed ? undefined : r.arrivedAt;
      if (arrivedAt === r.arrivedAt) continue;
      this.requests.set(mbid, { ...r, arrivedAt });
      this.storage.db.prepare('UPDATE album_requests SET arrived_at = ? WHERE mbid = ?').run(arrivedAt ?? null, mbid);
    }
  }

  /**
   * How a request that hasn't gone to Lidarr reads: waiting for an answer, or declined (and by whom: "Declined by you" to
   * the admin who did), with the songs already here when it's for the rest of an album.
   */
  private async answerOf(r: StoredRequest, viewer: RequestViewer, names: Map<number, string>): Promise<Availability> {
    const songs = songsOf(await this.library.albumByMbid(r.mbid));
    if (r.status !== 'declined') return withSongs(WAITING_FOR_APPROVAL, songs);
    const by = r.decidedBy === undefined ? undefined : r.decidedBy === viewer.accountId ? 'you' : names.get(r.decidedBy);
    return withSongs({ state: 'failed', message: by ? `Declined by ${by}` : 'Declined' }, songs);
  }

  /** A request as `viewer` sees it, with how it's doing now unless `availability` says it. */
  private async viewed(r: StoredRequest, viewer: RequestViewer, availability?: Availability): Promise<AlbumRequest> {
    const names = this.names();
    const now =
      availability ?? (r.status === 'approved' ? ((await this.statuses()).get(r.mbid) ?? { state: 'waiting' }) : await this.answerOf(r, viewer, names));
    return this.describeFor(this.requests.get(r.mbid) ?? r, viewer, await seenBy(now, viewer.library), this.askers(r.mbid).get(r.mbid) ?? []);
  }

  /** A request for `viewer`: whether they asked for it and whether that's news to them, and for an admin who else did. */
  private describeFor(r: StoredRequest, viewer: RequestViewer, availability: Availability, askers: Asker[]): AlbumRequest {
    const own = askers.find((a) => a.accountId === viewer.accountId);
    return {
      ...this.publicFields(r),
      availability,
      mine: !!own,
      ...(viewer.everyone ? { askedBy: askers.filter((a) => a !== own).map((a) => a.name) } : {}),
      ...(r.status !== 'approved' ? { approval: r.status } : {}),
      ...(own ? { unseen: isNews(r, own) } : {}),
    };
  }

  private publicFields(r: StoredRequest): Omit<AlbumRequest, 'availability'> {
    return { mbid: r.mbid, title: r.title, artistName: r.artistName, coverUrl: r.coverUrl, requestedAt: r.requestedAt };
  }
}

/**
 * Lidarr has the album and wants it, so asking again would only have it searched for again: the catalog's word when it
 * knows the album from Lidarr, else the lookup's.
 */
function lidarrWants(known: LidarrAlbumRef | undefined, lookup: LidarrLookupAlbum): boolean {
  if (known?.lidarrId) return known.monitored;
  return !!lookup.id && lookup.monitored === true;
}

/** Whether a request is news to one who asked for it: arrived, or declined, since they last looked at Requests. */
function isNews(r: StoredRequest, asker: Asker): boolean {
  const since = asker.seenAt ?? '';
  if (r.status === 'approved') return !!r.arrivedAt && r.arrivedAt > since;
  return r.status === 'declined' && !!r.decidedAt && r.decidedAt > since;
}

/** Some of an album's songs in the library: which album, how many, out of how many (where known). */
interface Songs {
  albumId: number;
  have: number;
  total?: number;
}

function songsOf(known: LidarrAlbumRef | undefined): Songs | undefined {
  return known?.albumId !== undefined && known.have !== undefined
    ? { albumId: known.albumId, have: known.have, ...(known.total !== undefined ? { total: known.total } : {}) }
    : undefined;
}

/**
 * Availability as an account that hears only some sources has it (`seen`, its view of the library): Lidarr's progress
 * and the household's requests as they are, but no link to an album outside its sources. Such an album, whole, is
 * still in the library (asking for it again would bring nothing); with only some of its songs there, the rest can be
 * asked for as if none were.
 */
async function seenBy(availability: Availability, seen: LibraryView | undefined): Promise<Availability> {
  const { albumId, have: _have, total: _total, ...rest } = availability;
  if (!seen?.sources || albumId === undefined || (await seen.album(albumId))) return availability;
  if (rest.state === 'partial') return { state: 'none' };
  return rest.state === 'available' ? { ...rest, message: NOT_HEARD } : rest;
}

/** A request's progress, plus the songs already here (so the album can still be opened). */
function withSongs(availability: Availability, songs: Songs | undefined): Availability {
  return songs && availability.state !== 'available' ? { ...availability, ...songs } : availability;
}

function describe(
  album: LidarrAlbum | undefined,
  items: LidarrQueueItem[],
  command: LidarrCommand | undefined,
  /** Songs of the album already in the library. */
  have = 0,
): Availability {
  if (!album) return { state: 'failed', message: 'Album was removed from Lidarr' };
  // Files the library doesn't have yet (the songs it has came from them, or from elsewhere).
  if ((album.statistics?.trackFileCount ?? 0) > have && !items.length) {
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
