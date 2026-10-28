import type { FavoriteTrack, Track } from '@playarr/shared';
import type { DatabaseSync } from 'node:sqlite';
import type { Library } from './library/library.ts';

interface FavoriteRow {
  recording_id: string;
  created_at: string;
}

/** Favorite songs, keyed by recording id so they survive re-imports and quality upgrades. */
export class Favorites {
  constructor(
    private readonly db: DatabaseSync,
    private readonly library: Library,
  ) {}

  /** Favorites that are currently playable, newest first. */
  async list(): Promise<FavoriteTrack[]> {
    const rows = this.db
      .prepare('SELECT recording_id, created_at FROM favorites ORDER BY created_at DESC')
      .all() as unknown as FavoriteRow[];
    const tracks = await Promise.all(
      rows.map(async (r) => {
        const track = await this.library.trackByRecording(r.recording_id);
        return track ? { ...track, favoritedAt: r.created_at } : undefined;
      }),
    );
    return tracks.filter((t): t is FavoriteTrack => !!t);
  }

  add(track: Track) {
    this.db
      .prepare(
        `INSERT INTO favorites (recording_id, track_id, title, artist_name, album_title, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (recording_id) DO NOTHING`,
      )
      .run(track.recordingId, track.id, track.title, track.artistName, track.albumTitle, new Date().toISOString());
  }

  remove(recordingId: string) {
    this.db.prepare('DELETE FROM favorites WHERE recording_id = ?').run(recordingId);
  }
}
