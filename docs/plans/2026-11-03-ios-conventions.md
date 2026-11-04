# Native iOS app: conventions shared by every phase plan

Date: 2026-11-03. Companion to [the design](2026-11-03-ios-app-design.md) and [the parity checklist](2026-11-03-ios-parity-inventory.md). Phase plans are written in parallel; this file fixes the names, contracts and commands they share. When a plan needs to change something here, it changes this file in the same commit.

## Apple identifiers

| What | Value |
|---|---|
| Team | W1T LTD (organization), Team ID `M7ME2TS45S` |
| Bundle id | `me.tracklistme.playarr` (UI tests: `me.tracklistme.playarr.uitests`) |
| App name | Playarr |
| App Store Connect API key | Team key "Playarr CI", Admin. `.p8` at `~/.appstoreconnect/private_keys/AuthKey_<ASC_KEY_ID>.p8` |
| `.env` (repo root, gitignored) | `ASC_KEY_ID`, `ASC_ISSUER_ID`, `APPLE_TEAM_ID`, `IOS_BUNDLE_ID` |
| GitHub secrets | `ASC_KEY_ID`, `ASC_ISSUER_ID`, `APPLE_TEAM_ID`, `ASC_KEY_P8_BASE64` |
| Deployment target | iOS 26.0; Swift packages also declare macOS 26 so `swift test` runs on the Mac |
| Devices | iPhone and iPad (`TARGETED_DEVICE_FAMILY = 1,2`) |
| Capabilities | Background mode: audio (background `URLSession` downloads need none). Keychain sharing not needed (one app). |
| Encryption | `ITSAppUsesNonExemptEncryption = NO` |

## Repository layout

```
apps/ios/
├── project.yml               # XcodeGen spec (the .xcodeproj is generated, gitignored)
├── Makefile                  # all entry points; pnpm ios:* scripts call it
├── .tools/                   # gitignored: pinned XcodeGen downloaded by `make bootstrap`
├── Config/                   # Base.xcconfig (versions, team, bundle id), Info.plist, entitlements
├── Playarr/                  # app target: PlayarrApp.swift, AppDelegate (background URLSession), Assets.xcassets
├── Packages/
│   ├── PlayarrAPI/           # Sources/PlayarrAPI, Tests/PlayarrAPITests (+ Fixtures/)
│   ├── PlayarrPlayer/        # Sources/PlayarrPlayer, Tests/PlayarrPlayerTests
│   └── PlayarrUI/            # Sources/PlayarrUI, Tests/PlayarrUITests (view models)
├── PlayarrUITests/           # XCUITest target: flows + App Store screenshots
├── store/                    # App Store text (en-US), review notes, keywords
└── scripts/
    ├── asc.mjs               # App Store Connect API (JWT with node:crypto, no dependencies)
    ├── release.mjs           # beta and release flows on top of asc.mjs and xcodebuild
    └── gen-models.mjs        # TypeScript types → Swift Codable
```

Package dependencies: `PlayarrUI → PlayarrPlayer → PlayarrAPI`, and `PlayarrUI → PlayarrAPI` directly. The app target depends on `PlayarrUI`. No third-party packages.

## Commands

| Command | What it does |
|---|---|
| `pnpm ios:bootstrap` (`make -C apps/ios bootstrap`) | Download pinned XcodeGen to `.tools/`, generate `Playarr.xcodeproj` |
| `pnpm ios:test` | `node --test` on the scripts, `swift test` in each package, then `xcodebuild test` (app + UI tests) on the simulator |
| `pnpm ios:build` | Simulator build |
| `pnpm ios:models` | Regenerate `PlayarrAPI/Sources/PlayarrAPI/Models.generated.swift` |
| `pnpm ios:setup` | One-time and idempotent: register the bundle id and capabilities via the API |
| `pnpm ios:beta` | Test, archive, upload, wait for processing, distribute to the internal TestFlight group |
| `pnpm ios:crashes` | Crash reports testers sent from TestFlight not looked at yet; each log saved in `apps/ios/build/crashes/` |
| `pnpm ios:screens` | Screenshots of the main screens on the demo library (`ScreenTour` UI test, simulator "Playarr Screens"), saved in `apps/ios/build/screens/` |
| `pnpm ios:release` | App Store version, text, screenshots, submit for review |
| `pnpm ios:device` | Build and install on a paired iPhone with `xcrun devicectl` |

