# iOS app: where things stand (2026-11-04)

Notes for picking the iOS work up again. The plans are in this folder:
- `2026-11-03-ios-app-design.md`, the design
- `2026-11-03-ios-parity-inventory.md`, what the web has and the app must match
- `2026-11-03-ios-conventions.md`, names, commands and commit style; read this first
- `2026-11-03-ios-phase<N>-*.md`, one plan per phase

## Phases

| Phase | What | State |
|---|---|---|
| 0 | Pipeline (XcodeGen, Makefile, `pnpm ios:*`, TestFlight) | Done. TestFlight builds go out; build 509 was the latest at the time of the crash fix below. |
| 1 | Accounts on the server (sign-in, setup codes, Bonjour, `GET /api/server`) | Done (server and web). |
| 2 | API layer and sign-in in the app | Done. |
| 3 | Audio engine (decks on one sample clock, FLAC/MP3, even volume, crossfades, lock screen) | Done. |
| 4 | Browsing and Now Playing (tabs, Home, Search, Library, Artist, Album, Queue, lyrics, Settings → Playback/Appearance) | Done. |
| 5 | DJ transitions, the transition sheet, Stats for nerds | Done. |
| 6 | Favorites, playlists, mixes, Your listening | Done. The older `2026-11-03-ios-phase6-next-steps.md` is out of date: phase 6 has landed. |
| 7 | Offline downloads | Code done (Tasks 0–21 committed). Hands-on checks still open, see below. |
| 8 | Discover, requests, Show metadata, Edit mix points | Done. |
| 9 | Admin settings (Sources, Mixes, Analysis, Requests, Updates, Accounts) | **Not started.** The plan is written. These Settings panels still show `PlaceholderPage`. |
| 10 | iPad split view, keyboard shortcuts, drag and drop, accessibility, icons, App Intents | **Not started.** The plan is written. |
| 11 | App Store (store text, privacy page, screenshots, `ios:release`) | **Not started.** The plan is written. There's no `apps/ios/store/` yet and no `ios:release` script. |

Work done outside the phase plans, all on main:
- `pnpm ios:crashes` lists new TestFlight crash reports and saves their logs to `apps/ios/build/crashes/`.
- `pnpm ios:screens` takes screenshots of the main screens on the "Playarr Screens" simulator and saves them to `apps/ios/build/screens/`.
- The web's fonts (Schibsted Grotesk, Gloock, DM Mono) are bundled.
- Fixes:
  - Songs failed to load: the stream cache had written its files under a percent-encoded "Application%20Support" path (`838dab2`).
  - The lock-screen artwork crashed build 509 (`de43a52`).

## Phase 7 (offline): what's left

All the code and automated tests are in. These checks need the dev server or the phone:

1. **Simulator against the dev server** (plan Task 16, step 6, and Task 20, step 2). Start the server if it needs the NAS: `corepack pnpm -C apps/server dev`. Then check:
   - downloading an album: the ring fills, songs get the offline mark, Library shows "Downloads 1", and Settings → Playback ends with On this device;
   - with DJ mix on, downloading a playlist sends `POST /api/transitions` for each pair, then fetches the transition files;
   - lowering the limit to 512 MB drops songs kept as you listen, but not downloads;
   - offline, a downloaded album plays, and songs that aren't kept are skipped with "Offline: skipped songs that aren’t on this device";
   - quitting from the app switcher mid-download, then reopening: the download resumes (the server log shows a `Range` request).
2. **On the phone** (`corepack pnpm ios:device`; the full checklist is in the phase 7 plan, Task 20, step 3):
   - downloads go on while the phone is locked, and resume after a force-quit;
   - mobile data: downloads wait unless "Allow downloads on mobile data" is on;
   - airplane mode: songs play levelled, transitions play, downloaded pages open from the cache, and play reports go out once back online;
   - keep-ahead: 3 songs on Wi-Fi, 1 on mobile data, none in Low Data Mode;
   - out of space: the messages are right;
   - Remove and "Remove all" free the space;
   - switching accounts, and the sign-out question;
   - iCloud backup size stays small.
3. **TestFlight**: `corepack pnpm ios:beta` (15–45 min) once the checklist passes.

Where phase 7 differs from its plan:
- Transitions kept with downloads plug into phase 5's existing `TransitionPlanner.kept` hook. A new `onPairChange` hook tells the store when the player moves to another pair.
- The rest of an MP3 after a transition (the "continuation") streams in phase 5. Downloads keep it on disk, and `TrackSource.Origin.kept` now plays it from there.
- The mix page now uses the query cache (`QueryKey.mix`), so a downloaded mix's page opens offline.
- An album download keeps the albums list under the key `["albums", "artist"]` (the plan assumed `["albums"]`).
- Now Playing has no up-next list, so the offline mark is on song rows and both kinds of queue row only.

## Next up

- Phase 9, admin settings. It reuses `Polling`, `FakeAPI`, `TestClock` and `Gate`. Follow the plan, one commit per task.
- Then phase 10 (iPad and polish), then phase 11 (App Store).

## How to work on it

- **Build:** `make -C apps/ios build`.
- **Package tests:** `make -C apps/ios test-packages`.
- **Everything:** `make -C apps/ios test`.
- **In Claude's shell:** Swift and Xcode commands need the sandbox off. `swift test` needs `--disable-sandbox`; the Makefile already passes the xcodebuild flags.
- **Simulator:** use "iPhone 17 Pro" on **iOS 26.5**. The 26.3 runtime is broken on this Mac, and two simulators share that name, so pick by id:
  `xcrun simctl list devices available`, then `-destination 'platform=iOS Simulator,id=<id>'`.
- **One UI test:** add `-only-testing:PlayarrUITests/<Class>` to the XCODEBUILD line in `apps/ios/Makefile`.
- **Known UI-test limitation:** XCUITest drags don't reach SwiftUI's list reordering on the iOS 26.5 simulator. The playlist UI test therefore only checks the reorder handles (`fcd9302`); `PlaylistModelTests` covers the move itself.
- **Test counts at the end of phase 7:**
  - scripts: 9
  - PlayarrAPI: 72
  - PlayarrPlayer: 230
  - PlayarrUI: 260
  - UI tests: 8, all passing on the simulator except the old drag test (since changed)
- **Commits:** one per task, on main, plain English. The pre-commit hook bumps the version. Pushing to GitHub main is the release: the NAS updates itself every 15 minutes.
