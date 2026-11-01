// The two EQ moves of a DJ transition: a low shelf for the bass swap (take A's bass out as B's
// comes in) and a high-pass for the quick-mix sweep. Both follow an automation curve, so the
// filter is redesigned every short block from the curve's value at that block: fine-grained
// enough that the move sounds smooth, coarse enough that recomputing coefficients costs nothing.
//
// The responses are the Audio EQ Cookbook's (RBJ) low shelf and high-pass: the bilinear transform
// of the same analog filters, prewarped at the corner. They are computed in Andrew Simper's
// trapezoidal state-variable form rather than direct form I, because the state of this form is
// the analog circuit's integrator charge, which stays meaningful when the coefficients change.
// Direct form I's state is past outputs, and a sudden cutoff drop turns them into a burst
// (measured: a 2 kHz → 40 Hz jump on a bass line peaked at 7× the input).

/** Samples per block: coefficients are recomputed this often (2.9 ms at 44.1 kHz). */
export const FILTER_BLOCK = 128;
/** Corner of the bass-swap shelf: below it is the kick and bass line. */
export const SHELF_HZ = 250;
/** Shelf slope S = 1 (the steepest shelf without a bump at the corner), as a Q: 1/√2. */
const SHELF_Q = Math.SQRT1_2;
/** Butterworth Q: a high-pass with no resonant peak at the cutoff. */
export const HIGH_PASS_Q = Math.SQRT1_2;
/** At or below this cutoff the high-pass is off: nothing audible lives under 20 Hz. */
export const HIGH_PASS_OFF_HZ = 20;
/** Shelf gains closer to 0 dB than this are treated as flat. */
const FLAT_DB = 0.01;
/**
 * Samples over which a filter turning on or off cross-fades with the dry signal (11.6 ms at
 * 44.1 kHz). Cutting between filtered and dry in one sample would click: a filter changes the
 * level and phase of the bass, so the two waveforms differ.
 */
const FADE = 4 * FILTER_BLOCK;
/** Raised-cosine weight of the filtered signal through the fade: 0 (dry) at 0, 1 (filtered) at FADE. */
const FADE_CURVE = Float64Array.from({ length: FADE + 1 }, (_, i) => 0.5 - 0.5 * Math.cos((Math.PI * i) / FADE));
/** Dry samples a filter coming back on after a long rest runs over first, so its state matches the music. */
const WARM_UP = 2048;
/** Integrator states smaller than this are flushed to zero: denormal numbers are very slow on some CPUs. */
const DENORMAL = 1e-20;

/** A filter parameter over time: called once per block with the block's start in seconds. */
export type ParameterAt = (blockStartSeconds: number) => number;

/**
 * State-variable filter coefficients: a1–a3 drive the integrators, m0–m2 mix the input, band-pass
 * and low-pass into the output.
 */
interface Coefficients {
  a1: number;
  a2: number;
  a3: number;
  m0: number;
  m1: number;
  m2: number;
}

/**
 * Applies the bass-swap low shelf to `channel` in place: `gainDbAt` gives the shelf gain in dB
 * (0 = flat, −24 = bass gone) at each block's start time, seconds from the start of `channel`.
 */
export function applyLowShelf(channel: Float32Array, gainDbAt: ParameterAt, sampleRate: number): void {
  runFilter(channel, sampleRate, gainDbAt, (gainDb) => Math.abs(gainDb) < FLAT_DB, designLowShelf);
}

/**
 * Applies the sweep high-pass to `channel` in place: `cutoffHzAt` gives the cutoff in Hz at each
 * block's start time (20 Hz or less = off).
 */
export function applyHighPass(channel: Float32Array, cutoffHzAt: ParameterAt, sampleRate: number): void {
  runFilter(channel, sampleRate, cutoffHzAt, (hz) => hz <= HIGH_PASS_OFF_HZ, designHighPass);
}

/**
 * The shared block loop. `wet` (0…FADE) is how far the output has faded from dry to filtered: it
 * counts up while the parameter is active and down while it is neutral, so turning on, turning off
 * and changing one's mind mid-fade are all the same smooth cross-fade. While fading out, the filter
 * keeps its last active setting. Blocks that are neutral and fully dry are left untouched.
 *
 * Turning back on, the filter first runs over the dry samples since it last stopped (they are still
 * the input, as dry blocks aren't touched), so it carries on exactly as if it had been running all
 * along; after a rest longer than WARM_UP it starts afresh on the last WARM_UP samples instead.
 */
