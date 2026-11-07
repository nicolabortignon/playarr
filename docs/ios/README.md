# The iOS app

Playarr's native app for iPhone and iPad: SwiftUI, its own audio engine on `AVAudioEngine`, and no third-party code. It talks to the same server as the web app and does nearly everything the web app does. It lives in `apps/ios`, outside the pnpm workspace (it has no `package.json`); the root `package.json`'s `pnpm ios:*` scripts call its `Makefile`.

More detail:

- [conventions.md](conventions.md): names, folders, commands, test doubles and launch arguments. Read it before changing the app.
- [layouts.md](layouts.md): the iPhone, iPad and iPhone Duo layouts in detail.
- [audio-engine.md](audio-engine.md): playback, levels and DJ transitions.
- [offline.md](offline.md): downloads, the stream cache and playing without a connection.
- [release.md](release.md): TestFlight, the App Store and the scripts behind them.
- [../server/accounts-and-access.md](../server/accounts-and-access.md): accounts, sessions, setup codes and Bonjour on the server side.

---

## 1. Targets and packages

`apps/ios/project.yml` is an XcodeGen spec. Every `make` target that builds regenerates `Playarr.xcodeproj` from it, so the project is never committed and added or removed files are picked up. Versions, team and bundle id are in `Config/Base.xcconfig`.

| Part | What it owns |
|---|---|
| `Playarr` (app target) | `PlayarrApp.swift` (picks a live, empty or demo `AppModel` from the launch arguments), `AppDelegate.swift` (the background download session, the orientation mask), `Intents/` (App Intents), the asset catalog. `Config/` holds `Info.plist` and the entitlements. |
| `Packages/PlayarrAPI` | Talking to servers: the generated models, `Endpoint<T>` and every call as `API.<Feature>.<call>()`, `APIClient`, `ServerStore`, Keychain tokens, Bonjour (`ServerBrowser`), `MediaURLs`. No dependencies. |
| `Packages/PlayarrPlayer` | Playback: the queue, the audio engine and its decks, levels, transitions, play reports, radio, the sleep timer, the lock screen, the stream cache and downloads. |
| `Packages/PlayarrUI` | Every screen and component, the per-account session, the query and image caches, the shell, the demo library, the web's fonts (`Fonts/`). |
| `PlayarrUITests` | XCUITest flows, the accessibility audits, `ScreenTour` (`make screens`) and `StoreScreenshots` (`make screenshots`). |

Dependencies point one way: the app target depends on `PlayarrUI`; `PlayarrUI` on `PlayarrPlayer` and `PlayarrAPI`; `PlayarrPlayer` on `PlayarrAPI`. Each package declares iOS 26 and macOS 26, so `swift test` runs its tests on the Mac without a simulator.

## 2. Talking to the server

### Requests

Every call is an `Endpoint<T>` (method, path, query, body) built by a function in `PlayarrAPI/Sources/PlayarrAPI/Endpoints/API+<Feature>.swift`, and sent by `APIClient` (an actor, one per server and account, or one for nobody to sign in with):

- every request carries `X-Playarr: 1` and, when signed in, `Authorization: Bearer <token>`;
- an error answer becomes an `APIError` (`.unauthorized`, `.server(status:message:)`, `.offline`, `.decoding`). A 401 to a request that carried the token means the session has ended: `ServerStore` marks the account signed out and keeps it listed to sign in again;
- when a server has a public address (`ServerInfo.publicUrl`) and was also reached at home, `ServerRecord.baseURL` is the public one and `localURL` the home one. A request that can't connect to one is tried once at the other, and whichever answered goes first afterwards (for routers without NAT loopback).

View models never hold an `APIClient`: they take `api: any APISending`, which tests answer with `FakeAPI` and the demo with `DemoAPI`.

Songs, transitions and images are fetched through `MediaURLs`, which puts the token in a header and never in a URL. `ServerAddress` turns what someone typed into a base URL: plain HTTP only for local names and private addresses (as `NSAllowsLocalNetworking` allows), HTTPS for everything else.

### Generated models

