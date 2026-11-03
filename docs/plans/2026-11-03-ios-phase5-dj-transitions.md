# Native iOS app, Phase 5: DJ Transitions and Stats for Nerds Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** With Settings → Playback → DJ mix, the phone mixes songs as the web does, on the lock screen too. It asks the server for the transition into the next song with the web's asking rules, downloads the rendered file before the mix point and plays it sample-aligned between the two songs. When the file isn't there in time, it plays a fade or a quick mix live from the plan's curves, or cuts on the beat. A press of Next mixes into the next song on the next bar. Mixing follows the queue's mode (Auto, Party, No mixing) and the album-in-order rule, and stops for the sleep timer's end of song. Now Playing and the Queue show "Next: …", which opens the transition sheet, and Settings → Appearance → Stats for nerds shows everything known about the song playing over the app.

**Architecture:** All of this sits on phase 3's engine seam: one sample clock for two decks and the transition node, with gains in the PCM. `TransitionPlanner` (`@MainActor @Observable`) ports the web's asking rules from `apps/web/src/player/transitions.ts`. `MixMapStore` ports `mixMaps.ts`. `TransitionCoordinator` downloads a ready file into `StreamCache`. `DJJoin` picks the next song's join from what's known: `.transition` (the server's file), `.mix` (a plan played live), `.cut` (a beat cut) or the old `.crossfade`. `AudioEngine` places a DJ join as late as it can, on exact samples:

- The file plays on the transition node.
- A is cut inside the file's lead.
- B starts from its own file or the server's `continuationUrl` at the sample where the file ends.
- The queue and lock screen move on at the plan's `switchAt`.

A live mix runs the plan's gain curves and filters (`DeckAutomation`, `MixFilter`, ported from `packages/mix/src/render/filters.ts`) into each block before it's scheduled. A stretched B is resampled by `VarispeedSource` so it lands on its own playback sample for sample. Presses of Next are planned on the phone by `SkipPlanner`, a port of `packages/mix/src/plan.ts`; the server never plans skips. A node script runs the TypeScript originals so the Swift tests can compare against them. The UI (`TransitionLine`, `TransitionSheet`, `EnergyAroundTheMix`, `StatsForNerdsOverlay`) reads `Player.transitions` and the engine's `mix` and `mixReports`.

**Tech Stack:** Swift 6.2 language mode with strict concurrency (written and checked with Xcode 27.2 / Swift 6.4 on macOS 26), AVFAudio, Accelerate, Observation, SwiftUI, Swift Testing; Node ≥ 22.18 (runs `.ts` files directly) for the fixture script. No third-party packages.

**Design:** [2026-11-03-ios-app-design.md](2026-11-03-ios-app-design.md), section 3 ("Audio engine": transitions, live mixes, Stats for nerds). Names: [2026-11-03-ios-conventions.md](2026-11-03-ios-conventions.md). Rules to port: [2026-11-03-ios-parity-inventory.md](2026-11-03-ios-parity-inventory.md), section 4. The web's originals: `apps/web/src/player/transitions.ts`, `mixMaps.ts`, `mixSequence.ts`, `AudioEngine.tsx` (`prepareBridge`, `joinInto`, `takeNext`), `packages/mix/src/plan.ts`, `automation.ts`, `render/filters.ts`, `apps/web/src/components/TransitionView.tsx`, `StatsForNerds.tsx`. Phase 3's seam: [2026-11-03-ios-phase3-audio-engine.md](2026-11-03-ios-phase3-audio-engine.md), key decision 10.

---

## Conventions

- Run everything from the repo root, `/Users/bortignon/dev/playarr`.
- Packages: `swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer` (one suite: `--filter MixRulesTests`; several: `--filter 'MixRulesTests|SkipPlannerTests'`), the same with `PlayarrUI`. `--disable-sandbox` because SwiftPM's sandbox can't start inside Claude's shell. Everything: `make -C apps/ios test` (`corepack pnpm ios:test`).
- A step that expects the build to fail keeps the compiler's first message with `grep -m1 -E '\.swift:[0-9]+:[0-9]+: .*error'` (the compiler colours its messages, so the line carries escape codes around `error:`).
- Engine tests render the real graph offline on the Mac, as in phase 3. Mixes are checked to the sample with a "tag" channel: the right channel carries a value that says which file and which frame is heard (see `TransitionFiles.swift`).
- Swift: 2-space indentation, one primary type per file named after it, no force unwraps outside tests, user-facing text in the web's words (where the web says "browser", say "this device").
- Changes to phase 3's files come as patches with 3 lines of context, applied with `git apply`. They were made against `main` at `4cc5200`. If one doesn't apply because those files changed since, run `git apply --reject` and make each rejected hunk by hand: every hunk is a "replace these lines with those" around unchanged context. Patches go in `/tmp`; they are never committed.
- Commit after every task, on `main`, only that task's files, with the message given (plain English, no prefixes, ending with the `Co-Authored-By` line). The pre-commit hook bumps the version: never bypass it. The user pushes.

## Before you start

**Phases 2 and 3 are on `main`** (phase 3 merged in `96a12db`), and phase 4 is landing: at `4cc5200` it has `AppearanceSettings`, `ToastCenter` and `Format`. This plan was checked against `main` at `4cc5200`. **Phase 4 must have landed in full** (`AccountSession`, Now Playing, the Queue, the shell) before Tasks 14 and 15. This plan uses the names below. Task 0 checks them; if one differs, change the one place that spells it out (given in brackets).

From phase 2 (`PlayarrAPI`, generated from `packages/mix/src/types.ts` and `packages/shared`):
- `TransitionPlan` (`style: TransitionStyle`, `aStart`, `bStart`, `length`, `bResume`, `switchAt`, `bRate`/`aGain`/`bGain`/`aLowDb`/`bLowDb`/`aHighPassHz: Automation`, `reason`, `beats: Double`), `TransitionStyle` (`.straight`, `.long`, `.quick`, `.fade`, `.unknown`), `AutomationItem(at:value:)`, `typealias Automation = [AutomationItem]`.
- `TransitionAnswer` (`.ready(Ready)`, `.pending(Pending)`, `.straight(Straight)`, `.unavailable(Unavailable)`, `.unknown(String)`), `TransitionAnswer.Ready` (`plan`, `url`, `continuationUrl?`, `levels: Levels?`), `TransitionAnswer.Ready.Levels(a:b:)`, `Pending` (`plan`, `render: RenderProgress?`), `RenderProgress` (`step: Step`, `ahead: Double?`, …), `Unavailable(reason:)`.
- `MixMapEntry` (the flattened `MixMap & { cues? }`: `version: Int`, `duration`, `bpm?`, `firstBeat?`, `downbeatOffset: Double?`, `downbeatConfidence?`, `beatConfidence?`, `gridStable?`, `introEnd`, `outroStart`, `coldStart`, `coldEnd`, `soundStart?`, `soundEnd?`, `phraseEnergy?`, `key?`, `camelot?`, `cues: CuePoints?`, …), `CuePoints(mixIn:mixOut:)`, `public let mixMapVersion`.
- `TransitionRequest(from:to:mode:position:fromFileId:toFileId:fade:albumQueue:levels:)`, `TrackMetadata` (`analysis: Analysis?`, `copies: [TrackCopyMetadata]`, `genres`), `TrackLevel`, `Track`, `AudioFormat(codec:container:lossless:)`, `MixMode`.
- `API.Playback.transition(_:)`, `API.Playback.mixMaps(ids:)`, `API.Library.trackMetadata(id:)`, `MediaURLs.transition(_ path:) -> URL?`, `APIError` (`.server(status:message:)`, `.offline`). [`PlayerBackend.swift`, Task 11.] All of these are in `main`'s `PlayarrAPI`.

From phase 3 (`PlayarrPlayer`, on `main`; its files are as its plan gives them). This plan patches `EngineItem.swift`, `Deck.swift`, `AudioEngine.swift`, `StreamCache.swift`, `PlayerBackend.swift`, `Player.swift`, `Tests/…/Support/FakeBackend.swift` and `StreamCacheTests.swift`, and uses `PlaybackSettings.transitions == .dj`, `.crossfade`, `QueueState.mixMode`, `.source: PlaySource?` (`href`), `.nextByPress`, `.upNextIndex`, `JoinRules.continues(_:_:)`, `AudioEngine.Tuning` (`scheduleAhead`, `block`, `startMargin`, `lowWater`, `preload`, `maxFade`), `Deck.place(at:)`/`load(…)`, `GainEnvelope`, `PCMBlock`, `PCMSource`, `FileDecoder`, `SignalSource`, `Signals`, `StubServer`, `song(_:…)`, `temporaryDirectory()`.

From phase 4 (`PlayarrUI`): `AccountSession` (`player`, `api: any APISending`), `AppModel` (`appearance`, `toasts`), `AppearanceSettings.statsForNerds` (UserDefaults `appearance.statsForNerds`, with its toggle in Settings → Appearance), `ToastCenter.push(_:tone:action:)` with `ToastCenter.Action(_ label:run:)`, `Format.time(_:)` (Stats for nerds' times), and the views `NowPlaying/NowPlayingView.swift`, `Pages/Queue/QueueView.swift` and `Shell/AppShell.swift` that Tasks 14 and 15 add to. [`AppearanceSettings`, `ToastCenter` and `Format` are checked by Task 13's build; the rest is used by Tasks 14 and 15 only.]

---

## Key decisions

**1. The server renders, the phone places.** A DJ transition is a file the server renders (`POST /api/transitions`). It is FLAC at 44.1 kHz and holds:

- a lead of A, floored to whole samples;
- the body, `round(length × 44 100)` samples;
- a tail of B.

Its sample 0 is A's frame `round(aStart × 44 100) − lead`. The sample after the body is B's frame `round(bResume × 44 100)`.

The phone downloads the file whole into the stream cache before the mix point, never as it plays, and places three things on the one timeline:

- **The cut.** A stops anywhere inside the lead, because both files hold the same sound there. By default that's the middle. If the middle is already behind what's scheduled, the cut goes as soon after it as can still be, and past the lead the mix is missed.
- **The file**, on the transition node, from the cut to the end of its body.
- **B**, at the sample after the body, from `bResume`: from its own file, or from the server's `continuationUrl` (`.rest.flac`), which runs on from the tail sample for sample. An MP3 can't be started at an exact sample by another decoder, so the server makes a continuation for MP3s; only a FLAC one is used, because it streams as it downloads.

The queue, Now Playing and the lock screen move on at `switchAt`, the middle of the blend, as on the web.

**2. Placed as late as possible, never late.** A join can only be taken back by a new epoch once it's scheduled, because a node's buffers can't be cleared. So the engine places a DJ join only when its start comes within what's scheduled ahead plus a block. With DJ mix on, it keeps 2.5 s scheduled instead of 10 (`Player.djScheduleAhead`). A mix or a press of Next can then still be placed a few seconds before it starts, and the next song's join can change until then.

If B isn't decoded by then, A's scheduling is held at the join's start while B gets ready, until just before A would run short. Then the join is missed (`EngineEvent.mixMissed`): B follows gapless from its start, and the Player doesn't try that mix again. Nothing is ever scheduled into the past (phase 3, key decision 6).

**3. What plays live, and the time-stretch decision.** When the server's file isn't here in time:

- A **fade** is played live from the plan's curves.
- A **quick mix** is played live when its stretch of B is within 2.1% (the planner allows 2%).
- A **long blend** needs the server's file. Its stretch can reach 8% over half a minute, and varispeed would be heard as pitch. Without the file, the phone cuts on the beat (the web's `beatCut`), else leaves out the silence between the songs (`silenceCut`), else joins gapless.

Live mixes run the plan's gain curves and filters into the PCM of each block before it's scheduled. The filters are the renderer's: a low shelf at 250 Hz (`aLowDb`, `bLowDb`) and a high-pass sweep on A (`aHighPassHz`), as state-variable filters updated every 128 samples. They're applied by `DeckAutomation`, so they stay sample-exact.

B's stretch is varispeed (`VarispeedSource`: Catmull-Rom resampling at the plan's `bRate` curve), and it lands exactly on `bResume`. It changes pitch by at most a third of a semitone for a few seconds, as a DJ's pitch fader would.

Pitch-preserving stretch on the phone (`AVAudioUnitTimePitch`) was rejected:

- It adds latency the timeline can't account for to the sample.
- Its rate changes aren't sample-accurate.
- It would sit on every node's path, or need a node of its own outside the shared clock.

Long blends stay the server's job.

**4. Levels.** The server renders at the levels the request sent (`levels`, only when either gain is non-zero, as the web), and answers with `Ready.levels`. The phone may have learned a song's level since. `TransitionJoin` keeps `correctionA`/`correctionB` (play gain minus the level sent), and `TransitionFileSource` turns the file by `MixSequence.bridgeGain` (the transition clock decides how much of each correction applies). A continuation plays at `gainB − levels.b`.

