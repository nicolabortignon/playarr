import { EXCERPT_MARGIN, RENDER_RATE, type MixMap, type MixMode, type TransitionPlan } from '@playarr/mix';
import type { Track } from '@playarr/shared';
import { api } from '../lib/api';
import { AUDIO_CACHE } from '../lib/cacheNames';
import { canSetVolume, continues, isDesktop } from './decks';
import type { LiveMixReply, LiveMixRequest, SongAudio } from './liveMix.worker';
import { useOffline } from './offline';

// The desktop live mixer. When the listener skips and no transition from the server is ready, a desktop
// browser can mix one itself: fetch and decode both songs around the mix, plan and render a quick mix in a
// worker (liveMix.worker.ts), and play it through Web Audio, in time with A's own element. Anything slow or missing gives up (null): the caller then switches straight away, as before.

const MB = 1024 ** 2;

/** How long a skip waits for a live mix; past it, the song switches straight away. */
export const PREPARE_BUDGET_MS = 1500;
/** Room after preparing to set the mix going: scheduling it, and Web Audio starting up. */
const START_MARGIN_S = 0.5;
/** Closer than this to the mix's start, it can't be scheduled on time (a slow prepare, a seek meanwhile). */
const MIN_LEAD_S = 0.05;
/** Bigger files aren't fetched and decoded for a live mix (decoded audio takes about 10 MB a minute). */
export const MAX_FILE_BYTES = 60 * MB;
/** Longer songs aren't decoded either, whatever their size: an hour-long DJ set would take gigabytes. */
const MAX_SONG_SECONDS = 15 * 60;
/**
 * Beats of A the worker gets from the earliest the mix may start: a skip's quick mix lands under 6 beats
 * later (its lead-in included) and A rings on for a beat after. The worker checks the plan fits what it got.
 */
const A_WINDOW_BEATS = 12;
/** Beats of B from its mix-in point: a quick mix lands B within 8 of its beats of it, and stops a beat later. */
const B_WINDOW_BEATS = 32;
/** Seconds of each song otherwise (no beat, or a fast one): a skip with no sure beat is a 2.5 s crossfade. */
const FADE_WINDOW_S = 4;
/** Formats whose start decodes on its own. Others (an MP4's index can sit at its end) are fetched whole. */
const START_DECODES = new Set(['mp3', 'flac', 'ogg', 'oga', 'opus']);
/** Slack on the bytes estimated to hold B's start: bit rates vary through a song, and cover art sits at the front. */
const RANGE_SLACK = 1.2;
const RANGE_HEADROOM_BYTES = 2 * MB;
/** B's element starts this much before the mix ends, for the moment it takes to start (AudioEngine's LEAD_MS). */
const B_LEAD_S = 0.03;
/**
 * At each end, the mix and the element it joins play the same sound together this long, one fading in as
 * the other fades out with gains adding up to 1 (AudioEngine's OVERLAP_MS): the same sound in step, so the
 * level holds, and neither join clicks.
 */
const OVERLAP_S = 0.015;
/** How often A's element's volume steps down through the start's overlap. */
const OVERLAP_STEP_MS = 4;
/** B already this close to where the mix leaves it isn't moved again (a seek can land a hair off and cost a rebuffer). */
const SEEK_SLACK_S = 0.005;

/** A quick mix (or, without a sure beat, a short crossfade) from A into B, rendered and ready to play. */
export interface LiveMix {
  plan: TransitionPlan;
  /** The transition at RENDER_RATE: it continues A from plan.aStart and runs into B at plan.bResume. */
  buffer: AudioBuffer;
  from: Track;
  to: Track;
}

/** Desktop browsers: Web Audio, workers, a mouse or trackpad, and a volume that can be set. */
export function canLiveMix(): boolean {
  return (
    typeof AudioContext !== 'undefined' &&
    typeof OfflineAudioContext !== 'undefined' &&
    typeof Worker !== 'undefined' &&
    isDesktop() &&
    canSetVolume()
  );
}

type Clock = Pick<BaseAudioContext, 'currentTime'> & { getOutputTimestamp?: () => AudioTimestamp };

/**
 * The audio context's time of what's heard now. getOutputTimestamp says which context time the speakers
 * played at a given moment; currentTime (the fallback) runs ahead of what's heard by the output's latency.
 * A context that isn't running yet stamps zeros.
 */
export function outputTime(context: Clock, now = performance.now()): number {
  const stamp = context.getOutputTimestamp?.();
  if (stamp?.contextTime && stamp.performanceTime) return stamp.contextTime + (now - stamp.performanceTime) / 1000;
  return context.currentTime;
}

