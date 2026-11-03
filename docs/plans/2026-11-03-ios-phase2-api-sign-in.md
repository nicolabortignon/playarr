# Native iOS app, Phase 2: API Layer and Sign-in Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** The app connects to a Playarr server (found by Bonjour or typed as an address), signs in, redeems a setup code, or claims a server in setup mode from the home network. It lists and switches servers and accounts, and keeps tokens in the Keychain. Swift models are generated from the TypeScript types, and contract tests decode real server answers.

**Architecture:** `pnpm ios:models` reads `packages/shared` and `packages/mix/src/types.ts` with `ts-json-schema-generator` and turns the JSON Schema into `Models.generated.swift` with a small emitter in `apps/ios/scripts/gen-models.mjs`. The server's route tests save real answers as fixtures when `RECORD_FIXTURES=1`. `PlayarrAPI` has an `APIClient` actor (one per server and account) that sends `Endpoint<T>` values, and every endpoint is a typed constructor under `API.<Feature>`. It also has `MediaURLs` (the token goes in a header, never in a URL), a `ServerStore` (`@MainActor @Observable`: servers as JSON in Application Support, tokens through a `SecretStore`, the Keychain in the app) and a `ServerBrowser` (NWBrowser). `PlayarrUI` adds a minimal `AppModel` and `AddServerModel` and the sign-in screens.

**Tech Stack:** Swift 6.4 (Xcode 27), Swift 6 language mode with strict concurrency, SwiftUI, Observation, Network, Security, Swift Testing. Node 24+ with `ts-json-schema-generator` 2.9.0 (its own TypeScript 5 inside; the repo's TypeScript 7 is untouched). Server tests: vitest 5, Fastify 5. No third-party Swift packages.

**Design:** [2026-11-03-ios-app-design.md](2026-11-03-ios-app-design.md), sections 1 and 2 and the Rollout table (phase 2). Names, layout and server contracts: [2026-11-03-ios-conventions.md](2026-11-03-ios-conventions.md). Endpoints and types: [2026-11-03-ios-parity-inventory.md](2026-11-03-ios-parity-inventory.md), sections 3 and 10.

---

## Key decisions in this plan

**The model generator: `ts-json-schema-generator` plus our own emitter (option a).** Three options were weighed:

- *quicktype* (b) was rejected. It is a large dependency tree. Its Swift output is its own: it has no `unknown(String)` fallback, and it names nested types and chooses Int or Double by itself. Bending it to our rules means post-processing its output, which is more moving parts than writing the emitter.
- *The TypeScript compiler API* (c) was rejected. The repo's TypeScript 7 is the native (Go) compiler: its JS API is published only as `typescript/unstable/*` over IPC to the binary. Using it means depending on an unstable API, or adding TypeScript 5 anyway and writing a type walker (unions, `extends`, `Partial`, `Record`, template literals) ourselves.
- *`ts-json-schema-generator` + emitter* (a) was chosen. It is one pinned devDependency that already resolves `extends`, `Partial<>`, `Record<>`, literal unions, tuples and JSDoc into plain JSON Schema. The emitter (about 300 lines, no dependencies) only maps schema to Swift, so every Swift rule is ours and visible. Output is deterministic: definitions are sorted by name, properties keep their TypeScript order, and the versions are pinned by the lockfile. A prototype of the generator in this plan was run against today's types (plus the phase 1 account types). It produced 3,100 lines that compile under Swift 6, and all 52 recorded fixtures decoded.

**Swift rules for generated types.**
- `interface` becomes `struct ...: Codable, Hashable, Sendable`, plus `Identifiable` when it has a non-optional `id`. Every struct gets a memberwise `public init`.
- An optional property becomes `T?`, and so does `T | null`. A property that is both optional and nullable becomes `T??`: `nil` leaves it out and `.some(nil)` sends `null`, as `RequestSettingsPatch` needs. A required but nullable property (`Account.sources`) is encoded as an explicit `null`.
- A string literal union becomes an enum with `case unknown(String)`, so a value added on the server never breaks decoding. A literal `none` becomes `noneValue`, because `.none` on an optional enum silently means `Optional.none`. Swift keywords are escaped with backticks (`` `repeat` ``).
- A union of objects tagged by one string property (`TransitionAnswer.status`, `RematchResult.kind`) becomes an enum with associated values. Each variant is a nested struct without the tag (`TransitionAnswer.Ready`), plus `case unknown(String)`. Decoding reads the tag, then decodes the variant from the same decoder.
- **Number vs integer:** `number` maps to `Double`, except names that are ids or counts, which map to `Int`. Those are `id`, names ending in `Id`/`Ids`/`Count`, and an explicit `INTEGERS` list in the script (`trackNumber`, `year`, `size`, `plays`, `version`, …). A numeric literal union (`UpdateInterval`, `MixSettings.length`) also maps to `Int`. Why: ids and counts are SQLite integers on the server and the app uses them as keys and in paths (`/api/albums/70`, not `70.0`). Durations, gains and confidences are fractional and stay `Double`. A wrong guess fails loudly, because a `12.5` decoded into an `Int` throws, and the contract tests decode real answers.
- `Record<string, T>` becomes `[String: T]`. Arrays and tuples become `[T]`. `Partial<Record<MixKind, boolean>>` becomes a struct of optional `Bool`s. `StatsRange` and `Camelot` (template literals) become `typealias ... = String`.
- An inline object type becomes a nested struct named after its property (`HealthStatus.Media`), with `Item` added inside arrays (`ListeningStats.TopArtistsItem`). The emitter refuses a nested name that would hide a top-level type.
- Dates stay `String` (ISO 8601 from the server), as the conventions require. `MIX_MAP_VERSION` is emitted as `public let mixMapVersion`.

**Types the web kept to itself move into the shared packages first (Task 1).** `AnalysisKind`, `AnalysisProgress` and the `Partial<…>` patch bodies move to `packages/shared`. `TransitionAnswer` (with its `RenderProgress`) and `MixMapEntry` (`MixMap & { cues? }`) move to `packages/mix/src/types.ts`, next to `TransitionPlan`. `packages/shared` doesn't depend on `@playarr/mix`, so this adds no new workspace dependency. The server already had its own copy of `TransitionAnswer`; it now re-exports the shared one. The web's `api.ts` re-exports them, so no other web file changes.

**Fixtures come from one contract test file, plus a few lines in existing tests.** Most existing route tests feed partial fakes (`{ style: 'quick' } as never`). Their answers wouldn't decode into the full types, and many endpoint families (library, playlists, mixes, discover) have no route test at all. So `apps/server/src/routes/contract.test.ts` builds each route group the way the existing tests do. It uses the real services over the Mezzanine test catalog where that is cheap (library, search, metadata, favorites, playlists, plays, stats, settings). It uses fully typed fakes (no casts on the values) where the real service talks to MusicBrainz, Lidarr or the renderer. Existing tests whose answers are already complete and real (settings, MusicBrainz status, levels) get a `recordFixture(...)` line. Phase 1's auth and account tests get one too. Timestamps are pinned and tokens and random ids are tidied, so recording twice gives identical files. That is checked: two recordings had the same checksum. CI records again and fails on any difference.

**401 handling.** A 401 to a request that carried a token means the session ended: `APIError.unauthorized`, and `ServerStore` marks that account signed out (token deleted, account kept in the list to sign in again). A 401 to a request without a token (a wrong password at sign-in) keeps the server's message: `APIError.server(status: 401, message:)`.

## Conventions

- Run everything from the repo root `/Users/bortignon/dev/playarr`. `pnpm` is `corepack pnpm` in Claude's shell.
- Swift package tests: `swift test --package-path apps/ios/Packages/PlayarrAPI` (one suite: `--filter EndpointTests`). Same for `PlayarrUI`. In Claude's shell SwiftPM's own sandbox can't start (`sandbox_apply: Operation not permitted`): add `--disable-sandbox` to every `swift build` / `swift test` there.
- Everything iOS (packages, then the app and UI tests on the simulator): `make -C apps/ios test`.
- Server tests: `corepack pnpm -C apps/server test`, or only the routes: `corepack pnpm -C apps/server exec vitest run src/routes`. Server typecheck: `corepack pnpm -C apps/server typecheck`. The 3 `onnxruntime-web` errors it prints exist before this plan (the package isn't installed in this checkout); nothing else may appear.
- Web: `corepack pnpm -C apps/web typecheck`, `corepack pnpm -C apps/web exec vitest run <files>`. `AnalysisPanel.test.tsx` already prints 22 "The animation was canceled" unhandled errors with all tests passing; that is not a failure of this plan.
- Recording fixtures: `RECORD_FIXTURES=1 corepack pnpm -C apps/server exec vitest run src/routes`.
- Swift: one primary type per file, named after it. No force unwraps outside tests. Swift Testing (`import Testing`) only.
- Commit after every task, directly on `main`, only that task's files, with a plain-English subject and the `Co-Authored-By` line. The pre-commit hook bumps the version; never bypass it. The user pushes.

## Before you start

Phases 0 and 1 are done. This plan relies on:

- **Phase 0:** `apps/ios/project.yml` with an app target `Playarr` (Info.plist generated from `info.properties`, written to `Config/Info.plist`). It also needs `apps/ios/Makefile` with `bootstrap`, `build` and `test`, the three packages under `apps/ios/Packages/` with placeholder sources and tests, `apps/ios/Playarr/PlayarrApp.swift`, and the `ios:*` scripts in the root `package.json`. Check with `ls apps/ios apps/ios/Packages/*/Sources/* && grep '"ios:' package.json`.
- **Phase 1:** in `packages/shared/src/index.ts`: `AccountRole`, `Account`, `SessionInfo`, `ServerInfo`, `SignInResponse`, `SetupCode`. On the server: the routes of the conventions table (`/api/server`, `/api/auth/*`, `/api/accounts*`) with route tests under `apps/server/src/routes/`. Check with `grep -n "export interface \(Account\|ServerInfo\|SignInResponse\|SetupCode\|SessionInfo\)" packages/shared/src/index.ts`.

Phase 1's plan ([2026-11-03-ios-phase1-accounts.md](2026-11-03-ios-phase1-accounts.md)) keeps route tests working on bare Fastify apps. Without its auth hook, `req.auth` is `undefined`: the rights helpers treat that as setup mode, and `libraryOf(library, req)` returns the whole library. So the route groups built below need no accounts. Phase 1 also drops `profiles` from `mixRoutes`' deps; the code below doesn't pass it. If a dependency still changed (TypeScript says so, or a route answers 401 or 500), pass what phase 1's own test for that route passes (`apps/server/src/accounts/testAccess.ts` has `actAs`/`account`). The answers being recorded stay the same.

---
### Task 1: Move the answer types the app needs into the shared packages

The generator reads only `packages/shared/src/index.ts` and `packages/mix/src/types.ts`. Five types the app decodes live in the web client or the server today. This task moves them, with no change in behaviour.

**Files:**
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/mix/src/types.ts`
- Modify: `apps/server/src/transitions/transitions.ts`
- Modify: `apps/web/src/lib/api.ts`

**Step 1: Add the types to `packages/shared/src/index.ts`**

Append at the end of the file:

```ts
// ── Settings → Analysis (here, not in the web client, so the iOS models are generated from it) ──

/** The analyses Settings → Analysis runs over the library. */
export type AnalysisKind = 'beats' | 'sound' | 'loudness' | 'tags';

/** How far each analysis has got over the library (GET /api/analysis/progress). */
export interface AnalysisProgress {
  /** Audio analysis is on (beat and sound analysis need it; tags are looked up without). */
  enabled: boolean;
  /** Songs in the library. */
  songs: number;
  /** Songs with a mix map; of those, the ones whose beats the beat model found; failed lately (tried again a day later). */
  beats: { ready: number; beatModel: number; failed: number };
  /** Songs with their tempo, energy and texture measured; failed lately. */
  sound: { ready: number; failed: number };
  /** Songs with their loudness measured (for even volume); failed lately. */
  loudness: { ready: number; failed: number };
  /** Of the songs with a MusicBrainz id (the only ones ListenBrainz knows), those looked up. */
  tags: { ready: number; songs: number };
  /** Songs queued for beat or sound analysis, and being analysed now. */
  waiting: number;
  working: number;
  /** The same for loudness analysis (its own queue). */
  loudnessWaiting: number;
  loudnessWorking: number;
  /** Songs queued for a tag lookup. */
  tagsWaiting: number;
  /** The whole library is analysed in the background; otherwise songs as they come up to play. */
  libraryScan: boolean;
}

/** PUT /api/settings/mixes: the settings to change. */
export type MixSettingsPatch = Partial<MixSettings>;

/** PUT /api/settings/updates: the settings to change. */
export type UpdateSettingsPatch = Partial<UpdateSettings>;
```

Then check that the answer of `POST /api/accounts` has a name:

```bash
grep -n "account: Account; setup: SetupCode\|CreatedAccount" packages/shared/src/index.ts
```

If phase 1 didn't export a named type for it, add it after `SetupCode`:

```ts
/** POST /api/accounts: the new account and its one-time setup code. */
export interface CreatedAccount {
  account: Account;
  setup: SetupCode;
}
```

If phase 1 named it differently, use that name for `CreatedAccount` everywhere in this plan.

**Step 2: Add the types to `packages/mix/src/types.ts`**

Append at the end of the file:

```ts
/** POST /api/mix-maps: a song's mix map with the cue points set by hand, if any. */
export interface MixMapEntry extends MixMap {
  cues?: CuePoints;
}

/**
 * How far a transition being made has got: waiting its turn (behind `ahead` others), decoding the two
 * songs around the mix, mixing them, saving the file, then (for an MP3 next song) saving the rest of it.
 * `done` is the whole job's share done, 0–1, the steps weighted by about how long each takes.
 */
export interface RenderProgress {
  step: 'waiting' | 'decoding' | 'mixing' | 'saving' | 'saving the rest of the next song';
  done: number;
  ahead?: number;
}

/**
 * POST /api/transitions: the file to play (ready), still rendering (pending, ask again), better played
 * straight on, or not possible (no mix map yet, say).
 */
export type TransitionAnswer =
  | {
      status: 'ready';
      plan: TransitionPlan;
      url: string;
      continuationUrl?: string;
      /** Seconds of B after the transition in its file (see TRANSITION_TAIL_SECONDS); none in older files. */
      tail?: number;
      /** Seconds of A before the transition in its file: the file starts at plan.aStart − lead. None in older files. */
      lead?: number;
      /** The songs' gains (dB) made into the audio (and B's remainder), when they were asked for. */
      levels?: { a: number; b: number };
    }
  | { status: 'pending'; plan: TransitionPlan; render?: RenderProgress }
  | { status: 'straight'; plan: TransitionPlan }
  | { status: 'unavailable'; reason: string };
```

**Step 3: The server uses the shared `TransitionAnswer`**

In `apps/server/src/transitions/transitions.ts`, add two names to the existing `@playarr/mix` import so it reads:

```ts
import {
  excerptRanges,
  planTransition,
  PLANNER_VERSION,
  RENDER_RATE,
  type CuePoints,
  type Excerpt,
  type MixMap,
  type MixMode,
  type RenderProgress,
  type StereoAudio,
  type TransitionAnswer,
  type TransitionPlan,
} from '@playarr/mix';
```

Delete the file's own `export type TransitionAnswer = …` and `export interface RenderProgress { … }` declarations: everything from the line `export type TransitionAnswer =` down to just before the comment `/** Each step's share of a render, …`. Put this in their place, so `import { type TransitionAnswer } from './transitions.ts'` elsewhere keeps working:

```ts
// The player's answer types live in @playarr/mix, where the iOS models are generated from.
export type { RenderProgress, TransitionAnswer } from '@playarr/mix';
```

**Step 4: The web re-exports the moved types**

In `apps/web/src/lib/api.ts`:

1. Replace the first line `import type { CuePoints, MixMap, MixMode, TransitionPlan } from '@playarr/mix';` with:
   ```ts
   import type { CuePoints, MixMapEntry, MixMode, TransitionAnswer } from '@playarr/mix';
   ```
2. In the `@playarr/shared` import list, add `AnalysisKind,` and `AnalysisProgress,` after `AlbumSort,`. Replace `MixSettings,` with `MixSettingsPatch,` (after `MixSettingsInfo,`) and `UpdateSettings,` with `UpdateSettingsPatch,`.
3. Delete the local `TransitionAnswer`, `AnalysisKind` and `AnalysisProgress` declarations with their doc comments: from `/**\n * The server's answer for one song into the next` down to just before `export class ApiError`. Put this in their place:
   ```ts
   // Answer types the iOS app shares, generated from these packages: re-exported for the web's imports.
   export type { TransitionAnswer } from '@playarr/mix';
   export type { AnalysisKind, AnalysisProgress } from '@playarr/shared';
   ```
4. `saveUpdates: (patch: Partial<UpdateSettings>) =>` becomes `saveUpdates: (patch: UpdateSettingsPatch) =>`.
5. `request<Record<string, MixMap & { cues?: CuePoints }>>('/api/mix-maps'` becomes `request<Record<string, MixMapEntry>>('/api/mix-maps'`.
6. `saveMixSettings: (patch: Partial<MixSettings>) =>` becomes `saveMixSettings: (patch: MixSettingsPatch) =>`.

**Step 5: Typecheck and run the affected tests**

```bash
corepack pnpm -C apps/server typecheck
corepack pnpm -C apps/web typecheck
corepack pnpm -C apps/server exec vitest run src/transitions src/routes
corepack pnpm -C apps/web exec vitest run src/player/transitions.test.ts src/player/offline.test.ts src/components/AnalysisPanel.test.tsx
```

Expected: no type errors except the existing three `onnxruntime-web` ones on the server. Every test passes (the web run also prints the existing 22 "animation was canceled" errors from `AnalysisPanel.test.tsx`).

**Step 6: Commit**

```bash
git add packages/shared/src/index.ts packages/mix/src/types.ts apps/server/src/transitions/transitions.ts apps/web/src/lib/api.ts
git commit -F - <<'MSG'
Move the answers the iOS app reads into the shared packages: transition answers, analysis progress, mix-map entries and settings patches

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---
### Task 2: Generate the Swift models (`pnpm ios:models`)

**Files:**
- Modify: `package.json` (root: devDependency and script), `pnpm-lock.yaml`
- Modify: `apps/ios/Makefile` (targets `models`, `models-check`)
- Create: `apps/ios/scripts/gen-models.mjs`
- Create: `apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/GeneratedModelsTests.swift`
- Create (generated): `apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/Models.generated.swift`

**Step 1: The package as phase 0 left it**

Phase 0's `PlayarrAPI` has no placeholder to remove: its one source, `AppVersion.swift` (with `AppVersionTests.swift`), is real and stays (Task 12 adds comparison to it). Its `Package.swift` already declares the library and test target with no dependencies (iOS 26 and macOS 26), so it stays as it is:

```bash
ls apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests
```

Expected: `AppVersion.swift` and `AppVersionTests.swift`.

**Step 2: Write the failing test**

These are the tricky shapes; each test pins one rule from "Key decisions".

`apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/GeneratedModelsTests.swift`:

```swift
import Foundation
import Testing
@testable import PlayarrAPI

/// The generator's choices for the tricky TypeScript shapes.
@Suite struct GeneratedModelsTests {
    private func decode<T: Decodable>(_ type: T.Type, _ text: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(text.utf8))
    }

    private func object<T: Encodable>(_ value: T) throws -> [String: Any] {
        try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any])
    }

    @Test func readsAnUnknownEnumValueWithoutFailing() throws {
        let availability = try decode(Availability.self, #"{"state":"teleporting"}"#)
        #expect(availability.state == .unknown("teleporting"))
        #expect(try decode(Availability.self, #"{"state":"none"}"#).state == .noneValue)
        #expect(AvailabilityState.noneValue.rawValue == "none")
    }

    @Test func readsEachTransitionAnswer() throws {
        let plan = #""plan":{"style":"long","aStart":200,"bStart":0,"length":16,"bResume":16,"switchAt":8,"bRate":[],"aGain":[{"at":0,"value":1}],"bGain":[],"aLowDb":[],"bLowDb":[],"aHighPassHz":[],"reason":"phrase","beats":32}"#
        let ready = try decode(TransitionAnswer.self, #"{"status":"ready",\#(plan),"url":"/transitions/abc.flac","lead":4,"levels":{"a":-3,"b":1.5}}"#)
        guard case .ready(let answer) = ready else { Issue.record("not ready: \(ready)"); return }
        #expect(answer.url == "/transitions/abc.flac")
        #expect(answer.levels == .init(a: -3, b: 1.5))
        #expect(answer.plan.aGain == [AutomationItem(at: 0, value: 1)])

        let pending = try decode(TransitionAnswer.self, #"{"status":"pending",\#(plan),"render":{"step":"render","done":0.5}}"#)
        guard case .pending(let waiting) = pending else { Issue.record("not pending"); return }
        #expect(waiting.render?.done == 0.5)

        #expect(try decode(TransitionAnswer.self, #"{"status":"unavailable","reason":"No mix map yet"}"#) == .unavailable(.init(reason: "No mix map yet")))
        #expect(try decode(TransitionAnswer.self, #"{"status":"exploded"}"#) == .unknown("exploded"))
    }

    @Test func writesTheTagBack() throws {
        let sent = try object(TransitionAnswer.unavailable(.init(reason: "off")))
        #expect(sent["status"] as? String == "unavailable")
        #expect(sent["reason"] as? String == "off")
    }

    @Test func readsIdsAndCountsAsIntegers() throws {
        let track = try decode(Track.self, #"{"id":7,"recordingId":"rec-1","fileId":9000,"albumId":70,"artistId":7,"title":"Angel","artistName":"Massive Attack","albumTitle":"Mezzanine","trackNumber":1,"discNumber":1,"duration":379.4,"explicit":false,"format":{"codec":"FLAC","container":"flac","bits":16,"sampleRate":44100,"lossless":true},"size":40000000,"streamUrl":"/stream/9000"}"#)
        #expect(track.fileId == 9000)
        #expect(track.duration == 379.4)
        #expect(track.format.sampleRate == 44100)
    }

    @Test func keepsNullsInArrays() throws {
        let map = try decode(MixMap.self, #"{"version":8,"duration":200,"bpm":120,"firstBeat":0.1,"downbeatOffset":0,"gridStable":true,"beatConfidence":0.9,"introEnd":16,"outroStart":180,"coldStart":false,"coldEnd":false,"soundEnd":199,"phraseEnergy":[0.5,null,1]}"#)
        #expect(map.phraseEnergy == [0.5, nil, 1])
        #expect(map.version == mixMapVersion)
    }

    @Test func sendsNullOnlyWhenAPatchSaysSo() throws {
        let cleared = try object(RequestSettingsPatch(rootFolderPath: .some(nil)))
        #expect(cleared.keys.sorted() == ["rootFolderPath"])
        #expect(cleared["rootFolderPath"] is NSNull)
        #expect(try object(RequestSettingsPatch(enabled: true)).keys.sorted() == ["enabled"])
    }

    @Test func sendsARequiredNullAsNull() throws {
        let account = Account(id: 1, username: "owner", name: "Home", role: .admin, canRequest: true, sources: nil, hasPassword: true)
        #expect(try object(account)["sources"] is NSNull)
        #expect(try decode(Account.self, #"{"id":1,"username":"owner","name":"Home","role":"admin","canRequest":true,"sources":null,"hasPassword":true}"#) == account)
    }

    @Test func readsADictionary() throws {
        let levels = try decode([String: TrackLevel].self, #"{"rec-1":{"track":-6,"album":-4.2,"lufs":-8,"peak":-0.5}}"#)
        #expect(levels["rec-1"]?.album == -4.2)
    }

    @Test func readsTheOtherUnion() throws {
        #expect(try decode(RematchResult.self, #"{"kind":"folder","state":"review","trackId":12}"#) == .folder(.init(state: .review, trackId: 12)))
        #expect(try decode(RematchResult.self, #"{"kind":"lidarr","message":"Refreshing"}"#) == .lidarr(.init(message: "Refreshing")))
    }

    @Test func readsAYearAsAStatsRange() throws {
        let range: StatsRange = "2026"
        #expect(range == "2026")
    }
}
```

**Step 3: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrAPI --filter GeneratedModelsTests
```

Expected: build fails with `cannot find 'Availability' in scope` (and the other model types).

**Step 4: Install the schema generator**

```bash
corepack pnpm add -D -w --save-exact ts-json-schema-generator@2.9.0
```

Expected: the root `package.json` gains `"ts-json-schema-generator": "2.9.0"` under `devDependencies`, and `pnpm-lock.yaml` changes.

**Step 5: Write the generator**

`apps/ios/scripts/gen-models.mjs`:

```js
#!/usr/bin/env node
// TypeScript API types → Swift Codable models (`pnpm ios:models`).
//
// ts-json-schema-generator reads the shared TypeScript types into JSON Schema; the emitter below turns
// that schema into Swift. The output is committed; `--check` fails when it is out of date (CI).
//
// Rules (docs/plans/2026-11-03-ios-phase2-api-sign-in.md, Task 2):
// - interface / object type → struct (Codable, Hashable, Sendable; Identifiable when it has `id`).
// - optional property → `T?`; `T | null` → `T?`; optional and nullable → `T??` (nil leaves it out,
//   .some(nil) sends null, as patch bodies need).
// - string literal union → enum with `case unknown(String)`, so a value added on the server decodes.
// - numeric literal union → Int.
// - number → Double, except ids, counts and the INTEGERS below → Int (SQLite integers on the server).
// - Record<string, T> → [String: T]; arrays → [T]; tuples → [T].
// - union of objects tagged by one string property (TransitionAnswer.status) → enum with associated
//   values and `case unknown(String)`.
// - inline object types → nested structs named after the property (+ "Item" inside arrays).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGenerator } from 'ts-json-schema-generator';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const INPUTS = ['packages/shared/src/index.ts', 'packages/mix/src/types.ts'];
const OUTPUT = resolve(here, '../Packages/PlayarrAPI/Sources/PlayarrAPI/Models.generated.swift');
/** Exported, but not part of the API. */
const SKIP = new Set(['parseRange', 'ByteRange']);
/** Numbers that are whole: what the server stores as SQLite integers or counts. */
const INTEGERS = new Set([
  'albums', 'analyzed', 'artists', 'audioFiles', 'background', 'batchId', 'beatModel', 'bits', 'channels',
  'days', 'decadeMixes', 'disc', 'discNumber', 'earlier', 'era', 'failed', 'files', 'freeSpace', 'genreMixes',
  'have', 'hour', 'lastCheck', 'lastUpdate', 'longestStreak', 'loudnessWaiting', 'loudnessWorking', 'matches',
  'matching', 'moved', 'newArtists', 'pending', 'plays', 'port', 'position', 'profile', 'queued', 'ready',
  'recorded', 'restored', 'review', 'sampleRate', 'sent', 'size', 'sizeBytes', 'songs', 'sources',
  'tagsWaiting', 'total', 'trackNumber', 'trackTotal', 'tracks', 'variant', 'version', 'waiting', 'weekday',
  'working', 'year', 'years',
]);
const isIntegerName = (name) => name === 'id' || /(Id|Ids|Count)$/.test(name) || INTEGERS.has(name);
const KEYWORDS = new Set([
  'associatedtype', 'class', 'deinit', 'enum', 'extension', 'func', 'import', 'init', 'inout', 'internal', 'let',
  'operator', 'private', 'protocol', 'public', 'static', 'struct', 'subscript', 'typealias', 'var', 'break',
  'case', 'continue', 'default', 'defer', 'do', 'else', 'fallthrough', 'for', 'guard', 'if', 'in', 'repeat',
  'return', 'switch', 'where', 'while', 'as', 'catch', 'false', 'is', 'nil', 'rethrows', 'super', 'self',
  'Self', 'throw', 'throws', 'true', 'try', 'Type', 'Protocol', 'any', 'some',
]);

function loadDefinitions() {
  const definitions = {};
  for (const input of INPUTS) {
    const schema = createGenerator({
      path: resolve(root, input),
      type: '*',
      expose: 'export',
      topRef: true,
      jsDoc: 'extended',
      skipTypeCheck: true,
      additionalProperties: false,
    }).createSchema('*');
    for (const [name, def] of Object.entries(schema.definitions ?? {})) {
      if (SKIP.has(name)) continue;
      if (definitions[name]) throw new Error(`${name} is exported by two inputs`);
      definitions[name] = def;
    }
  }
  return definitions;
}

const pascal = (s) => s.replace(/(^|[^A-Za-z0-9]+)([A-Za-z0-9])/g, (_, __, c) => c.toUpperCase());
const camel = (s) => {
  const p = pascal(s);
  return p.charAt(0).toLowerCase() + p.slice(1);
};
const ident = (name) => (KEYWORDS.has(name) ? `\`${name}\`` : name);
const caseName = (value) => {
  if (value === 'none') return 'noneValue'; // `.none` would be read as Optional.none
  if (value === 'unknown') throw new Error('"unknown" is the fallback case name');
  return ident(camel(value));
};
const refName = (schema) => schema.$ref?.replace('#/definitions/', '');
const trimEnd = (lines) => {
  while (lines.at(-1) === '') lines.pop();
  return lines;
};
const nonNull = (types) => (Array.isArray(types) ? types.filter((t) => t !== 'null') : [types]);

/** Strips `null` from a schema: { schema, nullable }. */
function splitNull(schema) {
  if (Array.isArray(schema.type) && schema.type.includes('null')) {
    const rest = nonNull(schema.type);
    return { schema: { ...schema, type: rest.length === 1 ? rest[0] : rest }, nullable: true };
  }
  const options = schema.anyOf;
  if (options?.some((o) => o.type === 'null')) {
    const rest = options.filter((o) => o.type !== 'null');
    return { schema: rest.length === 1 ? { ...rest[0], description: schema.description } : { ...schema, anyOf: rest }, nullable: true };
  }
  return { schema, nullable: false };
}

const isStringEnum = (s) => s.type === 'string' && Array.isArray(s.enum);
const isNumberEnum = (s) => s.type === 'number' && Array.isArray(s.enum);
const isObject = (s) => s.type === 'object' && s.properties;
const isRecord = (s) => s.type === 'object' && !s.properties && typeof s.additionalProperties === 'object';
const tagOf = (s) => {
  const options = s.anyOf;
  if (!options?.length || !options.every(isObject)) return undefined;
  const tag = Object.keys(options[0].properties).find((key) => options.every((o) => typeof o.properties[key]?.const === 'string'));
  return tag;
};

function docLines(description, indent) {
  if (!description) return [];
  return description.split('\n').map((line) => `${indent}/// ${line}`.trimEnd());
}

/** Swift source for every definition. */
function emitSwift(definitions) {
  const out = [];
  const names = Object.keys(definitions).sort();

  /** A nested type's name, which mustn't hide a top-level type inside its parent. */
  const nestedName = (name) => {
    const typeName = pascal(name);
    if (definitions[typeName]) throw new Error(`The nested type ${typeName} would hide the top-level ${typeName}: rename the property`);
    return typeName;
  };

  /** Swift type for `schema`; nested declarations it needs go into `nested`. */
  function typeOf(schema, name, propName, nested, indent) {
    const ref = refName(schema);
    if (ref) return ref;
    if (schema.anyOf && tagOf(schema)) {
      const typeName = nestedName(name);
      nested.push(...emitTaggedUnion(typeName, schema, indent));
      return typeName;
    }
    if (schema.anyOf) throw new Error(`${propName}: unions other than tagged objects and null aren't supported`);
    if (isStringEnum(schema)) {
      const typeName = nestedName(name);
      nested.push(...emitEnum(typeName, schema, indent));
      return typeName;
    }
    if (isNumberEnum(schema)) return 'Int';
    if (schema.const === true || schema.const === false) return 'Bool';
    switch (Array.isArray(schema.type) ? 'mixed' : schema.type) {
      case 'string':
        return 'String';
      case 'boolean':
        return 'Bool';
      case 'number':
      case 'integer':
        return isIntegerName(propName) ? 'Int' : 'Double';
      case 'array': {
        const items = Array.isArray(schema.items) ? schema.items[0] : schema.items;
        const { schema: item, nullable } = splitNull(items);
        const element = typeOf(item, `${name}Item`, propName, nested, indent);
        return `[${element}${nullable ? '?' : ''}]`;
      }
      case 'object': {
        if (isRecord(schema)) return `[String: ${typeOf(schema.additionalProperties, `${name}Value`, propName, nested, indent)}]`;
        const typeName = nestedName(name);
        nested.push(...emitStruct(typeName, schema, indent));
        return typeName;
      }
      default:
        throw new Error(`${propName}: can't map ${JSON.stringify(schema)}`);
    }
  }

  function emitStruct(typeName, schema, indent, skip) {
    const inner = `${indent}    `;
    const nested = [];
    const fields = [];
    const required = new Set(schema.required ?? []);
    for (const [prop, raw] of Object.entries(schema.properties ?? {})) {
      if (prop === skip) continue;
      const { schema: s, nullable } = splitNull(raw);
      const base = typeOf({ ...s, description: undefined }, prop, prop, nested, inner);
      const optional = !required.has(prop);
      const type = optional && nullable ? `${base}??` : optional || nullable ? `${base}?` : base;
      fields.push({ prop, type, description: raw.description, explicitNull: nullable && !optional, defaulted: optional });
    }
    const conformances = ['Codable', 'Hashable', 'Sendable'];
    if (fields.some((f) => f.prop === 'id' && !f.type.endsWith('?'))) conformances.push('Identifiable');
    const lines = [...docLines(schema.description, indent), `${indent}public struct ${typeName}: ${conformances.join(', ')} {`];
    for (const f of fields) lines.push(...docLines(f.description, inner), `${inner}public var ${ident(f.prop)}: ${f.type}`);
    if (fields.length) lines.push('');
    const params = fields.map((f) => `${ident(f.prop)}: ${f.type}${f.defaulted ? ' = nil' : ''}`).join(', ');
    lines.push(`${inner}public init(${params}) {`);
    for (const f of fields) lines.push(`${inner}    self.${ident(f.prop)} = ${ident(f.prop)}`);
    lines.push(`${inner}}`);
    if (fields.some((f) => f.explicitNull)) {
      // Required but nullable (Account.sources): null is a value the server reads, so it's sent.
      lines.push('', `${inner}public func encode(to encoder: any Encoder) throws {`, `${inner}    var container = encoder.container(keyedBy: CodingKeys.self)`);
      for (const f of fields) {
        const method = f.explicitNull || !f.type.endsWith('?') ? 'encode' : 'encodeIfPresent';
        lines.push(`${inner}    try container.${method}(${ident(f.prop)}, forKey: .${ident(f.prop)})`);
      }
      lines.push(`${inner}}`);
    }
    if (nested.length) lines.push('', ...trimEnd(nested));
    lines.push(`${indent}}`, '');
    return lines;
  }

  function emitEnum(typeName, schema, indent) {
    const inner = `${indent}    `;
    const cases = schema.enum.map((value) => ({ value, name: caseName(value) }));
    return [
      ...docLines(schema.description, indent),
      `${indent}public enum ${typeName}: RawRepresentable, Codable, Hashable, Sendable, CaseIterable {`,
      ...cases.map((c) => `${inner}case ${c.name}`),
      `${inner}/// A value this version of the app doesn't know yet.`,
      `${inner}case unknown(String)`,
      '',
      `${inner}public static let allCases: [${typeName}] = [${cases.map((c) => `.${c.name}`).join(', ')}]`,
      '',
      `${inner}public init(rawValue: String) {`,
      `${inner}    switch rawValue {`,
      ...cases.map((c) => `${inner}    case ${JSON.stringify(c.value)}: self = .${c.name}`),
      `${inner}    default: self = .unknown(rawValue)`,
      `${inner}    }`,
      `${inner}}`,
      '',
      `${inner}public var rawValue: String {`,
      `${inner}    switch self {`,
      ...cases.map((c) => `${inner}    case .${c.name}: ${JSON.stringify(c.value)}`),
      `${inner}    case .unknown(let value): value`,
      `${inner}    }`,
      `${inner}}`,
      '',
      `${inner}public init(from decoder: any Decoder) throws {`,
      `${inner}    self.init(rawValue: try decoder.singleValueContainer().decode(String.self))`,
      `${inner}}`,
      '',
      `${inner}public func encode(to encoder: any Encoder) throws {`,
      `${inner}    var container = encoder.singleValueContainer()`,
      `${inner}    try container.encode(rawValue)`,
      `${inner}}`,
      `${indent}}`,
      '',
    ];
  }

  function emitTaggedUnion(typeName, schema, indent) {
    const inner = `${indent}    `;
    const tag = tagOf(schema);
    const variants = schema.anyOf.map((o) => ({ value: o.properties[tag].const, schema: o }));
    variants.forEach((v) => (v.name = caseName(v.value)));
    variants.forEach((v) => (v.type = pascal(v.value)));
    const lines = [
      ...docLines(schema.description, indent),
      `${indent}public enum ${typeName}: Codable, Hashable, Sendable {`,
      ...variants.map((v) => `${inner}case ${v.name}(${v.type})`),
      `${inner}/// A \`${tag}\` this version of the app doesn't know yet.`,
      `${inner}case unknown(String)`,
      '',
      `${inner}private enum TagKey: String, CodingKey { case ${ident(tag)} = ${JSON.stringify(tag)} }`,
      '',
      `${inner}public var ${ident(tag)}: String {`,
      `${inner}    switch self {`,
      ...variants.map((v) => `${inner}    case .${v.name}: ${JSON.stringify(v.value)}`),
      `${inner}    case .unknown(let value): value`,
      `${inner}    }`,
      `${inner}}`,
      '',
      `${inner}public init(from decoder: any Decoder) throws {`,
      `${inner}    let tag = try decoder.container(keyedBy: TagKey.self).decode(String.self, forKey: .${ident(tag)})`,
      `${inner}    switch tag {`,
      ...variants.map((v) => `${inner}    case ${JSON.stringify(v.value)}: self = .${v.name}(try ${v.type}(from: decoder))`),
      `${inner}    default: self = .unknown(tag)`,
      `${inner}    }`,
      `${inner}}`,
      '',
      `${inner}public func encode(to encoder: any Encoder) throws {`,
      `${inner}    switch self {`,
      ...variants.map((v) => `${inner}    case .${v.name}(let value): try value.encode(to: encoder)`),
      `${inner}    case .unknown: break`,
      `${inner}    }`,
      `${inner}    var container = encoder.container(keyedBy: TagKey.self)`,
      `${inner}    try container.encode(${ident(tag)}, forKey: .${ident(tag)})`,
      `${inner}}`,
      '',
    ];
    for (const v of variants) lines.push(...emitStruct(v.type, v.schema, inner, tag));
    trimEnd(lines);
    lines.push(`${indent}}`, '');
    return lines;
  }

  for (const name of names) {
    const def = definitions[name];
    if (def.anyOf && tagOf(def)) out.push(...emitTaggedUnion(name, def, ''));
    else if (isStringEnum(def)) out.push(...emitEnum(name, def, ''));
    else if (isObject(def) || (def.type === 'object' && !isRecord(def))) out.push(...emitStruct(name, def, ''));
    else {
      const nested = [];
      const type = typeOf(def, name, name, nested, '');
      out.push(...docLines(def.description, ''), `public typealias ${name} = ${type}`, '', ...nested);
    }
  }
  return out;
}

/** The MIX_MAP_VERSION constant, which JSON Schema doesn't carry. */
function mixMapVersion() {
  const match = /export const MIX_MAP_VERSION = (\d+);/.exec(readFileSync(resolve(root, 'packages/mix/src/types.ts'), 'utf8'));
  if (!match) throw new Error('MIX_MAP_VERSION not found in packages/mix/src/types.ts');
  return Number(match[1]);
}

function render() {
  return [
    '// Generated by apps/ios/scripts/gen-models.mjs from packages/shared and packages/mix. Do not edit:',
    '// change the TypeScript types and run `pnpm ios:models`.',
    '',
    '/// Mix maps stored with an older version are measured again (packages/mix MIX_MAP_VERSION).',
    `public let mixMapVersion = ${mixMapVersion()}`,
    '',
    ...emitSwift(loadDefinitions()),
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n*$/, '\n');
}

const swift = render();
if (process.argv.includes('--check')) {
  const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : '';
  if (current !== swift) {
    console.error('Models.generated.swift is out of date: run `pnpm ios:models` and commit it.');
    process.exit(1);
  }
  console.log('Models.generated.swift is up to date.');
} else {
  writeFileSync(OUTPUT, swift);
  console.log(`Wrote ${OUTPUT}`);
}
```

**Step 6: Make and pnpm entry points**

Add `models models-check` to the Makefile's `.PHONY` line and a line for `make models` to its header comment, then add these targets before `setup:` (recipe lines start with a tab):

```make
# Swift models from the shared TypeScript types (committed).
models:
	node scripts/gen-models.mjs

# Fails when Models.generated.swift is out of date.
models-check:
	node scripts/gen-models.mjs --check
```

In the root `package.json` `scripts`, add this entry after `ios:test` (phase 0 didn't add it):

```json
"ios:models": "make -C apps/ios models"
```

**Step 7: Generate and run the test**

```bash
corepack pnpm ios:models
corepack pnpm ios:models   # twice: the second run must not change the file
git diff --stat apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/Models.generated.swift
make -C apps/ios models-check
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrAPI --filter GeneratedModelsTests
```

Expected: `Wrote …/Models.generated.swift` (about 3,250 lines with the phase 1 account types). `Models.generated.swift is up to date.` All `GeneratedModelsTests` pass.

Check the output for one of each kind: `grep -n "public enum TransitionAnswer\|case noneValue\|public var sources: \[Int\]?\|rootFolderPath: String??\|public typealias StatsRange = String\|public let mixMapVersion" apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/Models.generated.swift`. Expected: at least one line for each (`noneValue` is in two enums, and `rootFolderPath` shows in its property and its `init`).

**Step 8: Commit**

```bash
git add package.json pnpm-lock.yaml apps/ios/Makefile apps/ios/scripts/gen-models.mjs apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/Models.generated.swift apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/GeneratedModelsTests.swift docs/plans/2026-11-03-ios-phase2-api-sign-in.md
git commit -F - <<'MSG'
Generate the iOS app's Swift models from the shared TypeScript types (pnpm ios:models)

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---
### Task 3: A helper that saves route answers as fixtures

**Files:**
- Create: `apps/server/src/testing/recordFixture.ts`
- Test: `apps/server/src/testing/recordFixture.test.ts`

**Step 1: Write the failing test**

`apps/server/src/testing/recordFixture.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../catalog/testFixtures.ts';
import { FIXTURES_DIR, writeFixture } from './recordFixture.ts';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

const answer = (body: unknown, statusCode = 200) => ({ statusCode, json: () => body });

describe('writeFixture', () => {
  it('saves the answer as pretty JSON, timestamps pinned', () => {
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    writeFixture(dir, 'favorites', answer([{ id: 1, favoritedAt: '2026-10-01T09:30:12.345Z', title: '2026-10-01 is a date, not a timestamp' }]));
    expect(readFileSync(join(dir, 'favorites.json'), 'utf8')).toBe(
      '[\n  {\n    "id": 1,\n    "favoritedAt": "2026-11-03T12:00:00.000Z",\n    "title": "2026-10-01 is a date, not a timestamp"\n  }\n]\n',
    );
  });

  it('tidies what changes on every run', () => {
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    writeFixture(dir, 'auth-sign-in', answer({ token: 'r4nd0m' }), (body) => ({ ...body, token: 'token' }));
    expect(JSON.parse(readFileSync(join(dir, 'auth-sign-in.json'), 'utf8'))).toEqual({ token: 'token' });
  });

  it('refuses an error answer', () => {
    expect(() => writeFixture('/nonexistent', 'album', answer({ error: 'Album not found' }, 404))).toThrow('the route answered 404');
  });

  it('writes into the iOS package', () => {
    expect(FIXTURES_DIR).toMatch(/apps\/ios\/Packages\/PlayarrAPI\/Tests\/PlayarrAPITests\/Fixtures\/$/);
  });
});
```

**Step 2: Run it to see it fail**

```bash
corepack pnpm -C apps/server exec vitest run src/testing/recordFixture.test.ts
```

Expected: FAIL, because `./recordFixture.ts` doesn't exist yet (vitest says it can't load the module).

**Step 3: Write the helper**

`apps/server/src/testing/recordFixture.ts`:

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where the iOS contract tests read real server answers from. */
export const FIXTURES_DIR = fileURLToPath(new URL('../../../ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/Fixtures/', import.meta.url));

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** Timestamps pinned, so recording again changes a fixture only when its shape changes. */
function pinTimestamps(value: unknown): unknown {
  if (typeof value === 'string') return TIMESTAMP.test(value) ? '2026-11-03T12:00:00.000Z' : value;
  if (Array.isArray(value)) return value.map(pinTimestamps);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, pinTimestamps(v)]));
  return value;
}