Make variables (after the target, also through pnpm): `TESTERS=a@b,c@d` for `ios:setup`, `SIMULATOR="iPad Pro 13-inch (M5)"` for build and test; environment `DEVICE="Name"` picks the phone for `ios:device`. Lower-level targets: `tools`, `project`, `test-scripts`, `test-packages`, `test-app`, `beta-upload` (upload without tests, used by CI), `clean`.

Simulator destination: `platform=iOS Simulator,name=iPhone 17 Pro` (iPad: `iPad Pro 13-inch (M5)`); scripts pick the first available matching device when the exact one is missing. `pnpm` is `corepack pnpm` in Claude's shell.

Versions: `MARKETING_VERSION` in `Config/Base.xcconfig` (starts at `1.0.0`, changed only for releases); `CURRENT_PROJECT_VERSION` = `git rev-list --count HEAD`, passed by the scripts.

## Server contracts added for the app (phase 1)

Shared TypeScript types go in `packages/shared/src/index.ts`:

```ts
export type AccountRole = 'admin' | 'member';
export interface Account {
  id: number;
  username: string;
  name: string;               // display name
  role: AccountRole;
  canRequest: boolean;
  sources: number[] | null;   // null = every source
  hasPassword: boolean;       // false until set up
}
export interface SessionInfo { id: number; device: string; platform: string; createdAt: string; lastSeenAt: string; current: boolean }
export interface ServerInfo { id: string; name: string; version: string; minAppVersion: string; setup: boolean; ownerUsername?: string; publicUrl?: string } // ownerUsername only while setup; publicUrl whenever PUBLIC_URL is set (the address every client uses)
export interface SignInResponse { token: string; account: Account }
export interface SetupCode { code: string; link: string; expiresAt: string }
export interface CreatedAccount { account: Account; setup: SetupCode }
// PlaylistSummary gains: owner: string (display name), shared: boolean, mine: boolean
```