/** The audio context's time at which `element` will be heard at `elementTime` (its currentTime's clock), playing on. */
export function contextTimeFor(
  elementTime: number,
  element: Pick<HTMLMediaElement, 'currentTime' | 'playbackRate'>,
  context: Clock,
  now = performance.now(),
): number {
  return outputTime(context, now) + (elementTime - element.currentTime) / (element.playbackRate || 1);
}

/**
 * `work`'s answer if it comes within `ms`, else null; null too when `signal` aborts first or the work
 * fails. Either way the work's own signal aborts at the end, so whatever still runs (a download, the
 * worker) stops.
 */
export async function withDeadline<T>(work: (signal: AbortSignal) => Promise<T | null>, ms: number, signal?: AbortSignal): Promise<T | null> {
  if (signal?.aborted) return null;
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal?.addEventListener('abort', stop);
  const timer = setTimeout(stop, ms);
  const gaveUp = new Promise<null>((resolve) => controller.signal.addEventListener('abort', () => resolve(null)));
  try {
    const answer = Promise.resolve()
      .then(() => work(controller.signal))
      .catch(() => null);
    return await Promise.race([answer, gaveUp]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    controller.abort();
  }
}

/**
 * Prepares the skip from A, playing at `aPosition` now, into B: null if it can't be done within
 * PREPARE_BUDGET_MS (no mix map, a song too big, a slow connection, a pair that goes straight on, `signal`
 * aborted), and the caller switches straight away. A should play on meanwhile: the mix starts no earlier
 * than the budget and START_MARGIN_S from now (on a bar line of A within a few beats after, for a quick mix).
 */
export function prepareLiveMix({
  a,
  b,
  aPosition,
  mode,
  signal,
}: {
  a: Track;
  b: Track;
  aPosition: number;
  mode: MixMode;
  signal: AbortSignal;
}): Promise<LiveMix | null> {
  // An MP3's <audio> seeks by estimate (exact only with a seek table, which most files lack), so B's element
  // could resume off where the mix leaves B, and the landing off the beat: worse than a clean skip.
  if (mode === 'off' || a.fileId === b.fileId || isMp3(b)) return Promise.resolve(null);
  return withDeadline(
    async (deadline) => {
      const maps = await api.mixMaps([a.recordingId, b.recordingId]);
      const aMap = maps[a.recordingId];
      const bMap = maps[b.recordingId];
      if (!aMap || !bMap) return null;
      const at = aPosition + PREPARE_BUDGET_MS / 1000 + START_MARGIN_S;
      const aUntil = at + Math.max(FADE_WINDOW_S, beats(aMap, A_WINDOW_BEATS)) + EXCERPT_MARGIN;
      const bMixIn = Math.max(0, finiteOr(bMap.cues?.mixIn ?? bMap.introEnd, 0));
      const bUntil = Math.max(FADE_WINDOW_S, bMixIn + beats(bMap, B_WINDOW_BEATS)) + EXCERPT_MARGIN;
      const [aAudio, bAudio] = await Promise.all([
        songAudio(a, at - EXCERPT_MARGIN, aUntil, deadline),
        songAudio(b, 0, bUntil, deadline),
      ]);
      if (!aAudio || !bAudio) return null;
      const reply = await runWorker({ a: aMap, b: bMap, mode, sameAlbumInOrder: continues(a, b), at, aAudio, bAudio }, deadline);
      if (reply.status !== 'ready') return null;
      const buffer = new AudioBuffer({ numberOfChannels: 2, length: reply.left.length, sampleRate: RENDER_RATE });
      buffer.copyToChannel(reply.left, 0);
      buffer.copyToChannel(reply.right, 1);
      return { plan: reply.plan, buffer, from: a, to: b };
    },
    PREPARE_BUDGET_MS,
    signal,
  );
}

const isMp3 = (track: Track) => track.format?.container?.toLowerCase() === 'mp3' || track.format?.codec?.toUpperCase() === 'MP3';

const finiteOr = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback);

/** Seconds of `count` beats of the song; 0 without a usable tempo (the windows then fall back to FADE_WINDOW_S). */
const beats = (map: Pick<MixMap, 'bpm'>, count: number) => (map.bpm > 0 && Number.isFinite(map.bpm) ? (count * 60) / map.bpm : 0);

/** How many bytes from the start of the file hold its first `seconds`; undefined: fetch it whole. */
function startBytes(track: Track, seconds: number): number | undefined {
  if (!START_DECODES.has(track.format?.container?.toLowerCase() ?? '') || !(track.size > 0) || !(track.duration > 0)) return undefined;
  const bytes = Math.ceil((track.size * seconds * RANGE_SLACK) / track.duration) + RANGE_HEADROOM_BYTES;
  return bytes < track.size ? bytes : undefined;
}