type Answer = { statusCode: number; json: () => unknown };

/** Saves a route's JSON answer as <dir>/<name>.json, after `tidy` and with timestamps pinned. */
export function writeFixture(dir: string, name: string, res: Answer, tidy: (body: any) => unknown = (body) => body): void {
  if (res.statusCode < 200 || res.statusCode > 299) throw new Error(`Fixture ${name}: the route answered ${res.statusCode}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(pinTimestamps(tidy(res.json())), null, 2)}\n`);
}

/**
 * With RECORD_FIXTURES=1, saves a route's answer for the iOS contract tests; otherwise does nothing.
 * `tidy` replaces what changes on every run (tokens, random ids, random order).
 */
export function recordFixture(name: string, res: Answer, tidy?: (body: any) => unknown): void {
  if (process.env.RECORD_FIXTURES === '1') writeFixture(FIXTURES_DIR, name, res, tidy);
}
```

**Step 4: Run it to see it pass**

```bash
corepack pnpm -C apps/server exec vitest run src/testing/recordFixture.test.ts
```

Expected: 4 tests pass.

**Step 5: Commit**

```bash
git add apps/server/src/testing/recordFixture.ts apps/server/src/testing/recordFixture.test.ts
git commit -F - <<'MSG'
Save route answers as fixtures for the iOS contract tests when RECORD_FIXTURES=1

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 4: Record an answer of every endpoint family

The fixture names here are the ones `ContractTests.swift` (Task 8) lists. Adding a fixture there means adding it here, and the other way round.

**Files:**
- Create: `apps/server/src/routes/contract.test.ts`
- Modify: `apps/server/src/routes/settings.test.ts`, `apps/server/src/routes/status.test.ts`, `apps/server/src/routes/levels.test.ts`
- Create (recorded): `apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/Fixtures/*.json` (45 files)

**Step 1: Write the contract test**

`apps/server/src/routes/contract.test.ts`:

```ts
// Records real answers of every endpoint family the iOS app calls, for its contract tests
// (apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/ContractTests.swift). Run with RECORD_FIXTURES=1
// to write them; without it these are ordinary route tests. The library, favorites, playlists, plays and
// stats run on the real services over a small catalog; MusicBrainz, Lidarr, lyrics, mixes, ListenBrainz,
// analysis and rendering are fakes returning complete values typed by the shared types (no casts on
// the values), so a fixture still checks the TypeScript type against the Swift one.
import { MIX_MAP_VERSION, type MixMap, type TransitionAnswer, type TransitionPlan } from '@playarr/mix';
import type {
  AlbumRequest,
  Availability,
  DiscoverAlbum,
  DiscoverArtist,
  DiscoverArtistDetail,
  DiscoverResults,
  ListenBrainzInfo,
  Lyrics,
  MixDetail,
  MixSummary,
  PlayReport,
  Recommendations,
  Track,
} from '@playarr/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Analyzer } from '../analysis/analyzer.ts';
import { CatalogStore } from '../catalog/store.ts';
import { freshDb, mezzanine, tempDir } from '../catalog/testFixtures.ts';
import type { Config } from '../config.ts';
import { PlaylistCovers } from '../cover/index.ts';
import type { Discover } from '../discover/discover.ts';
import type { Recommendations as RecommendationService } from '../discover/recommendations.ts';
import type { Requests } from '../discover/requests.ts';
import { Favorites } from '../favorites.ts';
import { LidarrClient } from '../lidarr/client.ts';
import { Library } from '../library/library.ts';
import type { MediaSource } from '../media/index.ts';
import { History } from '../mixes/history.ts';
import type { Mixes } from '../mixes/mixes.ts';
import { Playlists } from '../playlists.ts';
import { recordFixture } from '../testing/recordFixture.ts';
import { apiRoutes } from './api.ts';
import { discoverRoutes } from './discover.ts';
import { favoriteRoutes } from './favorites.ts';
import { lyricsRoutes } from './lyrics.ts';
import { metadataRoutes } from './metadata.ts';
import { mixMapRoutes } from './mixMaps.ts';
import { mixRoutes } from './mixes.ts';
import { playlistRoutes } from './playlists.ts';
import { transitionRoutes } from './transitions.ts';

const ANGEL = '0b6a2c1e-1111-4222-8333-944455556666';
const RISINGSON = '0b6a2c1e-1111-4222-8333-944455557777';
const ARTIST_MBID = '10adbe5e-a2c0-4bf3-8249-2b4cbf6e6ca8';
const ALBUM_MBID = 'a9a3d3bd-0c1c-3a6c-8b3f-4b1e3b1f5b7e';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

/** The test catalog (Mezzanine, two songs) with MusicBrainz recording ids, as the routes require. */
async function catalog() {
  const db = freshDb();
  const store = new CatalogStore(db);
  const sourceId = store.addSource('lidarr', 'Lidarr');
  const sync = mezzanine();
  sync.tracks = sync.tracks.map((t) => ({ ...t, recordingId: t.recordingId === 'rec-1' ? ANGEL : RISINGSON }));
  const library = new Library(store, () => [{ id: sourceId, source: { kind: 'lidarr', sync: async () => sync } }], { info: () => {}, error: () => {} });
  await library.refresh();
  const tracks = (await library.allTracks()).sort((a, b) => a.id - b.id);
  return { db, store, library, tracks };
}

/** Each GET answers 2xx and is saved as the named fixture. */
async function recordGets(app: FastifyInstance, gets: [name: string, url: string][]) {
  for (const [name, url] of gets) {
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode, `${url}: ${res.body}`).toBeLessThan(300);
    recordFixture(name, res);
  }
}

const PLAN: TransitionPlan = {
  style: 'long',
  aStart: 312.4,
  bStart: 0.42,
  length: 24,
  bResume: 24.42,
  switchAt: 12,
  bRate: [{ at: 0, value: 1.02 }, { at: 24, value: 1 }],
  aGain: [{ at: 0, value: 1 }, { at: 16, value: 0 }],
  bGain: [{ at: 0, value: 0 }, { at: 8, value: 1 }],
  aLowDb: [{ at: 0, value: 0 }, { at: 12, value: -24 }],
  bLowDb: [{ at: 0, value: -24 }, { at: 12, value: 0 }],
  aHighPassHz: [{ at: 0, value: 20 }],
  reason: 'Both songs hold their beat over a 32-beat phrase',
  beats: 32,
};

const MAP: MixMap = {
  version: MIX_MAP_VERSION,
  duration: 379,
  bpm: 80,
  firstBeat: 0.42,
  downbeatOffset: 1,
  downbeatConfidence: 0.8,
  gridStable: true,
  beatConfidence: 0.9,
  key: { camelot: '8A', confidence: 0.7 },
  introEnd: 32.5,
  outroStart: 340,
  firstDrop: 64,
  coldStart: false,
  coldEnd: false,
  soundStart: 0.1,
  soundEnd: 378.2,
  beatsFrom: 'model',
  phraseEnergy: [0.4, 0.8, null, 1],
  phraseDrift: [3, null, 5],
  edgesStable: true,
};

describe('contract fixtures', () => {
  it('library, search, metadata and lyrics', async () => {
    const { store, library } = await catalog();
    const lyrics: Lyrics = { synced: [{ at: 12.5, text: 'Love, love is a verb' }], plain: 'Love, love is a verb', source: 'lrclib' };
    const app = Fastify();
    apiRoutes(app, {
      config: { pathMap: [] } as unknown as Config,
      lidarr: new LidarrClient(),
      library,
      media: { kind: 'local', check: async () => {} } as unknown as MediaSource,
      requestSettings: () => ({ enabled: false, searchOnAdd: true }),
    });
    metadataRoutes(app, { store, library, pathMap: [], features: () => new Map() });
    lyricsRoutes(app, { lyrics: { forTrack: async () => lyrics } });
    await recordGets(app, [
      ['health', '/api/health'],
      ['artists', '/api/artists'],
      ['artist', '/api/artists/7'],
      ['artist-tracks', '/api/artists/7/tracks'],
      ['albums', '/api/albums?sort=added'],
      ['albums-random', '/api/albums/random'],
      ['album', '/api/albums/70'],
      ['search', '/api/search?q=massive'],
      ['track-metadata', '/api/tracks/700/metadata'],
      ['lyrics', '/api/tracks/700/lyrics'],
    ]);
    const random = await app.inject({ method: 'GET', url: '/api/tracks/random' });
    expect(random.json()).toHaveLength(2);
    recordFixture('tracks-random', random, (tracks: Track[]) => tracks.sort((a, b) => a.id - b.id));
  });

  it('favorites and playlists', async () => {
    const { db, library } = await catalog();
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    const analyzer = { ensure() {}, features: () => new Map(), meta: () => new Map(), pending: () => 0 } as unknown as Analyzer;
    const covers = new PlaylistCovers(analyzer, library, dir);
    const recommendations: Recommendations = {
      owned: [{ recordingId: RISINGSON, title: 'Risingson', artistName: 'Massive Attack', albumTitle: 'Mezzanine', because: 'Angel', track: (await library.trackByRecording(RISINGSON))!, artistId: 7 }],
      missing: [
        {
          recordingId: 'b3c4d5e6-1111-4222-8333-944455558888',
          title: 'Teardrop',
          artistName: 'Massive Attack',
          albumTitle: 'Mezzanine (Deluxe)',
          because: 'Angel',
          album: { mbid: ALBUM_MBID, artistName: 'Massive Attack', albumTitle: 'Mezzanine (Deluxe)' },
          availability: { state: 'none' },
          artistMbid: ARTIST_MBID,
        },
      ],
      seedCount: 2,
    };
    const app = Fastify();
    favoriteRoutes(app, { favorites: new Favorites(db, library), library });
    playlistRoutes(app, {
      playlists: new Playlists(db, library, covers),
      recommendations: { forPlaylist: async () => recommendations } as unknown as RecommendationService,
      covers,
    });
    expect((await app.inject({ method: 'PUT', url: `/api/favorites/${ANGEL}` })).statusCode).toBe(204);
    const created = await app.inject({ method: 'POST', url: '/api/playlists', payload: { name: 'Late night', description: 'For the drive home', recordingIds: [ANGEL, RISINGSON] } });
    expect(created.statusCode).toBe(201);
    recordFixture('playlist', created);
    await recordGets(app, [
      ['favorites', '/api/favorites'],
      ['playlists', '/api/playlists'],
      ['recommendations', `/api/playlists/${created.json().id}/recommendations`],
    ]);
  });

  it('discover and requests', async () => {
    const availability: Availability = { state: 'partial', albumId: 70, have: 2, total: 11 };
    const album: DiscoverAlbum = {
      mbid: ALBUM_MBID,
      title: 'Mezzanine',
      artistName: 'Massive Attack',
      artistMbid: ARTIST_MBID,
      year: 1998,
      type: 'Album',
      secondaryTypes: [],
      coverUrl: `/art/remote?url=${encodeURIComponent('https://coverartarchive.org/release-group/x/front-250')}`,
      availability,
    };
    const artist: DiscoverArtist = { mbid: ARTIST_MBID, name: 'Massive Attack', disambiguation: 'Bristol group', genres: ['trip hop'], artistId: 7 };
    const results: DiscoverResults = {
      artists: [artist],
      albums: [album],
      tracks: [
        {
          id: 'b3c4d5e6-1111-4222-8333-944455558888',
          title: 'Teardrop',
          artistName: 'Massive Attack',
          albumTitle: 'Mezzanine',
          duration: 330,
          album: { mbid: ALBUM_MBID, artistName: 'Massive Attack', albumTitle: 'Mezzanine' },
          availability,
          artistId: 7,
        },
      ],
    };
    const detail: DiscoverArtistDetail = { ...artist, overview: 'Formed in Bristol in 1988.', albums: [album] };
    const request: AlbumRequest = {
      mbid: ALBUM_MBID,
      title: 'Mezzanine',
      artistName: 'Massive Attack',
      requestedAt: '2026-11-03T12:00:00.000Z',
      availability: { state: 'downloading', progress: 0.4, message: 'Downloading 4 of 11' },
    };
    const app = Fastify();
    discoverRoutes(app, {
      discover: { search: async () => results, artist: async () => detail, similarArtists: async () => [artist], findArtist: async () => ({ mbid: ARTIST_MBID, artistId: 7 }) } as unknown as Discover,
      requests: { list: async () => [request], request: async () => request, remove: async () => {} } as unknown as Requests,
    });
    await recordGets(app, [
      ['discover-search', '/api/discover/search?q=massive'],
      ['discover-artist', `/api/discover/artists/${ARTIST_MBID}`],
      ['discover-similar', `/api/discover/artists/${ARTIST_MBID}/similar`],
      ['artist-lookup', '/api/discover/artist-lookup?name=Massive%20Attack'],
      ['requests', '/api/requests'],
    ]);
    recordFixture('request-created', await app.inject({ method: 'POST', url: '/api/requests', payload: { mbid: ALBUM_MBID, artistName: 'Massive Attack', albumTitle: 'Mezzanine' } }));
  });

  it('plays, stats, mixes and ListenBrainz', async () => {
    const { db, store, library, tracks } = await catalog();
    const summary: MixSummary = {
      key: 'vibes',
      kind: 'vibes',
      title: 'Your vibes',
      subtitle: 'Massive Attack and more',
      description: 'Songs you play the most at this hour',
      trackCount: tracks.length,
      duration: tracks.reduce((sum, t) => sum + t.duration, 0),
      covers: ['/art/album/70/cover'],
      hue: 210,
      generatedAt: '2026-11-03T12:00:00.000Z',
      refreshesAt: '2026-11-03T13:00:00.000Z',
    };
    const detail: MixDetail = { ...summary, tracks };
    const listenBrainz: ListenBrainzInfo = { connected: true, user: 'listener', enabled: true, pending: 0, sent: 42, earlier: 3, lastSentAt: '2026-11-03T12:00:00.000Z' };
    const app = Fastify();
    mixRoutes(app, {
      mixes: { list: async () => [summary], get: async () => detail, regenerate: async () => detail, radio: async () => tracks, reset: async () => {} } as unknown as Mixes,
      history: new History(db, library),
      store,
      analysisAvailable: true,
      analyzeLibrary: vi.fn(),
      library,
      db,
      scrobbler: { info: () => listenBrainz, connect: async () => listenBrainz, disconnect: () => listenBrainz, setEnabled: () => listenBrainz, sendEarlier: () => listenBrainz, kick: async () => {} },
    });
    const plays: PlayReport[] = tracks.map((t, i) => ({ trackId: t.id, recordingId: t.recordingId, at: `2026-11-0${i + 1}T21:00:00.000Z`, hour: 21, weekday: i, seconds: t.duration, skipped: false }));
    const recorded = await app.inject({ method: 'POST', url: '/api/plays', payload: { plays } });
    expect(recorded.json()).toEqual({ recorded: 2 });
    recordFixture('plays', recorded);
    await recordGets(app, [
      ['recent-albums', '/api/plays/recent-albums'],
      ['stats', '/api/stats?range=all'],
      ['mixes', '/api/mixes?tz=Europe%2FLondon'],
      ['mix', '/api/mixes/vibes?tz=Europe%2FLondon'],
      ['mix-settings', '/api/settings/mixes'],
      ['listenbrainz', '/api/settings/listenbrainz'],
    ]);
    recordFixture('radio', await app.inject({ method: 'POST', url: '/api/radio', payload: { seeds: [ANGEL] } }));
  });

  it('mix maps, cue points and transitions', async () => {
    const { library } = await catalog();
    const analyzer = {
      canAnalyzeAudio: true,
      mixMaps: (ids: string[]) => new Map(ids.filter((id) => id === ANGEL).map((id) => [id, MAP] as const)),
      cues: (ids: string[]) => new Map(ids.filter((id) => id === ANGEL).map((id) => [id, { mixIn: 30, mixOut: 350 }] as const)),
      setCues: vi.fn(),
      ensure: vi.fn(),
      analysisProgress: () => ({
        songs: 2,
        beats: { ready: 1, beatModel: 1, failed: 0 },
        sound: { ready: 1, failed: 0 },
        loudness: { ready: 2, failed: 0 },
        tags: { ready: 2, songs: 2 },
        waiting: 1,
        working: 0,
        loudnessWaiting: 0,
        loudnessWorking: 0,
        tagsWaiting: 0,
      }),
      analyzeLibrary: async () => 0,
      reanalyzeLibrary: async () => 0,
    };
    const answers: Record<number, TransitionAnswer> = {
      1: { status: 'ready', plan: PLAN, url: `/transitions/${'a'.repeat(40)}.flac`, continuationUrl: `/transitions/${'a'.repeat(40)}.rest.flac`, tail: 8, lead: 4, levels: { a: -3.5, b: 1.2 } },
      2: { status: 'pending', plan: PLAN, render: { step: 'mixing', done: 0.45, ahead: 1 } },
      3: { status: 'straight', plan: { ...PLAN, style: 'straight', reason: 'Same album, in order', beats: 0 } },
      4: { status: 'unavailable', reason: 'No mix map yet for the next song' },
    };
    const app = Fastify();
    mixMapRoutes(app, { analyzer, library });
    transitionRoutes(app, { transitions: { request: async ({ fromTrackId }) => answers[fromTrackId]!, filePath: () => undefined } });
    recordFixture('mix-maps', await app.inject({ method: 'POST', url: '/api/mix-maps', payload: { ids: [ANGEL, RISINGSON] } }));
    recordFixture('analysis-progress', await app.inject({ method: 'GET', url: '/api/analysis/progress' }));
    await recordGets(app, [['cues', `/api/recordings/${ANGEL}/cues`]]);
    for (const [from, name] of [[1, 'ready'], [2, 'pending'], [3, 'straight'], [4, 'unavailable']] as const) {
      const res = await app.inject({ method: 'POST', url: '/api/transitions', payload: { from, to: 701, mode: 'auto' } });
      expect(res.json().status).toBe(name);
      recordFixture(`transition-${name}`, res);
    }
  });
});
```

**Step 2: Run it**

```bash
corepack pnpm -C apps/server exec vitest run src/routes/contract.test.ts
```

Expected: 5 tests pass (without `RECORD_FIXTURES` nothing is written). If one fails because phase 1 changed a route's deps or made it read the signed-in account, adapt as described in "Before you start", then run again.

**Step 3: Record from the existing tests whose answers are complete**

Each existing test below already builds its routes with real or complete data. Add `import { recordFixture } from '../testing/recordFixture.ts';` to each file's imports, then add the lines shown:

`apps/server/src/routes/status.test.ts`, after `expect(res.json()).toEqual({ queued: 4, background: 3, etaSeconds: 5, matching: 12 });`:

```ts
    recordFixture('musicbrainz-status', res);
```

`apps/server/src/routes/levels.test.ts`, in "answers each measured song’s gain…", replace

```ts
    const body = (await app.inject({ method: 'POST', url: '/api/levels', payload: { ids: ['a1', 'solo', 'a3', 'gone'] } })).json();
```

with

```ts
    const res = await app.inject({ method: 'POST', url: '/api/levels', payload: { ids: ['a1', 'solo', 'a3', 'gone'] } });
    recordFixture('levels', res);
    const body = res.json();
```

`apps/server/src/routes/settings.test.ts`:

- In "says which folder locations work…", after `expect(home.json()).toEqual({ smb: false });`:
  ```ts
      recordFixture('folder-access', home);
  ```
- In "adds a source from the home network and starts a sync", after `expect(library.refresh).toHaveBeenCalled();`:
  ```ts
      recordFixture('settings-source', res);
      recordFixture('settings-sources', await app.inject({ method: 'GET', url: '/api/settings/sources', remoteAddress: HOME }));
  ```
- In "lists and resolves review groups…", after `expect(list.json()).toEqual([{ groupKey: 'g', artistName: 'A', files: [], candidates: [] }]);`:
  ```ts
      recordFixture('review-groups', list);
  ```
- In "saves the AcoustID key…", after `expect(put.json()).toEqual({ acoustid: true, fingerprints: true });`:
  ```ts
      recordFixture('matching', put);
  ```
- In "starts with requests on and searching right away…", after its `expect(res.json()).toEqual({ … options });`:
  ```ts
        recordFixture('request-settings', res);
  ```
- In "turns automatic updates on and asks for a check", after `expect(check.json()).toMatchObject({ requested: true });`:
  ```ts
          recordFixture('updates', check);
  ```

If phase 1 replaced `remoteAddress: HOME` with an admin session in these tests, keep phase 1's way of sending the request; only the `recordFixture` lines are new.

**Step 4: Run the route tests, then record**

```bash
corepack pnpm -C apps/server exec vitest run src/routes src/testing
RECORD_FIXTURES=1 corepack pnpm -C apps/server exec vitest run src/routes
ls apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/Fixtures | wc -l
RECORD_FIXTURES=1 corepack pnpm -C apps/server exec vitest run src/routes
git status --short apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/Fixtures | head
```

Expected: all tests pass. 45 fixtures are written (plus any phase 1 already records, none yet). Recording a second time changes nothing: `git status` shows only the new untracked files, and running `git add` then recording again shows no modifications.

Look at two of them to see they are real: `cat apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/Fixtures/health.json` shows the library counts (1 artist, 1 album, 2 tracks). `playlist.json` shows the cover info and both items with their tracks.

**Step 5: Commit**

```bash
git add apps/server/src/routes/contract.test.ts apps/server/src/routes/settings.test.ts apps/server/src/routes/status.test.ts apps/server/src/routes/levels.test.ts apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/Fixtures
git commit -F - <<'MSG'
Record a real answer of every endpoint family the iOS app calls, as fixtures for its contract tests

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 5: Record the server, sign-in and account answers

Phase 1's route tests already make these requests. They only need a `recordFixture` line each.

**Files:**
- Modify: `apps/server/src/routes/auth.test.ts` and `apps/server/src/routes/accounts.test.ts` (phase 1 Tasks 6 and 7), and the test of `GET /api/server` (phase 1's server identity task; find it with `grep -rln "'/api/server'" apps/server/src --include='*.test.ts'`)
- Create (recorded): 7 fixtures in `apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/Fixtures/`

**Step 1: Add the recordings**

In each file, add `import { recordFixture } from '../testing/recordFixture.ts';`. Then, in the test that checks the answer named below, add the line after its assertion on that response. If the test reads `.json()` inline, first keep the response in a `const res`, as Task 4 did for levels. The `tidy` functions replace what is random on every run:

| Fixture | Answer of | Line to add |
|---|---|---|
| `server-info` | `GET /api/server` | `recordFixture('server-info', res, (info) => ({ ...info, id: '8d1e6f0a-0000-4000-8000-000000000001' }));` |
| `auth-sign-in` | `POST /api/auth/sign-in` | `recordFixture('auth-sign-in', res, (answer) => ({ ...answer, token: 'token' }));` |
| `auth-me` | `GET /api/auth/me` | `recordFixture('auth-me', res);` |
| `accounts` | `GET /api/accounts` | `recordFixture('accounts', res);` |
| `account-created` | `POST /api/accounts` | `recordFixture('account-created', res, (answer) => ({ ...answer, setup: { ...answer.setup, code: 'K7PQ2MXA', link: 'http://localhost/redeem?code=K7PQ2MXA' } }));` |
| `setup-code` | `POST /api/accounts/:id/reset` | `recordFixture('setup-code', res, (code) => ({ ...code, code: 'K7PQ2MXA', link: 'http://localhost/redeem?code=K7PQ2MXA' }));` |
| `sessions` | `GET /api/accounts/:id/sessions` | `recordFixture('sessions', res);` |

Use the answers of successful requests (2xx): `recordFixture` throws on any other status. If the `GET /api/server` test isn't under `apps/server/src/routes/`, add its path after `src/routes` in the recording commands below, in Task 17's workflow and in the conventions line of Task 19.

**Step 2: Run and record**

```bash
corepack pnpm -C apps/server exec vitest run src/routes
RECORD_FIXTURES=1 corepack pnpm -C apps/server exec vitest run src/routes
ls apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/Fixtures | wc -l
grep -L '"token": "token"' apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/Fixtures/auth-sign-in.json
```

Expected: tests pass; 52 fixtures; the `grep -L` prints nothing (the token was tidied).

**Step 3: Commit**

```bash
git add apps/server/src/routes/auth.test.ts apps/server/src/routes/accounts.test.ts <the GET /api/server test file> apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/Fixtures
git commit -F - <<'MSG'
Record the server, sign-in and account answers for the iOS contract tests

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---
### Task 6: Endpoints: every call the app makes, typed

An `Endpoint<Response>` is a value: method, path, query, JSON body and timeout. Every endpoint of the parity inventory (section 3) and the conventions' accounts table is a static constructor under `API.<Feature>`, so a call reads `try await client.send(API.Library.album(id: 70))`. Profiles are gone (phase 1), so there is no profiles group. Request bodies are private structs next to their endpoint. The few answers with no shared type (`{recorded}`, `{queued}`, `{restored}`, `{lyrics}`, 204) are in `Responses.swift`.

**Files:**
- Create: `apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/Endpoint.swift`, `Responses.swift`, `DeviceInfo.swift`
- Create: `apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/Endpoints/API.swift` and `API+Server.swift`, `API+Auth.swift`, `API+Accounts.swift`, `API+Library.swift`, `API+Search.swift`, `API+Discover.swift`, `API+Requests.swift`, `API+Favorites.swift`, `API+Playlists.swift`, `API+Settings.swift`, `API+Analysis.swift`, `API+Playback.swift`, `API+Mixes.swift`, `API+Stats.swift`
- Test: `apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/EndpointTests.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/EndpointTests.swift`:

```swift
import Foundation
import Testing
@testable import PlayarrAPI

@Suite struct EndpointTests {
    private func body<T>(_ endpoint: Endpoint<T>) throws -> [String: Any] {
        let data = try #require(try endpoint.bodyData())
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test func clearsCuePointsWithNull() throws {
        let sent = try body(API.Playback.setCues(recordingId: "rec-1", mixIn: 12.5, mixOut: nil))
        #expect(sent["mixIn"] as? Double == 12.5)
        #expect(sent["mixOut"] is NSNull)
    }

    @Test func sendsEverySourceAsNull() throws {
        let sent = try body(API.Accounts.create(username: "sam", name: "Sam", role: .member, canRequest: false, sources: nil))
        #expect(sent["sources"] is NSNull)
        #expect(sent["role"] as? String == "member")
    }

    @Test func leavesOutWhatAPatchDoesntChange() throws {
        #expect(try body(API.Accounts.update(id: 2, AccountPatch(name: "Sam"))).keys.sorted() == ["name"])
        let everySource = try body(API.Accounts.update(id: 2, AccountPatch(sources: .some(nil))))
        #expect(everySource["sources"] is NSNull)
    }

    @Test func leavesOutOptionalTransitionFields() throws {
        let sent = try body(API.Playback.transition(TransitionRequest(from: 3, to: 4, mode: .party, position: 61.5)))
        #expect(sent.keys.sorted() == ["from", "mode", "position", "to"])
        #expect(sent["mode"] as? String == "party")
    }

    @Test func runsEveryAnalysisAsAll() {
        #expect(API.Analysis.run(nil).path == "/api/analysis/all")
        #expect(API.Analysis.run(.beats).path == "/api/analysis/beats")
    }

    @Test func saysTheTimeZoneForMixes() {
        let endpoint = API.Mixes.get(key: "genre-electronic", timeZone: TimeZone(identifier: "Europe/London")!)
        #expect(endpoint.path == "/api/mixes/genre-electronic")
        #expect(endpoint.query == [URLQueryItem(name: "tz", value: "Europe/London")])
    }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --package-path apps/ios/Packages/PlayarrAPI --filter EndpointTests
```

Expected: build fails with `cannot find 'API' in scope`.

**Step 3: Write `Endpoint`, the extra answers and the device's name**

`apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/Endpoint.swift`:

```swift
import Foundation

public enum HTTPMethod: String, Sendable {
    case get = "GET", post = "POST", put = "PUT", patch = "PATCH", delete = "DELETE"
}

/// One call to the server: method, path, query and JSON body, typed by its answer.
public struct Endpoint<Response: Decodable & Sendable>: Sendable {
    public var method: HTTPMethod
    /// From the server's root, percent-encoded: "/api/albums/12".
    public var path: String
    public var query: [URLQueryItem]
    /// Sent as JSON.
    public var body: (any Encodable & Sendable)?
    /// Seconds before giving up; nil uses the client's default.
    public var timeout: TimeInterval?

    public init(
        _ method: HTTPMethod = .get,
        _ path: String,
        query: [URLQueryItem] = [],
        body: (any Encodable & Sendable)? = nil,
        timeout: TimeInterval? = nil
    ) {
        self.method = method
        self.path = path
        self.query = query
        self.body = body
        self.timeout = timeout
    }

    /// The body as JSON, or nil without one.
    public func bodyData() throws -> Data? {
        guard let body else { return nil }
        return try JSONEncoder().encode(body)
    }
}

extension Endpoint {
    /// A path segment encoded like the web's encodeURIComponent ("track:12" → "track%3A12").
    static func segment(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .uriComponent) ?? value
    }

    /// Query items, leaving out the nil ones.
    static func items(_ pairs: KeyValuePairs<String, String?>) -> [URLQueryItem] {
        pairs.compactMap { name, value in value.map { URLQueryItem(name: name, value: $0) } }
    }
}

extension CharacterSet {
    /// What encodeURIComponent leaves as is.
    static let uriComponent = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
}
```

`apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/Responses.swift`:

```swift
/// An answer with no body (204), or one the caller doesn't need.
public struct NoContent: Decodable, Sendable, Equatable {
    public init() {}
    public init(from decoder: any Decoder) throws {}
}

/// POST /api/plays.
public struct Recorded: Codable, Sendable, Equatable {
    public var recorded: Int
}

/// POST /api/analysis/:kind.
public struct Queued: Codable, Sendable, Equatable {
    public var queued: Int
}

/// POST /api/settings/sources/:id/organize/undo.
public struct Restored: Codable, Sendable, Equatable {
    public var restored: Int
}

/// GET /api/tracks/:id/lyrics: null when none were found.
public struct LyricsAnswer: Codable, Sendable, Equatable {
    public var lyrics: Lyrics?
}
```

`apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/DeviceInfo.swift`:

```swift
import Foundation
#if os(iOS)
import UIKit
#endif

/// How this device names itself to the server's session list (Settings → Accounts).
public struct DeviceInfo: Sendable, Equatable {
    public var name: String
    public var platform: String

    public init(name: String, platform: String) {
        self.name = name
        self.platform = platform
    }

    @MainActor public static func current() -> DeviceInfo {
        #if os(iOS)
        DeviceInfo(name: UIDevice.current.name, platform: UIDevice.current.userInterfaceIdiom == .pad ? "ipados" : "ios")
        #else
        DeviceInfo(name: ProcessInfo.processInfo.hostName, platform: "macos")
        #endif
    }
}
```

**Step 4: Write the endpoint groups**

`apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/Endpoints/API.swift`:

```swift
/// Every endpoint the app calls, grouped by feature: `try await client.send(API.Library.album(id: 12))`.
public enum API {}
```

`apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/Endpoints/API+Server.swift`:

```swift
extension API {
    /// The server itself: who it is, whether it's healthy, background work.
    public enum Server {
        /// GET /api/server: id, name, version, minAppVersion, setup mode. Answered without signing in.
        public static func info() -> Endpoint<ServerInfo> { Endpoint(.get, "/api/server", timeout: 10) }

        /// GET /api/health: Lidarr, media and library counts, and whether requests are on.
        public static func health() -> Endpoint<HealthStatus> { Endpoint(.get, "/api/health") }

        /// GET /api/musicbrainz/status: the MusicBrainz queue and its wait.
        public static func musicBrainzStatus() -> Endpoint<MusicBrainzStatus> { Endpoint(.get, "/api/musicbrainz/status") }

        /// POST /api/library/refresh (admin): scan every source now.
        public static func refreshLibrary() -> Endpoint<LibraryStats> { Endpoint(.post, "/api/library/refresh", timeout: 300) }
    }
}
```

`apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/Endpoints/API+Auth.swift`:

```swift
extension API {
    /// Signing in and out. Sign-in, redeem and setup are sent without a token.
    public enum Auth {
        /// POST /api/auth/setup: claims a server in setup mode as its owner (home network only).
        public static func setup(username: String, name: String, password: String, device: DeviceInfo) -> Endpoint<SignInResponse> {
            Endpoint(.post, "/api/auth/setup", body: SetupBody(username: username, name: name, password: password, device: device.name, platform: device.platform))
        }

        /// POST /api/auth/sign-in.
        public static func signIn(username: String, password: String, device: DeviceInfo) -> Endpoint<SignInResponse> {
            Endpoint(.post, "/api/auth/sign-in", body: SignInBody(username: username, password: password, device: device.name, platform: device.platform))
        }

        /// POST /api/auth/redeem: a setup code from an admin, and the account's first password.
        public static func redeem(code: String, password: String, device: DeviceInfo) -> Endpoint<SignInResponse> {
            Endpoint(.post, "/api/auth/redeem", body: RedeemBody(code: code, password: password, device: device.name, platform: device.platform))
        }

        /// POST /api/auth/sign-out: ends this session.
        public static func signOut() -> Endpoint<NoContent> { Endpoint(.post, "/api/auth/sign-out") }

        /// GET /api/auth/me: the signed-in account.
        public static func me() -> Endpoint<Account> { Endpoint(.get, "/api/auth/me") }

        private struct SetupBody: Encodable, Sendable {
            let username, name, password, device, platform: String
        }

        private struct SignInBody: Encodable, Sendable {
            let username, password, device, platform: String
        }

        private struct RedeemBody: Encodable, Sendable {
            let code, password, device, platform: String
        }
    }
}
```

`apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/Endpoints/API+Accounts.swift`:

```swift
extension API {
    /// Settings → Accounts (admin; an account may rename itself and see its own sessions).
    public enum Accounts {
        public static func list() -> Endpoint<[Account]> { Endpoint(.get, "/api/accounts") }

        /// A new account and its one-time setup code. `sources` nil: every source.
        public static func create(username: String, name: String, role: AccountRole, canRequest: Bool, sources: [Int]?) -> Endpoint<CreatedAccount> {
            Endpoint(.post, "/api/accounts", body: CreateBody(username: username, name: name, role: role, canRequest: canRequest, sources: sources))
        }

        public static func update(id: Int, _ patch: AccountPatch) -> Endpoint<Account> { Endpoint(.patch, "/api/accounts/\(id)", body: patch) }

        /// The accounts left (the last admin can't be deleted).
        public static func delete(id: Int) -> Endpoint<[Account]> { Endpoint(.delete, "/api/accounts/\(id)") }

        /// A new setup code; every session of the account is signed out.
        public static func reset(id: Int) -> Endpoint<SetupCode> { Endpoint(.post, "/api/accounts/\(id)/reset") }

        public static func sessions(accountId: Int) -> Endpoint<[SessionInfo]> { Endpoint(.get, "/api/accounts/\(accountId)/sessions") }

        /// The sessions left.
        public static func endSession(accountId: Int, sessionId: Int) -> Endpoint<[SessionInfo]> {
            Endpoint(.delete, "/api/accounts/\(accountId)/sessions/\(sessionId)")
        }

        private struct CreateBody: Encodable, Sendable {
            let username, name: String
            let role: AccountRole
            let canRequest: Bool
            let sources: [Int]?

            func encode(to encoder: any Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                try container.encode(username, forKey: .username)
                try container.encode(name, forKey: .name)
                try container.encode(role, forKey: .role)
                try container.encode(canRequest, forKey: .canRequest)
                try container.encode(sources, forKey: .sources) // null: every source
            }

            private enum CodingKeys: String, CodingKey { case username, name, role, canRequest, sources }
        }
    }
}

/// PATCH /api/accounts/:id: only the fields set are changed. `sources: .some(nil)` gives every source.
public struct AccountPatch: Encodable, Sendable, Equatable {
    public var name: String?
    public var role: AccountRole?
    public var canRequest: Bool?
    public var sources: [Int]??

    public init(name: String? = nil, role: AccountRole? = nil, canRequest: Bool? = nil, sources: [Int]?? = nil) {
        self.name = name
        self.role = role
        self.canRequest = canRequest
        self.sources = sources
    }
}
```

`apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/Endpoints/API+Library.swift`:

```swift
extension API {
    /// Browsing the library.
    public enum Library {
        public static func artists() -> Endpoint<[Artist]> { Endpoint(.get, "/api/artists") }
        public static func artist(id: Int) -> Endpoint<ArtistDetail> { Endpoint(.get, "/api/artists/\(id)") }
        public static func artistTracks(id: Int) -> Endpoint<[Track]> { Endpoint(.get, "/api/artists/\(id)/tracks") }

        public static func albums(sort: AlbumSort, limit: Int? = nil) -> Endpoint<[Album]> {
            Endpoint(.get, "/api/albums", query: Endpoint<[Album]>.items(["sort": sort.rawValue, "limit": limit.map(String.init)]))
        }

        public static func randomAlbums(limit: Int = 12) -> Endpoint<[Album]> {
            Endpoint(.get, "/api/albums/random", query: [.init(name: "limit", value: String(limit))])
        }

        public static func album(id: Int) -> Endpoint<AlbumDetail> { Endpoint(.get, "/api/albums/\(id)") }

        public static func randomTracks(limit: Int = 50) -> Endpoint<[Track]> {
            Endpoint(.get, "/api/tracks/random", query: [.init(name: "limit", value: String(limit))])
        }

        /// Jump back in: albums heard lately.
        public static func recentAlbums() -> Endpoint<[Album]> { Endpoint(.get, "/api/plays/recent-albums") }

        /// Show metadata.
        public static func trackMetadata(id: Int) -> Endpoint<TrackMetadata> { Endpoint(.get, "/api/tracks/\(id)/metadata") }

        /// Show metadata → Match again (admin).
        public static func rematchFile(fileId: Int) -> Endpoint<RematchResult> { Endpoint(.post, "/api/files/\(fileId)/rematch") }

        public static func lyrics(trackId: Int) -> Endpoint<LyricsAnswer> { Endpoint(.get, "/api/tracks/\(trackId)/lyrics") }
    }
}
```

`apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/Endpoints/API+Search.swift`:

```swift
extension API {
    public enum Search {
        /// GET /api/search: artists, albums and songs in the library.
        public static func library(_ query: String) -> Endpoint<SearchResults> {
            Endpoint(.get, "/api/search", query: [.init(name: "q", value: query)])
        }
    }
}
```

`apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/Endpoints/API+Discover.swift`:

```swift
extension API {
    /// Music not in the library yet (MusicBrainz, through the server).
    public enum Discover {
        public static func search(_ query: String) -> Endpoint<DiscoverResults> {
            Endpoint(.get, "/api/discover/search", query: [.init(name: "q", value: query)])
        }

        public static func artist(mbid: String) -> Endpoint<DiscoverArtistDetail> {
            Endpoint(.get, "/api/discover/artists/\(Endpoint<DiscoverArtistDetail>.segment(mbid))")
        }

        public static func similarArtists(mbid: String) -> Endpoint<[DiscoverArtist]> {
            Endpoint(.get, "/api/discover/artists/\(Endpoint<[DiscoverArtist]>.segment(mbid))/similar")
        }

        public static func findArtist(name: String) -> Endpoint<ArtistMatch> {
            Endpoint(.get, "/api/discover/artist-lookup", query: [.init(name: "name", value: name)])
        }
    }
}
```

`apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/Endpoints/API+Requests.swift`:

```swift
extension API {
    /// Album requests (Lidarr), when requests are on and the account may request.
    public enum Requests {
        public static func list() -> Endpoint<[AlbumRequest]> { Endpoint(.get, "/api/requests") }
        public static func request(_ album: AlbumRef) -> Endpoint<AlbumRequest> { Endpoint(.post, "/api/requests", body: album) }

        public static func remove(mbid: String) -> Endpoint<NoContent> {
            Endpoint(.delete, "/api/requests/\(Endpoint<NoContent>.segment(mbid))")
        }
    }
}
```

`apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/Endpoints/API+Favorites.swift`:

```swift
extension API {
    public enum Favorites {
        public static func list() -> Endpoint<[FavoriteTrack]> { Endpoint(.get, "/api/favorites") }

        public static func add(recordingId: String) -> Endpoint<NoContent> {
            Endpoint(.put, "/api/favorites/\(Endpoint<NoContent>.segment(recordingId))")
        }

        public static func remove(recordingId: String) -> Endpoint<NoContent> {
            Endpoint(.delete, "/api/favorites/\(Endpoint<NoContent>.segment(recordingId))")
        }
    }
}
```

`apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/Endpoints/API+Playlists.swift`:

```swift
extension API {
    public enum Playlists {
        public static func list() -> Endpoint<[PlaylistSummary]> { Endpoint(.get, "/api/playlists") }
        public static func get(id: Int) -> Endpoint<PlaylistDetail> { Endpoint(.get, "/api/playlists/\(id)") }

        public static func create(name: String, description: String? = nil, recordingIds: [String]? = nil) -> Endpoint<PlaylistDetail> {
            Endpoint(.post, "/api/playlists", body: CreateBody(name: name, description: description, recordingIds: recordingIds))
        }

        public static func update(id: Int, name: String? = nil, description: String? = nil) -> Endpoint<PlaylistDetail> {
            Endpoint(.patch, "/api/playlists/\(id)", body: UpdateBody(name: name, description: description))
        }

        public static func delete(id: Int) -> Endpoint<NoContent> { Endpoint(.delete, "/api/playlists/\(id)") }

        public static func addItems(id: Int, recordingIds: [String]) -> Endpoint<PlaylistDetail> {
            Endpoint(.post, "/api/playlists/\(id)/items", body: ["recordingIds": recordingIds])
        }

        public static func removeItem(id: Int, itemId: Int) -> Endpoint<PlaylistDetail> {
            Endpoint(.delete, "/api/playlists/\(id)/items/\(itemId)")
        }

        public static func reorder(id: Int, itemIds: [Int]) -> Endpoint<PlaylistDetail> {
            Endpoint(.put, "/api/playlists/\(id)/order", body: ["itemIds": itemIds])
        }

        public static func setCover(id: Int, layout: CoverLayout, variant: Int) -> Endpoint<PlaylistDetail> {
            Endpoint(.put, "/api/playlists/\(id)/cover", body: CoverBody(layout: layout, variant: variant))
        }

        public static func recommendations(id: Int, variant: Int = 0) -> Endpoint<Recommendations> {
            Endpoint(.get, "/api/playlists/\(id)/recommendations", query: [.init(name: "variant", value: String(variant))])
        }

        private struct CreateBody: Encodable, Sendable {
            let name: String
            let description: String?
            let recordingIds: [String]?
        }

        private struct UpdateBody: Encodable, Sendable {
            let name: String?
            let description: String?
        }

        private struct CoverBody: Encodable, Sendable {
            let layout: CoverLayout
            let variant: Int
        }
    }
}
```

`apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/Endpoints/API+Settings.swift`:

```swift
extension API {
    /// Settings: sources, matching, requests, updates (admin), mixes and ListenBrainz (per account).
    public enum Settings {
        public static func sources() -> Endpoint<SourcesResponse> { Endpoint(.get, "/api/settings/sources") }
        public static func addSource(_ input: SourceInput) -> Endpoint<SourceInfo> { Endpoint(.post, "/api/settings/sources", body: input) }
        public static func updateSource(id: Int, _ input: SourceInput) -> Endpoint<SourceInfo> { Endpoint(.patch, "/api/settings/sources/\(id)", body: input) }
        public static func removeSource(id: Int) -> Endpoint<NoContent> { Endpoint(.delete, "/api/settings/sources/\(id)") }
        public static func reorderSources(ids: [Int]) -> Endpoint<SourcesResponse> { Endpoint(.put, "/api/settings/sources/order", body: ["ids": ids]) }

        public static func testSource(id: Int? = nil, url: String? = nil, apiKey: String? = nil) -> Endpoint<SourceTestResult> {
            Endpoint(.post, "/api/settings/sources/test", body: TestBody(id: id, url: url, apiKey: apiKey))
        }

        public static func rescanSource(id: Int) -> Endpoint<NoContent> { Endpoint(.post, "/api/settings/sources/\(id)/rescan") }
        public static func rematchSource(id: Int) -> Endpoint<NoContent> { Endpoint(.post, "/api/settings/sources/\(id)/rematch") }
        public static func browseFolders(_ request: FolderBrowseRequest) -> Endpoint<FolderListing> { Endpoint(.post, "/api/settings/folders/browse", body: request) }
        public static func folderAccess() -> Endpoint<FolderAccessOptions> { Endpoint(.get, "/api/settings/folders/access") }
        public static func review(sourceId: Int) -> Endpoint<[ReviewGroup]> { Endpoint(.get, "/api/settings/sources/\(sourceId)/review") }

        public static func reviewAction(sourceId: Int, _ action: ReviewAction) -> Endpoint<NoContent> {
            Endpoint(.post, "/api/settings/sources/\(sourceId)/review", body: action)
        }

        public static func organizePlan(sourceId: Int) -> Endpoint<OrganizePlan> { Endpoint(.get, "/api/settings/sources/\(sourceId)/organize") }

        public static func organize(sourceId: Int, moves: [String]) -> Endpoint<OrganizeResult> {
            Endpoint(.post, "/api/settings/sources/\(sourceId)/organize", body: ["moves": moves])
        }

        public static func undoOrganize(sourceId: Int, batchId: Int) -> Endpoint<Restored> {
            Endpoint(.post, "/api/settings/sources/\(sourceId)/organize/undo", body: ["batchId": batchId])
        }

        public static func matching() -> Endpoint<MatchingSettings> { Endpoint(.get, "/api/settings/matching") }
        public static func saveMatching(acoustidKey: String) -> Endpoint<MatchingSettings> { Endpoint(.put, "/api/settings/matching", body: ["acoustidKey": acoustidKey]) }
        public static func requests() -> Endpoint<RequestSettingsInfo> { Endpoint(.get, "/api/settings/requests") }
        public static func saveRequests(_ patch: RequestSettingsPatch) -> Endpoint<RequestSettingsInfo> { Endpoint(.put, "/api/settings/requests", body: patch) }
        public static func updates() -> Endpoint<UpdateInfo> { Endpoint(.get, "/api/settings/updates") }
        public static func saveUpdates(_ patch: UpdateSettingsPatch) -> Endpoint<UpdateInfo> { Endpoint(.put, "/api/settings/updates", body: patch) }
        public static func checkForUpdates() -> Endpoint<UpdateInfo> { Endpoint(.post, "/api/settings/updates/check") }
        public static func mixes() -> Endpoint<MixSettingsInfo> { Endpoint(.get, "/api/settings/mixes") }
        public static func saveMixes(_ patch: MixSettingsPatch) -> Endpoint<MixSettingsInfo> { Endpoint(.put, "/api/settings/mixes", body: patch) }
        /// Forgets everything played; the mixes are made again.
        public static func clearHistory() -> Endpoint<MixSettingsInfo> { Endpoint(.delete, "/api/settings/mixes/history") }
        public static func listenBrainz() -> Endpoint<ListenBrainzInfo> { Endpoint(.get, "/api/settings/listenbrainz") }

        public static func saveListenBrainz(token: String? = nil, enabled: Bool? = nil) -> Endpoint<ListenBrainzInfo> {
            Endpoint(.put, "/api/settings/listenbrainz", body: ListenBrainzBody(token: token, enabled: enabled))
        }

        public static func disconnectListenBrainz() -> Endpoint<ListenBrainzInfo> { Endpoint(.delete, "/api/settings/listenbrainz") }
        public static func sendEarlierListens() -> Endpoint<ListenBrainzInfo> { Endpoint(.post, "/api/settings/listenbrainz/earlier") }

        private struct TestBody: Encodable, Sendable {
            let id: Int?
            let url: String?
            let apiKey: String?
        }

        private struct ListenBrainzBody: Encodable, Sendable {
            let token: String?
            let enabled: Bool?
        }
    }
}
```

`apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/Endpoints/API+Analysis.swift`:

```swift
extension API {
    /// Settings → Analysis.
    public enum Analysis {
        public static func progress() -> Endpoint<AnalysisProgress> { Endpoint(.get, "/api/analysis/progress") }

        /// Queues every song this analysis hasn't done (nil: every analysis); `again`: every song.
        public static func run(_ kind: AnalysisKind?, again: Bool = false) -> Endpoint<Queued> {
            Endpoint(.post, "/api/analysis/\(kind?.rawValue ?? "all")", body: ["again": again])
        }
    }
}
```

`apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/Endpoints/API+Playback.swift`:

```swift
extension API {
    /// What the player asks for: plays, levels, transitions, radio, mix maps and cue points.
    public enum Playback {
        public static func reportPlays(_ plays: [PlayReport]) -> Endpoint<Recorded> { Endpoint(.post, "/api/plays", body: ["plays": plays]) }

        /// Even volume: gains for up to 50 recordings.
        public static func levels(ids: [String]) -> Endpoint<[String: TrackLevel]> { Endpoint(.post, "/api/levels", body: ["ids": ids]) }

        public static func transition(_ request: TransitionRequest) -> Endpoint<TransitionAnswer> { Endpoint(.post, "/api/transitions", body: request) }

        /// Songs like the seeds, from the library.
        public static func radio(seeds: [String], exclude: [String] = [], count: Int = 25) -> Endpoint<[Track]> {
            Endpoint(.post, "/api/radio", body: RadioBody(seeds: seeds, exclude: exclude, count: count))
        }

        /// Mix maps for up to 50 recordings, with any cue points set by hand.
        public static func mixMaps(ids: [String]) -> Endpoint<[String: MixMapEntry]> { Endpoint(.post, "/api/mix-maps", body: ["ids": ids]) }

        public static func cues(recordingId: String) -> Endpoint<CuePoints> {
            Endpoint(.get, "/api/recordings/\(Endpoint<CuePoints>.segment(recordingId))/cues")
        }

        /// Replaces both mix points; nil clears one (the detected point is used again).
        public static func setCues(recordingId: String, mixIn: Double?, mixOut: Double?) -> Endpoint<CuePoints> {
            Endpoint(.put, "/api/recordings/\(Endpoint<CuePoints>.segment(recordingId))/cues", body: CuesBody(mixIn: mixIn, mixOut: mixOut))
        }

        private struct RadioBody: Encodable, Sendable {
            let seeds: [String]
            let exclude: [String]
            let count: Int
        }

        private struct CuesBody: Encodable, Sendable {
            let mixIn: Double?
            let mixOut: Double?

            func encode(to encoder: any Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                try container.encode(mixIn, forKey: .mixIn) // null clears the point
                try container.encode(mixOut, forKey: .mixOut)
            }

            private enum CodingKeys: String, CodingKey { case mixIn, mixOut }
        }
    }
}

/// POST /api/transitions: `from` into `to` (catalog song ids).
public struct TransitionRequest: Encodable, Sendable, Equatable {
    public var from: Int
    public var to: Int
    public var mode: MixMode
    /// Where `from` is now, so the plan doesn't start in the past.
    public var position: Double?
    /// The files the player has, so the server never renders from another one.
    public var fromFileId: Int?
    public var toFileId: Int?
    /// The listener's fade length, for songs that can't be mixed on the beat.
    public var fade: Double?
    /// The queue plays the songs' album (songs of one album in order go straight on).
    public var albumQueue: Bool?
    /// The gains (dB) the player plays each song at.
    public var levels: TransitionAnswer.Ready.Levels?

    public init(from: Int, to: Int, mode: MixMode, position: Double? = nil, fromFileId: Int? = nil, toFileId: Int? = nil, fade: Double? = nil, albumQueue: Bool? = nil, levels: TransitionAnswer.Ready.Levels? = nil) {
        self.from = from
        self.to = to
        self.mode = mode
        self.position = position
        self.fromFileId = fromFileId
        self.toFileId = toFileId
        self.fade = fade
        self.albumQueue = albumQueue
        self.levels = levels
    }
}
```

`apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/Endpoints/API+Mixes.swift`:

```swift
import Foundation

extension API {
    /// Made for you. Each call says the device's time zone: mixes follow the listener's clock.
    public enum Mixes {
        public static func list(timeZone: TimeZone = .current) -> Endpoint<[MixSummary]> { Endpoint(.get, "/api/mixes", query: tz(timeZone)) }

        public static func get(key: String, timeZone: TimeZone = .current) -> Endpoint<MixDetail> {
            Endpoint(.get, "/api/mixes/\(Endpoint<MixDetail>.segment(key))", query: tz(timeZone))
        }

        public static func regenerate(key: String, timeZone: TimeZone = .current) -> Endpoint<MixDetail> {
            Endpoint(.post, "/api/mixes/\(Endpoint<MixDetail>.segment(key))/regenerate", query: tz(timeZone))
        }

        /// Saves the mix as a playlist.
        public static func save(key: String, timeZone: TimeZone = .current) -> Endpoint<PlaylistDetail> {
            Endpoint(.post, "/api/mixes/\(Endpoint<PlaylistDetail>.segment(key))/save", query: tz(timeZone))
        }

        private static func tz(_ zone: TimeZone) -> [URLQueryItem] { [URLQueryItem(name: "tz", value: zone.identifier)] }
    }
}
```

`apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/Endpoints/API+Stats.swift`:

```swift
extension API {
    /// Your listening.
    public enum Stats {
        /// "month", "halfyear", "year", "all" or a calendar year ("2026").
        public static func listening(_ range: StatsRange) -> Endpoint<ListeningStats> {
            Endpoint(.get, "/api/stats", query: [.init(name: "range", value: range)])
        }
    }
}
```

**Step 5: Run it to see it pass**

```bash
swift test --package-path apps/ios/Packages/PlayarrAPI --filter EndpointTests
```

Expected: 6 tests pass.

**Step 6: Commit**

```bash
git add apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/Endpoint.swift apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/Responses.swift apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/DeviceInfo.swift apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/Endpoints apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/EndpointTests.swift
git commit -F - <<'MSG'
iOS: every server endpoint as a typed call, grouped by feature

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 7: The API client: headers, errors, 401, timeouts, cancellation

**Files:**
- Create: `apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/APIError.swift`, `APIClient.swift`
- Test: `apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/StubProtocol.swift` (a URLProtocol stub keyed by host, so parallel tests don't meet), `APIClientTests.swift`

**Step 1: Write the stub and the failing tests**

`apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/StubProtocol.swift`:

```swift
import Foundation
import Synchronization

/// Answers requests from a handler registered per host, so tests running in parallel don't meet.
final class StubProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) throws -> (status: Int, body: Data)

    private static let handlers = Mutex<[String: Handler]>([:])

    /// A session whose requests to `http://<host>` go to `handler`. Each test uses its own host.
    static func session(host: String, handler: @escaping Handler) -> URLSession {
        handlers.withLock { $0[host] = handler }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        return URLSession(configuration: configuration)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url, let handler = Self.handlers.withLock({ $0[url.host() ?? ""] }) else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotFindHost))
            return
        }
        do {
            let (status, body) = try handler(request)
            let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: body)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

extension URLRequest {
    /// The body as sent: URLSession moves it into a stream before URLProtocol sees it.
    var sentBody: Data? {
        if let httpBody { return httpBody }
        guard let stream = httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }
}

/// A host no other test uses.
func uniqueHost() -> String { "test-\(UUID().uuidString.lowercased()).invalid" }

func json(_ string: String) -> Data { Data(string.utf8) }
```

`apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/APIClientTests.swift`:

```swift
import Foundation
import Synchronization
import Testing
@testable import PlayarrAPI

