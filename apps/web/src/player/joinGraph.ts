// Joins measured on the sound itself (desktop). An element's reported time isn't the sample being heard
// (each element has its own decoder, buffers and output path), so two elements lined up by their
// currentTime can still be a few milliseconds apart as heard: at a join that's a bump. Here every
// <audio> element plays through one Web Audio graph (element → delay → gain → speakers). At a join the
// two files hold the same sound (a transition's lead of A, its tail of B), so the graph records both as
// they come out, finds how far apart they are by cross-correlation, delays the one ahead by exactly that,
// checks, and cross-fades on the audio clock: the two then join to the sample.

/** Recorded per look at the two outputs: about 0.17 s at 48 kHz, plenty to line up a beat's worth of sound. */
const CAPTURE_FRAMES = 8192;
/** The script processor's block: the capture is whole blocks of both outputs, recorded together. */
const BLOCK_FRAMES = 4096;
/** How far apart the two may be and still be found: well over a changeover's coarse step (see AHEAD_S). */
const MAX_LAG_S = 0.06;
/** Two copies of one sound correlate near 1; below this the match isn't trusted (silence, or not the same sound). */
const MIN_CORRELATION = 0.9;
/** Quieter than this (RMS) there's nothing to line up by. */
const MIN_RMS = 1e-4;
/** Gains move this smoothly (time constant, s) when the volume changes: no zipper noise. */
const GAIN_SMOOTHING_S = 0.005;
/** The longest delay an element can be given (the coarse step aims for about AHEAD_S). */
const MAX_DELAY_S = 1;
/**
 * The new file is brought this far ahead of the old one by its reported time (coarse, a few ms either
 * way), so the measured gap is one a delay can take up: the one ahead can be held back, not pulled forward.
 */
export const AHEAD_S = 0.02;

/**
 * The best match must beat any other lag (further than a few samples from it) by this much: a held note
 * or a steady bass line repeats every cycle, and lining up one cycle off would be worse than not at all.
 */
const MIN_MARGIN = 0.05;
/** Lags this close to the best are its own peak, not a rival. */
const PEAK_HALF_WIDTH = 8;

/**
 * How far `follower` runs ahead of `lead` (in samples: `follower[i]` is `lead[i + lag]`), found by
 * cross-correlation within ±maxLag, with how well they match (normalised, 1 = identical). Null when
 * there's too little sound, no clear match, or more than one (a sound that repeats within the range).
 *
 * Correlated on each signal's sample-to-sample change rather than the signal: that weighs the highs
 * (hats, attacks, the grain of the sound) over a bass line, whose cycles all look alike.
 */
export function measureLag(lead: Float32Array, follower: Float32Array, maxLag: number): { lag: number; correlation: number } | null {
  const n = Math.min(lead.length, follower.length);
  const window = n - 2 * maxLag - 1;
  if (window < 256) return null;
  const dl = changes(lead, n);
  const df = changes(follower, n);
  // The follower's middle stretch, against the lead shifted by each lag.
  const from = maxLag;
  let followerEnergy = 0;
  for (let i = from; i < from + window; i++) followerEnergy += df[i]! * df[i]!;
  let leadEnergy = 0;
  for (let i = from - maxLag; i < from - maxLag + window; i++) leadEnergy += dl[i]! * dl[i]!;
  if (Math.sqrt(followerEnergy / window) < MIN_RMS || rms(lead, 0, n) < MIN_RMS) return null;
  const scores = new Float32Array(2 * maxLag + 1);
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let cross = 0;
    for (let i = from; i < from + window; i++) cross += dl[i + lag]! * df[i]!;
    scores[lag + maxLag] = leadEnergy > 0 && followerEnergy > 0 ? cross / Math.sqrt(leadEnergy * followerEnergy) : 0;
    // The lead's energy for the next lag: one sample in at the end, one out at the start.
    const enter = dl[from + window + lag]!;
    const leave = dl[from + lag]!;
    leadEnergy += enter * enter - leave * leave;
  }
  let best = 0;
  for (let k = 1; k < scores.length; k++) if (scores[k]! > scores[best]!) best = k;
  let rival = -Infinity;
  for (let k = 0; k < scores.length; k++) if (Math.abs(k - best) > PEAK_HALF_WIDTH) rival = Math.max(rival, scores[k]!);
  const correlation = scores[best]!;
  if (correlation < MIN_CORRELATION || correlation - rival < MIN_MARGIN) return null;
  return { lag: best - maxLag, correlation };
}

/** Each sample's change from the one before (the first, from silence). */
function changes(x: Float32Array, n: number): Float32Array {
  const out = new Float32Array(n);
  out[0] = x[0]!;
  for (let i = 1; i < n; i++) out[i] = x[i]! - x[i - 1]!;
  return out;
}

function rms(x: Float32Array, from: number, length: number): number {
  let sum = 0;
  for (let i = from; i < from + length; i++) sum += x[i]! * x[i]!;
  return Math.sqrt(sum / Math.max(1, length));
}

interface Route {
  delay: DelayNode;
  gain: GainNode;
}

/** The graph every element plays through (see the top of this file). Only where it can be made: see `JoinGraph.create`. */
export class JoinGraph {
  private readonly routes = new Map<HTMLMediaElement, Route>();
  /** Gains a scheduled cross-fade owns until then (context time): volume changes leave them alone meanwhile. */
  private readonly rampedUntil = new Map<HTMLMediaElement, number>();

  private constructor(readonly context: AudioContext) {}

