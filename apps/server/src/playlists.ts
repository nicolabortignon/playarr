import type { CoverLayout, PlaylistDetail, PlaylistItem, PlaylistSummary, Track } from '@playarr/shared';
import type { DatabaseSync } from 'node:sqlite';
import type { CoverArt, CoverSnapshot, PlaylistCovers } from './cover/index.ts';
import type { Library } from './library/library.ts';

interface PlaylistRow {
  id: number;
  name: string;
  description: string;
  updated_at: string;
  cover_snapshot: string | null;
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

/**
 * Playlists of songs keyed by recording id (like favorites), with a title/artist/album
 * snapshot so songs that leave the library still show up, marked unavailable.
 */
export class Playlists {
  constructor(
    private readonly db: DatabaseSync,
    private readonly library: Library,
    private readonly covers: PlaylistCovers,
  ) {}

  async list(): Promise<PlaylistSummary[]> {
    const playlists = this.db
      .prepare('SELECT id, name, description, updated_at, cover_snapshot FROM playlists ORDER BY updated_at DESC')
      .all() as unknown as PlaylistRow[];
    const items = this.db
      .prepare('SELECT * FROM playlist_items ORDER BY playlist_id, position')
      .all() as unknown as ItemRow[];
    return Promise.all(
      playlists.map(async (p) => {
        const resolved = await this.resolve(items.filter((i) => i.playlist_id === p.id));
        return this.summarize(p, resolved);
      }),
    );
  }

  async get(id: number): Promise<PlaylistDetail> {
    const p = this.row(id);
    const items = await this.items(id);
    return { ...(await this.summarize(p, items)), items };
  }

  /** The cover to draw (frozen art, or provisional while songs are still being heard) and the title. */
  async cover(id: number): Promise<{ art: CoverArt; name: string; version: string }> {
    const p = this.row(id);
    const { art, freeze, version } = await this.covers.describe(this.coverInput(p, await this.items(id)));
    if (freeze) this.saveCover(id, freeze);
    return { art, name: p.name, version };
  }

  /** Candidate art from the songs as they are now, for the cover picker. */
  async coverCandidate(id: number, layout: CoverLayout, variant: number): Promise<{ art: CoverArt; name: string }> {
    const p = this.row(id);
    return { art: { dna: await this.covers.liveDna(id, await this.items(id)), layout, variant }, name: p.name };
  }

  /** Give the playlist a new cover, drawn from its current songs. */
  async setCover(id: number, layout: CoverLayout, variant: number): Promise<PlaylistDetail> {
    this.row(id);
    const dna = await this.covers.liveDna(id, await this.items(id));
    this.saveCover(id, this.covers.snapshot(dna, layout, variant));
    return this.get(id);
  }

  private saveCover(id: number, snapshot: CoverSnapshot) {
    this.db.prepare('UPDATE playlists SET cover_snapshot = ? WHERE id = ?').run(JSON.stringify(snapshot), id);
  }

  private coverInput(p: PlaylistRow, items: PlaylistItem[]) {
    const snapshot = p.cover_snapshot ? (JSON.parse(p.cover_snapshot) as CoverSnapshot) : undefined;
    return { id: p.id, name: p.name, items, snapshot };
  }

  private async items(id: number): Promise<PlaylistItem[]> {
    return this.resolve(
      this.db
        .prepare('SELECT * FROM playlist_items WHERE playlist_id = ? ORDER BY position')
        .all(id) as unknown as ItemRow[],
    );
  }

  private async summarize(p: PlaylistRow, items: PlaylistItem[]): Promise<PlaylistSummary> {
    const duration = items.reduce((s, { track }) => s + (track?.duration ?? 0), 0);
    const { info, freeze } = await this.covers.describe(this.coverInput(p, items));
    if (freeze) this.saveCover(p.id, freeze);
    return { id: p.id, name: p.name, description: p.description, trackCount: items.length, duration, cover: info, updatedAt: p.updated_at };
  }

