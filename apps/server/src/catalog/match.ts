import { normalize } from '../library/search.ts';
import type { MbReleaseInfo, MbTrack } from './mbRelease.ts';

/** What matching knows about a file: from its tags, else its name. */
export interface FileFacts {
  rel: string;
  title: string;
  trackNumber: number;
  discNumber: number;
  duration: number;
}

export interface Alignment {
  rel: string;
  track: MbTrack;
  score: number;
}

export interface ReleaseScore {
  release: MbReleaseInfo;
  score: number;
  alignment: Alignment[];
}

export const AUTO_SCORE = 0.85;
export const REVIEW_SCORE = 0.5;
export const MIN_FILE_SCORE = 0.6;

const VERSION_NOTE = /\s*[([][^)\]]*(remaster|album version|explicit|bonus track|mono|stereo)[^)\]]*[)\]]/gi;

/** 0..1, ignoring case, accents, punctuation and notes like "(2019 Remaster)". */
export function titleSimilarity(a: string, b: string): number {
  const x = normalize(a.replace(VERSION_NOTE, ''));
  const y = normalize(b.replace(VERSION_NOTE, ''));
  if (!x || !y) return 0;
  if (x === y) return 1;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

export function fileTrackScore(f: FileFacts, t: MbTrack): number {
  const title = titleSimilarity(f.title, t.title);
  const diff = f.duration > 0 && t.length > 0 ? Math.abs(f.duration - t.length) : undefined;
  const duration = diff === undefined ? 0.5 : diff <= 3 ? 1 : diff >= 15 ? 0 : 1 - (diff - 3) / 12;
  const position = f.trackNumber > 0 && f.trackNumber === t.position && f.discNumber === t.disc ? 1 : 0;
  return 0.6 * title + 0.3 * duration + 0.1 * position;
}

/** Pair each file with at most one track (best pairs first) and score the release. */
export function scoreRelease(files: FileFacts[], release: MbReleaseInfo): ReleaseScore {
  const pairs = files
    .flatMap((f) => release.tracks.map((t) => ({ f, t, s: fileTrackScore(f, t) })))
    .sort((a, b) => b.s - a.s);
  const usedFiles = new Set<string>();
  const usedTracks = new Set<MbTrack>();
  const alignment: Alignment[] = [];
  for (const p of pairs) {
    if (usedFiles.has(p.f.rel) || usedTracks.has(p.t)) continue;
    usedFiles.add(p.f.rel);
    usedTracks.add(p.t);
    alignment.push({ rel: p.f.rel, track: p.t, score: p.s });
  }
  const mean = alignment.reduce((sum, a) => sum + a.score, 0) / Math.max(files.length, 1);
  // More files than tracks: some of them can't be on this release.
  const fit = files.length > release.tracks.length ? release.tracks.length / files.length : 1;
  return { release, score: mean * fit, alignment };
}

export function verdict(best: ReleaseScore | undefined): 'auto' | 'review' | 'unmatched' {
  if (!best) return 'unmatched';
  if (best.score >= AUTO_SCORE && best.alignment.every((a) => a.score >= MIN_FILE_SCORE)) return 'auto';
  return best.score >= REVIEW_SCORE ? 'review' : 'unmatched';
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length]!;
}