@Suite struct APIClientTests {
    @Test func sendsTheTokenAndThePlayarrHeader() async throws {
        let host = uniqueHost()
        let seen = Mutex<URLRequest?>(nil)
        let session = StubProtocol.session(host: host) { request in
            seen.withLock { $0 = request }
            return (200, json(#"{"id":"u-1","name":"Home","version":"0.7.0","minAppVersion":"1.0.0","setup":false}"#))
        }
        let client = APIClient(baseURL: URL(string: "http://\(host)")!, token: "tok", session: session)

        let info = try await client.send(API.Server.info())

        #expect(info.name == "Home")
        let request = try #require(seen.withLock { $0 })
        #expect(request.url?.absoluteString == "http://\(host)/api/server")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer tok")
        #expect(request.value(forHTTPHeaderField: "X-Playarr") == "1")
        #expect(request.value(forHTTPHeaderField: "Accept") == "application/json")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == nil)
    }

    @Test func sendsNoAuthorizationWithoutAToken() throws {
        let client = APIClient(baseURL: URL(string: "http://localhost:4000")!)
        let request = try client.urlRequest(for: API.Server.info())
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
    }

    @Test func sendsTheBodyAsJSON() async throws {
        let host = uniqueHost()
        let body = Mutex<Data?>(nil)
        let session = StubProtocol.session(host: host) { request in
            body.withLock { $0 = request.sentBody }
            #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
            #expect(request.httpMethod == "POST")
            return (200, json(#"{"queued":4400}"#))
        }
        let client = APIClient(baseURL: URL(string: "http://\(host)")!, token: "tok", session: session)

        _ = try await client.send(API.Analysis.run(.loudness, again: true))
        let sent = try JSONSerialization.jsonObject(with: try #require(body.withLock { $0 })) as? [String: Bool]
        #expect(sent == ["again": true])
    }

    @Test func keepsThePathOfTheServerAddress() throws {
        let client = APIClient(baseURL: URL(string: "https://example.com/playarr/")!)
        let request = try client.urlRequest(for: API.Library.albums(sort: .added, limit: 20))
        #expect(request.url?.absoluteString == "https://example.com/playarr/api/albums?sort=added&limit=20")
    }

    @Test func encodesQueriesAndSegmentsLikeTheWeb() throws {
        let client = APIClient(baseURL: URL(string: "http://localhost:4000")!)
        #expect(try client.urlRequest(for: API.Search.library("AC+DC & co")).url?.absoluteString == "http://localhost:4000/api/search?q=AC%2BDC%20%26%20co")
        #expect(try client.urlRequest(for: API.Favorites.add(recordingId: "track:12")).url?.absoluteString == "http://localhost:4000/api/favorites/track%3A12")
    }

    @Test func turnsAnErrorAnswerIntoItsMessage() async throws {
        let host = uniqueHost()
        let session = StubProtocol.session(host: host) { _ in (404, json(#"{"error":"Album not found"}"#)) }
        let client = APIClient(baseURL: URL(string: "http://\(host)")!, token: "tok", session: session)

        await #expect(throws: APIError.server(status: 404, message: "Album not found")) {
            try await client.send(API.Library.album(id: 9))
        }
    }

    @Test func saysWhichStatusWhenTheErrorHasNoMessage() async throws {
        let host = uniqueHost()
        let session = StubProtocol.session(host: host) { _ in (502, Data()) }
        let client = APIClient(baseURL: URL(string: "http://\(host)")!, session: session)

        await #expect(throws: APIError.server(status: 502, message: "Request failed (502)")) {
            try await client.send(API.Server.health())
        }
    }

    @Test func endsTheSessionOnA401WithAToken() async throws {
        let host = uniqueHost()
        let session = StubProtocol.session(host: host) { _ in (401, json(#"{"error":"Sign in","setup":false}"#)) }
        let ended = Mutex(0)
        let client = APIClient(baseURL: URL(string: "http://\(host)")!, token: "old", session: session) {
            ended.withLock { $0 += 1 }
        }

        await #expect(throws: APIError.unauthorized) { try await client.send(API.Auth.me()) }
        #expect(ended.withLock { $0 } == 1)
    }

    @Test func keepsTheMessageOfA401WithoutAToken() async throws {
        let host = uniqueHost()
        let session = StubProtocol.session(host: host) { _ in (401, json(#"{"error":"Wrong username or password"}"#)) }
        let client = APIClient(baseURL: URL(string: "http://\(host)")!, session: session)

        await #expect(throws: APIError.server(status: 401, message: "Wrong username or password")) {
            try await client.send(API.Auth.signIn(username: "a", password: "b", device: DeviceInfo(name: "Test", platform: "ios")))
        }
    }

    @Test func acceptsNoContent() async throws {
        let host = uniqueHost()
        let session = StubProtocol.session(host: host) { _ in (204, Data()) }
        let client = APIClient(baseURL: URL(string: "http://\(host)")!, token: "tok", session: session)

        #expect(try await client.send(API.Auth.signOut()) == NoContent())
    }

    @Test func reportsAnAnswerItCantRead() async throws {
        let host = uniqueHost()
        let session = StubProtocol.session(host: host) { _ in (200, json(#"{"unexpected":true}"#)) }
        let client = APIClient(baseURL: URL(string: "http://\(host)")!, session: session)

        await #expect {
            try await client.send(API.Server.info())
        } throws: { error in
            if case APIError.decoding = error { true } else { false }
        }
    }

    @Test func isOfflineWhenTheServerCantBeReached() async throws {
        let host = uniqueHost()
        let session = StubProtocol.session(host: host) { _ in throw URLError(.cannotConnectToHost) }
        let client = APIClient(baseURL: URL(string: "http://\(host)")!, session: session)

        await #expect(throws: APIError.offline) { try await client.send(API.Server.info()) }
    }

    @Test func passesCancellationOn() async throws {
        let host = uniqueHost()
        let session = StubProtocol.session(host: host) { _ in throw URLError(.cancelled) }
        let client = APIClient(baseURL: URL(string: "http://\(host)")!, session: session)

        await #expect(throws: CancellationError.self) { try await client.send(API.Server.info()) }
    }

    @Test func usesTheEndpointsTimeout() throws {
        let client = APIClient(baseURL: URL(string: "http://localhost:4000")!, timeout: 30)
        #expect(try client.urlRequest(for: API.Server.info()).timeoutInterval == 10)
        #expect(try client.urlRequest(for: API.Server.health()).timeoutInterval == 30)
    }
}
```

**Step 2: Run them to see them fail**

```bash
swift test --package-path apps/ios/Packages/PlayarrAPI --filter APIClientTests
```

Expected: build fails with `cannot find 'APIClient' in scope`.

**Step 3: Write the error and the client**

`apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/APIError.swift`:

```swift
import Foundation

/// What can go wrong talking to a Playarr server.
public enum APIError: Error, Equatable, Sendable, LocalizedError {
    /// The session ended (signed out elsewhere, password reset): sign in again.
    case unauthorized
    /// The server answered with an error status and its `{ error }` message.
    case server(status: Int, message: String)
    /// The server couldn't be reached.
    case offline
    /// The answer isn't what this version of the app expects.
    case decoding(String)

    public var errorDescription: String? {
        switch self {
        case .unauthorized: "You were signed out. Sign in again."
        case .server(_, let message): message
        case .offline: "Can’t reach the server. Check the address and your connection."
        case .decoding: "The server sent an answer this version of Playarr doesn’t understand."
        }
    }
}
```

`apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/APIClient.swift`:

```swift
import Foundation

/// Talks to one server as one account, or as nobody (to sign in). Every request carries
/// `X-Playarr: 1` and, with a token, `Authorization: Bearer <token>`; error answers become `APIError`.
public actor APIClient {
    public nonisolated let baseURL: URL
    private nonisolated let token: String?
    private let session: URLSession
    private nonisolated let timeout: TimeInterval
    private let onUnauthorized: @Sendable () async -> Void

    /// `onUnauthorized` runs when the server answers 401 to a request that carried the token: the
    /// session has ended (ServerStore marks the account signed out).
    public init(
        baseURL: URL,
        token: String? = nil,
        session: URLSession = .shared,
        timeout: TimeInterval = 30,
        onUnauthorized: @escaping @Sendable () async -> Void = {}
    ) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
        self.timeout = timeout
        self.onUnauthorized = onUnauthorized
    }

    public func send<T: Decodable & Sendable>(_ endpoint: Endpoint<T>) async throws -> T {
        let request = try urlRequest(for: endpoint)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw Self.transportError(error)
        }
        guard let http = response as? HTTPURLResponse else { throw APIError.offline }
        if http.statusCode == 401, token != nil {
            await onUnauthorized()
            throw APIError.unauthorized
        }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError.server(status: http.statusCode, message: Self.message(in: data, status: http.statusCode))
        }
        do {
            return try Self.decode(T.self, from: data)
        } catch {
            throw APIError.decoding(String(describing: error))
        }
    }

    /// The request `send` makes for `endpoint`.
    public nonisolated func urlRequest<T>(for endpoint: Endpoint<T>) throws -> URLRequest {
        var request = URLRequest(url: try Self.url(base: baseURL, path: endpoint.path, query: endpoint.query))
        request.httpMethod = endpoint.method.rawValue
        request.timeoutInterval = endpoint.timeout ?? timeout
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        // The server's guard against other sites; Bearer requests are exempt, but it costs nothing.
        request.setValue("1", forHTTPHeaderField: "X-Playarr")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body = try endpoint.bodyData() {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }

    /// Decodes an answer as `send` does: an empty body (204) reads as JSON null, which `NoContent` accepts.
    public static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        try JSONDecoder().decode(type, from: data.isEmpty ? Data("null".utf8) : data)
    }

    static func url(base: URL, path: String, query: [URLQueryItem]) throws -> URL {
        guard var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else { throw URLError(.badURL) }
        var prefix = components.percentEncodedPath
        if prefix.hasSuffix("/") { prefix.removeLast() }
        components.percentEncodedPath = prefix + path
        components.percentEncodedQuery = query.isEmpty ? nil : query.map { item in
            let value = item.value.map { "=" + ($0.addingPercentEncoding(withAllowedCharacters: .uriComponent) ?? $0) } ?? ""
            return Endpoint<NoContent>.segment(item.name) + value
        }.joined(separator: "&")
        guard let url = components.url else { throw URLError(.badURL) }
        return url
    }

    static func transportError(_ error: any Error) -> any Error {
        if error is CancellationError { return error }
        if let urlError = error as? URLError, urlError.code == .cancelled { return CancellationError() }
        return APIError.offline
    }

    private struct ErrorBody: Decodable {
        let error: String?
    }

    static func message(in data: Data, status: Int) -> String {
        (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error ?? "Request failed (\(status))"
    }
}
```

**Step 4: Run them to see them pass**

```bash
swift test --package-path apps/ios/Packages/PlayarrAPI --filter APIClientTests
```

Expected: 14 tests pass.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/APIError.swift apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/APIClient.swift apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/StubProtocol.swift apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/APIClientTests.swift
git commit -F - <<'MSG'
iOS: an API client that signs requests with the account's token and turns error answers into clear errors

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 8: Contract tests: the recorded answers decode

**Files:**
- Modify: `apps/ios/Packages/PlayarrAPI/Package.swift` (the fixtures become test resources)
- Test: `apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/ContractTests.swift`

**Step 1: Write the test**

`apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/ContractTests.swift`:

```swift
import Foundation
import Testing
@testable import PlayarrAPI

/// One recorded server answer and the type the app reads it as.
struct Contract: Sendable, CustomTestStringConvertible {
    let fixture: String
    let decode: @Sendable (Data) throws -> Void

    init<T: Decodable>(_ fixture: String, _ type: T.Type) {
        self.fixture = fixture
        self.decode = { _ = try APIClient.decode(T.self, from: $0) }
    }

    var testDescription: String { fixture }
}

/// Real answers, saved by the server's route tests (`RECORD_FIXTURES=1 corepack pnpm -C apps/server test`),
/// decode into the generated types: a change on either side fails here until the other follows.
@Suite struct ContractTests {
    static let contracts: [Contract] = [
        // Server and accounts
        Contract("server-info", ServerInfo.self),
        Contract("auth-sign-in", SignInResponse.self),
        Contract("auth-me", Account.self),
        Contract("accounts", [Account].self),
        Contract("account-created", CreatedAccount.self),
        Contract("setup-code", SetupCode.self),
        Contract("sessions", [SessionInfo].self),
        Contract("health", HealthStatus.self),
        Contract("musicbrainz-status", MusicBrainzStatus.self),
        // Library and search
        Contract("artists", [Artist].self),
        Contract("artist", ArtistDetail.self),
        Contract("artist-tracks", [Track].self),
        Contract("albums", [Album].self),
        Contract("albums-random", [Album].self),
        Contract("album", AlbumDetail.self),
        Contract("tracks-random", [Track].self),
        Contract("search", SearchResults.self),
        Contract("recent-albums", [Album].self),
        Contract("track-metadata", TrackMetadata.self),
        Contract("lyrics", LyricsAnswer.self),
        // Discover and requests
        Contract("discover-search", DiscoverResults.self),
        Contract("discover-artist", DiscoverArtistDetail.self),
        Contract("discover-similar", [DiscoverArtist].self),
        Contract("artist-lookup", ArtistMatch.self),
        Contract("requests", [AlbumRequest].self),
        Contract("request-created", AlbumRequest.self),
        // Favorites and playlists
        Contract("favorites", [FavoriteTrack].self),
        Contract("playlists", [PlaylistSummary].self),
        Contract("playlist", PlaylistDetail.self),
        Contract("recommendations", Recommendations.self),
        // Settings and analysis
        Contract("settings-sources", SourcesResponse.self),
        Contract("settings-source", SourceInfo.self),
        Contract("folder-access", FolderAccessOptions.self),
        Contract("review-groups", [ReviewGroup].self),
        Contract("matching", MatchingSettings.self),
        Contract("request-settings", RequestSettingsInfo.self),
        Contract("updates", UpdateInfo.self),
        Contract("analysis-progress", AnalysisProgress.self),
        // Playback
        Contract("plays", Recorded.self),
        Contract("levels", [String: TrackLevel].self),
        Contract("transition-ready", TransitionAnswer.self),
        Contract("transition-pending", TransitionAnswer.self),
        Contract("transition-straight", TransitionAnswer.self),
        Contract("transition-unavailable", TransitionAnswer.self),
        Contract("radio", [Track].self),
        Contract("mix-maps", [String: MixMapEntry].self),
        Contract("cues", CuePoints.self),
        // Mixes and stats
        Contract("mixes", [MixSummary].self),
        Contract("mix", MixDetail.self),
        Contract("mix-settings", MixSettingsInfo.self),
        Contract("listenbrainz", ListenBrainzInfo.self),
        Contract("stats", ListeningStats.self),
    ]

    static let fixtures = Bundle.module.url(forResource: "Fixtures", withExtension: nil)

    @Test(arguments: contracts)
    func decodes(_ contract: Contract) throws {
        let folder = try #require(Self.fixtures)
        let data = try Data(contentsOf: folder.appending(path: "\(contract.fixture).json"))
        try contract.decode(data)
    }

    @Test func everyFixtureHasAContract() throws {
        let folder = try #require(Self.fixtures)
        let names = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }
            .map { $0.deletingPathExtension().lastPathComponent }
        #expect(Set(names) == Set(Self.contracts.map(\.fixture)))
    }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --package-path apps/ios/Packages/PlayarrAPI --filter ContractTests
```

Expected: build fails with `type 'Bundle' has no member 'module'`: the test target has no resources yet.

**Step 3: Bundle the fixtures**

In `apps/ios/Packages/PlayarrAPI/Package.swift`, the test target becomes:

```swift
        .testTarget(
            name: "PlayarrAPITests",
            dependencies: ["PlayarrAPI"],
            resources: [.copy("Fixtures")]
        ),
```

**Step 4: Run it to see it pass**

```bash
swift test --package-path apps/ios/Packages/PlayarrAPI --filter ContractTests
```

Expected: all 52 contracts decode, and `everyFixtureHasAContract` passes. If a fixture fails to decode, the error names the key. Either the TypeScript type is wrong (fix it in `packages/`, then run `pnpm ios:models`) or a number the server sends with a fraction got `Int` (remove that name from `INTEGERS` in `gen-models.mjs`, then regenerate). Don't edit the fixture.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrAPI/Package.swift apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/ContractTests.swift
git commit -F - <<'MSG'
iOS: contract tests decode every recorded server answer into the generated models

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---
### Task 9: Media addresses with the token in a header

**Files:**
- Create: `apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/MediaURLs.swift`
- Test: `apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/MediaURLsTests.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/MediaURLsTests.swift`:

```swift
import Foundation
import Testing
@testable import PlayarrAPI

@Suite struct MediaURLsTests {
    let media = MediaURLs(baseURL: URL(string: "https://music.example.com/playarr")!, token: "tok")

    @Test func buildsMediaAddressesOnTheServer() {
        #expect(media.stream(fileId: 9000)?.absoluteString == "https://music.example.com/playarr/stream/9000")
        #expect(media.transition("/transitions/abc.flac")?.absoluteString == "https://music.example.com/playarr/transitions/abc.flac")
        #expect(media.art("/art/album/70/cover", size: 600)?.absoluteString == "https://music.example.com/playarr/art/album/70/cover?size=600")
        #expect(media.art("/art/playlist/3?v=abc", size: 128)?.absoluteString == "https://music.example.com/playarr/art/playlist/3?v=abc&size=128")
        #expect(media.art(nil, size: 128) == nil)
    }

    @Test func levelsASongOnTheServer() {
        let track = Track(id: 700, recordingId: "rec-1", fileId: 9000, albumId: 70, artistId: 7, title: "Angel", artistName: "Massive Attack", albumTitle: "Mezzanine", trackNumber: 1, discNumber: 1, duration: 379, explicit: false, format: AudioFormat(codec: "FLAC", container: "flac", lossless: true), size: 1, streamUrl: "/stream/9000")
        #expect(media.levelled(track, gain: -4.5)?.absoluteString == "https://music.example.com/playarr/stream/9000/levelled.wav?gain=-4.5")
    }

    @Test func putsTheTokenInTheHeaderNeverInTheURL() throws {
        let url = try #require(media.stream(fileId: 1))
        #expect(!url.absoluteString.contains("tok"))
        #expect(media.request(for: url).value(forHTTPHeaderField: "Authorization") == "Bearer tok")
    }

    @Test func keepsTheTokenFromOtherSites() throws {
        let elsewhere = try #require(media.url("https://coverartarchive.org/release/x/front"))
        #expect(media.request(for: elsewhere).value(forHTTPHeaderField: "Authorization") == nil)
    }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --package-path apps/ios/Packages/PlayarrAPI --filter MediaURLsTests
```

Expected: build fails with `cannot find 'MediaURLs' in scope`.

**Step 3: Write `MediaURLs`**

`apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/MediaURLs.swift`:

```swift
import Foundation

/// Addresses of a server's songs, transitions and images. The token never goes in a URL: load them
/// with `request(for:)`, which puts it in the Authorization header (and only for this server).
public struct MediaURLs: Sendable {
    public let baseURL: URL
    private let token: String?

    public init(baseURL: URL, token: String?) {
        self.baseURL = baseURL
        self.token = token
    }

    /// A path the server gave (`Track.streamUrl`, `coverUrl`, a transition's `url`) on this server.
    /// Absolute URLs are returned as they are.
    public func url(_ path: String) -> URL? {
        if path.hasPrefix("http://") || path.hasPrefix("https://") { return URL(string: path) }
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else { return nil }
        let parts = path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        var prefix = components.percentEncodedPath
        if prefix.hasSuffix("/") { prefix.removeLast() }
        components.percentEncodedPath = prefix + String(parts[0])
        components.percentEncodedQuery = parts.count > 1 ? String(parts[1]) : nil
        return components.url
    }

    /// GET /stream/:fileId: the song's own file, with Range support.
    public func stream(fileId: Int) -> URL? { url("/stream/\(fileId)") }

    /// The song's file at a gain (dB), as a WAV levelled on the server: for a seek past what's downloaded.
    public func levelled(_ track: Track, gain: Double) -> URL? { url("\(track.streamUrl)/levelled.wav?gain=\(gain)") }

    /// A rendered transition: the `url` of a ready `TransitionAnswer` (or its `continuationUrl`).
    public func transition(_ path: String) -> URL? { url(path) }

    /// A cover or artist image resized by the server to `size` pixels (the longest side).
    public func art(_ path: String?, size: Int) -> URL? {
        guard let path, let base = url(path), var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return nil }
        components.queryItems = (components.queryItems ?? []) + [URLQueryItem(name: "size", value: String(size))]
        return components.url
    }

    /// A candidate playlist cover for the cover picker.
    public func playlistCoverPreview(playlistId: Int, layout: CoverLayout, variant: Int, size: Int) -> URL? {
        art("/art/playlist/\(playlistId)/preview?layout=\(layout.rawValue)&variant=\(variant)", size: size)
    }

    /// A request for `url` carrying the token, when `url` is on this server.
    public func request(for url: URL) -> URLRequest {
        var request = URLRequest(url: url)
        if let token, isOnServer(url) { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return request
    }

    private func isOnServer(_ url: URL) -> Bool {
        url.scheme == baseURL.scheme && url.host() == baseURL.host() && url.port == baseURL.port
    }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --package-path apps/ios/Packages/PlayarrAPI --filter MediaURLsTests
```

Expected: 4 tests pass.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/MediaURLs.swift apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/MediaURLsTests.swift
git commit -F - <<'MSG'
iOS: song, transition and cover addresses on the server, with the token in a header and never in the URL

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 10: Token storage: the Keychain, and memory for tests

**Files:**
- Create: `apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/SecretStore.swift`, `InMemorySecretStore.swift`, `KeychainSecretStore.swift`
- Test: `apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/KeychainSecretStoreTests.swift`

Tokens are generic passwords under the service `me.tracklistme.playarr`, one per server and account (`<serverId>:<accountId>`). They use `kSecAttrAccessibleAfterFirstUnlock`, so background playback and downloads can read them while the phone is locked. Run on the Mac, `swift test` uses the login keychain; this test passed there without a prompt.

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/KeychainSecretStoreTests.swift`:

```swift
import Foundation
import Testing
@testable import PlayarrAPI

@Suite struct KeychainSecretStoreTests {
    @Test func savesReplacesAndRemovesAToken() throws {
        let store = KeychainSecretStore()
        let key = "test-\(UUID().uuidString):1"
        defer { try? store.removeToken(for: key) }

        #expect(try store.token(for: key) == nil)
        try store.setToken("first", for: key)
        try store.setToken("second", for: key)
        #expect(try store.token(for: key) == "second")
        try store.removeToken(for: key)
        #expect(try store.token(for: key) == nil)
    }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --package-path apps/ios/Packages/PlayarrAPI --filter KeychainSecretStoreTests
```

Expected: build fails with `cannot find 'KeychainSecretStore' in scope`.

**Step 3: Write the stores**

`apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/SecretStore.swift`:

```swift
/// Where session tokens are kept: the Keychain in the app, memory in tests and previews.
public protocol SecretStore: Sendable {
    func token(for key: String) throws -> String?
    func setToken(_ token: String, for key: String) throws
    func removeToken(for key: String) throws
}
```

`apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/InMemorySecretStore.swift`:

```swift
import Synchronization

/// Tokens in memory, for tests and previews.
public final class InMemorySecretStore: SecretStore {
    private let tokens: Mutex<[String: String]>

    public init(_ tokens: [String: String] = [:]) {
        self.tokens = Mutex(tokens)
    }

    public func token(for key: String) throws -> String? {
        tokens.withLock { $0[key] }
    }

    public func setToken(_ token: String, for key: String) throws {
        tokens.withLock { $0[key] = token }
    }

    public func removeToken(for key: String) throws {
        _ = tokens.withLock { $0.removeValue(forKey: key) }
    }
}
```

`apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/KeychainSecretStore.swift`:

```swift
import Foundation
import Security

/// Tokens in the Keychain: generic passwords under the app's bundle id, one per server and account
/// ("<serverId>:<accountId>"), readable after the first unlock so playback and downloads keep working
/// while the phone is locked.
public struct KeychainSecretStore: SecretStore {
    public static let service = "me.tracklistme.playarr"

    public init() {}

    public func token(for key: String) throws -> String? {
        var query = Self.query(key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else { throw KeychainError(status: status) }
        return String(decoding: data, as: UTF8.self)
    }

    public func setToken(_ token: String, for key: String) throws {
        let values: [String: Any] = [
            kSecValueData as String: Data(token.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        let status = SecItemUpdate(Self.query(key) as CFDictionary, values as CFDictionary)
        if status == errSecItemNotFound {
            let added = SecItemAdd(Self.query(key).merging(values) { $1 } as CFDictionary, nil)
            guard added == errSecSuccess else { throw KeychainError(status: added) }
        } else if status != errSecSuccess {
            throw KeychainError(status: status)
        }
    }

    public func removeToken(for key: String) throws {
        let status = SecItemDelete(Self.query(key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
    }

    private static func query(_ key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }
}

public struct KeychainError: Error, Equatable, Sendable {
    public let status: OSStatus
}
```

**Step 4: Run it to see it pass**

```bash
swift test --package-path apps/ios/Packages/PlayarrAPI --filter KeychainSecretStoreTests
```

Expected: 1 test passes. If the Mac keychain is locked in a CI runner and the test fails with status `-25308`, run it on the simulator (`make -C apps/ios test`) instead. Don't weaken the store.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/SecretStore.swift apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/InMemorySecretStore.swift apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/KeychainSecretStore.swift apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/KeychainSecretStoreTests.swift
git commit -F - <<'MSG'
iOS: keep session tokens in the Keychain, readable after first unlock so playback works while locked

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 11: Servers and accounts: the store

`ServerStore` saves the server list (names, addresses, accounts, which is active) as `servers.json` in Application Support, without secrets. Tokens go to the `SecretStore`. It gives one `APIClient` per signed-in account. When the server answers 401, the client calls back and the store marks that account signed out.

**Files:**
- Create: `apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/AccountKey.swift`, `AccountRecord.swift`, `ServerRecord.swift`, `ServerStore.swift`
- Test: `apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/ServerStoreTests.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/ServerStoreTests.swift`:

```swift
import Foundation
import Testing
@testable import PlayarrAPI

@MainActor @Suite struct ServerStoreTests {
    let directory = FileManager.default.temporaryDirectory.appending(path: "playarr-\(UUID().uuidString)")
    let secrets = InMemorySecretStore()
    let home = ServerInfo(id: "srv-1", name: "Home", version: "0.7.0", minAppVersion: "1.0.0", setup: false)
    let homeURL = URL(string: "http://192.168.1.103:4000")!

    func account(_ id: Int, _ name: String) -> Account {
        Account(id: id, username: name.lowercased(), name: name, role: id == 1 ? .admin : .member, canRequest: true, sources: nil, hasPassword: true)
    }

    @Test func keepsTheTokenInTheSecretStoreAndTheRestOnDisk() throws {
        let store = ServerStore(directory: directory, secrets: secrets)
        try store.signedIn(SignInResponse(token: "tok-1", account: account(1, "Nicola")), server: home, at: homeURL)

        #expect(try secrets.token(for: "srv-1:1") == "tok-1")
        let saved = try String(contentsOf: directory.appending(path: "servers.json"), encoding: .utf8)
        #expect(!saved.contains("tok-1"))

        let reopened = ServerStore(directory: directory, secrets: secrets)
        #expect(reopened.servers.map(\.name) == ["Home"])
        #expect(reopened.activeAccount?.account.name == "Nicola")
        #expect(reopened.activeClient != nil)
    }

    @Test func switchesAccountsWithoutAPassword() throws {
        let store = ServerStore(directory: directory, secrets: secrets)
        try store.signedIn(SignInResponse(token: "tok-1", account: account(1, "Nicola")), server: home, at: homeURL)
        try store.signedIn(SignInResponse(token: "tok-2", account: account(2, "Sam")), server: home, at: homeURL)
        #expect(store.activeAccount?.account.name == "Sam")

        store.activate(AccountKey(serverId: "srv-1", accountId: 1))

        #expect(store.activeAccount?.account.name == "Nicola")
        #expect(ServerStore(directory: directory, secrets: secrets).active == AccountKey(serverId: "srv-1", accountId: 1))
    }

    @Test func keepsOneRecordPerServerAndFollowsItsNewAddress() throws {
        let store = ServerStore(directory: directory, secrets: secrets)
        try store.signedIn(SignInResponse(token: "tok-1", account: account(1, "Nicola")), server: home, at: homeURL)
        let moved = URL(string: "https://music.example.com")!

        store.remember(ServerInfo(id: "srv-1", name: "Home NAS", version: "0.7.1", minAppVersion: "1.0.0", setup: false), at: moved)

        #expect(store.servers.count == 1)
        #expect(store.servers[0].name == "Home NAS")
        #expect(store.servers[0].baseURL == moved)
        #expect(store.activeClient?.baseURL == moved)
    }

    @Test func marksAnEndedSessionSignedOut() throws {
        let store = ServerStore(directory: directory, secrets: secrets)
        try store.signedIn(SignInResponse(token: "tok-1", account: account(1, "Nicola")), server: home, at: homeURL)

        store.markSignedOut(AccountKey(serverId: "srv-1", accountId: 1))

        #expect(try secrets.token(for: "srv-1:1") == nil)
        #expect(store.activeAccount?.signedIn == false)
        #expect(store.activeClient == nil)
    }

    @Test func signsOutOnTheServerAndForgetsTheAccount() async throws {
        let host = uniqueHost()
        let session = StubProtocol.session(host: host) { request in
            #expect(request.url?.path() == "/api/auth/sign-out")
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer tok-2")
            return (204, Data())
        }
        let store = ServerStore(directory: directory, secrets: secrets, session: session)
        let url = URL(string: "http://\(host)")!
        try store.signedIn(SignInResponse(token: "tok-1", account: account(1, "Nicola")), server: home, at: url)
        try store.signedIn(SignInResponse(token: "tok-2", account: account(2, "Sam")), server: home, at: url)

        await store.signOut(AccountKey(serverId: "srv-1", accountId: 2))

        #expect(try secrets.token(for: "srv-1:2") == nil)
        #expect(store.servers[0].accounts.map(\.account.name) == ["Nicola"])
        #expect(store.activeAccount?.account.name == "Nicola")
    }

    @Test func forgetsTheServerWithItsLastAccount() async throws {
        let store = ServerStore(directory: directory, secrets: secrets)
        try store.signedIn(SignInResponse(token: "tok-1", account: account(1, "Nicola")), server: home, at: URL(string: "http://\(uniqueHost())")!)

        await store.signOut(AccountKey(serverId: "srv-1", accountId: 1))

        #expect(store.servers.isEmpty)
        #expect(store.active == nil)
    }

    @Test func endsTheSessionWhenTheServerAnswers401() async throws {
        let host = uniqueHost()
        let session = StubProtocol.session(host: host) { _ in (401, json(#"{"error":"Sign in"}"#)) }
        let store = ServerStore(directory: directory, secrets: secrets, session: session)
        try store.signedIn(SignInResponse(token: "tok-1", account: account(1, "Nicola")), server: home, at: URL(string: "http://\(host)")!)

        let client = try #require(store.activeClient)
        await #expect(throws: APIError.unauthorized) { try await client.send(API.Auth.me()) }

        #expect(store.activeAccount?.signedIn == false)
        #expect(try secrets.token(for: "srv-1:1") == nil)
    }

    @Test func startsEmptyFromADamagedFile() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data("not json".utf8).write(to: directory.appending(path: "servers.json"))
        #expect(ServerStore(directory: directory, secrets: secrets).servers.isEmpty)
    }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --package-path apps/ios/Packages/PlayarrAPI --filter ServerStoreTests
```

Expected: build fails with `cannot find 'ServerStore' in scope`.

**Step 3: Write the records and the store**

`apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/AccountKey.swift`:

```swift
/// Which account on which server: how tokens, clients and the active choice are keyed.
public struct AccountKey: Codable, Hashable, Sendable {
    public var serverId: String
    public var accountId: Int

    public init(serverId: String, accountId: Int) {
        self.serverId = serverId
        self.accountId = accountId
    }

    /// The token's Keychain account.
    public var keychainAccount: String { "\(serverId):\(accountId)" }
}
```

`apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/AccountRecord.swift`:

```swift
/// An account the app has signed in to on a server. Its token is in the SecretStore, never here.
public struct AccountRecord: Codable, Hashable, Sendable, Identifiable {
    public var serverId: String
    /// As the server last described it.
    public var account: Account
    /// False once the server ended the session (a 401): the account stays listed, to sign in again.
    public var signedIn: Bool

    public init(serverId: String, account: Account, signedIn: Bool = true) {
        self.serverId = serverId
        self.account = account
        self.signedIn = signedIn
    }

    public var key: AccountKey { AccountKey(serverId: serverId, accountId: account.id) }
    public var id: AccountKey { key }
}
```

`apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/ServerRecord.swift`:

```swift
import Foundation

/// A server the app knows, with the accounts signed in to it. Saved as JSON (no secrets).
public struct ServerRecord: Codable, Hashable, Sendable, Identifiable {
    /// The server's UUID (GET /api/server), stable across addresses.
    public var id: String
    public var name: String
    public var baseURL: URL
    public var accounts: [AccountRecord]

    public init(id: String, name: String, baseURL: URL, accounts: [AccountRecord] = []) {
        self.id = id
        self.name = name
        self.baseURL = baseURL
        self.accounts = accounts
    }
}
```

`apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/ServerStore.swift`:

```swift
import Foundation
import Observation

/// The servers the app knows, their signed-in accounts and which one is active. Servers are saved as
/// JSON in Application Support; tokens are in the SecretStore (the Keychain).
@MainActor @Observable
public final class ServerStore {
    public private(set) var servers: [ServerRecord] = []
    public private(set) var active: AccountKey?

    @ObservationIgnored private let file: URL
    @ObservationIgnored private let secrets: any SecretStore
    @ObservationIgnored private let session: URLSession
    @ObservationIgnored private var clients: [AccountKey: APIClient] = [:]

    public init(directory: URL, secrets: any SecretStore, session: URLSession = .shared) {
        self.file = directory.appending(path: "servers.json")
        self.secrets = secrets
        self.session = session
        if let data = try? Data(contentsOf: file), let saved = try? JSONDecoder().decode(Saved.self, from: data) {
            servers = saved.servers
            active = saved.active
        }
    }

    /// The app's store: Application Support/Playarr/servers.json and the Keychain.
    public static func live() -> ServerStore {
        ServerStore(directory: .applicationSupportDirectory.appending(path: "Playarr", directoryHint: .isDirectory), secrets: KeychainSecretStore())
    }

    public var activeServer: ServerRecord? { active.flatMap { server($0.serverId) } }
    public var activeAccount: AccountRecord? { active.flatMap(account) }
    /// The active account's client; nil when there is none or it is signed out.
    public var activeClient: APIClient? { activeAccount.flatMap(client) }

    public func server(_ id: String) -> ServerRecord? { servers.first { $0.id == id } }

    public func account(_ key: AccountKey) -> AccountRecord? {
        server(key.serverId)?.accounts.first { $0.account.id == key.accountId }
    }

    /// A client for a signed-in account (one per account, kept); nil when signed out.
    public func client(for record: AccountRecord) -> APIClient? {
        let key = record.key
        if let client = clients[key] { return client }
        guard record.signedIn, let server = server(key.serverId), let token = try? secrets.token(for: key.keychainAccount) else { return nil }
        let client = APIClient(baseURL: server.baseURL, token: token, session: session) { [weak self] in
            await self?.markSignedOut(key)
        }
        clients[key] = client
        return client
    }

    /// A client that signs in nobody: GET /api/server and the sign-in calls.
    public func anonymousClient(for baseURL: URL) -> APIClient {
        APIClient(baseURL: baseURL, session: session, timeout: 15)
    }

    /// Media addresses for a signed-in account, with its token for the Authorization header.
    public func mediaURLs(for record: AccountRecord) -> MediaURLs? {
        guard record.signedIn, let server = server(record.serverId), let token = try? secrets.token(for: record.key.keychainAccount) else { return nil }
        return MediaURLs(baseURL: server.baseURL, token: token)
    }

    /// Remembers a server, or its new name and address.
    @discardableResult
    public func remember(_ info: ServerInfo, at baseURL: URL) -> ServerRecord {
        if let index = servers.firstIndex(where: { $0.id == info.id }) {
            if servers[index].baseURL != baseURL { dropClients(serverId: info.id) }
            servers[index].name = info.name
            servers[index].baseURL = baseURL
            save()
            return servers[index]
        }
        let record = ServerRecord(id: info.id, name: info.name, baseURL: baseURL)
        servers.append(record)
        save()
        return record
    }

    /// Keeps a new session (sign-in, setup code or claiming the server) and makes its account active.
    public func signedIn(_ response: SignInResponse, server info: ServerInfo, at baseURL: URL) throws {
        remember(info, at: baseURL)
        let record = AccountRecord(serverId: info.id, account: response.account)
        try secrets.setToken(response.token, for: record.key.keychainAccount)
        clients[record.key] = nil
        update(serverId: info.id) { server in
            if let index = server.accounts.firstIndex(where: { $0.account.id == record.account.id }) {
                server.accounts[index] = record
            } else {
                server.accounts.append(record)
            }
        }
        active = record.key
        save()
    }

    /// Switches to another account: no password, its token is already kept.
    public func activate(_ key: AccountKey) {
        guard account(key) != nil else { return }
        active = key
        save()
    }

    /// The account as the server describes it now (GET /api/auth/me).
    public func update(_ account: Account, on serverId: String) {
        update(serverId: serverId) { server in
            if let index = server.accounts.firstIndex(where: { $0.account.id == account.id }) { server.accounts[index].account = account }
        }
        save()
    }

    /// The server ended the session: forget the token, keep the account listed to sign in again.
    public func markSignedOut(_ key: AccountKey) {
        try? secrets.removeToken(for: key.keychainAccount)
        clients[key] = nil
        update(serverId: key.serverId) { server in
            if let index = server.accounts.firstIndex(where: { $0.account.id == key.accountId }) { server.accounts[index].signedIn = false }
        }
        save()
    }

    /// Signs out on the server (POST /api/auth/sign-out), forgets the token and the account, and the
    /// server too once no account is left. Another signed-in account becomes active, if there is one.
    public func signOut(_ key: AccountKey) async {
        if let record = account(key), let client = client(for: record) {
            _ = try? await client.send(API.Auth.signOut())
        }
        try? secrets.removeToken(for: key.keychainAccount)
        clients[key] = nil
        update(serverId: key.serverId) { server in server.accounts.removeAll { $0.account.id == key.accountId } }
        servers.removeAll { $0.accounts.isEmpty && $0.id == key.serverId }
        if active == key {
            active = servers.lazy.flatMap(\.accounts).first(where: \.signedIn)?.key
        }
        save()
    }

    private func update(serverId: String, _ change: (inout ServerRecord) -> Void) {
        guard let index = servers.firstIndex(where: { $0.id == serverId }) else { return }
        change(&servers[index])
    }

    private func dropClients(serverId: String) {
        clients = clients.filter { $0.key.serverId != serverId }
    }

    private struct Saved: Codable {
        var servers: [ServerRecord]
        var active: AccountKey?
    }

    private func save() {
        do {
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(Saved(servers: servers, active: active)).write(to: file, options: .atomic)
        } catch {
            assertionFailure("Saving the server list failed: \(error)")
        }
    }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --package-path apps/ios/Packages/PlayarrAPI --filter ServerStoreTests
```

Expected: 8 tests pass.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/AccountKey.swift apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/AccountRecord.swift apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/ServerRecord.swift apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/ServerStore.swift apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/ServerStoreTests.swift
git commit -F - <<'MSG'
iOS: remember servers and their signed-in accounts, switch without a password, sign out

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 12: Typed addresses, app versions and setup-code links

**Files:**
- Create: `apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/ServerAddress.swift`, `AppVersion.swift`, `RedeemLink.swift`
- Test: `apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/ServerAddressTests.swift`, `AppVersionTests.swift`, `RedeemLinkTests.swift`

`ServerAddress` lets plain HTTP through only for home-network hosts (localhost, single-label and `.local` names, private and link-local addresses), and adds `https://` to anything else typed without a scheme. That matches App Transport Security's `NSAllowsLocalNetworking` (Task 14). An `http://` address outside the home network is refused with a message, not left to fail in ATS.

**Step 1: Write the failing tests**

`apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/ServerAddressTests.swift`:

```swift
import Foundation
import Testing
@testable import PlayarrAPI

@Suite struct ServerAddressTests {
    @Test(arguments: [
        ("192.168.1.103:4000", "http://192.168.1.103:4000"),
        ("playarr.local:4000/", "http://playarr.local:4000"),
        ("localhost:4000", "http://localhost:4000"),
        ("nas:4000", "http://nas:4000"),
        ("music.example.com", "https://music.example.com"),
        (" https://music.example.com/playarr/ ", "https://music.example.com/playarr"),
        ("http://10.0.0.2:4000", "http://10.0.0.2:4000"),
    ])
    func readsWhatWasTyped(typed: String, url: String) throws {
        #expect(try ServerAddress.url(from: typed).absoluteString == url)
    }

    @Test func wantsHTTPSOutsideTheHomeNetwork() {
        #expect(throws: ServerAddress.Problem.needsHTTPS) { try ServerAddress.url(from: "http://music.example.com") }
        #expect(throws: ServerAddress.Problem.needsHTTPS) { try ServerAddress.url(from: "http://203.0.113.5:4000") }
    }

    @Test func turnsAwayNothingAndNonsense() {
        #expect(throws: ServerAddress.Problem.empty) { try ServerAddress.url(from: "  ") }
        #expect(throws: ServerAddress.Problem.invalid) { try ServerAddress.url(from: "ftp://nas") }
    }
}
```

`apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/AppVersionTests.swift`:

```swift
import Foundation
import Testing
@testable import PlayarrAPI

@Suite struct AppVersionTests {
    @Test func comparesPartByPart() {
        #expect(AppVersion("1.10.0") > AppVersion("1.9.3"))
        #expect(AppVersion("1.0") == AppVersion("1.0.0"))
        #expect(AppVersion("2") > AppVersion("1.99"))
    }

    @Test func knowsWhenTheAppIsTooOld() {
        let server = ServerInfo(id: "s", name: "Home", version: "0.9.0", minAppVersion: "1.2.0", setup: false)
        #expect(!server.supports(AppVersion("1.1.9")))
        #expect(server.supports(AppVersion("1.2.0")))
    }
}
```

`apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/RedeemLinkTests.swift`:

```swift
import Foundation
import Testing
@testable import PlayarrAPI

@Suite struct RedeemLinkTests {
    @Test func readsTheServerAndTheCode() throws {
        let link = try #require(RedeemLink(URL(string: "playarr://redeem?server=https%3A%2F%2Fmusic.example.com&code=K7PQ2MXA")!))
        #expect(link.server.absoluteString == "https://music.example.com")
        #expect(link.code == "K7PQ2MXA")
    }

    @Test func ignoresOtherLinks() {
        #expect(RedeemLink(URL(string: "playarr://redeem?code=K7PQ2MXA")!) == nil)
        #expect(RedeemLink(URL(string: "playarr://album/12")!) == nil)
        #expect(RedeemLink(URL(string: "https://music.example.com/redeem?code=X")!) == nil)
    }
}
```

**Step 2: Run them to see them fail**

```bash
swift test --package-path apps/ios/Packages/PlayarrAPI --filter "ServerAddressTests|AppVersionTests|RedeemLinkTests"
```

Expected: build fails with `cannot find 'ServerAddress' in scope` (and `AppVersion`, `RedeemLink`).

**Step 3: Write them**

`apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/ServerAddress.swift`:

```swift
import Foundation

/// Turns what someone typed into a server's base URL. Plain HTTP is only for the home network
/// (as App Transport Security allows); everything else is HTTPS.
public enum ServerAddress {
    public enum Problem: Error, Equatable, Sendable, LocalizedError {
        case empty
        case invalid
        case needsHTTPS

        public var errorDescription: String? {
            switch self {
            case .empty: "Enter the server’s address."
            case .invalid: "That isn’t a web address."
            case .needsHTTPS: "Use https:// for a server outside your home network."
            }
        }
    }

    public static func url(from text: String) throws(Problem) -> URL {
        var text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw .empty }
        if !text.contains("://") {
            let host = text.split(separator: "/").first.map(String.init) ?? text
            text = (isLocal(host: hostOnly(host)) ? "http://" : "https://") + text
        }
        guard var components = URLComponents(string: text),
              let scheme = components.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = components.host, !host.isEmpty
        else { throw .invalid }
        if scheme == "http", !isLocal(host: host) { throw .needsHTTPS }
        components.scheme = scheme
        components.query = nil
        components.fragment = nil
        while components.path.hasSuffix("/") { components.path.removeLast() }
        guard let url = components.url else { throw .invalid }
        return url
    }

    /// localhost, single-label and .local names, and private, loopback and link-local addresses.
    public static func isLocal(host: String) -> Bool {
        let host = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if host == "localhost" || host.hasSuffix(".local") { return true }
        let octets = host.split(separator: ".").compactMap { UInt8($0) }
        if octets.count == 4 {
            switch (octets[0], octets[1]) {
            case (10, _), (127, _), (192, 168), (169, 254): return true
            case (172, let b): return (16...31).contains(b)
            default: return false
            }
        }
        if host.contains(":") { return host == "::1" || host.hasPrefix("fe80:") || host.hasPrefix("fc") || host.hasPrefix("fd") }
        return !host.contains(".")
    }

    private static func hostOnly(_ hostAndPort: String) -> String {
        if hostAndPort.hasPrefix("[") { return String(hostAndPort.prefix { $0 != "]" }.dropFirst()) }
        return String(hostAndPort.prefix { $0 != ":" })
    }
}
```

`apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/AppVersion.swift`:

```swift
import Foundation

/// A dotted version ("1.2.3"), compared part by part; missing parts count as 0.
public struct AppVersion: Comparable, Sendable, CustomStringConvertible {
    public let parts: [Int]

    public init(_ string: String) {
        parts = string.split(separator: ".").map { Int($0.prefix { $0.isNumber }) ?? 0 }
    }

    /// This app's marketing version.
    public static var current: AppVersion {
        AppVersion(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0")
    }

    public var description: String { parts.map(String.init).joined(separator: ".") }

    public static func < (lhs: AppVersion, rhs: AppVersion) -> Bool {
        let count = max(lhs.parts.count, rhs.parts.count)
        let left = lhs.parts + Array(repeating: 0, count: count - lhs.parts.count)
        let right = rhs.parts + Array(repeating: 0, count: count - rhs.parts.count)
        return left.lexicographicallyPrecedes(right)
    }

    public static func == (lhs: AppVersion, rhs: AppVersion) -> Bool { !(lhs < rhs) && !(rhs < lhs) }
}

extension ServerInfo {
    /// The server works with this version of the app (its minAppVersion is not newer).
    public func supports(_ app: AppVersion) -> Bool { app >= AppVersion(minAppVersion) }
}
```

`apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/RedeemLink.swift`:

```swift
import Foundation

/// A setup code opened from a link: playarr://redeem?server=<origin>&code=<code>.
public struct RedeemLink: Equatable, Sendable, Identifiable {
    public let server: URL
    public let code: String

    public var id: String { "\(server.absoluteString)#\(code)" }

    public init(server: URL, code: String) {
        self.server = server
        self.code = code
    }

    public init?(_ url: URL) {
        guard url.scheme == "playarr", url.host() == "redeem",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              let code = items.first(where: { $0.name == "code" })?.value, !code.isEmpty,
              let origin = items.first(where: { $0.name == "server" })?.value,
              let server = URL(string: origin), server.scheme == "http" || server.scheme == "https", server.host() != nil
        else { return nil }
        self.server = server
        self.code = code
    }
}
```

**Step 4: Run them to see them pass**

```bash
swift test --package-path apps/ios/Packages/PlayarrAPI --filter "ServerAddressTests|AppVersionTests|RedeemLinkTests"
```

Expected: all pass (`readsWhatWasTyped` runs 7 cases).

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/ServerAddress.swift apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/AppVersion.swift apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/RedeemLink.swift apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/ServerAddressTests.swift apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/AppVersionTests.swift apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/RedeemLinkTests.swift
git commit -F - <<'MSG'
iOS: read typed server addresses (HTTPS outside the home network), app versions and setup-code links

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 13: Finding servers on the home network (Bonjour)

**Files:**
- Create: `apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/DiscoveredServer.swift`, `ServerBrowser.swift`
- Test: `apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/DiscoveredServerTests.swift`

The TXT record parsing and the dedupe-by-id are pure functions on `DiscoveredServer` and are tested. `ServerBrowser` is the NWBrowser glue: it browses `_playarr._tcp` with TXT records and resolves each service to an IPv4 address and port by connecting to it (5 s limit). It is checked by hand in Task 18.

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/DiscoveredServerTests.swift`:

```swift
import Foundation
import Testing
@testable import PlayarrAPI

@Suite struct DiscoveredServerTests {
    @Test func readsTheTXTRecord() throws {
        let server = try #require(DiscoveredServer(txt: ["id": "srv-1", "v": "0.7.0", "name": "Home", "path": "/"], host: "192.168.1.103", port: 4000))
        #expect(server == DiscoveredServer(id: "srv-1", name: "Home", version: "0.7.0", baseURL: URL(string: "http://192.168.1.103:4000")!))
    }

    @Test func needsAnId() {
        #expect(DiscoveredServer(txt: ["name": "Home"], host: "192.168.1.103", port: 4000) == nil)
    }

    @Test func bracketsAnIPv6Address() throws {
        let server = try #require(DiscoveredServer(txt: ["id": "srv-1"], host: "fe80::1%en0", port: 4000))
        #expect(server.baseURL.absoluteString == "http://[fe80::1%25en0]:4000")
        #expect(server.name == "Playarr")
    }

    @Test func keepsOneEntryPerServer() {
        let a = DiscoveredServer(id: "srv-1", name: "Home", version: "0.7.0", baseURL: URL(string: "http://192.168.1.103:4000")!)
        let b = DiscoveredServer(id: "srv-1", name: "Home", version: "0.7.0", baseURL: URL(string: "http://192.168.1.104:4000")!)
        let c = DiscoveredServer(id: "srv-2", name: "Attic", version: "0.7.0", baseURL: URL(string: "http://192.168.1.20:4000")!)
        #expect(DiscoveredServer.merge(DiscoveredServer.merge([a], c), b) == [c, b])
    }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --package-path apps/ios/Packages/PlayarrAPI --filter DiscoveredServerTests
```

Expected: build fails with `cannot find 'DiscoveredServer' in scope`.

**Step 3: Write them**

`apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/DiscoveredServer.swift`:

```swift
import Foundation

/// A Playarr server found on the home network by Bonjour (`_playarr._tcp`).
public struct DiscoveredServer: Hashable, Sendable, Identifiable {
    /// The server's UUID (TXT `id`), the same as GET /api/server's.
    public var id: String
    public var name: String
    public var version: String
    public var baseURL: URL

    public init(id: String, name: String, version: String, baseURL: URL) {
        self.id = id
        self.name = name
        self.version = version
        self.baseURL = baseURL
    }

    /// From the service's TXT record (`id`, `v`, `name`, `path`) and resolved address; nil without an id.
    public init?(txt: [String: String], host: String, port: Int) {
        guard let id = txt["id"], !id.isEmpty else { return nil }
        let bracketed = host.contains(":") ? "[\(host.replacingOccurrences(of: "%", with: "%25"))]" : host
        var path = txt["path"] ?? "/"
        while path.hasSuffix("/") { path.removeLast() }
        guard let url = URL(string: "http://\(bracketed):\(port)\(path)") else { return nil }
        self.init(id: id, name: txt["name"].flatMap { $0.isEmpty ? nil : $0 } ?? "Playarr", version: txt["v"] ?? "", baseURL: url)
    }

    /// `servers` with `server` added, one entry per server id (the newest address wins), sorted by name.
    public static func merge(_ servers: [DiscoveredServer], _ server: DiscoveredServer) -> [DiscoveredServer] {
        (servers.filter { $0.id != server.id } + [server]).sorted {
            $0.name.localizedStandardCompare($1.name) == .orderedAscending
        }
    }
}
```

`apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/ServerBrowser.swift`:

```swift
import Foundation
import Network
import Observation
import Synchronization

/// Finds Playarr servers on the home network: browses `_playarr._tcp`, reads each TXT record and
/// resolves its address (IPv4). Starting it shows the Local Network permission prompt.
@MainActor @Observable
public final class ServerBrowser {
    public private(set) var servers: [DiscoveredServer] = []

    @ObservationIgnored private var browser: NWBrowser?

    public init() {}

    public func start() {
        guard browser == nil else { return }
        let browser = NWBrowser(for: .bonjourWithTXTRecord(type: "_playarr._tcp", domain: nil), using: NWParameters())
        browser.browseResultsChangedHandler = { [weak self] results, _ in
            let services = results.compactMap { result -> (NWEndpoint, [String: String])? in
                guard case .bonjour(let record) = result.metadata else { return nil }
                return (result.endpoint, record.dictionary)
            }
            Task { @MainActor in await self?.update(services) }
        }
        browser.start(queue: .main)
        self.browser = browser
    }

    public func stop() {
        browser?.cancel()
        browser = nil
        servers = []
    }

    private func update(_ services: [(NWEndpoint, [String: String])]) async {
        var found: [DiscoveredServer] = []
        for (endpoint, txt) in services {
            guard let (host, port) = await Self.resolve(endpoint),
                  let server = DiscoveredServer(txt: txt, host: host, port: port)
            else { continue }
            found = DiscoveredServer.merge(found, server)
        }
        servers = found
    }

    /// The service's IPv4 address and port, by connecting to it; nil after 5 s.
    nonisolated static func resolve(_ endpoint: NWEndpoint) async -> (String, Int)? {
        let parameters = NWParameters.tcp
        if let ip = parameters.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options { ip.version = .v4 }
        let connection = NWConnection(to: endpoint, using: parameters)
        let result = await withCheckedContinuation { (continuation: CheckedContinuation<(String, Int)?, Never>) in
            let once = ResumeOnce(continuation)
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    if case .hostPort(let host, let port) = connection.currentPath?.remoteEndpoint, let address = Self.address(host) {
                        once.resume((address, Int(port.rawValue)))
                    } else {
                        once.resume(nil)
                    }
                case .failed, .cancelled, .waiting:
                    once.resume(nil)
                default:
                    break
                }
            }
            connection.start(queue: .global())
            DispatchQueue.global().asyncAfter(deadline: .now() + 5) { once.resume(nil) }
        }
        connection.cancel()
        return result
    }

    nonisolated private static func address(_ host: NWEndpoint.Host) -> String? {
        switch host {
        case .ipv4(let address): "\(address)"
        case .ipv6(let address): "\(address)"
        case .name(let name, _): name
        @unknown default: nil
        }
    }
}

/// Resumes a continuation once, whichever callback comes first.
private final class ResumeOnce<T: Sendable>: Sendable {
    private let continuation: Mutex<CheckedContinuation<T, Never>?>

    init(_ continuation: CheckedContinuation<T, Never>) {
        self.continuation = Mutex(continuation)
    }

    func resume(_ value: T) {
        continuation.withLock { $0.take() }?.resume(returning: value)
    }
}
```

**Step 4: Run the whole package**

```bash
swift test --package-path apps/ios/Packages/PlayarrAPI
```

Expected: every suite passes (11 suites).

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/DiscoveredServer.swift apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/ServerBrowser.swift apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/DiscoveredServerTests.swift
git commit -F - <<'MSG'
iOS: find Playarr servers on the home network by Bonjour, one entry per server

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---
### Task 14: App settings: local network, Bonjour, plain HTTP at home, the playarr:// scheme

**Files:**
- Modify: `apps/ios/project.yml`
- Regenerated (by XcodeGen, committed if phase 0 commits it): `apps/ios/Config/Info.plist`

**Step 1: Check what's missing**

```bash
make -C apps/ios bootstrap
plutil -extract NSBonjourServices json -o - apps/ios/Config/Info.plist
```

Expected: `error: No value at that key path or invalid key path: NSBonjourServices`.

**Step 2: Add the keys**

In `apps/ios/project.yml`, under `targets: Playarr: info: properties:`, add these (keep phase 0's keys):

```yaml
        NSLocalNetworkUsageDescription: Playarr looks for your music servers on this network.
        NSBonjourServices:
          - _playarr._tcp
        NSAppTransportSecurity:
          NSAllowsLocalNetworking: true
        CFBundleURLTypes:
          - CFBundleURLName: me.tracklistme.playarr
            CFBundleURLSchemes:
              - playarr
```

- `NSBonjourServices` lets NWBrowser browse `_playarr._tcp`. Without it, browsing fails silently on iOS. `NSLocalNetworkUsageDescription` is the text of the Local Network prompt.
- `NSAllowsLocalNetworking` allows plain HTTP to local addresses only. Everything else stays HTTPS (no `NSAllowsArbitraryLoads`).
- The URL scheme opens `playarr://redeem?server=…&code=…` links in the app.

If phase 0 keeps a hand-written `Config/Info.plist` instead of `info.properties`, add the same keys there as plist XML.

**Step 3: Regenerate and check**

```bash
make -C apps/ios bootstrap
plutil -extract NSBonjourServices json -o - apps/ios/Config/Info.plist
plutil -extract NSAppTransportSecurity json -o - apps/ios/Config/Info.plist
plutil -extract CFBundleURLTypes.0.CFBundleURLSchemes json -o - apps/ios/Config/Info.plist
make -C apps/ios build
```

Expected: `["_playarr._tcp"]`, `{"NSAllowsLocalNetworking":true}`, `["playarr"]`, and the build succeeds.

**Step 4: Commit**

```bash
git add apps/ios/project.yml
git ls-files --error-unmatch apps/ios/Config/Info.plist >/dev/null 2>&1 && git add apps/ios/Config/Info.plist
git commit -F - <<'MSG'
iOS: ask for the local network, browse for Playarr servers, plain HTTP only at home, open playarr:// links

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 15: Sign-in state: the app model and adding a server

`AppModel` is the root state the conventions place in `PlayarrUI`. This phase starts it with what sign-in needs: the store, the Bonjour browser, the app version, a setup-code link to open, and "too old for this server". Later phases add to it. `AddServerModel` drives one add-a-server or add-an-account flow: connect (probe `GET /api/server`), then sign in, redeem a code, or claim a server in setup mode.

**Files:**
- Modify: `apps/ios/Packages/PlayarrUI/Package.swift` (depend on `PlayarrAPI` directly)
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/AppModel.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/SignIn/AddServerModel.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/AddServerModelTests.swift`
- Delete: phase 0's placeholder source and test in `PlayarrUI`, if any (as in Task 2)

**Step 1: The package depends on PlayarrAPI**

Replace `apps/ios/Packages/PlayarrUI/Package.swift` with (keep any other dependency phase 0 added):

```swift
// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "PlayarrUI",
    platforms: [.iOS(.v26), .macOS(.v26)],
    products: [
        .library(name: "PlayarrUI", targets: ["PlayarrUI"]),
    ],
    dependencies: [
        .package(path: "../PlayarrPlayer"),
        .package(path: "../PlayarrAPI"),
    ],
    targets: [
        .target(
            name: "PlayarrUI",
            dependencies: [
                .product(name: "PlayarrPlayer", package: "PlayarrPlayer"),
                .product(name: "PlayarrAPI", package: "PlayarrAPI"),
            ]
        ),
        .testTarget(name: "PlayarrUITests", dependencies: ["PlayarrUI"]),
    ]
)
```

**Step 2: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/AddServerModelTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Synchronization
import Testing
@testable import PlayarrUI

/// Answers every request from one handler (each test has its own session and host).
final class FakeServer: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) -> (Int, String)
    private static let handlers = Mutex<[String: Handler]>([:])

    static func session(host: String, _ handler: @escaping Handler) -> URLSession {
        handlers.withLock { $0[host] = handler }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FakeServer.self]
        return URLSession(configuration: configuration)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        let url = request.url!
        let (status, body) = Self.handlers.withLock { $0[url.host() ?? ""] }!(request)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}

@MainActor @Suite struct AddServerModelTests {
    let host = "test-\(UUID().uuidString.lowercased()).invalid"

    func app(setup: Bool = false, minAppVersion: String = "1.0.0") -> AppModel {
        let session = FakeServer.session(host: host) { request in
            switch request.url?.path() {
            case "/api/server": (200, #"{"id":"srv-1","name":"Home","version":"0.7.0","minAppVersion":"\#(minAppVersion)","setup":\#(setup)}"#)
            case "/api/auth/sign-in": (200, #"{"token":"tok","account":{"id":2,"username":"sam","name":"Sam","role":"member","canRequest":false,"sources":null,"hasPassword":true}}"#)
            default: (404, #"{"error":"Not found"}"#)
            }
        }
        let directory = FileManager.default.temporaryDirectory.appending(path: "playarr-\(UUID().uuidString)")
        let store = ServerStore(directory: directory, secrets: InMemorySecretStore(), session: session)
        return AppModel(store: store, browser: ServerBrowser(), appVersion: AppVersion("1.0.0"), device: DeviceInfo(name: "Test", platform: "ios"))
    }

    @Test func goesToSignInForAServerInUse() async {
        let model = AddServerModel(app: app())
        #expect(await model.connect(to: URL(string: "http://\(host)")!))
        #expect(model.nextStep == .signIn)
    }

    @Test func goesToSetupForAServerNoOneOwns() async {
        let model = AddServerModel(app: app(setup: true))
        await model.connect(to: URL(string: "http://\(host)")!)
        #expect(model.nextStep == .setup)
    }

    @Test func asksForAnUpdateWhenTheAppIsTooOld() async {
        let model = AddServerModel(app: app(minAppVersion: "2.0.0"))
        await model.connect(to: URL(string: "http://\(host)")!)
        #expect(model.nextStep == .tooOld)
    }

    @Test func explainsAnAddressThatIsntHTTPS() async {
        let model = AddServerModel(app: app())
        model.address = "http://music.example.com"
        #expect(await model.connect() == false)
        #expect(model.error == "Use https:// for a server outside your home network.")
    }

    @Test func signsInAndMakesTheAccountActive() async {
        let app = app()
        let model = AddServerModel(app: app)
        await model.connect(to: URL(string: "http://\(host)")!)
        #expect(await model.signIn(username: " sam ", password: "secret"))
        #expect(app.store.activeAccount?.account.name == "Sam")
        #expect(app.store.activeServer?.name == "Home")
    }
}
```

**Step 3: Run it to see it fail**

```bash
swift test --package-path apps/ios/Packages/PlayarrUI --filter AddServerModelTests
```

Expected: build fails with `cannot find 'AppModel' in scope`.

**Step 4: Write the models**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/AppModel.swift`:

```swift
import Foundation
import Observation
import PlayarrAPI

/// The app's root state: the servers and accounts, Bonjour, and what the root view shows.
@MainActor @Observable
public final class AppModel {
    public let store: ServerStore
    public let browser: ServerBrowser
    public let appVersion: AppVersion
    public let device: DeviceInfo
    /// The active server needs a newer app.
    public private(set) var tooOld: ServerInfo?
    /// A setup-code link to open (playarr://redeem).
    public var redeemLink: RedeemLink?
    public var showingAccounts = false

    public init(store: ServerStore, browser: ServerBrowser, appVersion: AppVersion, device: DeviceInfo) {
        self.store = store
        self.browser = browser
        self.appVersion = appVersion
        self.device = device
    }

    public static func live() -> AppModel {
        AppModel(store: .live(), browser: ServerBrowser(), appVersion: .current, device: .current())
    }

    /// playarr:// links: redeem a setup code.
    public func open(_ url: URL) {
        if let link = RedeemLink(url) { redeemLink = link }
    }

    /// Asks the active server who it is: its name may have changed, or it may need a newer app.
    public func checkActiveServer() async {
        guard let server = store.activeServer else { return }
        guard let info = try? await store.anonymousClient(for: server.baseURL).send(API.Server.info()), info.id == server.id else { return }
        store.remember(info, at: server.baseURL)
        tooOld = info.supports(appVersion) ? nil : info
    }

    /// Someone came through a server's checks: it is new enough.
    func connected(to info: ServerInfo) {
        if info.supports(appVersion), tooOld?.id == info.id { tooOld = nil }
    }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/SignIn/AddServerModel.swift`:

```swift
import Foundation
import Observation
import PlayarrAPI

/// Adding a server and signing in to it: by address or Bonjour, then sign-in, a setup code, or
/// claiming a server in setup mode.
@MainActor @Observable
public final class AddServerModel {
    public enum Step: Hashable, Sendable {
        case signIn, redeem, setup, tooOld
    }

    public struct Connected: Equatable, Sendable {
        public let info: ServerInfo
        public let url: URL
    }

    public var address = ""
    public private(set) var connected: Connected?
    public private(set) var busy = false
    public var error: String?

    @ObservationIgnored private let app: AppModel

    public init(app: AppModel) {
        self.app = app
    }

    /// The servers Bonjour found, and whether each is already added.
    public var discovered: [DiscoveredServer] { app.browser.servers }
    public func isAdded(_ server: DiscoveredServer) -> Bool { app.store.server(server.id) != nil }

    /// Where to go once connected.
    public var nextStep: Step? {
        guard let connected else { return nil }
        if !connected.info.supports(app.appVersion) { return .tooOld }
        return connected.info.setup ? .setup : .signIn
    }

    public var appVersion: AppVersion { app.appVersion }

    /// Connects to what was typed in the address field.
    @discardableResult
    public func connect() async -> Bool {
        do {
            return await connect(to: try ServerAddress.url(from: address))
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }

    /// Asks the server who it is (GET /api/server).
    @discardableResult
    public func connect(to url: URL) async -> Bool {
        busy = true
        error = nil
        defer { busy = false }
        do {
            let info = try await app.store.anonymousClient(for: url).send(API.Server.info())
            connected = Connected(info: info, url: url)
            app.connected(to: info)
            return true
        } catch APIError.decoding, APIError.server(404, _) {
            error = "That address doesn’t answer like a Playarr server."
        } catch {
            self.error = error.localizedDescription
        }
        return false
    }

    public func signIn(username: String, password: String) async -> Bool {
        await finish(API.Auth.signIn(username: username.trimmingCharacters(in: .whitespaces), password: password, device: app.device))
    }

    public func redeem(code: String, password: String) async -> Bool {
        await finish(API.Auth.redeem(code: code.trimmingCharacters(in: .whitespaces).uppercased(), password: password, device: app.device))
    }

    public func claim(username: String, name: String, password: String) async -> Bool {
        await finish(API.Auth.setup(username: username.trimmingCharacters(in: .whitespaces), name: name.trimmingCharacters(in: .whitespaces), password: password, device: app.device))
    }

    private func finish(_ endpoint: Endpoint<SignInResponse>) async -> Bool {
        guard let connected else { return false }
        busy = true
        error = nil
        defer { busy = false }
        do {
            let response = try await app.store.anonymousClient(for: connected.url).send(endpoint)
            try app.store.signedIn(response, server: connected.info, at: connected.url)
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }
}
```

**Step 5: Run it to see it pass**

```bash
swift test --package-path apps/ios/Packages/PlayarrUI --filter AddServerModelTests
```

Expected: 5 tests pass.

**Step 6: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Package.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/AppModel.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/SignIn/AddServerModel.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/AddServerModelTests.swift
git add -u apps/ios/Packages/PlayarrUI
git commit -F - <<'MSG'
iOS: the app's root state and the add-a-server flow: connect, sign in, redeem a code or claim the server

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 16: The sign-in screens, the account switcher and a signed-in home

These are minimal screens for this phase, in the web's words. If phase 1's web sign-in page or account switcher words something differently (labels, errors), use the web's words.

- **Add a server**: servers found on the network (tap to connect; "Added" when already known) and an address field.
- **Sign in to <server>**: username and password, and "I have a setup code".
- **Set your password**: setup code (pre-filled from a `playarr://redeem` link), password and confirmation.
- **Set up <server>**: claim the owner account of a server in setup mode (home network only; the server says so otherwise).
- **Update Playarr**: when `minAppVersion` is newer than the app.
- **Signed-in home**: "Signed in as X on Y" and the library counts from `GET /api/health`, with an Accounts button.
- **Accounts sheet**: servers with their accounts. Tap to switch, "Add account", swipe or long-press to sign out, "Add a server". An account whose session ended shows "Signed out", and tapping it leads to its sign-in.

**Files:**
- Create in `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/`: `RootView.swift`, `SignedInHomeView.swift`, `AccountSwitcherView.swift`, `SignIn/AddServerFlow.swift`, `SignIn/WelcomeView.swift`, `SignIn/SignInView.swift`, `SignIn/RedeemView.swift`, `SignIn/SetupView.swift`, `SignIn/UpdateRequiredView.swift`, `SignIn/TextFields.swift`
- Modify: `apps/ios/Playarr/PlayarrApp.swift`

SwiftUI screens get no unit tests here: the flows behind them are `AddServerModel` (Task 15) and `ServerStore` (Task 11). The check is that the package builds for the Mac and the iPhone simulator, plus the walk-through in Task 18.

**Step 1: Write the views**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/RootView.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// What the app shows: adding a server, signing in again, an update, or the signed-in app.
public struct RootView: View {
    @Bindable var model: AppModel

    public init(model: AppModel) {
        self.model = model
    }

    public var body: some View {
        content
            .sheet(item: $model.redeemLink) { link in
                AddServerFlow(app: model, start: .redeem(link)) { model.redeemLink = nil }
            }
            .task(id: model.store.active) { await model.checkActiveServer() }
    }

    @ViewBuilder private var content: some View {
        if let info = model.tooOld {
            UpdateRequiredView(serverName: info.name, minAppVersion: info.minAppVersion, appVersion: model.appVersion.description)
        } else if let server = model.store.activeServer, let account = model.store.activeAccount {
            if account.signedIn {
                SignedInHomeView(model: model)
            } else {
                AddServerFlow(app: model, start: .server(server.baseURL, username: account.account.username))
                    .id(account.key)
            }
        } else {
            AddServerFlow(app: model)
                .onAppear { model.browser.start() }
                .onDisappear { model.browser.stop() }
        }
    }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/SignIn/AddServerFlow.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// Adding a server or an account: from the address screen, or straight to a known server's sign-in
/// (an account signed out, Add account) or to a setup code from a link.
public struct AddServerFlow: View {
    public enum Start: Equatable, Sendable {
        case address
        case server(URL, username: String?)
        case redeem(RedeemLink)
    }

    @State private var model: AddServerModel
    @State private var path: [AddServerModel.Step] = []
    private let start: Start
    private let onDone: () -> Void

    public init(app: AppModel, start: Start = .address, onDone: @escaping () -> Void = {}) {
        _model = State(initialValue: AddServerModel(app: app))
        self.start = start
        self.onDone = onDone
    }

    public var body: some View {
        NavigationStack(path: $path) {
            root
                .navigationDestination(for: AddServerModel.Step.self) { step in screen(step) }
        }
    }

    @ViewBuilder private var root: some View {
        switch start {
        case .address:
            WelcomeView(model: model) { if let step = model.nextStep { path.append(step) } }
        case .server(let url, let username):
            connecting(to: url) { step in
                if step == .signIn {
                    SignInView(model: model, username: username ?? "", onDone: onDone) { path.append(.redeem) }
                } else {
                    screen(step)
                }
            }
        case .redeem(let link):
            connecting(to: link.server) { step in
                if step == .tooOld { screen(step) } else { RedeemView(model: model, code: link.code, onDone: onDone) }
            }
        }
    }

    private func connecting<Content: View>(to url: URL, @ViewBuilder then content: @escaping (AddServerModel.Step) -> Content) -> some View {
        Group {
            if let step = model.nextStep {
                content(step)
            } else if let error = model.error {
                ContentUnavailableView {
                    Label("Can’t connect", systemImage: "wifi.exclamationmark")
                } description: {
                    Text(error)
                } actions: {
                    Button("Try again") { Task { await model.connect(to: url) } }
                }
            } else {
                ProgressView("Connecting…")
            }
        }
        .task { if model.connected == nil { await model.connect(to: url) } }
    }

    @ViewBuilder private func screen(_ step: AddServerModel.Step) -> some View {
        switch step {
        case .signIn: SignInView(model: model, username: "", onDone: onDone) { path.append(.redeem) }
        case .redeem: RedeemView(model: model, code: "", onDone: onDone)
        case .setup: SetupView(model: model, onDone: onDone)
        case .tooOld: UpdateRequiredView(serverName: model.connected?.info.name ?? "This server", minAppVersion: model.connected?.info.minAppVersion ?? "", appVersion: model.appVersion.description)
        }
    }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/SignIn/WelcomeView.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// Add a server: the ones Bonjour finds on the home network, or an address.
struct WelcomeView: View {
    @Bindable var model: AddServerModel
    let onConnected: () -> Void

    var body: some View {
        Form {
            Section {
                if model.discovered.isEmpty {
                    Label("Looking for servers on your network…", systemImage: "antenna.radiowaves.left.and.right")
                        .foregroundStyle(.secondary)
                }
                ForEach(model.discovered) { server in
                    Button {
                        Task { if await model.connect(to: server.baseURL) { onConnected() } }
                    } label: {
                        LabeledContent(server.name, value: model.isAdded(server) ? "Added" : server.baseURL.host() ?? "")
                    }
                    .disabled(model.busy)
                }
            } header: {
                Text("On your network")
            }

            Section {
                TextField("Server address", text: $model.address, prompt: Text("https://music.example.com"))
                    .playarrAddressField()
                    .onSubmit(connect)
                Button("Connect", action: connect)
                    .disabled(model.busy || model.address.trimmingCharacters(in: .whitespaces).isEmpty)
            } header: {
                Text("Or type its address")
            } footer: {
                if let error = model.error { Text(error).foregroundStyle(.red) }
            }
        }
        .navigationTitle("Add a server")
        .overlay { if model.busy { ProgressView() } }
    }

    private func connect() {
        Task { if await model.connect() { onConnected() } }
    }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/SignIn/SignInView.swift`:

```swift
import SwiftUI

/// Sign in to a server with a username and password.
struct SignInView: View {
    @Bindable var model: AddServerModel
    @State var username: String
    @State private var password = ""
    let onDone: () -> Void
    var onSetupCode: (() -> Void)?

    init(model: AddServerModel, username: String, onDone: @escaping () -> Void, onSetupCode: (() -> Void)? = nil) {
        self.model = model
        _username = State(initialValue: username)
        self.onDone = onDone
        self.onSetupCode = onSetupCode
    }

    var body: some View {
        Form {
            Section {
                TextField("Username", text: $username).playarrUsernameField()
                SecureField("Password", text: $password).playarrPasswordField(new: false)
            } footer: {
                if let error = model.error { Text(error).foregroundStyle(.red) }
            }
            Section {
                Button("Sign in") { Task { if await model.signIn(username: username, password: password) { onDone() } } }
                    .disabled(model.busy || username.isEmpty || password.isEmpty)
                if let onSetupCode {
                    Button("I have a setup code", action: onSetupCode)
                }
            }
        }
        .navigationTitle("Sign in to \(model.connected?.info.name ?? "Playarr")")
    }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/SignIn/RedeemView.swift`:

```swift
import SwiftUI

/// A setup code from an admin, and the account's first password.
struct RedeemView: View {
    @Bindable var model: AddServerModel
    @State var code: String
    @State private var password = ""
    @State private var confirm = ""
    let onDone: () -> Void

    init(model: AddServerModel, code: String, onDone: @escaping () -> Void) {
        self.model = model
        _code = State(initialValue: code)
        self.onDone = onDone
    }

    var body: some View {
        Form {
            Section {
                TextField("Setup code", text: $code).playarrCodeField()
                SecureField("Password", text: $password).playarrPasswordField(new: true)
                SecureField("Confirm password", text: $confirm).playarrPasswordField(new: true)
            } footer: {
                if !confirm.isEmpty, confirm != password {
                    Text("The passwords don’t match.").foregroundStyle(.red)
                } else if let error = model.error {
                    Text(error).foregroundStyle(.red)
                }
            }
            Button("Set password and sign in") { Task { if await model.redeem(code: code, password: password) { onDone() } } }
                .disabled(model.busy || code.isEmpty || password.isEmpty || password != confirm)
        }
        .navigationTitle("Set your password")
    }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/SignIn/SetupView.swift`:

```swift
import SwiftUI

/// A server no one has claimed yet: its owner chooses a username and password (home network only).
struct SetupView: View {
    @Bindable var model: AddServerModel
    @State private var username = ""
    @State private var name = ""
    @State private var password = ""
    @State private var confirm = ""
    let onDone: () -> Void

    var body: some View {
        Form {
            Section {
                Text("No one owns this server yet. Choose the owner’s username and password: the owner changes settings and adds accounts.")
                    .foregroundStyle(.secondary)
            }
            Section {
                TextField("Username", text: $username).playarrUsernameField()
                TextField("Your name", text: $name)
                SecureField("Password", text: $password).playarrPasswordField(new: true)
                SecureField("Confirm password", text: $confirm).playarrPasswordField(new: true)
            } footer: {
                if !confirm.isEmpty, confirm != password {
                    Text("The passwords don’t match.").foregroundStyle(.red)
                } else if let error = model.error {
                    Text(error).foregroundStyle(.red)
                }
            }
            Button("Claim this server") { Task { if await model.claim(username: username, name: name, password: password) { onDone() } } }
                .disabled(model.busy || username.isEmpty || name.isEmpty || password.isEmpty || password != confirm)
        }
        .navigationTitle("Set up \(model.connected?.info.name ?? "Playarr")")
    }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/SignIn/UpdateRequiredView.swift`:

```swift
import SwiftUI

/// The server needs a newer version of the app.
public struct UpdateRequiredView: View {
    let serverName: String
    let minAppVersion: String
    let appVersion: String

    public init(serverName: String, minAppVersion: String, appVersion: String) {
        self.serverName = serverName
        self.minAppVersion = minAppVersion
        self.appVersion = appVersion
    }

    public var body: some View {
        ContentUnavailableView {
            Label("Update Playarr", systemImage: "arrow.down.app")
        } description: {
            Text("\(serverName) needs Playarr \(minAppVersion) or later. This is \(appVersion): update it from the App Store or TestFlight.")
        }
    }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/SignIn/TextFields.swift`:

```swift
import SwiftUI

extension View {
    /// What each kind of field wants from the keyboard (iOS only; nothing on the Mac).
    func playarrAddressField() -> some View {
        #if os(iOS)
        textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL).textContentType(.URL)
        #else
        autocorrectionDisabled()
        #endif
    }

    func playarrUsernameField() -> some View {
        #if os(iOS)
        textInputAutocapitalization(.never).autocorrectionDisabled().textContentType(.username)
        #else
        autocorrectionDisabled()
        #endif
    }

    func playarrPasswordField(new: Bool) -> some View {
        #if os(iOS)
        textContentType(new ? .newPassword : .password)
        #else
        self
        #endif
    }

    func playarrCodeField() -> some View {
        #if os(iOS)
        textInputAutocapitalization(.characters).autocorrectionDisabled().textContentType(.oneTimeCode)
        #else
        autocorrectionDisabled()
        #endif
    }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/SignedInHomeView.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// Phase 2's home: who is signed in where, and the library's size (GET /api/health).
struct SignedInHomeView: View {
    @Bindable var model: AppModel
    @State private var stats: LibraryStats?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 12) {
                if let account = model.store.activeAccount, let server = model.store.activeServer {
                    Text("Signed in as \(account.account.name) on \(server.name)").font(.headline)
                }
                if let stats {
                    Text("\(stats.artists) artists · \(stats.albums) albums · \(stats.tracks) songs").foregroundStyle(.secondary)
                } else if let error {
                    Text(error).foregroundStyle(.red)
                } else {
                    ProgressView()
                }
            }
            .padding()
            .navigationTitle("Playarr")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button("Accounts", systemImage: "person.crop.circle") { model.showingAccounts = true }
                }
            }
            .sheet(isPresented: $model.showingAccounts) { AccountSwitcherView(model: model) }
            .task(id: model.store.active) { await load() }
        }
    }

    private func load() async {
        stats = nil
        error = nil
        guard let client = model.store.activeClient else { return }
        do {
            stats = try await client.send(API.Server.health()).library
        } catch {
            self.error = error.localizedDescription
        }
    }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/AccountSwitcherView.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// Every server and its accounts: switch with a tap (no password), add an account or a server, sign out.
struct AccountSwitcherView: View {
    @Bindable var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var adding: AddServerFlow.Start?

    var body: some View {
        NavigationStack {
            List {
                ForEach(model.store.servers) { server in
                    Section(server.name) {
                        ForEach(server.accounts) { record in
                            Button {
                                model.store.activate(record.key)
                                dismiss()
                            } label: {
                                HStack {
                                    VStack(alignment: .leading) {
                                        Text(record.account.name)
                                        Text(record.signedIn ? "@\(record.account.username)" : "Signed out").font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    if record.key == model.store.active { Image(systemName: "checkmark") }
                                }
                            }
                            .swipeActions {
                                Button("Sign out", role: .destructive) { Task { await model.store.signOut(record.key) } }
                            }
                            .contextMenu {
                                Button("Sign out", role: .destructive) { Task { await model.store.signOut(record.key) } }
                            }
                        }
                        Button("Add account") { adding = .server(server.baseURL, username: nil) }
                    }
                }
                Section {
                    Button("Add a server") { adding = .address }
                }
            }
            .navigationTitle("Accounts")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .sheet(item: $adding) { start in
                AddServerFlow(app: model, start: start) {
                    adding = nil
                    dismiss()
                }
                .onAppear { if start == .address { model.browser.start() } }
                .onDisappear { model.browser.stop() }
            }
        }
    }
}

extension AddServerFlow.Start: Identifiable {
    public var id: String {
        switch self {
        case .address: "address"
        case .server(let url, let username): "server:\(url.absoluteString):\(username ?? "")"
        case .redeem(let link): "redeem:\(link.id)"
        }
    }
}
```

**Step 2: The app opens on the root view and handles playarr:// links**

Replace the body of `apps/ios/Playarr/PlayarrApp.swift` with the following. Keep phase 0's `@UIApplicationDelegateAdaptor` line if there is one.

```swift
import PlayarrUI
import SwiftUI

@main
struct PlayarrApp: App {
    @State private var model = AppModel.live()

    var body: some Scene {
        WindowGroup {
            RootView(model: model)
                .onOpenURL { model.open($0) }
        }
    }
}
```

**Step 3: Build for the Mac, the simulator, and the app**

```bash
swift build --package-path apps/ios/Packages/PlayarrUI
swift build --package-path apps/ios/Packages/PlayarrUI --triple arm64-apple-ios26.0-simulator --sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" --scratch-path /tmp/playarr-ui-ios
make -C apps/ios build
```

Expected: all three build with no errors and no warnings from these files. The iOS-only text-field modifiers are behind `#if os(iOS)` in `TextFields.swift`, and `DeviceInfo`'s UIKit use in PlayarrAPI is too.

**Step 4: Run every iOS test**

```bash
make -C apps/ios test
```

Expected: all package suites and the app's tests pass.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI apps/ios/Playarr/PlayarrApp.swift
git commit -F - <<'MSG'
iOS: add a server, sign in, redeem a setup code or claim the server, and switch accounts

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---
### Task 17: CI fails when the models or fixtures are out of date

Phase 0's macOS workflow already runs `swift test` in each package, and that now includes the contract tests. This job checks the other direction on a cheap Linux runner. A TypeScript change without `pnpm ios:models` fails it, and so does a server change without recorded fixtures.

**Files:**
- Create: `.github/workflows/ios-contracts.yml`

**Step 1: Write the workflow**

```yaml
name: iOS contracts

on:
  push:
    branches: [main]
    paths: ['packages/**', 'apps/server/**', 'apps/ios/**', 'package.json', 'pnpm-lock.yaml', '.github/workflows/ios-contracts.yml']
  pull_request:
    paths: ['packages/**', 'apps/server/**', 'apps/ios/**', 'package.json', 'pnpm-lock.yaml', '.github/workflows/ios-contracts.yml']

jobs:
  generated:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v5
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: The Swift models match the TypeScript types
        run: node apps/ios/scripts/gen-models.mjs --check
      - name: The fixtures match the server's answers
        run: |
          RECORD_FIXTURES=1 pnpm -C apps/server exec vitest run src/routes
          git add --intent-to-add apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/Fixtures
          git diff --exit-code -- apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/Fixtures
```

**Step 2: Check both steps locally**

```bash
node apps/ios/scripts/gen-models.mjs --check
RECORD_FIXTURES=1 corepack pnpm -C apps/server exec vitest run src/routes
git add --intent-to-add apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/Fixtures
git diff --exit-code -- apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/Fixtures && echo fixtures up to date
```

Expected: `Models.generated.swift is up to date.` and `fixtures up to date`.

Then prove the model check bites. Add a field `extra?: string;` to `MissingTrack` in `packages/shared/src/index.ts` and run `node apps/ios/scripts/gen-models.mjs --check`. Expected: exit 1 with `Models.generated.swift is out of date`. Then undo it: `git checkout packages/shared/src/index.ts`.

**Step 3: Commit**

```bash
git add .github/workflows/ios-contracts.yml
git commit -F - <<'MSG'
CI: fail when the iOS models or the recorded server answers are out of date

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 18: Walk through it on the simulator against the dev server

No code. This checks Bonjour, ATS, the Keychain and the screens together. If something is wrong, fix it in the task that owns it and commit there.

**Step 1: A dev server in setup mode**

```bash
DATA_DIR=$(mktemp -d) corepack pnpm dev:server
```

Run it in the background. A fresh `DATA_DIR` has no passwords, so the server is in setup mode. `--env-file` doesn't override a variable that is already set. Wait for the listening line on port 4000. Check: `curl -s http://localhost:4000/api/server` answers `"setup":true`.

**Step 2: Build, install and open the app**

```bash
make -C apps/ios bootstrap
xcodebuild -project apps/ios/Playarr.xcodeproj -scheme Playarr -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -derivedDataPath /tmp/playarr-dd build
xcrun simctl boot 'iPhone 17 Pro' 2>/dev/null; open -a Simulator
xcrun simctl install booted /tmp/playarr-dd/Build/Products/Debug-iphonesimulator/Playarr.app
xcrun simctl launch booted me.tracklistme.playarr
```

(If phase 0 named the scheme differently, use `xcodebuild -list -project apps/ios/Playarr.xcodeproj` to find it.)

**Step 3: The checklist**

1. "Add a server" opens and the Local Network prompt appears. Allow it. The dev server shows up under "On your network" with its name (Bonjour; the simulator shares the Mac's network).
2. Type `localhost:4000` and tap Connect. "Set up <name>" opens (setup mode). Claim it with a username, your name and a password. The home shows "Signed in as <name> on <server>" and the library counts.
3. Kill and relaunch the app (`xcrun simctl terminate booted me.tracklistme.playarr && xcrun simctl launch booted me.tracklistme.playarr`). It opens signed in, with no password asked: the token came from the Keychain.
4. On the web (`corepack pnpm dev:web`, http://localhost:5173), go to Settings → Accounts and add an account. Copy its setup code, then run `xcrun simctl openurl booted "playarr://redeem?server=http%3A%2F%2Flocalhost%3A4000&code=<CODE>"`. "Set your password" opens with the code filled in. Set a password: you are signed in as the new account.
5. Accounts: both accounts are listed under the server. Tap the owner: the home switches with no password. Swipe "Sign out" on the second account: it disappears, and the server's session list on the web loses it.
6. On the web, sign out the app's session for the owner (Settings → Accounts → sessions). In the app, open Accounts and tap the owner again. The next request gets a 401, the row says "Signed out", and tapping it opens "Sign in to <server>" with the username filled in.
7. Accounts → "Add a server", type `http://example.com`: "Use https:// for a server outside your home network."
8. Too old: restart the dev server with phase 1's minimum app version set above the app's (`MARKETING_VERSION` in `apps/ios/Config/Base.xcconfig`; use the env variable or constant phase 1 reads it from). Relaunch the app: "Update Playarr" shows.

Stop the dev servers afterwards.

---

### Task 19: Record this phase's names in the conventions

**Done centrally on 2026-11-03** (commit that added the phase 1 and 2 plans): skip this task.

The conventions file says a plan that changes something there updates it in the same commit. Skip this task if whoever coordinates the phase plans has already made these edits.

**Files:**
- Modify: `docs/plans/2026-11-03-ios-conventions.md`

**Step 1: Edit**

- Under "Server contracts added for the app": add `CreatedAccount { account: Account; setup: SetupCode }` to the shared types, and use it as the answer of `POST /api/accounts`.
- Under "Swift conventions → Key types → PlayarrAPI": add the following.
  - `AccountKey` (server id and account id, Keychain account `"<serverId>:<accountId>"`). `AccountRecord` carries `signedIn` (false after a 401).
  - `APIError` is `.unauthorized`, `.server(status:message:)`, `.offline`, `.decoding(String)`. A 401 without a token is `.server(401, message)`.
  - Endpoints are `API.<Feature>.<call>(…)` returning `Endpoint<T>`.
  - `SecretStore` (`KeychainSecretStore`, `InMemorySecretStore`), `ServerAddress`, `AppVersion`, `RedeemLink`, `DeviceInfo` (platform `"ios"` or `"ipados"`).
- Under "PlayarrUI": `AppModel` starts in phase 2 (store, browser, app version, redeem link). Later phases add to it.
- Add a line under "Commands": fixtures are recorded with `RECORD_FIXTURES=1 corepack pnpm -C apps/server exec vitest run src/routes` into `PlayarrAPI/Tests/PlayarrAPITests/Fixtures`. A new endpoint adds a recording in `apps/server/src/routes/contract.test.ts` (or its own route test) and a line in `ContractTests.swift`.
- Note under "Swift conventions": generated types follow the rules in this plan's "Key decisions" (`unknown(String)` fallbacks, `noneValue`, ids and counts as `Int`, dates as `String`). In Claude's shell, `swift build`/`swift test` need `--disable-sandbox`.

**Step 2: Commit**

```bash
git add docs/plans/2026-11-03-ios-conventions.md
git commit -F - <<'MSG'
iOS conventions: the names phase 2 settled (accounts in the store, API errors, endpoints, fixtures)

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

## What later phases can rely on (PlayarrAPI public API)

A summary of the signatures the tasks above define (abridged: not compilable as written).

```swift
// Models.generated.swift: every type of packages/shared and packages/mix/src/types.ts, by its TypeScript name
// (Track, Album, AlbumDetail, PlaylistDetail, TransitionPlan, TransitionAnswer, MixMap, MixMapEntry, …),
// plus `public let mixMapVersion: Int`.

public struct Endpoint<Response: Decodable & Sendable>: Sendable {
    public var method: HTTPMethod; public var path: String; public var query: [URLQueryItem]
    public var body: (any Encodable & Sendable)?; public var timeout: TimeInterval?
    public init(_ method: HTTPMethod = .get, _ path: String, query: [URLQueryItem] = [], body: (any Encodable & Sendable)? = nil, timeout: TimeInterval? = nil)
    public func bodyData() throws -> Data?
}
public enum API { Server, Auth, Accounts, Library, Search, Discover, Requests, Favorites, Playlists, Settings, Analysis, Playback, Mixes, Stats }

public actor APIClient {
    public nonisolated let baseURL: URL
    public init(baseURL: URL, token: String? = nil, session: URLSession = .shared, timeout: TimeInterval = 30, onUnauthorized: @escaping @Sendable () async -> Void = {})
    public func send<T: Decodable & Sendable>(_ endpoint: Endpoint<T>) async throws -> T
    public nonisolated func urlRequest<T>(for endpoint: Endpoint<T>) throws -> URLRequest
    public static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T
}
public enum APIError: Error, Equatable, Sendable, LocalizedError { case unauthorized, server(status: Int, message: String), offline, decoding(String) }

public struct MediaURLs: Sendable {
    public init(baseURL: URL, token: String?)
    public func url(_ path: String) -> URL?
    public func stream(fileId: Int) -> URL?
    public func levelled(_ track: Track, gain: Double) -> URL?
    public func transition(_ path: String) -> URL?
    public func art(_ path: String?, size: Int) -> URL?
    public func playlistCoverPreview(playlistId: Int, layout: CoverLayout, variant: Int, size: Int) -> URL?
    public func request(for url: URL) -> URLRequest
}

@MainActor @Observable public final class ServerStore {
    public private(set) var servers: [ServerRecord]; public private(set) var active: AccountKey?
    public init(directory: URL, secrets: any SecretStore, session: URLSession = .shared)
    public static func live() -> ServerStore
    public var activeServer: ServerRecord? { get }; public var activeAccount: AccountRecord? { get }; public var activeClient: APIClient? { get }
    public func server(_ id: String) -> ServerRecord?
    public func account(_ key: AccountKey) -> AccountRecord?
    public func client(for record: AccountRecord) -> APIClient?
    public func anonymousClient(for baseURL: URL) -> APIClient
    public func mediaURLs(for record: AccountRecord) -> MediaURLs?
    @discardableResult public func remember(_ info: ServerInfo, at baseURL: URL) -> ServerRecord
    public func signedIn(_ response: SignInResponse, server info: ServerInfo, at baseURL: URL) throws
    public func activate(_ key: AccountKey)
    public func update(_ account: Account, on serverId: String)
    public func markSignedOut(_ key: AccountKey)
    public func signOut(_ key: AccountKey) async
}
public struct ServerRecord: Codable, Hashable, Sendable, Identifiable { id: String; name: String; baseURL: URL; accounts: [AccountRecord] }
public struct AccountRecord: Codable, Hashable, Sendable, Identifiable { serverId: String; account: Account; signedIn: Bool; key: AccountKey }
public struct AccountKey: Codable, Hashable, Sendable { serverId: String; accountId: Int; keychainAccount: String }
public protocol SecretStore: Sendable { token(for:), setToken(_:for:), removeToken(for:) }   // KeychainSecretStore, InMemorySecretStore

@MainActor @Observable public final class ServerBrowser { public private(set) var servers: [DiscoveredServer]; start(); stop() }
public struct DiscoveredServer: Hashable, Sendable, Identifiable { id, name, version: String; baseURL: URL; init?(txt:host:port:); static merge(_:_:) }
public enum ServerAddress { static func url(from: String) throws(Problem) -> URL; static func isLocal(host:) -> Bool }
public struct AppVersion: Comparable, Sendable { init(_:); static var current: AppVersion }   // ServerInfo.supports(_:)
public struct RedeemLink: Equatable, Sendable, Identifiable { server: URL; code: String; init?(_ url: URL) }
public struct DeviceInfo: Sendable, Equatable { name, platform: String; @MainActor static func current() -> DeviceInfo }
```