`PlayarrAPI/Sources/PlayarrAPI/Models.generated.swift` is generated from the server's TypeScript types by `apps/ios/scripts/gen-models.mjs` and committed. Change the TypeScript, then run `pnpm ios:models` (`make models`); `make models-check` fails when the file is out of date. The script needs the root's `pnpm install` (`ts-json-schema-generator` is a root devDependency).

It reads every exported type from `packages/shared/src/index.ts` and `packages/mix/src/types.ts` into JSON Schema, then writes Swift by these rules:

- An interface or object type becomes a `public struct` that is `Codable, Hashable, Sendable`, and `Identifiable` when it has a non-optional `id`. It gets a memberwise `init` with optional fields defaulting to `nil`. JSDoc comments become `///` comments.
- An optional property becomes `T?`, and so does `T | null`. A property that is both becomes `T??`: `nil` leaves it out, `.some(nil)` sends `null`, as patch bodies need. A required but nullable property (`Account.sources`) is always encoded, `null` included.
- A string literal union becomes an enum with a `case unknown(String)`, so a value the server adds later still decodes. `"none"` becomes `.noneValue` (`.none` would read as `Optional.none`). A type may not use `"unknown"` as a value.
- A union of objects tagged by one string property (`TransitionAnswer.status`) becomes an enum with associated values, plus `case unknown(String)`.
- A numeric literal union becomes `Int`, and `true` or `false` alone becomes `Bool`.
- A `number` becomes `Double`, except `id`, names ending in `Id`, `Ids` or `Count`, and the names in the script's `INTEGERS` list, which become `Int` (what the server stores as SQLite integers). A new whole-number field with another name goes into `INTEGERS`.
- `Record<string, T>` becomes `[String: T]`; arrays and tuples become `[T]`.
- An inline object type becomes a nested struct named after its property, with `Item` added inside arrays and `Value` inside records. A nested name that would hide a top-level type stops the script: rename the property.
- Any other union, or a shape it can't map, stops the script with the property's name. So does a name exported by both inputs. Anything else (an alias to a primitive or an array) becomes a `typealias`.
- Swift keywords used as names are escaped with backticks. `parseRange`, `ByteRange` and `wavFallbackOf` are skipped (exported, but not part of the API: the script's `SKIP` list).
- `packages/mix`'s `MIX_MAP_VERSION` is written as `public let mixMapVersion`.

**Contract tests.** The server's route tests record real answers when run with `RECORD_FIXTURES=1` (`apps/server/src/routes/contract.test.ts`, through `apps/server/src/testing/recordFixture.ts`) into `PlayarrAPI/Tests/PlayarrAPITests/Fixtures/`. `ContractTests.swift` decodes each one into its generated type, so a change on either side fails `swift test` until the other follows. A new endpoint adds a recording to `contract.test.ts` and a line to `ContractTests.swift`. No CI job checks that the models or the fixtures are up to date with the TypeScript: run `make models-check` and re-record after changing the shared types or the routes.

### Finding servers and signing in

`RootView` shows one of four things: adding a server, signing in again (an account whose session ended), "update required" (the server's `minAppVersion` is newer than `AppVersion`), or the signed-in app.

1. **Finding a server.** `WelcomeView` lists the servers `ServerBrowser` finds on the home network (Bonjour `_playarr._tcp`, which shows the Local Network prompt), or takes an address.
2. **Asking who it is.** `AddServerModel` calls `GET /api/server`. A server in setup mode goes to `SetupView` (its owner claims it, from the home network only); otherwise `SignInView`.
3. **Setup codes.** An admin's `playarr://redeem?server=<origin>&code=<code>` link (`RedeemLink`) opens `RedeemView`, where the account sets its first password.
4. **Keeping the session.** `ServerStore` saves the servers and their accounts in `Application Support/Playarr/servers.json` (`ServerRecord`, `AccountRecord`, no secrets) and each token in the Keychain (`KeychainSecretStore`, one item per `<serverId>:<accountId>`, readable after first unlock so playback and downloads go on while the phone is locked).

**Many accounts.** The app keeps several servers, each with several signed-in accounts. The account button at the top right of every tab (`AccountMenu`) opens `AccountSwitcherView`: switch with a tap and no password, add an account or a server, sign out. Each signed-in account gets an `AccountSession` (its API, player, query and image caches, router, toasts, favorites, playlists, mixes, Discover state), and `AppModel.syncSession()` closes the old one and opens the new one on every switch. Each account's data lives in its own folder: `Application Support/Playarr/<serverId>/<accountId>/` and `Caches/Playarr/<serverId>/<accountId>/images/`.

## 3. The app shell

`AppShell` is the signed-in app: `AdaptiveShell` picks the layout from the window's width (`ShellLayout`, at the web's 768-point desktop breakpoint) and switches as the window is resized without losing the page.

- **iPhone, and narrow iPad windows** (`TabShell`): tabs Home, Search, Library and Queue, each a stack of pages, with the mini player (`MiniPlayer`) above the tab bar.
- **iPad** (`SplitShell`): the desktop web's sidebar (`Sidebar`), the page, a side column for the queue or lyrics (`SideColumnView`), and the player bar (`PlayerBar`) along the bottom: with nothing playing, the album heard last with Resume and Feeling lucky (`IdlePlayerBar`); out of the way while the screen's keyboard is up. Keyboard shortcuts with a hardware keyboard (`PlayarrCommands`), and drag and drop of songs (`TrackDrag`).
- **iPhone Duo**: on the cover screen the system's tabs and bar buttons stand in a column on the right; pages' backgrounds run under it and their content keeps clear of it (`UnderTheRail`). Opened, Now Playing lays out along the fold (`Fold`).
- **Now Playing** (`NowPlayingView`) covers everything, swiped down to close: lyrics, the sleep timer, the transition sheet, up next. On the iPhone it also turns sideways.

Every page is a `Route`, registered once in `shellDestinations(_:)` so tabs and the iPad's detail column both show it. Where the app is (`RouterSnapshot`) is kept in the scene's storage, so a window iOS closed in the background comes back where it was. All of this is in [layouts.md](layouts.md).

## 4. The demo library

`PlayarrUI/Sources/PlayarrUI/Demo/` is a server in memory, for UI tests, screenshots and view-model tests. It isn't something a user can open: the only way in is a launch argument (`PlayarrApp.makeModel()`).

- `-UITestsDemo` makes `AppModel.demo()`: signed in as "Demo" to a demo server answered by `DemoAPI` from the `Demo` library (Massive Attack, and Portishead without a photo of their own; three albums, lyrics, a mix, a playlist and a favorite). Nothing is kept: a temporary folder and a `UserDefaults` suite of its own.
- `DemoState` remembers changes between calls, so tests can heart a song and make, fill, reorder and delete a playlist.
- `DemoPlayerBackend` and `SilentSource` let the real player run on silence: time moves and songs end with no server and no sound. The demo has no analysis, so DJ mix cuts or plays gapless.
- `DemoArt` draws each cover and artist photo from its address. `make screens` alone puts the albums' real covers in instead, from `PLAYARR_DEMO_COVERS` (see [release.md](release.md)).
- Variants: `-UITestsRequests` (`DemoRequestsAPI`: Lidarr and an album to request), `-UITestsOffline` (`OfflineAPI`: a server that can't be reached), `-UITestsLongQueue` (5,000 songs queued), `-UITestsManyPlaylists`. The full list is in [conventions.md](conventions.md).

## 5. App Intents

`Playarr/Intents/` has three `AudioPlaybackIntent`s, so they play without bringing the app to the front: Play my Favorites, Feeling lucky (15 songs for this hour), and Start radio from the current song. `PlayarrShortcuts` gives Siri their phrases and the Shortcuts app their actions. They find the app's `AppModel` through `AppDependencyManager` (registered in `PlayarrApp.init`) and call `QuickPlay` in `PlayarrUI`, the same code as the buttons in the app; a failure is spoken as `QuickPlay.Failure`'s text ("Open Playarr and sign in first.").

## 6. Parity with the web

The app was built against an inventory of everything the web app does (every route, setting, endpoint and player rule). Today it covers:

- every page: Home, Search, Library (Artists, Albums, Favorites, Playlists, Made for you, Downloads), Artist, Album, Playlist, Mix, Queue, Your listening, Requests, and Discover's artist pages for artists not in the library;
- every sheet: Add to playlist, the playlist cover picker, Show metadata, Edit mix points, the transition sheet, Stats for nerds;
- playback as on the web: gapless, even volume, crossfades and DJ transitions, radio, the sleep timer, play reports, lyrics, the lock screen;
- Settings: Playback and Appearance per device; Accounts and Made for you for everyone; Sources, Analysis, Requests and Updates for admins to change and members to read;
- offline downloads, which the web does through its service worker.

What differs on purpose: accounts replace the web's old profiles; user-facing text follows the web's (and [design.md](../design.md)'s Words where the two differ), with "this device" where the web names the browser; keyboard shortcuts only with a hardware keyboard on an iPad.

## 7. Building and testing

| Command | What it does |
|---|---|
| `pnpm ios:bootstrap` | Download the pinned, checksummed XcodeGen into `apps/ios/.tools/` and generate the project |
| `pnpm ios:build` | The design check, then a simulator build |
| `pnpm ios:test` | The design check, the scripts' tests (`node --test`), `swift test` in each package, then the UI tests on a simulator |
| `make -C apps/ios design-check` | The design check alone (`scripts/check-design.mjs --app ios`) |
| `make -C apps/ios test-packages` | The package tests only: quick, no simulator |
| `make -C apps/ios test-app ONLY="IPadLayoutTests"` | Only those UI test classes |
| `pnpm ios:screens` | Screenshots of the main views on the demo library, in `screenshots/` at the repo root |
| `pnpm ios:device` | Build and install on a paired iPhone |

Release targets are in [release.md](release.md); every target is listed at the top of `apps/ios/Makefile`.

Notes:

- **The design check.** Colors, type sizes and radii come from `PlayarrUI/Theme/` by role ([design.md](../design.md)): `make build` and `make test` (and so CI) first run `scripts/check-design.mjs --app ios`, which fails on a `Color(red:)`, a `.system(size:)` or a literal `cornerRadius:` anywhere else in `PlayarrUI`, naming the file and the line. Use the tokens (`Radius.*`, the type roles, `IconRole` for a glyph in something of a fixed size, the palette), add one in `Theme/` where a size has a real role, or add the file to the script's `ALLOW` with the reason (today the energy charts' bars). Its tests are `scripts/check-design.test.mjs`, which `make test-scripts` runs.
- **Sandboxed shells** (Claude's): SwiftPM and the compiler can't start their own sandboxes inside another, so `swift test` needs `--disable-sandbox` and `xcodebuild` needs `-IDEPackageSupportDisableManifestSandbox=YES` and `-Xfrontend -disable-sandbox`. The Makefile and `release.mjs` already pass them. Swift and Xcode commands also need the shell's own sandbox off.
- **Which simulator.** `SIMULATOR` picks one by name (default "iPhone 17 Pro"); without one by that name, the first available iPhone. This Mac has two "iPhone 17 Pro"s and the Makefile takes the first listed, on iOS 26.3; to use the iOS 26.5 one, pass its id: `make -C apps/ios test SIMULATOR_ID=<id>` (from `xcrun simctl list devices available`).
- **UI tests run on a simulator of their own**: parallel runs on a shared one break each other. `make screens` makes "Playarr Screens iphone", "ipad" and "duo" (and "se" when asked for); the iPhone Duo needs its own iOS 27 runtime.
- **Drags.** XCUITest drags don't reach SwiftUI's list reordering on the simulator, so the playlist UI test only checks the reorder handles; `PlaylistModelTests` covers the move.
- **Against a dev server.** `AccountsUITests` signs in to a real server when given `TEST_RUNNER_PLAYARR_UITEST_SERVER`, `_ADMIN` and `_PASSWORD`, and is skipped without them (as in CI).
- **CI** runs `make test` on every push and pull request that changes `apps/ios`; see [release.md](release.md).
