import type { AudioFormat, Fidelity } from './index.ts';

/** Hi-Res is more than CD quality (16-bit at 44.1 or 48 kHz) and lossless; lossless is the rest of lossless. */
export function fidelityOf(format: Pick<AudioFormat, 'lossless' | 'bits' | 'sampleRate'>): Fidelity {
  if (!format.lossless) return 'lossy';
  return (format.bits ?? 0) > 16 || (format.sampleRate ?? 0) > 48_000 ? 'hi-res' : 'lossless';
}

/** Whether a format is found by filtering by `fidelity`: by `lossless`, Hi-Res is too. */
export function hasFidelity(format: Pick<AudioFormat, 'lossless' | 'bits' | 'sampleRate'>, fidelity: Fidelity): boolean {
  const own = fidelityOf(format);
  return own === fidelity || (fidelity === 'lossless' && own === 'hi-res');
}
