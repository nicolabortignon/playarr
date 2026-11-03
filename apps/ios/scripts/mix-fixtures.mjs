#!/usr/bin/env node
// The mixing rules the app ports to Swift, run in their TypeScript originals: the skip planner
// (packages/mix/src/plan.ts), the cuts and the transition clock (apps/web/src/player/mixSequence.ts)
// and the automation curves (packages/mix/src/automation.ts). Their answers for a fixed set of songs
// go into a Swift file the player's tests compare against, so the two languages can't drift apart.
//
//   node apps/ios/scripts/mix-fixtures.mjs           write the fixtures
//   node apps/ios/scripts/mix-fixtures.mjs --check   fail when they're out of date (make test-scripts)
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../../..');
const out = resolve(root, 'apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/MixFixtures.generated.swift');
const load = (path) => import(pathToFileURL(resolve(root, path)).href);
const { planTransition } = await load('packages/mix/src/plan.ts');
const { valueAt, integrate } = await load('packages/mix/src/automation.ts');
const seq = await load('apps/web/src/player/mixSequence.ts');

/** A mix map with the analysis's usual shape: 120 BPM, 4:00, intro to 0:32, outro from 3:20. */
const map = (o = {}) => ({
  version: 8, duration: 240, bpm: 120, firstBeat: 0.5, downbeatOffset: 0, gridStable: true, beatConfidence: 0.9,
  introEnd: 32.5, outroStart: 200.5, coldStart: false, coldEnd: false, soundStart: 0.2, soundEnd: 238.7,
  phraseEnergy: [0.4, 0.6, 1, 0.9], ...o,
});

const songs = {
  steady: map(),
  sameTempo: map({ bpm: 120.0004, firstBeat: 0.31, downbeatOffset: 2 }),
  close: map({ bpm: 121.5, firstBeat: 0.12, introEnd: 16.3, outroStart: 180.1 }),
  apart: map({ bpm: 128, firstBeat: 0.05, downbeatOffset: 1 }),
  halfTime: map({ bpm: 61, firstBeat: 0.9 }),
  unsureBars: map({ bpm: 119, downbeatConfidence: 0.3, firstBeat: 0.21 }),
  weakBeat: map({ beatConfidence: 0.42, firstBeat: 0.33 }),
  noBeat: map({ beatConfidence: 0.2, gridStable: false }),
  coldNoBeat: map({ beatConfidence: 0.2, gridStable: false, coldStart: true, soundStart: 0 }),
  cues: map({ bpm: 124, cues: { mixIn: 48.4, mixOut: 190.2 }, firstBeat: 0.4 }),
  short: map({ duration: 40, introEnd: 8.5, outroStart: 30.5, soundEnd: 39.8, phraseEnergy: [0.5, 1] }),
  longIntro: map({ introEnd: 64.5, firstBeat: 0.5 }),
  oldMap: map({ version: 3, soundStart: undefined, firstBeat: 1.25, downbeatOffset: 3 }),
};
const names = Object.keys(songs);

// The skips (a press of Next mixed live): songs leaving at different beats, into each kind of next song.
const skips = [];
for (const a of ['steady', 'unsureBars', 'weakBeat', 'short', 'oldMap']) {
  for (const b of ['sameTempo', 'close', 'apart', 'halfTime', 'coldNoBeat', 'cues']) {
    const at = a === 'short' ? 31.7 : 61.3;
    skips.push({ a, b, mode: 'auto', sameAlbumInOrder: false, at, plan: planTransition({ a: songs[a], b: songs[b], mode: 'auto', sameAlbumInOrder: false, skip: { at } }) });
  }
}
for (const [a, b, mode, sameAlbumInOrder, at] of [
  ['steady', 'close', 'off', false, 90], ['steady', 'close', 'party', false, 236.2], ['steady', 'longIntro', 'auto', false, 238.5],
  ['noBeat', 'steady', 'auto', false, 100], ['noBeat', 'coldNoBeat', 'auto', true, 100], ['steady', 'close', 'auto', true, 90],
]) {
  skips.push({ a, b, mode, sameAlbumInOrder, at, plan: planTransition({ a: songs[a], b: songs[b], mode, sameAlbumInOrder, skip: { at } }) });
}

