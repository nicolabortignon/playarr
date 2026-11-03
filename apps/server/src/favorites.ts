import type { FavoriteTrack, Track } from '@playarr/shared';
import type { DatabaseSync } from 'node:sqlite';
import type { LibraryView } from './library/library.ts';

interface FavoriteRow {
  recording_id: string;
  created_at: string;
}

/** Each account's favorite songs, keyed by recording id so they survive re-imports and quality upgrades. */
export class Favorites {
  constructor(private readonly db: DatabaseSync) {}

  /** The account's favorites it can play now (in its library), newest first. */
  async list(account: number, library: Pick<LibraryView, 'trackByRecording'>): Promise<FavoriteTrack[]> {
    const rows = this.db
      .prepare('SELECT recording_id, created_at FROM favorites WHERE account_id = ? ORDER BY created_at DESC')
      .all(account) as unknown as FavoriteRow[];
    const tracks = await Promise.all(
      rows.map(async (r) => {
        const track = await library.trackByRecording(r.recording_id);
        return track ? { ...track, favoritedAt: r.created_at } : undefined;
      }),
    );
    return tracks.filter((t): t is FavoriteTrack => !!t);
  }

  /** Every song the account has favorited, playable or not (what the mixes learn from). */
  recordingIds(account: number): string[] {
    return (this.db.prepare('SELECT recording_id FROM favorites WHERE account_id = ?').all(account) as { recording_id: string }[]).map((r) => r.recording_id);
  }

  add(account: number, track: Track) {
    this.db
      .prepare(
        `INSERT INTO favorites (account_id, recording_id, track_id, title, artist_name, album_title, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id, recording_id) DO NOTHING`,
      )
      .run(account, track.recordingId, track.id, track.title, track.artistName, track.albumTitle, new Date().toISOString());
  }

  remove(account: number, recordingId: string) {
    this.db.prepare('DELETE FROM favorites WHERE account_id = ? AND recording_id = ?').run(account, recordingId);
  }
}
