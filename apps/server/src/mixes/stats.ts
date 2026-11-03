import type { Album, Artist, ListeningStats, StatsRange, Track } from '@playarr/shared';
import type { DatabaseSync } from 'node:sqlite';
import { stripAlbum, type Library } from '../library/library.ts';

const DAY = 86_400_000;
const TOP = 10;

/** The period a range covers: [from, to). */
export function rangeBounds(range: StatsRange, now = Date.now()): { from?: string; to: string } {
  const iso = (ms: number) => new Date(ms).toISOString();
  if (/^\d{4}$/.test(range)) return { from: `${range}-01-01T00:00:00.000Z`, to: `${Number(range) + 1}-01-01T00:00:00.000Z` };
  const days = { month: 28, halfyear: 182, year: 365 }[range as 'month' | 'halfyear' | 'year'];
  return { ...(days ? { from: iso(now - days * DAY) } : {}), to: iso(now + 1) };
}

export const isStatsRange = (v: string): v is StatsRange => ['month', 'halfyear', 'year', 'all'].includes(v) || /^(19|20)\d{2}$/.test(v);

/** Most days in a row among these dates ("2026-11-01"). */
export function longestStreak(days: string[]): number {
  let best = 0;
  let run = 0;
  let prev = NaN;
  for (const d of [...new Set(days)].sort()) {
    const t = Date.parse(`${d}T00:00:00Z`);
    run = t - prev === DAY ? run + 1 : 1;
    best = Math.max(best, run);
    prev = t;
  }
  return best;
}

/** Listening stats from the history (skipped songs don't count). */
export async function listeningStats(
  db: DatabaseSync,
  library: Pick<Library, 'artists' | 'album' | 'tracksByRecordings'>,
  range: StatsRange,
  now = Date.now(),
  account = 1,
): Promise<ListeningStats> {
  const { from, to } = rangeBounds(range, now);
  const where = 'skipped = 0 AND played_at >= ? AND played_at < ? AND account_id = ?';
  const args = [from ?? '', to, account];
  const all = <T>(sql: string, ...extra: (string | number)[]) => db.prepare(sql).all(...args, ...extra) as T[];
  const minutes = (seconds: number | null) => Math.round((seconds ?? 0) / 60);

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS plays, SUM(seconds) AS seconds, COUNT(DISTINCT recording_id) AS songs, COUNT(DISTINCT artist_id) AS artists
       FROM plays WHERE ${where}`,
    )
    .get(...args) as { plays: number; seconds: number | null; songs: number; artists: number };
  const days = all<{ day: string }>(`SELECT DISTINCT substr(played_at, 1, 10) AS day FROM plays WHERE ${where}`).map((r) => r.day);
  const newArtists = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM (SELECT MIN(played_at) AS first FROM plays WHERE skipped = 0 AND account_id = ? AND artist_id IS NOT NULL GROUP BY artist_id)
         WHERE first >= ? AND first < ?`,
      )
      .get(account, from ?? '', to) as { n: number }
  ).n;

  const artistRows = all<{ id: number; plays: number; seconds: number }>(
    `SELECT artist_id AS id, COUNT(*) AS plays, SUM(seconds) AS seconds FROM plays WHERE ${where} AND artist_id IS NOT NULL
     GROUP BY artist_id ORDER BY seconds DESC, plays DESC, artist_id LIMIT ?`,
    TOP * 2,
  );
  const artistsById = new Map((await library.artists()).map((a) => [a.id, a]));
  const topArtists = artistRows
    .flatMap((r) => {
      const artist = artistsById.get(r.id);
      return artist ? [{ artist: artist as Artist, plays: r.plays, minutes: minutes(r.seconds) }] : [];
    })
    .slice(0, TOP);

  const albumRows = all<{ id: number; plays: number; seconds: number }>(
    `SELECT album_id AS id, COUNT(*) AS plays, SUM(seconds) AS seconds FROM plays WHERE ${where} AND album_id IS NOT NULL
     GROUP BY album_id ORDER BY seconds DESC, plays DESC, album_id`,
  );
  const topAlbums: ListeningStats['topAlbums'] = [];
  const genres = new Map<string, number>();
  for (const r of albumRows) {
    const album = await library.album(r.id);
    if (!album) continue;
    if (topAlbums.length < TOP) topAlbums.push({ album: stripAlbum(album) as Album, plays: r.plays, minutes: minutes(r.seconds) });
    for (const g of album.genres ?? []) genres.set(g, (genres.get(g) ?? 0) + r.seconds);
  }
  const topGenres = [...genres]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([genre, seconds]) => ({ genre, minutes: minutes(seconds) }));

  const trackRows = all<{ id: string; plays: number }>(
    `SELECT recording_id AS id, COUNT(*) AS plays, SUM(seconds) AS seconds FROM plays WHERE ${where}
     GROUP BY recording_id ORDER BY plays DESC, seconds DESC LIMIT ?`,
    TOP * 2,
  );
  const tracks = new Map((await library.tracksByRecordings(trackRows.map((r) => r.id))).map((t) => [t.recordingId, t]));
  const topTracks = trackRows.flatMap((r) => (tracks.has(r.id) ? [{ track: tracks.get(r.id)! as Track, plays: r.plays }] : [])).slice(0, TOP);

  const spread = (column: string, size: number, offset = 0) => {
    const out = Array<number>(size).fill(0);
    for (const r of all<{ k: number; seconds: number }>(`SELECT ${column} AS k, SUM(seconds) AS seconds FROM plays WHERE ${where} GROUP BY k`)) {
      const i = Number(r.k) - offset;
      if (i >= 0 && i < size) out[i] = minutes(r.seconds);
    }
    return out;
  };

  const first = db.prepare(`SELECT recording_id, played_at FROM plays WHERE ${where} ORDER BY played_at LIMIT 1`).get(...args) as
    | { recording_id: string; played_at: string }
    | undefined;
  const firstTrack = first && (await library.tracksByRecordings([first.recording_id]))[0];
  const years = (
    db.prepare(`SELECT DISTINCT substr(played_at, 1, 4) AS y FROM plays WHERE skipped = 0 AND account_id = ? ORDER BY y DESC`).all(account) as { y: string }[]
  ).map((r) => Number(r.y));

  return {
    range,
    ...(from ? { from } : {}),
    to,
    minutes: minutes(totals.seconds),
    plays: totals.plays,
    songs: totals.songs,
    artists: totals.artists,
    days: days.length,
    newArtists,
    longestStreak: longestStreak(days),
    topArtists,
    topAlbums,
    topTracks,
    topGenres,
    hours: spread('hour', 24),
    weekdays: spread('weekday', 7),
    ...(/^\d{4}$/.test(range) ? { months: spread('CAST(substr(played_at, 6, 2) AS INTEGER)', 12, 1) } : {}),
    ...(firstTrack ? { firstSong: { track: firstTrack, at: first!.played_at } } : {}),
    years,
  };
}