function runFilter(
  channel: Float32Array,
  sampleRate: number,
  parameterAt: ParameterAt,
  isNeutral: (value: number) => boolean,
  design: (into: Coefficients, value: number, sampleRate: number) => void,
): void {
  const c: Coefficients = { a1: 0, a2: 0, a3: 0, m0: 1, m1: 0, m2: 0 };
  // Integrator states.
  let ic1 = 0;
  let ic2 = 0;
  let wet = 0;
  /** Where the current stretch of untouched (dry) samples began; the state is as of there. */
  let dryFrom = 0;

  for (let start = 0; start < channel.length; start += FILTER_BLOCK) {
    const end = Math.min(start + FILTER_BLOCK, channel.length);
    const value = parameterAt(start / sampleRate);
    if (!Number.isFinite(value)) throw new RangeError(`filter parameter at ${start / sampleRate} s is ${value}`);
    const active = !isNeutral(value);
    if (!active && wet === 0) continue; // dry: nothing to do

    if (active) {
      design(c, value, sampleRate);
      if (wet === 0) {
        let from = dryFrom;
        if (start - dryFrom > WARM_UP) {
          ic1 = ic2 = 0;
          from = start - WARM_UP;
        }
        const { a1, a2, a3 } = c;
        for (let i = from; i < start; i++) {
          const v3 = channel[i]! - ic2;
          const v1 = a1 * ic1 + a2 * v3;
          const v2 = ic2 + a2 * ic1 + a3 * v3;
          ic1 = 2 * v1 - ic1;
          ic2 = 2 * v2 - ic2;
        }
      }
    }
    if (Math.abs(ic1) < DENORMAL) ic1 = 0;
    if (Math.abs(ic2) < DENORMAL) ic2 = 0;

    const { a1, a2, a3, m0, m1, m2 } = c;
    const step = active ? 1 : -1;
    for (let i = start; i < end; i++) {
      const v0 = channel[i]!;
      const v3 = v0 - ic2;
      const v1 = a1 * ic1 + a2 * v3;
      const v2 = ic2 + a2 * ic1 + a3 * v3;
      ic1 = 2 * v1 - ic1;
      ic2 = 2 * v2 - ic2;
      const y = m0 * v0 + m1 * v1 + m2 * v2;
      if (wet === FADE && active) {
        channel[i] = y;
      } else {
        wet = Math.min(FADE, Math.max(0, wet + step));
        channel[i] = v0 + FADE_CURVE[wet]! * (y - v0);
      }
    }
    if (wet === 0) dryFrom = end; // faded out: the state above is as of `end`
  }
}

/** Integrator coefficients for corner `g` = tan(π·fc/rate) (already scaled) and damping k = 1/Q. */
function setIntegrators(into: Coefficients, g: number, k: number): void {
  into.a1 = 1 / (1 + g * (g + k));
  into.a2 = g * into.a1;
  into.a3 = g * into.a2;
}

/** Cookbook low shelf at SHELF_HZ, slope S = 1, with the given gain in dB. */
function designLowShelf(into: Coefficients, gainDb: number, sampleRate: number): void {
  const a = 10 ** (gainDb / 40);
  const k = 1 / SHELF_Q;
  setIntegrators(into, Math.tan((Math.PI * SHELF_HZ) / sampleRate) / Math.sqrt(a), k);
  into.m0 = 1;
  into.m1 = k * (a - 1);
  into.m2 = a * a - 1;
}

/** Cookbook high-pass at `cutoffHz` with Q = 1/√2; the cutoff is kept below Nyquist. */
function designHighPass(into: Coefficients, cutoffHz: number, sampleRate: number): void {
  const k = 1 / HIGH_PASS_Q;
  setIntegrators(into, Math.tan((Math.PI * Math.min(cutoffHz, 0.45 * sampleRate)) / sampleRate), k);
  into.m0 = 1;
  into.m1 = -k;
  into.m2 = -1;
}
