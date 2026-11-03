import type { PlayReport } from '@playarr/shared';
import type { DatabaseSync } from 'node:sqlite';
import type { Library } from '../library/library.ts';

/** A song heard (or skipped), as stored. */
export interface Play {
  recordingId: string;
  trackId?: number;
  artistId?: number;
  albumId?: number;
  playedAt: string;
  hour: number;
  weekday: number;
  seconds: number;
  skipped: boolean;
}

interface PlayRow {
  recording_id: string;
  track_id: number | null;
  artist_id: number | null;
  album_id: number | null;
  played_at: string;
  hour: number;
  weekday: number;
  seconds: number;
  skipped: number;
}

/** The listening history: what was played where and when, which the generated mixes learn from. */
export class History {
  constructor(
    private readonly db: DatabaseSync,
    private readonly library: Pick<Library, 'track' | 'trackByRecording'>,
  ) {}

  /**
   * Store reports from a device. Songs no longer in the library are kept by recording alone. A report
   * already stored (sent again after a lost answer) is ignored. Returns how many were new.
   */
  async record(reports: PlayReport[], profile = 1): Promise<number> {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO plays (recording_id, track_id, artist_id, album_id, played_at, hour, weekday, seconds, skipped, account_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const rows = await Promise.all(
      reports.map(async (r) => {
        const track = (await this.library.track(r.trackId)) ?? (await this.library.trackByRecording(r.recordingId));
        return { r, track };
      }),
    );
    let added = 0;
    this.db.exec('BEGIN');
    try {
      for (const { r, track } of rows) {
        added += insert.run(
          track?.recordingId ?? r.recordingId,
          track?.id ?? null,
          track?.artistId ?? null,
          track?.albumId ?? null,
          new Date(r.at).toISOString(),
          r.hour,
          r.weekday,
          Math.round(r.seconds),
          r.skipped ? 1 : 0,
          r.profile ?? profile,
        ).changes as number;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return added;
  }

  /** Every play since `days` ago, oldest first. */
  since(days: number, now = Date.now(), profile = 1): Play[] {
    const from = new Date(now - days * 86_400_000).toISOString();
    const rows = this.db.prepare('SELECT * FROM plays WHERE played_at >= ? AND account_id = ? ORDER BY played_at').all(from, profile) as unknown as PlayRow[];
    return rows.map(toPlay);
  }

  /** Albums heard lately, most recent first (by catalog album id). */
  recentAlbums(limit: number, profile = 1): number[] {
    const rows = this.db
      .prepare(
        `SELECT album_id FROM plays WHERE album_id IS NOT NULL AND skipped = 0 AND account_id = ?
         GROUP BY album_id ORDER BY MAX(played_at) DESC LIMIT ?`,
      )
      .all(profile, limit) as { album_id: number }[];
    return rows.map((r) => r.album_id);
  }

  /** How much history there is. */
  stats(profile = 1): { plays: number; since?: string } {
    const row = this.db.prepare('SELECT COUNT(*) AS n, MIN(played_at) AS first FROM plays WHERE skipped = 0 AND account_id = ?').get(profile) as {
      n: number;
      first: string | null;
    };
    return { plays: row.n, ...(row.first ? { since: row.first } : {}) };
  }

  /** Forget what someone played. */
  clear(profile = 1) {
    this.db.prepare('DELETE FROM plays WHERE account_id = ?').run(profile);
  }
}

function toPlay(r: PlayRow): Play {
  return {
    recordingId: r.recording_id,
    ...(r.track_id !== null ? { trackId: r.track_id } : {}),
    ...(r.artist_id !== null ? { artistId: r.artist_id } : {}),
    ...(r.album_id !== null ? { albumId: r.album_id } : {}),
    playedAt: r.played_at,
    hour: r.hour,
    weekday: r.weekday,
    seconds: r.seconds,
    skipped: r.skipped === 1,
  };
}