  async create(name: string, description = '', recordingIds: string[] = []): Promise<PlaylistDetail> {
    const now = new Date().toISOString();
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO playlists (name, description, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(cleanName(name), cleanDescription(description), now, now);
    const id = Number(lastInsertRowid);
    if (recordingIds.length) await this.addItems(id, recordingIds);
    return this.get(id);
  }

  async update(id: number, patch: { name?: string; description?: string }): Promise<PlaylistDetail> {
    const p = this.row(id);
    this.db
      .prepare('UPDATE playlists SET name = ?, description = ?, updated_at = ? WHERE id = ?')
      .run(
        patch.name !== undefined ? cleanName(patch.name) : p.name,
        patch.description !== undefined ? cleanDescription(patch.description) : p.description,
        new Date().toISOString(),
        id,
      );
    return this.get(id);
  }

  remove(id: number) {
    this.row(id);
    this.db.prepare('DELETE FROM playlists WHERE id = ?').run(id);
  }

  /** Append songs (duplicates allowed, like most players). Unknown ids are rejected. */
  async addItems(id: number, recordingIds: string[]): Promise<PlaylistDetail> {
    this.row(id);
    const tracks: Track[] = [];
    for (const rid of recordingIds) {
      const track = await this.library.trackByRecording(rid);
      if (!track) throw new PlaylistError(`Song ${rid} is not in the library`, 404);
      tracks.push(track);
    }
    const { next } = this.db
      .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM playlist_items WHERE playlist_id = ?')
      .get(id) as { next: number };
    const now = new Date().toISOString();
    const insert = this.db.prepare(
      `INSERT INTO playlist_items (playlist_id, position, recording_id, title, artist_name, album_title, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.transaction(() => {
      tracks.forEach((t, i) => insert.run(id, next + i, t.recordingId, t.title, t.artistName, t.albumTitle, now));
      this.touch(id);
    });
    return this.get(id);
  }

  async removeItem(id: number, itemId: number): Promise<PlaylistDetail> {
    this.row(id);
    const { changes } = this.db
      .prepare('DELETE FROM playlist_items WHERE id = ? AND playlist_id = ?')
      .run(itemId, id);
    if (!changes) throw new PlaylistError('Song not found in this playlist', 404);
    this.touch(id);
    return this.get(id);
  }

  /** Set the full order; `itemIds` must be exactly the playlist's items. */
  async reorder(id: number, itemIds: number[]): Promise<PlaylistDetail> {
    this.row(id);
    const current = (
      this.db.prepare('SELECT id FROM playlist_items WHERE playlist_id = ?').all(id) as { id: number }[]
    ).map((r) => r.id);
    const same = current.length === itemIds.length && new Set(itemIds).size === itemIds.length && itemIds.every((i) => current.includes(i));
    if (!same) throw new PlaylistError('Order must list every item in the playlist exactly once');
    const update = this.db.prepare('UPDATE playlist_items SET position = ? WHERE id = ?');
    this.transaction(() => {
      itemIds.forEach((itemId, position) => update.run(position, itemId));
      this.touch(id);
    });
    return this.get(id);
  }

  private row(id: number): PlaylistRow {
    const row = this.db
      .prepare('SELECT id, name, description, updated_at, cover_snapshot FROM playlists WHERE id = ?')
      .get(id) as unknown as PlaylistRow | undefined;
    if (!row) throw new PlaylistError('Playlist not found', 404);
    return row;
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

  private resolve(rows: ItemRow[]): Promise<PlaylistItem[]> {
    return Promise.all(
      rows.map(async (r) => ({
        itemId: r.id,
        recordingId: r.recording_id,
        title: r.title,
        artistName: r.artist_name,
        albumTitle: r.album_title,
        addedAt: r.added_at,
        track: await this.library.trackByRecording(r.recording_id),
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
