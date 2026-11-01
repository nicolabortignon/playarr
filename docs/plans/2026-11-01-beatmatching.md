# Beatmatched Transitions Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Songs flow into each other like a DJ mix (long beatmatched blend, quick mix, or straight after), decided per transition, on every device, while the phone still sees two songs.

**Architecture:** The server analyses each song into a *mix map* (beat grid, downbeats, phrases, key, intro/outro). A pure planner in a new `packages/mix` turns two mix maps into a `TransitionPlan`; a pure renderer in the same package turns two PCM excerpts + a plan into mixed PCM. The server renders each upcoming transition to a cached FLAC file; the web player plays A → transition → B on three `<audio>` elements, presenting only A and B to the UI and the lock screen. Desktop browsers additionally render quick mixes live (Web Worker + Web Audio) for skips.

**Tech Stack:** TypeScript (strict), Fastify 5, node:sqlite, worker_threads, ffmpeg (decode + FLAC encode), React 19, zustand, TanStack Query, Vitest, jsdom.

**Design:** `docs/plans/2026-11-01-beatmatching-design.md` — read it first.

---

## Ground rules (read before Task 1)

- **Commands.** `pnpm` isn't on PATH: use `corepack pnpm`. Server tests: `corepack pnpm -C apps/server test`, web: `corepack pnpm -C apps/web test`, mix package: `corepack pnpm -C packages/mix test`. Typecheck: `corepack pnpm -C <dir> typecheck`. A single file: `corepack pnpm -C apps/server exec vitest run src/path/file.test.ts`.
- **Commits.** Commit on `main` after every task (the pre-commit hook bumps the version: never `--no-verify`). Don't push.
- **Style.** Match the surrounding code: comments explain *why* in plain words, names read as English (`songsLeft`, not `sl`), no abbreviations in user-facing text. User-facing text says "song", never "track".
- **Units.** Times in seconds (float) everywhere except where a name says otherwise (`…Ms`, `…Samples`). Sample rates: analysis 11025 Hz mono (existing `SAMPLE_RATE`), rendering 44100 Hz stereo (`RENDER_RATE`).
- **TDD.** Every task: failing test → run → implement → run → commit. Synthetic audio fixtures live in `packages/mix/src/testSignals.ts` (Task 2) and are reused everywhere.
- **Never break playback.** Any missing piece (no mix map, render failed, old browser) falls back to today's crossfade/gapless engine. Each player task keeps the existing `AudioEngine.test.tsx` suite green.

---

## Phase 1 — `packages/mix` foundation

### Task 1: Create the package

**Files:**
- Create: `packages/mix/package.json`, `packages/mix/tsconfig.json`, `packages/mix/src/index.ts`, `packages/mix/src/types.ts`, `packages/mix/src/index.test.ts`
- Modify: `apps/server/package.json` (dependency), `apps/server/tsup.config.ts:13` (`noExternal`), `apps/web/package.json` (dependency)

**Step 1: Scaffold**

`packages/mix/package.json`:
```json
{
  "name": "@playarr/mix",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit", "test": "vitest run" },
  "devDependencies": { "vitest": "^5.0.5" }
}
```
`packages/mix/tsconfig.json`: same as `packages/shared/tsconfig.json`.

