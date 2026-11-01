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
// plan the skip from where A is now into B, and render it. See liveMix.ts for the rest.

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
  /** The earliest A may be left (seconds into A): where it is now, plus the time to prepare and start the mix. */
  at: number;
  aAudio: SongAudio;
  bAudio: SongAudio;
}

export type LiveMixReply =
  | { status: 'ready'; plan: TransitionPlan; left: Float32Array<ArrayBuffer>; right: Float32Array<ArrayBuffer> }
  | { status: 'not possible'; reason: string };

/** Slack for comparing song times, as the renderer allows: under a sample. */
const EPSILON = 0.5 / RENDER_RATE;

/**
 * The planner's skip from A, no earlier than `at`, into B: a quick mix leaving A on a bar line within a few
 * beats, a short crossfade from `at` when a beat isn't sure enough to cut on, or straight on (the caller
 * then switches straight away).
 */
export function planLiveMix({ a, b, mode, sameAlbumInOrder, at }: Omit<LiveMixRequest, 'aAudio' | 'bAudio'>): TransitionPlan {
  return planTransition({ a, b, mode, sameAlbumInOrder, skip: { at } });
}

/** Whether a song's audio holds `[from, to]`. */
const covers = (audio: SongAudio, [from, to]: [number, number]) =>
  audio.start <= from + EPSILON && (audio.toEnd || audio.start + audio.left.length / RENDER_RATE >= to - EPSILON);

/** The answer to one request, and the buffers to hand over with it (moved, not copied). */
export function answerLiveMix(request: LiveMixRequest): { reply: LiveMixReply; transfer: ArrayBuffer[] } {
  const notPossible = (reason: string) => ({ reply: { status: 'not possible' as const, reason }, transfer: [] });
  try {
    const plan = planLiveMix(request);
    if (plan.style !== 'quick' && plan.style !== 'fade') return notPossible(plan.reason);
    const ranges = excerptRanges(plan);
    if (!ranges) return notPossible(plan.reason);
    if (!covers(request.aAudio, ranges.a)) return notPossible('A’s audio doesn’t cover the mix');
    if (!covers(request.bAudio, ranges.b)) return notPossible('B’s audio doesn’t cover the mix');
    // The renderer makes new (so plain, transferable) arrays.
    const rendered = renderTransition(plan, request.aAudio, request.bAudio);
    const { left, right } = rendered as { left: Float32Array<ArrayBuffer>; right: Float32Array<ArrayBuffer> };
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
