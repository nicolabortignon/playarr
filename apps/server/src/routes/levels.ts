import type { TrackLevel } from '@playarr/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Analyzer } from '../analysis/analyzer.ts';
import type { SongLoudness } from '../analysis/loudnessJobs.ts';
import type { Library } from '../library/library.ts';
import { libraryOf, visibleRecordings } from '../accounts/rights.ts';

/** Songs are levelled to this loudness (EBU R128 integrated), as Spotify, YouTube and Tidal level them. */
export const TARGET_LUFS = -14;
/** Turned up, a song's peak stays below this (dBFS): headroom for the peaks between samples. */
const PEAK_CEILING_DB = -1;
/** Never more than this either way: past it, it's not the song's level that's off. */
const MAX_CUT_DB = -20;
const MAX_BOOST_DB = 12;

const input = z.object({ ids: z.array(z.string().min(1).max(100)).min(1).max(50) });

/**
 * The gain (dB) that brings a song of this loudness to the target: loud songs come down; quiet ones go
 * up as far as their peak leaves room (none when it's already near full scale).
 */
export function gainFor(lufs: number, peak: number | null): number {
  const toTarget = TARGET_LUFS - lufs;
  const gain =
    toTarget <= 0 ? Math.max(MAX_CUT_DB, toTarget) : Math.min(toTarget, MAX_BOOST_DB, Math.max(0, PEAK_CEILING_DB - (peak ?? PEAK_CEILING_DB)));
  return Math.round(gain * 10) / 10;
}

/**
 * The loudness of songs heard one after another: the average of their power, each as long as it lasts
 * (a long song weighs more), not of their decibels.
 */
export function combinedLufs(songs: { lufs: number; samples: number }[]): number {
  const total = songs.reduce((sum, s) => sum + s.samples, 0);
  return 10 * Math.log10(songs.reduce((sum, s) => sum + s.samples * 10 ** (s.lufs / 10), 0) / total);
}

type Measured = SongLoudness & { lufs: number };

/**
 * Even volume: the gain for each song from its measured loudness, alone and within its album (so an
 * album played in order keeps its quiet and loud songs as mastered). Songs not measured yet are
 * measured at once, the rest of their album after, so they're levelled from the next time they're asked
 * about (the player asks again shortly).
 */
export function levelRoutes(
  app: FastifyInstance,
  deps: { analyzer: Pick<Analyzer, 'loudness' | 'ensure' | 'remeasureLoudness'>; library: Pick<Library, 'trackByRecording' | 'album'> & Partial<Pick<Library, 'view'>> },
) {
  app.post('/api/levels', async (req, reply) => {
    const parsed = input.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
    const out: Record<string, TrackLevel> = {};
    // Songs outside the account's sources aren't there for it: neither levelled nor measured.
    const asked = await visibleRecordings(deps.library, req, [...new Set(parsed.data.ids)]);
    const albums = libraryOf(deps.library, req);
    const albumMates = new Set<string>();
    for (const id of asked) {
      // The whole library's copy: the one loudness analysis measures (see the remeasure check below).
      const track = await deps.library.trackByRecording(id);
      if (!track) continue;
      const album = await albums.album(track.albumId);
      const albumIds = album?.tracks.map((t) => t.recordingId) ?? [id];
      for (const r of albumIds) albumMates.add(r);
      const measured = deps.analyzer.loudness([...new Set([id, ...albumIds])]);
      const own = measured.get(id);
      // Measured from another file than the one playing now (a better copy came): measured again.
      if (own && own.fileId !== track.fileId) {
        deps.analyzer.remeasureLoudness(id);
        continue;
      }
      if (!own || own.lufs === null) continue;
      const songs = albumIds.flatMap((r) => {
        const m = measured.get(r);
        return m && m.lufs !== null ? [m as Measured] : [];
      });
      const albumPeak = Math.max(...songs.map((s) => s.peak ?? PEAK_CEILING_DB));
      out[id] = {
        track: gainFor(own.lufs, own.peak),
        ...(songs.length > 1 ? { album: gainFor(combinedLufs(songs), albumPeak) } : {}),
        lufs: own.lufs,
        ...(own.peak !== null && Number.isFinite(own.peak) ? { peak: own.peak } : {}),
      };
    }
    // Asked for by the player for the songs about to play: ahead of everything; their albums after.
    deps.analyzer.ensure(asked, { beats: false, sound: false, tags: false, urgent: true });
    deps.analyzer.ensure([...albumMates], { beats: false, sound: false, tags: false });
    return out;
  });
}