**5. Skips are planned on the phone.** A press of Next with DJ mix (playing, mixing on, not repeat one, not the sleep timer's end of song, no mix under way) is taken over by `Player.takeNextPress()`:

- A mix into that song about to start within 3 s (`BRIDGE_SOON_S`) is waited for.
- Otherwise `SkipPlanner` plans a quick mix on A's next bar from where scheduling allows (`time + scheduleAhead + block + 0.25 s`). The engine plays it live, on both songs' own audio.
- A second press, a plan that says straight on, missing mix maps or a missed mix: the queue moves on at once, as before.

The play report says skipped (`.changed`), as for any press. The web could only do this on a desktop browser (`liveMix.ts`); the native engine does it everywhere.

**6. The web's asking rules, exactly.**

- `TransitionPlanner` asks once the song has played 5 s (`MIN_PLAYED_S`), and the first ask comes 2 s after the pair settles.
- It polls a pending answer every 3 s, or every 10 s after five pending answers or while paused.
- Errors (offline, 429, 5xx) are retried 3 times, then every 10 s. Any other 4xx gives up ("refused"). Offline, it waits for the network.
- "Unavailable" is asked once more after 60 s.
- It gives up 20 s before the mix point (`aStart`) and asks again after a restart (10 s margin).
- A ready transition survives a seek that lands 1 s before its mix point (`READY_LEAD_S`).
- The position sent is frozen at the first ask of a pair. A change of levels, files, mode or fade is a new pair.

`MixMapStore` follows `mixMaps.ts`:

- What's on screen is asked every 30 s, 10 times at most, while any map isn't at `mixMapVersion`.
- The Player's own lookups are fresh for 60 s.
- Ids go 50 to a request.

**7. Modes and the album rule.** No mixing (`queue.mixMode == .off`) asks nothing and joins as before. Songs of one album in order, in a queue that plays that album or its artist (`DJJoin.playsAlbum`, as `decks.ts`), are sent with `albumQueue` (the server answers straight on). The phone's own cuts get the same `sameAlbumInOrder` and leave them alone.

**8. The sleep timer.** With "end of song" set, nothing is asked and no mix is placed. A mix already placed plays out (taking it back would cost a new epoch), and the music pauses where it ends, with the next song shown, as at a cut.

**9. One rule set in two languages.** `apps/ios/scripts/mix-fixtures.mjs` imports the TypeScript originals (node runs `.ts` directly) and writes their answers for a fixed set of songs into a Swift file:

- 36 skips, including the album-in-order cases;
- 195 cuts;
- 9 plans' transition clocks and bridge gains;
- 4 curves.

The Swift tests compare against them. `make test-scripts` fails when the file is out of date, so a change to the planner or `mixSequence.ts` must regenerate it.

**10. What a new epoch does to a mix.** A seek, an output change, running short with a deck behind or a failed transition file all start a new epoch. The mix is abandoned: the song shown plays on alone from where it was, and the next song joins gapless. The web seeks inside the bridge instead (`seekInBridge`); the phone doesn't, because re-placing a transition after a seek inside it would need its own scheduling path for a rare case.

**11. Checked before writing.** All the Swift below was compiled under Swift 6 strict concurrency for macOS 26, and for the iOS 26 Simulator. It was compiled against the real code on `main` at `4cc5200`: phases 2 and 3, and phase 4's `AppearanceSettings`, `ToastCenter` and `Format`. Its tests pass: 154 in `PlayarrPlayer` (the 102 on `main` and this phase's 52) and 60 in `PlayarrUI` (50 and 10). `PlayarrUI` with all of this phase's views, which builds the three packages, also builds for the iOS Simulator with `xcodebuild`. The whole plan was then replayed from this document, task by task, on a fresh copy of that code, running every command in it. Every expected failure and count below is what the replay printed. The fixture script ran against today's `packages/mix` and `apps/web` with Node 25. Not checked: the edits to phase 4's three views and the overlay's mounting (Tasks 14 and 15; those views weren't in the tree yet), and anything on a device (Task 16).

---

### Task 0: Check the starting point

**Files:** none.

**Step 1: Phase 2's names are there**

```bash
grep -n "func transition(_ request\|func mixMaps(ids\|func trackMetadata(id" apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/Endpoints/*.swift
grep -n "public func transition(_ path" apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/MediaURLs.swift
grep -n "public enum TransitionAnswer\|public struct MixMapEntry\|public struct TransitionPlan:\|public let mixMapVersion\|public struct AutomationItem\|public struct TrackMetadata:" apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/Models.generated.swift
grep -n "public struct TransitionRequest" -r apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI
```

Expected: each grep prints its lines. If one is missing, phase 2 isn't done: stop and say so.

**Step 2: Phase 3's seam and phase 4's views are there**

```bash
grep -n "func timelineSample(of\|func scheduleTransition\|let transitionDeck\|public let tuning" apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/AudioEngine.swift
grep -n "var nextByPress\|var upNextIndex\|var mixMode\|var source" apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/QueueState.swift
grep -n "statsForNerds" apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Theme/AppearanceSettings.swift
grep -n "func push(_ message" apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/ToastCenter.swift
grep -n "Transport(player: player)" apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/NowPlaying/NowPlayingView.swift
grep -n "nowPlaying(track)" apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Queue/QueueView.swift
grep -n "ToastsView()" apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/AppShell.swift
```

Expected: each grep prints its lines. The last three are only needed by Tasks 14 and 15. If they print nothing, phase 4 hasn't finished: do Tasks 1 to 13, and Tasks 14 to 16 once it has.

**Step 3: Everything builds and passes**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer 2>&1 | tail -1
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI 2>&1 | tail -1
node --version
```

Expected: both `Test run with … tests … passed`, and Node v22.18 or later. Note the player's count: 102 on `main` at `4cc5200`. Each task below adds its tests to it.

---

### Task 1: The mixing rules' answers, from the TypeScript

The script imports the TypeScript originals and writes what they answer for a fixed set of songs into a Swift file, which the Swift tests of Tasks 2 and 3 compare against. Songs are referenced by name so the file stays small (about 88 KB).

**Files:**
- Create: `apps/ios/scripts/mix-fixtures.mjs`
- Create: `apps/ios/scripts/mix-fixtures.test.mjs`
- Create (generated): `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/MixFixtures.generated.swift`

**Step 1: Write the failing test**

Create `apps/ios/scripts/mix-fixtures.test.mjs`:

```js
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('the Swift mix fixtures are what the TypeScript rules answer today', () => {
  const run = spawnSync(process.execPath, [new URL('./mix-fixtures.mjs', import.meta.url).pathname, '--check'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
});
```

**Step 2: Run it to see it fail**

```bash
node --test apps/ios/scripts/mix-fixtures.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)"
```

Expected: `ℹ pass 0` and `ℹ fail 1` (the script isn't there).

**Step 3: Write the script**

Create `apps/ios/scripts/mix-fixtures.mjs`:

```js
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
```

**Step 4: Generate the fixtures, then run the test**

```bash
node apps/ios/scripts/mix-fixtures.mjs
node --test apps/ios/scripts/mix-fixtures.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)"
```

Expected: `36 skips, 195 cuts, 9 plans, 4 curves → …/MixFixtures.generated.swift`, then `ℹ pass 1` and `ℹ fail 0`. `make -C apps/ios test-scripts` runs it with the other script tests (it globs `scripts/*.test.mjs`).

**Step 5: Commit**

```bash
git add apps/ios/scripts/mix-fixtures.mjs apps/ios/scripts/mix-fixtures.test.mjs \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/MixFixtures.generated.swift
git commit -F - <<'EOF'
Write the mixing rules' answers from the TypeScript into fixtures for the iOS player

The skip planner, the web's cuts and transition clock and the automation curves answer for a fixed set of songs; the
Swift ports are tested against them, and make test-scripts fails when they're out of date.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 2: Curves, cuts and the transition clock (mixSequence.ts)

`Automation` read as `packages/mix/src/automation.ts` reads it (`valueAt`, `integrate`). `MixSequence` ports `apps/web/src/player/mixSequence.ts`:

- `bTimeAt`, `songTimeDuring` and `transitionTimeFor`, the transition's clock;
- `bridgeGain`;
- `beatCut`, `silenceCut` and `straightCut`.

`MixFixtures.swift` decodes the generated JSON and compares plans within 1e-9.

**Files:**
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Automation+Curve.swift`
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/MixSequence.swift`
- Create: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/MixFixtures.swift`
- Test: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/MixRulesTests.swift`

**Step 1: Write the failing tests**

Create `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/MixFixtures.swift`:

```swift
import Foundation
import PlayarrAPI
@testable import PlayarrPlayer

/// The TypeScript originals' answers (see apps/ios/scripts/mix-fixtures.mjs), decoded.
struct MixFixtures: Decodable {
  struct Curve: Decodable {
    struct Value: Decodable { let t: Double; let value: Double }
    struct Area: Decodable { let from: Double; let to: Double; let area: Double }
    let automation: Automation
    let values: [Value]
    let integrals: [Area]
  }
  struct Skip: Decodable {
    let a: String
    let b: String
    let mode: MixMode
    let sameAlbumInOrder: Bool
    let at: Double
    let plan: TransitionPlan
  }
  struct Cut: Decodable {
    let a: String
    let b: String
    let aDuration: Double
    let mode: MixMode
    let sameAlbumInOrder: Bool
    let beat: BeatCut?
    let silence: BeatCut?
  }
  struct Plan: Decodable {
    struct SongTime: Decodable { let song: MixSequence.Song; let time: Double }
    struct Moment: Decodable { let t: Double; let songTime: SongTime; let bTime: Double; let gain: Double }
    struct BMoment: Decodable { let bTime: Double; let t: Double? }
    let a: String
    let b: String
    let plan: TransitionPlan
    let aDuration: Double
    let straight: BeatCut?
    let times: [Moment]
    let bTimes: [BMoment]
  }
  let songs: [String: MixMapEntry]
  let curves: [Curve]
  let skips: [Skip]
  let cuts: [Cut]
  let plans: [Plan]

  static let all: MixFixtures = {
    do {
      return try JSONDecoder().decode(MixFixtures.self, from: Data(mixFixturesJSON.utf8))
    } catch {
      fatalError("MixFixtures.generated.swift doesn't decode: \(error)")
    }
  }()

  func song(_ name: String) -> MixMapEntry {
    guard let song = songs[name] else { fatalError("no song \(name) in the fixtures") }
    return song
  }
}

/// Two plans agree to 1e-9 in every number (the languages' floating point is the same IEEE arithmetic).
func close(_ x: TransitionPlan, _ y: TransitionPlan) -> Bool {
  let numbers: (TransitionPlan) -> [Double] = { p in
    [p.aStart, p.bStart, p.length, p.bResume, p.switchAt, p.beats]
      + [p.bRate, p.aGain, p.bGain, p.aLowDb, p.bLowDb, p.aHighPassHz].flatMap { [Double($0.count)] + $0.flatMap { [$0.at, $0.value] } }
  }
  let (a, b) = (numbers(x), numbers(y))
  return x.style == y.style && x.reason == y.reason && a.count == b.count && zip(a, b).allSatisfy { abs($0 - $1) < 1e-9 }
}
```

Create `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/MixRulesTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrPlayer

/// The Swift ports against their TypeScript originals' answers (MixFixtures.generated.swift).
struct MixRulesTests {
  let fixtures = MixFixtures.all

  @Test func curvesReadAsTheTypeScriptReadsThem() {
    for curve in fixtures.curves {
      for v in curve.values { #expect(abs(curve.automation.value(at: v.t) - v.value) < 1e-12, "\(curve.automation) at \(v.t)") }
      for i in curve.integrals { #expect(abs(curve.automation.integral(from: i.from, to: i.to) - i.area) < 1e-12) }
    }
    #expect(Automation().value(at: 3) == 0)
  }

  @Test func aSongIsSilentFromItsGainsLastStepDown() {
    let fade: Automation = [AutomationItem(at: 0, value: 1), AutomationItem(at: 4, value: 1), AutomationItem(at: 6, value: 0)]
    #expect(fade.silentFrom(limit: 8) == 6)
    #expect(fade.silentFrom(limit: 5) == 5)
    #expect([AutomationItem(at: 0, value: 1)].silentFrom(limit: 8) == 8)
  }

  @Test func cutsAreTheWebsCuts() {
    #expect(fixtures.cuts.count > 150)
    for c in fixtures.cuts {
      let (a, b) = (fixtures.song(c.a), fixtures.song(c.b))
      let beat = MixSequence.beatCut(a, b, aDuration: c.aDuration, mode: c.mode, sameAlbumInOrder: c.sameAlbumInOrder)
      let silence = MixSequence.silenceCut(a, b, aDuration: c.aDuration, mode: c.mode, sameAlbumInOrder: c.sameAlbumInOrder)
      #expect(same(beat, c.beat), "beat cut \(c.a) → \(c.b) \(c.mode)")
      #expect(same(silence, c.silence), "silence cut \(c.a) → \(c.b) \(c.mode)")
    }
  }

  @Test func theTransitionsClockGainsAndStraightCutsAreTheWebs() {
    for p in fixtures.plans {
      #expect(same(MixSequence.straightCut(p.plan, aDuration: p.aDuration), p.straight), "straight \(p.a) → \(p.b)")
      for m in p.times {
        let shown = MixSequence.songTimeDuring(p.plan, m.t)
        #expect(shown.song == m.songTime.song && abs(shown.time - m.songTime.time) < 1e-9)
        #expect(abs(MixSequence.bTimeAt(p.plan, m.t) - m.bTime) < 1e-9)
        #expect(abs(MixSequence.bridgeGain(p.plan, m.t, gainA: 0.5, gainB: 2) - m.gain) < 1e-9)
      }
      for m in p.bTimes {
        let t = MixSequence.transitionTimeFor(p.plan, m.bTime)
        #expect((t == nil) == (m.t == nil))
        if let t, let expected = m.t { #expect(abs(t - expected) < 1e-9) }
      }
    }
  }

  private func same(_ x: BeatCut?, _ y: BeatCut?) -> Bool {
    switch (x, y) {
    case (nil, nil): true
    case let (x?, y?): abs(x.aEnd - y.aEnd) < 1e-9 && abs(x.bStart - y.bStart) < 1e-9
    default: false
    }
  }
}
```

(Task 3 adds the skips' test to this suite.)

**Step 2: Run them to see them fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter MixRulesTests 2>&1 | grep -m1 -E '\.swift:[0-9]+:[0-9]+: .*error'
```

Expected: `…/Support/MixFixtures.swift:…: error: cannot find type 'BeatCut' in scope` (and `MixSequence` after it).

**Step 3: Implement**

Create `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Automation+Curve.swift`:

```swift
import PlayarrAPI

/// A plan's curves (gains, filters, B's rate) as packages/mix/src/automation.ts reads them: straight lines between
/// points, flat before the first and after the last; two points at one time are a step, which takes effect on time.
extension Array where Element == AutomationItem {
  /// The curve's value `t` seconds into the transition (`valueAt`). An empty curve reads 0.
  public func value(at t: Double) -> Double {
    guard let first, let last else { return 0 }
    if t < first.at { return first.value }
    if t >= last.at { return last.value }
    var index = 0
    while index + 1 < count, self[index + 1].at <= t { index += 1 }
    let from = self[index], to = self[index + 1]
    return from.value + (to.value - from.value) * (t - from.at) / (to.at - from.at)
  }

  /// The exact area under the curve from `from` to `to`, negative when `to` comes first (`integrate`): for B's rate,
  /// how many of B's own seconds play in that stretch of the transition.
  public func integral(from: Double, to: Double) -> Double {
    if to < from { return -integral(from: to, to: from) }
    let breakpoints = [from] + map(\.at).filter { $0 > from && $0 < to } + [to]
    var area = 0.0
    for (start, end) in zip(breakpoints, breakpoints.dropFirst()) where end > start {
      area += (end - start) * value(at: (start + end) / 2)
    }
    return area
  }

  /// When the curve last falls to 0 and stays there (A's gain: where A is no longer heard), at most `limit`.
  public func silentFrom(limit: Double) -> Double {
    guard let lastHeard = lastIndex(where: { $0.value > 0 }) else { return 0 }
    return Swift.min(lastHeard + 1 < count ? self[lastHeard + 1].at : limit, limit)
  }
}
```

Create `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/MixSequence.swift`:

```swift
import Foundation
import PlayarrAPI

/// Where A stops and B starts at a cut (song seconds): a cut on the beat, a silence cut, or the server's straight on.
public struct BeatCut: Sendable, Equatable, Codable {
  public var aEnd: Double
  public var bStart: Double
  public init(aEnd: Double, bStart: Double) {
    self.aEnd = aEnd
    self.bStart = bStart
  }
}

/// The parts of apps/web/src/player/mixSequence.ts the app needs, rule for rule: the transition's clock (the listener
/// only ever sees the two songs), the gain that keeps a transition at the songs' levels, and the cuts DJ mix makes
/// when there's no transition to play.
public enum MixSequence {
  /// Below this a beat grid is a guess (`STEADY_BEAT_CONFIDENCE` in plan.ts).
  public static let steadyBeatConfidence = 0.35
  /// Below this the bar starts are a guess (`MIN_DOWNBEAT_CONFIDENCE`).
  public static let minDownbeatConfidence = 0.4
  /// A cut never leaves A more than this before its real end.
  static let longestCut = 20.0
  /// B's intro longer than this many bars is mostly skipped at a cut.
  static let longIntroBars = 8.0
  /// Silence shorter than this at a join isn't worth a cut of its own.
  static let minSilence = 0.05

  // MARK: The transition's clock

  /// Where B is, in its own seconds, `t` into the transition: B plays at `bRate`.
  public static func bTimeAt(_ plan: TransitionPlan, _ t: Double) -> Double {
    plan.bStart + plan.bRate.integral(from: 0, to: t)
  }

  public enum Song: String, Sendable, Equatable, Codable { case a, b }

  /// The song to show `t` into the transition, and where in it: A until the switch, then B.
  public static func songTimeDuring(_ plan: TransitionPlan, _ t: Double) -> (song: Song, time: Double) {
    t < plan.switchAt ? (.a, plan.aStart + t) : (.b, bTimeAt(plan, t))
  }

  /// The point of the transition that shows B at `bTime`; nil outside the part that shows B.
  public static func transitionTimeFor(_ plan: TransitionPlan, _ bTime: Double) -> Double? {
    var low = plan.switchAt, high = plan.length
    guard bTime >= bTimeAt(plan, low), bTime < bTimeAt(plan, high) else { return nil }
    for _ in 0..<60 {
      let mid = (low + high) / 2
      if bTimeAt(plan, mid) <= bTime { low = mid } else { high = mid }
    }
    return low
  }

  /// How loud to play a transition file whose songs were made at other levels than they play at: `gainA` and `gainB`
  /// (linear) are what each song's own playback adds to what the file holds. Each counts as much as that song is heard:
  /// A's at the start, B's at the end, blended in decibels between (`bridgeGain`).
  public static func bridgeGain(_ plan: TransitionPlan, _ t: Double, gainA: Double, gainB: Double) -> Double {
    let a = pow(plan.aGain.value(at: t), 2), b = pow(plan.bGain.value(at: t), 2)
    let share = a + b > 0 ? b / (a + b) : (t < plan.switchAt ? 0 : 1)
    return pow(gainA, 1 - share) * pow(gainB, share)
  }

  // MARK: Cuts

  /// The cut from A into B on the beat (`beatCut`), or nil to play them the usual way: mixing off, songs of one album
  /// in order, no steady beat in either, or no downbeat late enough in A.
  public static func beatCut(_ a: MixMapEntry, _ b: MixMapEntry, aDuration: Double, mode: MixMode, sameAlbumInOrder: Bool) -> BeatCut? {
    guard mode != .off, !sameAlbumInOrder, steadyBeat(a), steadyBeat(b) else { return nil }
    let aOrigin = firstDownbeat(a), aLine = lineLength(a)
    let soundEnd = Swift.min(finiteOr(a.soundEnd, aDuration), aDuration)
    let aEnd = aOrigin + ((soundEnd - aOrigin) / aLine + 1e-9).rounded(.down) * aLine
    let earliest = Swift.max(aDuration - longestCut, finiteOr(a.cues?.mixOut ?? a.outroStart, 0))
    guard aEnd >= earliest, aEnd > 0 else { return nil }
    let bOrigin = Swift.max(0, firstDownbeat(b)), bLine = lineLength(b), bar = 4 * beatLength(b)
    let intoIntro = finiteOr(b.cues?.mixIn ?? b.introEnd, 0) - bar
    var bStart = bOrigin
    if intoIntro - bOrigin > longIntroBars * bar { bStart = bOrigin + ((intoIntro - bOrigin) / bLine - 1e-9).rounded(.up) * bLine }
    if bStart >= finiteOr(b.cues?.mixOut ?? b.outroStart, b.duration) { bStart = bOrigin }
    return bStart < b.duration ? BeatCut(aEnd: aEnd, bStart: bStart) : nil
  }

  /// DJ mix with no beat to cut on: the silence between the songs goes (`silenceCut`). Nil within an album played in
  /// order, with mixing off, or with no silence worth cutting.
  public static func silenceCut(_ a: MixMapEntry, _ b: MixMapEntry, aDuration: Double, mode: MixMode, sameAlbumInOrder: Bool) -> BeatCut? {
    guard mode != .off, !sameAlbumInOrder else { return nil }
    let aEnd = Swift.min(finiteOr(a.soundEnd, aDuration), aDuration)
    let bStart = Swift.max(0, Swift.min(finiteOr(b.soundStart ?? 0, 0), finiteOr(b.soundEnd, b.duration)))
    guard aEnd > 0, !(aDuration - aEnd < minSilence && bStart < minSilence) else { return nil }
    return BeatCut(aEnd: aEnd, bStart: bStart)
  }

  /// The server's "straight on" as a cut (`straightCut`); nil when that's A's end and B's start anyway.
  public static func straightCut(_ plan: TransitionPlan, aDuration: Double) -> BeatCut? {
    let aEnd = Swift.min(finiteOr(plan.aStart, aDuration), aDuration)
    let bStart = Swift.max(0, finiteOr(plan.bStart, 0))
    if aDuration - aEnd < minSilence && bStart < minSilence { return nil }
    return aEnd > 0 ? BeatCut(aEnd: aEnd, bStart: bStart) : nil
  }

  // MARK: The grid

  static func beatLength(_ song: MixMapEntry) -> Double { 60 / song.bpm }
  static func steadyBeat(_ song: MixMapEntry) -> Bool {
    song.bpm.isFinite && song.bpm > 0 && song.beatConfidence >= steadyBeatConfidence && song.firstBeat.isFinite && song.downbeatOffset.isFinite
  }
  static func firstDownbeat(_ song: MixMapEntry) -> Double { song.firstBeat + song.downbeatOffset * beatLength(song) }
  /// Bars, or beats where the bar starts are unsure (no confidence at all counts as sure).
  static func lineLength(_ song: MixMapEntry) -> Double {
    ((song.downbeatConfidence ?? 1) >= minDownbeatConfidence ? 4 : 1) * beatLength(song)
  }
  static func finiteOr(_ value: Double, _ fallback: Double) -> Double { value.isFinite ? value : fallback }
}
```

**Step 4: Run them to see them pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter MixRulesTests 2>&1 | tail -1
```

Expected: `Test run with 4 tests in 1 suite passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Automation+Curve.swift \
  apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/MixSequence.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/MixFixtures.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/MixRulesTests.swift
git commit -F - <<'EOF'
Port the web's mix clock, bridge gain and beat cuts to the iOS player

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 3: The skip planner (plan.ts)

The server never plans skips, so the phone does, as `planTransition` with `at` does. A quick mix lands on A's next bar line after a 4-beat lead-in, or a 2-beat one when that lands a bar sooner. With unsure bars it lands on a beat. It stretches B within 2%, else cuts. Without a sure beat it crossfades for 2.5 s, and with no mixing it goes straight on.

**Files:**
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/SkipPlanner.swift`
- Test: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/SkipPlannerTests.swift`
- Modify: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/MixRulesTests.swift`

**Step 1: Write the failing tests**

The skips against the TypeScript's, in `MixRulesTests`:

```bash
cat > /tmp/phase5-task3-mixrules.patch <<'PATCH'
diff --git a/apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/MixRulesTests.swift b/apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/MixRulesTests.swift
--- a/apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/MixRulesTests.swift
+++ b/apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/MixRulesTests.swift
@@ -50,6 +50,14 @@
     }
   }
 
+  @Test func skipsArePlannedAsTheTypeScriptPlansThem() {
+    #expect(fixtures.skips.contains { $0.plan.style == .quick } && fixtures.skips.contains { $0.plan.style == .fade })
+    for s in fixtures.skips {
+      let plan = SkipPlanner.plan(a: fixtures.song(s.a), b: fixtures.song(s.b), mode: s.mode, sameAlbumInOrder: s.sameAlbumInOrder, at: s.at)
+      #expect(close(plan, s.plan), "\(s.a) → \(s.b) at \(s.at): \(plan.reason) vs \(s.plan.reason)")
+    }
+  }
+
   private func same(_ x: BeatCut?, _ y: BeatCut?) -> Bool {
     switch (x, y) {
     case (nil, nil): true
PATCH
git apply /tmp/phase5-task3-mixrules.patch
```

And the rules one by one:

Create `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/SkipPlannerTests.swift`:

```swift
import PlayarrAPI
import Testing
@testable import PlayarrPlayer

/// A press of Next with DJ mix on mixes on the next bar: the arithmetic on A's beat grid.
struct SkipPlannerTests {
  /// 120 BPM (half a second a beat, 2 s a bar), the first downbeat at 0.5 s: bars at 0.5, 2.5, 4.5…
  func song(bpm: Double = 120, firstBeat: Double = 0.5, downbeatOffset: Double = 0, barsSure: Double? = nil, beat: Double = 0.9) -> MixMapEntry {
    MixMapEntry(
      version: 8, duration: 240, bpm: bpm, firstBeat: firstBeat, downbeatOffset: downbeatOffset, downbeatConfidence: barsSure,
      gridStable: true, beatConfidence: beat, introEnd: 32.5, outroStart: 200.5, coldStart: false, coldEnd: false, soundStart: 0,
      soundEnd: 239, phraseEnergy: [])
  }

  @Test func landsOnTheNextBarLineWithAFourBeatLeadIn() {
    // The mix may start from 61.6 s: 4 beats (2 s) on is 63.6, and the next bar line from there is 64.5.
    let plan = SkipPlanner.plan(a: song(), b: song(bpm: 121), mode: .auto, at: 61.6)
    #expect(plan.style == .quick)
    #expect(plan.beats == 4)
    #expect(abs(plan.aStart - 62.5) < 1e-9)
    #expect(abs(plan.aStart + plan.beats * 0.5 - 64.5) < 1e-9)
    // From 60.4, 4 beats on is 62.4: bar 62.5. Two beats would land there too, so the lead-in stays 4 beats.
    #expect(SkipPlanner.plan(a: song(), b: song(bpm: 121), mode: .auto, at: 60.4).beats == 4)
  }

  @Test func takesATwoBeatLeadInWhenThatLandsABarSooner() {
    // From 61.3, 4 beats on is 63.3 (bar 64.5), but 2 beats on is 62.3: bar 62.5, a bar sooner.
    let plan = SkipPlanner.plan(a: song(), b: song(bpm: 121), mode: .auto, at: 61.3)
    #expect(plan.beats == 2)
    #expect(abs(plan.aStart - 61.5) < 1e-9)
  }

  @Test func landsOnABeatWhenTheBarsAreUnsure() {
    let plan = SkipPlanner.plan(a: song(barsSure: 0.2), b: song(bpm: 121), mode: .auto, at: 61.3)
    // Beats every 0.5 s from 0.5: 4 beats from 61.3 is 63.3, the next beat 63.5.
    #expect(abs(plan.aStart + plan.beats * 0.5 - 63.5) < 1e-9)
  }

  @Test func stretchesBOnlyWithinTwoPercentAndElseCuts() {
    let near = SkipPlanner.plan(a: song(), b: song(bpm: 121), mode: .auto, at: 61.3)
    #expect(near.bRate.contains { abs($0.value - 120.0 / 121.0) < 1e-9 })
    #expect(near.bRate.last?.value == 1)
    let far = SkipPlanner.plan(a: song(), b: song(bpm: 128), mode: .auto, at: 61.3)
    #expect(far.bRate == [AutomationItem(at: 0, value: 1)])
    #expect(far.bGain.contains { $0.at == far.switchAt && $0.value == 0 })
  }

  @Test func withoutASureBeatItCrossfadesForTwoAndAHalfSecondsAndNoMixingGoesStraightOn() {
    let fade = SkipPlanner.plan(a: song(beat: 0.3), b: song(), mode: .auto, at: 61.3)
    #expect(fade.style == .fade)
    #expect(fade.length == 2.5)
    #expect(fade.aStart == 61.3)
    let off = SkipPlanner.plan(a: song(), b: song(), mode: .off, at: 61.3)
    #expect(off.style == .straight)
    #expect(off.aStart == 61.3)
    #expect(off.bStart == 0)
  }
}
```

**Step 2: Run them to see them fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter 'SkipPlannerTests|MixRulesTests' 2>&1 | grep -m1 -E '\.swift:[0-9]+:[0-9]+: .*error'
```

Expected: `…/MixRulesTests.swift:…: error: cannot find 'SkipPlanner' in scope`.

**Step 3: Implement**

`jsRound` is `Math.round` (halves up, also below zero); the grid helpers are `plan.ts`'s.

Create `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/SkipPlanner.swift`:

```swift
import Foundation
import PlayarrAPI

/// The plan for a press of Next mixed live (`skipPlan` in packages/mix/src/plan.ts, with the parts of the planner it
/// uses): leave A as soon as possible from `at`, mid-song if need be. Both beats sure → a quick mix landing on a bar line
/// of A with a 4-beat lead-in (2 when that lands a bar sooner), so the cut comes under 6 beats after `at`; otherwise a
/// 2.5 s crossfade, or straight on into an abrupt start. "No mixing" still means straight on. The server never plans
/// skips, so the app plans them itself; `mix-fixtures.mjs` checks this port against the TypeScript.
public enum SkipPlanner {
  static let quickMixConfidence = 0.5
  static let sameTempoDrift = 0.002
  static let quickMixStretchGap = 0.02
  static let longestBlendBeats = 64.0
  static let quickCrossfadeBeats = 2.0
  static let cutTailBeats = 1.0
  static let cutSeconds = 0.02
  static let skipFade = 2.5
  static let skipLeadBeats = [4.0, 2.0]
  static let shortestFade = 1.0
  static let ownTempoHold = 0.1
  static let ownTempoRamp = 0.2
  static let curvePoints = 8
  static let phraseBeats = 16.0
  static let barBeats = 4.0
  static let highPassOffHz = 20.0
  static let highPassSweepHz = 800.0
  static let epsilon = 1e-9

  /// `sameAlbumInOrder`: B follows A on its album; a skip mixes them anyway, but straight on then keeps B's start.
  public static func plan(a: MixMapEntry, b: MixMapEntry, mode: MixMode, sameAlbumInOrder: Bool = false, at requested: Double) -> TransitionPlan {
    let pair = Pair(a: a, b: b, mode: mode, sameAlbumInOrder: sameAlbumInOrder)
    guard requested.isFinite else { return straight(pair, "Skipped, but with no time to leave at: straight on") }
    let at = min(max(0, requested), duration(a))
    func leaving(_ plan: TransitionPlan) -> TransitionPlan {
      var plan = plan
      if plan.style == .straight { plan.aStart = at }
      return plan
    }
    if mode == .off { return leaving(straight(pair, "Skipped, no mixing: straight on")) }
    let sureBeat = { (song: MixMapEntry) in usableTempo(song) && song.beatConfidence >= quickMixConfidence }
    guard sureBeat(a), sureBeat(b) else {
      if b.coldStart { return leaving(straight(pair, "Skipped, no sure beat and an abrupt start: straight on")) }
      var plan = fade(pair, "Skipped, no sure beat: crossfade", from: at, longest: skipFade)
      if plan.style == .straight { plan.reason = "Skipped; \(plan.reason)" }
      return leaving(plan)
    }
    var plan = quick(pair, "Skipped: quick mix", at: at)
    if plan.style == .straight { plan.reason = "Skipped; \(plan.reason)" }
    return leaving(plan)
  }

  // MARK: The pair

  struct Pair {
    let a: MixMapEntry
    let b: MixMapEntry
    let mode: MixMode
    let sameAlbumInOrder: Bool
    let ratio: Double
    let tempoGap: Double
    let aBarsSure: Bool
    let bBarsSure: Bool

    init(a: MixMapEntry, b: MixMapEntry, mode: MixMode, sameAlbumInOrder: Bool) {
      self.a = a
      self.b = b
      self.mode = mode
      self.sameAlbumInOrder = sameAlbumInOrder
      let tempos = usableTempo(a) && usableTempo(b)
      let matched = tempos ? tempoRatio(a.bpm, b.bpm) : 1
      ratio = abs(matched - 1) * longestBlendBeats * (tempos ? beatLength(a) : 0) < sameTempoDrift ? 1 : matched
      tempoGap = abs(ratio - 1)
      aBarsSure = (a.downbeatConfidence ?? 1) >= MixSequence.minDownbeatConfidence
      bBarsSure = (b.downbeatConfidence ?? 1) >= MixSequence.minDownbeatConfidence
    }
  }

  /// B's rate that matches A: a.bpm / b.bpm, doubled or halved when that's closer to 1.
  static func tempoRatio(_ aBpm: Double, _ bBpm: Double) -> Double {
    let plain = aBpm / bBpm
    return [plain, plain * 2, plain / 2].reduce(plain) { abs($1 - 1) < abs($0 - 1) ? $1 : $0 }
  }

  // MARK: The plans

  static func quick(_ pair: Pair, _ reason: String, at: Double) -> TransitionPlan {
    let a = pair.a, b = pair.b
    guard usableTempo(a), usableTempo(b) else { return straight(pair, "No usable beat: straight on") }
    let stretched = pair.tempoGap <= quickMixStretchGap + epsilon
    let tailBeats = stretched ? 0 : cutTailBeats
    guard let placement = skipPlacement(pair, tailBeats: tailBeats, at: at) else {
      return straight(pair, "Too close to the end to mix: straight on")
    }
    let beat = beatLength(a)
    let landingAt = placement.beats * beat
    let rate = stretched ? pair.ratio : 1
    let leadInB = landingAt * rate
    let tailInB = tailBeats * beat * rate
    let holdOvershoot = max(0, (ownTempoRamp / 2 + ownTempoHold) * (1 - rate))
    let latestLanding = resumeLimit(b) - tailInB - holdOvershoot
    let target = mixInPoint(b)
    let bar = pair.bBarsSure ? barBeats : 1
    let phraseLanding = nearestLine(b, pair.bBarsSure ? phraseBeats : 1, target, notBefore: leadInB)
    var landing = abs(phraseLanding - target) <= (phraseBeats / 2) * beatLength(b) ? phraseLanding : nearestLine(b, bar, target, notBefore: leadInB)
    if landing > latestLanding + epsilon {
      guard let earlier = lastLineAtOrBefore(b, bar, latestLanding), earlier >= leadInB - epsilon else {
        return straight(pair, "B’s outro comes too soon to mix: straight on")
      }
      landing = earlier
    }
    guard landing < soundEnd(b) else { return straight(pair, "B is too short to mix into: straight on") }
    let bStart = max(0, landing - leadInB)
    let length = landingAt + tailBeats * beat
    let bRate = steadyRate(rate, length)
    var plan = TransitionPlan(
      style: .quick, aStart: placement.aStart, bStart: bStart, length: length,
      bResume: bStart + bRate.integral(from: 0, to: length), switchAt: landingAt, bRate: bRate,
      aGain: [], bGain: [], aLowDb: flatDb, bLowDb: flatDb, aHighPassHz: highPassSweep(0, landingAt), reason: reason,
      beats: placement.beats)
    if stretched {
      let crossfade = landingAt - quickCrossfadeBeats * beat
      plan.switchAt = crossfade
      plan.aGain = [AutomationItem(at: 0, value: 1)] + equalPower(crossfade, landingAt, fadingIn: false)
      plan.bGain = [AutomationItem(at: 0, value: 0)] + equalPower(crossfade, landingAt, fadingIn: true)
    } else {
      plan.aGain = [AutomationItem(at: 0, value: 1)] + equalPower(landingAt, length, fadingIn: false)
      plan.bGain = [
        AutomationItem(at: 0, value: 0), AutomationItem(at: landingAt, value: 0), AutomationItem(at: landingAt + cutSeconds, value: 1),
      ]
    }
    return plan
  }

  /// The landing is a bar line of A (a beat with unsure bars) with the whole lead-in at or after `at`.
  static func skipPlacement(_ pair: Pair, tailBeats: Double, at: Double) -> (aStart: Double, beats: Double)? {
    let a = pair.a
    let beat = beatLength(a)
    let line = pair.aBarsSure ? barBeats : 1
    var best: (aStart: Double, beats: Double, landing: Double)?
    for beats in skipLeadBeats {
      let landing = firstLineAtOrAfter(a, line, at + beats * beat)
      let sooner = best == nil || (pair.aBarsSure && landing < (best?.landing ?? 0) - epsilon)
      if sooner { best = (landing - beats * beat, beats, landing) }
    }
    guard let best, best.landing <= soundEnd(a) - tailBeats * beat + epsilon else { return nil }
    return (best.aStart, best.beats)
  }

  static func fade(_ pair: Pair, _ reason: String, from: Double, longest: Double) -> TransitionPlan {
    let a = pair.a, b = pair.b
    let end = soundEnd(a)
    let roomInA = end - from
    let bStart = soundStart(b)
    let roomInB = resumeLimit(b) - bStart
    guard roomInA >= shortestFade else { return straight(pair, "Too close to the end to fade: straight on") }
    guard roomInB >= shortestFade else { return straight(pair, "B’s outro comes too soon to mix: straight on") }
    let length = min(longest, roomInA, roomInB)
    return TransitionPlan(
      style: .fade, aStart: from, bStart: bStart, length: length, bResume: bStart + length, switchAt: length / 2,
      bRate: [AutomationItem(at: 0, value: 1)], aGain: equalPower(0, length, fadingIn: false), bGain: equalPower(0, length, fadingIn: true),
      aLowDb: flatDb, bLowDb: flatDb, aHighPassHz: highPassOff, reason: reason, beats: 0)
  }

  static func straight(_ pair: Pair, _ reason: String) -> TransitionPlan {
    let asRecorded = pair.mode == .off || pair.sameAlbumInOrder
    let bStart = asRecorded ? 0 : soundStart(pair.b)
    return TransitionPlan(
      style: .straight, aStart: asRecorded ? duration(pair.a) : soundEnd(pair.a), bStart: bStart, length: 0, bResume: bStart,
      switchAt: 0, bRate: [AutomationItem(at: 0, value: 1)], aGain: [AutomationItem(at: 0, value: 0)],
      bGain: [AutomationItem(at: 0, value: 1)], aLowDb: flatDb, bLowDb: flatDb, aHighPassHz: highPassOff, reason: reason, beats: 0)
  }

  // MARK: Curves

  static let flatDb = [AutomationItem(at: 0, value: 0)]
  static let highPassOff = [AutomationItem(at: 0, value: highPassOffHz)]

  static func steadyRate(_ rate: Double, _ length: Double) -> Automation {
    if abs(rate - 1) < epsilon { return [AutomationItem(at: 0, value: rate)] }
    let backToOwn = max(0, length - ownTempoHold)
    return [
      AutomationItem(at: 0, value: rate), AutomationItem(at: max(0, backToOwn - ownTempoRamp), value: rate),
      AutomationItem(at: backToOwn, value: 1),
    ]
  }

  static func equalPower(_ from: Double, _ to: Double, fadingIn: Bool) -> Automation {
    sampleCurve(from, to) { fadingIn ? sin($0 * .pi / 2) : cos($0 * .pi / 2) }
  }

  static func highPassSweep(_ from: Double, _ to: Double) -> Automation {
    sampleCurve(from, to) { highPassOffHz * pow(highPassSweepHz / highPassOffHz, $0) }
  }

  static func sampleCurve(_ from: Double, _ to: Double, _ shape: (Double) -> Double) -> Automation {
    (0..<curvePoints).map { i in
      let progress = Double(i) / Double(curvePoints - 1)
      let value = shape(progress)
      let snapped = abs(value - value.rounded()) < epsilon ? value.rounded() : value
      return AutomationItem(at: from + (to - from) * progress, value: snapped)
    }
  }

  // MARK: The grid and the songs

  static func beatLength(_ song: MixMapEntry) -> Double { 60 / song.bpm }
  static func usableTempo(_ song: MixMapEntry) -> Bool {
    song.bpm.isFinite && song.bpm > 0 && song.firstBeat.isFinite && song.downbeatOffset.isFinite
  }
  static func gridLine(_ song: MixMapEntry, _ beatsPerLine: Double, _ index: Double) -> Double {
    song.firstBeat + (song.downbeatOffset + index * beatsPerLine) * beatLength(song)
  }
  static func linesAt(_ song: MixMapEntry, _ beatsPerLine: Double, _ t: Double) -> Double {
    (t - gridLine(song, beatsPerLine, 0)) / (beatsPerLine * beatLength(song))
  }
  static func firstLineAtOrAfter(_ song: MixMapEntry, _ beatsPerLine: Double, _ t: Double) -> Double {
    gridLine(song, beatsPerLine, max(0, (linesAt(song, beatsPerLine, t) - epsilon).rounded(.up)))
  }
  static func lastLineAtOrBefore(_ song: MixMapEntry, _ beatsPerLine: Double, _ t: Double) -> Double? {
    let index = (linesAt(song, beatsPerLine, t) + epsilon).rounded(.down)
    return index < 0 ? nil : gridLine(song, beatsPerLine, index)
  }
  static func nearestLine(_ song: MixMapEntry, _ beatsPerLine: Double, _ target: Double, notBefore: Double) -> Double {
    let nearest = jsRound(linesAt(song, beatsPerLine, target))
    let earliest = (linesAt(song, beatsPerLine, notBefore) - epsilon).rounded(.up)
    return gridLine(song, beatsPerLine, max(nearest, earliest, 0))
  }
  /// JavaScript's Math.round: halves go up (Swift's `.rounded()` takes -2.5 to -3, Math.round to -2).
  static func jsRound(_ x: Double) -> Double { (x + 0.5).rounded(.down) }

  static func finiteOr(_ value: Double, _ fallback: Double) -> Double { value.isFinite ? value : fallback }
  static func duration(_ song: MixMapEntry) -> Double { max(0, finiteOr(song.duration, 0)) }
  static func soundEnd(_ song: MixMapEntry) -> Double { min(max(finiteOr(song.soundEnd, duration(song)), 0), duration(song)) }
  static func soundStart(_ song: MixMapEntry) -> Double { min(max(finiteOr(song.soundStart ?? 0, 0), 0), soundEnd(song)) }
  static func mixInPoint(_ b: MixMapEntry) -> Double { finiteOr(b.cues?.mixIn ?? b.introEnd, 0) }
  static func resumeLimit(_ b: MixMapEntry) -> Double { finiteOr(b.cues?.mixOut ?? b.outroStart, soundEnd(b)) }
}
```

**Step 4: Run them to see them pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter 'SkipPlannerTests|MixRulesTests' 2>&1 | tail -1
```

Expected: `Test run with 10 tests in 2 suites passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/SkipPlanner.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/SkipPlannerTests.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/MixRulesTests.swift
git commit -F - <<'EOF'
Plan presses of Next on the phone, as the mix planner plans skips

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 4: Mix maps, polled as the web polls them

`Scheduling` is a clock with timers. `TaskScheduling` uses real tasks; the tests' `ManualScheduling` moves time by hand. `MixMapStore` keeps maps by recording id and follows the rules of key decision 6.

**Files:**
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Scheduling.swift`
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/MixMapStore.swift`
- Create: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/ManualScheduling.swift`
- Test: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/MixMapStoreTests.swift`

**Step 1: Write the failing tests**

Create `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/ManualScheduling.swift`:

```swift
import Foundation
@testable import PlayarrPlayer

/// A clock moved by hand: `advance(by:)` runs what falls due, in order.
@MainActor
final class ManualScheduling: Scheduling {
  private(set) var now = Date(timeIntervalSince1970: 1_000_000)
  private var pending: [(at: Date, order: Int, action: ScheduledAction, run: @MainActor () -> Void)] = []
  private var order = 0

  @discardableResult
  func schedule(after seconds: Double, _ action: @escaping @MainActor () -> Void) -> ScheduledAction {
    let handle = ScheduledAction()
    order += 1
    pending.append((now.addingTimeInterval(seconds), order, handle, action))
    return handle
  }

  func advance(by seconds: Double) {
    let end = now.addingTimeInterval(seconds)
    while let next = pending.filter({ !$0.action.isCancelled && $0.at <= end }).min(by: { ($0.at, $0.order) < ($1.at, $1.order) }) {
      pending.removeAll { $0.order == next.order }
      now = max(now, next.at)
      next.run()
    }
    pending.removeAll { $0.action.isCancelled }
    now = end
  }

  /// Seconds until the next action falls due, if any.
  var nextDue: Double? {
    pending.filter { !$0.action.isCancelled }.map { $0.at.timeIntervalSince(now) }.min()
  }
}
```

Create `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/MixMapStoreTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Synchronization
import Testing
@testable import PlayarrPlayer

@MainActor
struct MixMapStoreTests {
  final class Server: Sendable {
    let asked = Mutex<[[String]]>([])
    let version = Mutex(7)
    func maps(_ ids: [String]) -> [String: MixMapEntry] {
      asked.withLock { $0.append(ids) }
      let v = version.withLock { $0 }
      return Dictionary(uniqueKeysWithValues: ids.filter { $0 != "rec-9" }.map { ($0, Self.map(version: v)) })
    }
    static func map(version: Int) -> MixMapEntry {
      MixMapEntry(
        version: version, duration: 200, bpm: 120, firstBeat: 0.1, downbeatOffset: 0, gridStable: true, beatConfidence: 0.9,
        introEnd: 16, outroStart: 180, coldStart: false, coldEnd: false, soundEnd: 199, phraseEnergy: [0.5, nil, 1])
    }
  }

  let clock = ManualScheduling()
  let server = Server()

  func store() -> MixMapStore {
    let server = self.server
    return MixMapStore(scheduler: clock) { server.maps($0) }
  }

  /// Lets the polls' tasks run.
  func settle() async { for _ in 0..<20 { await Task.yield() } }

  @Test func thePlayerAsksAgainForASongAfterAMinute() async {
    let maps = store()
    await maps.load([song(1), song(2), song(1), nil])
    #expect(server.asked.withLock { $0 } == [["rec-1", "rec-2"]])
    #expect(maps.map("rec-1")?.bpm == 120)
    clock.advance(by: 59)
    await maps.load([song(1)])
    #expect(server.asked.withLock { $0.count } == 1)
    clock.advance(by: 2)
    await maps.load([song(1)])
    #expect(server.asked.withLock { $0.count } == 2)
  }

  @Test func asksForFiftyAtATime() async {
    let maps = store()
    await maps.load((1...120).map { song($0 + 100) })
    #expect(server.asked.withLock { $0.map(\.count) } == [50, 50, 20])
  }

  @Test func whatIsOnScreenIsAskedEveryThirtySecondsTenTimesAtMostWhileNotCurrent() async {
    let maps = store()
    maps.watch(["rec-1", "rec-9"])
    await settle()
    #expect(server.asked.withLock { $0.count } == 1)
    for _ in 0..<20 {
      clock.advance(by: 30)
      await settle()
    }
    #expect(server.asked.withLock { $0.count } == MixMapStore.polls)
  }

  @Test func stopsAskingOnceEveryMapIsCurrent() async {
    let maps = store()
    maps.watch(["rec-1"])
    await settle()
    server.version.withLock { $0 = mixMapVersion }
    clock.advance(by: 30)
    await settle()
    #expect(maps.map("rec-1")?.version == mixMapVersion)
    clock.advance(by: 300)
    await settle()
    #expect(server.asked.withLock { $0.count } == 2)
  }

  @Test func anotherListStartsOverAndForgetAsksAfresh() async {
    let maps = store()
    maps.watch(["rec-1"])
    await settle()
    maps.watch(["rec-1"])
    await settle()
    #expect(server.asked.withLock { $0.count } == 1)
    maps.forget("rec-1")
    await maps.load([song(1)])
    #expect(server.asked.withLock { $0.count } == 2)
  }
}
```

**Step 2: Run them to see them fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter MixMapStoreTests 2>&1 | grep -m1 -E '\.swift:[0-9]+:[0-9]+: .*error'
```

Expected: `…/Support/ManualScheduling.swift:…: error: cannot find type 'ScheduledAction' in scope`.

**Step 3: Implement**

Create `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Scheduling.swift`:

```swift
import Foundation

/// Waits on the wall clock for the player's timers (asking for transitions, polling mix maps), so tests can move the
/// clock by hand (`ManualScheduling` in the tests) instead of sleeping.
@MainActor
public protocol Scheduling: AnyObject {
  var now: Date { get }
  /// Runs `action` after `seconds`, unless cancelled first.
  @discardableResult func schedule(after seconds: Double, _ action: @escaping @MainActor () -> Void) -> ScheduledAction
}

/// A pending action of a `Scheduling`.
@MainActor
public final class ScheduledAction {
  public private(set) var isCancelled = false
  private let onCancel: () -> Void

  public init(onCancel: @escaping () -> Void = {}) { self.onCancel = onCancel }

  public func cancel() {
    guard !isCancelled else { return }
    isCancelled = true
    onCancel()
  }
}

/// The real clock: a task that sleeps.
@MainActor
public final class TaskScheduling: Scheduling {
  public init() {}

  public var now: Date { Date() }

  @discardableResult
  public func schedule(after seconds: Double, _ action: @escaping @MainActor () -> Void) -> ScheduledAction {
    let task = Task { @MainActor in
      try? await Task.sleep(for: .seconds(max(0, seconds)))
      guard !Task.isCancelled else { return }
      action()
    }
    return ScheduledAction { task.cancel() }
  }
}
```

Create `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/MixMapStore.swift`:

```swift
import Foundation
import Observation
import PlayarrAPI

/// Songs' mix maps (`POST /api/mix-maps`, with any cue points set by hand), for cuts on the beat, the transition sheet,
/// Stats for nerds and a press of Next mixed live. As the web: the player asks again for a song after a minute
/// (`player/mixMaps.ts`); what's on screen is asked again every 30 s, ten times at most, while a song has no map yet or
/// one from an older analysis (`mixMapsQuery` in lib/queries.ts), since the server measures those meanwhile.
@MainActor @Observable
public final class MixMapStore {
  public static let fresh: TimeInterval = 60
  public static let pollInterval: TimeInterval = 30
  public static let polls = 10
  public static let batchSize = 50

  public private(set) var maps: [String: MixMapEntry] = [:]

  @ObservationIgnored private var askedAt: [String: Date] = [:]
  @ObservationIgnored private var asking: Set<String> = []
  @ObservationIgnored private var watched: [String] = []
  @ObservationIgnored private var fetches = 0
  @ObservationIgnored private var poll: ScheduledAction?
  @ObservationIgnored private let scheduler: any Scheduling
  @ObservationIgnored private let fetch: @Sendable ([String]) async throws -> [String: MixMapEntry]

  public init(scheduler: any Scheduling, fetch: @escaping @Sendable ([String]) async throws -> [String: MixMapEntry]) {
    self.scheduler = scheduler
    self.fetch = fetch
  }

  public func map(_ recordingId: String) -> MixMapEntry? { maps[recordingId] }

  /// Learn these songs' maps unless known within the minute or on their way. The engine never waits for one.
  public func load(_ tracks: [Track?]) async {
    let now = scheduler.now
    var seen = Set<String>()
    let ids = tracks.compactMap { $0?.recordingId }.filter {
      seen.insert($0).inserted && !asking.contains($0) && now.timeIntervalSince(askedAt[$0] ?? .distantPast) > Self.fresh
    }
    await ask(ids, at: now)
  }

  /// The songs on screen (Now Playing's next transition, Stats for nerds): asked now unless fresh, then every 30 s while
  /// one isn't current, ten asks at most. Another list starts over; an empty one stops.
  public func watch(_ recordingIds: [String]) {
    guard recordingIds != watched else { return }
    watched = recordingIds
    fetches = 0
    poll?.cancel()
    poll = nil
    guard !recordingIds.isEmpty else { return }
    Task { await refreshWatched(force: false) }
  }

  /// A song's cue points changed (Edit mix points): its map is asked for afresh.
  public func forget(_ recordingId: String) {
    askedAt[recordingId] = nil
  }

  private func refreshWatched(force: Bool) async {
    let ids = watched
    let now = scheduler.now
    let stale = ids.filter { force || now.timeIntervalSince(askedAt[$0] ?? .distantPast) > Self.fresh }
    if !stale.isEmpty {
      fetches += 1
      await ask(ids, at: now)
    }
    guard ids == watched, fetches < Self.polls, ids.contains(where: { (maps[$0]?.version ?? 0) < mixMapVersion }) else { return }
    poll = scheduler.schedule(after: Self.pollInterval) { [weak self] in
      Task { await self?.refreshWatched(force: true) }
    }
  }

  private func ask(_ ids: [String], at now: Date) async {
    guard !ids.isEmpty else { return }
    for id in ids { asking.insert(id) }
    defer { for id in ids { asking.remove(id) } }
    for start in stride(from: 0, to: ids.count, by: Self.batchSize) {
      let batch = Array(ids[start..<min(start + Self.batchSize, ids.count)])
      // Offline or the server busy: asked again next time; meanwhile the songs follow each other the usual way.
      guard let found = try? await fetch(batch) else { continue }
      for id in batch { askedAt[id] = now }
      maps.merge(found) { _, new in new }
    }
  }
}
```

**Step 4: Run them to see them pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter MixMapStoreTests 2>&1 | tail -1
```

Expected: `Test run with 5 tests in 1 suite passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Scheduling.swift \
  apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/MixMapStore.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/ManualScheduling.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/MixMapStoreTests.swift
git commit -F - <<'EOF'
Keep the songs' mix maps on the phone, asked again until they're current

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 5: The transition planner (transitions.ts)

It asks the server for the transition between the song playing and the next one, with the web's rules (key decision 6), and publishes `upcoming` (the pair and its `Result`: an answer, or `.gaveUp`). The Player tells it the pair (`update(wanted:playing:)`) and the clock (`clock(_:seeked:)`), four times a second. `kept` is phase 7's hook for transitions kept with downloads.

**Files:**
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/TransitionPlanner.swift`
- Test: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/TransitionPlannerTests.swift`

**Step 1: Write the failing tests**

The tests tick a quarter second at a time (a binary fraction, so times add up exactly) and wait for each ask in flight.

Create `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/TransitionPlannerTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Synchronization
import Testing
@testable import PlayarrPlayer

/// The asking and polling rules of apps/web/src/player/transitions.ts, on a clock moved by hand.
@MainActor
struct TransitionPlannerTests {
  /// The server: answers in turn (the last one repeats), every request kept.
  final class Server: Sendable {
    let requests = Mutex<[TransitionRequest]>([])
    let answers = Mutex<[Swift.Result<TransitionAnswer, APIError>]>([])
    func answer(_ request: TransitionRequest) throws -> TransitionAnswer {
      requests.withLock { $0.append(request) }
      let next = answers.withLock { a in a.count > 1 ? a.removeFirst() : a.first }
      return try (next ?? .success(.unavailable(.init(reason: "No mix map yet")))).get()
    }
    var asked: Int { requests.withLock { $0.count } }
  }

  static func plan(aStart: Double) -> TransitionPlan {
    TransitionPlan(
      style: .long, aStart: aStart, bStart: 16, length: 30, bResume: 46, switchAt: 16, bRate: [.init(at: 0, value: 1)],
      aGain: [.init(at: 0, value: 1)], bGain: [.init(at: 0, value: 0)], aLowDb: [.init(at: 0, value: 0)], bLowDb: [.init(at: 0, value: 0)],
      aHighPassHz: [.init(at: 0, value: 20)], reason: "Same tempo, keys compatible: 64-beat blend", beats: 64)
  }
  static let pending = TransitionAnswer.pending(.init(plan: plan(aStart: 180), render: RenderProgress(step: .mixing, done: 0.43)))
  static let ready = TransitionAnswer.ready(.init(plan: plan(aStart: 180), url: "/transitions/abc.flac", lead: 3, levels: .init(a: -3, b: 1.5)))

  let clock = ManualScheduling()
  let server = Server()
  let pair = TransitionPlanner.Pair(from: song(1, duration: 240), to: song(2, albumId: 2), mode: .auto, fade: 6, albumQueue: false, levels: nil)

  func planner(playing: @escaping @MainActor () -> Bool = { true }, online: @escaping @MainActor () -> Bool = { true }) -> TransitionPlanner {
    let server = self.server
    let planner = TransitionPlanner(scheduler: clock) { try server.answer($0) }
    planner.isPlaying = playing
    planner.isOnline = online
    return planner
  }

  /// Plays `seconds` from `from`, ticking every quarter second (a whole number of binary fractions, so the times
  /// add up exactly), letting each ask finish.
  func play(_ planner: TransitionPlanner, from: Double, for seconds: Double) async {
    var t = from
    for _ in 0..<Int((seconds * 4).rounded()) {
      clock.advance(by: 0.25)
      t += 0.25
      planner.clock(t, seeked: false)
      await planner.inFlight?.value
    }
  }

  /// The pair wanted from the song's start, its clock at 0 (the Player's tick right after a load).
  func begin(_ planner: TransitionPlanner, _ pair: TransitionPlanner.Pair? = nil, restart: Int = 0) {
    planner.update(wanted: pair ?? self.pair, playing: (1, restart))
    planner.clock(0, seeked: false)
  }

  func jump(_ planner: TransitionPlanner, to time: Double) async {
    clock.advance(by: 0.25)
    planner.clock(time, seeked: true)
    await planner.inFlight?.value
  }

  @Test func asksOnceTheSongHasPlayedFiveSecondsAndTwoAfterThePairSettles() async {
    let planner = planner()
    begin(planner)
    #expect(planner.upcoming == .init(fromFileId: 1, toFileId: 2, result: nil))
    await play(planner, from: 0, for: 4.75)
    #expect(server.asked == 0)
    await play(planner, from: 4.75, for: 0.25)
    #expect(server.asked == 1)
    let sent = server.requests.withLock { $0[0] }
    #expect(sent == TransitionRequest(from: 1, to: 2, mode: .auto, position: 5, fromFileId: 1, toFileId: 2, fade: 6, albumQueue: false))
  }

  @Test func aSeekDoesNotCountAsListening() async {
    let planner = planner()
    begin(planner)
    await jump(planner, to: 60)
    await play(planner, from: 60, for: 3)
    #expect(server.asked == 0)
    await play(planner, from: 63, for: 2)
    #expect(server.asked == 1)
  }

  @Test func pollsEveryThreeSecondsThenEveryTenAndKeepsThePosition() async {
    server.answers.withLock { $0 = [.success(Self.pending)] }
    let planner = planner()
    begin(planner)
    await play(planner, from: 0, for: 5)
    #expect(server.asked == 1)
    #expect(planner.upcoming.result == .answer(Self.pending))
    await play(planner, from: 5, for: 12)  // at 8, 11, 14 and 17
    #expect(server.asked == 5)
    await play(planner, from: 17, for: 9.75)  // five answers "pending": every 10 s from here
    #expect(server.asked == 5)
    await play(planner, from: 26.75, for: 0.25)
    #expect(server.asked == 6)
    #expect(Set(server.requests.withLock { $0.map(\.position) }) == [5])
  }

  @Test func pollsEveryTenSecondsWhilePaused() async {
    server.answers.withLock { $0 = [.success(Self.pending)] }
    let planner = planner(playing: { false })
    begin(planner)
    await play(planner, from: 0, for: 5)
    await play(planner, from: 5, for: 9.75)
    #expect(server.asked == 1)
    await play(planner, from: 14.75, for: 0.25)
    #expect(server.asked == 2)
  }

  @Test func errorsAreTriedAgainAfterThreeSecondsThenTenAndARefusalGivesUp() async {
    server.answers.withLock {
      $0 = [.failure(.server(status: 503, message: "busy")), .failure(.offline), .failure(.server(status: 429, message: "slow down")), .success(Self.ready)]
    }
    let planner = planner()
    begin(planner)
    await play(planner, from: 0, for: 5)
    #expect(server.asked == 1)
    await play(planner, from: 5, for: 3)
    #expect(server.asked == 2)
    await play(planner, from: 8, for: 9.75)
    #expect(server.asked == 2)
    await play(planner, from: 17.75, for: 0.25)
    #expect(server.asked == 3)
    await play(planner, from: 18, for: 10)
    #expect(server.asked == 4)
    #expect(planner.upcoming.result == .answer(Self.ready))
    await play(planner, from: 28, for: 30)
    #expect(server.asked == 4)  // answered for good

    let refusing = Server()
    refusing.answers.withLock { $0 = [.failure(.server(status: 404, message: "Unknown track"))] }
    let other = TransitionPlanner(scheduler: clock) { try refusing.answer($0) }
    other.update(wanted: pair, playing: (1, 0))
    other.clock(0, seeked: false)
    await play(other, from: 0, for: 5)
    #expect(other.upcoming.result == .gaveUp)
  }

  @Test func offlineItWaitsForTheNetwork() async {
    let network = Mutex(false)
    let planner = planner(online: { network.withLock { $0 } })
    begin(planner)
    await play(planner, from: 0, for: 8)
    #expect(server.asked == 0)
    network.withLock { $0 = true }
    planner.networkChanged()
    await planner.inFlight?.value
    #expect(server.asked == 1)
  }

  @Test func unavailableIsAskedOnceMoreAfterAMinute() async {
    let planner = planner()
    begin(planner)
    await play(planner, from: 0, for: 5)
    await play(planner, from: 5, for: 59.75)
    #expect(server.asked == 1)
    await play(planner, from: 64.75, for: 0.25)
    #expect(server.asked == 2)
    await play(planner, from: 65, for: 100)
    #expect(server.asked == 2)
  }

  @Test func givesUpTwentySecondsBeforeTheMixPointAndARestartAsksAgain() async {
    server.answers.withLock { $0 = [.success(Self.pending)] }
    let planner = planner()
    begin(planner)
    await jump(planner, to: 150)
    await play(planner, from: 150, for: 9.75)
    #expect(planner.upcoming.result == .answer(Self.pending))
    await play(planner, from: 159.75, for: 0.25)  // 160 = aStart − 20
    #expect(planner.upcoming.result == .gaveUp)
    let asked = server.asked
    await play(planner, from: 160, for: 20)
    #expect(server.asked == asked)
    // Back to the start (a restart): there's time again, so it's asked afresh, from where it is then.
    planner.update(wanted: pair, playing: (1, 1))
    await jump(planner, to: 0)
    #expect(planner.upcoming.result == nil)
    await play(planner, from: 0, for: 5)
    #expect(server.asked == asked + 1)
    #expect(server.requests.withLock { $0.last?.position } == 5)
  }

  @Test func aSeekPastAReadyMixPointAsksAfreshFromThere() async {
    server.answers.withLock { $0 = [.success(Self.ready), .success(Self.pending)] }
    let planner = planner()
    begin(planner)
    await play(planner, from: 0, for: 5)
    #expect(planner.upcoming.result == .answer(Self.ready))
    clock.advance(by: 0.25)
    planner.clock(179.5, seeked: true)
    #expect(planner.upcoming.result == nil)
    await planner.inFlight?.value
    #expect(server.requests.withLock { $0.last?.position } == 179.5)
    #expect(planner.upcoming.result == .gaveUp)  // too close to its mix point to be made in time
  }

  @Test func aLevelLearnedIsAnotherPair() async {
    server.answers.withLock { $0 = [.success(Self.ready)] }
    let planner = planner()
    begin(planner)
    await play(planner, from: 0, for: 5)
    #expect(server.asked == 1)
    var levelled = pair
    levelled.levels = .init(a: 0, b: -4.5)
    planner.update(wanted: levelled, playing: (1, 0))
    #expect(planner.upcoming.result == nil)
    await play(planner, from: 5, for: 2)
    #expect(server.asked == 2)
    #expect(server.requests.withLock { $0.last?.levels } == .init(a: 0, b: -4.5))
  }

  @Test func noPairNoAsking() async {
    let planner = planner()
    planner.update(wanted: nil, playing: (1, 0))
    planner.clock(0, seeked: false)
    await play(planner, from: 0, for: 30)
    #expect(server.asked == 0)
    #expect(planner.upcoming == .init())
  }
}
```

**Step 2: Run them to see them fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter TransitionPlannerTests 2>&1 | grep -m1 -E '\.swift:[0-9]+:[0-9]+: .*error'
```

Expected: `…/TransitionPlannerTests.swift:…: error: cannot find 'TransitionPlanner' in scope`.

**Step 3: Implement**

Create `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/TransitionPlanner.swift`:

```swift
import Foundation
import Observation
import PlayarrAPI

/// Asks the server for the DJ transition from the song playing into the next while it plays, so it's rendered by the
/// time it's needed: `watchUpcomingTransition` in apps/web/src/player/transitions.ts, rule for rule.
///
/// - Only once the song has played 5 s (skipping through songs renders nothing), and 2 s after the pair settles.
/// - While the server renders: asked again every 3 s, after 5 polls (or while paused) every 10 s.
/// - A lost connection, 429 or a server error: again after 3 s, then every 10 s. Offline: when the network is back.
/// - "Unavailable" is asked once more after 60 s (the songs' analysis may have finished meanwhile).
/// - Not ready 20 s before the mix point: given up, and the songs follow each other the usual way.
/// - The position sent is the one at the first ask, unchanged after: the plan (and its render) depends on it. A seek
///   that leaves the answer behind (past a ready mix point, or too close to a pending one) asks afresh from there.
@MainActor @Observable
public final class TransitionPlanner {
  public static let minPlayed = 5.0
  public static let firstAskDelay = 2.0
  public static let pollInterval = 3.0
  public static let slowPollInterval = 10.0
  public static let fastPolls = 5
  public static let retryIntervals = [3.0, 10.0]
  public static let unavailableRetry = 60.0
  public static let giveUp = 20.0
  /// A ready transition survives a seek that lands at least this long before its mix point.
  public static let readyLead = 1.0
  /// After giving up, a jump back this far before the cut-off (a restart) is worth asking again.
  public static let restartMargin = 10.0

  /// What's known of the transition into the next song: the server's answer, or "gave up".
  public enum Result: Sendable, Equatable {
    case answer(TransitionAnswer)
    case gaveUp

    public var plan: TransitionPlan? {
      switch self {
      case .answer(.ready(let r)): r.plan
      case .answer(.pending(let p)): p.plan
      case .answer(.straight(let s)): s.plan
      default: nil
      }
    }
  }

  /// The pair asked about (by file, as the decks know them) and what's known of it. Nil files: no transition wanted.
  public struct Upcoming: Sendable, Equatable {
    public var fromFileId: Int?
    public var toFileId: Int?
    public var result: Result?
    public init(fromFileId: Int? = nil, toFileId: Int? = nil, result: Result? = nil) {
      self.fromFileId = fromFileId
      self.toFileId = toFileId
      self.result = result
    }
  }

  /// A pair the player wants mixed, with everything the server plans and renders it from. Another value is another pair.
  public struct Pair: Sendable, Equatable {
    public var from: Track
    public var to: Track
    public var mode: MixMode
    /// The listener's fade length, for songs that can't be mixed on the beat.
    public var fade: Double
    /// The queue plays the songs' album: songs of one album in order go straight on.
    public var albumQueue: Bool
    /// The gains (dB) the phone plays the two songs at: the transition is made at them.
    public var levels: TransitionAnswer.Ready.Levels?
    public init(from: Track, to: Track, mode: MixMode, fade: Double, albumQueue: Bool, levels: TransitionAnswer.Ready.Levels?) {
      self.from = from
      self.to = to
      self.mode = mode
      self.fade = fade
      self.albumQueue = albumQueue
      self.levels = levels
    }
  }

  public private(set) var upcoming = Upcoming()

  /// Told whenever `upcoming` changes (the coordinator downloads a ready file, the Player picks the join again).
  @ObservationIgnored public var onChange: (@MainActor () -> Void)?

  /// Phase 7: a transition kept with a download, played instead of asking (offline, a Party queue takes Auto's).
  @ObservationIgnored public var kept: (@MainActor (Pair, _ online: Bool) -> TransitionAnswer?)?

  private enum Ended { case answered, late, refused }

  private final class Asking {
    let pair: Pair
    var position: Double?
    var asks = 0
    var asking = false
    var timer: ScheduledAction?
    var aStart: Double?
    var polls = 0
    var errors = 0
    var askedAgainUnavailable = false
    var ended: Ended?
    init(_ pair: Pair) { self.pair = pair }
  }

  @ObservationIgnored private var pair: Asking?
  @ObservationIgnored private var playingFileId: Int?
  @ObservationIgnored private var restartToken: Int?
  @ObservationIgnored private var played = 0.0
  @ObservationIgnored private var time = 0.0
  @ObservationIgnored private var lastTime: Double?
  @ObservationIgnored private var lastAt: Date
  /// The ask on its way, if one is (tests wait for it).
  @ObservationIgnored private(set) var inFlight: Task<Void, Never>?
  /// Polls slow down while paused (the transition isn't needed soon).
  @ObservationIgnored public var isPlaying: @MainActor () -> Bool = { true }
  /// Offline, nothing is asked: `networkChanged()` asks once it's back.
  @ObservationIgnored public var isOnline: @MainActor () -> Bool = { true }
  @ObservationIgnored private let scheduler: any Scheduling
  @ObservationIgnored private let ask: @Sendable (TransitionRequest) async throws -> TransitionAnswer

  public init(scheduler: any Scheduling, ask: @escaping @Sendable (TransitionRequest) async throws -> TransitionAnswer) {
    self.scheduler = scheduler
    self.ask = ask
    lastAt = scheduler.now
  }

  // MARK: What the player tells it

  /// The pair wanted now (nil: none: not DJ mix, mixing off, no next song, the sleep timer ends this song), and the
  /// song playing with its restart token (its listening time starts over when either changes). A different pair
  /// starts over; the same one goes on.
  public func update(wanted: Pair?, playing: (fileId: Int, restartToken: Int)?) {
    if playing?.fileId != playingFileId || playing?.restartToken != restartToken {
      playingFileId = playing?.fileId
      restartToken = playing?.restartToken
      played = 0
      lastTime = nil
    }
    if wanted != pair?.pair {
      drop()
      if let wanted {
        let asking = Asking(wanted)
        pair = asking
        later(asking, Self.firstAskDelay)
      }
      upcoming = Upcoming(fromFileId: wanted?.from.fileId, toFileId: wanted?.to.fileId, result: nil)
      onChange?()
    }
    maybeAsk()
  }

  /// The song's clock (the Player's 10 Hz tick), `seeked` when it jumped.
  public func clock(_ time: Double, seeked: Bool) {
    let now = scheduler.now
    let step = lastTime.map { time - $0 } ?? .nan
    let elapsed = now.timeIntervalSince(lastAt)
    // Listening moves the clock about as fast as time passes; a seek or a new song's reset doesn't.
    let listening = !seeked && step > 0 && step <= elapsed * 1.25 + 0.5
    if listening { played += step }
    self.time = time
    lastTime = time
    lastAt = now
    guard let p = pair else { return }
    if !listening && outOfStep(p, time) {
      startOver(p)
    } else if p.ended == nil && tooLate(p) {
      return giveUp(p, .late)
    }
    maybeAsk()
  }

  /// A song's mix points were edited: if it's in the pair, the pair is asked for afresh (after its short wait).
  public func refresh(recordingId: String) {
    guard let p = pair, p.pair.from.recordingId == recordingId || p.pair.to.recordingId == recordingId else { return }
    let wanted = p.pair
    drop()
    let asking = Asking(wanted)
    pair = asking
    later(asking, Self.firstAskDelay)
    publish(nil)
  }

  /// The network came back (or went): ask if it's time.
  public func networkChanged() { maybeAsk() }

  // MARK: Asking

  private func tooLate(_ p: Asking) -> Bool { time >= (p.aStart ?? p.pair.from.duration) - Self.giveUp }

  private func publish(_ result: Result?) {
    upcoming.result = result
    onChange?()
  }

  private func later(_ p: Asking, _ seconds: Double) {
    p.timer?.cancel()
    p.timer = scheduler.schedule(after: seconds) { [weak self, weak p] in
      guard let p else { return }
      p.timer = nil
      self?.maybeAsk()
    }
  }

  private func drop() {
    pair?.timer?.cancel()
    pair = nil
  }

  private func giveUp(_ p: Asking, _ why: Ended) {
    p.timer?.cancel()
    p.timer = nil
    p.asking = false
    p.ended = why
    publish(.gaveUp)
  }

  private func startOver(_ p: Asking) {
    p.timer?.cancel()
    p.timer = nil
    p.position = nil
    p.aStart = nil
    p.asking = false
    p.ended = nil
    p.polls = 0
    p.errors = 0
    p.asks += 1
    publish(nil)
  }

  private func outOfStep(_ p: Asking, _ time: Double) -> Bool {
    switch upcoming.result {
    case .answer(.ready(let r)) where time >= r.plan.aStart - Self.readyLead: return true
    case .answer(.pending(let r)) where time >= r.plan.aStart - Self.giveUp: return true
    default: return p.ended == .late && time < (p.aStart ?? p.pair.from.duration) - Self.giveUp - Self.restartMargin
    }
  }

  private func maybeAsk() {
    guard let p = pair, p.ended == nil else { return }
    let online = isOnline()
    if let kept = kept?(p.pair, online), case .ready(let r) = kept, !online || time < r.plan.aStart - Self.giveUp {
      p.timer?.cancel()
      p.timer = nil
      p.asking = false
      p.asks += 1
      return answered(p, kept)
    }
    guard !p.asking, p.timer == nil, played >= Self.minPlayed, online else { return }
    if tooLate(p) { return giveUp(p, .late) }
    p.asking = true
    if p.position == nil { p.position = time }
    p.asks += 1
    let ask = p.asks
    let request = TransitionRequest(
      from: p.pair.from.id, to: p.pair.to.id, mode: p.pair.mode, position: p.position, fromFileId: p.pair.from.fileId,
      toFileId: p.pair.to.fileId, fade: p.pair.fade, albumQueue: p.pair.albumQueue, levels: p.pair.levels)
    let send = self.ask
    inFlight = Task { [weak self] in
      let outcome: Swift.Result<TransitionAnswer, any Error>
      do { outcome = .success(try await send(request)) } catch { outcome = .failure(error) }
      // The pair changed, started over or gave up meanwhile: this answer is for nothing now.
      guard let self, self.pair === p, p.asks == ask, p.ended == nil else { return }
      p.asking = false
      switch outcome {
      case .success(let answer):
        p.errors = 0
        self.answered(p, answer)
      case .failure(let error):
        self.failed(p, error)
      }
    }
  }

  private func answered(_ p: Asking, _ answer: TransitionAnswer) {
    switch answer {
    case .pending(let r): p.aStart = r.plan.aStart
    case .ready(let r): p.aStart = r.plan.aStart
    default: break
    }
    if case .pending = answer, tooLate(p) { return giveUp(p, .late) }
    if case .ready = answer, tooLate(p) { return giveUp(p, .late) }
    publish(.answer(answer))
    switch answer {
    case .pending:
      p.polls += 1
      later(p, p.polls >= Self.fastPolls || !isPlaying() ? Self.slowPollInterval : Self.pollInterval)
    case .unavailable where !p.askedAgainUnavailable:
      p.askedAgainUnavailable = true
      later(p, Self.unavailableRetry)
    default:
      p.ended = .answered
    }
  }

  private func failed(_ p: Asking, _ error: any Error) {
    // Offline: asked again when the network is back.
    guard isOnline() else { return }
    let status: Int
    switch error as? APIError {
    case .server(let code, _)?: status = code
    case .unauthorized?: status = 401
    default: status = 0  // a lost connection or an answer that didn't decode: likely to pass
    }
    if status == 0 || status == 429 || status >= 500 {
      later(p, Self.retryIntervals[min(p.errors, Self.retryIntervals.count - 1)])
      p.errors += 1
    } else {
      giveUp(p, .refused)
    }
  }
}
```

**Step 4: Run them to see them pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter TransitionPlannerTests 2>&1 | tail -1
```

Expected: `Test run with 11 tests in 1 suite passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/TransitionPlanner.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/TransitionPlannerTests.swift
git commit -F - <<'EOF'
Ask for DJ transitions from the phone with the web's rules

Five seconds played, then every 3 s while it's made (10 s when paused or after five answers); errors tried again, a
refusal given up, offline waits for the network, given up 20 s before the mix point.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 6: The mix's filters and curves, in the PCM

`MixFilter` ports the renderer's state-variable filters (`packages/mix/src/render/filters.ts`): a 250 Hz low shelf and a high-pass. Their settings follow a curve, updated every 128 samples and smoothed over 512. `DeckAutomation` applies a plan's side (A's or B's: gain curve, shelf, high-pass) to blocks as they're scheduled, at their timeline sample.

**Files:**
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/MixFilter.swift`
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/DeckAutomation.swift`
- Test: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/MixFilterTests.swift`

**Step 1: Write the failing tests**

Create `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/MixFilterTests.swift`:

```swift
import Foundation
import Testing
@testable import PlayarrPlayer

/// The bass swap's shelf and the quick mix's sweep, for mixes the engine plays itself.
struct MixFilterTests {
  func sine(_ hertz: Double, frames: Int) -> [Float] {
    (0..<frames).map { Float(0.5 * sin(2 * .pi * hertz * Double($0) / 44_100)) }
  }

  func rms(_ x: ArraySlice<Float>) -> Double { (x.reduce(0) { $0 + Double($1 * $1) } / Double(x.count)).squareRoot() }

  @Test func neutralLeavesTheSoundAsItIs() {
    var samples = sine(100, frames: 10_000)
    let dry = samples
    MixFilter(.highPass).process(&samples, firstIndex: 0) { _ in 20 }
    MixFilter(.lowShelf).process(&samples, firstIndex: 0) { _ in 0 }
    #expect(samples == dry)
  }

  @Test func theSweepTakesTheBassOutAndLeavesTheTop() {
    var bass = sine(50, frames: 44_100), top = sine(5000, frames: 44_100)
    MixFilter(.highPass).process(&bass, firstIndex: 0) { _ in 800 }
    MixFilter(.highPass).process(&top, firstIndex: 0) { _ in 800 }
    #expect(20 * log10(rms(bass[22_050...]) / rms(sine(50, frames: 44_100)[22_050...])) < -40)
    #expect(abs(20 * log10(rms(top[22_050...]) / rms(sine(5000, frames: 44_100)[22_050...]))) < 0.5)
  }

  @Test func theShelfCutsTheBassByWhatTheCurveSays() {
    var bass = sine(40, frames: 44_100), top = sine(5000, frames: 44_100)
    MixFilter(.lowShelf).process(&bass, firstIndex: 0) { _ in -24 }
    MixFilter(.lowShelf).process(&top, firstIndex: 0) { _ in -24 }
    let cut = 20 * log10(rms(bass[22_050...]) / rms(sine(40, frames: 44_100)[22_050...]))
    #expect(cut < -20 && cut > -25)
    #expect(abs(20 * log10(rms(top[22_050...]) / rms(sine(5000, frames: 44_100)[22_050...]))) < 0.5)
  }

  @Test func blocksOfAnySizeFilterAsOne() {
    let input = sine(80, frames: 30_000)
    var whole = input
    MixFilter(.highPass).process(&whole, firstIndex: 0) { 20 * pow(40, min(1, $0 / 0.5)) }
    let filter = MixFilter(.highPass)
    var pieces: [Float] = []
    var start = 0
    for size in [1000, 333, 22_050, 6617] {
      var piece = Array(input[start..<start + size])
      filter.process(&piece, firstIndex: Int64(start)) { 20 * pow(40, min(1, $0 / 0.5)) }
      pieces += piece
      start += size
    }
    #expect(pieces == whole)
  }
}
```

**Step 2: Run them to see them fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter MixFilterTests 2>&1 | grep -m1 -E '\.swift:[0-9]+:[0-9]+: .*error'
```

Expected: `…/MixFilterTests.swift:…: error: cannot find 'MixFilter' in scope`.

**Step 3: Implement**

Create `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/MixFilter.swift`:

```swift
import Foundation

/// One channel of a DJ move's filter, following an automation curve, for a mix the engine plays itself: the low shelf
/// of the bass swap or the high-pass of the quick-mix sweep. As packages/mix/src/render/filters.ts: the Audio EQ
/// Cookbook's responses in Andrew Simper's trapezoidal state-variable form (whose state stays meaningful when the
/// coefficients change), redesigned every 128 samples from the curve, cross-faded with the dry signal over 512
/// samples when it turns on or off. It runs on blocks as they're scheduled, keeping its state between them.
final class MixFilter {
  enum Kind { case lowShelf, highPass }

  static let block: Int64 = 128
  static let shelfHz = 250.0
  static let highPassOffHz = 20.0
  static let fade = 512
  private static let fadeCurve: [Double] = (0...fade).map { 0.5 - 0.5 * cos(Double.pi * Double($0) / Double(fade)) }
  private static let denormal = 1e-20

  private let kind: Kind
  private var a1 = 0.0, a2 = 0.0, a3 = 0.0, m0 = 1.0, m1 = 0.0, m2 = 0.0
  private var ic1 = 0.0, ic2 = 0.0
  private var wet = 0
  private var active = false
  private var designedFor: Int64 = -1

  init(_ kind: Kind) { self.kind = kind }

  /// Filters `samples` in place; `firstIndex` is the first sample's position counted from the curve's time 0, and
  /// `value(seconds)` the curve. Before time 0 nothing is touched.
  func process(_ samples: inout [Float], firstIndex: Int64, value: (Double) -> Double) {
    for i in samples.indices {
      let n = firstIndex + Int64(i)
      guard n >= 0 else { continue }
      let gridBlock = n / Self.block
      if gridBlock != designedFor {
        designedFor = gridBlock
        design(value(Double(gridBlock * Self.block) / EngineFormat.sampleRate))
      }
      let v0 = Double(samples[i])
      let v3 = v0 - ic2
      let v1 = a1 * ic1 + a2 * v3
      let v2 = ic2 + a2 * ic1 + a3 * v3
      ic1 = 2 * v1 - ic1
      ic2 = 2 * v2 - ic2
      if abs(ic1) < Self.denormal { ic1 = 0 }
      if abs(ic2) < Self.denormal { ic2 = 0 }
      wet = min(Self.fade, max(0, wet + (active ? 1 : -1)))
      guard wet > 0 else { continue }
      let y = m0 * v0 + m1 * v1 + m2 * v2
      samples[i] = Float(v0 + Self.fadeCurve[wet] * (y - v0))
    }
  }

  /// Neutral (a flat shelf, a high-pass at 20 Hz or less) leaves the sound dry; the last active setting is kept while
  /// fading out.
  private func design(_ value: Double) {
    let rate = EngineFormat.sampleRate
    switch kind {
    case .lowShelf:
      active = abs(value) >= 0.01
      guard active || wet == 0 else { return }
      let a = pow(10, value / 40)
      let k = 2.0.squareRoot()
      setIntegrators(g: tan(Double.pi * Self.shelfHz / rate) / a.squareRoot(), k: k)
      (m0, m1, m2) = (1, k * (a - 1), a * a - 1)
    case .highPass:
      active = value > Self.highPassOffHz
      guard active || wet == 0 else { return }
      let k = 2.0.squareRoot()
      setIntegrators(g: tan(Double.pi * min(value, 0.45 * rate) / rate), k: k)
      (m0, m1, m2) = (1, -k, -1)
    }
  }

  private func setIntegrators(g: Double, k: Double) {
    a1 = 1 / (1 + g * (g + k))
    a2 = g * a1
    a3 = g * a2
  }
}
```

Create `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/DeckAutomation.swift`:

```swift
import Foundation
import PlayarrAPI

/// One song's part of a mix the engine plays itself (a fade, a quick mix, a press of Next): the plan's gain curve, and
/// its low shelf and high-pass, applied to the deck's PCM by timeline sample as blocks are scheduled, after the song's
/// own gain. Transition time 0 is timeline sample `start`; past the plan the curves hold their last values.
final class DeckAutomation {
  let start: SampleTime
  let gain: Automation
  let lowShelfDb: Automation
  let highPassHz: Automation
  private let filters: [(MixFilter.Kind, [MixFilter])]

  init(start: SampleTime, gain: Automation, lowShelfDb: Automation, highPassHz: Automation) {
    self.start = start
    self.gain = gain
    self.lowShelfDb = lowShelfDb
    self.highPassHz = highPassHz
    var filters: [(MixFilter.Kind, [MixFilter])] = []
    if lowShelfDb.contains(where: { abs($0.value) >= 0.01 }) { filters.append((.lowShelf, [MixFilter(.lowShelf), MixFilter(.lowShelf)])) }
    if highPassHz.contains(where: { $0.value > MixFilter.highPassOffHz }) { filters.append((.highPass, [MixFilter(.highPass), MixFilter(.highPass)])) }
    self.filters = filters
  }

  /// A's side of `plan` (gain, bass swap, sweep), from timeline sample `start`.
  static func a(_ plan: TransitionPlan, start: SampleTime) -> DeckAutomation {
    DeckAutomation(start: start, gain: plan.aGain, lowShelfDb: plan.aLowDb, highPassHz: plan.aHighPassHz)
  }

  /// B's side (gain, bass swap).
  static func b(_ plan: TransitionPlan, start: SampleTime) -> DeckAutomation {
    DeckAutomation(start: start, gain: plan.bGain, lowShelfDb: plan.bLowDb, highPassHz: [AutomationItem(at: 0, value: MixFilter.highPassOffHz)])
  }

  func apply(to block: inout PCMBlock, at sample: SampleTime) {
    let first = sample - start
    for (kind, channels) in filters {
      let curve = kind == .lowShelf ? lowShelfDb : highPassHz
      channels[0].process(&block.left, firstIndex: first) { curve.value(at: $0) }
      channels[1].process(&block.right, firstIndex: first) { curve.value(at: $0) }
    }
    let gains = (0..<block.frames).map { Float(gain.value(at: Double(first + Int64($0)) / EngineFormat.sampleRate)) }
    block.scale(by: gains)
  }
}
```

**Step 4: Run them to see them pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter MixFilterTests 2>&1 | tail -1
```

Expected: `Test run with 4 tests in 1 suite passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/MixFilter.swift \
  apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/DeckAutomation.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/MixFilterTests.swift
git commit -F - <<'EOF'
Port the renderer's mix filters and apply a plan's curves to a deck's audio

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 7: The pieces of a mix

These are the sources and values the engine's DJ joins are made of. Task 8's engine tests cover them, played through the real graph:

- `TransitionJoin`: a ready answer with its file, lead and tail in frames, and the level corrections.
- `TransitionFileSource`: the file's frames from the cut to the end of the body, turned by the bridge gain.
- `VarispeedSource`: B resampled along the plan's `bRate`, starting where it must so it lands exactly on `bResume`.
- `MixReport`: a changeover, for Stats for nerds: where it was placed, which way, and how far ahead of the playhead its first audio was scheduled.

**Files:**
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/TransitionJoin.swift`
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/TransitionFileSource.swift`
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/VarispeedSource.swift`
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/MixReport.swift`

**Step 1: Write them**

Create `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/TransitionJoin.swift`:

```swift
import Foundation
import PlayarrAPI

/// A transition rendered by the server, downloaded whole to this device, ready to be played between two songs.
///
/// The file is `lead` seconds of A as it is, the transition (`plan.length`), then `tail` seconds of B as it is. Its
/// first sample is A's frame `round(aStart × 44 100) − leadFrames`, and the sample after the transition is B's frame
/// `round(bResume × 44 100)` (packages/mix/src/render/transition.ts), so the engine places it on A's timeline to the
/// sample and changes over inside the lead, where both hold the same sound.
public struct TransitionJoin: Sendable, Equatable {
  public var plan: TransitionPlan
  /// The transition file on this device.
  public var file: URL
  /// Whole samples (the server floors the lead to one).
  public var leadFrames: Int64
  public var tailFrames: Int64
  /// What each song's own playback adds to the level it was made at (dB): the gain the phone plays the song at,
  /// less the level sent with the request (0 when none was). Zero when the transition was made at the levels the
  /// songs play at; otherwise the file is turned by `MixSequence.bridgeGain` so neither changeover jumps.
  public var correctionA: Double
  public var correctionB: Double

  public init(plan: TransitionPlan, file: URL, leadFrames: Int64, tailFrames: Int64, correctionA: Double = 0, correctionB: Double = 0) {
    self.plan = plan
    self.file = file
    self.leadFrames = leadFrames
    self.tailFrames = tailFrames
    self.correctionA = correctionA
    self.correctionB = correctionB
  }

  /// From a ready answer and its downloaded file, for songs playing at `gainA` and `gainB` dB.
  public init(_ ready: TransitionAnswer.Ready, file: URL, gainA: Double, gainB: Double) {
    self.init(
      plan: ready.plan, file: file, leadFrames: EngineFormat.frames(ready.lead ?? 0), tailFrames: EngineFormat.frames(ready.tail ?? 0),
      correctionA: gainA - (ready.levels?.a ?? 0), correctionB: gainB - (ready.levels?.b ?? 0))
  }

  public var lengthFrames: Int64 { EngineFormat.frames(plan.length) }
}
```

Create `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/TransitionFileSource.swift`:

```swift
import Foundation

/// The part of a downloaded transition file the engine plays: frames `from..<to` (from the changeover in its lead to
/// the end of the transition, where B's own playback takes over), turned by the correction for levels it wasn't made
/// at (see `TransitionJoin`).
actor TransitionFileSource: PCMSource {
  private let url: URL
  private let join: TransitionJoin
  private var position: Int64
  private let to: Int64
  private var decoder: FileDecoder?
  private var closed = false

  init(_ join: TransitionJoin, from: Int64, to: Int64) {
    url = join.file
    self.join = join
    position = from
    self.to = to
  }

  func read(maxFrames: Int) async throws -> PCMBlock? {
    guard !closed, position < to else { return nil }
    if decoder == nil { decoder = try FileDecoder(url: url, firstFrame: position) }
    guard let decoder, let decoded = try decoder.decode(maxFrames: Int(min(Int64(maxFrames), to - position))) else { return nil }
    var block = decoded.frames > Int(to - position) ? decoded.slice(0..<Int(to - position)) : decoded
    if join.correctionA != 0 || join.correctionB != 0 {
      let gainA = pow(10, join.correctionA / 20), gainB = pow(10, join.correctionB / 20)
      let first = position - join.leadFrames
      block.scale(by: (0..<block.frames).map {
        Float(MixSequence.bridgeGain(join.plan, Double(first + Int64($0)) / EngineFormat.sampleRate, gainA: gainA, gainB: gainB))
      })
    }
    position += Int64(block.frames)
    return block
  }

  func close() async { closed = true }
}
```

Create `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/VarispeedSource.swift`:

```swift
import Foundation
import PlayarrAPI

/// B played at the plan's rate for a mix the engine plays itself, the way a DJ's pitch fader does it: resampled, so
/// its tempo meets A's (and its pitch moves with it, by at most 2%: the planner stretches a quick mix no further).
/// Then B goes on at its own speed. The rate is followed exactly: output sample n is B's frame
/// `bResume·44 100 − 44 100·∫ rate` from n to the transition's end, so after `lengthFrames` it reads B's own frames,
/// sample for sample, from `round(bResume × 44 100)`, as the rest of the song does.
///
/// AVAudioUnitTimePitch keeps pitch, but it delays its output by a varying amount and takes rate changes from the main
/// thread between render cycles: B would leave the shared timeline and miss its landing. A cubic resampler over the
/// PCM is exact, runs on the source's actor, and the 2% pitch moves for a few beats while B fades in.
actor VarispeedSource: PCMSource {
  private let base: any PCMSource
  private let rate: Automation
  private let lengthFrames: Int64
  /// B's frame (fractional) that output sample `produced` reads.
  private var position: Double
  /// B's frames read so far from `base`: `buffer` holds frames `bufferStart..<bufferStart + buffer.frames`.
  private var buffer = PCMBlock(left: [], right: [])
  private var bufferStart: Int64
  private var produced: Int64 = 0
  private var ended = false

  /// The frame `base` starts at, to read from one frame before where the transition starts reading B.
  static func baseStart(plan: TransitionPlan, lengthFrames: Int64, endFrame: Int64) -> Int64 {
    max(0, Int64(startPosition(plan: plan, lengthFrames: lengthFrames, endFrame: endFrame).rounded(.down)) - 1)
  }

  static func startPosition(plan: TransitionPlan, lengthFrames: Int64, endFrame: Int64) -> Double {
    Double(endFrame) - EngineFormat.sampleRate * plan.bRate.integral(from: 0, to: Double(lengthFrames) / EngineFormat.sampleRate)
  }

  /// `base` reads B from `baseStart`; the transition lasts `lengthFrames` and runs into B's frame `endFrame`.
  init(base: any PCMSource, baseStart: Int64, rate: Automation, lengthFrames: Int64, endFrame: Int64, plan: TransitionPlan) {
    self.base = base
    self.rate = rate
    self.lengthFrames = lengthFrames
    bufferStart = baseStart
    position = Self.startPosition(plan: plan, lengthFrames: lengthFrames, endFrame: endFrame)
  }

  func read(maxFrames: Int) async throws -> PCMBlock? {
    if produced >= lengthFrames {
      // B's own frames from here: what's left of the buffer, then the base as it comes.
      let from = Int(Int64(position.rounded()) - bufferStart)
      if from < buffer.frames {
        let out = buffer.slice(max(0, from)..<min(buffer.frames, max(0, from) + maxFrames))
        position += Double(out.frames)
        produced += Int64(out.frames)
        return out
      }
      return try await base.read(maxFrames: maxFrames)
    }
    let count = Int(min(Int64(maxFrames), lengthFrames - produced))
    // Enough of B for this block: up to two frames past the furthest position it reads.
    let furthest = position + Double(count) * max(1, rate.map(\.value).max() ?? 1) + 3
    while !ended, Double(bufferStart) + Double(buffer.frames) < furthest {
      guard let more = try await base.read(maxFrames: 22_050) else {
        ended = true
        break
      }
      buffer.left += more.left
      buffer.right += more.right
    }
    var left = [Float](repeating: 0, count: count), right = [Float](repeating: 0, count: count)
    for i in 0..<count {
      let p = position - Double(bufferStart)
      left[i] = Self.cubic(buffer.left, p)
      right[i] = Self.cubic(buffer.right, p)
      position += rate.value(at: (Double(produced + Int64(i)) + 0.5) / EngineFormat.sampleRate)
    }
    produced += Int64(count)
    if produced == lengthFrames {
      // The transition's end: exactly B's frame where its own playback picks up.
      position = position.rounded()
    }
    // Keep a few frames behind the read position (the interpolation looks one back).
    let keepFrom = Int(position.rounded(.down)) - Int(bufferStart) - 2
    if keepFrom > 0 {
      let drop = min(keepFrom, buffer.frames)
      buffer = buffer.dropping(drop)
      bufferStart += Int64(drop)
    }
    return PCMBlock(left: left, right: right)
  }

  func close() async { await base.close() }

  /// Catmull-Rom between samples ⌊p⌋ and ⌊p⌋+1; silence outside what's there.
  static func cubic(_ s: [Float], _ p: Double) -> Float {
    let i = Int(p.rounded(.down))
    let t = Float(p - Double(i))
    func at(_ k: Int) -> Float { s.indices.contains(k) ? s[k] : 0 }
    let (y0, y1, y2, y3) = (at(i - 1), at(i), at(i + 1), at(i + 2))
    if t == 0 { return y1 }
    let a = -0.5 * y0 + 1.5 * y1 - 1.5 * y2 + 0.5 * y3
    let b = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3
    let c = -0.5 * y0 + 0.5 * y2
    return ((a * t + b) * t + c) * t + y1
  }
}
```

Create `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/MixReport.swift`:

```swift
import Foundation

/// How a changeover of the last mix went, for Stats for nerds: where it was scheduled on the engine's one clock, and
/// how far ahead of the playhead its first audio was handed to the node (the web measured two files' drift; here the
/// changeover is sample-exact by construction, so what's worth seeing is that it was scheduled, and with what margin).
public struct MixReport: Sendable, Equatable {
  public enum Kind: String, Sendable, CaseIterable {
    /// From A's own file to the transition (or, mixed live, B coming in).
    case mixIn = "mix in"
    /// From the transition to B's own file (or, mixed live, A gone).
    case mixOut = "mix out"
  }

  public enum Way: String, Sendable {
    case server = "made on the server"
    case live = "mixed on this device"
    case cut = "cut on the beat"
  }

  public let kind: Kind
  public let way: Way
  /// "Into the Trees → Hung Up".
  public let songs: String
  /// The timeline sample of the changeover.
  public let sample: SampleTime
  /// Where that is in the song it happens in: A's time for a mix in, B's for a mix out.
  public let songTime: Double
  /// Seconds before the changeover its first audio was scheduled; nil until it has been.
  public var headroom: Double?

  public init(kind: Kind, way: Way, songs: String, sample: SampleTime, songTime: Double, headroom: Double? = nil) {
    self.kind = kind
    self.way = way
    self.songs = songs
    self.sample = sample
    self.songTime = songTime
    self.headroom = headroom
  }
}
```

**Step 2: They build**

```bash
swift build --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer 2>&1 | tail -1
```

Expected: `Build complete!` (no warnings from these files).

**Step 3: Commit**

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/TransitionJoin.swift \
  apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/TransitionFileSource.swift \
  apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/VarispeedSource.swift \
  apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/MixReport.swift
git commit -F - <<'EOF'
Add the pieces of a DJ join: the transition file, its levels, a resampled next song

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 8: The engine plays DJ joins on the sample

`Join` gains `.transition(TransitionJoin)`, `.cut(BeatCut)` and `.mix(TransitionPlan)`, with `leaveTime` (where A must not be scheduled past before the join is placed) and `mixBegins`. `EngineItem` gains `continuation`, and `EngineEvent` gains `.mixMissed`. `Deck` segments gain:

- `limit`: the song stops at a sample, and nothing past it is read;
- `hold`: nothing from a sample on is scheduled yet;
- `automation`;
- `firstHeadroom`.

`AudioEngine` gains:

- a mutable `tuning`;
- `mix` (the mix in progress), `mixReports` and `upcomingPlaced`;
- `placeMix` and `missed` (key decisions 1 and 2), and the queue's switch at `switchAt`;
- `position` mapped through a mix: A's clock until the switch, then B's;
- `SourcePlan`: where B's audio comes from (its frame, varispeed, the continuation).

A new epoch drops the mix (key decision 10). The Player gets a placeholder for `.mixMissed` until Task 12.

**Files:**
- Modify: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/EngineItem.swift`
- Modify: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Deck.swift`
- Modify: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/AudioEngine.swift`
- Modify: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Player.swift`
- Create: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/TransitionFiles.swift`
- Test: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/MixEngineTests.swift`

**Step 1: Write the failing tests**

`TransitionFiles` writes real FLAC files with `AVAudioFile`. The tests' songs carry their own frame number in the right channel (`music`), and so does the transition file (`tag`), so the rendered output says exactly which file and frame is heard at each sample.

Create `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/TransitionFiles.swift`:

```swift
import AVFoundation
import Foundation
import PlayarrAPI
@testable import PlayarrPlayer

/// Synthetic transitions for the engine's tests.
enum TransitionFiles {
  /// A 24-bit FLAC of exactly `frames` frames at 44.1 kHz: `signal(frame, channel)`.
  static func flac(frames: Int, signal: (Int, Int) -> Float) throws -> URL {
    let url = temporaryDirectory().appending(path: "transition.flac")
    let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 44_100, channels: 2, interleaved: false)!
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames))!
    buffer.frameLength = AVAudioFrameCount(frames)
    for c in 0..<2 {
      for i in 0..<frames { buffer.floatChannelData![c][i] = signal(i, c) }
    }
    do {
      let file = try AVAudioFile(
        forWriting: url, settings: [AVFormatIDKey: kAudioFormatFLAC, AVSampleRateKey: 44_100, AVNumberOfChannelsKey: 2, AVLinearPCMBitDepthKey: 24],
        commonFormat: .pcmFormatFloat32, interleaved: false)
      try file.write(from: buffer)
    }
    return url
  }

  /// Not periodic over a few samples, so a changeover a sample early or late shows as a step: two sines whose
  /// frequencies share no period.
  static let music: @Sendable (Int64) -> Float = { n in
    let t = Double(n) / 44_100
    return Float(0.3 * sin(2 * .pi * 523.25 * t) + 0.1 * sin(2 * .pi * 61.7 * t))
  }

  static func plan(
    style: TransitionStyle = .long, aStart: Double, bStart: Double = 8, length: Double, bResume: Double, switchAt: Double,
    bRate: Automation = [.init(at: 0, value: 1)], aGain: Automation? = nil, bGain: Automation? = nil
  ) -> TransitionPlan {
    TransitionPlan(
      style: style, aStart: aStart, bStart: bStart, length: length, bResume: bResume, switchAt: switchAt, bRate: bRate,
      aGain: aGain ?? [.init(at: 0, value: 1), .init(at: length, value: 0)], bGain: bGain ?? [.init(at: 0, value: 0), .init(at: length, value: 1)],
      aLowDb: [.init(at: 0, value: 0)], bLowDb: [.init(at: 0, value: 0)], aHighPassHz: [.init(at: 0, value: 20)], reason: "test", beats: 0)
  }
}

extension AudioEngine.Tuning {
  /// As the Player sets it for DJ mix.
  static var dj: AudioEngine.Tuning {
    var tuning = AudioEngine.Tuning()
    tuning.scheduleAhead = 2.5
    return tuning
  }
}
```

Create `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/MixEngineTests.swift`:

```swift
import AVFoundation
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrPlayer

/// DJ joins rendered offline: every changeover checked to the sample. The left channel carries "music" that runs on
/// continuously through A, the transition and B (a changeover a sample off shows as a step); the right channel says
/// which file is heard (A's own 0.1, the transition 0.2, B's own 0.3), so each changeover's sample can be read off it.
@MainActor
@Suite(.serialized)
struct MixEngineTests {
  let sr = 44_100

  /// The limiter's delay, found on the left channel.
  func lag(_ out: PCMBlock, _ expected: (Int) -> Float) -> Int { latency(of: out, matching: expected) }

  @Test func aRenderedTransitionLandsOnTheSampleAtBothChangeovers() async throws {
    // A's mix point at 4 s; the file has a 1 s lead, a 2 s transition, a 1 s tail; B goes on from 10 s.
    let aStart = 4 * sr, lead = sr, length = 2 * sr, tail = sr, bResume = 10 * sr
    let music = TransitionFiles.music
    let file = try TransitionFiles.flac(frames: lead + length + tail) { k, c in
      c == 0 ? music(Int64(aStart - lead + k)) : 0.2
    }
    // B's own file holds the same music from where the transition leaves it.
    let audio = try AudioEngine.offline(
      [1: { n, c in c == 0 ? music(n) : 0.1 }, 2: { m, c in c == 0 ? music(m - Int64(bResume) + Int64(aStart + length)) : 0.3 }],
      tuning: .dj)
    var events: [EngineEvent] = []
    audio.onEvent = { events.append($0) }
    let a = EngineItem(track: song(1, duration: 8)), b = EngineItem(track: song(2, duration: 30))
    let plan = TransitionFiles.plan(aStart: 4, length: 2, bResume: 10, switchAt: 1)
    audio.load(a, playing: true)
    audio.setUpcoming(b, join: .transition(TransitionJoin(plan: plan, file: file, leadFrames: Int64(lead), tailFrames: Int64(tail))))
    let out = try await audio.render(seconds: 9)
    let lag = lag(out) { music(Int64($0)) }
    let cut = aStart - lead / 2, landing = aStart + length
    // Not one sample off anywhere: the music runs on through both changeovers.
    let worst = (0..<(8 * sr)).map { abs(out.left[$0 + lag] - music(Int64($0))) }.max() ?? 1
    #expect(worst < 1e-4)
    // A's own file to the transition in the middle of its lead, the transition to B's own file where it ends.
    #expect(abs(out.right[cut - 1 + lag] - 0.1) < 1e-4)
    #expect(abs(out.right[cut + lag] - 0.2) < 1e-4)
    #expect(abs(out.right[landing - 1 + lag] - 0.2) < 1e-4)
    #expect(abs(out.right[landing + lag] - 0.3) < 1e-4)
    // The listener sees B from the switch, at B's time.
    #expect(events.contains(.advanced(b.id)))
    #expect(abs(audio.position - 13) < 0.1)
    #expect(audio.mixReports[.mixIn]?.sample == SampleTime(cut))
    #expect(audio.mixReports[.mixOut]?.sample == SampleTime(landing))
    #expect((audio.mixReports[.mixIn]?.headroom ?? 0) > 0.5)
  }

  @Test func aTransitionMadeAtOtherLevelsIsTurnedToTheSongsLevels() async throws {
    // The songs play at −6 dB and +4 dB; the transition was made at 0 dB for both.
    let aStart = 4 * sr, lead = sr, length = 2 * sr, tail = sr, bResume = 10 * sr
    let music = TransitionFiles.music
    let file = try TransitionFiles.flac(frames: lead + length + tail) { k, _ in music(Int64(aStart - lead + k)) }
    let audio = try AudioEngine.offline(
      [1: { n, _ in music(n) }, 2: { m, _ in music(m - Int64(bResume) + Int64(aStart + length)) }], tuning: .dj)
    let a = EngineItem(track: song(1, duration: 8), gainDb: -6), b = EngineItem(track: song(2, duration: 30), gainDb: 4)
    let plan = TransitionFiles.plan(aStart: 4, length: 2, bResume: 10, switchAt: 1)
    audio.load(a, playing: true)
    audio.setUpcoming(b, join: .transition(TransitionJoin(plan: plan, file: file, leadFrames: Int64(lead), tailFrames: Int64(tail), correctionA: -6, correctionB: 4)))
    let out = try await audio.render(seconds: 8)
    let (ga, gb) = (pow(10, -6.0 / 20), pow(10, 4.0 / 20))
    let expected = { (n: Int) -> Float in
      let t = Double(n - aStart) / Double(self.sr)
      let gain = n < aStart ? ga : n >= aStart + length ? gb : MixSequence.bridgeGain(plan, t, gainA: ga, gainB: gb)
      return Float(gain) * music(Int64(n))
    }
    let lag = lag(out, expected)
    for changeover in [aStart - lead / 2, aStart + length] {
      let worst = ((changeover - 2000)..<(changeover + 2000)).map { abs(out.left[$0 + lag] - expected($0)) }.max() ?? 1
      #expect(worst < 2e-4, "at \(changeover)")
    }
  }

  @Test func aFadeWithoutAFileIsPlayedLiveOnThePlansCurves() async throws {
    // A in the left ear (0.4), B in the right as a ramp that says which of its frames is heard.
    let plan = TransitionFiles.plan(
      style: .fade, aStart: 3, bStart: 0.5, length: 1, bResume: 1.5, switchAt: 0.5,
      aGain: SkipPlanner.equalPower(0, 1, fadingIn: false), bGain: SkipPlanner.equalPower(0, 1, fadingIn: true))
    let audio = try AudioEngine.offline([1: Signals.constant(0.4, 0), 2: { m, c in c == 1 ? Float(m) * 1e-6 : 0 }], tuning: .dj)
    var events: [EngineEvent] = []
    audio.onEvent = { events.append($0) }
    let b = EngineItem(track: song(2, duration: 20))
    audio.load(EngineItem(track: song(1, duration: 6)), playing: true)
    audio.setUpcoming(b, join: .mix(plan))
    let out = try await audio.render(seconds: 5.5)
    let lag = (0..<512).first { out.left[$0] > 0.2 } ?? 0
    let start = 3 * sr
    for i in stride(from: 0, to: sr, by: 441) {
      let t = Double(i) / Double(sr)
      #expect(abs(out.left[start + i + lag] - 0.4 * Float(plan.aGain.value(at: t))) < 1e-4)
      let bFrame = Double(sr / 2 + i)  // B from 0.5 s, at its own speed
      #expect(abs(out.right[start + i + lag] - Float(plan.bGain.value(at: t) * bFrame * 1e-6)) < 1e-4)
    }
    #expect(abs(out.left[start + sr + 10 + lag]) < 1e-6)  // A is gone
    #expect(events.contains(.advanced(b.id)))
    #expect(abs(audio.position - (1.5 + 1.5)) < 0.1)
  }

  @Test func aStretchedQuickMixLandsBOnTheSampleWhereItsOwnPlaybackGoesOn() async throws {
    // B at 0.98 for 0.7 s, back to 1 by 0.9 s, held to 1 s: it must end on exactly frame 5.0 s.
    let rate: Automation = [.init(at: 0, value: 0.98), .init(at: 0.7, value: 0.98), .init(at: 0.9, value: 1)]
    let bStart = 5 - rate.integral(from: 0, to: 1)
    let plan = TransitionFiles.plan(
      style: .quick, aStart: 2, bStart: bStart, length: 1, bResume: 5, switchAt: 0.5, bRate: rate,
      aGain: [.init(at: 0, value: 0)], bGain: [.init(at: 0, value: 1)])
    // B's left channel is its frame number: interpolating a straight line gives back the position exactly.
    let audio = try AudioEngine.offline([1: Signals.constant(0, 0.4), 2: { m, c in c == 0 ? Float(m) * 1e-6 : 0 }], tuning: .dj)
    audio.load(EngineItem(track: song(1, duration: 6)), playing: true)
    audio.setUpcoming(EngineItem(track: song(2, duration: 20)), join: .mix(plan))
    let out = try await audio.render(seconds: 4)
    let lag = (0..<512).first { out.right[$0] > 0.2 } ?? 0
    let start = 2 * sr
    for i in stride(from: 0, to: sr, by: 1000) {
      // Output sample i reads B at 5 s − ∫ rate from i to the end.
      let expected = 5 * Double(sr) - Double(sr) * rate.integral(from: (Double(i)) / Double(sr), to: 1)
      #expect(abs(Double(out.left[start + i + lag]) / 1e-6 - expected) < 0.2, "sample \(i)")
    }
    for i in [sr, sr + 1, sr + 2, sr + 4410] {
      #expect(abs(Double(out.left[start + i + lag]) / 1e-6 - Double(5 * sr + (i - sr))) < 0.1, "after, sample \(i)")
    }
  }

  @Test func aCutOnTheBeatChangesSongsOnOneSample() async throws {
    let audio = try AudioEngine.offline([1: Signals.constant(0.1, 0.1), 2: { m, c in c == 0 ? Float(m) * 1e-6 : 0.3 }], tuning: .dj)
    audio.load(EngineItem(track: song(1, duration: 6)), playing: true)
    audio.setUpcoming(EngineItem(track: song(2, duration: 20)), join: .cut(BeatCut(aEnd: 3, bStart: 1)))
    let out = try await audio.render(seconds: 4)
    let lag = (0..<512).first { out.right[$0] > 0.05 } ?? 0
    #expect(abs(out.right[3 * sr - 1 + lag] - 0.1) < 1e-4)
    #expect(abs(out.right[3 * sr + lag] - 0.3) < 1e-4)
    #expect(abs(Double(out.left[3 * sr + lag]) / 1e-6 - Double(sr)) < 0.1)  // B from its frame at 1 s
  }

  @Test func aMixAskedForTooLateIsMissedAndTheSongsJoinGapless() async throws {
    let audio = try AudioEngine.offline([1: Signals.constant(0.1, 0.1), 2: Signals.constant(0.3, 0.3)], tuning: .dj)
    var events: [EngineEvent] = []
    audio.onEvent = { events.append($0) }
    let b = EngineItem(track: song(2, duration: 20))
    audio.load(EngineItem(track: song(1, duration: 3)), playing: true)
    _ = try await audio.render(seconds: 1)
    audio.setUpcoming(b, join: .cut(BeatCut(aEnd: 1.05, bStart: 1)))  // already scheduled past
    let out = try await audio.render(seconds: 3)
    #expect(events.contains(.mixMissed(b.id)))
    // A to its end at 3 s (2 s into this render), then B from its start: no sample of silence between.
    let join = (2 * sr - 300)..<(2 * sr + 300)
    #expect(abs(out.left[join.lowerBound] - 0.1) < 1e-4)
    #expect(abs(out.left[join.upperBound] - 0.3) < 1e-4)
    #expect(out.left[join].allSatisfy { abs($0 - 0.1) < 1e-4 || abs($0 - 0.3) < 1e-4 })
  }

  @Test func aMixWhoseNextSongIsNotReadyInTimeIsMissedWithoutAGap() async throws {
    let gate = Gate()
    let stalled = SignalSource(seconds: 20, signal: Signals.constant(0.3, 0.3))
    await stalled.stall(after: 0, until: gate)
    let audio = try AudioEngine(tuning: .dj, manualRendering: true) { item, frame in
      item.track.id == 2 ? stalled : SignalSource(seconds: item.track.duration, from: frame, signal: Signals.constant(0.1, 0.1))
    }
    var events: [EngineEvent] = []
    audio.onEvent = { events.append($0) }
    let b = EngineItem(track: song(2, duration: 20))
    audio.load(EngineItem(track: song(1, duration: 8)), playing: true)
    audio.setUpcoming(b, join: .cut(BeatCut(aEnd: 4, bStart: 0)))
    let out = try await audio.render(seconds: 6)
    #expect(events.contains(.mixMissed(b.id)))
    // A played on through where the cut would have been, never short of audio.
    #expect(audio.state == .playing)
    let a = out.left[(3 * sr)..<(5 * sr)]
    #expect(a.allSatisfy { abs($0 - 0.1) < 1e-4 })
    await gate.open()
  }
}
```

**Step 2: Run them to see them fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter MixEngineTests 2>&1 | grep -m1 -E '\.swift:[0-9]+:[0-9]+: .*error'
```

Expected: `…/MixEngineTests.swift:…: error: type 'Join' has no member 'transition'`.

**Step 3: Implement**

Apply the patch:

```bash
cat > /tmp/phase5-task8-engine.patch <<'PATCH'
diff --git a/apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/EngineItem.swift b/apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/EngineItem.swift
--- a/apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/EngineItem.swift
+++ b/apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/EngineItem.swift
@@ -9,12 +9,31 @@
   public var gainDb: Double
   /// Seconds into the song where it starts.
   public var startAt: Double
+  /// The rest of the song after a transition as the server made it (`continuationUrl`), played instead of the song's
+  /// own file from `from` on (an MP3 can't be started at an exact sample; the server's copy runs on from the
+  /// transition's tail sample for sample).
+  public var continuation: Continuation?
 
-  public init(id: UUID = UUID(), track: Track, gainDb: Double = 0, startAt: Double = 0) {
+  public struct Continuation: Sendable, Equatable {
+    /// The server's path for it (`/transitions/<name>.rest.flac`).
+    public var url: String
+    /// The song second it starts at: the plan's `bResume`.
+    public var from: Double
+    /// Its gain: it was made at the level sent with the request, so it's turned only by the difference.
+    public var gainDb: Double
+    public init(url: String, from: Double, gainDb: Double) {
+      self.url = url
+      self.from = from
+      self.gainDb = gainDb
+    }
+  }
+
+  public init(id: UUID = UUID(), track: Track, gainDb: Double = 0, startAt: Double = 0, continuation: Continuation? = nil) {
     self.id = id
     self.track = track
     self.gainDb = gainDb
     self.startAt = startAt
+    self.continuation = continuation
   }
 }
 
@@ -22,8 +41,33 @@
 public enum Join: Sendable, Equatable {
   /// It starts where the current one ends, overlapping by `seconds` with equal-power fades (0: gapless).
   case crossfade(seconds: Double)
-  // Phase 5 adds `.transition(...)`: a rendered transition file on the transition node and the next song's own file
-  // from `bResume`, both placed with `timelineSample(of:songFrame:)` and `scheduleTransition(_:at:envelope:)`.
+  /// A transition rendered by the server and downloaded (see `TransitionJoin`): A is cut inside the file's lead, the
+  /// file plays on the transition node, and the item goes on from the plan's `bResume` where the transition ends.
+  case transition(TransitionJoin)
+  /// A stops at `aEnd` and the item starts at `bStart`, on the same sample: a cut on the beat, a silence cut, or the
+  /// server's straight on.
+  case cut(BeatCut)
+  /// The engine mixes the two songs itself from the plan's curves: a fade, a quick mix, a press of Next. The item comes
+  /// in at the plan's `aStart`, from `bStart`, at the plan's rate.
+  case mix(TransitionPlan)
+
+  /// Where in A (song seconds) the join begins: A's own audio must not be scheduled past it before the join is
+  /// placed. Nil for a crossfade, which goes by A's end.
+  public var leaveTime: Double? {
+    switch self {
+    case .crossfade: nil
+    case .transition(let t): t.plan.aStart - EngineFormat.seconds(t.leadFrames)
+    case .cut(let c): c.aEnd
+    case .mix(let plan): plan.aStart
+    }
+  }
+
+  /// Where in A the mix is first heard (song seconds): a transition's `aStart` (its lead is A alone), else where the
+  /// join begins. Nil for a crossfade.
+  public var mixBegins: Double? {
+    if case .transition(let t) = self { return t.plan.aStart }
+    return leaveTime
+  }
 }
 
 public enum EngineState: Sendable, Equatable {
@@ -43,6 +87,8 @@
   case ended(UUID)
   /// The item couldn't play.
   case failed(UUID, PlaybackError)
+  /// The item's mix couldn't be placed in time (asked for too late, or the item not ready): it joins gapless instead.
+  case mixMissed(UUID)
 }
 
 /// What the Player lab shows of a deck.
@@ -55,6 +101,16 @@
   public let scheduledSeconds: Double
   public let finished: Bool
   public let gain: Float
+
+  public init(name: String, title: String?, startsAt: Double?, decodedSeconds: Double, scheduledSeconds: Double, finished: Bool, gain: Float) {
+    self.name = name
+    self.title = title
+    self.startsAt = startsAt
+    self.decodedSeconds = decodedSeconds
+    self.scheduledSeconds = scheduledSeconds
+    self.finished = finished
+    self.gain = gain
+  }
 }
 
 public struct EngineSnapshot: Sendable, Equatable {
diff --git a/apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Deck.swift b/apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Deck.swift
--- a/apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Deck.swift
+++ b/apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Deck.swift
@@ -24,6 +24,14 @@
     var decoded: Int64 = 0
     var scheduled: Int64 = 0
     var finished = false
+    /// The song stops at this timeline sample (a mix leaves it there): nothing past it is read or scheduled.
+    var limit: SampleTime?
+    /// Nothing from this sample on is scheduled yet: a mix is waiting for the next song to be ready.
+    var hold: SampleTime?
+    /// A mix's curves and filters for this song, applied as blocks are scheduled.
+    var automation: DeckAutomation?
+    /// How far ahead of the playhead its first block was scheduled (frames), once it has been.
+    var firstHeadroom: Int64?
 
     var end: SampleTime? { finished ? timelineStart.map { $0 + decoded } : nil }
     var scheduledEnd: SampleTime? { timelineStart.map { $0 + scheduled } }
@@ -51,6 +59,15 @@
   func setFadeOut(_ ramp: Ramp) { segment?.envelope.fadeOut = ramp }
   func setGain(_ gainDb: Double) { segment?.envelope.gain = GainEnvelope(gainDb: gainDb).gain }
 
+  /// The song stops at timeline sample `sample`: a mix leaves it there.
+  func end(at sample: SampleTime) {
+    segment?.limit = sample
+    segment?.hold = nil
+  }
+
+  func hold(at sample: SampleTime?) { segment?.hold = sample }
+  func setAutomation(_ automation: DeckAutomation?) { segment?.automation = automation }
+
   /// Forgets the segment (its source is closed). What's already scheduled still plays: only `stop` clears that.
   func release() {
     reading?.cancel()
@@ -69,6 +86,7 @@
   func pump(now: SampleTime, ahead: Int64, block: Int64) {
     scheduleReady(now: now, ahead: ahead)
     guard reading == nil, let s = segment, !s.finished else { return }
+    if let limit = s.limit, let start = s.timelineStart, start + s.decoded >= limit { return }
     let decodedAhead = s.timelineStart.map { $0 + s.decoded - now } ?? s.decoded
     guard decodedAhead < ahead + s.holdback + block else { return }
     let (source, id) = (s.source, s.id)
@@ -87,6 +105,8 @@
   private func received(_ pcm: PCMBlock?, for id: UUID) {
     guard segment?.id == id else { return }
     reading = nil
+    // Read before the song was cut short at its limit: not needed.
+    guard segment?.finished == false else { return }
     if let pcm {
       if pcm.frames > 0 {
         segment?.pending.append(pcm)
@@ -109,17 +129,37 @@
     let holdFrom = s.expectedFrames - s.holdback
     while let pcm = s.pending.first {
       let at = start + s.scheduled
-      let blockEnd = s.scheduled + Int64(pcm.frames)
+      var blockEnd = s.scheduled + Int64(pcm.frames)
       guard at < now + ahead else { break }
-      // Near the end, a block waits until the end is known or enough beyond it is decoded: it might fade out.
-      if !s.finished && s.holdback > 0 && blockEnd > holdFrom && blockEnd > s.decoded - s.holdback { break }
+      if let hold = s.hold, start + blockEnd > hold { break }
+      // Near the end, a block waits until the end is known or enough beyond it is decoded: it might fade out. A song
+      // a mix leaves has its end known already.
+      if s.limit == nil && !s.finished && s.holdback > 0 && blockEnd > holdFrom && blockEnd > s.decoded - s.holdback { break }
       s.pending.removeFirst()
       var scaled = pcm
+      if let limit = s.limit, start + blockEnd > limit {
+        let keep = Int(max(0, limit - at))
+        scaled = pcm.slice(0..<keep)
+        blockEnd = s.scheduled + Int64(keep)
+      }
       s.envelope.apply(to: &scaled, at: at)
+      s.automation?.apply(to: &scaled, at: at)
+      if s.firstHeadroom == nil { s.firstHeadroom = at - now }
       if let buffer = scaled.makeBuffer() {
         node.scheduleBuffer(buffer, at: AVAudioTime(sampleTime: at, atRate: EngineFormat.sampleRate), options: [], completionHandler: nil)
       }
       s.scheduled = blockEnd
+      if let limit = s.limit, start + blockEnd >= limit {
+        // The mix has left the song: it ends here, and the rest isn't read.
+        s.pending = []
+        s.decoded = s.scheduled
+        s.finished = true
+        reading?.cancel()
+        reading = nil
+        let source = s.source
+        Task { await source.close() }
+        break
+      }
     }
     segment = s
   }
diff --git a/apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/AudioEngine.swift b/apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/AudioEngine.swift
--- a/apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/AudioEngine.swift
+++ b/apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/AudioEngine.swift
@@ -1,5 +1,6 @@
 import AVFoundation
 import AudioToolbox
+import PlayarrAPI
 
 /// The audio engine: AVAudioEngine with two decks taking turns and a third player node for transition files, each
 /// through its own mixer into a bus, an EQ (flat for now) and a peak limiter, then out.
@@ -33,9 +34,26 @@
     public init() {}
   }
 
+  /// A mix placed on the timeline, from where it starts until the next song plays on its own.
+  public struct MixInProgress: Sendable, Equatable {
+    /// The item mixed into.
+    public let to: UUID
+    public let plan: TransitionPlan
+    public let way: MixReport.Way
+    /// Timeline samples: transition time 0 (the plan's `aStart`), the switch to the next song, the end.
+    public let start: SampleTime
+    public let switchSample: SampleTime
+    public let end: SampleTime
+  }
+
   public private(set) var state: EngineState = .idle
   public var onEvent: ((EngineEvent) -> Void)?
-  public let tuning: Tuning
+  /// Changeable while playing: DJ mix keeps less scheduled ahead, so a mix can be placed a few seconds ahead.
+  public var tuning: Tuning
+  /// The mix playing (or placed and about to), if any.
+  public private(set) var mix: MixInProgress?
+  /// The last mix's changeovers, for Stats for nerds.
+  public private(set) var mixReports: [MixReport.Kind: MixReport] = [:]
 
   let engine = AVAudioEngine()
   let decks: [Deck]
@@ -60,6 +78,8 @@
   private var pumpAgain = false
   private var events: [EngineEvent] = []
   private var configurationWatch: Task<Void, Never>?
+  /// The deck and segment whose first scheduled block each report's headroom is read from.
+  private var reportSources: [MixReport.Kind: (deck: Deck, id: UUID)] = [:]
 
   /// `makeSource` opens a song's audio from a frame (44.1 kHz) on. `manualRendering` renders offline, for tests.
   public init(tuning: Tuning = Tuning(), manualRendering: Bool = false, makeSource: @escaping @MainActor (EngineItem, Int64) -> any PCMSource) throws {
@@ -118,11 +138,19 @@
   /// reloaded where it is (a new epoch), so its end is as it should be for the new one.
   public func setUpcoming(_ item: EngineItem?, join: Join = .crossfade(seconds: 0)) {
     let placed = upcomingDeck?.segment?.timelineStart != nil
-    if let item, item.id == upcoming?.item.id {
+    if let item, let old = upcoming, item.id == old.item.id {
       guard !placed else { return }
       upcoming = (item, join)
       items[item.id] = item
-      upcomingDeck?.setGain(item.gainDb)
+      let opening = sourcePlan(item, join)
+      if opening != sourcePlan(old.item, old.join) {
+        // Its audio has to come from elsewhere now (another frame, the server's rest, resampled): opened again.
+        upcomingDeck?.release()
+        upcomingDeck = nil
+      } else {
+        upcomingDeck?.setGain(opening.gainDb)
+      }
+      pump()
       return
     }
     upcomingDeck?.release()
@@ -189,8 +217,17 @@
 
   public var currentItem: EngineItem? { current?.segment.flatMap { items[$0.id] } }
 
+  /// The next item is placed on the timeline: changing it now means a new epoch.
+  public var upcomingPlaced: Bool { upcomingDeck?.segment?.timelineStart != nil }
+
   /// Seconds into the current item.
   public var position: Double {
+    let now = self.now
+    if let m = mix, let id = current?.segment?.id, now < m.end {
+      // In a mix the listener sees A until the switch, then B (on B's clock, at its rate).
+      let t = EngineFormat.seconds(now - m.start)
+      return id == m.to ? MixSequence.bTimeAt(m.plan, t) : m.plan.aStart + t
+    }
     guard let s = current?.segment, let start = s.timelineStart else { return currentItem?.startAt ?? 0 }
     let played = min(max(0, now - start), s.finished ? s.decoded : .max)
     return EngineFormat.seconds(s.firstFrame + played)
@@ -254,21 +291,25 @@
     startWhenReady(now: now)
     watchBuffer(now: now)
     reportEnd(now: now)
+    refreshReports()
   }
 
   private func prepareUpcoming() {
-    guard let (item, _) = upcoming, upcomingDeck == nil, let cur = current, let s = cur.segment, let curItem = items[s.id],
+    guard let (item, join) = upcoming, upcomingDeck == nil, let cur = current, let s = cur.segment, let curItem = items[s.id],
       let deck = decks.first(where: { $0 !== cur && $0.segment == nil })
     else { return }
-    let remaining = curItem.track.duration - position
+    // A DJ join begins before A's end: the next song is made ready that long before it begins.
+    let remaining = (join.leaveTime ?? curItem.track.duration) - position
     guard remaining <= tuning.preload || s.finished else { return }
-    open(item, on: deck)
+    open(item, on: deck, join: join)
     upcomingDeck = deck
   }
 
   private func placeUpcoming(now: SampleTime) {
+    guard let join = upcoming?.join else { return }
+    guard case .crossfade(let seconds) = join else { return placeMix(join, now: now) }
     guard let next = upcomingDeck, next.segment?.timelineStart == nil, let cur = current?.segment, let end = cur.end,
-      let scheduledEnd = cur.scheduledEnd, case .crossfade(let seconds)? = upcoming?.join
+      let scheduledEnd = cur.scheduledEnd
     else { return }
     let soonest = now + EngineFormat.frames(tuning.startMargin)
     // A fade can't reach back into what's already scheduled, nor start before the soonest moment.
@@ -284,8 +325,98 @@
     pumpAgain = true
   }
 
+  /// Places a DJ join, as late as it can still be: once its start is within what's scheduled ahead (plus a block), so
+  /// until then the join can change without a new epoch. If the next song isn't decoded by then, A's scheduling is
+  /// held at the join's start while it gets ready, up to just before A would run short; then the join is missed.
+  private func placeMix(_ join: Join, now: SampleTime) {
+    guard let next = upcomingDeck, let b = next.segment, b.timelineStart == nil, let cur = current, let a = cur.segment,
+      let aStart = a.timelineStart, let item = upcoming?.item, let leave = join.leaveTime
+    else { return }
+    let sampleOfA = { (seconds: Double) in aStart + EngineFormat.frames(seconds) - a.firstFrame }
+    var at = sampleOfA(leave)
+    if case .transition(let t) = join { at += t.leadFrames / 2 }
+    guard at <= now + EngineFormat.frames(tuning.scheduleAhead + tuning.block) else { return }
+    let soonest = now + EngineFormat.frames(tuning.startMargin)
+    let scheduledEnd = a.scheduledEnd ?? aStart
+    let bReady: Bool = if case .transition = join { true } else { b.finished || b.decoded > 0 }
+    if !bReady {
+      guard at - now > EngineFormat.frames(tuning.lowWater + tuning.startMargin + 0.1), scheduledEnd <= at else { return missed(item) }
+      return cur.hold(at: at)
+    }
+    let songs = "\(items[a.id]?.track.title ?? "?") → \(item.track.title)"
+    switch join {
+    case .crossfade:
+      return
+    case .cut(let c):
+      guard at >= max(soonest, scheduledEnd) else { return missed(item) }
+      cur.end(at: at)
+      next.place(at: at)
+      report(.mixIn, MixReport(kind: .mixIn, way: .cut, songs: songs, sample: at, songTime: c.aEnd), from: next)
+      mixReports[.mixOut] = nil
+    case .mix(let plan):
+      guard at >= max(soonest, scheduledEnd) else { return missed(item) }
+      let silent = at + EngineFormat.frames(plan.aGain.silentFrom(limit: plan.length))
+      cur.setAutomation(.a(plan, start: at))
+      cur.end(at: silent)
+      next.setAutomation(.b(plan, start: at))
+      next.place(at: at)
+      mix = MixInProgress(
+        to: item.id, plan: plan, way: .live, start: at, switchSample: at + EngineFormat.frames(plan.switchAt),
+        end: at + EngineFormat.frames(plan.length))
+      report(.mixIn, MixReport(kind: .mixIn, way: .live, songs: songs, sample: at, songTime: plan.aStart), from: next)
+      report(.mixOut, MixReport(kind: .mixOut, way: .live, songs: songs, sample: silent, songTime: plan.aStart + plan.aGain.silentFrom(limit: plan.length)), from: next)
+    case .transition(let t):
+      let t0 = sampleOfA(t.plan.aStart) - t.leadFrames
+      // Anywhere in the lead the two files hold the same sound: the middle, or as soon after it as can still be.
+      let cut = max(at, scheduledEnd, soonest)
+      guard cut <= t0 + t.leadFrames, transitionDeck.segment == nil else { return missed(item) }
+      let bAt = t0 + t.leadFrames + t.lengthFrames
+      let id = UUID()
+      cur.end(at: cut)
+      transitionDeck.load(
+        id: id, source: TransitionFileSource(t, from: cut - t0, to: t.leadFrames + t.lengthFrames), firstFrame: 0, expectedFrames: .max,
+        holdback: 0, envelope: GainEnvelope())
+      transitionDeck.place(at: cut)
+      next.place(at: bAt)
+      mix = MixInProgress(
+        to: item.id, plan: t.plan, way: .server, start: t0 + t.leadFrames, switchSample: t0 + t.leadFrames + EngineFormat.frames(t.plan.switchAt),
+        end: bAt)
+      let cutTime = t.plan.aStart + EngineFormat.seconds(cut - t0 - t.leadFrames)
+      report(.mixIn, MixReport(kind: .mixIn, way: .server, songs: songs, sample: cut, songTime: cutTime), from: transitionDeck, id: id)
+      report(.mixOut, MixReport(kind: .mixOut, way: .server, songs: songs, sample: bAt, songTime: t.plan.bResume), from: next)
+    }
+    pumpAgain = true
+  }
+
+  /// The join couldn't be placed in time: the next song follows gapless instead, from its start.
+  private func missed(_ item: EngineItem) {
+    current?.hold(at: nil)
+    upcomingDeck?.release()
+    upcomingDeck = nil
+    upcoming = (item, .crossfade(seconds: 0))
+    events.append(.mixMissed(item.id))
+    pumpAgain = true
+  }
+
+  private func report(_ kind: MixReport.Kind, _ report: MixReport, from deck: Deck, id: UUID? = nil) {
+    mixReports[kind] = report
+    if let id = id ?? deck.segment?.id { reportSources[kind] = (deck, id) }
+  }
+
+  /// Each report's headroom, once its first audio is scheduled.
+  private func refreshReports() {
+    for (kind, source) in reportSources {
+      guard let s = source.deck.segment, s.id == source.id, let headroom = s.firstHeadroom else { continue }
+      mixReports[kind]?.headroom = EngineFormat.seconds(headroom)
+      reportSources[kind] = nil
+    }
+  }
+
   private func advance(now: SampleTime) {
-    guard nodesStarted, let next = upcomingDeck, let s = next.segment, let start = s.timelineStart, now >= start else { return }
+    guard nodesStarted, let next = upcomingDeck, let s = next.segment, let start = s.timelineStart else { return }
+    // In a mix the next song takes over at the switch, in the middle of the blend.
+    let switchAt = mix.flatMap { $0.to == s.id ? $0.switchSample : nil } ?? start
+    guard now >= switchAt else { return }
     current = next
     upcomingDeck = nil
     upcoming = nil
@@ -301,6 +432,7 @@
       }
     }
     if let s = transitionDeck.segment, let end = s.end, s.fullyScheduled, now >= end { transitionDeck.release() }
+    if let m = mix, now >= m.end { mix = nil }
   }
 
   private func startWhenReady(now: SampleTime) {
@@ -314,7 +446,7 @@
   private func watchBuffer(now: SampleTime) {
     guard state == .playing || state == .buffering else { return }
     let low = EngineFormat.frames(tuning.lowWater)
-    let audible = decks.compactMap(\.segment).filter { s in
+    let audible = (decks + [transitionDeck]).compactMap(\.segment).filter { s in
       guard let start = s.timelineStart else { return false }
       return start <= now + low && !s.fullyScheduled
     }
@@ -339,14 +471,56 @@
 
   // MARK: Epochs
 
-  private func open(_ item: EngineItem, on deck: Deck) {
+  /// Where an item's audio comes from for a join: the frame its source opens at, the song frame its segment starts at
+  /// (they differ when B is resampled), the server's rest of it, and the gain.
+  struct SourcePlan: Equatable {
+    var readFrom: Int64
+    var firstFrame: Int64
+    var varispeed: TransitionPlan?
+    var continuation: EngineItem.Continuation?
+    var gainDb: Double
+  }
+
+  func sourcePlan(_ item: EngineItem, _ join: Join?) -> SourcePlan {
+    var frame = EngineFormat.frames(item.startAt)
+    switch join {
+    case .transition(let t)?:
+      frame = EngineFormat.frames(t.plan.bResume)
+    case .cut(let c)?:
+      frame = EngineFormat.frames(c.bStart)
+    case .mix(let plan)? where plan.bRate.contains(where: { abs($0.value - 1) > 1e-9 }):
+      // B resampled through the mix: its segment counts B's frames as they are after it.
+      let length = EngineFormat.frames(plan.length), end = EngineFormat.frames(plan.bResume)
+      let from = VarispeedSource.baseStart(plan: plan, lengthFrames: length, endFrame: end)
+      return SourcePlan(readFrom: from, firstFrame: end - length, varispeed: plan, continuation: nil, gainDb: item.gainDb)
+    case .mix(let plan)?:
+      frame = EngineFormat.frames(plan.bStart)
+    case .crossfade?, nil:
+      break
+    }
+    // The server's rest of the song serves any frame from where it starts.
+    if let c = item.continuation, frame >= EngineFormat.frames(c.from) {
+      return SourcePlan(readFrom: frame, firstFrame: frame, varispeed: nil, continuation: c, gainDb: c.gainDb)
+    }
+    return SourcePlan(readFrom: frame, firstFrame: frame, varispeed: nil, continuation: nil, gainDb: item.gainDb)
+  }
+
+  private func open(_ item: EngineItem, on deck: Deck, join: Join? = nil) {
     items[item.id] = item
-    let firstFrame = EngineFormat.frames(item.startAt)
+    let plan = sourcePlan(item, join)
+    var opened = item
+    opened.continuation = plan.continuation
+    var source = makeSource(opened, plan.readFrom)
+    if let mix = plan.varispeed {
+      source = VarispeedSource(
+        base: source, baseStart: plan.readFrom, rate: mix.bRate, lengthFrames: EngineFormat.frames(mix.length),
+        endFrame: EngineFormat.frames(mix.bResume), plan: mix)
+    }
     let length = EngineFormat.frames(item.track.duration)
     // A fade is never longer than a third of the song (see JoinRules.fadeSeconds): no need to hold back more.
     deck.load(
-      id: item.id, source: makeSource(item, firstFrame), firstFrame: firstFrame, expectedFrames: max(0, length - firstFrame),
-      holdback: min(EngineFormat.frames(tuning.maxFade), length / 3), envelope: GainEnvelope(gainDb: item.gainDb))
+      id: item.id, source: source, firstFrame: plan.firstFrame, expectedFrames: max(0, length - plan.firstFrame),
+      holdback: min(EngineFormat.frames(tuning.maxFade), length / 3), envelope: GainEnvelope(gainDb: plan.gainDb))
   }
 
   /// Stops all nodes (clearing what they had scheduled and their clocks): the next start begins a new epoch at 0.
@@ -357,6 +531,9 @@
     nodesStarted = false
     lastNow = 0
     endReported = nil
+    // A mix doesn't survive a new epoch: the song shown plays on from where it was, on its own.
+    mix = nil
+    reportSources = [:]
   }
 
   /// Starts the three nodes at the same moment, so they share one timeline.
@@ -415,7 +592,9 @@
       wantsToPlay = false
       state = .idle
     } else if id == transitionDeck.segment?.id {
+      // The transition file wouldn't play: the song shown goes on from where it is, on its own.
       transitionDeck.release()
+      if mix != nil { reloadCurrent() }
     }
     events.append(.failed(id, playbackError))
     pump()
diff --git a/apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Player.swift b/apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Player.swift
--- a/apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Player.swift
+++ b/apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Player.swift
@@ -353,6 +353,8 @@
       // The sleep timer's "end of song": on to the next song, paused, for when you're back.
       if sleep.stopsAtSongEnd() { queue.playing = false }
       sync()
+    case .mixMissed:
+      break  // Task 12 handles it.
     case .failed(let id, let failure):
       guard loaded?.item.id == id else { return }
       error = failure.message
PATCH
git apply /tmp/phase5-task8-engine.patch
```

Expected: no output. (If it doesn't apply, see Conventions.)

**Step 4: Run them to see them pass, then everything**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter MixEngineTests 2>&1 | tail -1
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer 2>&1 | tail -1
```

Expected: `Test run with 7 tests in 1 suite passed`. Then the whole package passes, phase 3's engine and Player tests included: the crossfade path is unchanged.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/EngineItem.swift \
  apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Deck.swift \
  apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/AudioEngine.swift \
  apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Player.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/TransitionFiles.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/MixEngineTests.swift
git commit -F - <<'EOF'
Play DJ transitions, live mixes and beat cuts in the iOS engine, to the sample

A transition file plays on the third node with A cut inside its lead and B going on from bResume where it ends; fades
and quick mixes are played live from their curves, B resampled to land exactly; a mix that can't be placed in time
is missed and the songs join gapless.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 9: Which join, with DJ mix

`DJJoin.decide` picks the next song's join from the planner's answer, the downloaded file, the mix maps and where A is now (key decision 3). `playsAlbum` is `decks.ts`'s album-queue test. `djFadeSeconds` is the web's (the crossfade length, or 6 s).

**Files:**
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/DJJoin.swift`
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PlaybackSettings+DJ.swift`
- Test: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/DJJoinTests.swift`

**Step 1: Write the failing tests**

Create `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/DJJoinTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrPlayer

/// Which join DJ mix picks from what's known, as the web's prepareBridge and joinInto do (plus what plays live here).
struct DJJoinTests {
  let fixtures = MixFixtures.all
  let file = URL(filePath: "/tmp/transition-abc.flac")

  func context(_ result: TransitionPlanner.Result?, file: URL? = nil, maps: Bool = true, position: Double = 100, mode: MixMode = .auto) -> DJJoin.Context {
    DJJoin.Context(
      result: result, file: file, a: maps ? fixtures.song("steady") : nil, b: maps ? fixtures.song("close") : nil, mode: mode,
      sameAlbumInOrder: false, aDuration: 240, position: position, gainA: -3, gainB: 2)
  }

  func plan(_ style: TransitionStyle, aStart: Double = 200, rate: Double = 1) -> TransitionPlan {
    TransitionFiles.plan(style: style, aStart: aStart, length: 8, bResume: 16, switchAt: 4, bRate: [.init(at: 0, value: rate)])
  }

  @Test func aDownloadedTransitionPlaysWithTheRestOfAnMP3AtItsLevel() {
    let ready = TransitionAnswer.Ready(
      plan: plan(.long), url: "/transitions/abc.flac", continuationUrl: "/transitions/abc.rest.flac", tail: 3, lead: 3, levels: .init(a: -3, b: 0.5))
    let (join, rest) = DJJoin.decide(context(.answer(.ready(ready)), file: file))
    #expect(join == .transition(TransitionJoin(plan: ready.plan, file: file, leadFrames: 132_300, tailFrames: 132_300, correctionA: 0, correctionB: 1.5)))
    #expect(rest == EngineItem.Continuation(url: "/transitions/abc.rest.flac", from: 16, gainDb: 1.5))
  }

  @Test func notDownloadedYetOrTooLateItCutsOnTheBeat() {
    let ready = TransitionAnswer.ready(.init(plan: plan(.long), url: "/transitions/abc.flac", lead: 3))
    let beat = MixSequence.beatCut(fixtures.song("steady"), fixtures.song("close"), aDuration: 240, mode: .auto, sameAlbumInOrder: false)
    #expect(beat != nil)
    #expect(DJJoin.decide(context(.answer(ready))).join == .cut(beat!))
    #expect(DJJoin.decide(context(.answer(ready), file: file, position: 199.5)).join == .cut(beat!))
    #expect(DJJoin.decide(context(.gaveUp)).join == .cut(beat!))
  }

  @Test func aFadeOrAQuickMixNotMadeInTimeIsPlayedLive() {
    let fade = plan(.fade)
    #expect(DJJoin.decide(context(.answer(.pending(.init(plan: fade))))).join == .mix(fade))
    let quick = plan(.quick, rate: 0.985)
    #expect(DJJoin.decide(context(.answer(.pending(.init(plan: quick))))).join == .mix(quick))
    // A long blend's stretch needs the server's file.
    #expect(DJJoin.decide(context(.answer(.pending(.init(plan: plan(.long, rate: 0.95)))))).join != .mix(plan(.long, rate: 0.95)))
  }

  @Test func straightOnCutsWhereTheServerSaysOrGoesGapless() {
    var straight = plan(.straight, aStart: 238.7)
    straight.bStart = 0.2
    #expect(DJJoin.decide(context(.answer(.straight(.init(plan: straight))))).join == .cut(BeatCut(aEnd: 238.7, bStart: 0.2)))
    straight.aStart = 240
    straight.bStart = 0
    #expect(DJJoin.decide(context(.answer(.straight(.init(plan: straight))))).join == .crossfade(seconds: 0))
  }

  @Test func withoutAnswerOrMapsTheSongsFollowGaplessAndNoMixingNeverCuts() {
    #expect(DJJoin.decide(context(nil, maps: false)).join == .crossfade(seconds: 0))
    #expect(DJJoin.decide(context(.answer(.unavailable(.init(reason: "No mix map yet"))), maps: false)).join == .crossfade(seconds: 0))
    #expect(DJJoin.decide(context(nil, mode: .off)).join == .crossfade(seconds: 0))
  }
}
```

**Step 2: Run them to see them fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter DJJoinTests 2>&1 | grep -m1 -E '\.swift:[0-9]+:[0-9]+: .*error'
```

Expected: `…/DJJoinTests.swift:…: error: cannot find type 'DJJoin' in scope`.

**Step 3: Implement**

Create `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/DJJoin.swift`:

```swift
import Foundation
import PlayarrAPI

/// How the next song joins the one playing with DJ mix, from what's known: the server's answer, the transition's file
/// once downloaded, and the two songs' mix maps. As `prepareBridge` and `joinInto` in the web's AudioEngine.tsx, with
/// what a native engine adds: a fade or a quick mix the server planned but hasn't made in time is played live from
/// its plan (the web could only cut), B resampled for a quick mix's stretch. A long blend needs the server's file (its
/// stretch of up to 8% over half a minute would be heard as pitch): without it, a cut on the beat.
public enum DJJoin {
  /// A mix this close to where A is now is left alone: there's no time to place it.
  public static let minLead = 0.5
  /// A ready transition survives a seek that lands this long before its mix point (`READY_LEAD_S`).
  public static let readyLead = 1.0
  /// The most a quick mix played live stretches B (the planner's 2%, with room for rounding).
  public static let liveStretch = 0.021

  public struct Context: Sendable {
    public var result: TransitionPlanner.Result?
    /// The ready transition's file on this device, once downloaded.
    public var file: URL?
    public var a: MixMapEntry?
    public var b: MixMapEntry?
    public var mode: MixMode
    public var sameAlbumInOrder: Bool
    public var aDuration: Double
    /// Where A is now (seconds).
    public var position: Double
    /// The gains (dB) the songs play at.
    public var gainA: Double
    public var gainB: Double

    public init(
      result: TransitionPlanner.Result?, file: URL?, a: MixMapEntry?, b: MixMapEntry?, mode: MixMode, sameAlbumInOrder: Bool,
      aDuration: Double, position: Double, gainA: Double, gainB: Double
    ) {
      self.result = result
      self.file = file
      self.a = a
      self.b = b
      self.mode = mode
      self.sameAlbumInOrder = sameAlbumInOrder
      self.aDuration = aDuration
      self.position = position
      self.gainA = gainA
      self.gainB = gainB
    }
  }

  /// The join, and the server's rest of B to play after a transition (an MP3's), if any.
  public static func decide(_ c: Context) -> (join: Join, continuation: EngineItem.Continuation?) {
    if case .answer(.ready(let ready))? = c.result, let file = c.file, c.position < ready.plan.aStart - readyLead {
      // Only a FLAC rest streams as it downloads; a WAV one (a server without an encoder) would have to come whole.
      let rest = ready.continuationUrl.flatMap { url -> EngineItem.Continuation? in
        guard url.lowercased().hasSuffix(".flac") else { return nil }
        return EngineItem.Continuation(url: url, from: ready.plan.bResume, gainDb: c.gainB - (ready.levels?.b ?? 0))
      }
      return (.transition(TransitionJoin(ready, file: file, gainA: c.gainA, gainB: c.gainB)), rest)
    }
    if let plan = c.result?.plan {
      switch plan.style {
      case .straight:
        // Straight on is where the server says the songs' sounds end and start: a cut there, or gapless.
        guard let cut = MixSequence.straightCut(plan, aDuration: c.aDuration), cut.aEnd > c.position + minLead else {
          return (.crossfade(seconds: 0), nil)
        }
        return (.cut(cut), nil)
      case .fade where plan.aStart > c.position + minLead:
        return (.mix(plan), nil)
      case .quick where plan.aStart > c.position + minLead && plan.bRate.allSatisfy({ abs($0.value - 1) <= liveStretch }):
        return (.mix(plan), nil)
      default:
        break
      }
    }
    return (beatCut(c).map { .cut($0) } ?? .crossfade(seconds: 0), nil)
  }

  /// No mix to play: a cut on the beat, else one that leaves out the silence between the songs (both need maps).
  static func beatCut(_ c: Context) -> BeatCut? {
    guard let a = c.a, let b = c.b else { return nil }
    let cut =
      MixSequence.beatCut(a, b, aDuration: c.aDuration, mode: c.mode, sameAlbumInOrder: c.sameAlbumInOrder)
      ?? MixSequence.silenceCut(a, b, aDuration: c.aDuration, mode: c.mode, sameAlbumInOrder: c.sameAlbumInOrder)
    guard let cut, cut.aEnd > c.position + minLead else { return nil }
    return cut
  }
}

extension DJJoin {
  /// The queue plays `a`'s album (or its artist's albums, which come whole and in order): there, songs of the album
  /// in order are heard as one. Elsewhere (a playlist, a mix) they only happen to be in order (`playsAlbum`, decks.ts).
  public static func playsAlbum(_ source: PlaySource?, _ a: Track) -> Bool {
    guard let source else { return true }
    return source.href == "/albums/\(a.albumId)" || source.href == "/artists/\(a.artistId)"
  }
}
```

Create `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PlaybackSettings+DJ.swift`:

```swift
import Foundation

extension PlaybackSettings {
  /// With DJ mix, how long songs that can't be mixed on the beat fade into each other: the crossfade length, or 6 s
  /// when none is picked (`djFadeSeconds` in apps/web/src/lib/prefs.ts).
  public var djFadeSeconds: Double { crossfade > 0 ? crossfade : 6 }
}
```

**Step 4: Run them to see them pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter DJJoinTests 2>&1 | tail -1
```

Expected: `Test run with 5 tests in 1 suite passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/DJJoin.swift \
  apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PlaybackSettings+DJ.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/DJJoinTests.swift
git commit -F - <<'EOF'
Pick the next song's join with DJ mix: the server's transition, a live mix or a beat cut

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 10: Transition files in the stream cache

Transition files live beside the songs in `stream/` (as `transition-<name>`), are dropped with them least recently played first, and download outside the songs' fetch-ahead queue (they're needed by the mix point). A running download is never evicted.

**Files:**
- Modify: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/StreamCache.swift`
- Test: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/StreamCacheTests.swift`

**Step 1: Write the failing test**

A test at the end of `StreamCacheTests`:

```bash
cat > /tmp/phase5-task10-test.patch <<'PATCH'
diff --git a/apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/StreamCacheTests.swift b/apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/StreamCacheTests.swift
--- a/apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/StreamCacheTests.swift
+++ b/apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/StreamCacheTests.swift
@@ -46,4 +46,18 @@
     await cache.keepOnly([])
     await #expect(throws: CancellationError.self) { try await d.waitUntilFinished() }
   }
+
+  @Test func keepsTransitionFilesBesideTheSongsAndDownloadsEachOnce() async throws {
+    StubServer.serve("/transitions/abc.flac", .init(body: body))
+    let cache = cache()
+    #expect(await cache.completedTransition(named: "abc.flac") == nil)
+    let first = await cache.transition(named: "abc.flac", request: StubServer.request("/transitions/abc.flac"))
+    let again = await cache.transition(named: "abc.flac", request: StubServer.request("/transitions/abc.flac"))
+    #expect(first === again)
+    try await first.waitUntilFinished()
+    let file = try #require(await cache.completedTransition(named: "abc.flac"))
+    #expect(file.lastPathComponent == "transition-abc.flac")
+    #expect(try Data(contentsOf: file) == body)
+    #expect(StubServer.requests("/transitions/abc.flac").count == 1)
+  }
 }
PATCH
git apply /tmp/phase5-task10-test.patch
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter StreamCacheTests 2>&1 | grep -m1 -E '\.swift:[0-9]+:[0-9]+: .*error'
```

Expected: `…/StreamCacheTests.swift:…: error: value of type 'StreamCache' has no member 'completedTransition'`.

**Step 3: Implement**

```bash
cat > /tmp/phase5-task10-cache.patch <<'PATCH'
diff --git a/apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/StreamCache.swift b/apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/StreamCache.swift
--- a/apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/StreamCache.swift
+++ b/apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/StreamCache.swift
@@ -11,6 +11,7 @@
   private let configuration: @Sendable () -> URLSessionConfiguration
   private let retryDelay: Duration
   private var downloads: [Int: Download] = [:]
+  private var transitions: [String: Download] = [:]
   private var waiting: [(Track, URLRequest)] = []
 
   public init(
@@ -43,6 +44,31 @@
       configuration: configuration)
     d.onFinish { [weak self] in Task { await self?.finished() } }
     downloads[track.fileId] = d
+    d.start()
+    return d
+  }
+
+  /// A DJ transition's file on disk, beside the songs (and dropped with them, least recently played first). `name` is
+  /// the last part of its URL: the server names transitions by a hash of what they're made from.
+  public func transitionFile(named name: String) -> URL { directory.appending(path: "transition-\(name)") }
+
+  /// The whole transition file, if it's here. Marks it as just played.
+  public func completedTransition(named name: String) -> URL? {
+    let url = transitionFile(named: name)
+    guard FileManager.default.fileExists(atPath: url.path()) else { return nil }
+    try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path())
+    return url
+  }
+
+  /// The download of a transition file, started (or continued) if it isn't running. It isn't queued behind the songs
+  /// fetched ahead: it's needed by the mix point.
+  public func transition(named name: String, request: URLRequest) -> Download {
+    if let running = transitions[name], running.isActive || running.isFinished { return running }
+    let final = transitionFile(named: name)
+    let d = Download(
+      request: request, file: final.appendingPathExtension("part"), finalFile: final, retryDelay: retryDelay, configuration: configuration)
+    d.onFinish { [weak self] in Task { await self?.finished() } }
+    transitions[name] = d
     d.start()
     return d
   }
@@ -91,7 +117,7 @@
   private func evict() {
     let keys: [URLResourceKey] = [.contentModificationDateKey, .fileSizeKey]
     guard let files = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: keys) else { return }
-    let busy = Set(downloads.values.filter(\.isActive).map(\.file))
+    let busy = Set((Array(downloads.values) + Array(transitions.values)).filter(\.isActive).map(\.file))
     var entries = files.compactMap { url -> (URL, Date, Int64)? in
       guard !busy.contains(url), let v = try? url.resourceValues(forKeys: Set(keys)) else { return nil }
       return (url, v.contentModificationDate ?? .distantPast, Int64(v.fileSize ?? 0))
PATCH
git apply /tmp/phase5-task10-cache.patch
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter StreamCacheTests 2>&1 | tail -1
```

Expected: `Test run with 5 tests in 1 suite passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/StreamCache.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/StreamCacheTests.swift
git commit -F - <<'EOF'
Keep DJ transition files in the phone's stream cache

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 11: The coordinator and the server's side

`TransitionCoordinator` owns the planner and the mix maps, and downloads a ready answer's file once. `Track.continuation(of:url:from:)` turns the server's rest of a song into a song of its own for `TrackSource` (a negative file id from its URL). `PlayerBackend` gains `transition(_:)`, `mixMaps(_:)` and `transitionRequest(_:)`, with the signatures phase 7's plan gives (its Task 6 then skips them). The tests' `FakeBackend` answers them as phase 7's does: answers by `"<from>-<to>"`, given in turn, and asks kept in a `Recorder` (phase 7's `Support/Recorder.swift`, created here in the same words). Task 12 tests all of this through the Player.

**Files:**
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/TransitionCoordinator.swift`
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Track+Continuation.swift`
- Modify: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PlayerBackend.swift`
- Create: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/Recorder.swift`
- Modify: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/FakeBackend.swift`
- Modify: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Demo/DemoPlayerBackend.swift` (phase 4's demo backend conforms to `PlayerBackend` too)

**Step 1: Write them**

Create `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/TransitionCoordinator.swift`:

```swift
import Foundation
import Observation
import PlayarrAPI

/// DJ mix's side of the player: asks for the transition into the next song (`TransitionPlanner`), downloads its file
/// whole into the stream cache once it's ready, and keeps the songs' mix maps (`MixMapStore`) for cuts on the beat, the
/// transition sheet and presses of Next. The Player asks it nothing directly: it reads `planner.upcoming`, `file(for:)`
/// and `mixMaps` when it picks the next song's join, and is told (`onChange`) when any of them moves.
@MainActor @Observable
public final class TransitionCoordinator {
  /// A press of Next waits for a mix into the same song starting within this long (`BRIDGE_SOON_S`).
  public static let mixSoon = 3.0

  public let planner: TransitionPlanner
  public let mixMaps: MixMapStore
  /// Transition files on this device, by the server's URL for them.
  public private(set) var files: [String: URL] = [:]
  /// Files that wouldn't download: those mixes play as if no file had come.
  public private(set) var failedFiles: Set<String> = []

  @ObservationIgnored public var onChange: (@MainActor () -> Void)?
  @ObservationIgnored private var downloading: [String: Task<Void, Never>] = [:]
  @ObservationIgnored private let download: @Sendable (String) async throws -> URL

  /// `download` fetches a transition file whole (into the stream cache) and answers where it is.
  public init(planner: TransitionPlanner, mixMaps: MixMapStore, download: @escaping @Sendable (String) async throws -> URL) {
    self.planner = planner
    self.mixMaps = mixMaps
    self.download = download
    planner.onChange = { [weak self] in self?.answerChanged() }
  }

  /// The planner's answer for `from` → `to`, if it's working on that pair.
  public func result(from: Track, to: Track) -> TransitionPlanner.Result? {
    let upcoming = planner.upcoming
    guard upcoming.fromFileId == from.fileId, upcoming.toFileId == to.fileId else { return nil }
    return upcoming.result
  }

  /// The ready answer's file, once it's all here.
  public func file(for result: TransitionPlanner.Result?) -> URL? {
    guard case .answer(.ready(let ready))? = result else { return nil }
    return files[ready.url]
  }

  /// Downloads the file of a ready answer, once: before it's needed, not as it plays.
  private func answerChanged() {
    if case .answer(.ready(let ready))? = planner.upcoming.result, files[ready.url] == nil, downloading[ready.url] == nil,
      !failedFiles.contains(ready.url)
    {
      let url = ready.url
      let download = self.download
      downloading[url] = Task { [weak self] in
        let file: URL?
        do { file = try await download(url) } catch { file = nil }
        guard let self else { return }
        if let file { self.files[url] = file } else { self.failedFiles.insert(url) }
        self.downloading[url] = nil
        self.onChange?()
      }
    }
    onChange?()
  }
}
```

Create `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Track+Continuation.swift`:

```swift
import Foundation
import PlayarrAPI

extension Track {
  /// The server's rest of `track` after a transition (`continuationUrl`), as a song of its own for `TrackSource`: it
  /// streams and caches like any file, under a file id of its own (negative, from its URL, so it never meets a real
  /// one), and starts at `from` seconds into the song.
  static func continuation(of track: Track, url: String, from: Double) -> Track {
    var hash: UInt32 = 2_166_136_261
    for byte in url.utf8 { hash = (hash ^ UInt32(byte)) &* 16_777_619 }
    var rest = track
    rest.fileId = -Int(hash & 0x7fff_ffff) - 1
    rest.streamUrl = url
    rest.duration = max(0, track.duration - from)
    rest.format = AudioFormat(codec: "FLAC", container: url.lowercased().hasSuffix(".wav") ? "wav" : "flac", lossless: true)
    return rest
  }
}
```

Create `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/Recorder.swift`:

```swift
import Synchronization

/// Values another task hands over, kept in order (events, requests).
final class Recorder<Value: Sendable>: Sendable {
  private let values = Mutex<[Value]>([])
  var all: [Value] { values.withLock { $0 } }
  func append(_ value: Value) { values.withLock { $0.append(value) } }
  func removeAll() { values.withLock { $0 = [] } }
}

/// A value tests change while another task reads it (the room left on the device).
final class Shared<Value: Sendable>: Sendable {
  private let storage: Mutex<Value>
  init(_ value: Value) { storage = Mutex(value) }
  var value: Value {
    get { storage.withLock { $0 } }
    set { storage.withLock { $0 = newValue } }
  }
}
```

```bash
cat > /tmp/phase5-task11-backend.patch <<'PATCH'
diff --git a/apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PlayerBackend.swift b/apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PlayerBackend.swift
--- a/apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PlayerBackend.swift
+++ b/apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PlayerBackend.swift
@@ -11,6 +11,12 @@
   /// The song's levelled stream at gain 0 (the phone applies the gain), authorized.
   func levelledRequest(_ track: Track) -> URLRequest
   func artwork(_ track: Track, size: Int) async -> Data?
+  /// `POST /api/transitions`.
+  func transition(_ request: TransitionRequest) async throws -> TransitionAnswer
+  /// `POST /api/mix-maps`, at most 50 at a time.
+  func mixMaps(_ recordingIds: [String]) async throws -> [String: MixMapEntry]
+  /// A transition file or the rest of a song after one (a path the server gave, `/transitions/…`), authorized.
+  func transitionRequest(_ path: String) -> URLRequest
 }
 
 /// The real server, through PlayarrAPI.
@@ -47,6 +53,18 @@
     media.request(for: media.levelled(track, gain: 0) ?? media.baseURL)
   }
 
+  public func transition(_ request: TransitionRequest) async throws -> TransitionAnswer {
+    try await client.send(API.Playback.transition(request))
+  }
+
+  public func mixMaps(_ recordingIds: [String]) async throws -> [String: MixMapEntry] {
+    try await client.send(API.Playback.mixMaps(ids: recordingIds))
+  }
+
+  public func transitionRequest(_ path: String) -> URLRequest {
+    media.request(for: media.transition(path) ?? media.baseURL)
+  }
+
   public func artwork(_ track: Track, size: Int) async -> Data? {
     guard let url = media.art(track.coverUrl, size: size),
       let (data, response) = try? await session.data(for: media.request(for: url)),
diff --git a/apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/FakeBackend.swift b/apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/FakeBackend.swift
--- a/apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/FakeBackend.swift
+++ b/apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/FakeBackend.swift
@@ -21,6 +21,25 @@
   func streamRequest(_ track: Track) -> URLRequest { StubServer.request(track.streamUrl) }
   func levelledRequest(_ track: Track) -> URLRequest { StubServer.request(track.streamUrl + "/levelled.wav") }
   func artwork(_ track: Track, size: Int) async -> Data? { nil }
+
+  /// Answers for POST /api/transitions by "<from id>-<to id>", in turn (the last one repeats); unavailable otherwise.
+  let transitionAnswers = Mutex<[String: [TransitionAnswer]]>([:])
+  let transitionAsks = Recorder<TransitionRequest>()
+  let mixMapTable = Mutex<[String: MixMapEntry]>([:])
+
+  func transition(_ request: TransitionRequest) async throws -> TransitionAnswer {
+    transitionAsks.append(request)
+    return transitionAnswers.withLock { table in
+      let key = "\(request.from)-\(request.to)"
+      guard let answers = table[key], let first = answers.first else { return .unavailable(.init(reason: "No mix map yet")) }
+      if answers.count > 1 { table[key] = Array(answers.dropFirst()) }
+      return first
+    }
+  }
+  func mixMaps(_ recordingIds: [String]) async throws -> [String: MixMapEntry] {
+    mixMapTable.withLock { table in table.filter { recordingIds.contains($0.key) } }
+  }
+  func transitionRequest(_ path: String) -> URLRequest { StubServer.request(path) }
 }
 
 extension Player {
PATCH
git apply /tmp/phase5-task11-backend.patch
```

If phase 2 named the transition URL differently than `MediaURLs.transition(_:)`, change it in `APIBackend.transitionRequest` only.

Phase 4's `DemoPlayerBackend` (the `-UITestsDemo` library, no server) gets the three calls too, at the end of the struct. The demo has no analysis, so it answers as a server without it:

```swift
  /// The demo has no analysis, so no mixes: DJ mix cuts or plays gapless.
  public func transition(_ request: TransitionRequest) async throws -> TransitionAnswer {
    .unavailable(.init(reason: "Mixed transitions need audio analysis"))
  }
  public func mixMaps(_ recordingIds: [String]) async throws -> [String: MixMapEntry] { [:] }
  public func transitionRequest(_ path: String) -> URLRequest { URLRequest(url: Demo.baseURL.appending(path: path)) }
```

**Step 2: Everything still passes**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer 2>&1 | tail -1
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI 2>&1 | tail -1
```

Expected: `Test run with … tests in … suites passed` (the count from Task 0 plus 43: 146 on `main` after phase 4), and `PlayarrUI` still builds and passes.

**Step 3: Commit**

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/TransitionCoordinator.swift \
  apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Track+Continuation.swift \
  apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PlayerBackend.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/Recorder.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/FakeBackend.swift \
  apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Demo/DemoPlayerBackend.swift
git commit -F - <<'EOF'
Ask the server for transitions and mix maps from the player, and download ready files

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 12: The Player mixes

`Player` owns `transitions` (built with the stream cache's downloads and the scheduler, which tests replace), and:

- tells the planner the pair (with the levels the songs play at) and the clock;
- loads mix maps for the current and next song;
- keeps 2.5 s scheduled with DJ mix;
- picks each next song's join with `DJJoin`, or a press's mix (`takeNextPress`, key decision 5);
- handles `.advanced` for presses (skipped) and the sleep timer (pause where the mix ends), and `.mixMissed` (no second try; a press becomes a plain skip);
- opens a continuation through `TrackSource`;
- exposes `upcomingMixMissed` for Stats for nerds;
- has `mixPointsChanged(recordingId:)`, the hook phase 8's Edit mix points calls after saving. It asks for the song's map again and asks afresh for a coming transition made with the old points (the web's `forgetMixMap` and `refreshUpcomingTransition`).

**Files:**
- Modify: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Player.swift`
- Modify: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/FakeBackend.swift` (`Player.testing` takes a scheduler and per-song signals)
- Test: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/PlayerTransitionTests.swift`

**Step 1: Write the failing tests**

Create `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/PlayerTransitionTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrPlayer

/// DJ mix through the Player: asking, the transition file, presses of Next, the sleep timer, mixing off.
@MainActor
@Suite(.serialized)
struct PlayerTransitionTests {
  let clock = ManualScheduling()
  let backend = FakeBackend()
  let directory = temporaryDirectory()

  func player() throws -> Player {
    let settings = PlaybackSettings(defaults: UserDefaults(suiteName: UUID().uuidString)!)
    settings.transitions = .dj
    return try Player.testing(backend, directory: directory, settings: settings, scheduler: clock)
  }

  /// Plays `seconds` in steps of 0.1 s, the clock moving with the audio.
  func play(_ player: Player, for seconds: Double) async throws {
    for _ in 0..<Int((seconds * 10).rounded()) {
      _ = try await player.engine.render(seconds: 0.1)
      clock.advance(by: 0.1)
      player.tick()
      await player.transitions.planner.inFlight?.value
      await Task.yield()
    }
  }

  let a = song(1, duration: 30), b = song(2, albumId: 2, duration: 60)

  @Test func asksWithTheGainsThePhonePlaysEachSongAt() async throws {
    backend.levelTable.withLock { $0 = ["rec-1": TrackLevel(track: -5), "rec-2": TrackLevel(track: 3)] }
    let player = try player()
    player.play([a, b])
    try await play(player, for: 6)
    let asked = try #require(backend.transitionAsks.all.last)
    #expect(asked.from == 1 && asked.to == 2 && asked.mode == .auto)
    #expect(asked.levels == .init(a: 0, b: 3))  // A was loaded before its level came: it plays at 0 dB to its end
    #expect(asked.fade == 6)
  }

  @Test func aReadyTransitionIsDownloadedAndPlayedAndTheQueueMovesOnAtTheSwitch() async throws {
    // A's mix point at 30 s (asked at 5 s, more than 20 s before it); a 1 s lead, 2 s of transition, B on from 10 s.
    let plan = TransitionFiles.plan(aStart: 30, length: 2, bResume: 10, switchAt: 1)
    backend.transitionAnswers.withLock { $0["1-2"] = [.ready(.init(plan: plan, url: "/transitions/abc.flac", tail: 1, lead: 1))] }
    // Already in the stream cache, as if downloaded: the coordinator takes it from there.
    let file = try TransitionFiles.flac(frames: 4 * 44_100) { _, _ in 0.1 }
    try FileManager.default.createDirectory(at: directory.appending(path: "stream"), withIntermediateDirectories: true)
    try FileManager.default.copyItem(at: file, to: directory.appending(path: "stream/transition-abc.flac"))
    let player = try player()
    player.play([song(1, duration: 60), b])
    try await play(player, for: 6)
    guard case .transition(let join)? = player.upcoming?.join else {
      Issue.record("no transition: \(String(describing: player.upcoming?.join))")
      return
    }
    #expect(join.leadFrames == 44_100)
    player.seek(to: 27)  // a ready transition survives a seek that lands before its mix point
    try await play(player, for: 3.5)  // 30.5 s: in the transition, before the switch
    #expect(player.queue.pos == 0)
    #expect(player.engine.mix?.way == .server)
    try await play(player, for: 1)  // past the switch at 31 s
    #expect(player.queue.pos == 1)
    #expect(abs(player.time - 9.5) < 0.2)  // B's time: in from 8 s, on from 10 s at the transition's end
    #expect(player.engine.mixReports[.mixIn]?.sample == player.engine.mixReports[.mixOut].map { $0.sample - 2 * 44_100 - 44_100 / 2 })
  }

  @Test func aPressOfNextMixesOnTheNextBar() async throws {
    let fixtures = MixFixtures.all
    backend.mixMapTable.withLock { $0 = ["rec-1": fixtures.song("steady"), "rec-2": fixtures.song("close")] }
    let player = try player()
    player.play([a, b])
    try await play(player, for: 3)
    player.next()
    #expect(player.queue.pos == 0)  // A plays on until the mix
    guard case .mix(let plan)? = player.upcoming?.join else {
      Issue.record("no mix: \(String(describing: player.upcoming?.join))")
      return
    }
    #expect(plan.style == .quick)
    #expect(plan.aStart >= 3 + 2.5 + 0.5 + 0.25 - 0.11)
    #expect(plan.aStart <= 3 + 2.5 + 0.5 + 0.25 + 4 * 0.5)  // the next bar line, a 2- or 4-beat lead-in
    try await play(player, for: plan.aStart - player.time + plan.switchAt + 0.3)
    #expect(player.queue.pos == 1)
    await eventually { !backend.plays.withLock { $0.isEmpty } }
    #expect(backend.plays.withLock { $0.first?.skipped } == true)
  }

  @Test func pressedAgainWhileItWaitsTheSongChangesAtOnce() async throws {
    let fixtures = MixFixtures.all
    backend.mixMapTable.withLock { $0 = ["rec-1": fixtures.song("steady"), "rec-2": fixtures.song("close")] }
    let player = try player()
    player.play([a, b])
    try await play(player, for: 3)
    player.next()
    player.next()
    #expect(player.queue.pos == 1)
  }

  @Test func withoutMixMapsAPressOfNextIsAPlainSkip() async throws {
    let player = try player()
    player.play([a, b])
    try await play(player, for: 3)
    player.next()
    #expect(player.queue.pos == 1)
  }

  @Test func theSleepTimersEndOfSongAsksForNoTransition() async throws {
    let player = try player()
    player.play([a, b])
    player.sleepAtEndOfSong()
    try await play(player, for: 7)
    #expect(backend.transitionAsks.all.isEmpty)
    #expect(player.upcoming == nil)
  }

  @Test func noMixingAsksNothingAndPlaysTheNextSongGapless() async throws {
    let fixtures = MixFixtures.all
    backend.mixMapTable.withLock { $0 = ["rec-1": fixtures.song("steady"), "rec-2": fixtures.song("close")] }
    let player = try player()
    player.play([a, b])
    player.setMixMode(.off)
    try await play(player, for: 7)
    #expect(backend.transitionAsks.all.isEmpty)
    #expect(player.upcoming?.join == .crossfade(seconds: 0))
  }

  @Test func djMixKeepsLessScheduledAhead() throws {
    let player = try player()
    player.play([a, b])
    #expect(player.engine.tuning.scheduleAhead == 2.5)
    player.settings.transitions = .crossfade
    player.play([a, b])
    #expect(player.engine.tuning.scheduleAhead == 10)
  }

  @Test func aClosedSessionAsksForNoMoreTransitions() async throws {
    let player = try player()
    player.play([a, b])
    try await play(player, for: 1)
    player.shutDown()
    clock.advance(by: 30)
    await player.transitions.planner.inFlight?.value
    #expect(backend.transitionAsks.all.isEmpty)
    #expect(player.transitions.planner.upcoming == .init())
  }

  @Test func editedMixPointsAskAgainForTheMapAndTheTransition() async throws {
    let fixtures = MixFixtures.all
    backend.mixMapTable.withLock { $0 = ["rec-1": fixtures.song("steady"), "rec-2": fixtures.song("close")] }
    let player = try player()
    player.play([a, b])
    try await play(player, for: 8)
    let asks = backend.transitionAsks.all.count
    #expect(asks == 1)
    backend.mixMapTable.withLock { $0["rec-2"] = fixtures.song("cues") }
    player.mixPointsChanged(recordingId: "rec-2")
    try await play(player, for: 3)
    #expect(backend.transitionAsks.all.count == asks + 1)
    #expect(player.transitions.mixMaps.map("rec-2") == fixtures.song("cues"))
  }
}
```

**Step 2: Run them to see them fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter PlayerTransitionTests 2>&1 | grep -m1 -E '\.swift:[0-9]+:[0-9]+: .*error'
```

Expected: `…/PlayerTransitionTests.swift:…: error: extra argument 'scheduler' in call`.

**Step 3: Implement**

The patch is made against `main` after phase 4, whose `Player` asks for a radio once per song (`radioAskedAt`), and has `shutDown()` for a closed account session: `shutDown()` also drops the planner's pair, so a closed session asks the server nothing more (the test `aClosedSessionAsksForNoMoreTransitions`).

```bash
cat > /tmp/phase5-task12-player.patch <<'PATCH'
diff --git a/apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Player.swift b/apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Player.swift
--- a/apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Player.swift
+++ b/apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Player.swift
@@ -34,6 +34,8 @@ public final class Player {
   public let settings: PlaybackSettings
   public let levels: LevelStore
   public let sleep = SleepTimer()
+  /// DJ mix: the transition into the next song, its file, the songs' mix maps.
+  public let transitions: TransitionCoordinator
 
   @ObservationIgnored public private(set) var engine: AudioEngine
   @ObservationIgnored public var nowPlaying: NowPlayingBridge?
@@ -54,19 +56,42 @@ public final class Player {
   /// The song whose start was last checked for a radio continuation.
   @ObservationIgnored private var radioAskedAt: Entry?
   @ObservationIgnored private var ticker: Task<Void, Never>?
+  /// A press of Next being mixed live into the next song: its item and the mix (kept over later syncs).
+  @ObservationIgnored private var pressed: (id: UUID, join: Join)?
+  /// A press of Next waiting for the mix into that song about to start.
+  @ObservationIgnored private var pressAwaits: UUID?
+  /// Items whose mix couldn't be placed in time: they follow gapless.
+  @ObservationIgnored private var missedMixes: Set<UUID> = []
+  /// The sleep timer ended the song in the middle of a mix: the music stops where the mix ends.
+  @ObservationIgnored private var pauseAtMixEnd: SampleTime?
+  @ObservationIgnored private var seekedSinceTick = false
+
+  /// The next song's mix couldn't be placed in time: it follows gapless (Stats for nerds says so).
+  public var upcomingMixMissed: Bool { upcoming.map { missedMixes.contains($0.item.id) } ?? false }
+
+  /// With DJ mix the engine keeps 2.5 s scheduled (not 10), so a press of Next mixes a few seconds after it.
+  static let djScheduleAhead = 2.5
+  /// Room for scheduling between a press of Next and where its mix may start.
+  static let pressMargin = 0.25
 
   /// `directory` is this server and account's folder in Application Support: the queue, unsent plays and the stream
   /// cache live there. `makeSource` replaces the real sources (tests); `makeEngine` the real engine.
   public init(
     backend: any PlayerBackend, directory: URL, settings: PlaybackSettings = PlaybackSettings(),
     makeEngine: (@MainActor (@escaping @MainActor (EngineItem, Int64) -> any PCMSource) throws -> AudioEngine)? = nil,
-    makeSource: (@MainActor (EngineItem, Int64) -> any PCMSource)? = nil
+    makeSource: (@MainActor (EngineItem, Int64) -> any PCMSource)? = nil, scheduler: (any Scheduling)? = nil
   ) throws {
     let cache = StreamCache(directory: directory.appending(path: "stream", directoryHint: .isDirectory))
     let levels = LevelStore { ids in try await backend.levels(ids) }
     let reports = PlayReportQueue(file: directory.appending(path: "pending-plays.json")) { try await backend.reportPlays($0) }
     let sources: @MainActor (EngineItem, Int64) -> any PCMSource = makeSource ?? { item, frame in
-      TrackSource(
+      // After a transition into an MP3: the server's rest of it, which runs on from the transition sample for sample.
+      if let rest = item.continuation {
+        return TrackSource(
+          track: Track.continuation(of: item.track, url: rest.url, from: rest.from), firstFrame: frame - EngineFormat.frames(rest.from),
+          origin: TrackSource.Origin(stream: backend.transitionRequest(rest.url), levelled: nil), cache: cache)
+      }
+      return TrackSource(
         track: item.track, firstFrame: frame,
         origin: TrackSource.Origin(
           stream: backend.streamRequest(item.track),
@@ -74,6 +99,17 @@ public final class Player {
         cache: cache)
     }
     let build = { try makeEngine?(sources) ?? AudioEngine(makeSource: sources) }
+    let scheduler = scheduler ?? TaskScheduling()
+    transitions = TransitionCoordinator(
+      planner: TransitionPlanner(scheduler: scheduler) { try await backend.transition($0) },
+      mixMaps: MixMapStore(scheduler: scheduler) { try await backend.mixMaps($0) },
+      download: { path in
+        let name = URL(string: path)?.lastPathComponent ?? path
+        if let kept = await cache.completedTransition(named: name) { return kept }
+        let download = await cache.transition(named: name, request: backend.transitionRequest(path))
+        try await download.waitUntilFinished()
+        return await cache.transitionFile(named: name)
+      })
     self.backend = backend
     self.settings = settings
     self.levels = levels
@@ -86,6 +122,9 @@ public final class Player {
     tracker = PlayTracker { _ in }
     tracker = PlayTracker { [weak self] plays in self?.report(plays) }
     engine.onEvent = { [weak self] in self?.handle($0) }
+    transitions.planner.isPlaying = { [weak self] in self?.queue.playing ?? false }
+    transitions.planner.isOnline = { [weak self] in self?.network() != .offline }
+    transitions.onChange = { [weak self] in self?.updateUpcoming() }
     sync()
     Task { await reports.retry() }
   }
@@ -116,8 +155,11 @@ public final class Player {
   public func move(from: Int, to: Int) { change { $0.move(from: from, to: to) } }
   public func setUpcoming(_ queueIndices: [Int]) { change { $0.setUpcoming(queueIndices) } }
   public func clearUpcoming() { change { $0.clearUpcoming() } }
-  /// A press of Next.
-  public func next() { change { $0.next() } }
+  /// A press of Next. With DJ mix it's mixed into the next song on the next bar, when it can be (see `takeNextPress`).
+  public func next() {
+    if takeNextPress() { return }
+    change { $0.next() }
+  }
   /// Restarts the song past 3 s, else goes back one.
   public func previous() { change { [time] in $0.prev(currentTime: time) } }
   public func toggleShuffle() { change { $0.toggleShuffle() } }
@@ -136,6 +178,7 @@ public final class Player {
   public func seek(to seconds: Double) {
     guard loaded != nil else { return }
     tracker.pause()
+    seekedSinceTick = true
     engine.seek(to: seconds)
     time = seconds
     showNowPlaying()
@@ -199,6 +242,8 @@ public final class Player {
     ticker = nil
     appWillTerminate()
     queue.playing = false
+    // A closed session asks the server nothing more.
+    transitions.planner.update(wanted: nil, playing: nil)
     engine.stop()
     nowPlaying?.update(track: nil, elapsed: 0, playing: false)
     nowPlaying?.unregister()
@@ -212,6 +257,13 @@ public final class Player {
     buffered = engine.bufferedAhead
     loading = engine.state == .loading || engine.state == .buffering
     if engine.state == .playing { tracker.tick(time) } else { tracker.pause() }
+    transitions.planner.clock(time, seeked: seekedSinceTick)
+    seekedSinceTick = false
+    if let end = pauseAtMixEnd, engine.now >= end {
+      // The sleep timer: the mix played out, and the next song waits here, paused.
+      pauseAtMixEnd = nil
+      setPlaying(false)
+    }
     let volume = queue.muted ? 0 : Float(queue.volume * queue.volume)
     engine.setMasterGain(volume * sleep.gain(at: now))
     if sleep.runsOut(at: now) {
@@ -248,6 +300,7 @@ public final class Player {
         engine.pause()
       }
     }
+    updateTransitions()
     updateUpcoming()
     loadLevels()
     continueRadio()
@@ -272,6 +325,9 @@ public final class Player {
     queue.startAt = nil
     firstLoad = false
     let item = EngineItem(track: track, gainDb: gainDb(track), startAt: start)
+    pressed = nil
+    pressAwaits = nil
+    pauseAtMixEnd = nil
     loaded = (entry, item)
     upcoming = nil
     error = nil
@@ -281,8 +337,11 @@ public final class Player {
   }
 
   /// Tells the engine what plays after the current song and how: the album in order never fades (JoinRules), repeat
-  /// one plays the song again without a gap, the sleep timer's "end of song" plays nothing after it.
+  /// one plays the song again without a gap, the sleep timer's "end of song" plays nothing after it. With DJ mix, the
+  /// join DJJoin picks (a transition, a mix played live, a cut on the beat), or a press of Next's mix.
   private func updateUpcoming() {
+    // A mix already placed plays out (the sleep timer then stops where it ends): taking it back would cost a new epoch.
+    if sleep.endOfSong, engine.upcomingPlaced, upcoming?.join.leaveTime != nil { return }
     guard let current = loaded, !sleep.endOfSong,
       let index = queue.repeatMode == .one ? current.entry.index : queue.upNextIndex
     else {
@@ -291,11 +350,100 @@ public final class Player {
       return
     }
     let track = queue.queue[index]
-    let fade = queue.repeatMode == .one ? 0 : JoinRules.fadeSeconds(current.item.track, track, crossfade: settings.crossfadeSeconds)
     let id = upcoming?.index == index ? upcoming?.item.id ?? UUID() : UUID()
-    let item = EngineItem(id: id, track: track, gainDb: gainDb(track))
-    upcoming = (index, item, .crossfade(seconds: fade))
-    engine.setUpcoming(item, join: .crossfade(seconds: fade))
+    var item = EngineItem(id: id, track: track, gainDb: gainDb(track))
+    let join: Join
+    if let pressed, pressed.id == id {
+      join = pressed.join
+    } else if settings.transitions == .dj, queue.repeatMode != .one, track.fileId != current.item.track.fileId, !missedMixes.contains(id) {
+      let decided = DJJoin.decide(djContext(current.item, track, gainB: item.gainDb))
+      join = decided.join
+      item.continuation = decided.continuation
+    } else {
+      let fade = queue.repeatMode == .one ? 0 : JoinRules.fadeSeconds(current.item.track, track, crossfade: settings.crossfadeSeconds)
+      join = .crossfade(seconds: fade)
+    }
+    upcoming = (index, item, join)
+    engine.setUpcoming(item, join: join)
+  }
+
+  private func djContext(_ a: EngineItem, _ b: Track, gainB: Double) -> DJJoin.Context {
+    let result = transitions.result(from: a.track, to: b)
+    return DJJoin.Context(
+      result: result, file: transitions.file(for: result), a: transitions.mixMaps.map(a.track.recordingId),
+      b: transitions.mixMaps.map(b.recordingId), mode: queue.mixMode,
+      sameAlbumInOrder: JoinRules.continues(a.track, b) && DJJoin.playsAlbum(queue.source, a.track), aDuration: a.track.duration,
+      position: time, gainA: a.gainDb, gainB: gainB)
+  }
+
+  /// DJ mix: the pair the planner asks the server about (none with mixing off, no next song, or the sleep timer
+  /// ending this song), at the levels the songs play at; the songs' mix maps; and less scheduled ahead.
+  private func updateTransitions() {
+    engine.tuning.scheduleAhead = settings.transitions == .dj ? Self.djScheduleAhead : AudioEngine.Tuning().scheduleAhead
+    guard settings.transitions == .dj, let current = loaded else {
+      transitions.planner.update(wanted: nil, playing: nil)
+      return
+    }
+    let a = current.item
+    let next = queue.upNext.flatMap { $0.fileId == a.track.fileId ? nil : $0 }
+    var wanted: TransitionPlanner.Pair?
+    if let next, queue.mixMode != .off, !sleep.endOfSong {
+      let gainB = gainDb(next)
+      wanted = TransitionPlanner.Pair(
+        from: a.track, to: next, mode: queue.mixMode, fade: settings.djFadeSeconds, albumQueue: DJJoin.playsAlbum(queue.source, a.track),
+        levels: a.gainDb != 0 || gainB != 0 ? .init(a: a.gainDb, b: gainB) : nil)
+    }
+    transitions.planner.update(wanted: wanted, playing: (a.track.fileId, current.entry.token))
+    let maps = transitions.mixMaps
+    if maps.map(a.track.recordingId) == nil || next.map({ maps.map($0.recordingId) == nil }) == true {
+      Task {
+        await maps.load([a.track, next])
+        updateUpcoming()
+      }
+    }
+  }
+
+  /// A song's mix points were edited (phase 8's Edit mix points): its map is asked for again, and a coming transition
+  /// planned with the old points is asked for afresh (the web's `forgetMixMap` and `refreshUpcomingTransition`).
+  public func mixPointsChanged(recordingId: String) {
+    let maps = transitions.mixMaps
+    maps.forget(recordingId)
+    transitions.planner.refresh(recordingId: recordingId)
+    let tracks = [queue.currentTrack, queue.upNext].filter { $0?.recordingId == recordingId }
+    guard !tracks.isEmpty else { return }
+    Task {
+      await maps.load(tracks)
+      updateUpcoming()
+    }
+  }
+
+  /// A press of Next with DJ mix: taken over (true) to mix into the song it goes to on A's next bar (planned here, as
+  /// the server never plans skips), or to wait for a mix into that song about to start; else the queue moves on at
+  /// once. Pressed again while waiting: no more waiting. As `takeNext` in the web's AudioEngine.tsx, which only a
+  /// desktop browser could do; the engine here mixes it with both songs' own audio, on the lock screen too.
+  private func takeNextPress() -> Bool {
+    if pressAwaits != nil || pressed != nil {
+      pressAwaits = nil
+      pressed = nil
+      return false
+    }
+    guard settings.transitions == .dj, queue.mixMode != .off, queue.repeatMode != .one, queue.playing, !sleep.endOfSong,
+      engine.state == .playing, engine.mix == nil, !engine.upcomingPlaced, let current = loaded, let to = queue.nextByPress,
+      to.fileId != current.item.track.fileId, let index = queue.upNextIndex, queue.queue[index].fileId == to.fileId
+    else { return false }
+    if let up = upcoming, up.index == index, let begins = up.join.mixBegins, begins - time >= -1, begins - time <= TransitionCoordinator.mixSoon {
+      pressAwaits = up.item.id
+      return true
+    }
+    guard let a = transitions.mixMaps.map(current.item.track.recordingId), let b = transitions.mixMaps.map(to.recordingId) else { return false }
+    let at = time + engine.tuning.scheduleAhead + engine.tuning.block + Self.pressMargin
+    let sameAlbum = JoinRules.continues(current.item.track, to) && DJJoin.playsAlbum(queue.source, current.item.track)
+    let plan = SkipPlanner.plan(a: a, b: b, mode: queue.mixMode, sameAlbumInOrder: sameAlbum, at: at)
+    guard plan.style != .straight else { return false }
+    let id = upcoming?.index == index ? upcoming?.item.id ?? UUID() : UUID()
+    pressed = (id, .mix(plan))
+    updateUpcoming()
+    return true
   }
 
   private func gainDb(_ track: Track) -> Double {
@@ -306,7 +454,9 @@ public final class Player {
     let tracks = [queue.currentTrack, queue.upNext]
     Task {
       await levels.load(tracks)
-      updateUpcoming()  // the next song's gain, if it came in time
+      // The next song's gain, if it came in time; with DJ mix the transition is asked for at it.
+      updateTransitions()
+      updateUpcoming()
     }
   }
 
@@ -353,8 +503,15 @@ public final class Player {
     switch event {
     case .advanced(let id):
       guard let joined = upcoming, joined.item.id == id else { return }
-      // Joined on its own at the end of the song: heard through.
-      tracker.finish(.ended)
+      // Joined on its own at the end of the song: heard through; mixed for a press of Next: skipped.
+      let skipped = pressed?.id == id || pressAwaits == id
+      pressed = nil
+      pressAwaits = nil
+      tracker.finish(skipped ? .changed : .ended)
+      // The sleep timer ends this song: in a mix, the music stops where the mix ends; at a cut, here.
+      if sleep.stopsAtSongEnd() {
+        if let mix = engine.mix, mix.to == id { pauseAtMixEnd = mix.end } else { queue.playing = false }
+      }
       tracker.start(joined.item.track)
       queue.next(auto: true)
       if let entry = currentEntry { loaded = (entry, joined.item) }
@@ -369,8 +526,14 @@ public final class Player {
       // The sleep timer's "end of song": on to the next song, paused, for when you're back.
       if sleep.stopsAtSongEnd() { queue.playing = false }
       sync()
-    case .mixMissed:
-      break  // Task 12 handles it.
+    case .mixMissed(let id):
+      missedMixes.insert(id)
+      // A press of Next whose mix couldn't be made in time goes through as a plain skip.
+      if pressed?.id == id || pressAwaits == id {
+        pressed = nil
+        pressAwaits = nil
+        change { $0.next() }
+      }
     case .failed(let id, let failure):
       guard loaded?.item.id == id else { return }
       error = failure.message
diff --git a/apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/FakeBackend.swift b/apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/FakeBackend.swift
--- a/apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/FakeBackend.swift
+++ b/apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/FakeBackend.swift
@@ -44,12 +44,16 @@ final class FakeBackend: PlayerBackend {
 
 extension Player {
   /// A Player on an offline engine whose songs are 441 Hz sines (see `Signals`).
-  static func testing(_ backend: FakeBackend = FakeBackend(), directory: URL = temporaryDirectory(), settings: PlaybackSettings? = nil) throws -> Player {
+  static func testing(
+    _ backend: FakeBackend = FakeBackend(), directory: URL = temporaryDirectory(), settings: PlaybackSettings? = nil,
+    scheduler: (any Scheduling)? = nil, signals: [Int: @Sendable (Int64, Int) -> Float] = [:]
+  ) throws -> Player {
     let defaults = UserDefaults(suiteName: UUID().uuidString)!
     return try Player(
       backend: backend, directory: directory, settings: settings ?? PlaybackSettings(defaults: defaults),
       makeEngine: { try AudioEngine(manualRendering: true, makeSource: $0) },
-      makeSource: { item, frame in SignalSource(seconds: item.track.duration, from: frame, signal: Signals.sine) })
+      makeSource: { item, frame in SignalSource(seconds: item.track.duration, from: frame, signal: signals[item.track.id] ?? Signals.sine) },
+      scheduler: scheduler)
   }
 
   /// Renders `seconds` in steps of 0.1 s, ticking the Player's clock between them.
PATCH
git apply /tmp/phase5-task12-player.patch
```

**Step 4: Run them to see them pass, then everything**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter PlayerTransitionTests 2>&1 | tail -1
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer 2>&1 | tail -1
```

Expected: `Test run with 10 tests in 1 suite passed`, then the whole package: the count from Task 0 plus 53 (`Test run with 156 tests in 28 suites passed` on `main` after phase 4), phase 4's `clearingUpNextDoesntStartARadio` and `shutsDownWhenItsAccountIsSwitchedAway` included.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Player.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/FakeBackend.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/PlayerTransitionTests.swift
git commit -F - <<'EOF'
Mix songs with DJ mix on the phone, and mix a press of Next on the next bar

The Player asks for the transition at the levels it plays, downloads it, picks each join with DJJoin, keeps 2.5 s
scheduled so mixes can be placed late, lets a mix already placed play out when the sleep timer ends the song, and
plans presses of Next itself.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 13: The words, the energy picture and the nerd stats

The pure parts of the UI, ported and tested:

- `TransitionWords`: TransitionView.tsx's `describe`, styles, reasons, `pairFacts`, the "Next: …" line and its spoken form, and the modes with the web's hints.
- `EnergyPicture`: the transition sheet's energy around the mix, with phrases, bars, the overlap, and the next song on the picture's clock at its average rate.
- `NerdFormat`: StatsForNerds.tsx's number formats, with JavaScript's `toFixed` rounding.
- `NerdStats`: every group and row of StatsForNerds.tsx, adapted to the phone. "Stream" says native, there's a row per deck, the changeovers show scheduled against actual samples (`MixReport`), and the next mix's status includes "ready, but placed too late: straight on".

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Transitions/TransitionWords.swift`
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Transitions/EnergyPicture.swift`
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/StatsForNerds/NerdFormat.swift`
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/StatsForNerds/NerdStats.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/TransitionWordsTests.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/EnergyPictureTests.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/NerdStatsTests.swift`

**Step 1: Write the failing tests**

Create `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/TransitionWordsTests.swift`:

```swift
import Foundation
import PlayarrAPI
import PlayarrPlayer
import Testing
@testable import PlayarrUI

/// The "Next: …" line and its sheet, in TransitionView.tsx's words.
struct TransitionWordsTests {
  func plan(_ style: TransitionStyle, beats: Double = 0, reason: String = "Same tempo, keys compatible: 32-beat blend") -> TransitionPlan {
    TransitionPlan(
      style: style, aStart: 200, bStart: 16, length: 15, bResume: 31, switchAt: 8, bRate: [.init(at: 0, value: 1)], aGain: [.init(at: 0, value: 1)],
      bGain: [.init(at: 0, value: 0)], aLowDb: [.init(at: 0, value: 0)], bLowDb: [.init(at: 0, value: 0)], aHighPassHz: [.init(at: 0, value: 20)],
      reason: reason, beats: beats)
  }

  func map(bpm: Double, key: String? = nil, confidence: Double = 0.8) -> MixMapEntry {
    MixMapEntry(
      version: 8, duration: 200, bpm: bpm, firstBeat: 0.1, downbeatOffset: 0, gridStable: true, beatConfidence: 0.9,
      key: key.map { .init(camelot: $0, confidence: confidence) }, introEnd: 16, outroStart: 180, coldStart: false, coldEnd: false,
      soundEnd: 199, phraseEnergy: [])
  }

  @Test func namesEachStyle() {
    #expect(TransitionWords.styleName(plan(.long, beats: 32)) == "32-beat blend")
    #expect(TransitionWords.styleName(plan(.quick, beats: 8)) == "8-beat quick mix")
    #expect(TransitionWords.styleName(plan(.quick)) == "quick mix")
    #expect(TransitionWords.styleName(plan(.fade)) == "crossfade")
    #expect(TransitionWords.styleName(plan(.straight)) == "straight on")
  }

  @Test func saysWhatIsKnown() {
    #expect(TransitionWords.describe(nil, mixMode: .auto).style == "planning the mix")
    let pending = TransitionWords.describe(.answer(.pending(.init(plan: plan(.long, beats: 64)))), mixMode: .party)
    #expect(pending.style == "64-beat blend" && pending.preparing)
    #expect(TransitionWords.describe(.gaveUp, mixMode: .auto).why == "The mix wasn’t ready in time, so the next song follows straight on.")
    #expect(TransitionWords.describe(nil, mixMode: .off) == .init(style: "no mixing", why: "Mixing is off for this queue, so the next song follows straight on."))
    let unavailable = TransitionWords.describe(.answer(.unavailable(.init(reason: "No mix map yet for the next song (rec-2)"))), mixMode: .auto)
    #expect(unavailable.why == "The next song hasn’t been analysed yet, so the next song follows straight on.")
    #expect(TransitionWords.plainReason("Mixed transitions need audio analysis") == "Mixing needs audio analysis, which is off on this server")
    #expect(TransitionWords.plainReason("something for the logs") == "There’s no mix for these two songs")
  }

  @Test func theLineHasTempoAndKeyOnlyWhenKnownForBoth() {
    let words = TransitionWords.describe(.answer(.straight(.init(plan: plan(.long, beats: 32)))), mixMode: .auto)
    let line = TransitionWords.line(words, map(bpm: 123.6, key: "8A"), map(bpm: 126.2, key: "9A"))
    #expect(line == "Next: 32-beat blend · 124 → 126 BPM · 8A → 9A")
    #expect(TransitionWords.line(words, map(bpm: 124, key: "8A", confidence: 0.2), map(bpm: 0, key: "9A")) == "Next: 32-beat blend")
    #expect(TransitionWords.spoken(line) == "Next: 32-beat blend, 124 to 126 BPM, 8A to 9A")
    #expect(TransitionWords.songFacts(map(bpm: 124, key: "8A")) == "124 BPM · 8A")
  }
}
```

Create `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/EnergyPictureTests.swift`:

```swift
import Foundation
import PlayarrAPI
import PlayarrPlayer
import Testing
@testable import PlayarrUI

struct EnergyPictureTests {
  /// 120 BPM from 0.5 s: phrases of 8 s at 0.5, 8.5, 16.5…
  let map = MixMapEntry(
    version: 8, duration: 40, bpm: 120, firstBeat: 0.5, downbeatOffset: 0, gridStable: true, beatConfidence: 0.9, introEnd: 8.5,
    outroStart: 32.5, coldStart: false, coldEnd: false, soundStart: 0.5, soundEnd: 39.5, phraseEnergy: [0.2, nil, 1, 0.5, 0.1])

  @Test func drawsAPhraseAsLoudAsItSounds() {
    #expect(EnergyPicture.heardHeight(1) == 1)
    #expect(abs(EnergyPicture.heardHeight(pow(10, -10.0 / 20)) - 0.5) < 0.01)  // 10 dB down: half as tall
  }

  @Test func placesPhrasesAndBarsOnThePicturesClock() {
    let (phrases, bars) = EnergyPicture.phrasesAndBars(map, clock: { $0 }, from: 0, to: 40)
    #expect(phrases.map(\.at) == [0.5, 16.5, 24.5, 32.5])  // the unmeasured phrase is left out
    #expect(abs(phrases[0].left - 0.5 / 40) < 1e-12)
    #expect(bars.count == 20)
    #expect(bars.filter(\.phrase).count == 5)
  }

  @Test func theNextSongRunsAtItsAverageRateThroughTheMix() {
    let plan = TransitionPlan(
      style: .long, aStart: 100, bStart: 10, length: 20, bResume: 30.4, switchAt: 10, bRate: [.init(at: 0, value: 1.02)],
      aGain: [.init(at: 0, value: 1), .init(at: 10, value: 1), .init(at: 16, value: 0)], bGain: [.init(at: 0, value: 0)],
      aLowDb: [.init(at: 0, value: 0)], bLowDb: [.init(at: 0, value: 0)], aHighPassHz: [.init(at: 0, value: 20)], reason: "", beats: 32)
    let clock = EnergyPicture.nextSongClock(plan)
    #expect(clock(5) == -5)
    #expect(abs(clock(30.4) - 20) < 1e-9)
    #expect(abs(clock(31.4) - 21) < 1e-9)
    #expect(EnergyPicture.overlap(plan, bpmA: 120) == 16)
    var long = map
    long.duration = 400
    let strips = EnergyPicture.aroundTheMix(plan, a: ("Into the Trees", long), b: ("Hung Up", long))
    #expect(strips.map(\.note) == ["mixes out from 1:40", "comes in from 0:10"])
    #expect(abs(strips[0].mixLeft - 24.0 / 68) < 1e-9)
    #expect(abs(strips[0].mixWidth - 16.0 / 68) < 1e-9)
  }
}
```

Create `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/NerdStatsTests.swift`:

```swift
import Foundation
import PlayarrAPI
import PlayarrPlayer
import Testing
@testable import PlayarrUI

/// Stats for nerds' rows, in StatsForNerds.tsx's words (and the native ones where the engine differs).
struct NerdStatsTests {
  let track = Track(
    id: 7, recordingId: "rec-7", fileId: 9000, albumId: 70, artistId: 7, title: "Angel", artistName: "Massive Attack", albumTitle: "Mezzanine",
    trackNumber: 1, discNumber: 1, duration: 379.4, explicit: false,
    format: AudioFormat(codec: "FLAC", container: "flac", bits: 24, sampleRate: 96_000, channels: 2, lossless: true), size: 1, streamUrl: "/stream/9000")
  let map = MixMapEntry(
    version: 8, duration: 379.4, bpm: 120, firstBeat: 0.5, downbeatOffset: 1, downbeatConfidence: 0.8, gridStable: true, beatConfidence: 0.91,
    key: .init(camelot: "8A", confidence: 0.62), introEnd: 32.5, outroStart: 320.5, firstDrop: 64.5, coldStart: false, coldEnd: true,
    soundStart: 0.4, soundEnd: 378.9, beatsFrom: .model, phraseEnergy: [0.2, 0.5, nil, 1], phraseDrift: [3, 31, nil, -2], edgesStable: true)

  func row(_ groups: [NerdStats.Group], _ group: String, _ label: String) -> String? {
    guard case .text(let text)? = groups.first(where: { $0.title == group })?.rows.first(where: { $0.label == label })?.value else { return nil }
    return text
  }

  @Test func formatsAsTheWebDoes() {
    #expect(NerdFormat.at(83.46) == "1:23.4")
    #expect(NerdFormat.time(3723) == "1:02:03")
    #expect(NerdFormat.dB(-5.25) == "−5.3 dB")
    #expect(NerdFormat.dB(0) == "±0.0 dB")
    #expect(NerdFormat.signed(-9.04) == "−9.0")
    #expect(NerdFormat.format(track.format) == "FLAC · 24-bit / 96 kHz · stereo · lossless")
    #expect(NerdFormat.making(RenderProgress(step: .mixing, done: 0.437)) == "43% · mixing")
    #expect(NerdFormat.making(RenderProgress(step: .waiting, done: 0, ahead: 2)) == "waiting · 2 ahead")
  }

  @Test func readsTheBeatGridKeyAndSections() {
    // The first bar is at 0.5 + 1 beat = 1 s; 2 s a bar, 8 s a phrase.
    #expect(NerdStats.gridPosition(map, 18.2) == .init(bar: 9, beat: 3, phrase: 3, barOfPhrase: 1))
    #expect(NerdStats.gridPosition(map, 0.9) == nil)
    #expect(NerdStats.keyName("8A") == "A minor")
    #expect(NerdStats.keyName("8B") == "C major")
    #expect(NerdStats.keyName("3A") == "B♭ minor")
    #expect(NerdStats.section(map, 10) == "intro")
    #expect(NerdStats.section(map, 70) == "main, past the drop")
    #expect(NerdStats.section(map, 379) == "silence")
    #expect(NerdStats.drift([3, 31, nil, -2], .init(bar: 5, beat: 1, phrase: 2, barOfPhrase: 1)) == "+31 ms, drifts · 1 of 4 phrases drift")
    #expect(NerdStats.summary(map: map, level: TrackLevel(track: -5, lufs: -9.04), time: 18.2) == "120.0 BPM · 8A · 9.3 · −9.0 LUFS")
  }

  @Test func theEnergyStripMarksThePhrasePlayingAndTheIntroAndOutro() throws {
    let strip = try #require(NerdStats.energyStrip(map, 9.5))
    #expect(strip.bars.count == 48)  // to where its sound ends: (378.9 − 1) / 8 phrases, rounded up
    #expect(strip.bars[1].state == .now)
    #expect(strip.bars[2].state == .unmeasured)
    #expect(strip.energyNow == "0.50")
    #expect(strip.introLabel == "intro ends 0:32.5")
  }

  @Test func everyGroupWithTheNativeStreamDecksAndChangeovers() {
    let report = MixReport(kind: .mixIn, way: .server, songs: "Angel → Teardrop", sample: 154_350, songTime: 207.5, headroom: 2.61)
    let deck = DeckSnapshot(name: "A", title: "Angel", startsAt: 0, decodedSeconds: 12.34, scheduledSeconds: 2.5, finished: false, gain: 0.5)
    let groups = NerdStats.groups(.init(
      track: track, time: 18.25, duration: 379.5, buffered: 9.96, loading: false, playing: true, map: map,
      level: TrackLevel(track: -6, album: -4.2, lufs: -8, peak: -0.5), gainDb: -6, levelVolume: true, transitions: .dj, mixMode: .party,
      next: track, upcoming: .answer(.pending(.init(plan: TransitionFiles.plan, render: .init(step: .mixing, done: 0.43)))), djWanted: true,
      reports: [.mixIn: report], decks: [deck]))
    #expect(groups.map(\.title) == ["Song", "Playback", "Rhythm", "Structure", "Loudness", "Next"])
    #expect(row(groups, "Song", "Ids") == "track 7 · file 9000")
    #expect(row(groups, "Playback", "Position") == "0:18.2 / 6:19.5 · playing")
    #expect(row(groups, "Playback", "Buffer") == "10.0 s ahead")
    #expect(row(groups, "Playback", "Stream") == "its own file, levelled on this device at −6.0 dB")
    #expect(row(groups, "Playback", "Deck A") == "Angel · placed at 0:00.0 · 12.3 s decoded, 2.5 s scheduled · −6.0 dB")
    #expect(row(groups, "Playback", "Transitions") == "DJ mix · party")
    #expect(row(groups, "Playback", "Mix in") == "Angel → Teardrop · made on the server · at A’s 3:27.5, sample 154350 · scheduled 2.6 s ahead")
    #expect(row(groups, "Playback", "Mix out") == "none yet")
    #expect(row(groups, "Rhythm", "Beat") == "91% sure · steady · holds where mixed · beat model")
    #expect(row(groups, "Rhythm", "Key") == "8A · A minor · 62% sure")
    #expect(row(groups, "Structure", "Outro") == "from 5:20.5 · cold end")
    #expect(row(groups, "Loudness", "Applied") == "−6.0 dB on this device (track gain)")
    #expect(row(groups, "Loudness", "Heard at") == "≈ −14.0 LUFS")
    #expect(row(groups, "Next", "Mix") == "being made · long, 64 beats")
    #expect(row(groups, "Next", "Making") == "43% · mixing")
    #expect(row(groups, "Next", "Length") == "30.0 s · next takes over at +16.0 s · on from 0:46.0")
    #expect(row(groups, "Next", "Mix at") == "3:20.0 (in 3:01) → 0:16.0 of the next")
  }
}

enum TransitionFiles {
  static let plan = TransitionPlan(
    style: .long, aStart: 200, bStart: 16, length: 30, bResume: 46, switchAt: 16, bRate: [.init(at: 0, value: 1)], aGain: [.init(at: 0, value: 1)],
    bGain: [.init(at: 0, value: 0)], aLowDb: [.init(at: 0, value: 0)], bLowDb: [.init(at: 0, value: 0)], aHighPassHz: [.init(at: 0, value: 20)],
    reason: "Same tempo, keys compatible: 64-beat blend", beats: 64)
}
```

**Step 2: Run them to see them fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter 'TransitionWordsTests|EnergyPictureTests|NerdStatsTests' 2>&1 | grep -m1 -E '\.swift:[0-9]+:[0-9]+: .*error'
```

Expected: `…/NerdStatsTests.swift:…: error: cannot find type 'NerdStats' in scope` (or `TransitionWords`, `EnergyPicture`).

**Step 3: Implement**

Create `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Transitions/TransitionWords.swift`:

```swift
import PlayarrAPI
import PlayarrPlayer

/// The next transition in words, for the "Next: …" line and its sheet: `describe`, `styleName`, `plainReason` and
/// `pairFacts` of apps/web/src/components/TransitionView.tsx, word for word.
public enum TransitionWords {
  /// Keys this unsure aren't worth showing: they'd be a guess.
  static let minKeyConfidence = 0.3

  public struct Mode: Identifiable, Sendable {
    public let value: MixMode
    public let label: String
    public let hint: String
    public var id: String { value.rawValue }
  }

  public static let modes: [Mode] = [
    Mode(value: .auto, label: "Auto", hint: "Songs are blended when they suit it, and mixed quickly when they don’t."),
    Mode(value: .party, label: "Party", hint: "Longer blends, more often: for a party that shouldn’t stop."),
    Mode(value: .off, label: "No mixing", hint: "Songs follow each other straight on, without a gap."),
  ]

  /// What's known of the next transition: "32-beat blend" (lower case: it follows "Next:"), why, and the plan.
  public struct Upcoming: Equatable, Sendable {
    public var style: String
    public var why: String
    public var plan: TransitionPlan?
    /// Planned, but the mix is still being made.
    public var preparing = false
  }

  public static func styleName(_ plan: TransitionPlan) -> String {
    let beats = Int(plan.beats.rounded())
    switch plan.style {
    case .long: return beats > 0 ? "\(beats)-beat blend" : "blend"
    case .quick: return beats > 0 ? "\(beats)-beat quick mix" : "quick mix"
    case .fade: return "crossfade"
    case .straight, .unknown: return "straight on"
    }
  }

  /// The server's reasons for having no mix, in the listener's words (they're written for the logs).
  public static func plainReason(_ reason: String) -> String {
    if reason.hasPrefix("No mix map yet for the song playing") { return "This song hasn’t been analysed yet" }
    if reason.hasPrefix("No mix map yet for the next song") { return "The next song hasn’t been analysed yet" }
    if reason == "Mixed transitions need audio analysis" { return "Mixing needs audio analysis, which is off on this server" }
    if reason.hasPrefix("The transition couldn’t be") { return "The mix couldn’t be made" }
    return "There’s no mix for these two songs"
  }

  /// Without a mix (unavailable, too late, mixing off) DJ mix plays the next song straight on, without a gap.
  public static func describe(_ result: TransitionPlanner.Result?, mixMode: MixMode) -> Upcoming {
    if mixMode == .off { return Upcoming(style: "no mixing", why: "Mixing is off for this queue, so the next song follows straight on.") }
    switch result {
    case nil:
      return Upcoming(style: "planning the mix", why: "Working out how these two songs go together…")
    case .answer(.ready(let r))?:
      return Upcoming(style: styleName(r.plan), why: r.plan.reason, plan: r.plan)
    case .answer(.straight(let s))?:
      return Upcoming(style: styleName(s.plan), why: s.plan.reason, plan: s.plan)
    case .answer(.pending(let p))?:
      return Upcoming(style: styleName(p.plan), why: p.plan.reason, plan: p.plan, preparing: true)
    case .answer(.unavailable(let u))?:
      return Upcoming(style: "straight on", why: "\(plainReason(u.reason)), so the next song follows straight on.")
    case .answer(.unknown)?:
      return Upcoming(style: "straight on", why: "There’s no mix for these two songs, so the next song follows straight on.")
    case .gaveUp?:
      return Upcoming(style: "straight on", why: "The mix wasn’t ready in time, so the next song follows straight on.")
    }
  }

  public static func bpm(_ map: MixMapEntry?) -> Int? {
    guard let map, map.bpm > 0 else { return nil }
    return Int(map.bpm.rounded())
  }

  public static func key(_ map: MixMapEntry?) -> String? {
    guard let key = map?.key, key.confidence >= minKeyConfidence else { return nil }
    return key.camelot
  }

  /// "124 → 126 BPM" and "8A → 9A", each only when known for both songs.
  public static func pairFacts(_ a: MixMapEntry?, _ b: MixMapEntry?) -> [String] {
    var facts: [String] = []
    if let x = bpm(a), let y = bpm(b) { facts.append("\(x) → \(y) BPM") }
    if let x = key(a), let y = key(b) { facts.append("\(x) → \(y)") }
    return facts
  }

  /// "Next: 32-beat blend · 124 → 126 BPM · 8A → 9A".
  public static func line(_ upcoming: Upcoming, _ a: MixMapEntry?, _ b: MixMapEntry?) -> String {
    (["Next: " + upcoming.style] + pairFacts(a, b)).joined(separator: " · ")
  }

  /// The line as VoiceOver should say it: "124 to 126 BPM", pauses for the dots.
  public static func spoken(_ text: String) -> String {
    text.replacingOccurrences(of: " → ", with: " to ").replacingOccurrences(of: " · ", with: ", ")
  }

  /// "Song 1 BPM · 8A" for the sheet's Now and Next rows.
  public static func songFacts(_ map: MixMapEntry?) -> String? {
    let facts = [bpm(map).map { "\($0) BPM" }, key(map)].compactMap { $0 }
    return facts.isEmpty ? nil : facts.joined(separator: " · ")
  }
}
```

Create `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Transitions/EnergyPicture.swift`:

```swift
import Foundation
import PlayarrAPI

/// Songs' energy per 16-beat phrase as columns over their bar lines: what the transition sheet draws around the mix
/// and Stats for nerds draws for the whole song. As apps/web/src/components/EnergyStrip.tsx and TransitionView.tsx.
public enum EnergyPicture {
  /// One phrase of a song, placed in a picture.
  public struct Phrase: Equatable, Sendable {
    /// Seconds into the song.
    public var at: Double
    public var energy: Double
    /// Start and end on the picture's clock.
    public var start: Double
    public var end: Double
    /// Position and width in the picture, 0–1.
    public var left: Double
    public var width: Double
    /// In the stretch where both songs sound together.
    public var inMix = false
  }

  /// A bar line in the picture, 0–1; `phrase` marks every fourth.
  public struct Bar: Equatable, Sendable {
    public var left: Double
    public var phrase: Bool
  }

  /// One song's strip around the mix.
  public struct Strip: Equatable, Sendable {
    public var title: String
    /// "mixes out from 3:20", "comes in from 0:16".
    public var note: String
    public var phrases: [Phrase]
    public var bars: [Bar]
    /// The mix, 0–1 (zero width for a straight cut).
    public var mixLeft: Double
    public var mixWidth: Double
  }

  /// How tall to draw a phrase of this energy: as loud as it sounds (level^0.6), so 10 dB down is half as tall.
  public static func heardHeight(_ energy: Double) -> Double { pow(max(0, energy), 0.6) }

  /// Seconds per beat and where the first bar starts, when the song has a beat.
  public static func beatGrid(_ map: MixMapEntry) -> (beat: Double, firstBar: Double)? {
    guard map.bpm > 0 else { return nil }
    let beat = 60 / map.bpm
    return (beat, map.firstBeat + map.downbeatOffset * beat)
  }

  /// A song's phrases and bars between `from` and `to` seconds of the picture's clock; `clock` turns song time into it.
  public static func phrasesAndBars(_ map: MixMapEntry, clock: (Double) -> Double, from: Double, to: Double) -> (phrases: [Phrase], bars: [Bar]) {
    let span = to - from
    let place = { (t: Double) in (min(max(t, from), to) - from) / span }
    guard let grid = beatGrid(map) else { return ([], []) }
    var phrases: [Phrase] = []
    for (k, energy) in map.phraseEnergy.enumerated() {
      guard let energy else { continue }  // not measured: left blank
      let at = grid.firstBar + Double(k) * 16 * grid.beat
      let start = clock(at), end = clock(min(at + 16 * grid.beat, map.duration))
      if end <= from || start >= to { continue }
      phrases.append(Phrase(at: at, energy: energy, start: start, end: end, left: place(start), width: place(end) - place(start)))
    }
    var bars: [Bar] = []
    var n = max(0, Int((-grid.firstBar / (4 * grid.beat)).rounded(.up)))
    while true {
      let at = grid.firstBar + Double(n) * 4 * grid.beat
      if at > map.duration { break }
      let t = clock(at)
      if t > to { break }
      if t >= from { bars.append(Bar(left: place(t), phrase: n % 4 == 0)) }
      n += 1
    }
    return (phrases, bars)
  }

  /// How long both songs sound together from the start of the mix: until A has faded out, else the plan's beats.
  public static func overlap(_ plan: TransitionPlan, bpmA: Double) -> Double {
    if plan.aGain.contains(where: { $0.value > 0 }) { return plan.aGain.silentFrom(limit: plan.length) }
    return bpmA > 0 && plan.beats > 0 ? min(plan.beats * 60 / bpmA, plan.length) : plan.length
  }

  /// Where the next song's moments fall on the picture's clock (0: the start of the mix): stretched to A's tempo
  /// during the mix, its seconds there run at the average rate.
  public static func nextSongClock(_ plan: TransitionPlan) -> (Double) -> Double {
    let span = plan.bResume - plan.bStart
    let rate = plan.length > 0 && span > 0 ? span / plan.length : 1
    return { t in
      t < plan.bStart ? t - plan.bStart : t <= plan.bStart + span ? (t - plan.bStart) / rate : plan.length + (t - plan.bStart - span)
    }
  }

  /// Seconds shown either side of the mix (more for a long mix).
  static let pad = 24.0

  /// Both songs' strips on one clock, the next song lined up where it comes in, so the shaded mix is the same stretch.
  public static func aroundTheMix(_ plan: TransitionPlan, a: (title: String, map: MixMapEntry), b: (title: String, map: MixMapEntry)) -> [Strip] {
    let pad = max(Self.pad, plan.length / 2)
    let from = -pad, to = plan.length + pad
    let mixLength = overlap(plan, bpmA: a.map.bpm)
    func strip(_ title: String, _ note: String, _ map: MixMapEntry, _ clock: (Double) -> Double) -> Strip {
      let span = to - from
      let place = { (t: Double) in (min(max(t, from), to) - from) / span }
      let mixEnd = clock(map.duration)
      var (phrases, bars) = phrasesAndBars(map, clock: clock, from: from, to: to)
      for i in phrases.indices {
        let p = phrases[i]
        phrases[i].inMix = mixLength > 0 ? p.start < mixLength && p.end > 0 : p.start <= 0 && p.end > 0
      }
      return Strip(title: title, note: note, phrases: phrases, bars: bars, mixLeft: place(0), mixWidth: place(min(mixLength, mixEnd)) - place(0))
    }
    return [
      strip(a.title, "mixes out from \(NerdFormat.time(plan.aStart))", a.map) { $0 - plan.aStart },
      strip(b.title, "comes in from \(NerdFormat.time(plan.bStart))", b.map, nextSongClock(plan)),
    ]
  }
}
```

Create `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/StatsForNerds/NerdFormat.swift`:

```swift
import Foundation
import PlayarrAPI

/// Numbers as Stats for nerds and the transition sheet write them (apps/web/src/lib/format.ts, StatsForNerds.tsx).
public enum NerdFormat {
  /// 83 → "1:23"; an hour or more → "1:02:03" (phase 4's `Format.time`).
  public static func time(_ seconds: Double) -> String { Format.time(seconds) }

  /// 83.46 → "1:23.4".
  public static func at(_ seconds: Double) -> String {
    "\(time(seconds)).\(Int((max(0, seconds).truncatingRemainder(dividingBy: 1)) * 10))"
  }

  /// −5.25 → "−5.3 dB", 0 → "±0.0 dB".
  public static func dB(_ db: Double) -> String {
    let sign = db > 0 ? "+" : db < 0 ? "−" : "±"
    return "\(sign)\(fixed(abs(db), 1)) dB"
  }

  /// −9.04 → "−9.0", with a real minus sign.
  public static func signed(_ x: Double) -> String { (x < 0 ? "−" : "") + fixed(abs(x), 1) }

  public static func pct(_ x: Double) -> String { "\(Int((min(1, max(0, x)) * 100).rounded()))%" }

  public static func n2(_ x: Double) -> String { fixed(x, 2) }

  /// JavaScript's `toFixed`: halves away from zero (printf's `%.1f` takes 5.25 to 5.2, toFixed to 5.3).
  static func fixed(_ x: Double, _ digits: Int) -> String {
    let scale = pow(10, Double(digits))
    return String(format: "%.\(digits)f", (x * scale).rounded(.toNearestOrAwayFromZero) / scale)
  }

  /// "FLAC · 24-bit / 96 kHz · stereo · lossless" (`describeFormat`).
  public static func format(_ f: AudioFormat) -> String {
    var parts = [f.codec]
    let depth = [f.bits.map { "\($0)-bit" }, f.sampleRate.map { "\(Double($0) / 1000) kHz".replacingOccurrences(of: ".0 kHz", with: " kHz") }]
      .compactMap { $0 }
    if !depth.isEmpty { parts.append(depth.joined(separator: " / ")) }
    if let bitrate = f.bitrate { parts.append("\(Int(bitrate.rounded())) kbps") }
    if let channels = f.channels { parts.append(channels == 1 ? "mono" : channels == 2 ? "stereo" : "\(channels) ch") }
    parts.append(f.lossless ? "lossless" : "lossy")
    return parts.joined(separator: " · ")
  }

  /// How far the server has got making the transition: "43% · mixing", "waiting · 2 ahead" (`makingOf`).
  public static func making(_ render: RenderProgress) -> String {
    if render.step == .waiting {
      if let ahead = render.ahead, ahead > 0 { return "waiting · \(Int(ahead)) ahead" }
      return "waiting"
    }
    return "\(Int((min(1, max(0, render.done)) * 100).rounded(.down)))% · \(render.step.rawValue)"
  }
}
```

Create `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/StatsForNerds/NerdStats.swift`:

```swift
import Foundation
import PlayarrAPI
import PlayarrPlayer

/// Everything Stats for nerds says, as groups of rows: StatsForNerds.tsx, group for group and row for row, with what's
/// different natively said so. There are no <audio> elements: the decks are shown instead, the stream is the song's
/// own file levelled on this device (or the server's transition, or a mix played live), and each changeover reports
/// the sample it was scheduled on rather than how far apart two files were found.
public enum NerdStats {
  /// The drift past which a phrase's beat "drifts" (`DRIFT_LIMIT_MS`).
  static let driftLimitMs = 25.0
  /// A rate this close to 1 shows as the next song's own tempo.
  static let sameRate = 0.0005

  public struct Row: Equatable, Sendable, Identifiable {
    public enum Value: Equatable, Sendable {
      case text(String)
      case energy(EnergyStrip)
      case error(String)
    }
    public let label: String
    public let value: Value
    public var id: String { label }
  }

  public struct Group: Equatable, Sendable, Identifiable {
    public let title: String
    public let rows: [Row]
    public var id: String { title }
  }

  /// The phrase strip: each phrase's height and whether it's played, playing or to come; the intro and outro lines.
  public struct EnergyStrip: Equatable, Sendable {
    public enum State: Sendable { case unmeasured, past, now, future }
    public var bars: [(height: Double, state: State)]
    public var introAt: Double
    public var outroAt: Double
    public var introLabel: String
    public var outroLabel: String
    public var energyNow: String

    public static func == (x: EnergyStrip, y: EnergyStrip) -> Bool {
      x.bars.map(\.height) == y.bars.map(\.height) && x.bars.map { "\($0.state)" } == y.bars.map { "\($0.state)" }
        && x.introAt == y.introAt && x.outroAt == y.outroAt && x.energyNow == y.energyNow
    }
  }

  /// Where a time falls on the song's grid, from its first bar (1.1).
  public struct GridPosition: Equatable, Sendable {
    public var bar: Int
    /// 1–4 within the bar.
    public var beat: Int
    public var phrase: Int
    /// 1–4 within the phrase.
    public var barOfPhrase: Int
  }

  /// Everything the panel reads.
  public struct Input: Sendable {
    public var track: Track
    public var time: Double
    public var duration: Double
    public var buffered: Double
    public var loading: Bool
    public var playing: Bool
    public var error: String?
    public var map: MixMapEntry?
    public var level: TrackLevel?
    public var metadata: TrackMetadata?
    /// The gain the song plays at (dB), and whether even volume is on.
    public var gainDb: Double
    public var levelVolume: Bool
    public var albumGain: Bool
    public var transitions: PlaybackSettings.Transitions
    public var crossfade: Double
    public var mixMode: MixMode
    public var next: Track?
    /// The planner's answer, when it's working on this song into the next.
    public var upcoming: TransitionPlanner.Result?
    public var djWanted: Bool
    public var mixMissed: Bool
    public var mix: AudioEngine.MixInProgress?
    public var engineNow: SampleTime
    public var reports: [MixReport.Kind: MixReport]
    public var decks: [DeckSnapshot]
    public var continuation: EngineItem.Continuation?

    public init(track: Track, time: Double, duration: Double, buffered: Double, loading: Bool, playing: Bool, error: String? = nil,
      map: MixMapEntry? = nil, level: TrackLevel? = nil, metadata: TrackMetadata? = nil, gainDb: Double = 0, levelVolume: Bool = true,
      albumGain: Bool = false, transitions: PlaybackSettings.Transitions = .dj, crossfade: Double = 0, mixMode: MixMode = .auto,
      next: Track? = nil, upcoming: TransitionPlanner.Result? = nil, djWanted: Bool = false, mixMissed: Bool = false,
      mix: AudioEngine.MixInProgress? = nil, engineNow: SampleTime = 0, reports: [MixReport.Kind: MixReport] = [:], decks: [DeckSnapshot] = [],
      continuation: EngineItem.Continuation? = nil
    ) {
      self.track = track; self.time = time; self.duration = duration; self.buffered = buffered; self.loading = loading
      self.playing = playing; self.error = error; self.map = map; self.level = level; self.metadata = metadata; self.gainDb = gainDb
      self.levelVolume = levelVolume; self.albumGain = albumGain; self.transitions = transitions; self.crossfade = crossfade
      self.mixMode = mixMode; self.next = next; self.upcoming = upcoming; self.djWanted = djWanted; self.mixMissed = mixMissed
      self.mix = mix; self.engineNow = engineNow; self.reports = reports; self.decks = decks; self.continuation = continuation
    }
  }

  // MARK: Reading the map

  public static func gridPosition(_ map: MixMapEntry, _ time: Double) -> GridPosition? {
    guard let grid = EnergyPicture.beatGrid(map) else { return nil }
    let beats = Int(((time - grid.firstBar) / grid.beat + 1e-6).rounded(.down))
    guard beats >= 0 else { return nil }
    let bars = beats / 4
    return GridPosition(bar: bars + 1, beat: beats % 4 + 1, phrase: bars / 4 + 1, barOfPhrase: bars % 4 + 1)
  }

  public static func section(_ map: MixMapEntry, _ time: Double) -> String {
    if time < (map.soundStart ?? 0) || time >= map.soundEnd { return "silence" }
    if time < map.introEnd { return "intro" }
    if time >= map.outroStart { return "outro" }
    if let drop = map.firstDrop, time >= drop { return "main, past the drop" }
    return "main"
  }

  /// "8A" → "A minor", "8B" → "C major" (`keyName`, from camelot.ts's `toCamelot`).
  public static func keyName(_ camelot: Camelot) -> String? {
    let major = ["C", "D♭", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"]
    let minor = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "G♯", "A", "B♭", "B"]
    for pc in 0..<12 {
      if toCamelot(pc, minor: false) == camelot { return "\(major[pc]) major" }
      if toCamelot(pc, minor: true) == camelot { return "\(minor[pc]) minor" }
    }
    return nil
  }

  static func toCamelot(_ pitchClass: Int, minor: Bool) -> String {
    let majorTonic = minor ? (pitchClass + 3) % 12 : pitchClass
    let fifthsFromC = majorTonic * 7 % 12
    return "\((fifthsFromC + 7) % 12 + 1)\(minor ? "A" : "B")"
  }

  /// "+34 ms, drifts · 12 of 58 phrases drift".
  public static func drift(_ drift: [Double?], _ grid: GridPosition?) -> String {
    let drifting = drift.filter { ($0.map { abs($0) > driftLimitMs }) ?? false }.count
    var now: String?
    if let grid, drift.indices.contains(grid.phrase - 1) {
      if let d = drift[grid.phrase - 1] {
        let sign = d > 0 ? "+" : d < 0 ? "−" : "±"
        now = "\(sign)\(Int(abs(d).rounded())) ms, \(abs(d) > driftLimitMs ? "drifts" : "holds")"
      } else {
        now = "no beat to judge"
      }
    }
    return [now, "\(drifting) of \(drift.count) phrases drift"].compactMap { $0 }.joined(separator: " · ")
  }

  public static func energyStrip(_ map: MixMapEntry, _ time: Double) -> EnergyStrip? {
    guard let grid = EnergyPicture.beatGrid(map), !map.phraseEnergy.isEmpty else { return nil }
    let phrase = 16 * grid.beat
    let total = max(map.phraseEnergy.count, Int(((map.soundEnd - grid.firstBar) / phrase).rounded(.up)))
    let now = Int(((time - grid.firstBar) / phrase).rounded(.down))
    let place = { (t: Double) in min(1, max(0, (t - grid.firstBar) / (phrase * Double(total)))) }
    let bars = (0..<total).map { k -> (Double, EnergyStrip.State) in
      guard k < map.phraseEnergy.count, let e = map.phraseEnergy[k] else { return (0.08, .unmeasured) }
      return (max(0.08, EnergyPicture.heardHeight(e)), k == now ? .now : k < now ? .past : .future)
    }
    let energy = map.phraseEnergy.indices.contains(now) ? map.phraseEnergy[now] : nil
    return EnergyStrip(
      bars: bars, introAt: place(map.introEnd), outroAt: place(map.outroStart), introLabel: "intro ends \(NerdFormat.at(map.introEnd))",
      outroLabel: "outro from \(NerdFormat.at(map.outroStart))", energyNow: energy.map { NerdFormat.n2($0) } ?? "–")
  }

  /// The header when collapsed: "124.0 BPM · 8A · 17.3 · −9.0 LUFS".
  public static func summary(map: MixMapEntry?, level: TrackLevel?, time: Double) -> String {
    let grid = map.flatMap { gridPosition($0, time) }
    return [
      map.flatMap { $0.bpm > 0 ? String(format: "%.1f BPM", $0.bpm) : nil }, map?.key?.camelot, grid.map { "\($0.bar).\($0.beat)" },
      level?.lufs.map { "\(NerdFormat.signed($0)) LUFS" },
    ].compactMap { $0 }.joined(separator: " · ")
  }

  // MARK: The groups

  public static func groups(_ i: Input) -> [Group] {
    var groups = [song(i), playback(i), rhythm(i)]
    if let map = i.map { groups.append(structure(map, i.time)) }
    groups.append(Group(title: "Loudness", rows: loudness(i)))
    if let analysis = i.metadata?.analysis {
      groups.append(
        Group(title: "Sound", rows: rows([
          ("Energy", "level \(NerdFormat.n2(analysis.loudness)) · dynamics \(NerdFormat.n2(analysis.dynamics))"),
          ("Texture", "bright \(NerdFormat.n2(analysis.brightness)) · busy \(NerdFormat.n2(analysis.busyness)) · bass \(NerdFormat.n2(analysis.bass))"),
          ("Genres", i.metadata?.genres.isEmpty == false ? i.metadata?.genres.joined(separator: ", ") : nil),
        ])))
    }
    if let next = i.next { groups.append(Group(title: "Next", rows: [Row(label: "Song", value: .text("\(next.title) — \(next.artistName)"))] + upcoming(i))) }
    return groups
  }

  static func rows(_ pairs: [(String, String?)]) -> [Row] {
    pairs.compactMap { label, value in value.flatMap { $0.isEmpty ? nil : Row(label: label, value: .text($0)) } }
  }

  static func song(_ i: Input) -> Group {
    let copy = i.metadata?.copies.first { $0.playing }
    return Group(title: "Song", rows: rows([
      ("Title", "\(i.track.title) — \(i.track.artistName)"),
      ("Ids", "track \(i.track.id) · file \(i.track.fileId)"),
      ("Recording", i.track.recordingId),
      ("Source", copy.map { [$0.source.name, $0.path].compactMap { $0 }.joined(separator: " · ") }),
    ]))
  }

  static func playback(_ i: Input) -> Group {
    var list = rows([
      ("Position", "\(NerdFormat.at(i.time)) / \(NerdFormat.at(i.duration)) · \(i.loading ? "loading" : i.playing ? "playing" : "paused")"),
      ("Buffer", i.buffered > 0 ? "\(NerdFormat.fixed(i.buffered, 1)) s ahead" : "none ahead"),
      ("Stream", stream(i)),
    ])
    list += i.decks.filter { $0.title != nil }.map { Row(label: "Deck \($0.name)", value: .text(deck($0))) }
    list += rows([
      ("URL", i.continuation?.url ?? i.track.streamUrl),
      ("Format", NerdFormat.format(i.track.format)),
      ("Transitions", i.transitions == .dj ? "DJ mix · \(i.mixMode.rawValue)" : i.transitions == .crossfade ? "crossfade \(Int(i.crossfade)) s" : "gapless"),
      ("Mix in", i.reports[.mixIn].map(report) ?? "none yet"),
      ("Mix out", i.reports[.mixOut].map(report) ?? "none yet"),
    ])
    if let error = i.error { list.append(Row(label: "Error", value: .error(error))) }
    return Group(title: "Playback", rows: list)
  }

  /// What's heard: the server's transition, a mix played live, the server's rest of a song, or its own file.
  static func stream(_ i: Input) -> String {
    if let mix = i.mix, i.engineNow < mix.end {
      return mix.way == .server ? "DJ transition, made on the server" : "mixed live on this device"
    }
    if let rest = i.continuation, i.time >= rest.from { return "the rest after the transition, from \(NerdFormat.at(rest.from))" }
    return i.gainDb != 0 ? "its own file, levelled on this device at \(NerdFormat.dB(i.gainDb))" : "its own file"
  }

  /// "Song 2 · at 3:12.0 · 9.5 s decoded, 2.5 s scheduled · +2.0 dB".
  static func deck(_ d: DeckSnapshot) -> String {
    [
      d.title, d.startsAt.map { "placed at \(NerdFormat.at($0))" } ?? "cued",
      String(format: "%.1f s decoded, %.1f s scheduled", d.decodedSeconds, d.scheduledSeconds), d.finished ? "end known" : nil,
      NerdFormat.dB(20 * log10(Double(max(d.gain, 1e-6)))),
    ].compactMap { $0 }.joined(separator: " · ")
  }

  /// "A → B · made on the server · at A's 3:27.5, sample 154 350 · scheduled 2.6 s ahead".
  static func report(_ r: MixReport) -> String {
    let whose = r.kind == .mixIn ? "A’s" : "B’s"
    let ahead = r.headroom.map { String(format: "scheduled %.1f s ahead", $0) } ?? "not scheduled yet"
    return "\(r.songs) · \(r.way.rawValue) · at \(whose) \(NerdFormat.at(r.songTime)), sample \(r.sample) · \(ahead)"
  }

  static func rhythm(_ i: Input) -> Group {
    guard let map = i.map, map.bpm > 0 else {
      var list = [Row(label: "Tempo", value: .text(i.map == nil ? "not analysed yet" : "no steady beat"))]
      if let key = i.map?.key { list.append(keyRow(key)) }
      return Group(title: "Rhythm", rows: list)
    }
    let grid = gridPosition(map, i.time)
    var list = rows([
      ("Tempo", "\(NerdFormat.n2(map.bpm)) BPM · \(Int((60_000 / map.bpm).rounded())) ms a beat"),
      ("Beat", [
        "\(NerdFormat.pct(map.beatConfidence)) sure", map.gridStable ? "steady" : "wandering",
        map.edgesStable.map { $0 ? "holds where mixed" : "drifts where mixed" }, map.beatsFrom == .onsets ? "onsets" : "beat model",
      ].compactMap { $0 }.joined(separator: " · ")),
      ("Bars", "\(NerdFormat.pct(map.downbeatConfidence ?? 1)) sure · first beat \(NerdFormat.at(map.firstBeat)) +\(Int(map.downbeatOffset))"),
      ("Now", grid.map { "bar \($0.bar).\($0.beat) · phrase \($0.phrase) (bar \($0.barOfPhrase)/4)" } ?? (i.time < map.firstBeat ? "before the first beat" : "pickup")),
      ("Drift", map.phraseDrift.map { drift($0, grid) }),
    ])
    if let key = map.key { list.append(keyRow(key)) }
    return Group(title: "Rhythm", rows: list)
  }

  static func keyRow(_ key: MixMapEntry.Key) -> Row {
    Row(label: "Key", value: .text("\(key.camelot) · \(keyName(key.camelot) ?? "?") · \(NerdFormat.pct(key.confidence)) sure"))
  }

  static func structure(_ map: MixMapEntry, _ time: Double) -> Group {
    var list = rows([
      ("Section", section(map, time)),
      ("Audible", "\(NerdFormat.at(map.soundStart ?? 0)) → \(NerdFormat.at(map.soundEnd))"),
      ("Intro", "to \(NerdFormat.at(map.introEnd)) · \(map.coldStart ? "cold start" : "eases in")"),
      ("Outro", "from \(NerdFormat.at(map.outroStart)) · \(map.coldEnd ? "cold end" : "fades out")"),
      ("First drop", map.firstDrop.map(NerdFormat.at) ?? "none"),
    ])
    if let cues = map.cues, cues.mixIn != nil || cues.mixOut != nil {
      let mixIn = cues.mixIn.map { "in \(NerdFormat.at($0))" } ?? "in: detected"
      let mixOut = cues.mixOut.map { "out \(NerdFormat.at($0))" } ?? "out: detected"
      list.append(Row(label: "Mix points", value: .text("\(mixIn) · \(mixOut) (set by hand)")))
    }
    if let strip = energyStrip(map, time) { list.append(Row(label: "Phrases", value: .energy(strip))) }
    list.append(Row(label: "Mix map", value: .text("version \(map.version)")))
    return Group(title: "Structure", rows: list)
  }

  /// The phone applies every gain itself, up as well as down, on any file.
  static func loudness(_ i: Input) -> [Row] {
    guard let level = i.level else { return [Row(label: "Measured", value: .text("not measured yet"))] }
    let applied: String
    if !i.levelVolume {
      applied = "none: even volume is off"
    } else {
      applied = "\(NerdFormat.dB(i.gainDb)) on this device (\(i.albumGain ? "album gain" : "track gain"))"
    }
    return rows([
      ("Measured", level.lufs.map { lufs in "\(NerdFormat.signed(lufs)) LUFS" + (level.peak.map { " · peak \(NerdFormat.signed($0)) dBFS" } ?? "") }),
      ("Gains", "track \(NerdFormat.dB(level.track))" + (level.album.map { " · album \(NerdFormat.dB($0))" } ?? "")),
      ("Applied", applied),
      ("Heard at", i.levelVolume ? level.lufs.map { "≈ \(NerdFormat.signed($0 + i.gainDb)) LUFS" } : nil),
    ])
  }

  static func upcoming(_ i: Input) -> [Row] {
    guard i.transitions == .dj, i.mixMode != .off, i.djWanted else {
      return [Row(label: "How", value: .text(i.transitions == .crossfade ? "crossfade \(Int(i.crossfade)) s" : "straight on, gapless"))]
    }
    guard let result = i.upcoming else { return [Row(label: "Mix", value: .text("planning"))] }
    let status: String
    switch result {
    case .answer(.ready): status = i.mixMissed ? "ready, but placed too late: straight on" : "ready"
    case .answer(.pending): status = "being made"
    case .answer(.straight): status = "straight on"
    case .answer(.unavailable), .answer(.unknown): status = "unavailable"
    case .gaveUp: status = "gave up: not ready in time"
    }
    let plan = result.plan
    var list = [Row(label: "Mix", value: .text(plan.map { "\(status) · \($0.style.rawValue)\($0.beats > 0 ? ", \(Int($0.beats)) beats" : "")" } ?? status))]
    if case .answer(.pending(let p)) = result, let render = p.render { list.append(Row(label: "Making", value: .text(NerdFormat.making(render)))) }
    if let plan {
      let soon = plan.aStart > i.time ? " (in \(NerdFormat.time(plan.aStart - i.time)))" : ""
      list += rows([
        ("Mix at", "\(NerdFormat.at(plan.aStart))\(soon) → \(NerdFormat.at(plan.bStart)) of the next"),
        ("Length", "\(NerdFormat.fixed(plan.length, 1)) s · next takes over at +\(NerdFormat.fixed(plan.switchAt, 1)) s · on from \(NerdFormat.at(plan.bResume))"),
      ])
      let rates = plan.bRate.map(\.value)
      if let slowest = rates.min(), let fastest = rates.max(), rates.contains(where: { abs($0 - 1) >= sameRate }) {
        list.append(Row(label: "Next’s rate", value: .text(slowest == fastest ? String(format: "×%.3f", slowest) : String(format: "×%.3f – ×%.3f", slowest, fastest))))
      }
    }
    if case .answer(.ready(let r)) = result, let levels = r.levels {
      list.append(Row(label: "Levels", value: .text("\(NerdFormat.dB(levels.a)) → \(NerdFormat.dB(levels.b))")))
    }
    let why: String? = switch result {
    case .answer(.unavailable(let u)): u.reason
    default: plan?.reason
    }
    if let why { list.append(Row(label: "Why", value: .text(why))) }
    return list
  }
}
```

**Step 4: Run them to see them pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter 'TransitionWordsTests|EnergyPictureTests|NerdStatsTests' 2>&1 | tail -1
```

Expected: `Test run with 10 tests in 3 suites passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Transitions/TransitionWords.swift \
  apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Transitions/EnergyPicture.swift \
  apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/StatsForNerds/NerdFormat.swift \
  apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/StatsForNerds/NerdStats.swift \
  apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/TransitionWordsTests.swift \
  apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/EnergyPictureTests.swift \
  apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/NerdStatsTests.swift
git commit -F - <<'EOF'
Describe the next transition and every stat for nerds as the web does

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 14: "Next: …" and the transition sheet

`TransitionLine` is the "Next: 32-beat blend · 124 → 126 BPM · 8A → 9A" line. It shows only with DJ mix, when the next song is wanted mixed. It opens `TransitionSheet`, which holds all of TransitionView's sheet:

- the style and why, with "Getting the mix ready…" while the file is made;
- both songs' tempo and key;
- `EnergyAroundTheMix`, the energy picture, where a tap reads the time and the Numbers section shows the plan's figures;
- this queue's mixing (Auto, Party, No mixing) with the web's hints.

The line watches both songs' mix maps while it's on screen.

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Transitions/TransitionLine.swift`
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Transitions/TransitionSheet.swift`
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Transitions/EnergyAroundTheMix.swift`
- Modify: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/NowPlaying/NowPlayingView.swift`
- Modify: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Queue/QueueView.swift`

**Step 1: Write the views**

Create `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Transitions/TransitionLine.swift`:

```swift
import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// "Next: 32-beat blend · 124 → 126 BPM · 8A → 9A" under Now Playing's transport and the queue's current song,
/// opening the transition sheet. Only with DJ mix, and only when the next song is wanted mixed (not when the sleep
/// timer stops after this one). As `TransitionView` in apps/web/src/components/TransitionView.tsx.
public struct TransitionLine: View {
  let player: Player
  @State private var open = false

  public init(player: Player) { self.player = player }

  /// The two songs, when the line shows at all.
  private var pair: (from: Track, to: Track)? {
    guard player.settings.transitions == .dj, !player.sleep.endOfSong, let from = player.queue.currentTrack,
      let to = player.queue.upNext, from.fileId != to.fileId
    else { return nil }
    let upcoming = player.transitions.planner.upcoming
    // With mixing on, the planner names the pair it's working on; any other pair isn't mixed.
    let wanted = player.queue.mixMode == .off || (upcoming.fromFileId == from.fileId && upcoming.toFileId == to.fileId)
    return wanted ? (from, to) : nil
  }

  public var body: some View {
    if let pair {
      let maps = player.transitions.mixMaps
      let words = TransitionWords.describe(player.transitions.result(from: pair.from, to: pair.to), mixMode: player.queue.mixMode)
      let text = TransitionWords.line(words, maps.map(pair.from.recordingId), maps.map(pair.to.recordingId))
      Button {
        open = true
      } label: {
        Label(text, systemImage: "arrow.triangle.merge")
          .font(.footnote.monospacedDigit())
          .lineLimit(1)
          .foregroundStyle(.secondary)
          .frame(minHeight: 44)
      }
      .buttonStyle(.plain)
      .accessibilityLabel(TransitionWords.spoken(text))
      .accessibilityHint("Shows how the next song comes in")
      .task(id: [pair.from.recordingId, pair.to.recordingId]) { maps.watch([pair.from.recordingId, pair.to.recordingId]) }
      .sheet(isPresented: $open) {
        TransitionSheet(player: player, from: pair.from, to: pair.to)
          .presentationDetents([.medium, .large])
      }
    }
  }
}
```

Create `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Transitions/TransitionSheet.swift`:

```swift
import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// The next transition: its style and why, both songs' tempo and key, their energy around the mix, and this queue's
/// mixing (Auto, Party, No mixing). The `Sheet` of TransitionView.tsx.
struct TransitionSheet: View {
  let player: Player
  let from: Track
  let to: Track

  var body: some View {
    let maps = player.transitions.mixMaps
    let a = maps.map(from.recordingId), b = maps.map(to.recordingId)
    let words = TransitionWords.describe(player.transitions.result(from: from, to: to), mixMode: player.queue.mixMode)
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 24) {
          VStack(alignment: .leading, spacing: 6) {
            Text(words.style.prefix(1).uppercased() + words.style.dropFirst())
              .font(.title2.weight(.semibold))
            if words.preparing {
              Text("Getting the mix ready…".uppercased())
                .font(.caption2.monospaced())
                .tracking(1.5)
                .foregroundStyle(.secondary)
            }
            Text(words.why)
              .font(.subheadline)
              .foregroundStyle(.secondary)
          }
          VStack(alignment: .leading, spacing: 6) {
            facts("Now", from, a)
            facts("Next", to, b)
          }
          if let plan = words.plan, let a, let b {
            EnergyAroundTheMix(strips: EnergyPicture.aroundTheMix(plan, a: (from.title, a), b: (to.title, b)))
          }
          VStack(alignment: .leading, spacing: 8) {
            Text("Mixing for this queue".uppercased())
              .font(.caption2.monospaced())
              .tracking(2)
              .foregroundStyle(.secondary)
            Picker("Mixing for this queue", selection: Binding(get: { player.queue.mixMode }, set: { player.setMixMode($0) })) {
              ForEach(TransitionWords.modes) { Text($0.label).tag($0.value) }
            }
            .pickerStyle(.segmented)
            Text(TransitionWords.modes.first { $0.value == player.queue.mixMode }?.hint ?? "")
              .font(.footnote)
              .foregroundStyle(.secondary)
          }
        }
        .padding(20)
      }
      .navigationTitle("Next transition")
      #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
      #endif
    }
  }

  private func facts(_ label: String, _ track: Track, _ map: MixMapEntry?) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 12) {
      Text(label.uppercased())
        .font(.caption2.monospaced())
        .foregroundStyle(.secondary)
        .frame(width: 40, alignment: .leading)
      Text(track.title)
        .lineLimit(1)
        .frame(maxWidth: .infinity, alignment: .leading)
      if let facts = TransitionWords.songFacts(map) {
        Text(facts)
          .monospacedDigit()
          .foregroundStyle(.secondary)
      }
    }
    .font(.subheadline)
  }
}
```

Create `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Transitions/EnergyAroundTheMix.swift`:

```swift
import PlayarrPlayer
import SwiftUI

/// Both songs' energy per phrase around the mix, on one clock: the shaded mix is the same stretch in both. One colour
/// (the accent), bar ticks underneath, a phrase's time and energy on a tap, and the numbers under "Numbers".
struct EnergyAroundTheMix: View {
  let strips: [EnergyPicture.Strip]
  @State private var picked: (strip: Int, phrase: Int)?

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .firstTextBaseline) {
        Text("Energy around the mix".uppercased())
          .font(.caption2.monospaced())
          .tracking(2)
          .foregroundStyle(.secondary)
        Spacer()
        if let picked, strips.indices.contains(picked.strip), strips[picked.strip].phrases.indices.contains(picked.phrase) {
          let phrase = strips[picked.strip].phrases[picked.phrase]
          Text("\(NerdFormat.time(phrase.at)) · \(Int((phrase.energy * 100).rounded()))%")
            .font(.footnote.monospacedDigit())
        }
      }
      ForEach(strips.indices, id: \.self) { i in
        let strip = strips[i]
        VStack(alignment: .leading, spacing: 4) {
          HStack {
            Text(strip.title).lineLimit(1).foregroundStyle(.secondary)
            Spacer()
            Text(strip.note).monospacedDigit().foregroundStyle(.tertiary)
          }
          .font(.caption)
          GeometryReader { geo in
            canvas(strip, index: i, size: geo.size)
              .contentShape(Rectangle())
              .onTapGesture { location in
                let x = location.x / geo.size.width
                if let k = strip.phrases.firstIndex(where: { x >= $0.left && x <= $0.left + $0.width }) { picked = (i, k) }
              }
          }
          .frame(height: 54)
          .accessibilityHidden(true)
        }
      }
      DisclosureGroup("Numbers") {
        Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 4) {
          GridRow {
            Text("Song")
            Text("From").gridColumnAlignment(.trailing)
            Text("Energy").gridColumnAlignment(.trailing)
            Text("In the mix").gridColumnAlignment(.trailing)
          }
          .font(.caption2.monospaced())
          .foregroundStyle(.secondary)
          ForEach(strips.indices, id: \.self) { i in
            ForEach(strips[i].phrases.indices, id: \.self) { k in
              let p = strips[i].phrases[k]
              GridRow {
                Text(strips[i].title).lineLimit(1)
                Text(NerdFormat.time(p.at))
                Text("\(Int((p.energy * 100).rounded()))%")
                Text(p.inMix ? "Yes" : "")
              }
              .font(.footnote.monospacedDigit())
            }
          }
        }
      }
      .font(.caption2.monospaced())
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Energy around the mix")
  }

  private func canvas(_ strip: EnergyPicture.Strip, index: Int, size: CGSize) -> some View {
    Canvas { context, size in
      let w = size.width, h = size.height - 8
      // The mix: shaded with edges strong enough to see, or a line for a straight cut.
      let mix = CGRect(x: strip.mixLeft * w, y: 0, width: max(1, strip.mixWidth * w), height: h)
      context.fill(Path(mix), with: .color(.primary.opacity(strip.mixWidth > 0 ? 0.08 : 0.5)))
      if strip.mixWidth > 0 {
        context.stroke(Path { $0.move(to: CGPoint(x: mix.minX, y: 0)); $0.addLine(to: CGPoint(x: mix.minX, y: h)) }, with: .color(.primary.opacity(0.45)))
        context.stroke(Path { $0.move(to: CGPoint(x: mix.maxX, y: 0)); $0.addLine(to: CGPoint(x: mix.maxX, y: h)) }, with: .color(.primary.opacity(0.45)))
      }
      for (k, p) in strip.phrases.enumerated() {
        let height = max(2, EnergyPicture.heardHeight(p.energy) * h)
        let rect = CGRect(x: p.left * w, y: h - height, width: max(1, p.width * w - 2), height: height)
        let dimmed = picked.map { $0.strip != index || $0.phrase != k } ?? false
        context.fill(Path(roundedRect: rect, cornerRadius: 3), with: .color(.accentColor.opacity(dimmed ? 0.45 : 1)))
      }
      context.fill(Path(CGRect(x: 0, y: h - 0.5, width: w, height: 0.5)), with: .color(.secondary))
      for bar in strip.bars {
        let tick = CGRect(x: bar.left * w, y: h + 2, width: 1, height: bar.phrase ? 6 : 4)
        context.fill(Path(tick), with: .color(.primary.opacity(bar.phrase ? 0.4 : 0.15)))
      }
    }
  }
}
```

**Step 2: Show the line under Now Playing's transport and the queue's current song**

In `NowPlaying/NowPlayingView.swift`, replace:

```swift
          SeekBar(player: player)
          Transport(player: player)
```

with:

```swift
          SeekBar(player: player)
          Transport(player: player)
          TransitionLine(player: player)
```

In `Pages/Queue/QueueView.swift`, replace:

```swift
          Section {
            nowPlaying(track)
          } header: {
```

with:

```swift
          Section {
            nowPlaying(track)
            TransitionLine(player: session.player)
          } header: {
```

(If phase 4 laid these out differently, put the line right under the transport, and as the second row of the queue's "Now playing" section.)

**Step 3: Build and test**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI 2>&1 | tail -1
make -C apps/ios build
```

Expected: the UI package's tests pass, and the app builds for the simulator.

**Step 4: Look at it**

Run the app on the simulator against the dev server (`make -C apps/ios build`, then install and launch as phase 3's Task 21 does). Turn on Settings → Playback → DJ mix and play an album shuffled. Now Playing shows "Next: …" with the style (and BPM and keys once the maps are in). Tapping it opens "Next transition"; switching to No mixing hides the line, and Auto brings it back. With VoiceOver on, the line reads "Next: … beats per minute …" and its hint.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Transitions/TransitionLine.swift \
  apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Transitions/TransitionSheet.swift \
  apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Transitions/EnergyAroundTheMix.swift \
  apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/NowPlaying/NowPlayingView.swift \
  apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Queue/QueueView.swift
git commit -F - <<'EOF'
Show the next transition under Now Playing and in the Queue, with its sheet

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 15: Stats for nerds

The overlay floats over the app when Settings → Appearance → Stats for nerds is on, and holds every group of `NerdStats`:

- it's dragged by its header and kept on screen;
- it collapses to one line (tempo, key, bar.beat, loudness) with the beat dots;
- it closes with the web's toast and an Undo.

It refreshes ten times a second while playing (once a second paused), loads the song's metadata once per song, and watches its mix map.

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/StatsForNerds/StatsForNerdsOverlay.swift`
- Modify: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/AppShell.swift`

**Step 1: Write the overlay**

Create `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/StatsForNerds/StatsForNerdsOverlay.swift`:

```swift
import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// Settings → Appearance → Stats for nerds: everything known about the song playing, over the app. Dragged by its
/// header, collapsed to one line (tempo, key, bar.beat, loudness), closed with an undo. As StatsForNerds.tsx.
public struct StatsForNerdsOverlay: View {
  let player: Player
  let appearance: AppearanceSettings
  let toasts: ToastCenter
  let metadata: @Sendable (Int) async -> TrackMetadata?

  @State private var open = true
  @State private var offset: CGSize = .zero
  @State private var dragStart: CGSize?
  @State private var meta: TrackMetadata?

  public init(player: Player, appearance: AppearanceSettings, toasts: ToastCenter, metadata: @escaping @Sendable (Int) async -> TrackMetadata?) {
    self.player = player
    self.appearance = appearance
    self.toasts = toasts
    self.metadata = metadata
  }

  public var body: some View {
    if appearance.statsForNerds, let track = player.queue.currentTrack {
      GeometryReader { geo in
        let width = min(geo.size.width - 16, 360)
        TimelineView(.periodic(from: .now, by: player.queue.playing ? 0.1 : 1)) { _ in
          panel(track, width: width)
        }
        .frame(width: width)
        .offset(clamped(offset, in: geo.size, width: width))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
        .padding(.top, 60)
        .padding(.trailing, 8)
      }
      .task(id: track.id) {
        meta = nil
        meta = await metadata(track.id)
        player.transitions.mixMaps.watch([track.recordingId])
      }
    }
  }

  private func input(_ track: Track) -> NerdStats.Input {
    let maps = player.transitions.mixMaps
    let next = player.queue.upNext
    let result = next.flatMap { player.transitions.result(from: track, to: $0) }
    let level = player.levels.levels[track.recordingId]
    let item = player.engine.currentItem
    return NerdStats.Input(
      track: track, time: player.time, duration: player.duration, buffered: player.buffered, loading: player.loading,
      playing: player.queue.playing, error: player.error, map: maps.map(track.recordingId), level: level, metadata: meta,
      gainDb: item?.gainDb ?? 0, levelVolume: player.settings.levelVolume,
      albumGain: level?.album != nil && item?.gainDb == level?.album && level?.album != level?.track,
      transitions: player.settings.transitions, crossfade: player.settings.crossfade, mixMode: player.queue.mixMode, next: next,
      upcoming: result, djWanted: player.transitions.planner.upcoming.fromFileId == track.fileId, mixMissed: player.upcomingMixMissed,
      mix: player.engine.mix, engineNow: player.engine.now, reports: player.engine.mixReports, decks: player.engine.snapshot().decks,
      continuation: item?.continuation)
  }

  private func panel(_ track: Track, width: CGFloat) -> some View {
    let input = input(track)
    let grid = input.map.flatMap { NerdStats.gridPosition($0, input.time) }
    return VStack(spacing: 0) {
      header(summary: NerdStats.summary(map: input.map, level: input.level, time: input.time), beat: grid?.beat)
      if open {
        Divider()
        ScrollView {
          VStack(alignment: .leading, spacing: 8) {
            ForEach(NerdStats.groups(input)) { group in
              VStack(alignment: .leading, spacing: 2) {
                Text(group.title.uppercased())
                  .font(.system(size: 9.5, design: .monospaced))
                  .tracking(2)
                  .foregroundStyle(Color.accentColor)
                Grid(alignment: .topLeading, horizontalSpacing: 8, verticalSpacing: 1) {
                  ForEach(group.rows) { row in
                    GridRow {
                      Text(row.label).foregroundStyle(.secondary).frame(width: 92, alignment: .leading)
                      value(row.value)
                    }
                  }
                }
              }
            }
          }
          .padding(10)
        }
        .frame(maxHeight: 520)
      }
    }
    .font(.system(size: 11, design: .monospaced).monospacedDigit())
    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 10))
    .overlay(RoundedRectangle(cornerRadius: 10).stroke(.primary.opacity(0.1)))
    .shadow(radius: 20)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Stats for nerds")
  }

  private func header(summary: String, beat: Int?) -> some View {
    HStack(spacing: 8) {
      Text("Stats for nerds".uppercased())
        .font(.system(size: 10, design: .monospaced))
        .tracking(2)
      if let beat {
        HStack(spacing: 4) {
          ForEach(1...4, id: \.self) { b in
            Circle()
              .fill(b != beat ? Color.primary.opacity(0.15) : b == 1 ? Color.accentColor : Color.primary)
              .frame(width: 6, height: 6)
          }
        }
        .accessibilityHidden(true)
      }
      Text(open ? "" : summary)
        .lineLimit(1)
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, alignment: .trailing)
      Button(open ? "Collapse" : "Expand", systemImage: open ? "minus" : "plus") { open.toggle() }
        .labelStyle(.iconOnly)
        .frame(width: 44, height: 32)
      Button("Turn off stats for nerds", systemImage: "xmark") { turnOff() }
        .labelStyle(.iconOnly)
        .frame(width: 44, height: 32)
    }
    .buttonStyle(.plain)
    .padding(.leading, 10)
    .frame(height: 36)
    .contentShape(Rectangle())
    .gesture(
      DragGesture()
        .onChanged { drag in
          let start = dragStart ?? offset
          dragStart = start
          offset = CGSize(width: start.width + drag.translation.width, height: start.height + drag.translation.height)
        }
        .onEnded { _ in dragStart = nil })
  }

  @ViewBuilder private func value(_ value: NerdStats.Row.Value) -> some View {
    switch value {
    case .text(let text): Text(text).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
    case .error(let text): Text(text).foregroundStyle(.red)
    case .energy(let strip): PhraseEnergyStrip(strip: strip)
    }
  }

  /// Kept inside the screen: at most to the left edge and the bottom.
  private func clamped(_ offset: CGSize, in size: CGSize, width: CGFloat) -> CGSize {
    CGSize(width: min(0, max(-(size.width - width - 16), offset.width)), height: min(max(-60, offset.height), size.height - 120))
  }

  private func turnOff() {
    appearance.statsForNerds = false
    let appearance = self.appearance
    toasts.push("Stats for nerds is off: it’s in Settings → Appearance.", action: ToastCenter.Action("Undo") { appearance.statsForNerds = true })
  }
}

/// Each phrase's energy over the whole song, the one playing in the accent colour, with lines where the intro ends
/// (sky) and the outro starts (rose).
struct PhraseEnergyStrip: View {
  let strip: NerdStats.EnergyStrip

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      HStack(spacing: 8) {
        GeometryReader { geo in
          ZStack(alignment: .bottomLeading) {
            HStack(alignment: .bottom, spacing: 1) {
              ForEach(strip.bars.indices, id: \.self) { k in
                let bar = strip.bars[k]
                RoundedRectangle(cornerRadius: 1)
                  .fill(color(bar.state))
                  .frame(height: geo.size.height * bar.height)
              }
            }
            marker(.cyan, at: strip.introAt, width: geo.size.width)
            marker(.pink, at: strip.outroAt, width: geo.size.width)
          }
        }
        .frame(height: 20)
        Text(strip.energyNow)
      }
      HStack(spacing: 12) {
        Label(strip.introLabel, systemImage: "line.diagonal").labelStyle(.titleOnly).foregroundStyle(.cyan)
        Label(strip.outroLabel, systemImage: "line.diagonal").labelStyle(.titleOnly).foregroundStyle(.pink)
      }
      .font(.system(size: 10, design: .monospaced))
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Phrase energy, now \(strip.energyNow); \(strip.introLabel); \(strip.outroLabel)")
  }

  private func color(_ state: NerdStats.EnergyStrip.State) -> Color {
    switch state {
    case .unmeasured: .primary.opacity(0.05)
    case .now: .accentColor
    case .past: .primary.opacity(0.35)
    case .future: .primary.opacity(0.15)
    }
  }

  private func marker(_ color: Color, at x: Double, width: CGFloat) -> some View {
    Rectangle().fill(color).frame(width: 1).offset(x: x * width).padding(.vertical, -2)
  }
}
```

**Step 2: Mount it over the app and over Now Playing**

Now Playing is a full-screen cover above the shell, so the overlay goes on both. In `Shell/AppShell.swift`, replace:

```swift
        .overlay(alignment: .top) { ToastsView().environment(model.toasts).environment(model.theme) }
    }
    .overlay(alignment: .top) { ToastsView() }
```

with:

```swift
        .overlay(alignment: .top) { ToastsView().environment(model.toasts).environment(model.theme) }
        .overlay { stats }
    }
    .overlay(alignment: .top) { ToastsView() }
    .overlay { stats }
```

and add to `AppShell`, after `body`:

```swift
  /// Settings → Appearance → Stats for nerds.
  private var stats: some View {
    StatsForNerdsOverlay(
      player: session.player, appearance: model.appearance, toasts: model.toasts,
      metadata: { [api = session.api] id in try? await api.send(API.Library.trackMetadata(id: id)) })
  }
```

(`AppShell.swift` needs `import PlayarrAPI` if it doesn't have it.)

**Step 3: Build and test**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI 2>&1 | tail -1
make -C apps/ios test
```

Expected: everything passes: scripts, the three packages and the app's UI tests.

**Step 4: Look at it**

In the simulator, turn on Settings → Appearance → Stats for nerds and play something with DJ mix:

- The panel shows Song, Playback (with Deck A, Deck B, Transition), Rhythm, Structure, Loudness, Sound and Next.
- It drags anywhere on screen but not off it, and collapses to its summary line.
- After a mix, Playback shows "Mix in" and "Mix out", each with its sample, song time and headroom.
- × turns it off with the toast "Stats for nerds is off: it’s in Settings → Appearance." and Undo brings it back.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/StatsForNerds/StatsForNerdsOverlay.swift \
  apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/AppShell.swift
git commit -F - <<'EOF'
Add Stats for nerds to the iOS app: draggable, collapsible, closable with undo

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 16: Mixes on the phone, then TestFlight

No code, unless something below fails: then fix it test-first in the task it belongs to, and commit there.

**Files:** none.

**Step 1: The dev server and real songs**

The NAS isn't reachable from Claude's shell (macOS Local Network). Ask the user to start the dev server if it needs the NAS (`corepack pnpm -C apps/server dev`). Check that the server renders transitions: `curl -s -X POST localhost:3000/api/transitions -H 'content-type: application/json' -d '{"from":<id>,"to":<id>,"mode":"auto"}'` (with a session) answers `pending`, then `ready`. Pick a playlist that mixes well (similar tempos) and one album of MP3s.

**Step 2: On a phone**

```bash
corepack pnpm ios:device
```

Settings → Playback → DJ mix, Even volume on, and Stats for nerds on for the checks that read it. The on-device checklist (each line: expected result):

- [ ] **A mix on a locked phone**: play a playlist with DJ mix, lock the phone, listen through three mixes. Each is the server's transition (no click, no jump, no doubled beat at mix in or mix out), and the lock screen changes song mid-blend. Unlock: Stats for nerds' Mix in / Mix out say "server", with headroom above 0.
- [ ] **MP3 into MP3**: a mix between two MP3s (Next shows a long blend) has no doubled or missing beat at mix out (the continuation), nor at mix in. A slip at mix in would be the MP3 priming difference between the server's decoder and Apple's: note it under the risks below.
- [ ] **Next pressed mid-song**: press Next in the middle of a song with a steady beat. Within about 3 s the next song comes in on A's next bar as a short blend (not a cut). Stats for nerds' Mix in says "live", and the play report counts the first song as skipped. Press Next twice quickly: the song changes at once.
- [ ] **Next pressed on the lock screen and with AirPods**: same as above.
- [ ] **A pending render**: start a mix whose transition isn't made yet (a new pair, Next shows "Getting the mix ready…"). The sheet's status moves through the server's steps. If it's ready before the mix point, it plays. If not, a fade or quick mix is played live, or a long blend becomes a cut on the beat, never a gap or a jump.
- [ ] **Seek near a mix**: seek to 2 s before a ready mix's start. The song plays on alone and joins without a gap (key decision 10). Seek back to well before it: the mix plays.
- [ ] **No mixing for this queue** (in the sheet): the next song follows gapless; Auto: the line comes back and the mix plays.
- [ ] **An album in order** (the album's page, play): its songs go straight on (Next says straight on), never cut or blended.
- [ ] **The sleep timer, end of song**: set it while a mix is a minute away. No mix is asked (Next disappears), the song ends, and the next one is shown, paused. Set it in the middle of a mix: the mix plays out and the music pauses where it ends.
- [ ] **A slow network** (Network Link Conditioner, "3G"): mixes still land on the beat. A missed one says so in Stats for nerds ("placed too late") and joins gapless.
- [ ] **Offline with a kept transition**: phase 7 keeps transitions with downloads. Here, only check that airplane mode just before a mix whose file is already downloaded still plays it. The rest is phase 7's.
- [ ] **Stats for nerds**: drag, collapse, close with undo, rotate the phone; the panel stays on screen and readable with the largest Dynamic Type.
- [ ] **Battery and heat**: an hour of DJ mix with the screen off doesn't warm the phone more than plain playback.

**Step 3: TestFlight**

If the checklist passes, ask the user whether to ship a build to TestFlight (`corepack pnpm ios:beta`), as each phase ends with one.

---

## Seams for later phases

**Phase 7 (offline).** Its Task 6 finds `transition(_:)` and `transitionRequest(_:)` already in `PlayerBackend`, with its signatures, and `FakeBackend`'s `transitionAnswers` and `transitionAsks` in its shape, so it skips them. Its Task 4 creates `Support/Recorder.swift`, which is here already in the same words. Its Task 13, step 5 maps onto these names:

1. **Before asking**: set `player.transitions.planner.kept` where the Player is made. The hook receives the planner's `Pair` and `online`, and returns the kept ready answer or nil. The planner already applies "online, only if it's still more than 20 s before the mix point" itself, so the closure only looks it up:

   ```swift
   transitions.planner.kept = { [weak downloads] pair, online in
     downloads?.keptTransition(from: pair.from, to: pair.to, mode: pair.mode, online: online, levelled: pair.levels != nil)?.transition.answer
   }
   ```

   Offline, the planner asks nothing either way (`isOnline`).
2. **Where a ready answer's file is downloaded**: in `Player.init`'s `download:` closure, first `if let local = downloads.keptTransitionFile(path) { return local }`.
3. **The player's pair**: `downloads.playerPair = { [weak self] in self?.transitions.planner.upcoming.fromFileId.flatMap { from in self?.transitions.planner.upcoming.toFileId.map { (fromFileId: from, toFileId: $0) } } }`. Call `downloads.playerMoved()` in the Player's `transitions.onChange` closure, which runs on every change of the planner's pair or answer.

**Phase 8 (Edit mix points).** It calls `player.mixPointsChanged(recordingId:)` after saving (Task 12 here).

## Risks, and how this plan meets them

- **MP3 priming at mix in.** The server decodes A with ffmpeg and the phone with Apple's decoder. If they trim a different number of priming samples, the cut lands a few hundred samples off: heard as a small slip, not a gap. The continuation fixes mix out. Task 16 checks mix in on a device. If it slips, the fix is cutting at the lead's start, where the file holds only A, or making a continuation for A too.
- **Songs at 48 kHz.** The server resamples with ffmpeg and the phone with `AVAudioConverter`. Sample positions agree, but the filters' phase may differ by a fraction of a sample at the cut. That's inaudible inside the lead, where both hold the same sound.
- **2.5 s scheduled ahead in the background.** The main actor pumps the decks twice a second. With the screen locked that's enough (audio apps keep running), but a long main-thread stall would run a deck short. The engine then pauses and reloads, the mix is abandoned and the songs join gapless. The locked-phone line of the checklist watches for it.
- **Seeking inside a transition** abandons it (key decision 10) rather than seeking in it as the web does.
- **The phase 4 edits** (Tasks 14, 15) were written against phase 4's plan and not compiled here. Their anchors are given so a drift is easy to fix.

## Not in this phase

Transitions kept with downloads and played offline (phase 7, through `TransitionPlanner.kept`); Edit mix points and Show metadata in the song menus (phase 8); the admin Mixes and Analysis settings (phase 9); keyboard shortcuts (phase 10).
