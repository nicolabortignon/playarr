import type { Lyrics, Track } from '@playarr/shared';
import type { DatabaseSync } from 'node:sqlite';
import { extname } from 'node:path';
import { selectIn } from '../analysis/sql.ts';
import type { FileResolver } from '../catalog/files.ts';
import { lyricsFrom } from '../catalog/tags.ts';
import type { Library } from '../library/library.ts';
import type { LyricsFact } from '../mixes/mood.ts';

const LRCLIB = 'https://lrclib.net/api';
const USER_AGENT = 'Playarr (self-hosted music player)';
/** Songs without lyrics are looked up again after this long (LRCLIB grows every day). */
const RETRY_MISSING_MS = 14 * 86_400_000;
const MAX_LRC_BYTES = 256 * 1024;

/** "[01:02.50]Words" lines → timed lines; null if there are none (then it's plain text). */
export function parseLrc(lrc: string): { at: number; text: string }[] | null {
  const offset = Number(/^\[offset:\s*([+-]?\d+)\]/im.exec(lrc)?.[1] ?? 0) / 1000;
  const lines: { at: number; text: string }[] = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g)];
    if (!stamps.length) continue;
    const text = raw.slice(stamps.at(-1)!.index! + stamps.at(-1)![0].length).trim();
    for (const m of stamps) {
      const at = Number(m[1]) * 60 + Number(m[2]!.replace(':', '.')) - offset;
      lines.push({ at: Math.max(0, Math.round(at * 100) / 100), text });
    }
  }
  return lines.length ? lines.sort((a, b) => a.at - b.at) : null;
}

/** Text that may be LRC, as Lyrics. */
function fromText(text: string, source: Lyrics['source']): Lyrics {
  const synced = parseLrc(text);
  return synced ? { synced, source } : { plain: text.trim(), source };
}

interface LrclibRecord {
  syncedLyrics?: string | null;
  plainLyrics?: string | null;
  instrumental?: boolean;
  duration?: number;
}

/** Lyrics that only say the song has none: "[Instrumental]", as embedded lyrics often do. */
const NO_WORDS = /^\W*instrumental\W*$/i;

/**
 * What lyrics lookups found for songs that have been looked up: their words, or that they're instrumental (LRCLIB's
 * flag, or lyrics that only say so).
 */
export function lyricsFacts(db: DatabaseSync, ids: string[]): Map<string, LyricsFact> {
  const rows = selectIn<{ recording_id: string; instrumental: number | null; words: number; plain: string | null }>(
    db,
    `SELECT recording_id, json_extract(data, '$.instrumental') AS instrumental,
       (json_type(data, '$.synced') IS NOT NULL OR json_type(data, '$.plain') IS NOT NULL) AS words,
       CASE WHEN length(json_extract(data, '$.plain')) <= 40 THEN json_extract(data, '$.plain') END AS plain
     FROM lyrics WHERE data IS NOT NULL AND recording_id IN`,
    ids,
  );
  return new Map(
    rows.flatMap((r): [string, LyricsFact][] => {
      if (r.instrumental === 1 || (r.plain !== null && NO_WORDS.test(r.plain))) return [[r.recording_id, 'instrumental']];
      return r.words ? [[r.recording_id, 'words']] : [];
    }),
  );
}

/**
 * Lyrics for a song: from its file first (an .lrc file beside it, or its tags), else LRCLIB, a free
 * open database of synced lyrics. Remembered, found or not.
 */