// Cuts on the beat and silence cuts: every pair, then same album and no mixing for each song into itself.
const cuts = [];
const cut = (a, b, mode, sameAlbumInOrder) => {
  const options = { aDuration: songs[a].duration, mode, sameAlbumInOrder };
  cuts.push({ a, b, ...options, beat: seq.beatCut(songs[a], songs[b], options), silence: seq.silenceCut(songs[a], songs[b], options) });
};
for (const a of names) for (const b of names) cut(a, b, 'auto', false);
for (const a of names) {
  cut(a, a, 'auto', true);
  cut(a, a, 'off', false);
}

// Plans of every style from the planner, for the transition's clock, the gains and the straight cuts.
const plans = [];
for (const [a, b, mode, sameAlbumInOrder, aPosition] of [
  ['steady', 'steady', 'auto', false, 10], ['steady', 'close', 'party', false, 10], ['steady', 'apart', 'auto', false, 10],
  ['unsureBars', 'close', 'auto', false, 10], ['noBeat', 'steady', 'auto', false, 10], ['coldNoBeat', 'coldNoBeat', 'auto', false, 10],
  ['steady', 'close', 'off', false, 10], ['steady', 'close', 'auto', true, 10], ['short', 'steady', 'auto', false, 30],
]) {
  const plan = planTransition({ a: songs[a], b: songs[b], mode, sameAlbumInOrder, aPosition, fadeSeconds: 6 });
  const times = [-1, 0, 0.25, plan.switchAt - 0.01, plan.switchAt, plan.length / 2, plan.length - 0.05, plan.length, plan.length + 1];
  const bTimes = [plan.bStart, plan.bStart + 1, plan.bResume - 0.5, plan.bResume, plan.bResume + 1];
  plans.push({
    a, b, plan, aDuration: songs[a].duration,
    straight: seq.straightCut(plan, songs[a].duration),
    times: times.map((t) => ({ t, songTime: seq.songTimeDuring(plan, t), bTime: seq.bTimeAt(plan, t), gain: seq.bridgeGain(plan, t, 0.5, 2) })),
    bTimes: bTimes.map((bTime) => ({ bTime, t: seq.transitionTimeFor(plan, bTime) })),
  });
}

const curves = [
  [{ at: 0, value: 1 }],
  [{ at: 0, value: 0 }, { at: 2, value: 1 }],
  [{ at: 1, value: 0.5 }, { at: 1, value: 1 }, { at: 3, value: 0 }],
  [{ at: 0, value: 0.98 }, { at: 0.7, value: 0.98 }, { at: 0.9, value: 1 }],
].map((automation) => {
  const ts = [-1, 0, 0.5, 0.7, 0.8, 1, 1.5, 2, 2.9, 3, 4];
  return {
    automation,
    values: ts.map((t) => ({ t, value: valueAt(automation, t) })),
    integrals: [[0, 1], [0.5, 2.5], [2, 0.25], [0, 4]].map(([from, to]) => ({ from, to, area: integrate(automation, from, to) })),
  };
});

const json = JSON.stringify({ songs, curves, skips, cuts, plans });
const swift = `// Generated by apps/ios/scripts/mix-fixtures.mjs from the TypeScript originals: don't edit.
// Regenerate with \`node apps/ios/scripts/mix-fixtures.mjs\` after changing the planner or mixSequence.ts.

let mixFixturesJSON = #"""
${json}
"""#
`;
if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(out, 'utf8');
  } catch {}
  if (current !== swift) {
    console.error(`${out} is out of date: run node apps/ios/scripts/mix-fixtures.mjs`);
    process.exit(1);
  }
} else {
  writeFileSync(out, swift);
  console.log(`${skips.length} skips, ${cuts.length} cuts, ${plans.length} plans, ${curves.length} curves → ${out}`);
}