`packages/mix/src/types.ts` — the shared vocabulary (complete):
```ts
/** Camelot wheel position: 1–12 and A (minor) or B (major), e.g. "8A". */
export type Camelot = `${number}${'A' | 'B'}`;

/** What Playarr knows about a song for mixing it. Times in seconds from the start of the song. */
export interface MixMap {
  version: number;
  duration: number;
  /** Beats per minute of the grid (not folded: a 174 BPM song stays 174). */
  bpm: number;
  /** Time of the first beat of the grid; beat n is at firstBeat + n * 60 / bpm. */
  firstBeat: number;
  /** The grid's beat index of the first downbeat (0–3): bars start every 4 beats from there. */
  downbeatOffset: number;
  /** The grid holds over the whole song (no wandering tempo): long blends allowed. */
  gridStable: boolean;
  /** 0–1: how sure the beat grid is. */
  beatConfidence: number;
  key?: { camelot: Camelot; confidence: number };
  /** Seconds from the start with a steady beat and little else: where the song can be brought in. */
  introEnd: number;
  /** Seconds from the start where the outro begins (beat-led, sparse): where the song can be left. */
  outroStart: number;
  /** The first big rise in energy, if any. */
  firstDrop?: number;
  /** The song starts on full sound (no fade or intro), or ends abruptly. */
  coldStart: boolean;
  coldEnd: boolean;
  /** Where sound ends (before trailing silence). */
  soundEnd: number;
  /** Energy 0–1 per 16-beat phrase, from the first downbeat. */
  phraseEnergy: number[];
}

/** Hand-set mix points that override the detected ones (Edit mix points). */
export interface CuePoints {
  mixIn?: number;
  mixOut?: number;
}

export type TransitionStyle = 'straight' | 'long' | 'quick' | 'fade';
/** The per-queue override: Auto, Party (longer blends), No mixing (gapless only). */
export type MixMode = 'auto' | 'party' | 'off';

/** A gain or filter value over time, linear between points. Times are seconds into the transition. */
export type Automation = { at: number; value: number }[];

export interface TransitionPlan {
  style: TransitionStyle;
  /** Where in A the transition starts (A plays normally until here). */
  aStart: number;
  /** Where in B the transition starts. */
  bStart: number;
  /** Seconds of transition output. */
  length: number;
  /** Where in B normal playback resumes after the transition. */
  bResume: number;
  /** Seconds into the transition where the listener hears B take over (lock screen switches here). */
  switchAt: number;
  /** B's playback rate over the transition (1 = its own tempo), per point; A always plays at 1. */
  bRate: Automation;
  aGain: Automation;
  bGain: Automation;
  /** Low-shelf gain in dB on each side (0 = flat, −24 = bass gone): the bass swap. */
  aLowDb: Automation;
  bLowDb: Automation;
  /** High-pass cutoff in Hz on A (20 = off): the quick-mix sweep. */
  aHighPassHz: Automation;
  /** Why this style: for the transition view and logs. */
  reason: string;
  /** Beats of overlap, for the transition view. */
  beats: number;
}
```
`src/index.ts`: `export * from './types';`

**Step 2: Write a smoke test** (`src/index.test.ts`): import a type-only value (`export const MIX_MAP_VERSION = 1` added to `types.ts`) and `expect(MIX_MAP_VERSION).toBe(1)`.

**Step 3:** `corepack pnpm install` then `corepack pnpm -C packages/mix test` → PASS. Add `"@playarr/mix": "workspace:*"` to server and web `dependencies`, add `'@playarr/mix'` to server `noExternal`. `corepack pnpm install`; typecheck all three.

**Step 4: Commit** — `git commit -m "packages/mix: types for mix maps and transition plans"`

---

### Task 2: Synthetic test signals

**Files:**
- Create: `packages/mix/src/testSignals.ts`, `packages/mix/src/testSignals.test.ts`

Test-only helpers producing mono Float32Array at a given rate:
- `clickTrack({ bpm, seconds, rate, firstBeat = 0.5, accentEvery = 4, accentOffset = 0 })` — a short decaying 60 Hz sine "kick" on every beat (louder on downbeats) plus a quiet 8 kHz tick on off-beats; returns `{ samples, beats: number[], downbeats: number[] }`.
- `chord({ root: 'C' | …, minor, seconds, rate })` — a sustained triad of sines with harmonics (for key tests).
- `song({ bpm, rate, introBeats, bodyBeats, outroBeats, key })` — intro = kick only, body = kick + chord + noise bursts at higher level, outro = kick only, then 1 s silence; returns the samples plus ground truth `{ introEnd, outroStart, soundEnd }`.
- `stereo(mono)` → interleaved `[L, R]` pair arrays `{ left, right }`.

**Test:** beats are evenly spaced (`beats[1] - beats[0] ≈ 60 / bpm`), the signal peaks near each beat, `song()` truth is consistent (`introEnd < outroStart < soundEnd < duration`).

Commit: `"packages/mix: synthetic songs for tests"`.

---

## Phase 2 — Analysis: the mix map

The DSP lives in `packages/mix/src/analysis/` (pure, reused nowhere else but kept beside its types); the server calls it from its DSP worker.

### Task 3: Precise tempo and beat grid