/** The song's file, or its first `bytes`: from this device if it's kept here, else from the server. */
async function songBytes(track: Track, bytes: number | undefined, signal: AbortSignal): Promise<ArrayBuffer> {
  if (track.fileId in useOffline.getState().songs && typeof caches !== 'undefined') {
    const kept = await caches.match(track.streamUrl, { cacheName: AUDIO_CACHE });
    if (kept) {
      const file = await kept.arrayBuffer();
      return bytes === undefined ? file : file.slice(0, bytes);
    }
  }
  const res = await fetch(track.streamUrl, { signal, headers: bytes === undefined ? {} : { Range: `bytes=0-${bytes - 1}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.arrayBuffer();
}

/** Decoded in an offline context running at the render rate, which resamples to it. */
const decode = (bytes: ArrayBuffer) => new OfflineAudioContext(2, 1, RENDER_RATE).decodeAudioData(bytes);

/** The song's audio from `from` to `to` (copied out, to move to the worker); `whole`: the buffer is the whole song. */
function cut(buffer: AudioBuffer, from: number, to: number, whole: boolean): SongAudio | null {
  if (buffer.sampleRate !== RENDER_RATE) return null;
  const first = Math.max(0, Math.floor(from * RENDER_RATE));
  const last = Math.min(buffer.length, Math.ceil(to * RENDER_RATE));
  if (!(last > first)) return null;
  const left = new Float32Array(last - first);
  const right = new Float32Array(last - first);
  buffer.copyFromChannel(left, 0, first);
  // A mono song plays the same on both sides.
  buffer.copyFromChannel(right, Math.min(1, buffer.numberOfChannels - 1), first);
  return { left, right, start: first / RENDER_RATE, toEnd: whole && last === buffer.length };
}

/**
 * A song's audio from `from` to `to`. Only the bytes from the file's start that hold it are fetched, where
 * the format decodes from a part: for A, mid-song, that's still everything up to where it plays, but not
 * the rest. The whole file otherwise, or when the part doesn't decode or comes out short. Null when what
 * it takes is too big to fetch and decode.
 */
async function songAudio(track: Track, from: number, to: number, signal: AbortSignal): Promise<SongAudio | null> {
  if (!(track.duration <= MAX_SONG_SECONDS)) return null;
  const part = startBytes(track, to);
  if (part !== undefined && part <= MAX_FILE_BYTES) {
    const audio = await songBytes(track, part, signal)
      .then(decode)
      .then((buffer) => cut(buffer, from, to, false))
      .catch(() => null);
    if (audio && audio.start + audio.left.length / RENDER_RATE >= to - 1 / RENDER_RATE) return audio;
    signal.throwIfAborted();
  }
  if (!(track.size <= MAX_FILE_BYTES)) return null;
  return cut(await decode(await songBytes(track, undefined, signal)), from, to, true);
}

/** Plans and renders in a worker of its own, stopped as soon as it answers or `signal` aborts. */
function runWorker(request: LiveMixRequest, signal: AbortSignal): Promise<LiveMixReply> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./liveMix.worker.ts', import.meta.url), { type: 'module' });
    const finish = (settle: () => void) => {
      worker.terminate();
      signal.removeEventListener('abort', onAbort);
      settle();
    };
    const onAbort = () => finish(() => reject(signal.reason));
    signal.addEventListener('abort', onAbort);
    worker.onmessage = (event: MessageEvent<LiveMixReply>) => finish(() => resolve(event.data));
    worker.onerror = (event: ErrorEvent) => finish(() => reject(new Error(event.message)));
    // The songs' audio moves to the worker rather than being copied: it isn't needed here again.
    const { aAudio, bAudio } = request;
    worker.postMessage(request, [aAudio.left.buffer, aAudio.right.buffer, bAudio.left.buffer, bAudio.right.buffer]);
  });
}

/** A live mix playing, or about to. */
export interface LiveMixPlayback {
  /** The audio context's time the mix starts at (output clock): A's element fades out under it then. */
  startsAt: number;
  /** Seconds into the transition now; negative before it starts. For songTimeDuring, bridgeGain and the switch. */
  time(): number;
  /** The mix's loudness, 0–1, as the engine sets an element's volume. */
  setVolume(volume: number): void;
  /** Stops the mix and its timers. The elements stay as they are: the caller decides what plays. */
  stop(): void;
}

/** Calls `fn` when the output clock reaches `when`. Timers drift, so a long wait wakes a little early and measures again. */
function at(context: Clock, when: number, fn: () => void): () => void {
  let timer: ReturnType<typeof setTimeout>;
  const arm = () => {
    const wait = when - outputTime(context);
    timer = wait > 0.25 ? setTimeout(arm, (wait - 0.2) * 1000) : setTimeout(fn, Math.max(0, wait * 1000));
  };
  arm();
  return () => clearTimeout(timer);
}

/**
 * Plays a live mix in time with A: the rendered transition starts at plan.aStart (a bar line of A for a
 * quick mix). It begins as A itself, so A's element fades out over OVERLAP_S as the mix fades in, then
 * pauses. B's element starts from plan.bResume as the transition ends, where it runs into B, the mix
 * fading out under it. Null when it can't start on time (A
 * paused or past the mix's start, the context not running): the caller switches straight away.
 *
 * `a` and `b` must hold the two songs, `a` playing (`aOffset`: where its file starts in the song, for a
 * remainder after a DJ transition); `context` must be running (resumed after a tap or key press).
 */
export function playLiveMix(
  mix: LiveMix,
  {
    a,
    b,
    context,
    aOffset = 0,
    volume = 1,
    onStarted,
    onLanded,
  }: {
    a: HTMLMediaElement;
    b: HTMLMediaElement;
    context: AudioContext;
    aOffset?: number;
    volume?: number;
    /** A has faded out and paused: the mix is what's heard. */
    onStarted?: () => void;
    /** B's element has been told to play (the promise says whether it does). */
    onLanded?: (playing: Promise<void>) => void;
  },
): LiveMixPlayback | null {
  const { plan, buffer } = mix;
  const startsAt = contextTimeFor(plan.aStart - aOffset, a, context);
  // currentTime runs ahead of what's heard: a start before it would play late, off A's beat.
  if (context.state !== 'running' || a.paused || startsAt < context.currentTime + MIN_LEAD_S) return null;
  const endsAt = startsAt + buffer.duration;

  // B waits where the mix leaves it, loading meanwhile. Before its metadata a seek may be ignored (Safari),
  // so it's made once that's there, and checked again as B starts.
  const seekB = () => {
    if (Math.abs(b.currentTime - plan.bResume) > SEEK_SLACK_S) b.currentTime = plan.bResume;
  };
  b.pause();
  if (b.readyState >= 1 /* HAVE_METADATA */) seekB();
  else b.addEventListener('loadedmetadata', seekB, { once: true });

  // The transition → its fades in over A and out under B → the volume → the speakers.
  const source = context.createBufferSource();
  source.buffer = buffer;
  const fade = context.createGain();
  fade.gain.setValueAtTime(0, startsAt);
  fade.gain.linearRampToValueAtTime(1, startsAt + OVERLAP_S);
  fade.gain.setValueAtTime(1, endsAt - OVERLAP_S);
  fade.gain.linearRampToValueAtTime(0, endsAt);
  const level = context.createGain();
  level.gain.value = volume;
  source.connect(fade).connect(level).connect(context.destination);
  // Sample-exact on the context's clock; the elements only follow by timer, a few milliseconds either way.
  source.start(startsAt);

  // A's element fades out as the mix fades in, by the same clock: in steps, as an element's volume only
  // moves by timer, each matching the mix's gain at that moment so the two add up to A's own level.
  let fadingOut: ReturnType<typeof setInterval> | undefined;
  let aVolume: number | undefined;
  /** A's element back to its level, for whatever it plays next (the engine sets it again anyway). */
  const endFadeOut = () => {
    clearInterval(fadingOut);
    if (aVolume !== undefined) a.volume = aVolume;
    aVolume = undefined;
  };
  const fadeOutA = () => {
    const full = (aVolume = a.volume);
    const step = () => {
      const done = (outputTime(context) - startsAt) / OVERLAP_S;
      if (done < 1) return void (a.volume = full * Math.max(0, 1 - done));
      a.pause();
      endFadeOut();
      onStarted?.();
    };
    fadingOut = setInterval(step, OVERLAP_STEP_MS);
    step();
  };
  const timers = [
    at(context, startsAt, fadeOutA),
    endFadeOut,
    at(context, endsAt - B_LEAD_S, () => {
      seekB();
      const playing = b.play();
      if (onLanded) onLanded(playing);
      else playing.catch(() => {});
    }),
  ];
  let stopped = false;
  return {
    startsAt,
    time: () => outputTime(context) - startsAt,
    setVolume: (v) => (level.gain.value = v),
    stop() {
      if (stopped) return;
      stopped = true;
      timers.forEach((cancel) => cancel());
      b.removeEventListener('loadedmetadata', seekB);
      source.stop();
      level.disconnect();
    },
  };
}
