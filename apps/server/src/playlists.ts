import type { CoverLayout, PlaylistDetail, PlaylistItem, PlaylistSummary, Track } from '@playarr/shared';
import type { DatabaseSync } from 'node:sqlite';
import type { CoverArt, CoverSnapshot, PlaylistCovers } from './cover/index.ts';
import type { Library, LibraryView } from './library/library.ts';

/** Who's looking: their account, and the library as they may hear it. */
export interface Viewer {
  account: number;
  library: LibraryView;
}

interface PlaylistRow {
  id: number;
  name: string;
  description: string;
  updated_at: string;
  cover_snapshot: string | null;
  account_id: number;
  shared: number;
  owner: string | null;
}

interface ItemRow {
  id: number;
  playlist_id: number;
  recording_id: string;
  title: string;
  artist_name: string;
  album_title: string;
  added_at: string;
}

export class PlaylistError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const PLAYLIST = `SELECT p.id, p.name, p.description, p.updated_at, p.cover_snapshot, p.account_id, p.shared, a.name AS owner
                  FROM playlists p LEFT JOIN accounts a ON a.id = p.account_id`;

/**
 * Playlists of songs keyed by recording id (like favorites), with a title/artist/album snapshot so songs
 * that leave the library still show up, marked unavailable. Each belongs to an account: private, or
 * shared with everyone on this server, who can play it while only its owner changes it.
 */
export class Playlists {
  constructor(
    private readonly db: DatabaseSync,
    /** The whole library: covers are drawn from every song, whoever looks. */
    private readonly library: Library,
    private readonly covers: PlaylistCovers,
  ) {}

  /** The viewer's own playlists and those shared with everyone, most recently changed first. */
  async list(viewer: Viewer): Promise<PlaylistSummary[]> {
    const playlists = this.db
      .prepare(`${PLAYLIST} WHERE p.account_id = ? OR p.shared = 1 ORDER BY p.updated_at DESC`)
      .all(viewer.account) as unknown as PlaylistRow[];
    const items = this.db.prepare('SELECT * FROM playlist_items ORDER BY playlist_id, position').all() as unknown as ItemRow[];
    return Promise.all(
      playlists.map(async (p) => {
        const { items: _items, ...summary } = await this.present(p, items.filter((i) => i.playlist_id === p.id), viewer);
        return summary;
      }),
    );
  }

  async get(id: number, viewer: Viewer): Promise<PlaylistDetail> {
    return this.present(this.row(id, viewer), this.itemRows(id), viewer);
  }

  /** The cover to draw (frozen art, or provisional while songs are still being heard) and the title. */
  async cover(id: number, viewer: Viewer): Promise<{ art: CoverArt; name: string; version: string }> {
    const p = this.row(id, viewer);
    const { art, freeze, version } = await this.covers.describe(this.coverInput(p, await this.resolve(this.itemRows(id), this.library)));
    if (freeze) this.saveCover(id, freeze);
    return { art, name: p.name, version };
  }

  /** Candidate art from the songs as they are now, for the cover picker. */
  async coverCandidate(id: number, layout: CoverLayout, variant: number, viewer: Viewer): Promise<{ art: CoverArt; name: string }> {
    const p = this.row(id, viewer);
    return { art: { dna: await this.covers.liveDna(id, await this.resolve(this.itemRows(id), this.library)), layout, variant }, name: p.name };
  }

  /** Give the playlist a new cover, drawn from its current songs. */
  async setCover(id: number, layout: CoverLayout, variant: number, viewer: Viewer): Promise<PlaylistDetail> {
    this.row(id, viewer, 'own');
    const dna = await this.covers.liveDna(id, await this.resolve(this.itemRows(id), this.library));
    this.saveCover(id, this.covers.snapshot(dna, layout, variant));
    return this.get(id, viewer);
  }