**Files:**
- Create: `packages/mix/src/analysis/onset.ts` (spectral-flux onset envelope: port `onsetEnvelope` + the FFT from `apps/server/src/analysis/dsp.ts`, exported so the server's `dsp.ts` can import it instead of keeping a copy — do the move in this task and keep `dsp.test.ts` green)
- Create: `packages/mix/src/analysis/beatGrid.ts`, `beatGrid.test.ts`

**Algorithm (implement exactly):**
1. Onset envelope at 11025 Hz, hop 256 (≈43 fps).
2. Coarse tempo: autocorrelation of the envelope over lags for 60–200 BPM, picking the strongest peak with a mild prior toward 120 (reuse the existing `tempo()` approach) — but **don't fold**: test the candidate, ×2 and ×½ with a comb-filter score (sum of envelope at k·period for k up to 16) and keep the best within 70–200.
3. Refine: search `bpm ± 2%` in 0.01 steps maximizing the comb score over the whole excerpt (parabolic interpolation on the best three).
4. Phase: for the refined period, find the offset in `[0, period)` maximizing the summed envelope at `offset + k·period` → `firstBeat` = first such time ≥ 0.
5. Stability: split into 30 s windows; in each, re-run steps 3–4 locally; `gridStable` when every window's best phase lies within ±25 ms of the global grid and local bpm within ±0.5%. `beatConfidence` = (mean envelope at grid beats − mean elsewhere) / (std of envelope), clamped to 0–1 by `scale(x, 0.5, 3)`.

Export `beatGrid(onset: Float64Array, fps: number): { bpm; firstBeat; gridStable; beatConfidence }`.

**Tests** (with `clickTrack` and `song`): 124.00 BPM detected within ±0.05; 174 BPM not folded to 87; firstBeat within ±12 ms; a track whose second half is 4% faster → `gridStable: false`; white noise → `beatConfidence < 0.3`.

Commit: `"mix analysis: precise beat grid"`.

### Task 4: Downbeats and phrases

**Files:** `packages/mix/src/analysis/downbeats.ts`, test.

For each of the 4 candidate offsets, sum low-band (< 150 Hz) energy at beats `offset + 4k`; the offset with the largest low-band accent (ties → largest onset accent) is `downbeatOffset`. Phrases are every 16 beats from the first downbeat. `phraseEnergy[i]` = mean RMS over phrase i, scaled 0–1 relative to the song's loudest phrase.

Tests: `clickTrack({ accentOffset: 2 })` → `downbeatOffset === 2`; `song()` → phrase energies low in intro/outro, high in body.

Commit: `"mix analysis: downbeats and phrases"`.

### Task 5: Key

**Files:** `packages/mix/src/analysis/key.ts`, `key.test.ts`, `packages/mix/src/camelot.ts`, `camelot.test.ts`

- Chromagram: FFT frames (4096 at 11025 Hz), map bins 60 Hz–2 kHz to 12 pitch classes (log-frequency, A4 = 440), sum magnitudes over the song (skip frames below the silence gate).
- Correlate the 12-vector with the 24 rotated Krumhansl–Schmuckler profiles (major/minor; put the profile constants in the file with their source in a comment). Best → key; `confidence` = (best − second best) / best, clamped 0–1 with `scale(x, 0, 0.15)`.
- `camelot.ts`: `toCamelot(pitchClass: number, minor: boolean): Camelot` (table: C major = 8B, A minor = 8A, …), `camelotDistance(a, b)` (0 same, 1 = ±1 on the wheel same letter or same number other letter, else 2+), `keysCompatible(a, b) = distance ≤ 1`.

Tests: C major chord → 8B; A minor → 8A; F♯ minor → 11A; `keysCompatible('8A','9A')`, `('8A','8B')` true, `('8A','3B')` false; noise → confidence < 0.2.

Commit: `"mix analysis: musical key and the Camelot wheel"`.

### Task 6: Intro, outro, drop, cold start/end

**Files:** `packages/mix/src/analysis/sections.ts`, test.

Per beat, compute: low-band energy (kick), full-band RMS, and "fill" = mid/high-band energy excluding transient frames. A beat is *sparse* when fill < 35% of the song's median fill and the kick is present. `introEnd` = start of the first phrase that isn't mostly (≥ 75%) sparse beats, snapped to a phrase boundary (0 if the song starts dense). `outroStart` = the same from the end. `firstDrop` = first phrase whose energy rises ≥ 0.35 over the previous one. `coldStart` = RMS of the first beat ≥ 60% of the median beat RMS; `coldEnd` = the same for the last sounding beat with no fade (energy over the last 4 bars doesn't fall monotonically). `soundEnd` = last frame above the silence gate.

Tests with `song({ introBeats: 32, outroBeats: 32 })`: introEnd and outroStart within one beat of truth; a song with a 10 s linear fade-out → `coldEnd: false`; a song starting at full level → `coldStart: true`.

Commit: `"mix analysis: intro, outro, drop and cold edges"`.

### Task 7: `analyzeMix` — head and tail excerpts

**Files:** `packages/mix/src/analysis/index.ts` (export `analyzeMix`), test.

Signature: `analyzeMix(head: Float32Array, tail: Float32Array | null, duration: number, rate = 11025): MixMap`. `head` covers 0…min(duration, 420 s); `tail` (when the song is longer than 420 s) covers the last 180 s. The grid comes from the head; outro/soundEnd/coldEnd from the tail mapped to song time (`duration − tail.length / rate + t`). Silent or very short input → a map with `beatConfidence: 0`, `gridStable: false`, `introEnd: 0`, `outroStart: duration`, `phraseEnergy: []`.

Tests: a 10-minute synthetic song (head + tail) gets outroStart from the tail; silence handled.

Commit: `"mix analysis: whole-song mix maps"`.

### Task 8: Decode from the end, and stereo for rendering

**Files:**
- Modify: `apps/server/src/media/source.ts` (`PcmOptions` gains `startSeconds?: number`, `fromEnd?: boolean`, `channels?: 1 | 2`; `ffmpegPcmArgs` uses `-ss` before `-i` when `startSeconds` is set, `-sseof -<maxSeconds>` when `fromEnd`, `-ac <channels>`)
- Modify: `apps/server/src/media/local.ts`, `ssh.ts`, `sftp.ts`, `rclone*.ts` only if they build their own args (they call `ffmpegPcmArgs` — check)
- Test: `apps/server/src/media/source.test.ts` (create if missing)

Test the argument list for each option combination (e.g. `{ sampleRate: 44100, maxSeconds: 30, startSeconds: 200.5, channels: 2 }` → contains `['-ss','200.5','-t','30','-i',path]` and `['-ac','2','-ar','44100']`). Keep `maxBuffer` large enough: 44100 × 2 ch × 2 bytes × 150 s ≈ 26 MB, so raise `maxBuffer` to 96 MB in `local.ts` (and ssh equivalents).

Commit: `"media: decode a section of a song, from the end, or in stereo"`.

### Task 9: Store mix maps

**Files:**
- Modify: `apps/server/src/db.ts` — migration: `CREATE TABLE mix_maps (recording_id TEXT PRIMARY KEY, version INTEGER NOT NULL, data TEXT, error TEXT, analyzed_at TEXT NOT NULL); CREATE TABLE cue_points (recording_id TEXT PRIMARY KEY, mix_in REAL, mix_out REAL, updated_at TEXT NOT NULL);`
- Modify: `apps/server/src/analysis/analyzer.ts` — after `features` for a song, also decode the tail when `duration > 420` (`media.pcm(path, { sampleRate: SAMPLE_RATE, maxSeconds: 180, fromEnd: true })`), run `analyzeMix` on the DSP thread, save to `mix_maps`. Add `mixMaps(ids): Map<string, MixMap>` and include `mix_maps` in `ensure`'s "already done" check (a song is done when both rows exist at current versions).
- Modify: `apps/server/src/analysis/dspThread.ts` + `dspWorker.ts` — message `{ id, kind: 'features' | 'mixmap', pcm, tail?, duration? }`.
- Test: `apps/server/src/analysis/analyzer.test.ts` (extend; there's an existing pattern with fake media) — a song gets a mix map row; a long song also triggers a `fromEnd` decode.

Commit: `"analysis: a mix map for every song"`.

### Task 10: Mix map and cue point API

**Files:**
- Create: `apps/server/src/routes/mixMaps.ts`, test
- Modify: `apps/server/src/index.ts` (wire), `packages/shared/src/index.ts` (re-export nothing — the web imports types from `@playarr/mix`)

Routes:
- `POST /api/mix-maps { ids: string[] (≤ 50) }` → `Record<recordingId, MixMap & { cues?: CuePoints }>`; ensures missing ones (audio) like `/api/levels`.
- `GET /api/recordings/:id/cues` → `CuePoints`; `PUT` (body `{ mixIn?: number | null, mixOut?: number | null }`, validated 0 ≤ t ≤ duration, `requireLocal` not needed — it's a library edit like favorites; keep the `X-Playarr` header rule) → saves, and calls `transitions.forget(recordingId)` (Task 15; inject as an optional callback now).

Tests with Fastify inject.

Commit: `"API: mix maps and cue points"`.

---

## Phase 3 — The planner

### Task 11: Planner — style decision

**Files:** `packages/mix/src/plan.ts`, `plan.test.ts`

```ts
export interface PlanInput {
  a: MixMap & { cues?: CuePoints };
  b: MixMap & { cues?: CuePoints };
  mode: MixMode;
  /** B follows A on the same album, in order (decided by the caller from the tracks). */
  sameAlbumInOrder: boolean;
  /** Where A's playback is now (a plan never starts in the past). */
  aPosition?: number;
}
export function planTransition(input: PlanInput): TransitionPlan
```

Decision order (encode as a small table and test each row):
1. `mode === 'off'` or `sameAlbumInOrder` → straight.
2. Either `beatConfidence < 0.35` → fade (if neither song is cold on the joining edge) else straight.
3. `a.coldEnd && b.coldStart` and tempo ratio outside 0.92–1.08 → straight.
4. Tempo ratio `r = a.bpm / b.bpm` normalized against ×2/×½ to the closest to 1; `|r − 1| > 0.08` → quick (downbeat cut with echo-out) when both confidences ≥ 0.5, else fade.
5. Long requires: both `gridStable`, keys compatible (or either key confidence < 0.3), `a.duration − outroStartA ≥ beats(16)` and `b.introEnd ≥ beats(16)` (cue points override intro/outro). Otherwise quick.
6. Long length: the largest of 64/32/16 beats that fits both outro and intro room; `party` adds one step (×2) when room allows; `auto` caps at 32 unless both outro and intro ≥ 64 beats.

`reason` strings are plain English ("Tempos 4% apart and keys compatible: 32-beat blend").

Commit: `"mix planner: choosing long, quick, straight or fade"`.

### Task 12: Planner — placement, tempo and automation

**Files:** same.

- `aStart` = the latest phrase boundary in A ≤ `min(cues.mixOut ?? outroStart … soundEnd − length)` such that `aStart ≥ aPosition + 5 s`; if none, `quick` at the next downbeat ≥ aPosition + 2 s.
- `bStart` = the phrase boundary in B such that B's phrase grid lands on A's downbeat at `aStart`: B's downbeat nearest to `(cues.mixIn ?? introEnd) − length_in_B` but ≥ B's first downbeat; length in B's own time = `length × rate`.
- `bRate`: constant `a.bpm / b.bpm` (normalized ×2/½) during the overlap, then ease linearly back to 1 over 16 bars (long) or 0 bars (quick: rate 1 when |r−1| ≤ 2%, else cut without stretch). `length` includes the ease-back; `bResume` = `bStart + ∫ rate dt` over the transition (helper `integrate(automation, length)`).
- Gains: long — `aGain` 1 until 75% of the overlap then down to 0 at the overlap's end (equal-power curve sampled at 8 points), `bGain` 0→1 over the first 25%, `aLowDb`: 0 → −24 at the midpoint (on a bar line), `bLowDb`: −24 → 0 at the same point; `switchAt` = that midpoint. Quick — `aHighPassHz` 20 → 800 over the overlap, `aGain` 1 → 0, `bGain` 0 → 1 over the last 2 beats; `switchAt` = the cut. Fade — equal-power crossfade over `min(8 s, length)`. Straight — `length: 0`, `bStart: 0`, `bResume: 0`.

Tests: B's downbeats coincide with A's to < 1 ms after mapping both into transition time; `bResume` matches the integral; switchAt on a bar line; aStart never before aPosition + 5 s.

Commit: `"mix planner: where, how fast, and the EQ moves"`.

---

## Phase 4 — The renderer

### Task 13: Building blocks — biquad, automation, WSOLA

**Files:** `packages/mix/src/render/biquad.ts`, `automation.ts`, `stretch.ts`, tests.

- `biquad.ts`: RBJ cookbook low-shelf (at 250 Hz) and high-pass (Q 0.707), processing a block with per-block coefficient updates (block = 128 samples) so automation is smooth. Test: a 50 Hz sine through low-shelf −24 dB comes out ≥ 20 dB quieter; a 2 kHz sine unchanged (±0.5 dB); high-pass at 800 Hz attenuates 100 Hz by ≥ 15 dB.
- `automation.ts`: `valueAt(automation, t)` (linear between points, held at ends) and `integrate(automation, from, to)`. Test with simple ramps.
- `stretch.ts`: WSOLA time-stretch with a *time-varying* rate (`rateAt(t)`): frame 2048 at 44.1 kHz, overlap 50%, search ±512 samples by cross-correlation, Hann overlap-add. Signature `stretch(input: Float32Array, rate: (outSeconds: number) => number, outSamples: number, sampleRate): Float32Array`. Tests: a 440 Hz sine stretched at rate 0.95 keeps 440 Hz (zero-crossing count ±1%) and has length `outSamples`; a click track at 120 BPM stretched by 1.05 has clicks every `0.5 / 1.05` s (±2 ms).

Commit: `"mix renderer: filters, automation and time-stretch"`.

### Task 14: `renderTransition`

**Files:** `packages/mix/src/render/index.ts`, test.

```ts
export interface Excerpt { left: Float32Array; right: Float32Array; /** song time of sample 0 */ start: number; }
export function renderTransition(plan: TransitionPlan, a: Excerpt, b: Excerpt, rate = 44100): { left: Float32Array; right: Float32Array }
```
`a` must cover `[plan.aStart, plan.aStart + overlap]`, `b` must cover `[plan.bStart, plan.bResume]` (throw a clear error otherwise). B is stretched per `plan.bRate` (both channels with the same splice points: run WSOLA on the mid channel to pick offsets, apply them to L and R), each side goes through its low-shelf/high-pass, gains are applied, then summed with a soft limiter (`tanh` above −1 dBFS). Also export `excerptRanges(plan): { a: [from, to]; b: [from, to] }` for callers to decode exactly what's needed (+0.25 s margins).

Tests:
- Two click tracks (120 and 124 BPM) with a long plan: in the output, A's and B's clicks during the overlap coincide within 2 ms (detect peaks per band: A's kick at 60 Hz, B's kick at 80 Hz in the fixtures).
- The first 10 ms of output equals A's excerpt at `aStart` (the join into the transition is seamless) and the last 10 ms equals B at `bResume` played at rate 1 (the join out is seamless) — tolerance 1e-3.
- Bass swap: low-band energy of A drops by ≥ 18 dB after `switchAt`.

Commit: `"mix renderer: rendering a whole transition"`.

---

## Phase 5 — Server transitions

### Task 15: Transition service

**Files:**
- Create: `apps/server/src/transitions/transitions.ts`, `transitions.test.ts`
- Modify: `apps/server/src/analysis/dspThread.ts` / `dspWorker.ts` (add `kind: 'render'` running `renderTransition`; transfer the Float32Array buffers)
- Modify: `apps/server/src/routes/art.ts` (generalize `trimArtCache` into `trimCacheDir(dir, maxBytes)` in a new `apps/server/src/cacheDir.ts`; art keeps calling it)

`class Transitions` (deps: `library`, `files`, `analyzer` (for `mixMaps` + cues), `dsp`, `cacheDir`, `ffmpegPath`, `log`):
- `request(fromTrackId, toTrackId, mode, aPosition?)` → `{ status: 'ready', plan, url, continuationUrl? } | { status: 'pending', plan } | { status: 'straight', plan } | { status: 'unavailable', reason }`. Plans are computed immediately (cheap); rendering is queued (one at a time, low priority, max 3 queued, newest first — a skipped song's render is dropped).
- Cache key: sha1 of `[aRecording, bRecording, mode, MIX_MAP_VERSION, RENDERER_VERSION, cues of both, plan.aStart, plan.bStart]`; file `${cacheDir}/transitions/${key}.flac` plus `${key}.json` (the plan).
- Rendering: `excerptRanges(plan)` → two `media.pcm(path, { sampleRate: 44100, channels: 2, startSeconds, maxSeconds })` decodes (s16le stereo → deinterleave to Float32) → `dsp.render(...)` → encode with **local** ffmpeg: `ffmpeg -f f32le -ar 44100 -ac 2 -i - -c:a flac -compression_level 5 out.flac.tmp` → rename. If local ffmpeg is missing, write WAV instead (`.wav`) — the response URL reflects it.
- Continuation: when B's file is MP3 (or any VBR codec per `file.format`), also render `[bResume, end]` as FLAC (`-ss bResume -i path -c:a flac`) and return `continuationUrl`.
- `forget(recordingId)` deletes cached files involving it (index file names → keep a small JSON index in memory loaded from the `.json` sidecars).
- Size cap: `TRANSITIONS_CACHE_MB` (default 1024) via `trimCacheDir`, run after each render.

Tests: fake library/files/media returning synthetic PCM; a request goes pending → ready (file exists, plan matches); the same request again is served from cache without rendering; `forget` removes it; a newer request supersedes a queued one.

Commit: `"server: rendering transitions to cached files"`.

### Task 16: Transition routes

**Files:** `apps/server/src/routes/transitions.ts`, test; wire in `index.ts`; add `TRANSITIONS_CACHE_MB` to `config.ts` and `.env.example`.

- `POST /api/transitions { from: trackId, to: trackId, mode: 'auto'|'party'|'off', position?: number }` → the service result.
- `GET /transitions/:file` (`^[0-9a-f]{40}\.(flac|wav)$` only) → range-served file with `Cache-Control: private, max-age=31536000, immutable` (names are content keys). Reuse `parseRange` from `@playarr/shared` like `routes/stream.ts`.
- The service worker must not intercept `/transitions/` specially beyond the default (network); add `/^\/transitions\//` to the navigation denylist in `apps/web/src/sw.ts`.

Commit: `"API: transitions"`.

---

## Phase 6 — The player

### Task 17: Settings and the per-queue override

**Files:**
- Modify: `apps/web/src/lib/prefs.ts` — `transitions: 'off' | 'crossfade' | 'dj'` (default `'crossfade'` when `crossfade > 0` was saved, else `'off'`); keep `crossfade` seconds.
- Modify: `apps/web/src/player/store.ts` — `mixMode: MixMode` (session, persisted with the queue; reset to `'auto'` by `playTracks`), `setMixMode`.
- Modify: `apps/web/src/components/PlaybackPanel.tsx` — the Sound section: *Transitions* pills (Off · Crossfade · DJ mix); the crossfade seconds pills only when Crossfade is chosen; a line explaining DJ mix ("Songs are mixed like a DJ would, when their beats allow: long blends, quick mixes or straight after").
- Tests: prefs migration (a saved `crossfade: 6` → `transitions: 'crossfade'`), store reset on `playTracks`.

Commit: `"Settings: Transitions (off, crossfade, DJ mix)"`.

### Task 18: Asking for the upcoming transition

**Files:**
- Create: `apps/web/src/player/transitions.ts`, test
- Modify: `apps/web/src/lib/api.ts` (`transition(from, to, mode, position)`, `mixMaps(ids)`)

A zustand store `useTransition` holding `{ fromFileId, toFileId, result }` for the current → next pair. A hook `useUpcomingTransition()` (mounted in `AudioEngine`) asks when: transitions are `'dj'`, the current song has played ≥ 5 s (so skipping through songs doesn't render each pair), and `upNext()` exists; re-asks on `pending` every 3 s until ready or until A is within 20 s of `plan.aStart` (then gives up for this pair → fallback). It also preloads the transition file into the standby deck (Task 19) once ready.

Tests: pairs change with the queue; no request in the first 5 s; polling stops when ready.

Commit: `"player: knowing the next transition"`.

### Task 19: Three decks — A → transition → B

**Files:**
- Modify: `apps/web/src/player/AudioEngine.tsx`, `apps/web/src/player/AudioEngine.test.tsx`
- Create: `apps/web/src/player/mixSequence.ts` (pure helpers), test

Pure helpers (`mixSequence.ts`), fully unit-tested:
- `songTimeDuring(plan, transitionTime)` → `{ song: 'a' | 'b'; time }` (A's time before `switchAt`, B's mapped time after, using `integrate(plan.bRate)`).
- `transitionTimeFor(plan, bTime)` (inverse, for seeking within B during the transition — returns null if outside).

Engine changes (keep the existing two-deck gapless path intact; the third deck is only used for DJ transitions):
1. Render a third `<audio>` (the *bridge* deck). When `useTransition` is ready, load the transition URL into it and the B song into the standby deck (`currentTime = plan.bResume`, or the continuation URL at 0).
2. Schedule `handOffToBridge` at `plan.aStart` exactly like `approachEnd` schedules gapless (LEAD_MS, timer + `timeupdate` re-arming), with a 15 ms equal-power overlap where the device can set volume.
3. While the bridge plays: `useClock` and Media Session show **A** until `switchAt`, then **B** with mapped time (`songTimeDuring`). At `switchAt` call `usePlayer.next(true)` *once* with a `handedOff` marker so the track effect doesn't reload B (same mechanism as gapless). The play tracker finishes A as `'ended'` at that point and starts B with `heard` credited from the bridge's B section.
4. At the bridge's end (`plan.length − LEAD`), start the standby deck (B) — again the gapless handoff.
5. Seeking during the bridge: `transitionTimeFor` → if inside, seek the bridge; else abandon the bridge and seek B. Next during the bridge → jump to B's deck at the mapped position. Pause pauses whichever deck plays. Sleep timer "end of song" with a planned transition → don't start the bridge.
6. Any error on the bridge deck → abandon it (fall back to gapless at A's end).

Tests in `AudioEngine.test.tsx` (extend the fake media to three elements; mock `useTransition` with a ready plan): A → bridge at `aStart`, Media Session title switches once at `switchAt`, B deck starts at `bResume` at the bridge end; `next()` during the bridge lands in B; a bridge error falls back to gapless; history gets exactly two plays.

Commit: `"player: playing DJ transitions, the phone still seeing two songs"`.

### Task 20: Live mixer on desktop

**Files:**
- Create: `apps/web/src/player/liveMix.worker.ts` (imports `planTransition`, `renderTransition`), `apps/web/src/player/liveMix.ts`, test
- Modify: `AudioEngine.tsx`

When the user skips (or the server transition isn't ready) on a device where `canSetVolume()` and `AudioContext` exist and `matchMedia('(pointer: fine)')` (desktop): fetch both mix maps (`api.mixMaps`), plan a **quick** transition from A's current position, fetch the needed byte ranges is hard for compressed files — instead fetch B's start from the offline cache or the network (`fetch(streamUrl)` with `Range: bytes=0-<estimate>`), `decodeAudioData` (desktop only), take A's tail by decoding A the same way, render in the worker, then play the result through an `AudioBufferSourceNode` scheduled at the next downbeat of A (A's element time → context time via `getOutputTimestamp`), pause A's element at that instant, and start B's element at `bResume` when the buffer ends. If any step takes longer than 1.5 s or fails → today's behaviour (immediate switch).

Test the pure parts (choosing the downbeat, the timeout fallback) with fakes; the Web Audio path is exercised manually (document how in the task's commit message).

Commit: `"player: live quick mixes on desktop when skipping"`.

### Task 21: Phones without a ready transition — beat-aligned cut

**Files:** `AudioEngine.tsx`, `mixSequence.ts`, tests.

When DJ mix is on, a mix map exists for both songs, and no rendered transition is available at A's end, cut on A's last downbeat before `soundEnd` (instead of playing A's tail out) and start B at its first downbeat (`firstBeat + downbeatOffset × 60/bpm`, ≥ introEnd − 1 bar when the intro is long). Uses the existing gapless handoff with a different end point.

Test: with maps, the handoff happens at the computed downbeat and B starts at its downbeat.

Commit: `"player: on-the-beat cuts when no transition is ready"`.

---

## Phase 7 — Extras

### Task 22: Downloads include their transitions

**Files:** `apps/web/src/player/offline.ts`, `downloads.ts`, tests.

For each download (in its own order), after its songs are kept, request transitions for consecutive pairs (`mode: 'auto'`) and keep each ready file in the audio cache (reuse `keepSong` with a pseudo-track `{ fileId: -hash, streamUrl: url, size }`; record them under `pins[key].transitions`). The service worker already serves anything in the audio cache with ranges. Removing the download removes them.

Commit: `"Downloads: their transitions, for mixed playback offline"`.

### Task 23: Mix-friendly ordering

**Files:**
- Modify: `apps/server/src/mixes/mixes.ts` (`radio`), `apps/server/src/mixes/generators.ts` (final ordering step), `apps/server/src/mixes/taste.ts` (`Song` gains `mix?: Pick<MixMap, 'bpm' | 'key' | 'beatConfidence'>` from `analyzer.mixMaps`)
- Create: `packages/mix/src/blend.ts` (`blendScore(a, b): number` 0–1 = tempo closeness (×2/½ aware) × key compatibility (soft when unsure) × energy continuity), test
- Tests: generators — a mix's neighbours have a higher average `blendScore` than a random order of the same songs; radio prefers the seed's tempo and key.

Order mixes with a greedy nearest-neighbour walk on `blendScore` starting from the planned first song, then a 2-opt pass limited to 200 swaps; keep the existing "no artist twice in a row" rule as a hard constraint.

Commit: `"Mixes and radio: songs ordered to blend"`.

### Task 24: Transition view

**Files:** `apps/web/src/components/TransitionView.tsx`, test; modify `NowPlaying.tsx` (a small "Next: 32-beat blend · 124 → 126 BPM · 8A → 9A" line under the transport that opens a sheet) and `pages/Queue.tsx` (the same line under the current song).

The sheet shows: style and reason, both songs' `phraseEnergy` as two aligned strips (single accent color, the mix region highlighted, beat ticks every bar — follow the dataviz skill: thin marks, labels in text tokens, a table fallback), and the per-queue override as a PillGroup (Auto · Party · No mixing → `setMixMode`).

Commit: `"Now Playing: what the next transition will be"`.

### Task 25: Edit mix points

**Files:** `apps/web/src/components/MixPointsDialog.tsx`, test; add "Edit mix points" to the song menus in `TrackList.tsx` and `NowPlaying.tsx` (only when transitions are `'dj'`), `useUI` gains `mixPointsTrack`.

The dialog fetches the song's mix map, draws the energy strip with bar ticks, and two draggable markers (mix in, mix out) that snap to bars (pointer + keyboard: arrows move by one bar, Shift by a phrase). Play buttons preview 8 s from each marker (plays the song in the main player from there). Save → `PUT /api/recordings/:id/cues`; Reset → nulls.

Commit: `"Edit mix points for songs the detection gets wrong"`.

---

## Phase 8 — Finish

### Task 26: Docs and full verification

- Update `README.md` (player bullet: DJ transitions; roadmap), `.env.example` (`TRANSITIONS_CACHE_MB`), and the design doc's status.
- Run every suite and typecheck: `corepack pnpm -C packages/mix test && corepack pnpm -C apps/server test && corepack pnpm -C apps/web test && corepack pnpm -r typecheck` → all green; `corepack pnpm -C apps/web exec vite build` succeeds.
- Local end-to-end: start the server on a temp folder of synthetic songs (generate WAVs with Python as in earlier sessions, including two 124/126 BPM click songs with intros/outros), `POST /api/transitions`, wait for `ready`, fetch the FLAC, and check its length equals `plan.length` (±10 ms) with `ffprobe` if available.
- Commit: `"Docs: DJ transitions"`. Then ask the user for a listening pass on the NAS: long blend between two dance songs, quick mix across a tempo jump, an album played in order (must stay gapless), and a locked iPhone.
