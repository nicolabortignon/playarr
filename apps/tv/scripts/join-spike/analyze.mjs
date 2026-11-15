// Where each stretch of a spike output comes from in the signal: its lag (output sample − signal sample) and how
// closely it matches there. A perfect join keeps lag 0 throughout; a repeat makes it negative, a loss positive.
import { readFileSync } from 'node:fs';
const sig = new Int16Array(readFileSync(new URL('../../build/spike/signal.s16', import.meta.url)).buffer.slice(0));
const W = 1024, STEP = 512, SPAN = 5000;
function corr(o, p, s) {
  let xy = 0, xx = 0, yy = 0;
  for (let i = 0; i < W; i++) { const a = o[p + i], b = sig[s + i]; xy += a * b; xx += a * a; yy += b * b; }
  return xx && yy ? xy / Math.sqrt(xx * yy) : 0;
}
for (const name of process.argv.slice(2)) {
  const raw = new Int16Array(readFileSync(new URL(`../../build/spike/out/${name}.pcm`, import.meta.url)).buffer.slice(0));
  const o = raw.filter((_, i) => i % 2 === 0);
  const segments = [];
  let worst = 1;
  for (let p = 0; p + W <= o.length; p += STEP) {
    let best = { lag: null, c: -1 };
    const prev = segments.at(-1)?.lag ?? 0;
    const tryLag = (lag) => { const s = p - lag; if (s < 0 || s + W > sig.length) return; const c = corr(o, p, s); if (c > best.c) best = { lag, c }; };
    tryLag(prev);
    if (best.c < 0.98) for (let lag = -SPAN; lag <= SPAN; lag++) tryLag(lag);
    if (best.lag === null) continue; // past the signal's end (the final padding)
    if (best.c < 0.98) best.lag = 'none';
    const seg = segments.at(-1);
    if (seg && seg.lag === best.lag) { seg.to = p + W; seg.min = Math.min(seg.min, best.c); }
    else segments.push({ lag: best.lag, from: p, to: p + W, min: best.c });
    if (typeof best.lag === 'number') worst = Math.min(worst, best.c);
  }
  console.log(`${name}: ${o.length} samples`);
  for (const s of segments) console.log(`  output ${s.from}–${s.to}: lag ${s.lag}${typeof s.lag === 'number' ? `, match ≥ ${s.min.toFixed(4)}` : ''}`);
}
