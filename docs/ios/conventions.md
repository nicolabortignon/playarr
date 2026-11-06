# iOS app conventions

The names, folders, commands and habits the iOS app's code follows. Read this before changing the app; the architecture is in [README.md](README.md). When a convention changes, change this file in the same commit.

---

## 1. Apple identifiers and settings

| What | Value |
|---|---|
| Team | W1T LTD, Team ID `M7ME2TS45S` (`DEVELOPMENT_TEAM` in `Config/Base.xcconfig`) |
| Bundle id | `me.tracklistme.playarr` (`PLAYARR_BUNDLE_ID`); the UI tests are `me.tracklistme.playarr.uitests` |
| App Store Connect API key | A Team key with the Admin role, at `~/.appstoreconnect/private_keys/AuthKey_<ASC_KEY_ID>.p8`. Never in the repo (`*.p8` is gitignored). |
| Repo `.env` (gitignored) | `ASC_KEY_ID`, `ASC_ISSUER_ID`, `APPLE_TEAM_ID`, `IOS_BUNDLE_ID`; for App Store releases also `REVIEW_SERVER_URL`, `REVIEW_USERNAME`, `REVIEW_PASSWORD`, `REVIEW_CONTACT_FIRST_NAME`, `_LAST_NAME`, `_EMAIL`, `_PHONE`; for the App Store screenshots `SCREENSHOT_LIBRARY`, `SCREENSHOT_ALBUM`. `.env.example` lists the `REVIEW_*` and `SCREENSHOT_*` lines only. |
| GitHub secrets | `ASC_KEY_ID`, `ASC_ISSUER_ID`, `APPLE_TEAM_ID`, `ASC_KEY_P8_BASE64`. The workflow sets `IOS_BUNDLE_ID` itself. |
| Deployment target | iOS 26.0. The Swift packages also declare macOS 26, so `swift test` runs on the Mac. |
| Swift | Swift 6 language mode (`SWIFT_VERSION: "6.0"` in `project.yml`; packages use tools version 6.2) |
| Devices | iPhone and iPad (`TARGETED_DEVICE_FAMILY: "1,2"`) |
| `Info.plist` | Background mode `audio` only (background `URLSession` downloads need none); `ITSAppUsesNonExemptEncryption` false; the `playarr` URL scheme; Bonjour `_playarr._tcp` with a Local Network usage text; `NSAllowsLocalNetworking`; the exported type `me.tracklistme.playarr.tracks` for dragging songs |
| Entitlements | None (`Config/Playarr.entitlements` is empty) |

## 2. Repository layout

```
apps/ios/
├── project.yml        # XcodeGen spec; Playarr.xcodeproj is generated and gitignored
├── Makefile           # every entry point; the root package.json's pnpm ios:* scripts call it
├── .tools/            # gitignored: the pinned XcodeGen, downloaded by make bootstrap
├── build/             # gitignored: DerivedData, archives, crashes/, screens-covers/
├── Config/            # Base.xcconfig (versions, team, bundle id), Info.plist, Playarr.entitlements
├── Playarr/           # app target: PlayarrApp.swift, AppDelegate.swift, Intents/, Assets.xcassets
├── Packages/
│   ├── PlayarrAPI/    # Sources/PlayarrAPI (+ Endpoints/), Tests/PlayarrAPITests (+ Fixtures/)
│   ├── PlayarrPlayer/ # Sources/PlayarrPlayer, Tests/PlayarrPlayerTests (+ Support/)
│   └── PlayarrUI/     # Sources/PlayarrUI (one folder per area), Tests/PlayarrUITests (+ Support/, Admin/)
├── PlayarrUITests/    # the XCUITest target: flows, audits, ScreenTour, StoreScreenshots
├── store/             # the App Store listing: app.json, en-US/*.txt
└── scripts/           # asc.mjs, release.mjs, appstore.mjs, store.mjs, screenshots.mjs, screens-covers.mjs,
                       # gen-models.mjs, mix-fixtures.mjs (each with a .test.mjs), flatten-png.swift, make-icons.swift
```

Two things share the name `PlayarrUITests`: the XCUITest target at `apps/ios/PlayarrUITests/`, and `PlayarrUI`'s package test target at `Packages/PlayarrUI/Tests/PlayarrUITests/`. Give the full path when it matters.