  /** A graph on `context`, where it has what's needed (a desktop browser); null otherwise. */
  static create(context: AudioContext): JoinGraph | null {
    const able = typeof context.createMediaElementSource === 'function' && typeof context.createScriptProcessor === 'function';
    return able ? new JoinGraph(context) : null;
  }

  /**
   * Plays `element` through the graph from now on (for good: an element can't be taken out again). Only
   * while the context runs: routed into a suspended one, it would play silently.
   */
  route(element: HTMLMediaElement): boolean {
    if (this.routes.has(element)) return true;
    if (this.context.state !== 'running') return false;
    try {
      const source = this.context.createMediaElementSource(element);
      const delay = this.context.createDelay(MAX_DELAY_S);
      const gain = this.context.createGain();
      // At the level it plays at now, so one already playing carries on as it was.
      gain.gain.value = element.muted ? 0 : element.volume;
      source.connect(delay).connect(gain).connect(this.context.destination);
      this.routes.set(element, { delay, gain });
      // The level is the graph's from now on; the element plays at full volume into it.
      element.volume = 1;
      element.muted = false;
      return true;
    } catch {
      return false;
    }
  }

  routed(element: HTMLMediaElement): boolean {
    return this.routes.has(element);
  }

  /** The element's level, smoothly; not while a cross-fade owns it. */
  setLevel(element: HTMLMediaElement, level: number) {
    const route = this.routes.get(element);
    if (!route) return;
    const now = this.context.currentTime;
    if ((this.rampedUntil.get(element) ?? 0) > now) return;
    route.gain.gain.setTargetAtTime(level, now, GAIN_SMOOTHING_S);
  }

  /** How long the element's sound is held back on its way out (s). */
  delayOf(element: HTMLMediaElement): number {
    return this.routes.get(element)?.delay.delayTime.value ?? 0;
  }

  setDelay(element: HTMLMediaElement, seconds: number) {
    const route = this.routes.get(element);
    if (route) route.delay.delayTime.setValueAtTime(Math.min(MAX_DELAY_S, Math.max(0, seconds)), this.context.currentTime);
  }

  /**
   * How far `follower` is ahead of `lead` as they come out (s, after their delays), and how well the two
   * match; null when they couldn't be compared (too quiet, not the same sound, or no way to record).
   */
  async lag(lead: HTMLMediaElement, follower: HTMLMediaElement): Promise<number | null> {
    const leadRoute = this.routes.get(lead);
    const followerRoute = this.routes.get(follower);
    if (!leadRoute || !followerRoute || this.context.state !== 'running') return null;
    const { context } = this;
    // Both outputs, before their gains (the follower is silent until it takes over), into one recorder,
    // so each block holds the two at the very same moment.
    const merger = context.createChannelMerger(2);
    leadRoute.delay.connect(merger, 0, 0);
    followerRoute.delay.connect(merger, 0, 1);
    const recorder = context.createScriptProcessor(BLOCK_FRAMES, 2, 1);
    const blocks = Math.ceil(CAPTURE_FRAMES / BLOCK_FRAMES) + 1;
    const leadSound = new Float32Array(blocks * BLOCK_FRAMES);
    const followerSound = new Float32Array(blocks * BLOCK_FRAMES);
    try {
      await new Promise<void>((resolve, reject) => {
        let got = 0;
        // Past twice the time it should take, something's wrong (a page in the background): give up.
        const timeout = setTimeout(() => reject(new Error('no audio to compare')), ((blocks * BLOCK_FRAMES) / context.sampleRate) * 2000 + 500);
        recorder.onaudioprocess = (e) => {
          // The first block may hold what was there before the recorder was connected: skipped.
          if (got > 0) {
            leadSound.set(e.inputBuffer.getChannelData(0), (got - 1) * BLOCK_FRAMES);
            followerSound.set(e.inputBuffer.getChannelData(1), (got - 1) * BLOCK_FRAMES);
          }
          if (++got > blocks) {
            clearTimeout(timeout);
            resolve();
          }
        };
        merger.connect(recorder);
        // A script processor only runs while connected onward; it outputs silence.
        recorder.connect(context.destination);
      });
    } catch {
      return null;
    } finally {
      recorder.onaudioprocess = null;
      for (const off of [() => recorder.disconnect(), () => merger.disconnect(), () => leadRoute.delay.disconnect(merger), () => followerRoute.delay.disconnect(merger)]) {
        try {
          off();
        } catch {
          // Already apart.
        }
      }
    }
    const found = measureLag(leadSound, followerSound, Math.round(MAX_LAG_S * context.sampleRate));
    return found ? found.lag / context.sampleRate : null;
  }

  /**
   * Cross-fades from `lead` to `follower` on the audio clock, starting a moment from now: the lead from
   * `leadLevel` to silence, the follower from silence to `followerLevel`, with equal gains (the two are one
   * sound, so the level holds). Answers when it's over (context time).
   */
  crossfade(lead: HTMLMediaElement, follower: HTMLMediaElement, leadLevel: number, followerLevel: number, seconds: number): number {
    const from = this.context.currentTime + 0.02;
    const to = from + seconds;
    const ramp = (element: HTMLMediaElement, start: number, end: number) => {
      const route = this.routes.get(element);
      if (!route) return;
      route.gain.gain.cancelScheduledValues(0);
      route.gain.gain.setValueAtTime(start, from);
      route.gain.gain.linearRampToValueAtTime(end, to);
      this.rampedUntil.set(element, to);
    };
    ramp(lead, leadLevel, 0);
    ramp(follower, 0, followerLevel);
    return to;
  }

  /** Volume changes reach the element's gain again (a cross-fade called off). */
  release(element: HTMLMediaElement) {
    this.rampedUntil.delete(element);
  }
}
