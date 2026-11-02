/**
 * How loud a song is, the way streaming services level songs: integrated loudness by ITU-R BS.1770-4
 * (EBU R128), in LUFS, and its peak. The stereo signal is K-weighted (a shelf boosting what the ear
 * hears as loud, a high-pass dropping the deep bass it doesn't), its power summed over both channels
 * in 400 ms blocks every 100 ms, and the blocks averaged leaving out silence (below −70 LUFS) and
 * the quiet passages (10 LU below the rest), so a long fade or a quiet intro doesn't make a song
 * read quieter than it sounds.
 */

/** Songs are measured, and levelled streams decoded, at this rate (CD rate: most files' own). */
export const LOUDNESS_RATE = 44_100;

/** Blocks are 400 ms long, one every 100 ms: four sub-blocks each. */
const SUB_BLOCK_SECONDS = 0.1;
const SUB_BLOCKS_PER_BLOCK = 4;
const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_LU = -10;

export interface Loudness {
  /** Integrated loudness (LUFS); null when the song is silence or shorter than a block. */
  lufs: number | null;
  /** The largest sample (dBFS); −Infinity for digital silence. */
  peak: number;
  /** How many sample frames (per channel) the song decodes to at LOUDNESS_RATE. */
  samples: number;
}

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * The two K-weighting filters for any sample rate, from their analogue prototypes (as libebur128
 * derives them): BS.1770 gives coefficients for 48 kHz only.
 */
export function kWeighting(rate: number): [Biquad, Biquad] {
  // The shelf: +4 dB above about 1.7 kHz.
  const k = Math.tan((Math.PI * 1681.974450955533) / rate);
  const q = 0.7071752369554196;
  const vh = 10 ** (3.999843853973347 / 20);
  const vb = vh ** 0.4996667741545416;
  const a0 = 1 + k / q + k * k;
  const shelf: Biquad = {
    b0: (vh + (vb * k) / q + k * k) / a0,
    b1: (2 * (k * k - vh)) / a0,
    b2: (vh - (vb * k) / q + k * k) / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  };
  // The high-pass (RLB weighting): the deep bass below about 38 Hz counts for little.
  const k1 = Math.tan((Math.PI * 38.13547087602444) / rate);
  const q1 = 0.5003270373238773;
  const d = 1 + k1 / q1 + k1 * k1;
  const highPass: Biquad = { b0: 1, b1: -2, b2: 1, a1: (2 * (k1 * k1 - 1)) / d, a2: (1 - k1 / q1 + k1 * k1) / d };
  return [shelf, highPass];
}

/** A block's loudness from its mean square power summed over the channels. */
const lufsOf = (power: number) => -0.691 + 10 * Math.log10(power);

/**
 * Measures a song fed to it piece by piece (interleaved stereo 16-bit PCM, as ffmpeg decodes it), so
 * a long one never has to be held whole.
 */
export class LoudnessMeter {
  private readonly filters: [Biquad, Biquad];
  /** Filter state per channel: [x1, x2, y1, y2] for the shelf, then the same for the high-pass. */
  private readonly state = [new Float64Array(8), new Float64Array(8)];
  private readonly subBlockLength: number;
  /** Mean square power of each 100 ms, summed over the channels. */
  private readonly subBlocks: number[] = [];
  private sum = 0;
  private inSubBlock = 0;
  private maxSample = 0;
  private frames = 0;
  /** The bytes of a stereo frame split between two pieces, until the rest arrives. */
  private leftover = Buffer.alloc(0);

  constructor(rate = LOUDNESS_RATE) {
    this.filters = kWeighting(rate);
    this.subBlockLength = Math.round(rate * SUB_BLOCK_SECONDS);
  }

  push(pcm: Buffer) {
    const bytes = this.leftover.length ? Buffer.concat([this.leftover, pcm]) : pcm;
    const whole = bytes.length - (bytes.length % 4);
    this.leftover = Buffer.from(bytes.subarray(whole));
    this.frames += whole / 4;
    const [shelf, hp] = this.filters;
    const [left, right] = this.state as [Float64Array, Float64Array];
    for (let i = 0; i < whole; i += 4) {
      const l = bytes.readInt16LE(i) / 32768;
      const r = bytes.readInt16LE(i + 2) / 32768;
      const loudest = Math.max(Math.abs(l), Math.abs(r));
      if (loudest > this.maxSample) this.maxSample = loudest;
      const yl = filter(hp, left, 4, filter(shelf, left, 0, l));
      const yr = filter(hp, right, 4, filter(shelf, right, 0, r));
      this.sum += yl * yl + yr * yr;
      if (++this.inSubBlock === this.subBlockLength) {
        this.subBlocks.push(this.sum / this.subBlockLength);
        this.sum = 0;
        this.inSubBlock = 0;
      }
    }
  }

  result(): Loudness {
    const s = this.subBlocks;
    const blocks: number[] = [];
    for (let j = 0; j + SUB_BLOCKS_PER_BLOCK <= s.length; j++) {
      blocks.push((s[j]! + s[j + 1]! + s[j + 2]! + s[j + 3]!) / SUB_BLOCKS_PER_BLOCK);
    }
    const peak = this.maxSample > 0 ? round(20 * Math.log10(this.maxSample)) : -Infinity;
    return { lufs: integrated(blocks), peak, samples: this.frames };
  }
}

/** One step of a biquad (direct form I) whose state sits at `at` in `st`. */
function filter(f: Biquad, st: Float64Array, at: number, x: number): number {
  const y = f.b0 * x + f.b1 * st[at]! + f.b2 * st[at + 1]! - f.a1 * st[at + 2]! - f.a2 * st[at + 3]!;
  st[at + 1] = st[at]!;
  st[at] = x;
  st[at + 3] = st[at + 2]!;
  st[at + 2] = y;
  return y;
}

/** Gated integrated loudness of 400 ms blocks' powers (BS.1770-4 §5.1), or null if nothing passes. */
export function integrated(blocks: number[]): number | null {
  const audible = blocks.filter((p) => p > 0 && lufsOf(p) > ABSOLUTE_GATE_LUFS);
  if (!audible.length) return null;
  const relativeGate = lufsOf(mean(audible)) + RELATIVE_GATE_LU;
  const counted = audible.filter((p) => lufsOf(p) > relativeGate);
  return round(lufsOf(mean(counted)));
}

const mean = (values: number[]) => values.reduce((s, v) => s + v, 0) / values.length;
const round = (v: number) => Math.round(v * 100) / 100;