Types that lived only in the web move so the Swift generator sees them (phase 2, task 1): `TransitionAnswer`, `RenderProgress`, `MixMapEntry` → `@playarr/mix` (shared doesn't depend on mix); `AnalysisKind`, `AnalysisProgress`, `MixSettingsPatch`, `UpdateSettingsPatch` → `@playarr/shared`. Server and web re-export them.

Endpoints (JSON; errors are `{ error: string }` with a status code, as today):

| Method and path | Who | Body → answer |
|---|---|---|
| `GET /api/server` | anyone | → `ServerInfo` |
| `POST /api/auth/setup` | home network, setup mode only | `{ username, name, password, device, platform }` → `SignInResponse` (claims account 1 as admin) |
| `POST /api/auth/sign-in` | anyone (rate-limited) | `{ username, password, device, platform }` → `SignInResponse` |
| `POST /api/auth/redeem` | anyone (rate-limited) | `{ code, password, device, platform }` → `SignInResponse` (first password from a setup code) |
| `POST /api/auth/sign-out` | signed in | → 204 (ends this session) |
| `GET /api/auth/me` | signed in | → `Account` |
| `POST /api/auth/switch` | anyone (authenticates by the token in the body; web only) | `{ token }` → `Account`, sets the cookie to that session |
| `GET /api/accounts` | admin | → `Account[]` |
| `POST /api/accounts` | admin | `{ username, name, role, canRequest, sources }` → `CreatedAccount` |
| `PATCH /api/accounts/:id` | admin (or self for `name`) | partial `Account` fields → `Account` |
| `DELETE /api/accounts/:id` | admin | → `Account[]` (never the last admin) |
| `POST /api/accounts/:id/reset` | admin | → `SetupCode` (signs out every session) |
| `POST /api/playlists`, `PATCH /api/playlists/:id` | signed in (PATCH: owner) | gain an optional `shared: boolean` |
| `GET /api/accounts/:id/sessions` | admin or self | → `SessionInfo[]` |
| `DELETE /api/accounts/:id/sessions/:sessionId` | admin or self | → `SessionInfo[]` |

- **Credentials**: `Authorization: Bearer <token>` (the app) or cookie `playarr_session` (the web, HttpOnly, SameSite=Lax, Secure when served over HTTPS). Both accepted on every route, including `/stream`, `/art`, `/transitions`.
- **Unauthenticated**: once any account has a password, every `/api`, `/stream`, `/art`, `/transitions` request without a valid session is answered 401 `{ error, setup: false }`, except `GET /api/server`, `/api/auth/sign-in|redeem|setup|switch`, and `GET /api/health`. Every 401 body carries `setup` (in setup mode `GET /api/auth/me` and failed sign-ins answer 401 with `setup: true`). In setup mode, requests keep working as today (no sign-in yet) so an existing install isn't locked out before the owner claims it.
- **`X-Playarr: 1`** stays required on changes for cookie sessions; Bearer requests are exempt (no cookie, no cross-site risk). The app sends it anyway.
- **`X-Playarr-Profile`** is ignored once accounts exist; the session decides.
- **Tokens**: 32 random bytes, base64url; stored as SHA-256. Setup codes: 8 characters from an unambiguous alphabet, valid 7 days, single use; `link` is `<origin>/redeem?code=...` (the app also opens `playarr://redeem?server=<origin>&code=...`).
- **Statuses**: rate-limited sign-in or redeem → 429; `POST /api/accounts` and `/reset` in setup mode → 409. `device` and `platform` are optional (defaults "Unknown device", "web").
- **Usernames** match `^[a-z0-9][a-z0-9._-]{0,31}$` (lowercased on input); passwords need at least 8 characters.
- **Owner recovery**: no endpoint. On the server host, `node dist/cli.js reset-password <username>` from `apps/server` (in Docker: `docker exec playarr node server/dist/cli.js reset-password <username>`, the image's working directory being `/app`; in dev: `corepack pnpm -C apps/server reset-password <username>`) signs the account out everywhere and prints a setup code and link (on `PUBLIC_URL`, else `http://localhost:<PORT>`). The old password ends too unless it's the server's only one (clearing that would put the server back in setup mode until the code is used). Phase 1 adds it as its last code task.
- **Bonjour**: instance name = server name; `_playarr._tcp`, TXT `id=<server uuid>`, `v=<version>`, `name=<server name>`, `path=/`. Turned off with `BONJOUR=off`.

## Swift conventions

- Swift 6 language mode, strict concurrency. UI state is `@MainActor @Observable` classes; networking and audio I/O are actors or `Sendable` types.
- Naming mirrors the web where a thing exists there: `Track`, `Album`, `PlaylistDetail`, `TransitionPlan`, `MixMap`. Swift types generated from TypeScript keep the TypeScript names.
- Key types the phases build on (defined in the phase named):
  - `PlayarrAPI` (phase 2): `ServerRecord` (id, name, baseURL, localURL, accounts: baseURL is the server's `publicUrl` when it has one, localURL the home-network address it was reached at or found by Bonjour, which `APIClient` tries once when baseURL can't be reached), `AccountRecord` (server id, account, token in Keychain), `ServerStore` (`@Observable`, the list and the active server and account), `APIClient` (actor; one per server and account; `func send<T: Decodable>(_ endpoint: Endpoint<T>) async throws -> T`), `Endpoint<T>` (method, path, query, body), `APIError` (`.unauthorized`, `.server(status:message:)`, `.offline`, `.decoding(String)`; a 401 to a request with no token is `.server(401, message)` so a wrong password keeps the server's message), `ServerBrowser` (Bonjour), `MediaURLs` (stream, art, transition URLs with sizes; the token always goes in a header, never the URL). Also: `AccountKey`, `AccountRecord.signedIn`, `SecretStore` (Keychain or in-memory), `ServerAddress`, `AppVersion`, `RedeemLink`, `DeviceInfo`, `DiscoveredServer`, and every endpoint as `API.<Feature>.<call>()` returning an `Endpoint`. The phase 2 plan lists the exact signatures.
  - `PlayarrPlayer` (phase 3): `Player` (`@MainActor @Observable`: queue state, `play(_:startAt:source:shuffle:at:)` where `startAt` is the index into the tracks and `at:` seconds, `next()`, `previous()`, `seek(to:)`, shuffle, repeat), `QueueState` (queue, order, pos, as in `apps/web/src/player/store.ts`; `repeatMode` is saved as `"repeat"`), `AudioEngine` (owns AVAudioEngine and nodes; phase 5's seam is `timelineSample(of:songFrame:)` + `scheduleTransition(_:at:envelope:)`, and `Join` gains a `.transition` case), `TrackSource` (progressive download + decode), `LevelStore`, `PlayTracker`, `PlayReportQueue`, `NowPlayingBridge`, `SleepTimer`, `PlaybackSettings` (UserDefaults `playback.*`), `PlayerBackend`/`APIBackend`, `StreamCache`, `Download`, `EngineItem`, `EngineEvent`, `PCMSource`, `PCMBlock`, `GainEnvelope`, `JoinRules`, `Radio`, `SessionPolicy`, `AudioSessionController`, `NetworkMonitor`, `PrefetchPolicy`, `PlaybackError`. The phase 3 plan lists the exact signatures.
  - Phase 5 extends phase 3: `Join` gains `.transition`, `.cut` and `.mix`; `EngineEvent.mixMissed`; `AudioEngine.tuning` is mutable; `EngineItem.continuation`; `DeckSnapshot` has a public init; `StreamCache` keeps transition files as `stream/transition-<name>`; `PlayerBackend` gains `transition(_:)`, `mixMaps(_:)`, `transitionRequest(_:)`; `Player.mixPointsChanged(recordingId:)` (for phase 8). Shared player test doubles: `FakeBackend` (with phase 7's transition fields), `Support/Recorder.swift`, `ManualScheduling` (timers driven by hand through the `Scheduling` protocol). `apps/ios/scripts/mix-fixtures.mjs` runs the web's TypeScript (`packages/mix/src/plan.ts`, `automation.ts`, `apps/web/src/player/mixSequence.ts`) and writes `MixFixtures.generated.swift`; rerun it after changing those files (`make test-scripts` checks it).
  - **Per-account folder**: `Application Support/Playarr/<serverId>/<accountId>/` holds `queue.json`, `pending-plays.json`, `stream/` (stream cache) and, from phase 7, downloads. Phase 3 computes the path; a later phase may move it to `ServerStore.folder(for:)`. From phase 7: `stream/` holds every whole song file (kept as you listen and downloads' songs), with `offline/transitions/`, `offline/resume/` and `offline.json` (the manifest) beside it; `stream/` and `offline/` are excluded from backups. Background download jobs are named by their file's path from `Application Support/Playarr/` (`<serverId>/<accountId>/stream/12.flac`).
  - `PlayarrUI` (phase 4): `AccountSession` is the per-account root (`api: any APISending`, `client`, `player`, `queries: QueryCache`, `images: ImageCache`, `router: AppRouter`, `toasts: ToastCenter`, `actions: TrackActions`); `AppModel.session` is the active one, rebuilt by `syncSession()` on switching. Phases 5–9 hang per-account state on it. Phase 4 also adds `Player.shutDown()` and `NowPlayingBridge.unregister()` so a closed session releases the lock screen. Folders: answers in `Application Support/Playarr/<server>/<account>/queries/`, images in `Caches/Playarr/<server>/<account>/images/`. UI tests launch with `-UITests` (empty store) or `-UITestsDemo` (the in-app `Demo` library served by `DemoAPI`, no server). Shared formatting lives in `Format` (time, duration, plural, bytes, ago); later phases add to it instead of their own copies.
  - Phase 6 adds to `AccountSession`: `favorites` (`FavoritesStore`), `playlists` (`PlaylistsStore`), `mixes` (`MixesStore`), `picking` and `addToPlaylist(_:)`; `Route.listeningRange(StatsRange)`; `Player.live(...like:)` and `NowPlayingBridge.setLiked(_:)`; `DemoState` makes the demo server remember changes. Polling loops use the one `Polling.run(clock:interval:refresh:)` in `PlayarrUI/Support/Polling.swift` (phase 9 reuses it). Shared test helpers (from phase 8): `FakeAPI.queries(_:_:_:)`, `FakeAPI.hold(_:_:until:)` and `Gate`; phase 6 adds only its `Listening` fixtures. Sheets that must also open over Now Playing are attached twice with `active:` (`addToPlaylistSheet(_:active:)`, phase 8's song sheets).
  - `PlayarrUI`: `AppModel` (root state; starts in phase 2 with the server store, browser, app version and redeem link; later phases add to it), `QueryCache` (stale-while-revalidate on disk), `ImageCache`, `Theme` (accent colour).
  - `PlayarrUI` (phase 8): `AccountSession.discover: DiscoverContext` (`@MainActor @Observable`, one per signed-in account, in the signed-in app's environment as `DiscoverContext?`: `api`, `account`, `health`, `gate: RequestGate`, `requests: RequestsModel`, `musicBrainz: MusicBrainzStatusModel`, `sheets: TrackSheets`, `invalidate(_: [CacheFamily])`, `generation(_:)`, `start()`/`stop()`; the account's only health poller, once a minute), `CacheFamily` (the web's query-key names; invalidations are passed on to `QueryCache.invalidate(_:)` by name), `Route.discoverArtist(mbid:album:)`, `.findArtist(name:album:)`, `.requests` with `DiscoverDestination` (lib/links.ts; `.route` is what a link pushes), `AppRouter.search(_:)` (the Search tab with a query), `RequestButton(album:availability:small:)`, `TrackLibraryMenuItems(track:)` (Show metadata, Edit mix points) and `.trackSheets(player:active:)`, `Format.wait` and `Format.jsRound`, `TitleKey`. `FakeAPI` records each call's query and can `hold` an answer until a `Gate` opens; `TestClock.sleeping` counts sleepers. The requesting UI test launches with `-UITestsRequests` (`AppModel.demo(requests: true)`: the demo library plus Lidarr and a request flow, `DemoRequestsAPI`); later flows add their own demo API the same way.
  - `PlayarrPlayer` (phase 7): `DownloadStore` (`@MainActor @Observable`, the account's manifest and downloads; `Player.downloads`), `PinnedDownload` (an album/playlist/mix/Favorites on the device, keys `album:12`, `playlist:3`, `mix:<key>`, `favorites`; `Download` stays phase 3's file fetch), `OfflineManifest`, `KeptFile`, `KeptTransition`, `KeptTransitionFiles`, `OfflineRules`, `OfflineFolder` (the one place the per-account folder is worked out: `OfflineFolder.of(key).root`), `OfflineLimit`, `ByteCount`, `DownloadTransport`/`URLSessionTransport` (`URLSessionTransport.background`, identifier `me.tracklistme.playarr.downloads`, made at launch by the app target's `AppDelegate`), `TransitionPoller`, `KeepAhead`, `OfflinePlayback`, `Player.networkChanged(_:)`, `NetworkMonitor.onChange`; `TrackSource.Origin.kept` (a download's transition continuation, decoded from its file); `TransitionPlanner.kept` and `.onPairChange` are the planner's hooks into the store. `PlayerBackend`'s `transition(_:)` and `transitionRequest(_:)` (phase 5) are what downloads ask transitions with. `PlaybackSettings` keys: `playback.offlineLimit`, `playback.cellularDownloads`.
  - `PlayarrUI` (phase 7): `DownloadButton`, `DownloadItem`, `OfflineMark`, `DownloadsView` (`Route.downloads`, `/downloads`), `OfflineStorageSection` (Settings → Playback → On this device), `KeptForAccount` (the sign-out question), `PinnedDownload.pageKeys` with `QueryCache.setPinned(_:)` (downloads' pages kept on disk as long as the download), `QueryKey.mix(_:)`; the launch argument `-UITestsDownloads` (Debug: `DownloadsDemoView`).
  - `PlayarrPlayer` (phase 8): `Player.preview(_:from:length:)`, `Player.endPreviews()`, `Player.preview` (a second `AudioEngine` while the queue waits paused; never reported as a play; any command of the listener ends it), `Player.previewSeconds` = 8.
  - `PlayarrUI` (phase 9): the server's Settings panels are `SettingsPanel` cases shown by `SettingsPanelView` (`SettingsPanel.server(for: role)`: Sources, Analysis, Requests and Updates for admins; Accounts and Mixes for everyone), each a thin view over a `@MainActor @Observable` model in `UI/Settings/Admin/<Panel>/` (`SourcesModel`, `LidarrFormModel`, `FolderFormModel`, `FolderBrowserModel`, `ReviewModel`, `OrganizeModel`, `MatchingModel`, `MixSettingsModel`, `ListenBrainzModel`, `AnalysisModel`, `RequestSettingsModel`, `UpdatesModel`, `AccountsModel`, `AccountFormModel`). Polling models run `Polling.run` on an injected clock; package tests answer them from `FakeAPI` and follow them with `TestClock`, with sample answers in `PlayarrUITests/Admin/Samples.swift`. `AccountPatch.username` (PlayarrAPI). `AppModel.signInForUITests()` takes `PLAYARR_UITEST_SERVER` and `PLAYARR_UITEST_TOKEN` with `-UITests`.
  - `PlayarrUI` (phase 10): `ShellLayout` (`.tabs`/`.split`, `choose(regularWidth:width:)` at the web's 768 points), `SidebarItem`, `SideColumn`, and on `AppRouter` `layout`/`sidebar`/`detail`/`column`/`focusSearch`, `select(sidebar:)`, `openSearch()`, `setLayout(_:)`; `RouterSnapshot` (kept in `@SceneStorage("router")` by `AdaptiveShell`, which shows `TabShell` or `SplitShell`); `Sidebar`, `SidebarFooter`, `PlayerBar`, `SideColumnView`, `UpNextPreview`; `Route: Codable`; `KeyCommand`/`KeyCommandHandler`/`PlaybackControlling`/`PlayarrCommands` (the web's shortcuts as menu commands); `TrackDrag` (type `me.tracklistme.playarr.tracks`, declared in Info.plist); `QuickPlay` (Siri and Shortcuts: Play my Favorites, Feeling lucky, Start radio; App Intents in `Playarr/Intents/`); `AccountSession+Shell.swift` (favorites and playlists as the shell calls them); accessibility pieces `AdaptiveStack`, `essentialLineLimit()`, `.muted`, `reducesMotion`, `pointerHover()`, `Haptic`, `ArtworkText`; `OfflineAPI` for `-UITestsOffline`.
  - `PlayarrUI` (Now Playing sideways, docs/plans/2026-11-04-ios-now-playing-landscape.md): `NowPlayingLayout` (`.upright`/`.sideways`/`.wide`), `Tracklist` (lines, numbers, joins, end line, time left), `NowPlayingTracklist`, `NowPlayingDeck`, `OrientationPolicy` (the phone's tab pages stay upright, only Now Playing turns; the app delegate answers from it), `ScreenAwake`, and `AppearanceSettings.turnToOpen`/`keepScreenOnSideways`.
- **Contract fixtures**: `RECORD_FIXTURES=1 corepack pnpm -C apps/server exec vitest run src/routes` writes real responses to `apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/Fixtures/`. A new endpoint adds a recording in `apps/server/src/routes/contract.test.ts` and a line in `ContractTests.swift`; `.github/workflows/ios-contracts.yml` fails when models or fixtures are stale.
- **UI tests against a dev server** (`AccountsUITests`) read `TEST_RUNNER_PLAYARR_UITEST_SERVER`, `TEST_RUNNER_PLAYARR_UITEST_ADMIN` and `TEST_RUNNER_PLAYARR_UITEST_PASSWORD`, sign in through the server's API and hand the app the token; they're skipped without them (CI). Identifiers: `settings` (in the account menu), `settings.<panel>`.
- In Claude's shell, xcodebuild needs `-IDEPackageSupportDisableManifestSandbox=YES` and `OTHER_SWIFT_FLAGS=-Xfrontend -disable-sandbox`, and `swift build`/`swift test` need `--disable-sandbox` (SwiftPM's sandbox can't start inside it), and xcodebuild needs `OTHER_SWIFT_FLAGS=$(inherited) -Xfrontend -disable-sandbox` once the app uses macros (`@Observable`: the compiler can't sandbox its macro plugins either); the Makefile and `release.mjs` already pass them.
- Tests: XCTest-free Swift Testing (`import Testing`, `@Test`, `#expect`) in packages; XCUITest for UI tests.
- Files: one primary type per file, named after it. No force unwraps outside tests.
- Indentation: hand-written Swift uses 2 spaces (phase 0's style); the generated models keep the generator's 4.
- View models never take `APIClient` directly: they take `api: any APISending` (`protocol APISending: Sendable { func send<T: Decodable & Sendable>(_: Endpoint<T>) async throws -> T }`, with `extension APIClient: APISending {}`), and polling ones take `clock: any Clock<Duration> = ContinuousClock()`. Shared test doubles live in `Packages/PlayarrUI/Tests/PlayarrUITests/Support/`: `FakeAPI` (answers by method and path, records bodies) and `TestClock` (`nextSleep()`, `advance(by:)`). Whichever phase is implemented first adds them (the phase 9 plan has the code); later phases reuse them, never duplicate.
- Accessibility: put `.accessibilityLabel` on the Button or NavigationLink itself; never `.accessibilityElement(children: .ignore)` around a button (it makes an untappable wrapper for VoiceOver and UI tests).
- Navigation: every page a tab stack or the iPad detail column can show is a `Route` case (phase 8 added `.discoverArtist`, `.findArtist`, `.requests`), and destinations are registered in one place, `shellDestinations(_:)` (phase 10), so tabs and the iPad split view both get them.
- Layout and look (phase 10): every control at least 44 pt (`.contentShape` after the frame); secondary text uses `.muted`; text drawn on artwork goes through `ArtworkText`. UI tests run on a simulator of their own, and tab-bar flows call `skipOnIPad()`. Stable identifiers include `sidebar.*`, `playerBar*`, `sideColumn`, `nowPlaying.upNext`; launch arguments `-UITests`, `-UITestsDemo`, `-UITestsRequests`, `-UITestsDownloads`, `-UITestsOffline`, `-UITestsLongQueue`, `-UITestsRestore`.
- User-facing text follows the web's wording (copy it from the web component cited in the parity checklist). Where the web names the browser, say "this device" (e.g. "This file format is not supported on this device").

## Commits

Each task commits on `main`, only that task's files, with a plain-English subject in the style of the history (no `feat:` prefixes) and the `Co-Authored-By: Claude <noreply@anthropic.com>` line. The pre-commit hook bumps the version; never bypass it. The user pushes.
