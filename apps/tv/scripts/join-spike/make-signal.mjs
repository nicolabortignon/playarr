// The join spike's signal: 6 s of seven unrelated tones with slowly changing levels, so any 1024 samples of it
// appear nowhere else in it. Written as the demo library's 16-bit WAV, and as float for the analysis.
import { mkdirSync, writeFileSync } from 'node:fs';
const RATE = 44100, N = RATE * 6;
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const tones = Array.from({ length: 7 }, () => ({ f: 150 + rnd() * 2850, p: rnd() * 6.283, m: 0.2 + rnd() * 0.8, mp: rnd() * 6.283 }));
const x = new Int16Array(N);
for (let i = 0; i < N; i++) {
  const t = i / RATE;
  let v = 0;
  for (const s of tones) v += 0.1 * (0.6 + 0.4 * Math.sin(2 * Math.PI * s.m * t + s.mp)) * Math.sin(2 * Math.PI * s.f * t + s.p);
  x[i] = Math.round(v * 32767);
}
const wav = Buffer.alloc(44 + N * 4);
wav.write('RIFF', 0); wav.writeUInt32LE(36 + N * 4, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(RATE, 24); wav.writeUInt32LE(RATE * 4, 28);
wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) { wav.writeInt16LE(x[i], 44 + i * 4); wav.writeInt16LE(x[i], 46 + i * 4); }
mkdirSync(new URL("../../build/spike/", import.meta.url), { recursive: true });
const dir = new URL('../../build/demo-library/Spike/Join Test (2026)/', import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL('01 Signal.wav', dir), wav);
writeFileSync(new URL('../../build/spike/signal.s16', import.meta.url), Buffer.from(x.buffer));
console.log('signal', N, 'samples');