  async create(viewer: Viewer, name: string, description = '', recordingIds: string[] = [], shared = false): Promise<PlaylistDetail> {
    const now = new Date().toISOString();
    const tracks = await this.tracks(recordingIds, viewer);
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO playlists (name, description, created_at, updated_at, account_id, shared) VALUES (?, ?, ?, ?, ?, ?)')
      .run(cleanName(name), cleanDescription(description), now, now, viewer.account, shared ? 1 : 0);
    const id = Number(lastInsertRowid);
    if (tracks.length) this.append(id, tracks);
    return this.get(id, viewer);
  }

  async update(id: number, patch: { name?: string; description?: string; shared?: boolean }, viewer: Viewer): Promise<PlaylistDetail> {
    const p = this.row(id, viewer, 'own');
    this.db
      .prepare('UPDATE playlists SET name = ?, description = ?, shared = ?, updated_at = ? WHERE id = ?')
      .run(
        patch.name !== undefined ? cleanName(patch.name) : p.name,
        patch.description !== undefined ? cleanDescription(patch.description) : p.description,
        patch.shared !== undefined ? (patch.shared ? 1 : 0) : p.shared,
        new Date().toISOString(),
        id,
      );
    return this.get(id, viewer);
  }

  remove(id: number, viewer: Viewer) {
    this.row(id, viewer, 'own');
    this.db.prepare('DELETE FROM playlists WHERE id = ?').run(id);
  }