Dependencies: the app target → `PlayarrUI` → `PlayarrPlayer` → `PlayarrAPI`, and `PlayarrUI` → `PlayarrAPI` directly. No third-party packages.

## 3. Commands

| pnpm script | Make target | What it does |
|---|---|---|
| `pnpm ios:bootstrap` | `bootstrap` | Download the pinned XcodeGen (2.46.0, SHA-256 checked) and generate the project |
| `pnpm ios:build` | `build` | Simulator build |
| `pnpm ios:test` | `test` | `test-scripts` (`node --test scripts/*.test.mjs`), `test-packages` (`swift test` in each package), `test-app` (the UI tests) |
| `pnpm ios:models` | `models` | Regenerate `Models.generated.swift`; `make models-check` fails when it's stale |
| `pnpm ios:screens` | `screens` | Screenshots of the main views on the demo library, in `screenshots/<device>/` at the repo root |
| `pnpm ios:device` | `device` | Build and install on a paired iPhone with `xcrun devicectl` |
| `pnpm ios:setup` | `setup` | Register the bundle id; once the app record exists, the "Household" TestFlight group and its testers |
| `pnpm ios:beta` | `beta` | Test, then `beta-upload`: archive, upload, wait, "What to Test", the Household group |
| `pnpm ios:crashes` | `crashes` | New TestFlight crash reports, logs saved in `apps/ios/build/crashes/` |
| `pnpm ios:screenshots` | `screenshots` | The App Store screenshots |
| `pnpm ios:release` | `release` | Test, then submit `MARKETING_VERSION` to the App Store |
| none | `store-check`, `release-submit`, `models-check`, `tools`, `project`, `test-scripts`, `test-packages`, `test-app`, `clean` | Run with `make -C apps/ios <target>` |

Make variables go after the target, also through pnpm (`pnpm ios:screens SCREENS=ipad`):

