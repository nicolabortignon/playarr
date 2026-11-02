/**
 * The beat model: Beat This! (small, see assets/README.md) run with onnxruntime-web's WebAssembly
 * build, which needs nothing native (the Docker image stays Alpine). Loaded on first use; meant for
 * beatModelWorker.ts, off the main thread, since a song takes it seconds of every core it's given.
 */
import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { BEAT_THIS_BANDS, BEAT_THIS_FPS, beatThisSpectrogram, type BeatActivations } from '@playarr/mix';
import type { InferenceSession, Tensor } from 'onnxruntime-web';

/** Frames the model hears at once: 30 s, what it was trained on. */
const CHUNK_FRAMES = 1500;
/** Frames at each end of a chunk whose answer is left out (the model wasn't trained on its edges); chunks overlap by that much. */
const BORDER_FRAMES = 6;

/**
 * Threads for the model: all cores but one (left for streaming and pages), at most 4. Seconds per
 * song either way; with 3 on a NAS's N100, about 15 s for a 4-minute song.
 */
export const MODEL_THREADS = Math.max(1, Math.min(4, availableParallelism() - 1));

type Ort = typeof import('onnxruntime-web');

export class BeatModel {
  private constructor(
    private readonly ort: Ort,
    private readonly session: InferenceSession,
  ) {}

  /** Loads the model (from `file`, else the assets folder); fails if it's missing or can't run here. */
  static async load(file = modelFile()): Promise<BeatModel> {
    if (!file) throw new Error('The beat model (assets/beat-this-small.onnx) is missing');
    const ort = await import('onnxruntime-web');
    ort.env.wasm.numThreads = MODEL_THREADS;
    const session = await ort.InferenceSession.create(file, { executionProviders: ['wasm'] });
    return new BeatModel(ort, session);
  }

  /**
   * The model's beat and downbeat odds for `samples` (mono at BEAT_THIS_RATE), one value per frame
   * (1/50 s): its spectrogram in 30 s chunks overlapping by 6 frames, each frame answered by the
   * first chunk that has it away from its edges, as Beat This!'s own inference does.
   */
  async activations(samples: Float32Array): Promise<BeatActivations> {
    const spect = beatThisSpectrogram(samples);
    const frames = spect.length / BEAT_THIS_BANDS;
    const beat = new Float32Array(frames).fill(-1000);
    const downbeat = new Float32Array(frames).fill(-1000);
    const answered = new Uint8Array(frames);
    for (const start of chunkStarts(frames)) {
      const from = Math.max(start, 0);
      const to = Math.min(start + CHUNK_FRAMES, frames);
      // The first and last chunks are padded with silence where they hang over the song's ends.
      const before = from - start;
      const after = Math.max(0, Math.min(BORDER_FRAMES, start + CHUNK_FRAMES - frames));
      const length = before + (to - from) + after;
      const input = new Float32Array(length * BEAT_THIS_BANDS);
      input.set(spect.subarray(from * BEAT_THIS_BANDS, to * BEAT_THIS_BANDS), before * BEAT_THIS_BANDS);
      const answer = await this.session.run({ spect: new this.ort.Tensor('float32', input, [1, length, BEAT_THIS_BANDS]) });
      const beats = (answer.beat as Tensor).data as Float32Array;
      const downbeats = (answer.downbeat as Tensor).data as Float32Array;
      for (let i = BORDER_FRAMES; i < length - BORDER_FRAMES; i++) {
        const frame = start + i;
        if (frame < 0 || frame >= frames || answered[frame]) continue;
        beat[frame] = beats[i]!;
        downbeat[frame] = downbeats[i]!;
        answered[frame] = 1;
      }
    }
    return { fps: BEAT_THIS_FPS, beat, downbeat };
  }

  async close() {
    await this.session.release();
  }
}

/**
 * Where each chunk starts (a frame; the first is negative, padded): every 1488 frames from −6, the
 * last moved back to end at the song's end, so no chunk is short.
 */
function chunkStarts(frames: number): number[] {
  const step = CHUNK_FRAMES - 2 * BORDER_FRAMES;
  const starts: number[] = [];
  for (let start = -BORDER_FRAMES; start < frames - BORDER_FRAMES; start += step) starts.push(start);
  if (frames > step) starts[starts.length - 1] = frames - (CHUNK_FRAMES - BORDER_FRAMES);
  return starts;
}

/** The model file: next to the built server (dist/../assets) or the source (src/analysis/../../assets). */
function modelFile(): string | undefined {
  for (const relative of ['../assets/beat-this-small.onnx', '../../assets/beat-this-small.onnx']) {
    const path = fileURLToPath(new URL(relative, import.meta.url));
    if (existsSync(path)) return path;
  }
  return undefined;
}