export class LyricsService {
  private inflight = new Map<string, Promise<Lyrics | null>>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly library: Pick<Library, 'track' | 'file'>,
    private readonly files: Pick<FileResolver, 'resolve'>,
    private readonly opts: { log: { warn: (obj: object, msg: string) => void }; fetch?: typeof fetch },
  ) {}

  async forTrack(trackId: number): Promise<Lyrics | null | undefined> {
    const track = await this.library.track(trackId);
    if (!track) return undefined;
    const row = this.db.prepare('SELECT data, fetched_at FROM lyrics WHERE recording_id = ?').get(track.recordingId) as
      | { data: string | null; fetched_at: string }
      | undefined;
    if (row?.data) return JSON.parse(row.data) as Lyrics;
    if (row && Date.now() - Date.parse(row.fetched_at) < RETRY_MISSING_MS) return null;
    let job = this.inflight.get(track.recordingId);
    if (!job) {
      job = this.find(track)
        .then((found) => {
          this.db
            .prepare(
              `INSERT INTO lyrics (recording_id, data, fetched_at) VALUES (?, ?, ?)
               ON CONFLICT (recording_id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`,
            )
            .run(track.recordingId, found ? JSON.stringify(found) : null, new Date().toISOString());
          return found;
        })
        .finally(() => this.inflight.delete(track.recordingId));
      this.inflight.set(track.recordingId, job);
    }
    return job;
  }

  private async find(track: Track): Promise<Lyrics | null> {
    return (await this.fromFile(track)) ?? (await this.fromLrclib(track));
  }

  private async fromFile(track: Track): Promise<Lyrics | null> {
    try {
      const file = await this.library.file(track.fileId);
      if (!file) return null;
      const { media, path } = this.files.resolve(file);
      const lrc = path.slice(0, path.length - extname(path).length) + '.lrc';
      const sidecar = await media.stat(lrc).catch(() => null);
      if (sidecar && sidecar.size > 0 && sidecar.size <= MAX_LRC_BYTES) {
        const chunks: Buffer[] = [];
        for await (const chunk of await media.open(lrc)) chunks.push(chunk as Buffer);
        const text = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '');
        if (text.trim()) return fromText(text, 'file');
      }
      const { size } = await media.stat(path);
      const tagged = await lyricsFrom(media, path, size);
      if (tagged?.synced) return { synced: tagged.synced.map((l) => ({ at: l.ms / 1000, text: l.text.trim() })), source: 'file' };
      if (tagged?.text) return fromText(tagged.text, 'file');
    } catch (err) {
      this.opts.log.warn({ err, trackId: track.id }, 'reading lyrics from the file failed');
    }
    return null;
  }

  private async fromLrclib(track: Track): Promise<Lyrics | null> {
    const fetchFn = this.opts.fetch ?? fetch;
    const get = async (url: string) => {
      const res = await fetchFn(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(10_000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`LRCLIB HTTP ${res.status}`);
      return res.json() as Promise<unknown>;
    };
    const q = new URLSearchParams({ artist_name: track.artistName, track_name: track.title, album_name: track.albumTitle, duration: String(Math.round(track.duration)) });
    let hit = (await get(`${LRCLIB}/get?${q}`)) as LrclibRecord | null;
    if (!hit) {
      // Not this exact album or length: the closest in length among songs of this name by this artist.
      const found = ((await get(`${LRCLIB}/search?${new URLSearchParams({ artist_name: track.artistName, track_name: track.title })}`)) ?? []) as LrclibRecord[];
      hit = found
        .filter((r) => r.duration !== undefined && Math.abs(r.duration - track.duration) <= 3 && (r.syncedLyrics || r.plainLyrics || r.instrumental))
        .sort((a, b) => Number(!!b.syncedLyrics) - Number(!!a.syncedLyrics) || Math.abs(a.duration! - track.duration) - Math.abs(b.duration! - track.duration))[0] ?? null;
    }
    if (!hit) return null;
    if (hit.instrumental) return { instrumental: true, source: 'lrclib' };
    const synced = hit.syncedLyrics ? parseLrc(hit.syncedLyrics) : null;
    if (synced) return { synced, source: 'lrclib' };
    return hit.plainLyrics?.trim() ? { plain: hit.plainLyrics.trim(), source: 'lrclib' } : null;
  }
}