- `SIMULATOR="iPad Pro 13-inch (M5)"` for `build` and `test` (default "iPhone 17 Pro"; the first available iPhone when there's none by that name), or `SIMULATOR_ID=<id>` to pick one exactly;
- `ONLY="AccessibilityAuditTests IPadLayoutTests"` for `test-app`;
- `SCREENS="iphone ipad duo"` for `screens` (`se`, the smallest iPhone, only when named), `SETS="iphone-6.9 ipad-13 iphone-6.3"` for `screenshots`;
- `TESTERS="a@example.com b@example.com"` (space-separated) for `setup`, `DEVICE="name or UDID"` for `device`;
- `VERSION=1.1.0` and `DRY_RUN=1` for `release`.

The Makefile loads the repo's `.env` for the App Store Connect scripts (`node --env-file-if-exists=../../.env`). `pnpm` is `corepack pnpm` in Claude's shell.

**Versions.** `MARKETING_VERSION` in `Config/Base.xcconfig` (`1.0.0`) changes only for App Store releases. The build number is `git rev-list --count HEAD`, passed as `CURRENT_PROJECT_VERSION` by the Makefile and `release.mjs`; the `1` in the xcconfig is for builds from Xcode.

**Sandboxed shells.** `swift test` needs `--disable-sandbox`; `xcodebuild` needs `-IDEPackageSupportDisableManifestSandbox=YES` and `OTHER_SWIFT_FLAGS=$(inherited) -Xfrontend -disable-sandbox` (the compiler can't sandbox the `@Observable` macro plugin). The Makefile and `release.mjs` pass them.

## 4. The server's side

Accounts, sessions, setup codes, the 401 rules and Bonjour are described in [../server/accounts-and-access.md](../server/accounts-and-access.md). What the app relies on:

- The app sends `Authorization: Bearer <token>` on every request, including `/stream`, `/art` and `/transitions`, and `X-Playarr: 1` too, though Bearer requests don't need it. Tokens never go in a URL (`MediaURLs.request(for:)`).
- Answer types come from `packages/shared/src/index.ts` and `packages/mix/src/types.ts` only, so `gen-models.mjs` sees them. A type the app reads that lives only in the server or the web moves there first. Its rules are in [README.md](README.md#generated-models).
- A new endpoint adds `API.<Feature>.<call>()` in `PlayarrAPI/Sources/PlayarrAPI/Endpoints/API+<Feature>.swift`, a recording in `apps/server/src/routes/contract.test.ts`, and a line in `ContractTests.swift`. Record with `RECORD_FIXTURES=1 corepack pnpm -C apps/server exec vitest run src/routes`. CI decodes the fixtures (`swift test`), but no workflow checks that the models or the fixtures match the TypeScript; run `make models-check` and re-record yourself.

## 5. Swift

- **Concurrency.** Strict concurrency. UI state is `@MainActor @Observable` classes; networking and audio I/O are actors or `Sendable` types.
- **Names** mirror the web's where the thing exists there (`Track`, `Album`, `PlaylistDetail`, `TransitionPlan`, `MixMap`); generated types keep their TypeScript names. Extensions go in `Type+Feature.swift` (`AccountSession+Shell.swift`, `Format+Listening.swift`).
- **Files.** One primary type per file, named after it. No force unwraps in app code (the demo library's constants are the only ones).
- **Indentation.** Match the file. `PlayarrAPI` mostly uses 4 spaces, everything else 2; the generated models use 4. There's no formatter.
- **View models** take `api: any APISending`, never `APIClient`, and a polling one takes `clock: any Clock<Duration> = ContinuousClock()`. Polling loops use `Polling.run(clock:interval:refresh:)` (`PlayarrUI/Support/Polling.swift`); don't write another.
- **Per-account state** hangs on `AccountSession` (`api`, `player`, `queries`, `images`, `router`, `toasts`, `discover`, `favorites`, `playlists`, `mixes`, `picking`, `actions`, `addToPlaylist(_:)`). `AppModel.session` is the active one, rebuilt by `syncSession()`.
- **Folders.** `AccountSession.folder(for:)` is `Application Support/Playarr/<serverId>/<accountId>/` (`queue.json`, `pending-plays.json`, `queries/`, `stream/`, `offline/`, `offline.json`); `AccountSession.imageFolder(for:)` is `Caches/Playarr/<serverId>/<accountId>/images/`. `OfflineFolder` works out the download paths ([offline.md](offline.md)).
- **Settings.** Playback settings are `UserDefaults` keys `playback.*` (`PlaybackSettings`); appearance is `AppearanceSettings`.
- **Formatting** shared across screens lives in `Format` (`time`, `duration`, `plural`, `wait`, `jsRound`, `addedAgo`…). Add to it rather than writing a copy.
- **Navigation.** Every page a tab stack or the iPad's detail column shows is a `Route` case (`Route` is `Codable`, for scene restoration), and destinations are registered once, in `shellDestinations(_:)` (`Shell/TabShell.swift`). Server settings panels are `SettingsPanel` cases, each a thin view over a `@MainActor @Observable` model in `Settings/Admin/<Panel>/`.
- **Sheets** that must also open over Now Playing are attached twice with `active:` (`addToPlaylistSheet(_:active:)`, `trackSheets(player:active:)`).

## 6. Look, text and accessibility

- User-facing text copies the web's wording. Where the web names the browser, say "this device" ("This file format is not supported on this device").
- Every control is at least 44 points (`.contentShape` after the frame). Colors, type, radii and cover shadows come from `Theme/` by role ([design.md](../design.md)): secondary text is `.paperDim`, quieter text (kickers, times, counts) `.muted`; text drawn on artwork goes through `ArtworkText`. Use `AdaptiveStack`, `essentialLineLimit()`, `reducesMotion` and `pointerHover()` where they fit.
- **Headers.** A tab or a library list takes `pageHeader(_:count:)`, its controls going in the bar; anything you can play takes `DetailHeader` and `titleInBar(_:)`, its meta line a `MetaLine` of parts joined by dots ([layouts.md](layouts.md#2-iphone-upright)). A kicker is `Kicker` (`.muted` in the kicker role, `overArt:` for `.paperDim` over art). A name beside numbers is `NameAndNumbers`, so the numbers move under the name rather than cut it.
- **Rows and menus.** A song in a list is a `SongRow` (a song not in the library a `MissingSongRow`), whose ⋯, long press and VoiceOver actions are the one song menu (`SongMenu.groups`), the place's own actions passed as `SongMenu.Place`; never build a song's menu by hand. Everything you can play offers `PlayableMenu`'s items. A change that can be taken back says so with `ToastCenter.undo(_:undo:)`; a menu item that takes something away is `.remove` (or `.delete`, for good), drawn in red.
- Put `.accessibilityLabel` on the `Button` or `NavigationLink` itself. Never wrap a button in `.accessibilityElement(children: .ignore)`: VoiceOver and UI tests can't tap the wrapper.
- An accessibility audit exception (`AuditExceptions` in `AccessibilityAuditTests.swift`) says what, where and why, and is added only after trying to fix the view; check contrast against the element's own pixels (`measuredContrast`) before ignoring a contrast issue.
- After a change to the UI, run `corepack pnpm ios:screens` to refresh `screenshots/` at the repo root (iphone, iphone-sideways, ipad, duo, duo-sideways; not committed).

## 7. Tests

- Packages use Swift Testing (`import Testing`, `@Test`, `#expect`), never XCTest; the UI tests use XCUITest.
- Shared doubles, reused rather than copied:
  - `Packages/PlayarrUI/Tests/PlayarrUITests/Support/`: `FakeAPI` (answers by method and path: `on`, `then`, `fail`, `hold(_:_:until:)` with a `Gate`; records `calls`, `queries`, `bodies`), `TestClock` (`nextSleep()`, `advance(by:)`, `sleeping`), `Gate`, `TestSession`, `FakeServer`, `Listening`. Admin panels' sample answers are in `../Admin/Samples.swift`.
  - `Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/`: `FakeBackend`, `FakeTransport`, `ManualScheduling` (timers driven by hand through `Scheduling`), `Recorder`, `Gate`, `StubServer`, synthetic `Signals` and `Songs`.
- `MixFixtures.generated.swift` holds the web's mixing rules' answers, written by `scripts/mix-fixtures.mjs` from the TypeScript (`packages/mix/src/plan.ts`, `automation.ts`, `apps/web/src/player/mixSequence.ts`). Rerun it after changing those files; `make test-scripts` fails when it's stale (and needs the web's packages installed).
- UI tests each run on a simulator of their own. Phone flows that go through the tab bar call `skipOnIPad()` first.
- **Launch arguments** (`Playarr/PlayarrApp.swift`): `-UITests` (no servers, nothing kept; takes a dev server's session from `PLAYARR_UITEST_SERVER` and `PLAYARR_UITEST_TOKEN`), `-UITestsDemo` (the demo library), `-UITestsRequests` (the demo with Lidarr), and with the demo `-UITestsOffline`, `-UITestsLongQueue`, `-UITestsManyPlaylists`, `-UITestsTurnToOpen`, `-UITestsRestore`, `-UITestsFold flat|half` (the iPhone Duo's hinge, which the simulator can't open). `-UITestsDownloads` (Debug builds) opens made-up downloads.
- **Environment for the UI tests**, through xcodebuild's `TEST_RUNNER_` prefix: `PLAYARR_UITEST_SERVER`, `PLAYARR_UITEST_ADMIN`, `PLAYARR_UITEST_PASSWORD` (`AccountsUITests`, skipped without them), `PLAYARR_DEVICE_CHECKS=1` and `PLAYARR_RESTORE=1` (checks only a device can do), `SCREENS_DIR` and `PLAYARR_DEMO_COVERS` (`ScreenTour`), and `PLAYARR_SCREENSHOTS`, `PLAYARR_SERVER`, `PLAYARR_USERNAME`, `PLAYARR_PASSWORD`, `PLAYARR_ALBUM`, `PLAYARR_LANDSCAPE` (`StoreScreenshots`, set by `screenshots.mjs`).
- **Stable identifiers** include `settings` (in the account menu), `settings.<panel>`, `sidebar.*`, `playerBar*`, `sideColumn` and `nowPlaying.upNext`.

## 8. Commits

Commit on `main`, only the files of the change, with a plain-English subject in the style of the history (no `feat:` prefixes) and the `Co-Authored-By: Claude <noreply@anthropic.com>` line. The pre-commit hook (`.githooks/pre-commit`) raises the version; never bypass it. Pushing to `main` is the release: the NAS updates itself, and a push that changes `apps/ios` also sends a TestFlight build ([release.md](release.md)).
