import {
  excerptRanges,
  planTransition,
  renderTransition,
  RENDER_RATE,
  type CuePoints,
  type Excerpt,
  type MixMap,
  type MixMode,
  type TransitionPlan,
} from '@playarr/mix';

// The desktop live mixer's heavy lifting, off the main thread so playback and the page stay smooth:
// plan a quick mix from where A is now into B, and render it. See liveMix.ts for the rest.

type Song = MixMap & { cues?: CuePoints };

/** A song's decoded audio at RENDER_RATE, stereo, around the mix. */
export interface SongAudio extends Excerpt {
  /** It runs to the song's end: past it there's nothing more to have, so it covers any later time. */
  toEnd: boolean;
}

export interface LiveMixRequest {
  a: Song;
  b: Song;
  mode: MixMode;
  sameAlbumInOrder: boolean;
  /** Where A may be left, no earlier: the next downbeat of A that leaves time to start the mix. */
  leaveAt: number;
  aAudio: SongAudio;
  bAudio: SongAudio;
}

export type LiveMixReply =
  | { status: 'ready'; plan: TransitionPlan; left: Float32Array<ArrayBuffer>; right: Float32Array<ArrayBuffer> }
  | { status: 'not possible'; reason: string };

/**
 * Keys that clash, standing in for the songs' own when the planner wants a long blend. A skip has no time
 * for one (and the planner has no option to ask for a quick mix), so the pair is planned again as if the
 * keys clashed: that rule only chooses between a long blend and a quick mix, and nothing else in a
 * quick mix depends on the keys.
 */
const CLASHING_KEYS = { a: { camelot: '1A', confidence: 1 }, b: { camelot: '7B', confidence: 1 } } as const;

/** Slack for comparing song times, as the renderer allows: under a sample. */
const EPSILON = 0.5 / RENDER_RATE;

/**
 * The quick mix from A, left at `leaveAt` (as if its mix-out point were set there, so mid-song is fine),
 * into B. Whatever else the planner decides (a crossfade, straight on) stands: the caller then doesn't
 * mix. No position goes to the planner: its 5 s lead is for the server's render and download, and the
 * leave point is never in the past anyway.
 */
export function planLiveMix({ a, b, mode, sameAlbumInOrder, leaveAt }: Omit<LiveMixRequest, 'aAudio' | 'bAudio'>): TransitionPlan {
  const leaving = { ...a, cues: { ...a.cues, mixOut: leaveAt } };
  const plan = planTransition({ a: leaving, b, mode, sameAlbumInOrder });
  if (plan.style !== 'long') return plan;
  const quick = planTransition({ a: { ...leaving, key: CLASHING_KEYS.a }, b: { ...b, key: CLASHING_KEYS.b }, mode, sameAlbumInOrder });
  return { ...quick, reason: 'Skipped: quick mix' };
}

/** Whether a song's audio holds `[from, to]`. */
const covers = (audio: SongAudio, [from, to]: [number, number]) =>
  audio.start <= from + EPSILON && (audio.toEnd || audio.start + audio.left.length / RENDER_RATE >= to - EPSILON);

/** The answer to one request, and the buffers to hand over with it (moved, not copied). */
export function answerLiveMix(request: LiveMixRequest): { reply: LiveMixReply; transfer: ArrayBuffer[] } {
  const notPossible = (reason: string) => ({ reply: { status: 'not possible' as const, reason }, transfer: [] });
  try {
    const plan = planLiveMix(request);
    if (plan.style !== 'quick') return notPossible(plan.reason);
    const ranges = excerptRanges(plan);
    if (!ranges) return notPossible(plan.reason);
    if (!covers(request.aAudio, ranges.a)) return notPossible('A’s audio doesn’t cover the mix');
    if (!covers(request.bAudio, ranges.b)) return notPossible('B’s audio doesn’t cover the mix');
    // The renderer makes new (so plain, transferable) arrays.
    const { left, right } = renderTransition(plan, request.aAudio, request.bAudio) as { left: Float32Array<ArrayBuffer>; right: Float32Array<ArrayBuffer> };
    return { reply: { status: 'ready', plan, left, right }, transfer: [left.buffer, right.buffer] };
  } catch (err) {
    return notPossible(err instanceof Error ? err.message : String(err));
  }
}

// Only when running as a worker (tests import the functions above without one).
if (typeof self !== 'undefined' && 'WorkerGlobalScope' in self) {
  self.onmessage = (event: MessageEvent<LiveMixRequest>) => {
    const { reply, transfer } = answerLiveMix(event.data);
    self.postMessage(reply, { transfer });
  };
}