  /**
   * For Add to playlist: how many of these songs each of the viewer's own playlists already holds (only those that hold
   * any), so the picker can tick them.
   */
  holding(recordingIds: string[], viewer: Viewer): Record<number, number> {
    const wanted = [...new Set(recordingIds)];
    if (!wanted.length) return {};
    const rows = this.db
      .prepare(
        `SELECT i.playlist_id AS id, COUNT(DISTINCT i.recording_id) AS n FROM playlist_items i
         JOIN playlists p ON p.id = i.playlist_id
         WHERE p.account_id = ? AND i.recording_id IN (${wanted.map(() => '?').join(', ')})
         GROUP BY i.playlist_id`,
      )
      .all(viewer.account, ...wanted) as { id: number; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.id, r.n]));
  }

  /** Append songs the owner may hear (duplicates allowed, like most players). Unknown ids are rejected. */
  async addItems(id: number, recordingIds: string[], viewer: Viewer): Promise<PlaylistDetail> {
    this.row(id, viewer, 'own');
    this.append(id, await this.tracks(recordingIds, viewer));
    return this.get(id, viewer);
  }

  async removeItem(id: number, itemId: number, viewer: Viewer): Promise<PlaylistDetail> {
    this.row(id, viewer, 'own');
    const { changes } = this.db.prepare('DELETE FROM playlist_items WHERE id = ? AND playlist_id = ?').run(itemId, id);
    if (!changes) throw new PlaylistError('Song not found in this playlist', 404);
    this.touch(id);
    return this.get(id, viewer);
  }

  /** Set the full order; `itemIds` must be exactly the playlist's items. */
  async reorder(id: number, itemIds: number[], viewer: Viewer): Promise<PlaylistDetail> {
    this.row(id, viewer, 'own');
    const current = (this.db.prepare('SELECT id FROM playlist_items WHERE playlist_id = ?').all(id) as { id: number }[]).map((r) => r.id);
    const same = current.length === itemIds.length && new Set(itemIds).size === itemIds.length && itemIds.every((i) => current.includes(i));
    if (!same) throw new PlaylistError('Order must list every item in the playlist exactly once');
    const update = this.db.prepare('UPDATE playlist_items SET position = ? WHERE id = ?');
    this.transaction(() => {
      itemIds.forEach((itemId, position) => update.run(position, itemId));
      this.touch(id);
    });
    return this.get(id, viewer);
  }

  /** A playlist as this viewer sees it: the songs as their library has them; the cover from all of them. */
  private async present(p: PlaylistRow, rows: ItemRow[], viewer: Viewer): Promise<PlaylistDetail> {
    const items = await this.resolve(rows, viewer.library);
    const all = viewer.library === this.library ? items : await this.resolve(rows, this.library);
    const { info, freeze } = await this.covers.describe(this.coverInput(p, all));
    if (freeze) this.saveCover(p.id, freeze);
    const duration = items.reduce((s, { track }) => s + (track?.duration ?? 0), 0);
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      trackCount: items.length,
      duration,
      cover: info,
      updatedAt: p.updated_at,
      owner: p.owner ?? 'Removed account',
      shared: p.shared === 1,
      mine: p.account_id === viewer.account,
      items,
    };
  }

  /** The playlist if the viewer may see it (theirs, or shared), and change it ('own': theirs only). */
  private row(id: number, viewer: Viewer, need: 'see' | 'own' = 'see'): PlaylistRow {
    const row = this.db.prepare(`${PLAYLIST} WHERE p.id = ?`).get(id) as unknown as PlaylistRow | undefined;
    if (!row || (row.account_id !== viewer.account && row.shared !== 1)) throw new PlaylistError('Playlist not found', 404);
    if (need === 'own' && row.account_id !== viewer.account) throw new PlaylistError('Only its owner can change this playlist', 403);
    return row;
  }

  private itemRows(id: number): ItemRow[] {
    return this.db.prepare('SELECT * FROM playlist_items WHERE playlist_id = ? ORDER BY position').all(id) as unknown as ItemRow[];
  }

  /** The songs for these recordings in the viewer's library, or a 404 naming the first it doesn't have. */
  private async tracks(recordingIds: string[], viewer: Viewer): Promise<Track[]> {
    const tracks: Track[] = [];
    for (const rid of recordingIds) {
      const track = await viewer.library.trackByRecording(rid);
      if (!track) throw new PlaylistError(`Song ${rid} is not in the library`, 404);
      tracks.push(track);
    }
    return tracks;
  }

  private append(id: number, tracks: Track[]) {
    const { next } = this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM playlist_items WHERE playlist_id = ?').get(id) as { next: number };
    const now = new Date().toISOString();
    const insert = this.db.prepare(
      `INSERT INTO playlist_items (playlist_id, position, recording_id, title, artist_name, album_title, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.transaction(() => {
      tracks.forEach((t, i) => insert.run(id, next + i, t.recordingId, t.title, t.artistName, t.albumTitle, now));
      this.touch(id);
    });
  }

  private saveCover(id: number, snapshot: CoverSnapshot) {
    this.db.prepare('UPDATE playlists SET cover_snapshot = ? WHERE id = ?').run(JSON.stringify(snapshot), id);
  }

  private coverInput(p: PlaylistRow, items: PlaylistItem[]) {
    const snapshot = p.cover_snapshot ? (JSON.parse(p.cover_snapshot) as CoverSnapshot) : undefined;
    return { id: p.id, name: p.name, items, snapshot };
  }

  private touch(id: number) {
    this.db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  }

  private transaction(fn: () => void) {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private resolve(rows: ItemRow[], library: Pick<LibraryView, 'trackByRecording'>): Promise<PlaylistItem[]> {
    return Promise.all(
      rows.map(async (r) => ({
        itemId: r.id,
        recordingId: r.recording_id,
        title: r.title,
        artistName: r.artist_name,
        albumTitle: r.album_title,
        addedAt: r.added_at,
        track: await library.trackByRecording(r.recording_id),
      })),
    );
  }
}

function cleanName(name: string): string {
  const n = name.trim().replace(/\s+/g, ' ');
  if (!n) throw new PlaylistError('Playlist name is required');
  if (n.length > 100) throw new PlaylistError('Playlist name is too long (max 100 characters)');
  return n;
}

function cleanDescription(d: string): string {
  const v = d.trim();
  if (v.length > 300) throw new PlaylistError('Description is too long (max 300 characters)');
  return v;
}
