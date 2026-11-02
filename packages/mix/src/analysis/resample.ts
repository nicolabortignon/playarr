// Halving a sample rate: the server decodes songs once, at the beat tracker's 22050 Hz, and the rest of
// the analysis measures at half that (ANALYSIS_RATE).

/** Filter length: an odd number, so the filter is centred on a sample and delays nothing. */
const TAPS = 127;
/** The low-pass corner as a share of the input rate: 5 kHz of 22.05 kHz, under the new 5.5 kHz Nyquist. */
const CUTOFF = 5000 / 22050;

const filter = lowPass();

/**
 * `samples` at half the rate: every other sample after a low-pass (a Blackman-windowed sinc) that keeps
 * what lies below ~4.5 kHz (at 22050 Hz in) unchanged and removes what would otherwise fold back. Sample
 * k is the input's sample 2k, with no delay; past either end counts as silence.
 */
export function halveRate(samples: Float32Array): Float32Array {
  const n = samples.length;
  const out = new Float32Array(Math.ceil(n / 2));
  const half = (TAPS - 1) / 2;
  for (let k = 0; k < out.length; k++) {
    const centre = 2 * k;
    const from = Math.max(0, half - centre);
    const to = Math.min(TAPS, n - centre + half);
    let sum = 0;
    for (let j = from; j < to; j++) sum += filter[j]! * samples[centre + j - half]!;
    out[k] = sum;
  }
  return out;
}

/** The windowed-sinc taps, scaled to pass a constant unchanged. */
function lowPass(): Float64Array {
  const half = (TAPS - 1) / 2;
  const taps = Float64Array.from({ length: TAPS }, (_, j) => {
    const x = j - half;
    const sinc = x === 0 ? 2 * CUTOFF : Math.sin(2 * Math.PI * CUTOFF * x) / (Math.PI * x);
    const blackman = 0.42 - 0.5 * Math.cos((2 * Math.PI * j) / (TAPS - 1)) + 0.08 * Math.cos((4 * Math.PI * j) / (TAPS - 1));
    return sinc * blackman;
  });
  const gain = taps.reduce((s, v) => s + v, 0);
  return taps.map((v) => v / gain);
}
