# Native iOS app, Phase 8: Discover, Requests, Metadata and Mix Points Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** The library features the web has, in the app: Search's "Not in your library" (songs, albums and artists from MusicBrainz, Lidarr and Deezer, each with request controls), the Discover artist page and the Find artist lookup, "Not in your library" on an artist, "Request the rest" on an album, and the request buttons phase 6 left on recommendations; one Request button with every state; the Requests page with live progress; requests polled (10 s while one is on its way, 60 s otherwise) with "“Title” is ready to play" when one lands, and a notification when that happens while the app plays in the background; the MusicBrainz queue on the Library page; Show metadata; and Edit mix points with 8-second previews that leave the queue alone. Phase 8 ends with parity for library features.

**Architecture:** Everything is in `PlayarrUI` except the previews, which are a small addition to phase 3's `Player`. One `DiscoverContext` per signed-in account (`@MainActor @Observable`, in the SwiftUI environment) holds the server's health (does it have Lidarr, may this account request), a `RequestsModel` (polling, requesting, removing, noticing requests that landed), a `MusicBrainzStatusModel`, Discover's short-lived answers (kept as long as the web keeps them), the song sheets (`TrackSheets`), and a generation counter per family of answers (`CacheFamily`, named after the web's query keys) that views reload on and that is passed on to phase 4's cache. Pure types carry the web's rules and words so they are tested without a screen: `RequestButtonState`, `RequestGate`, `RequestPolling`, `RequestWatch`, `Discography`, `DiscoverDestination` (lib/links.ts), `MetadataFormat`, `MixGrid`, `EnergyLayout`, `MixPointsEditor`. Waiting goes through a `Sleeper`, so polling and debouncing are tested with a fake clock. Previews play on a second `AudioEngine` while the queue's engine is paused where it is.

**Tech Stack:** Swift 6 language mode with strict concurrency (tools version 6.2; checked with Xcode 27.2 / Swift 6.4.2 on macOS 26), SwiftUI, Observation, UserNotifications, Synchronization (`Mutex`, tests), Swift Testing, XCUITest. No third-party code.

**Design:** [2026-11-03-ios-app-design.md](2026-11-03-ios-app-design.md): Rollout phase 8 ("Requests on iOS: same in every build, gated by the server switch and the account's right"). Names and layout: [2026-11-03-ios-conventions.md](2026-11-03-ios-conventions.md). What to port: [2026-11-03-ios-parity-inventory.md](2026-11-03-ios-parity-inventory.md), section 6 (Discover, search and requests), the Show metadata and Edit mix points overlays of section 1, the MusicBrainz status of section 6, and the web files cited in each task.


> **Coordinator's note (2026-11-03), read before Task 1:** the conventions (written after this plan) fix the shared seams: view models take `api: any APISending` and, for polling and debouncing, `clock: any Clock<Duration> = ContinuousClock()`; tests use the shared `FakeAPI` and `TestClock` from `PlayarrUITests` (added by phase 4, or phase 9's Tasks 1–2 if phase 4 didn't). Where this plan defines `Sleeper`, `ScriptedSleeper` or `ManualSleeper`, use the clock and `TestClock` instead (same behaviour: `sleep(for:)` and advancing time), and reuse `FakeAPI` rather than a new fake. Move `FakeServer` into `Tests/PlayarrUITests/Support/` if it isn't there yet. Hand-written Swift uses 2-space indentation. Health polling: reuse a single app-wide poller if phase 4 created one.

> **As built (Task 0's findings on main after phase 5, 2026-11-03).** Phases 0–5 are implemented; phase 6 isn't. Phase 4 and 5 named things differently from the "Before you start" table, so the tasks below were built against the real names; each task ends with an **As built** note for its own differences. The mappings used throughout:
>
> | This plan | On main |
> |---|---|
> | `client: APIClient`, `FakeServer`/`fakeClient`, `jsonText` | `api: any APISending`; tests use `FakeAPI` (now records each call's query, and `hold(_:_:until: Gate)` keeps an answer back) |
> | `Sleeper`, `ScriptedSleeper`, `ManualSleeper` | `clock: any Clock<Duration> = ContinuousClock()`; tests use `TestClock` (`nextSleep()`, `advance(by:)`) |
> | `TextFormat.clock/plural/wait/jsRound`, `ServerDate.parse` | `Format.time/plural` (phase 4), `Format.wait` and `Format.jsRound` (added here), `Format.parseDate` |
> | `AppModel.discover`, `AppModel.player/toasts/cache` | `AccountSession.discover` (the per-account root), `session.player`, `session.toasts` (`ToastCenter.push(_:tone:)`), `session.queries` (`QueryCache.invalidate(_ name:)`) |
> | `DiscoverDestination` pushed with `.discoverDestinations()` | Tab stacks are typed `[Route]`: `Route` gains `.discoverArtist(mbid:album:)`, `.findArtist(name:album:)`, `.requests`; `DiscoverDestination.route` maps to it and `RouteDestination` shows the pages |
> | `ArtistPage`, `AlbumPage`, `libraryArtistPage`/`libraryAlbumPage` closures | `Route.artist(id)`, `Route.album(id)` through `RouteDestination` |
> | `CoverImage(path:size:)` / `DiscoverCover` | `Cover(path:points:label:circle:)` |
> | `AppModel.openSearch(_:)` | `AppRouter.search(_:)` (Search tab, query handed to `SearchView`) |
> | `DiscoverSectionHeader`, `DiscoverShelf` | phase 4's `SectionHeader`, `Shelf`, `Kicker`, `Skeleton` |
> | `EnergyLayout` | phase 5's `EnergyPicture.phrasesAndBars(_:clock:from:to:)` and `heardHeight(_:)` |
> | `UITestServer` (`PLAYARR_UI_STUB=requests`) | `DemoRequestsAPI` behind the launch argument `-UITestsRequests` (the demo library plus Lidarr and a request flow), like phase 4's `-UITestsDemo` |
> | Phase 6's recommendation row | not built yet: a `// Phase 6:` TODO marks where its Request button goes |
>
> No app-wide health poller existed (phase 4's Library page asks for health itself), so `DiscoverContext` polls health once a minute for the account. `Player.mixPointsChanged(recordingId:)` exists (phase 5). `FakeServer` moved to `Tests/PlayarrUITests/Support/`.

---

## Before you start

Phases 2 to 7 are done. **Phases 4 to 7 were planned in parallel with this one, and their plans didn't exist when this was written**, so this plan assumes the names below. Task 0 checks each one with a grep. Only the files listed after each name use it; if a phase named something differently, change it there and nowhere else.

**Phase 2** (`docs/plans/2026-11-03-ios-phase2-api-sign-in.md`), used as written there:

- Generated models: `AlbumRef`, `AlbumRequest`, `Availability`, `AvailabilityState` (`.noneValue`, `.unknown(String)`), `DiscoverResults`, `DiscoverAlbum`, `DiscoverArtist`, `DiscoverArtistDetail`, `DiscoverTrack`, `ArtistMatch`, `HealthStatus` (`lidarr: HealthStatus.Lidarr?`, `requests: Bool`), `MusicBrainzStatus` (`etaSeconds: Double`), `TrackMetadata` (with `TrackMetadata.Analysis`), `TrackCopyMetadata` (`.source: TrackCopyMetadata.Source`, `.match: TrackCopyMetadata.Match?`), `FileTags`, `RematchResult` (`.folder(RematchResult.Folder)` with `state: RematchResult.Folder.State` and `trackId: Int?`, `.lidarr(RematchResult.Lidarr)`, `.unknown`), `MixMapEntry` (MixMap's fields flattened, plus `cues: CuePoints?`), `CuePoints`, `Album`, `AlbumDetail`, `ArtistDetail`, `Account` (`canRequest`, `role`), `RecommendedTrack`, `Track`, `AudioFormat`, `SourceKind`, `mixMapVersion`. These were checked by generating `Models.generated.swift` with phase 2's own `gen-models.mjs` from today's types plus phase 2's Task 1 additions.
- `APIClient(baseURL:token:session:)` and `send(_:)`; `API.Discover.search(_:)`, `.artist(mbid:)`, `.similarArtists(mbid:)`, `.findArtist(name:)`; `API.Requests.list()`, `.request(_:)`, `.remove(mbid:)`; `API.Server.health()`, `.musicBrainzStatus()`; `API.Library.trackMetadata(id:)`, `.rematchFile(fileId:)`; `API.Playback.mixMaps(ids:)`, `.setCues(recordingId:mixIn:mixOut:)`. Errors read through `localizedDescription` (an `APIError.server` is the server's own message).
- `ServerStore(directory:secrets:session:)`, `.signedIn(_:server:at:)`, `.active`, `.activeAccount`, `.activeClient`; `InMemorySecretStore`; `ServerInfo`, `SignInResponse`; `AppModel(store:browser:appVersion:device:)` and `AppModel.live()` in `PlayarrUI/AppModel.swift`; the `FakeServer` URL protocol in `PlayarrUI/Tests/PlayarrUITests/AddServerModelTests.swift` (this plan's tests use it).

**Phase 3** (`docs/plans/2026-11-03-ios-phase3-audio-engine.md`): `Player` (its private `makeEngine`, `gainDb(_:)`, `sync()`, `change(_:)`, `session`, `notice`, the 10 Hz `tick`), `AudioEngine` (`load(_:playing:)`, `pump()`, `position`, `stop()`, `pause()`, `onEvent`), `EngineItem`, `EngineEvent`, `PlaybackError.message`, `PlaybackSettings.transitions` (`.dj`), and the test helpers `Player.testing(_:)`, `Player.play(for:)`, `FakeBackend`, `song(_:)`, `AudioEngine.render(seconds:)`. Task 17 edits `Player.swift`; its replacements were applied to phase 3's code as written in its plan, and phase 3's tests still pass.

**Phase 4** (assumed):

| Name | What | Used only in |
|---|---|---|
| `CoverImage(path: String?, size: Int)` | A cover or picture from a server path, through the image cache, at `?size=` | `Discover/DiscoverCover.swift` |
| `ArtistPage(id: Int)`, `AlbumPage(id: Int)` | The library's artist and album pages | `Discover/AppModel+Discover.swift` |
| `AppModel.player: Player?` | The active account's player | `Discover/AppModel+Discover.swift`, `Discover/DiscoverRoot.swift` |
| `AppModel.toasts.show(_ text: String, isError: Bool)` | A toast, shown as accessible text | `Discover/AppModel+Discover.swift` |
| `AppModel.cache: QueryCache?`, `QueryCache.invalidate(prefix: String)` | The disk cache of answers, keyed like the web's query keys | `Discover/AppModel+Discover.swift` |
| `AppModel.openSearch(_ query: String)` | Switches to the Search tab with a query | `Discover/AppModel+Discover.swift` |
| The Search page, the Artist page, the Album page, the track ⋯ menu, Now Playing's ⋯ menu, the Library page, each tab's `NavigationStack`, the signed-in root view | Where Task 21 puts this phase's parts | Task 21 |

**Phase 5** (assumed): `Player.mixPointsChanged(recordingId: String)`: forgets the song's mix map and asks again for a coming transition planned with the old points (the web's `forgetMixMap` and `refreshUpcomingTransition`). Used only in `Discover/AppModel+Discover.swift`. Without it, saving still works; a transition already planned keeps the old points until the next one.

**Phase 6** (assumed): the recommendation row ("Songs like these") leaves a slot for a request button. Used only in Task 21.

**Phase 7:** nothing. Discover and requests need the server; offline they show the server's error, as the web does.

## Key decisions

**1. Previews play on a second engine while the queue waits paused.** Two ways were weighed for Edit mix points' "Play from" (8 seconds from a marker). *Pausing the queue and restoring it* by loading the preview into the queue's own engine and loading the queue's song back afterwards would cost a new epoch and 2 s of decoding on the way back, throw away the next song already placed and (from phase 5) a transition file already scheduled on the transition node, and need every other subsystem (play tracker, radio, Now Playing, saving the queue) told to look away. The web's way, inserting the song after the current one and jumping to it, changes the queue, its "Playing from" and its history, and reports the auditioned song as a skip. So **a separate preview path**: `Player.preview(_:from:length:)` pauses the queue (`AVAudioEngine.pause()` freezes all its nodes on one sample and keeps every buffer they have, so play goes on from that exact sample) and plays the song on a second `AudioEngine` made by the Player's own factory (same sources, cache, levels and limiter). After 8 s of audio the preview stops and the queue keeps waiting, so several previews in a row don't let the music burst back in between; closing the sheet calls `endPreviews()`, which plays the queue again if it was playing before the first preview. Any command of the listener (play, pause, Next, a seek, a new queue, the lock screen) ends the preview and does what they asked. A preview is never reported as a play. Cost: one more `AVAudioEngine` while previewing (two engines in one audio session is supported; only one runs at a time).

**2. A local notification when a request lands in the background: in scope, and small.** iOS keeps the app running in the background only while it plays (background audio), and that is exactly when someone who requested an album has the phone in a pocket. The polling already runs then, so the notification is about 40 lines (`LocalRequestNotifier`) with no new capability or entitlement. Permission is asked the first time the listener requests an album, when the reason is plain. On screen, the toast says it instead. Out of scope, deliberately: Background App Refresh (iOS runs it when it likes, often hours later, so it would promise what it can't keep) and server push (the server has no APNs). Tapping the notification opens the app where it was.

**3. Request buttons follow the web's rule for "requests off".** With no Lidarr, requests off in Settings, or an account without `canRequest`, the states that would ask (Request, Search again, Retry, the partial album's Request) are hidden, while progress on earlier requests and "In library" still show, as the web's RequestButton does. `RequestGate` reads `health.requests` (the server already folds Lidarr, the Settings switch and this account's right into it, phase 1) and `Account.canRequest` too, so a change of rights shows before the next health check. Until health is known nothing the account may use is hidden (the web's `useRequestsEnabled`). Removing a request from the list needs only `canRequest` (the server's guard).

**4. Polling follows what's on screen.** Requests are polled for as long as the account is signed in, every 10 s while any is searching, downloading or importing and every 60 s otherwise, and once more as soon as the app comes back on screen (it may have been suspended). Health is asked every minute. The MusicBrainz queue is asked every 1.5 s while lookups wait and every 15 s otherwise, but only while a view that shows it is on screen (`SlowLookup`, the Library page's indicator): the loop runs in that view's `.task`.

**5. Answers: in memory, with the web's lifetimes; invalidation by generation.** Discover's answers are kept as long as the web keeps them (search and discographies a minute, similar artists an hour) and are not written to disk (the web doesn't persist them either). A change (a request made or landed, a match again, mix points saved) invalidates families of answers by the web's query-key names: `DiscoverContext.invalidate(_:)` bumps a counter that this phase's views reload on (`.task(id: context.generation(.discoverArtist))`) and passes the names on to phase 4's cache.

**6. Edit mix points on a touch screen.** A drag snaps to bars (to whole seconds without a beat), as the web's pointer drag does. The keyboard's Shift (a phrase) and PageUp/PageDown become step buttons on each point's card: back a phrase, back a bar, on a bar, on a phrase (10 s and 1 s without a beat). VoiceOver's swipe up and down on a marker moves it a bar. The In handle sits above the strip and the Out handle below, each in a 44-point row, so they never collide. The hint's wording changes accordingly ("drag one, or step it a bar or a phrase with its buttons"); everything else is the web's text. Save and Cancel sit in the sheet's toolbar; Reset under the cards.

**7. Find artist resolves in place.** The web redirects (`<Navigate replace>`). A SwiftUI navigation path can't swap its last element from inside the page, so `FindArtistPage` shows what the name leads to in its own place once looked up.

**8. Seams.** This phase names phase 4 to 6 things in three files and Task 21's slot edits only: `DiscoverCover.swift` (phase 4's image view), `AppModel+Discover.swift` (phase 4's pages, toasts, cache, player and Search; phase 5's hook), `DiscoverRoot.swift` (the player). Everything else talks to `DiscoverContext`, which the app fills in.

**9. The requesting UI test runs against a pretend server inside the app.** In Debug builds, launching with `PLAYARR_UI_STUB=requests` signs the app in to `UITestServer`, a `URLProtocol` that answers the few endpoints the flow touches (Lidarr present, one album to find, a request that lands on the second look at the requests). It needs no dev server, no Lidarr and no network, so it runs in CI. Its flow is also unit-tested (`UITestServerTests`), so a failure in the UI test points at the UI.

## Conventions

- Run everything from the repo root, `/Users/bortignon/dev/playarr`.
- PlayarrUI's tests: `swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter '<Suite>|<Suite>'`. The player's: the same with `apps/ios/Packages/PlayarrPlayer`. `--disable-sandbox` because SwiftPM's sandbox can't start inside Claude's shell; the Makefile passes it too. Everything, the UI test included: `make -C apps/ios test` (`corepack pnpm ios:test`).
- The package alone for iOS, quicker than the app and without Xcode (a bare `xcodebuild` of the package fails in Claude's shell because the `@Observable` macro plugin can't be sandboxed there; the Makefile's own `xcodebuild` passes `-Xfrontend -disable-sandbox` for that): `swift build --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --scratch-path /tmp/playarr-ios-build --triple arm64-apple-ios26.0-simulator --sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)"`. It compiles the UIKit branches. The app itself: `make -C apps/ios build`.
- Swift: 2-space indentation, like phase 0's and phase 3's files (phase 2's PlayarrUI files use 4; leave them as they are, and keep 4 in the lines this plan adds to `AppModel.swift`). One primary type per file, named after it. No force unwraps outside tests. `@MainActor @Observable` for UI state. User-facing text is the web's, from the component each task cites.
- Tests: Swift Testing. Fakes: phase 2's `FakeServer` for the server, `ScriptedSleeper` and `ManualSleeper` (Task 1) for time.
- Commit after every task, on `main`, only that task's files, with the message given (plain English, ending with the `Co-Authored-By` line). The pre-commit hook bumps the version: never bypass it. The user pushes.

## What was verified while writing this plan

All the Swift below was compiled and its tests run, task by task in this order (each task's build and tests on top of the ones before it), in a scratch copy of `apps/ios/Packages`: phase 2's and phase 3's code extracted from their plans (with phase 3's Task 15 replacements applied), `Models.generated.swift` made by phase 2's `gen-models.mjs` (with `ts-json-schema-generator` 2.9.0) from today's `packages/shared` and `packages/mix` plus phase 2's Task 1 additions, and stand-ins for the phase 4 and 5 names in the table above. Results: PlayarrUI 89 tests passed (84 of this phase and phase 2's 5); PlayarrPlayer 105 passed (the 98 of phase 3's tests that its plan spells out as whole files, and this phase's 7); PlayarrUI also builds for the iOS 26 simulator (the triple build above). The slot snippets of Task 21 were type-checked inside stand-in views. The XCUITest was type-checked against the iOS simulator's XCTest; it was not run (it needs phase 4's screens). Not run either: anything on a device.

---

### Task 0: Check the starting point

Read-only: find out whether the names this plan assumes exist, before writing anything.

**Files:** none.

**Step 1: Phases 2 and 3**

```bash
P=apps/ios/Packages
grep -c "public struct MixMapEntry\|public enum RematchResult\|public struct DiscoverArtistDetail\|public struct MusicBrainzStatus" $P/PlayarrAPI/Sources/PlayarrAPI/Models.generated.swift
grep -n "static func similarArtists\|static func findArtist\|static func remove(mbid\|static func musicBrainzStatus\|static func rematchFile\|static func setCues" -r $P/PlayarrAPI/Sources/PlayarrAPI/Endpoints
grep -n "final class FakeServer" $P/PlayarrUI/Tests/PlayarrUITests/*.swift
grep -n "private let makeEngine\|private func change\|private func gainDb\|func tick(now" $P/PlayarrPlayer/Sources/PlayarrPlayer/Player.swift
grep -n "static func testing\|func render(seconds" -r $P/PlayarrPlayer/Tests
```

Expected: `4`; six endpoint lines; one `FakeServer`; the four Player lines; both test helpers. A missing one means the phase it comes from isn't done: stop and finish it first.

**Step 2: Phases 4, 5 and 6**

```bash
U=apps/ios/Packages/PlayarrUI/Sources/PlayarrUI
grep -rn "struct CoverImage\|struct ArtistPage\|struct AlbumPage" $U
grep -rn "var player\b\|var player:\|var toasts\|var cache\|func openSearch\|func invalidate(prefix" $U
grep -rn "func mixPointsChanged" apps/ios/Packages/PlayarrPlayer/Sources
grep -rln "NavigationStack" $U
grep -rln "Songs like these" $U
```

Write down what each name is called and in which file. Where a name differs, use phase 4's (or 5's, 6's) name in the file the "Before you start" table lists, when you get to that task, and nowhere else. If phase 5 has no `mixPointsChanged`, Task 21 passes `{ _ in }` instead (see the table). If phase 4 already has an `Album(_ detail: AlbumDetail)` initializer, skip Task 10's `Album+Detail.swift` and its test.

**Step 3: Everything passes before starting**

```bash
make -C apps/ios test
```

Expected: every suite passes. Nothing to commit.

---

### Task 1: Small shared pieces: waiting, families of answers, title keys, the web's wordings

`Sleeper` is how this phase waits (tests pass a fake). `CacheFamily` names what a change makes stale, after the web's query keys. `TitleKey` is lib/links.ts `titleKey` ("Mezzanine (Deluxe Edition)" finds "Mezzanine"). `TextFormat` holds lib/format.ts's `formatTime`, `plural` and `formatWait`, and JavaScript's rounding. The test support files serve every later task.

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shared/Sleeper.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shared/CacheFamily.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shared/TitleKey.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shared/TextFormat.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/TitleKeyTests.swift`, `TextFormatTests.swift`
- Test support: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/Support/Phase8Fixtures.swift`, `Support/TestSleepers.swift`

**Step 1: Write the test support and the failing tests**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/Support/Phase8Fixtures.swift`:

```swift
import Foundation
import PlayarrAPI
@testable import PlayarrUI

/// Small builders for this phase's tests.
func availability(_ state: AvailabilityState, albumId: Int? = nil, have: Int? = nil, total: Int? = nil, progress: Double? = nil, message: String? = nil) -> Availability {
  Availability(state: state, albumId: albumId, have: have, total: total, progress: progress, message: message)
}

func albumRequest(_ mbid: String, _ title: String, _ state: AvailabilityState, albumId: Int? = nil, progress: Double? = nil) -> AlbumRequest {
  AlbumRequest(mbid: mbid, title: title, artistName: "Massive Attack", requestedAt: "2026-11-03T10:00:00.000Z", availability: availability(state, albumId: albumId, progress: progress))
}

func account(canRequest: Bool = true, role: AccountRole = .member) -> Account {
  Account(id: 2, username: "sam", name: "Sam", role: role, canRequest: canRequest, sources: nil, hasPassword: true)
}

func health(lidarr: Bool = true, requests: Bool = true) -> HealthStatus {
  HealthStatus(ok: true, lidarr: lidarr ? .init(ok: true, version: "2.9") : nil, media: .init(source: .local, ok: true), requests: requests)
}

/// JSON text of a value, for fake server answers.
func jsonText<T: Encodable>(_ value: T) -> String {
  String(decoding: (try? JSONEncoder().encode(value)) ?? Data(), as: UTF8.self)
}

/// A client whose requests go to `handler` (FakeServer, from AddServerModelTests).
func fakeClient(_ handler: @escaping FakeServer.Handler) -> APIClient {
  let host = "test-\(UUID().uuidString.lowercased()).invalid"
  return APIClient(baseURL: URL(string: "http://\(host)")!, token: "tok", session: FakeServer.session(host: host, handler))
}

/// What the models said to the rest of the app.
@MainActor final class EventLog {
  var toasts: [String] = []
  var errors: [String] = []
  var invalidated: [CacheFamily] = []

  func toast(_ text: String, _ isError: Bool) {
    if isError { errors.append(text) } else { toasts.append(text) }
  }

  func invalidate(_ families: [CacheFamily]) { invalidated += families }
}

/// Waits (up to a second) for something another task does.
@MainActor func eventually(_ condition: () -> Bool) async {
  for _ in 0..<1000 where !condition() { try? await Task.sleep(for: .milliseconds(1)) }
}

func album(id: Int = 70, title: String = "Mezzanine", mbid: String? = nil, type: String = "Album", have: Int = 11, total: Int = 11, mayBeIncomplete: Bool? = nil) -> Album {
  Album(
    id: id, title: title, artistId: 7, artistName: "Massive Attack", albumType: type, secondaryTypes: [], genres: [],
    duration: 3000, trackCount: have, totalTrackCount: total, mbid: mbid, mayBeIncomplete: mayBeIncomplete)
}

extension URLRequest {
  /// The body as sent (URLSession moves it into a stream before URLProtocol sees it).
  var bodyText: String {
    if let httpBody { return String(decoding: httpBody, as: UTF8.self) }
    guard let stream = httpBodyStream else { return "" }
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while stream.hasBytesAvailable {
      let read = stream.read(&buffer, maxLength: buffer.count)
      if read <= 0 { break }
      data.append(buffer, count: read)
    }
    return String(decoding: data, as: UTF8.self)
  }
}
```

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/Support/TestSleepers.swift`:

```swift
import Foundation
import Synchronization
@testable import PlayarrUI

/// Records each sleep and returns at once; the sleep after `limit` throws, which ends a polling loop.
final class ScriptedSleeper: Sendable {
  private let slept = Mutex<[Duration]>([])
  let limit: Int

  init(limit: Int) { self.limit = limit }

  var durations: [Duration] { slept.withLock { $0 } }

  var sleeper: Sleeper {
    Sleeper { [self] duration in
      let count = slept.withLock { $0.append(duration); return $0.count }
      if count > limit { throw CancellationError() }
    }
  }
}

/// Sleeps until the test lets them go; a cancelled sleep throws, as Task.sleep does.
final class ManualSleeper: Sendable {
  private struct Waiter {
    let id: UUID
    let duration: Duration
    let continuation: CheckedContinuation<Void, any Error>
  }

  private let waiters = Mutex<[Waiter]>([])
  private let asked = Mutex<[Duration]>([])

  /// Every sleep asked for, in order.
  var durations: [Duration] { asked.withLock { $0 } }
  var waiting: Int { waiters.withLock { $0.count } }

  var sleeper: Sleeper {
    Sleeper { [self] duration in
      let id = UUID()
      asked.withLock { $0.append(duration) }
      try await withTaskCancellationHandler {
        try await withCheckedThrowingContinuation { continuation in
          waiters.withLock { $0.append(Waiter(id: id, duration: duration, continuation: continuation)) }
        }
      } onCancel: {
        let waiter = waiters.withLock { list in list.firstIndex { $0.id == id }.map { list.remove(at: $0) } }
        waiter?.continuation.resume(throwing: CancellationError())
      }
    }
  }

  /// Ends every sleep waiting now.
  func releaseAll() {
    let all = waiters.withLock { list in
      defer { list = [] }
      return list
    }
    for waiter in all { waiter.continuation.resume() }
  }
}

/// A list other threads append to (what a fake server was asked).
final class Recorder<Value: Sendable>: Sendable {
  private let items = Mutex<[Value]>([])
  var all: [Value] { items.withLock { $0 } }
  func append(_ value: Value) { items.withLock { $0.append(value) } }
}
```

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/TitleKeyTests.swift`:

```swift
import Testing
@testable import PlayarrUI

@Suite struct TitleKeyTests {
  @Test func foldsEditionsAccentsAndPunctuation() {
    #expect(TitleKey.of("Mezzanine (Deluxe Edition)") == "mezzanine")
    #expect(TitleKey.of("Mezzanine [2018 Remaster]") == "mezzanine")
    #expect(TitleKey.of("Blue Lines - 2012 Mix/Master") == "blue lines")
    #expect(TitleKey.of("Café Tacvba") == "cafe tacvba")
    #expect(TitleKey.of("100th Window") == "100th window")
  }

  @Test func keepsATitleThatIsAllPunctuation() {
    #expect(TitleKey.of(" !!! ") == "!!!")
  }
}
```

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/TextFormatTests.swift`:

```swift
import Testing
@testable import PlayarrUI

@Suite struct TextFormatTests {
  @Test func writesTimesCountsAndWaitsAsTheWebDoes() {
    #expect(TextFormat.clock(245) == "4:05")
    #expect(TextFormat.clock(3725) == "1:02:05")
    #expect(TextFormat.clock(.nan) == "0:00")
    #expect(TextFormat.plural(1, "release") == "1 release")
    #expect(TextFormat.plural(3, "release") == "3 releases")
    #expect(TextFormat.wait(0.2) == "1 s")
    #expect(TextFormat.wait(130) == "2 min")
  }

  @Test func roundsHalvesUpAsJavaScriptDoes() {
    #expect(TextFormat.jsRound(2.5) == 3)
    #expect(TextFormat.jsRound(-2.5) == -2)
  }
}
```

**Step 2: Run them to see them fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter 'TitleKeyTests|TextFormatTests'
```

Expected: the build fails with `cannot find type 'CacheFamily' in scope` (and `TitleKey`, `TextFormat`, `Sleeper`).

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shared/Sleeper.swift`:

```swift
/// Waits: polling and debouncing sleep through this, so tests can let time pass without waiting.
public struct Sleeper: Sendable {
  public let sleep: @Sendable (Duration) async throws -> Void

  public init(_ sleep: @escaping @Sendable (Duration) async throws -> Void) {
    self.sleep = sleep
  }

  public static let live = Sleeper { try await Task.sleep(for: $0) }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shared/CacheFamily.swift`:

```swift
/// Families of cached answers, named like the web's query keys: what a change on the server makes stale.
public enum CacheFamily: String, Sendable, CaseIterable {
  case albums, artists, artist, album, health, search, discover, requests, recommendations
  case discoverArtist = "discover-artist"
  case similarArtists = "similar-artists"
  case mixMaps = "mix-maps"
  case trackMetadata = "track-metadata"

  /// What a request that became playable changes (useWatchRequests).
  public static let landed: [CacheFamily] = [.albums, .artists, .artist, .health, .search, .discover, .discoverArtist, .recommendations]
  /// What asking for an album changes (useRequestAlbum); the requests themselves are asked for again by their model.
  public static let requested: [CacheFamily] = [.discover, .discoverArtist, .recommendations]
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shared/TitleKey.swift`:

```swift
import Foundation

/// A loose album-title key, so "Mezzanine (Deluxe Edition)" finds "Mezzanine" (lib/links.ts titleKey).
public enum TitleKey {
  public static func of(_ title: String) -> String {
    let folded = String(String.UnicodeScalarView(title.decomposedStringWithCanonicalMapping.unicodeScalars.filter { !(0x300...0x36F).contains($0.value) }))
    let key = folded.lowercased()
      .replacing(#/\s*[(\[].*?[)\]]/#, with: " ")
      .replacing(#/\s+-\s+.*$/#, with: "")
      .replacing(#/[^\p{L}\p{N}]+/#, with: " ")
      .trimmingCharacters(in: .whitespaces)
    return key.isEmpty ? title.trimmingCharacters(in: .whitespaces).lowercased() : key
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shared/TextFormat.swift`:

```swift
import Foundation

/// The web's small wordings (lib/format.ts), shared by this phase's screens.
public enum TextFormat {
  /// 245 → "4:05", 3725 → "1:02:05".
  public static func clock(_ seconds: Double) -> String {
    let total = seconds.isFinite && seconds > 0 ? Int(seconds) : 0
    let (h, m, s) = (total / 3600, total / 60 % 60, total % 60)
    return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
  }

  /// "1 release", "12 releases".
  public static func plural(_ n: Int, _ word: String, _ pluralWord: String? = nil) -> String {
    "\(n) \(n == 1 ? word : pluralWord ?? word + "s")"
  }

  /// A rough wait: "4 s", "2 min".
  public static func wait(_ seconds: Double) -> String {
    seconds < 60 ? "\(max(1, Int(jsRound(seconds)))) s" : "\(Int(jsRound(seconds / 60))) min"
  }

  /// JavaScript's Math.round: halves go up (Swift's `rounded()` takes -2.5 to -3, JavaScript to -2).
  public static func jsRound(_ value: Double) -> Double { (value + 0.5).rounded(.down) }
}
```

**Step 4: Run them to see them pass**

Same command. Expected: `Test run with 4 tests` … `passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shared/Sleeper.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shared/CacheFamily.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shared/TitleKey.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shared/TextFormat.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/Support/Phase8Fixtures.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/Support/TestSleepers.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/TitleKeyTests.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/TextFormatTests.swift
git commit -F - <<'EOF'
iOS: shared pieces for Discover and requests: a fake-able clock, families of answers, title keys and the web's wordings

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

**As built:** no `Sleeper.swift` or `TestSleepers.swift` (the clock and `TestClock` instead) and no `TextFormat.swift`: `Format` gained `wait(_:)` and `jsRound(_:)`, tested in `FormatTests`. `Phase8Fixtures.swift` keeps `availability`, `albumRequest`, `account`, `health`, `album`, `EventLog` and `eventually` (no `fakeClient`, `jsonText` or `bodyText`). `FakeAPI` records each call's query (`queries(_:_:_:)`) and can hold an answer until a `Gate` (new `Support/Gate.swift`) opens; `FakeServer` moved from `AddServerModelTests.swift` to `Support/FakeServer.swift`.

---

### Task 2: The Request button's states and who may press it

One control for every state of an album that may not be in the library yet (components/Discover.tsx `RequestButton`), as a value: its words, its tooltip, whether pressing it asks Lidarr or opens the album. `RequestGate` says whether Discover shows and whether Request buttons do (decision 3). `AlbumRef.requestKey` names an album whichever way it's known, so every button for the same album shows the same "Requesting".

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Requests/RequestGate.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Requests/PendingRequest.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Requests/AlbumRef+Key.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Requests/RequestButtonState.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/RequestButtonStateTests.swift`, `RequestGateTests.swift`

**Step 1: Write the failing tests**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/RequestButtonStateTests.swift`:

```swift
import PlayarrAPI
import Testing
@testable import PlayarrUI

@Suite struct RequestButtonStateTests {
  private func state(_ a: Availability, allowed: Bool = true, pending: PendingRequest? = nil) -> RequestButtonState {
    RequestButtonState.make(a, allowed: allowed, pending: pending)
  }

  @Test func saysEachStateInTheWebsWords() {
    #expect(state(availability(.noneValue)).label == "Request")
    #expect(state(availability(.searching)).label == "Searching")
    #expect(state(availability(.downloading, progress: 0.425)).label == "43%")
    #expect(state(availability(.downloading)).label == "0%")
    #expect(state(availability(.importing)).label == "Importing")
    #expect(state(availability(.waiting)).label == "Search again")
    #expect(state(availability(.failed)).label == "Retry")
    #expect(state(availability(.available, albumId: 5)) == .inLibrary(albumId: 5))
    #expect(state(availability(.available, albumId: 5)).label == "In library")
  }

  @Test func saysRequestingThenLookingUp() {
    #expect(state(availability(.noneValue), pending: .requesting).label == "Requesting")
    let slow = state(availability(.failed), pending: .lookingUp)
    #expect(slow.label == "Looking up")
    #expect(slow.help == "Finding this album on MusicBrainz, which answers about one request per second")
  }

  @Test func countsWhatIsHereOfAPartialAlbum() {
    let some = state(availability(.partial, albumId: 5, have: 1, total: 12))
    #expect(some == .partial(count: "1/12", summary: "1 of 12 songs in your library", albumId: 5, canRequest: true))
    #expect(state(availability(.partial, albumId: 5, have: 3)).label == "3 here")
    #expect(state(availability(.partial, have: 1)).help == "1 song in your library")
    #expect(state(availability(.partial, albumId: 5, have: 1, total: 12), allowed: false).opensAlbum == 5)
  }

  @Test func hidesWhatWouldAskWhenRequestsArentAllowed() {
    for s: AvailabilityState in [.noneValue, .waiting, .failed, .unknown("new")] {
      #expect(state(availability(s), allowed: false) == .hidden)
    }
    // Progress on earlier requests still shows, and In library still opens the album.
    #expect(state(availability(.searching), allowed: false).label == "Searching")
    #expect(state(availability(.available, albumId: 9), allowed: false).opensAlbum == 9)
    #expect(state(availability(.partial, have: 2, total: 9), allowed: false) == .partial(count: "2/9", summary: "2 of 9 songs in your library", albumId: nil, canRequest: false))
  }

  @Test func asksOnlyFromTheStatesThatCan() {
    #expect(state(availability(.noneValue)).asks)
    #expect(state(availability(.waiting, message: "No release found")).asks)
    #expect(state(availability(.waiting, message: "No release found")).help == "No release found")
    #expect(state(availability(.failed)).asks)
    #expect(!state(availability(.searching)).asks)
    #expect(!state(availability(.available)).asks)
  }

  @Test func namesAnAlbumByItsIdElseByArtistAndTitle() {
    #expect(AlbumRef(mbid: "rg-1", artistName: "Massive Attack", albumTitle: "Mezzanine").requestKey == "rg-1")
    #expect(AlbumRef(artistName: "Massive Attack", albumTitle: "Mezzanine (Deluxe)").requestKey == "massive attack|mezzanine")
  }
}
```

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/RequestGateTests.swift`:

```swift
import PlayarrAPI
import Testing
@testable import PlayarrUI

@Suite struct RequestGateTests {
  @Test func allowsRequestsOnlyWithLidarrRequestsOnAndTheRight() {
    #expect(RequestGate(health: health(), account: account()).allowsRequests)
    #expect(!RequestGate(health: health(requests: false), account: account()).allowsRequests)
    #expect(!RequestGate(health: health(), account: account(canRequest: false)).allowsRequests)
    #expect(!RequestGate(health: health(), account: nil).allowsRequests)
  }

  @Test func showsDiscoverOnlyWithLidarr() {
    #expect(RequestGate(health: health(), account: account(canRequest: false)).hasLidarr)
    #expect(!RequestGate(health: health(lidarr: false, requests: false), account: account()).hasLidarr)
  }

  @Test func hidesNothingTheAccountMayUseBeforeHealthIsKnown() {
    let gate = RequestGate(health: nil, account: account())
    #expect(gate.hasLidarr)
    #expect(gate.allowsRequests)
    #expect(!RequestGate(health: nil, account: account(canRequest: false)).allowsRequests)
  }
}
```

**Step 2: Run them to see them fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter 'RequestButtonStateTests|RequestGateTests'
```

Expected: the build fails with `cannot find type 'RequestButtonState' in scope` (and `PendingRequest`, `RequestGate`, `requestKey`).

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Requests/RequestGate.swift`:

```swift
import PlayarrAPI

/// Who may see Discover and press Request. Until the server's health is known it doesn't hide anything the account
/// may use, as the web (useHasLidarr, useRequestsEnabled); the server refuses what isn't allowed anyway.
public struct RequestGate: Equatable, Sendable {
  /// A Lidarr source is set up: Discover and requests exist on this server.
  public var hasLidarr: Bool
  /// Request buttons show: Lidarr, requests on in Settings, and this account may request (`health.requests` says
  /// all three for the signed-in account; `canRequest` is checked too so a change shows before the next health).
  public var allowsRequests: Bool
  /// The account may request and withdraw requests (DELETE /api/requests needs only this).
  public var canRequest: Bool

  public init(health: HealthStatus?, account: Account?) {
    canRequest = account?.canRequest ?? false
    hasLidarr = health.map { $0.lidarr != nil } ?? true
    allowsRequests = canRequest && (health?.requests ?? true)
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Requests/PendingRequest.swift`:

```swift
/// A request on its way to the server: "Requesting", then "Looking up" once it has taken 2 s (finding an album can
/// wait on MusicBrainz, which answers about one request per second).
public enum PendingRequest: Equatable, Sendable {
  case requesting
  case lookingUp

  /// When "Requesting" becomes "Looking up".
  public static let slowAfter: Duration = .seconds(2)
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Requests/AlbumRef+Key.swift`:

```swift
import PlayarrAPI

extension AlbumRef {
  /// One key per album, whichever way it's named: its MusicBrainz id, else its artist and title.
  public var requestKey: String {
    mbid ?? releaseMbid ?? "\(TitleKey.of(artistName))|\(TitleKey.of(albumTitle))"
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Requests/RequestButtonState.swift`:

```swift
import PlayarrAPI

/// What a Request button shows for an album that may not be in the library yet: one control for every state,
/// Request → Searching → 42% → Importing → In library (components/Discover.tsx, RequestButton).
public enum RequestButtonState: Equatable, Sendable {
  /// Nothing can be asked for (no Lidarr, requests off, or the account may not request) and nothing is on its way.
  case hidden
  /// Asking the server; `slow` after 2 s ("Looking up").
  case requesting(slow: Bool)
  /// Some of its songs are here: "3/12" (or "3 here") opening the album, and Request for the rest when allowed.
  case partial(count: String, summary: String, albumId: Int?, canRequest: Bool)
  case request
  case searching(message: String?)
  case downloading(percent: Int, message: String?)
  case importing(message: String?)
  /// Monitored in Lidarr, nothing found yet: ask Lidarr to search again.
  case searchAgain(message: String?)
  case retry(message: String?)
  case inLibrary(albumId: Int?)

  public static func make(_ availability: Availability, allowed: Bool, pending: PendingRequest?) -> RequestButtonState {
    if let pending { return .requesting(slow: pending == .lookingUp) }
    switch availability.state {
    case .available:
      return .inLibrary(albumId: availability.albumId)
    case .partial:
      let have = availability.have ?? 0
      // How long the album is may be unknown (folder files without a track total): then just how many are here.
      if let total = availability.total, total > 0 {
        return .partial(count: "\(have)/\(total)", summary: "\(have) of \(total) songs in your library", albumId: availability.albumId, canRequest: allowed)
      }
      return .partial(count: "\(have) here", summary: "\(TextFormat.plural(have, "song")) in your library", albumId: availability.albumId, canRequest: allowed)
    case .searching:
      return .searching(message: availability.message)
    case .downloading:
      return .downloading(percent: Int(TextFormat.jsRound((availability.progress ?? 0) * 100)), message: availability.message)
    case .importing:
      return .importing(message: availability.message)
    case .waiting:
      return allowed ? .searchAgain(message: availability.message) : .hidden
    case .failed:
      return allowed ? .retry(message: availability.message) : .hidden
    case .noneValue, .unknown:
      return allowed ? .request : .hidden
    }
  }

  /// The button's words.
  public var label: String {
    switch self {
    case .hidden: ""
    case .requesting(let slow): slow ? "Looking up" : "Requesting"
    case .partial(let count, _, _, _): count
    case .request: "Request"
    case .searching: "Searching"
    case .downloading(let percent, _): "\(percent)%"
    case .importing: "Importing"
    case .searchAgain: "Search again"
    case .retry: "Retry"
    case .inLibrary: "In library"
    }
  }

  /// The web's tooltip: Lidarr's message, or why it's slow.
  public var help: String? {
    switch self {
    case .requesting(true): "Finding this album on MusicBrainz, which answers about one request per second"
    case .partial(_, let summary, _, _): summary
    case .searching(let message), .importing(let message), .searchAgain(let message), .retry(let message): message
    case .downloading(_, let message): message
    default: nil
    }
  }

  /// Pressing it asks Lidarr for the album (the partial state's second button does too).
  public var asks: Bool {
    switch self {
    case .request, .searchAgain, .retry: true
    default: false
    }
  }

  /// Pressing it opens the album in the library.
  public var opensAlbum: Int? {
    switch self {
    case .inLibrary(let id), .partial(_, _, let id, _): id
    default: nil
    }
  }
}
```

**Step 4: Run them to see them pass**

Same command. Expected: `Test run with 9 tests` … `passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Requests/RequestGate.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Requests/PendingRequest.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Requests/AlbumRef+Key.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Requests/RequestButtonState.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/RequestButtonStateTests.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/RequestGateTests.swift
git commit -F - <<'EOF'
iOS: the Request button's states in the web's words, hidden where nothing may be asked for

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

**As built:** as written, with `Format.plural` and `Format.jsRound` for `TextFormat`'s.

---

### Task 3: How often requests are asked for, and noticing the ones that landed

lib/queries.ts `useRequests` (every 10 s while any request is searching, downloading or importing, every 60 s otherwise) and `useWatchRequests` (a request that turns `available` is announced once; nothing is announced on the first look).

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Requests/RequestPolling.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Requests/RequestWatch.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/RequestPollingTests.swift`

**Step 1: Write the failing tests**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/RequestPollingTests.swift`:

```swift
import PlayarrAPI
import Testing
@testable import PlayarrUI

@Suite struct RequestPollingTests {
  @Test func pollsEveryTenSecondsWhileAnythingIsOnItsWay() {
    for s: AvailabilityState in [.searching, .downloading, .importing] {
      #expect(RequestPolling.interval(after: [albumRequest("a", "A", .available), albumRequest("b", "B", s)]) == .seconds(10))
    }
  }

  @Test func pollsEveryMinuteOtherwise() {
    #expect(RequestPolling.interval(after: nil) == .seconds(60))
    #expect(RequestPolling.interval(after: []) == .seconds(60))
    #expect(RequestPolling.interval(after: [albumRequest("a", "A", .waiting), albumRequest("b", "B", .failed), albumRequest("c", "C", .available)]) == .seconds(60))
  }

  @Test func countsWhatIsInProgress() {
    #expect(RequestPolling.activeCount([albumRequest("a", "A", .searching), albumRequest("b", "B", .downloading), albumRequest("c", "C", .waiting)]) == 2)
  }
}

@Suite struct RequestWatchTests {
  @Test func announcesNothingOnTheFirstLook() {
    var watch = RequestWatch()
    #expect(watch.landed(in: [albumRequest("a", "Mezzanine", .available)]).isEmpty)
  }

  @Test func announcesARequestThatBecamePlayableOnce() {
    var watch = RequestWatch()
    _ = watch.landed(in: [albumRequest("a", "Mezzanine", .downloading)])
    let landed = watch.landed(in: [albumRequest("a", "Mezzanine", .available, albumId: 7)])
    #expect(landed.map(\.mbid) == ["a"])
    #expect(RequestWatch.message(for: landed) == "“Mezzanine” is ready to play")
    #expect(watch.landed(in: [albumRequest("a", "Mezzanine", .available, albumId: 7)]).isEmpty)
  }

  @Test func countsSeveralAtOnce() {
    var watch = RequestWatch()
    _ = watch.landed(in: [albumRequest("a", "A", .importing), albumRequest("b", "B", .searching)])
    let landed = watch.landed(in: [albumRequest("a", "A", .available), albumRequest("b", "B", .available), albumRequest("c", "C", .available)])
    #expect(landed.count == 3)
    #expect(RequestWatch.message(for: landed) == "3 albums are ready to play")
    #expect(RequestWatch.message(for: []) == nil)
  }
}
```

**Step 2: Run them to see them fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter 'RequestPollingTests|RequestWatchTests'
```

Expected: the build fails with `cannot find 'RequestPolling' in scope` (and `RequestWatch`).

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Requests/RequestPolling.swift`:

```swift
import PlayarrAPI

/// How often the requests are asked for: every 10 s while any is on its way, every minute otherwise (useRequests).
public enum RequestPolling {
  public static let activeStates: Set<AvailabilityState> = [.searching, .downloading, .importing]
  public static let whileActive: Duration = .seconds(10)
  public static let otherwise: Duration = .seconds(60)

  public static func interval(after requests: [AlbumRequest]?) -> Duration {
    activeCount(requests) > 0 ? whileActive : otherwise
  }

  /// Requests Lidarr is searching for, downloading or importing ("2 requests in progress").
  public static func activeCount(_ requests: [AlbumRequest]?) -> Int {
    requests?.filter { activeStates.contains($0.availability.state) }.count ?? 0
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Requests/RequestWatch.swift`:

```swift
import PlayarrAPI

/// Notices requests that became playable since the last look (useWatchRequests). Nothing counts until there was a
/// list to compare with, so opening the app with albums already in doesn't announce them.
public struct RequestWatch: Sendable {
  private var previous: [String: AvailabilityState] = [:]

  public init() {}

  public mutating func landed(in requests: [AlbumRequest]) -> [AlbumRequest] {
    let landed = previous.isEmpty ? [] : requests.filter { $0.availability.state == .available && previous[$0.mbid] != .available }
    previous = Dictionary(requests.map { ($0.mbid, $0.availability.state) }, uniquingKeysWith: { first, _ in first })
    return landed
  }

  /// "“Mezzanine” is ready to play", "2 albums are ready to play".
  public static func message(for landed: [AlbumRequest]) -> String? {
    switch landed.count {
    case 0: nil
    case 1: "“\(landed[0].title)” is ready to play"
    default: "\(landed.count) albums are ready to play"
    }
  }
}
```

**Step 4: Run them to see them pass**

Same command. Expected: `Test run with 6 tests` … `passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Requests/RequestPolling.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Requests/RequestWatch.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/RequestPollingTests.swift
git commit -F - <<'EOF'
iOS: poll requests every 10 s while one is on its way, and notice when one becomes playable

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

**As built:** as written.

---

### Task 4: The requests model: polling, requesting, removing, and the notification

`RequestsModel` is the account's requests kept fresh (Task 3's cadence, slept through a `Sleeper`), requesting an album ("Requesting", then "Looking up" after 2 s; the web's two toasts; the families a request makes stale), taking a request off the list, announcing requests that landed (toast, invalidation, notifier), and "Request the rest" for a library album missing songs (`RequestRest`, `canRequestRest`). `LocalRequestNotifier` is decision 2: a notification only when the app isn't on screen; permission asked at the first request. It isn't run in `swift test` (UserNotifications needs an app bundle): its one decision is a pure function that is.

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Requests/RequestNotifier.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Requests/LocalRequestNotifier.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Requests/RequestsModel.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/RequestsModelTests.swift`, `LocalRequestNotifierTests.swift`

**Step 1: Write the failing tests**

The polling test is the fake clock: `ScriptedSleeper` records each sleep and ends the loop after three. The "Looking up" test holds the server's answer with a semaphore and lets the 2-second sleep go by hand.

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/RequestsModelTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Synchronization
import Testing
@testable import PlayarrUI

/// Remembers what it was told.
@MainActor final class FakeNotifier: RequestNotifier {
  var asked = 0
  var landed: [[AlbumRequest]] = []
  func requested() { asked += 1 }
  func landed(_ requests: [AlbumRequest]) { landed.append(requests) }
}

@MainActor @Suite struct RequestsModelTests {
  let log = EventLog()
  let notifier = FakeNotifier()

  private func model(_ client: APIClient, _ sleeper: Sleeper) -> RequestsModel {
    RequestsModel(client: client, sleeper: sleeper, notifier: notifier, toast: log.toast, invalidate: log.invalidate)
  }

  @Test func pollsEveryTenSecondsWhileOnItsWayThenEveryMinute() async {
    let answers = [
      [albumRequest("rg-1", "Mezzanine", .downloading, progress: 0.4)],
      [albumRequest("rg-1", "Mezzanine", .importing)],
      [albumRequest("rg-1", "Mezzanine", .available, albumId: 70)],
      [albumRequest("rg-1", "Mezzanine", .available, albumId: 70)],
    ]
    let asked = Mutex(0)
    let client = fakeClient { _ in
      let n = asked.withLock { n in defer { n += 1 }; return n }
      return (200, jsonText(answers[min(n, answers.count - 1)]))
    }
    let clock = ScriptedSleeper(limit: 3)
    let requests = model(client, clock.sleeper)
    requests.startPolling()
    await eventually { clock.durations.count == 4 }
    #expect(clock.durations == [.seconds(10), .seconds(10), .seconds(60), .seconds(60)])
    #expect(log.toasts == ["“Mezzanine” is ready to play"])
    #expect(log.invalidated == CacheFamily.landed)
    #expect(notifier.landed.map { $0.map(\.mbid) } == [["rg-1"]])
    #expect(requests.activeCount == 0)
  }

  @Test func keepsTheNotifierItIsGiven() {
    // The app makes its notifier inline: the model must hold on to it.
    weak var given: FakeNotifier?
    let requests: RequestsModel = {
      let made = FakeNotifier()
      given = made
      return RequestsModel(client: fakeClient { _ in (200, "[]") }, notifier: made, toast: log.toast, invalidate: log.invalidate)
    }()
    #expect(given != nil)
    _ = requests
  }

  @Test func saysRequestingThenLookingUpUntilTheServerAnswers() async {
    let answer = DispatchSemaphore(value: 0)
    let posted = Mutex(false)
    let client = fakeClient { request in
      if request.httpMethod == "POST" {
        _ = answer.wait(timeout: .now() + 5)
        posted.withLock { $0 = true }
        return (200, jsonText(albumRequest("rg-1", "Mezzanine", .searching)))
      }
      return (200, posted.withLock { $0 } ? jsonText([albumRequest("rg-1", "Mezzanine", .searching)]) : "[]")
    }
    let clock = ManualSleeper()
    let requests = model(client, clock.sleeper)
    let ref = AlbumRef(mbid: "rg-1", artistName: "Massive Attack", albumTitle: "Mezzanine")
    requests.request(ref)
    #expect(requests.pendingState(for: ref) == .requesting)
    #expect(requests.buttonState(for: ref, availability: availability(.noneValue), allowed: true).label == "Requesting")
    await eventually { clock.waiting == 1 }
    #expect(clock.durations == [.seconds(2)])
    clock.releaseAll()
    await eventually { requests.pendingState(for: ref) == .lookingUp }
    #expect(requests.buttonState(for: ref, availability: availability(.noneValue), allowed: true).label == "Looking up")
    answer.signal()
    await eventually { requests.pendingState(for: ref) == nil }
    #expect(log.toasts == ["Requested “Mezzanine”. Lidarr is searching for it"])
    #expect(log.invalidated == CacheFamily.requested)
    #expect(requests.requests?.map(\.mbid) == ["rg-1"])
    #expect(notifier.asked == 1)
  }

  @Test func saysWhenLidarrWillSearchOnItsSchedule() async {
    let client = fakeClient { request in
      request.httpMethod == "POST" ? (200, jsonText(albumRequest("rg-1", "Mezzanine", .waiting))) : (200, "[]")
    }
    let requests = model(client, ManualSleeper().sleeper)
    requests.request(AlbumRef(artistName: "Massive Attack", albumTitle: "Mezzanine"))
    await eventually { !log.toasts.isEmpty }
    #expect(log.toasts == ["Requested “Mezzanine”. Lidarr will search for it on its schedule"])
  }

  @Test func showsTheServersReasonWhenARequestIsRefused() async {
    let client = fakeClient { _ in (403, #"{"error":"Your account can’t request albums"}"#) }
    let requests = model(client, ManualSleeper().sleeper)
    let ref = AlbumRef(artistName: "Massive Attack", albumTitle: "Mezzanine")
    requests.request(ref)
    await eventually { requests.pendingState(for: ref) == nil }
    #expect(log.errors == ["Your account can’t request albums"])
    #expect(log.toasts.isEmpty)
  }

  @Test func removesARequestFromTheListOnly() async {
    let removed = Mutex<String?>(nil)
    let client = fakeClient { request in
      if request.httpMethod == "DELETE" { removed.withLock { $0 = request.url?.path() } }
      return request.httpMethod == "DELETE" ? (204, "") : (200, "[]")
    }
    let requests = model(client, ManualSleeper().sleeper)
    await requests.remove(albumRequest("rg-1", "Mezzanine", .waiting))
    #expect(removed.withLock { $0 } == "/api/requests/rg-1")
    #expect(requests.requests == [])
  }

  @Test func offersTheRestOfAnIncompleteAlbum() async {
    let client = fakeClient { _ in (200, jsonText([albumRequest("rg-9", "Mezzanine (Deluxe)", .downloading, progress: 0.5)])) }
    let requests = model(client, ManualSleeper().sleeper)
    #expect(requests.rest(of: album(have: 11, total: 11)) == nil)
    #expect(requests.rest(of: album(type: "Loose", have: 3, total: 9)) == nil)
    let fresh = requests.rest(of: album(have: 3, total: 11))
    #expect(fresh?.album == AlbumRef(artistName: "Massive Attack", albumTitle: "Mezzanine"))
    #expect(fresh?.availability.state == .noneValue)
    #expect(requests.rest(of: album(have: 1, total: 1, mayBeIncomplete: true)) != nil)
    await requests.refresh()
    // Recognised by artist and title when the album has no MusicBrainz id.
    #expect(requests.rest(of: album(have: 3, total: 11))?.availability.state == .downloading)
  }

  @Test func hidesTheRestOnceItIsAllHere() async {
    let client = fakeClient { _ in (200, jsonText([albumRequest("rg-1", "Something Else", .available, albumId: 70)])) }
    let requests = model(client, ManualSleeper().sleeper)
    await requests.refresh()
    #expect(requests.rest(of: album(mbid: "rg-1", have: 3, total: 11)) == nil)
  }
}
```

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/LocalRequestNotifierTests.swift`:

```swift
import Testing
@testable import PlayarrUI

@Suite struct LocalRequestNotifierTests {
  @Test func notifiesOnlyWhenTheAppIsntOnScreen() {
    let landed = [albumRequest("rg-1", "Mezzanine", .available)]
    #expect(LocalRequestNotifier.text(for: landed, active: false) == "“Mezzanine” is ready to play")
    #expect(LocalRequestNotifier.text(for: landed, active: true) == nil)
    #expect(LocalRequestNotifier.text(for: [], active: false) == nil)
  }
}
```

**Step 2: Run them to see them fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter 'RequestsModelTests|LocalRequestNotifierTests'
```

Expected: the build fails with `cannot find type 'RequestNotifier' in scope` (and `RequestsModel`, `LocalRequestNotifier`).

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Requests/RequestNotifier.swift`:

```swift
import PlayarrAPI

/// Tells the listener a request is ready when the app isn't on screen (a local notification on iOS).
@MainActor public protocol RequestNotifier: AnyObject {
  /// The listener asked for an album: the moment to ask for permission, once.
  func requested()
  /// Requests became playable.
  func landed(_ requests: [AlbumRequest])
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Requests/LocalRequestNotifier.swift`:

```swift
import Foundation
import PlayarrAPI
import UserNotifications

/// A request that becomes playable while the app plays in the background (it runs only then, for its audio) shows
/// as a notification; on screen, the toast says it. Permission is asked the first time the listener requests an
/// album, when the reason is plain.
@MainActor public final class LocalRequestNotifier: RequestNotifier {
  private let isActive: @MainActor () -> Bool
  private var asked = false

  /// `isActive`: the app is on screen.
  public init(isActive: @escaping @MainActor () -> Bool) {
    self.isActive = isActive
  }

  public func requested() {
    guard !asked else { return }
    asked = true
    Task { _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) }
  }

  public func landed(_ requests: [AlbumRequest]) {
    guard let text = Self.text(for: requests, active: isActive()) else { return }
    let content = UNMutableNotificationContent()
    content.body = text
    content.sound = .default
    let request = UNNotificationRequest(identifier: "requests-\(requests.map(\.mbid).joined(separator: ","))", content: content, trigger: nil)
    Task { try? await UNUserNotificationCenter.current().add(request) }
  }

  /// What the notification says, or nil when the app is on screen (the toast says it there).
  nonisolated static func text(for requests: [AlbumRequest], active: Bool) -> String? {
    active ? nil : RequestWatch.message(for: requests)
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Requests/RequestsModel.swift`:

```swift
import Foundation
import Observation
import PlayarrAPI

/// The account's album requests, kept fresh: asked for every 10 s while any is on its way and every minute
/// otherwise; when one becomes playable the library is refreshed and the listener told, once (lib/queries.ts:
/// useRequests, useWatchRequests, useRequestAlbum). One per signed-in account, owned by `DiscoverContext`.
@MainActor @Observable
public final class RequestsModel {
  public private(set) var requests: [AlbumRequest]?
  public private(set) var error: String?
  /// Requests on their way to the server, by `AlbumRef.requestKey`.
  public private(set) var pending: [String: PendingRequest] = [:]

  @ObservationIgnored private let client: APIClient
  @ObservationIgnored private let sleeper: Sleeper
  @ObservationIgnored private let toast: @MainActor (String, Bool) -> Void
  /// Where stale families are reported (the owner may set it after making the model).
  @ObservationIgnored var invalidate: @MainActor ([CacheFamily]) -> Void
  @ObservationIgnored private let notifier: (any RequestNotifier)?
  @ObservationIgnored private var watch = RequestWatch()
  @ObservationIgnored private var poller: Task<Void, Never>?

  public init(
    client: APIClient, sleeper: Sleeper = .live, notifier: (any RequestNotifier)? = nil,
    toast: @escaping @MainActor (String, Bool) -> Void, invalidate: @escaping @MainActor ([CacheFamily]) -> Void
  ) {
    self.client = client
    self.sleeper = sleeper
    self.notifier = notifier
    self.toast = toast
    self.invalidate = invalidate
  }

  /// "2 requests in progress".
  public var activeCount: Int { RequestPolling.activeCount(requests) }

  /// Asks now, then every 10 s or 60 s until `stopPolling()`.
  public func startPolling() {
    poller?.cancel()
    poller = Task { [weak self, sleeper] in
      while !Task.isCancelled {
        guard let wait = await self?.refreshForNextPoll() else { return }
        do { try await sleeper.sleep(wait) } catch { return }
      }
    }
  }

  public func stopPolling() {
    poller?.cancel()
    poller = nil
  }

  private func refreshForNextPoll() async -> Duration {
    await refresh()
    return RequestPolling.interval(after: requests)
  }

  /// Asks for the requests now; announces any that became playable.
  public func refresh() async {
    do {
      let fresh = try await client.send(API.Requests.list())
      requests = fresh
      error = nil
      let landed = watch.landed(in: fresh)
      guard let message = RequestWatch.message(for: landed) else { return }
      invalidate(CacheFamily.landed)
      toast(message, false)
      notifier?.landed(landed)
    } catch is CancellationError {
    } catch {
      self.error = error.localizedDescription
    }
  }

  public func pendingState(for album: AlbumRef) -> PendingRequest? { pending[album.requestKey] }

  public func buttonState(for album: AlbumRef, availability: Availability, allowed: Bool) -> RequestButtonState {
    RequestButtonState.make(availability, allowed: allowed, pending: pendingState(for: album))
  }

  /// Asks Lidarr for the album. Returns at once; the button shows "Requesting" (then "Looking up") meanwhile.
  public func request(_ album: AlbumRef) {
    let key = album.requestKey
    guard pending[key] == nil else { return }
    pending[key] = .requesting
    notifier?.requested()
    Task { [weak self, sleeper] in
      try? await sleeper.sleep(PendingRequest.slowAfter)
      guard let self, self.pending[key] == .requesting else { return }
      self.pending[key] = .lookingUp
    }
    Task { await send(album, key: key) }
  }

  private func send(_ album: AlbumRef, key: String) async {
    defer { pending[key] = nil }
    do {
      let made = try await client.send(API.Requests.request(album))
      toast(
        made.availability.state == .searching
          ? "Requested “\(made.title)”. Lidarr is searching for it"
          : "Requested “\(made.title)”. Lidarr will search for it on its schedule", false)
      invalidate(CacheFamily.requested)
      await refresh()
    } catch {
      toast(error.localizedDescription, true)
    }
  }

  /// Takes a request off the list; Lidarr keeps the album wanted.
  public func remove(_ request: AlbumRequest) async {
    do {
      _ = try await client.send(API.Requests.remove(mbid: request.mbid))
    } catch {
      toast(error.localizedDescription, true)
    }
    await refresh()
  }

  /// A library album missing songs: what to ask Lidarr for, and how a request for it is doing (RequestRest). Nil
  /// for a complete album, the "Loose songs" bucket, or once the whole album is here.
  public func rest(of album: Album) -> (album: AlbumRef, availability: Availability)? {
    guard Self.canRequestRest(album) else { return nil }
    // Albums known only from their tags have no MusicBrainz id: the server finds them by artist and title, and
    // their request is recognised the same way.
    let made = requests?.first { request in
      (album.mbid != nil && request.mbid == album.mbid)
        || (TitleKey.of(request.artistName) == TitleKey.of(album.artistName) && TitleKey.of(request.title) == TitleKey.of(album.title))
    }
    let availability = made?.availability ?? Availability(state: .noneValue)
    guard availability.state != .available else { return nil }
    return (AlbumRef(mbid: album.mbid, artistName: album.artistName, albumTitle: album.title), availability)
  }

  /// Songs are missing and it's a real album (canRequestRest).
  public static func canRequestRest(_ album: Album) -> Bool {
    album.albumType != "Loose" && (album.trackCount < album.totalTrackCount || album.mayBeIncomplete == true)
  }
}
```

**Step 4: Run them to see them pass**

Same command. Expected: `Test run with 9 tests` … `passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Requests/RequestNotifier.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Requests/LocalRequestNotifier.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Requests/RequestsModel.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/RequestsModelTests.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/LocalRequestNotifierTests.swift
git commit -F - <<'EOF'
iOS: requests kept fresh, made and removed; a landed album refreshes the library, toasts, and notifies in the background

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

**As built:** `RequestsModel(api:clock:notifier:toast:invalidate:)`; the 2-second "Looking up" sleep goes through the clock and is cancelled once the server answers. The tests use `FakeAPI` (`hold` with a `Gate` keeps the POST's answer back) and `TestClock` (the polling test reads each `nextSleep()`: 10, 10, 60, 60 s), and check the request's body.

---

### Task 5: The MusicBrainz queue, and the words for a wait

`useMusicBrainzStatus` (1.5 s while lookups wait, else 15 s), run only while something on screen shows it (decision 4), and the words of components/SlowLookup.tsx and the sidebar's indicator (`Nav.tsx` 221-232).

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/MusicBrainz/MusicBrainzStatusModel.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/MusicBrainz/SlowLookupText.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/MusicBrainzStatusTests.swift`

**Step 1: Write the failing tests**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/MusicBrainzStatusTests.swift`:

```swift
import PlayarrAPI
import Synchronization
import Testing
@testable import PlayarrUI

@MainActor @Suite struct MusicBrainzStatusTests {
  private func status(queued: Int, background: Int = 0, eta: Double = 0) -> MusicBrainzStatus {
    MusicBrainzStatus(queued: queued, background: background, etaSeconds: eta, matching: 0)
  }

  @Test func asksQuicklyWhileLookupsWaitAndSlowlyOtherwise() async {
    let answers = [status(queued: 3), status(queued: 1), status(queued: 0)]
    let asked = Mutex(0)
    let client = fakeClient { _ in
      let n = asked.withLock { n in defer { n += 1 }; return n }
      return (200, jsonText(answers[min(n, 2)]))
    }
    let clock = ScriptedSleeper(limit: 2)
    let model = MusicBrainzStatusModel(client: client, sleeper: clock.sleeper)
    await model.watch()
    #expect(clock.durations == [.milliseconds(1500), .milliseconds(1500), .seconds(15)])
    #expect(model.status?.queued == 0)
  }

  @Test func explainsTheWaitInTheWebsWords() {
    #expect(SlowLookupText.waiting(for: "“Air”", status: nil) == "Asking MusicBrainz for “Air”. It answers about one request per second.")
    #expect(SlowLookupText.waiting(for: "this album", status: status(queued: 1, background: 1)) == "Asking MusicBrainz for this album. It answers about one request per second.")
    #expect(
      SlowLookupText.waiting(for: "this album", status: status(queued: 40, background: 38, eta: 130))
        == "Asking MusicBrainz for this album. It answers about one request per second, and Playarr is also identifying your folder music, so there’s a line: about 2 min to go.")
    #expect(SlowLookupText.queued(status(queued: 4)) == "4 queued")
    #expect(SlowLookupText.explanation(status(queued: 4, eta: 3.2)) == "About 3 s of MusicBrainz lookups waiting (it answers about once a second)")
    #expect(SlowLookupText.explanation(status(queued: 4, background: 2, eta: 0.2)) == "About 1 s of MusicBrainz lookups waiting (it answers about once a second); 2 of them identifying your folder music")
  }
}
```

**Step 2: Run them to see them fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter MusicBrainzStatusTests
```

Expected: the build fails with `cannot find 'MusicBrainzStatusModel' in scope` (and `SlowLookupText`).

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/MusicBrainz/MusicBrainzStatusModel.swift`:

```swift
import Observation
import PlayarrAPI

/// How busy MusicBrainz is (it answers about once a second): asked every 1.5 s while lookups wait, every 15 s
/// otherwise (useMusicBrainzStatus), only while something on screen shows it (`watch()` runs in a view's `.task`).
@MainActor @Observable
public final class MusicBrainzStatusModel {
  public private(set) var status: MusicBrainzStatus?

  @ObservationIgnored private let client: APIClient
  @ObservationIgnored private let sleeper: Sleeper

  public init(client: APIClient, sleeper: Sleeper = .live) {
    self.client = client
    self.sleeper = sleeper
  }

  public static func interval(after status: MusicBrainzStatus?) -> Duration {
    (status?.queued ?? 0) > 0 ? .milliseconds(1500) : .seconds(15)
  }

  /// Keeps `status` fresh until the calling task is cancelled.
  public func watch() async {
    while !Task.isCancelled {
      if let fresh = try? await client.send(API.Server.musicBrainzStatus()) { status = fresh }
      do { try await sleeper.sleep(Self.interval(after: status)) } catch { return }
    }
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/MusicBrainz/SlowLookupText.swift`:

```swift
import PlayarrAPI

/// The words that explain a MusicBrainz wait (SlowLookup, and the sidebar's queue indicator).
public enum SlowLookupText {
  /// A lookup is only explained once it has taken this long.
  public static let after: Duration = .milliseconds(1500)

  /// "Asking MusicBrainz for this artist’s albums. It answers about one request per second."
  public static func waiting(for what: String, status: MusicBrainzStatus?) -> String {
    let start = "Asking MusicBrainz for \(what). It answers about one request per second"
    guard let status, status.background > 0, status.queued > 1 else { return start + "." }
    return start + ", and Playarr is also identifying your folder music, so there’s a line: about \(TextFormat.wait(status.etaSeconds)) to go."
  }

  /// The indicator's detail: "3 queued".
  public static func queued(_ status: MusicBrainzStatus) -> String { "\(status.queued) queued" }

  /// The indicator's longer explanation (the web's tooltip, here its accessibility hint).
  public static func explanation(_ status: MusicBrainzStatus) -> String {
    let start = "About \(TextFormat.wait(status.etaSeconds)) of MusicBrainz lookups waiting (it answers about once a second)"
    return status.background > 0 ? start + "; \(status.background) of them identifying your folder music" : start
  }
}
```

**Step 4: Run them to see them pass**

Same command. Expected: `Test run with 2 tests` … `passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/MusicBrainz/MusicBrainzStatusModel.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/MusicBrainz/SlowLookupText.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/MusicBrainzStatusTests.swift
git commit -F - <<'EOF'
iOS: watch the MusicBrainz queue while something shows it, and explain a wait in the web's words

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 6: DiscoverContext: the account's health, requests, queue and short-lived answers

The root of this phase for one signed-in account (decisions 4 and 5). It owns the `RequestsModel` and `MusicBrainzStatusModel`, asks for health every minute, keeps Discover's answers as long as the web does (`TimedCache`), and turns invalidations into generation counters (and passes them on to the app's cache). The library pages and Search are closures the app fills in (Task 21), so nothing here names phase 4.

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shared/TimedCache.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverContext.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/DiscoverContextTests.swift`

**Step 1: Write the failing tests**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/DiscoverContextTests.swift`:

```swift
import PlayarrAPI
import Synchronization
import Testing
@testable import PlayarrUI

@MainActor @Suite struct DiscoverContextTests {
  let log = EventLog()

  @Test func followsTheServersHealthAndTheAccount() async {
    let client = fakeClient { request in
      request.url?.path() == "/api/health" ? (200, jsonText(health(requests: false))) : (200, "[]")
    }
    let context = DiscoverContext(client: client, account: account(), sleeper: ManualSleeper().sleeper, toast: log.toast)
    #expect(context.gate.allowsRequests)  // health not known yet
    await context.refreshHealth()
    #expect(!context.gate.allowsRequests)
    #expect(context.gate.hasLidarr)
  }

  @Test func marksAnswersStaleHereAndInTheApp() {
    var forwarded: [CacheFamily] = []
    let context = DiscoverContext(client: fakeClient { _ in (200, "[]") }, account: account(), sleeper: ManualSleeper().sleeper, toast: log.toast) { forwarded += $0 }
    context.invalidate([.discover, .albums, .discover])
    #expect(context.generation(.discover) == 1)
    #expect(context.generation(.albums) == 1)
    #expect(context.generation(.search) == 0)
    #expect(forwarded == [.discover, .albums, .discover])
  }

  @Test func keepsADiscographyAMinuteUnlessItGoesStale() async throws {
    let asked = Mutex(0)
    let detail = DiscoverArtistDetail(mbid: "a-1", name: "Air", genres: [], albums: [])
    let client = fakeClient { _ in
      asked.withLock { $0 += 1 }
      return (200, jsonText(detail))
    }
    let context = DiscoverContext(client: client, account: account(), sleeper: ManualSleeper().sleeper, toast: log.toast)
    _ = try await context.discoverArtist("a-1")
    _ = try await context.discoverArtist("a-1")
    #expect(asked.withLock { $0 } == 1)
    context.invalidate([.discoverArtist])
    _ = try await context.discoverArtist("a-1")
    #expect(asked.withLock { $0 } == 2)
  }

  @Test func aRequestThatLandsRefreshesDiscover() async {
    let answers = [[albumRequest("rg-1", "Mezzanine", .importing)], [albumRequest("rg-1", "Mezzanine", .available, albumId: 70)]]
    let asked = Mutex(0)
    let client = fakeClient { request in
      guard request.url?.path() == "/api/requests" else { return (200, jsonText(health())) }
      let n = asked.withLock { n in defer { n += 1 }; return n }
      return (200, jsonText(answers[min(n, 1)]))
    }
    let context = DiscoverContext(client: client, account: account(), sleeper: ManualSleeper().sleeper, toast: log.toast)
    await context.requests.refresh()
    await context.requests.refresh()
    #expect(context.generation(.discover) == 1)
    #expect(context.generation(.discoverArtist) == 1)
    #expect(log.toasts == ["“Mezzanine” is ready to play"])
  }
}
```

**Step 2: Run them to see them fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter DiscoverContextTests
```

Expected: the build fails with `cannot find 'DiscoverContext' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shared/TimedCache.swift`:

```swift
/// Answers kept for a while (the web's staleTime): asked again once older than `maxAge`, or after `removeAll()`.
struct TimedCache<Value: Sendable>: Sendable {
  private var entries: [String: (at: ContinuousClock.Instant, value: Value)] = [:]
  let maxAge: Duration

  init(maxAge: Duration) {
    self.maxAge = maxAge
  }

  func value(_ key: String, now: ContinuousClock.Instant = .now) -> Value? {
    guard let entry = entries[key], now - entry.at < maxAge else { return nil }
    return entry.value
  }

  mutating func store(_ value: Value, for key: String, now: ContinuousClock.Instant = .now) {
    entries[key] = (now, value)
  }

  mutating func removeAll() { entries = [:] }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverContext.swift`:

```swift
import Observation
import PlayarrAPI
import SwiftUI

/// This phase's state for the signed-in account: the server's health (does it have Lidarr, may this account
/// request), the requests and the MusicBrainz queue, Discover's short-lived answers, and which of them a change made
/// stale. The app keeps one per signed-in account and puts it in the environment.
@MainActor @Observable
public final class DiscoverContext {
  public let client: APIClient
  public private(set) var account: Account
  public private(set) var health: HealthStatus?
  public let requests: RequestsModel
  public let musicBrainz: MusicBrainzStatusModel
  /// Bumped when a family of answers goes stale: views reload with `.task(id: context.generation(.discover))`.
  public private(set) var generations: [CacheFamily: Int] = [:]
  /// The library's own pages (phase 4), for links from Discover to an artist or album that is in the library.
  @ObservationIgnored public var libraryArtistPage: @MainActor (Int) -> AnyView = { _ in AnyView(EmptyView()) }
  @ObservationIgnored public var libraryAlbumPage: @MainActor (Int) -> AnyView = { _ in AnyView(EmptyView()) }
  /// Opens Search with a query (Find artist's "Search for … instead", Requests' "Search").
  @ObservationIgnored public var openSearch: @MainActor (String) -> Void = { _ in }

  @ObservationIgnored private let sleeper: Sleeper
  @ObservationIgnored private let forward: @MainActor ([CacheFamily]) -> Void
  @ObservationIgnored let toast: @MainActor (String, Bool) -> Void
  @ObservationIgnored private var searches = TimedCache<DiscoverResults>(maxAge: .seconds(60))
  @ObservationIgnored private var artists = TimedCache<DiscoverArtistDetail>(maxAge: .seconds(60))
  @ObservationIgnored private var similar = TimedCache<[DiscoverArtist]>(maxAge: .seconds(3600))
  @ObservationIgnored private var healthWatch: Task<Void, Never>?

  /// `forward` passes invalidations on to the app's cache (phase 4's pages); `toast` shows a message.
  public init(
    client: APIClient, account: Account, sleeper: Sleeper = .live, notifier: (any RequestNotifier)? = nil,
    toast: @escaping @MainActor (String, Bool) -> Void, forward: @escaping @MainActor ([CacheFamily]) -> Void = { _ in }
  ) {
    self.client = client
    self.account = account
    self.sleeper = sleeper
    self.toast = toast
    self.forward = forward
    musicBrainz = MusicBrainzStatusModel(client: client, sleeper: sleeper)
    requests = RequestsModel(client: client, sleeper: sleeper, notifier: notifier, toast: toast, invalidate: { _ in })
    requests.invalidate = { [weak self] in self?.invalidate($0) }
  }

  public var gate: RequestGate { RequestGate(health: health, account: account) }

  /// The account changed on the server (its rights, say).
  public func update(_ account: Account) { self.account = account }

  /// Health every minute (as the web) and the requests' own polling, until `stop()`.
  public func start() {
    requests.startPolling()
    healthWatch?.cancel()
    healthWatch = Task { [weak self, sleeper] in
      while !Task.isCancelled {
        await self?.refreshHealth()
        do { try await sleeper.sleep(.seconds(60)) } catch { return }
      }
    }
  }

  public func stop() {
    requests.stopPolling()
    healthWatch?.cancel()
    healthWatch = nil
  }

  /// Back on screen: the app may have been suspended, so ask at once.
  public func becameActive() {
    Task {
      await refreshHealth()
      await requests.refresh()
    }
  }

  public func refreshHealth() async {
    if let fresh = try? await client.send(API.Server.health()) { health = fresh }
  }

  public func generation(_ family: CacheFamily) -> Int { generations[family, default: 0] }

  /// Marks answers stale here and in the app's cache.
  public func invalidate(_ families: [CacheFamily]) {
    for family in Set(families) {
      generations[family, default: 0] += 1
      switch family {
      case .discover: searches.removeAll()
      case .discoverArtist: artists.removeAll()
      case .similarArtists: similar.removeAll()
      case .health: Task { await refreshHealth() }
      case .requests: Task { await requests.refresh() }
      default: break
      }
    }
    forward(families)
  }

  /// Music not in the library matching `query`, kept a minute.
  public func discover(_ query: String) async throws -> DiscoverResults {
    if let kept = searches.value(query) { return kept }
    let fresh = try await client.send(API.Discover.search(query))
    searches.store(fresh, for: query)
    return fresh
  }

  /// An artist's MusicBrainz discography, kept a minute.
  public func discoverArtist(_ mbid: String) async throws -> DiscoverArtistDetail {
    if let kept = artists.value(mbid) { return kept }
    let fresh = try await client.send(API.Discover.artist(mbid: mbid))
    artists.store(fresh, for: mbid)
    return fresh
  }

  /// Artists like this one (ListenBrainz): they change slowly, so kept an hour.
  public func similarArtists(_ mbid: String) async throws -> [DiscoverArtist] {
    if let kept = similar.value(mbid) { return kept }
    let fresh = try await client.send(API.Discover.similarArtists(mbid: mbid))
    similar.store(fresh, for: mbid)
    return fresh
  }
}
```

**Step 4: Run them to see them pass**

Same command. Expected: `Test run with 4 tests` … `passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shared/TimedCache.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverContext.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/DiscoverContextTests.swift
git commit -F - <<'EOF'
iOS: one Discover context per account: health, requests, the MusicBrainz queue, and answers kept as long as the web keeps them

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 7: Where Discover links lead, and Search's "Not in your library" model

`DiscoverDestination` is lib/links.ts (`artistHref`, `albumHref`) plus where Discover's cards and rows lead, as values pushed on a tab's navigation stack. `DiscoverSearchModel` is Search.tsx's `DiscoverSection` and `useDiscover`: asked 450 ms after the typing stops, from 2 characters, kept a minute, previous results kept while the next load; albums already playable and artists already in the library left out; 8 songs.

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverDestination.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverSearchModel.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/DiscoverSearchModelTests.swift`

**Step 1: Write the failing tests**

The debounce test types twice with `ManualSleeper`: the first 450 ms sleep is cancelled by the second keystroke, and only "mas" reaches the server.

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/DiscoverSearchModelTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Synchronization
import Testing
@testable import PlayarrUI

@MainActor @Suite struct DiscoverSearchModelTests {
  let log = EventLog()

  nonisolated static let answer = DiscoverResults(
    artists: [
      DiscoverArtist(mbid: "a-1", name: "Massive Attack", genres: [], artistId: 7),
      DiscoverArtist(mbid: "a-2", name: "Mass Gothic", genres: ["indie"]),
    ],
    albums: [
      DiscoverAlbum(mbid: "rg-1", title: "Mezzanine", artistName: "Massive Attack", artistMbid: "a-1", type: "Album", secondaryTypes: [], availability: availability(.available, albumId: 70)),
      DiscoverAlbum(mbid: "rg-2", title: "Heligoland", artistName: "Massive Attack", artistMbid: "a-1", type: "Album", secondaryTypes: [], availability: availability(.noneValue)),
    ],
    tracks: (1...10).map { n in
      DiscoverTrack(id: "t-\(n)", title: "Song \(n)", artistName: "Massive Attack", albumTitle: "Heligoland", album: AlbumRef(mbid: "rg-2", artistName: "Massive Attack", albumTitle: "Heligoland"), availability: availability(.noneValue))
    })

  private func setUp(_ asked: Recorder<String>) -> (DiscoverSearchModel, ManualSleeper) {
    let client = fakeClient { request in
      let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "q" }?.value ?? ""
      asked.append(query)
      return (200, jsonText(Self.answer))
    }
    let clock = ManualSleeper()
    let context = DiscoverContext(client: client, account: account(), sleeper: ManualSleeper().sleeper, toast: log.toast)
    return (DiscoverSearchModel(context: context, sleeper: clock.sleeper), clock)
  }

  @Test func asksOnce450MillisecondsAfterTheTypingStops() async {
    let asked = Recorder<String>()
    let (model, clock) = setUp(asked)
    model.update("ma")
    await eventually { clock.waiting == 1 }
    model.update("mas")
    await eventually { clock.waiting == 1 && clock.durations.count == 2 }
    #expect(model.loading)
    clock.releaseAll()
    await eventually { model.results != nil }
    #expect(asked.all == ["mas"])
    #expect(clock.durations == [.milliseconds(450), .milliseconds(450)])
    #expect(!model.loading)
  }

  @Test func waitsForTwoCharacters() async {
    let asked = Recorder<String>()
    let (model, clock) = setUp(asked)
    model.update("m")
    #expect(!model.loading)
    await eventually { clock.waiting == 1 }
    clock.releaseAll()
    await eventually { model.answered == "m" }
    #expect(asked.all.isEmpty)
    #expect(model.results == nil)
  }

  @Test func leavesOutWhatIsAlreadyInTheLibrary() async {
    let asked = Recorder<String>()
    let (model, clock) = setUp(asked)
    model.update("massive")
    await eventually { clock.waiting == 1 }
    clock.releaseAll()
    await eventually { model.results != nil }
    #expect(model.albums.map(\.mbid) == ["rg-2"])
    #expect(model.artists.map(\.mbid) == ["a-2"])
    #expect(model.tracks.count == 8)
    #expect(!model.nothing)
  }

  @Test func keepsAnAnswerAMinute() async {
    let asked = Recorder<String>()
    let (model, _) = setUp(asked)
    model.update("air")
    await model.reload()
    await model.reload()
    #expect(asked.all == ["air"])
  }
}

@Suite struct DiscoverDestinationTests {
  @Test func leadsToTheLibraryElseTheDiscographyElseALookup() {
    #expect(DiscoverDestination.artist(id: 7, mbid: "a-1", name: "Air") == .libraryArtist(id: 7))
    #expect(DiscoverDestination.artist(id: nil, mbid: "a-1", name: "Air") == .discoverArtist(mbid: "a-1", album: nil))
    #expect(DiscoverDestination.artist(id: nil, mbid: nil, name: "Air") == .findArtist(name: "Air", album: nil))
    #expect(DiscoverDestination.album(id: 70, artistMbid: "a-1", artistName: "Air", title: "Moon Safari") == .libraryAlbum(id: 70))
    #expect(DiscoverDestination.album(id: nil, artistMbid: "a-1", artistName: "Air", title: "Moon Safari") == .discoverArtist(mbid: "a-1", album: "Moon Safari"))
    #expect(DiscoverDestination.album(id: nil, artistMbid: nil, artistName: "Air", title: "Moon Safari") == .findArtist(name: "Air", album: "Moon Safari"))
  }

  @Test func opensAPartlyOwnedAlbumsPage() {
    func card(_ a: Availability) -> DiscoverDestination {
      .card(DiscoverAlbum(mbid: "rg", title: "T", artistName: "A", artistMbid: "a-1", type: "Album", secondaryTypes: [], availability: a))
    }
    #expect(card(availability(.available, albumId: 5)) == .libraryAlbum(id: 5))
    #expect(card(availability(.partial, albumId: 5, have: 2, total: 9)) == .libraryAlbum(id: 5))
    #expect(card(availability(.searching, albumId: 5, have: 2)) == .libraryAlbum(id: 5))
    #expect(card(availability(.noneValue)) == .discoverArtist(mbid: "a-1", album: nil))
  }

  @Test func followsALookedUpName() {
    #expect(DiscoverDestination.found(ArtistMatch(mbid: "a-1", artistId: 7), name: "Air", album: nil) == .libraryArtist(id: 7))
    #expect(DiscoverDestination.found(ArtistMatch(mbid: "a-1", artistId: 7), name: "Air", album: "Moon Safari") == .discoverArtist(mbid: "a-1", album: "Moon Safari"))
    #expect(DiscoverDestination.found(ArtistMatch(mbid: "a-1"), name: "Air", album: nil) == .discoverArtist(mbid: "a-1", album: nil))
  }
}
```

**Step 2: Run them to see them fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter 'DiscoverSearchModelTests|DiscoverDestinationTests'
```

Expected: the build fails with `cannot find 'DiscoverSearchModel' in scope` (and `DiscoverDestination`).

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverDestination.swift`:

```swift
import PlayarrAPI

/// Where a Discover link leads (lib/links.ts): the library's page when the artist or album is there, else the
/// artist's MusicBrainz discography, else a lookup by name first. Pushed on the tab's navigation stack.
public enum DiscoverDestination: Hashable, Sendable {
  case libraryArtist(id: Int)
  case libraryAlbum(id: Int)
  /// The discography; `album` highlights one of its albums (`?album=` on the web).
  case discoverArtist(mbid: String, album: String?)
  /// Only a name is known: look it up on MusicBrainz, then show what it leads to.
  case findArtist(name: String, album: String?)
  case requests

  /// artistHref.
  public static func artist(id: Int?, mbid: String?, name: String) -> DiscoverDestination {
    if let id { return .libraryArtist(id: id) }
    if let mbid { return .discoverArtist(mbid: mbid, album: nil) }
    return .findArtist(name: name, album: nil)
  }

  /// albumHref: an owned album opens its page; another opens the artist's discography with it highlighted.
  public static func album(id: Int?, artistMbid: String?, artistName: String, title: String) -> DiscoverDestination {
    if let id { return .libraryAlbum(id: id) }
    if let artistMbid { return .discoverArtist(mbid: artistMbid, album: title) }
    return .findArtist(name: artistName, album: title)
  }

  /// A Discover album card: the album's page when any of it is here, else its artist's discography.
  public static func card(_ album: DiscoverAlbum) -> DiscoverDestination {
    let a = album.availability
    let partial = a.state == .partial || (a.have != nil && a.albumId != nil)
    if (a.state == .available || partial), let id = a.albumId { return .libraryAlbum(id: id) }
    return .discoverArtist(mbid: album.artistMbid, album: nil)
  }

  /// A Discover song row opens its album when the album is (partly) here.
  public static func row(_ track: DiscoverTrack) -> DiscoverDestination? {
    let a = track.availability
    guard let id = a.albumId, a.state == .available || a.have != nil else { return nil }
    return .libraryAlbum(id: id)
  }

  /// A Discover artist card.
  public static func card(_ artist: DiscoverArtist) -> DiscoverDestination {
    .artist(id: artist.artistId, mbid: artist.mbid, name: artist.name)
  }

  /// Where a looked-up name leads (FindArtist).
  public static func found(_ match: ArtistMatch, name: String, album: String?) -> DiscoverDestination {
    if let album { return .album(id: nil, artistMbid: match.mbid, artistName: name, title: album) }
    return .artist(id: match.artistId, mbid: match.mbid, name: name)
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverSearchModel.swift`:

```swift
import Observation
import PlayarrAPI

/// Search's "Not in your library": what MusicBrainz, Lidarr and Deezer know matching the query, asked 450 ms after
/// the typing stops and from 2 characters (Search.tsx DiscoverSection, useDiscover). Albums already playable and
/// artists already in the library are left out: they're in the results above.
@MainActor @Observable
public final class DiscoverSearchModel {
  /// The latest answer; kept while the next one loads (keepPreviousData).
  public private(set) var results: DiscoverResults?
  /// The query `results` (or `error`) answer.
  public private(set) var answered = ""
  public private(set) var fetching = false
  public private(set) var error: String?
  /// What was typed (trimmed).
  public private(set) var typed = ""

  public static let debounce: Duration = .milliseconds(450)
  public static let minimumLength = 2
  public static let songsShown = 8

  @ObservationIgnored private let context: DiscoverContext
  @ObservationIgnored private let sleeper: Sleeper
  @ObservationIgnored private var pending: Task<Void, Never>?

  public init(context: DiscoverContext, sleeper: Sleeper = .live) {
    self.context = context
    self.sleeper = sleeper
  }

  public var albums: [DiscoverAlbum] { results?.albums.filter { $0.availability.state != .available } ?? [] }
  public var artists: [DiscoverArtist] { results?.artists.filter { $0.artistId == nil } ?? [] }
  public var tracks: [DiscoverTrack] { Array((results?.tracks ?? []).prefix(Self.songsShown)) }
  /// "Nothing found for “…”."
  public var nothing: Bool { results != nil && albums.isEmpty && artists.isEmpty && tracks.isEmpty }
  /// Skeleton rows: nothing to show yet, and an answer is coming.
  public var loading: Bool { results == nil && (fetching || typed != answered) && typed.count >= Self.minimumLength }

  /// The search field changed (the page passes it trimmed).
  public func update(_ text: String) {
    typed = text
    pending?.cancel()
    pending = Task { [weak self, sleeper] in
      do { try await sleeper.sleep(Self.debounce) } catch { return }
      await self?.search(text)
    }
  }

  /// Asks again for what's typed (a request changed what's available).
  public func reload() async {
    pending?.cancel()
    await search(typed)
  }

  private func search(_ query: String) async {
    answered = query
    guard query.count >= Self.minimumLength else {
      results = nil
      error = nil
      return
    }
    fetching = true
    defer { if answered == query { fetching = false } }
    do {
      let fresh = try await context.discover(query)
      guard answered == query else { return }
      results = fresh
      error = nil
    } catch is CancellationError {
    } catch {
      guard answered == query else { return }
      self.error = error.localizedDescription
    }
  }
}
```

**Step 4: Run them to see them pass**

Same command. Expected: `Test run with 7 tests` … `passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverDestination.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverSearchModel.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/DiscoverSearchModelTests.swift
git commit -F - <<'EOF'
iOS: Search's Not in your library, asked 450 ms after typing from 2 characters, and where Discover links lead

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 8: Discographies, similar artists and finding an artist by name

`Discography` lays out pages/DiscoverArtist.tsx (Albums, EPs & soundtracks, the in-library count, the `?album` highlight and its notice, the empty text) and pages/Artist.tsx's "Not in your library" (albums not here at all). `SimilarArtistGroups` is components/SimilarArtists.tsx. `DiscoverArtistModel` loads a discography (again on "Try again"); `FindArtistModel` is pages/FindArtist.tsx.

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/Discography.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/SimilarArtistGroups.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverArtistModel.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/FindArtistModel.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/DiscographyTests.swift`

**Step 1: Write the failing tests**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/DiscographyTests.swift`:

```swift
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct DiscographyTests {
  private func release(_ mbid: String, _ title: String, type: String = "Album", _ state: AvailabilityState = .noneValue) -> DiscoverAlbum {
    DiscoverAlbum(mbid: mbid, title: title, artistName: "Air", artistMbid: "a-1", type: type, secondaryTypes: [], availability: availability(state))
  }

  private var air: DiscoverArtistDetail {
    DiscoverArtistDetail(mbid: "a-1", name: "Air", genres: [], albums: [
      release("rg-1", "Moon Safari", .available), release("rg-2", "Talkie Walkie"),
      release("rg-3", "Premiers Symptômes", type: "EP", .partial), release("rg-4", "The Virgin Suicides", type: "Soundtrack"),
    ])
  }

  @Test func splitsAlbumsFromTheRestAndCountsWhatIsHere() {
    let d = Discography(air)
    #expect(d.groups.map(\.title) == ["Albums", "EPs & soundtracks"])
    #expect(d.groups.map { $0.albums.map(\.mbid) } == [["rg-1", "rg-2"], ["rg-3", "rg-4"]])
    #expect(d.groups[0].kicker == "2 releases")
    #expect(d.summary == "4 releases · 1 in your library")
    #expect(d.empty == nil)
  }

  @Test func highlightsTheAlbumASongLedTo() {
    #expect(Discography(air, wanted: "Talkie Walkie (Deluxe)").highlighted == "rg-2")
    let missing = Discography(air, wanted: "Kelly Watch the Stars")
    #expect(missing.highlighted == nil)
    #expect(missing.notice == "“Kelly Watch the Stars” isn’t among these albums and EPs; it’s probably a single or a compilation. You can still request it from the song.")
  }

  @Test func saysWhenMusicBrainzListsNothing() {
    let none = DiscoverArtistDetail(mbid: "a-1", name: "Air", genres: [], albums: [])
    #expect(Discography(none).empty == "MusicBrainz lists no albums or EPs for this artist.")
    #expect(Discography(none, wanted: "Moon Safari").notice == nil)
    let failed = DiscoverArtistDetail(mbid: "a-1", name: "Air", genres: [], albums: [], discographyError: "timeout")
    #expect(Discography(failed).empty == nil)
  }

  @Test func listsOnALibraryArtistOnlyWhatIsntHereAtAll() {
    let groups = Discography.notInLibrary(air, owned: [album(title: "Talkie Walkie", mbid: "rg-2")])
    #expect(groups.map(\.title) == ["EPs & soundtracks not in your library"])
    #expect(groups.flatMap(\.albums).map(\.mbid) == ["rg-4"])
  }

  @Test func groupsSimilarArtistsLibraryFirst() {
    let mine = DiscoverArtist(mbid: "a-2", name: "Daft Punk", genres: [], artistId: 3)
    let other = DiscoverArtist(mbid: "a-3", name: "Phoenix", genres: [])
    #expect(SimilarArtistGroups.make([other, mine]).map(\.title) == ["Similar artists in your library", "More similar artists"])
    #expect(SimilarArtistGroups.make([other]).map(\.title) == ["Similar artists"])
  }

  @Test func findsAnArtistByNameThenLeadsOn() async {
    let client = fakeClient { _ in (200, #"{"mbid":"a-1"}"#) }
    let find = FindArtistModel(client: client, name: "Air", album: "Moon Safari")
    await find.load()
    #expect(find.destination == .discoverArtist(mbid: "a-1", album: "Moon Safari"))
    let nobody = FindArtistModel(client: client, name: "")
    await nobody.load()
    #expect(nobody.error == "No artist given.")
  }

  @Test func saysWhyALookupFailed() async {
    let find = FindArtistModel(client: fakeClient { _ in (404, #"{"error":"No artist called “Ayr” on MusicBrainz"}"#) }, name: "Ayr")
    await find.load()
    #expect(find.error == "No artist called “Ayr” on MusicBrainz")
    #expect(find.destination == nil)
  }
}
```

**Step 2: Run them to see them fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter DiscographyTests
```

Expected: the build fails with `cannot find 'Discography' in scope` (and `SimilarArtistGroups`, `FindArtistModel`).

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/Discography.swift`:

```swift
import PlayarrAPI

/// An artist's MusicBrainz discography laid out as the web lays it out (pages/DiscoverArtist.tsx, and the
/// "Not in your library" sections of pages/Artist.tsx).
public struct Discography: Equatable, Sendable {
  public struct Group: Equatable, Sendable, Identifiable {
    public let title: String
    public let albums: [DiscoverAlbum]
    public var id: String { title }
    /// "4 releases".
    public var kicker: String { TextFormat.plural(albums.count, "release") }
  }

  public let groups: [Group]
  /// Releases already playable.
  public let owned: Int
  /// The album a song led here for (`?album=`), when it's among these.
  public let highlighted: String?
  /// Said when that album isn't among them.
  public let notice: String?
  /// "12 releases · 3 in your library".
  public let summary: String
  /// Said when MusicBrainz lists nothing (and didn't fail).
  public let empty: String?

  /// The Discover artist page: Albums, then EPs & soundtracks.
  public init(_ artist: DiscoverArtistDetail, wanted album: String? = nil) {
    groups = Self.split(artist.albums, albums: "Albums", others: "EPs & soundtracks")
    owned = artist.albums.filter { $0.availability.state == .available }.count
    let match = album.flatMap { wanted in artist.albums.first { TitleKey.of($0.title) == TitleKey.of(wanted) } }
    highlighted = match?.mbid
    notice = album.flatMap { wanted in
      match == nil && !artist.albums.isEmpty
        ? "“\(wanted)” isn’t among these albums and EPs; it’s probably a single or a compilation. You can still request it from the song."
        : nil
    }
    summary = "\(TextFormat.plural(artist.albums.count, "release")) · \(owned) in your library"
    empty = artist.discographyError == nil && artist.albums.isEmpty ? "MusicBrainz lists no albums or EPs for this artist." : nil
  }

  /// A library artist's page: their albums and EPs not in the library at all (those partly here have their own
  /// Request in the sections above).
  public static func notInLibrary(_ artist: DiscoverArtistDetail, owned: [Album]) -> [Group] {
    let ownedIds = Set(owned.compactMap(\.mbid))
    let missing = artist.albums.filter { album in
      !ownedIds.contains(album.mbid) && album.availability.state != .available && album.availability.state != .partial
    }
    return split(missing, albums: "Albums not in your library", others: "EPs & soundtracks not in your library")
  }

  private static func split(_ albums: [DiscoverAlbum], albums albumsTitle: String, others: String) -> [Group] {
    [
      Group(title: albumsTitle, albums: albums.filter { $0.type == "Album" }),
      Group(title: others, albums: albums.filter { $0.type != "Album" }),
    ].filter { !$0.albums.isEmpty }
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/SimilarArtistGroups.swift`:

```swift
import PlayarrAPI

/// Artists like this one (ListenBrainz): those in the library first, then the others (components/SimilarArtists.tsx).
public enum SimilarArtistGroups {
  public static let kicker = "From ListenBrainz"
  public static let failed = "Couldn’t reach ListenBrainz for similar artists right now."

  public static func make(_ artists: [DiscoverArtist]) -> [(title: String, artists: [DiscoverArtist])] {
    let mine = artists.filter { $0.artistId != nil }
    let others = artists.filter { $0.artistId == nil }
    return [
      ("Similar artists in your library", mine),
      (mine.isEmpty ? "Similar artists" : "More similar artists", others),
    ].filter { !$0.1.isEmpty }
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverArtistModel.swift`:

```swift
import Observation
import PlayarrAPI

/// The Discover artist page: an artist's MusicBrainz discography with what's in the library and what can be
/// requested (pages/DiscoverArtist.tsx).
@MainActor @Observable
public final class DiscoverArtistModel {
  public let mbid: String
  public let wantedAlbum: String?
  public private(set) var artist: DiscoverArtistDetail?
  public private(set) var error: String?
  public private(set) var loading = false

  @ObservationIgnored private let context: DiscoverContext

  public init(context: DiscoverContext, mbid: String, album: String? = nil) {
    self.context = context
    self.mbid = mbid
    wantedAlbum = album
  }

  public var discography: Discography? { artist.map { Discography($0, wanted: wantedAlbum) } }

  /// Loads (or loads again: "Try again" after MusicBrainz failed, or after a request changed what's here).
  public func load(again: Bool = false) async {
    if again { context.invalidate([.discoverArtist]) }
    loading = true
    defer { loading = false }
    do {
      artist = try await context.discoverArtist(mbid)
      error = nil
    } catch is CancellationError {
    } catch {
      self.error = error.localizedDescription
    }
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/FindArtistModel.swift`:

```swift
import Observation
import PlayarrAPI

/// Songs from outside the library only know an artist's name: look it up, then go where it leads (FindArtist.tsx).
@MainActor @Observable
public final class FindArtistModel {
  public let name: String
  public let album: String?
  public private(set) var destination: DiscoverDestination?
  public private(set) var error: String?

  @ObservationIgnored private let client: APIClient

  public init(client: APIClient, name: String, album: String? = nil) {
    self.client = client
    self.name = name
    self.album = album
  }

  public func load() async {
    guard !name.isEmpty else {
      error = "No artist given."
      return
    }
    do {
      let match = try await client.send(API.Discover.findArtist(name: name))
      destination = .found(match, name: name, album: album)
    } catch is CancellationError {
    } catch {
      self.error = error.localizedDescription
    }
  }
}
```

**Step 4: Run them to see them pass**

Same command. Expected: `Test run with 7 tests` … `passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/Discography.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/SimilarArtistGroups.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverArtistModel.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/FindArtistModel.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/DiscographyTests.swift
git commit -F - <<'EOF'
iOS: lay out an artist's MusicBrainz discography as the web does, group similar artists, and find an artist by name

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 9: A request row's small print

pages/Requests.tsx: Lidarr's message or the state, and "requested 2 hours ago" (the web's `ago()`: days, hours or minutes, rounded, said the natural way, "just now" under a minute). `ServerDate` reads the server's ISO times with or without milliseconds.

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shared/ServerDate.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Requests/RequestRowText.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/RequestRowTextTests.swift`

**Step 1: Write the failing tests**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/RequestRowTextTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@Suite struct RequestRowTextTests {
  let english = Locale(identifier: "en_US")
  let now = ServerDate.parse("2026-11-03T12:00:00.000Z")!

  @Test func saysHowLongAgoTheWebsWay() {
    #expect(RequestRowText.ago("2026-11-03T11:59:30.000Z", now: now, locale: english) == "just now")
    #expect(RequestRowText.ago("2026-11-03T11:55:00Z", now: now, locale: english) == "5 minutes ago")
    #expect(RequestRowText.ago("2026-11-03T10:00:00.000Z", now: now, locale: english) == "2 hours ago")
    #expect(RequestRowText.ago("2026-11-02T12:00:00.000Z", now: now, locale: english) == "yesterday")
    #expect(RequestRowText.ago("2026-10-30T12:00:00.000Z", now: now, locale: english) == "4 days ago")
  }

  @Test func showsLidarrsMessageElseTheState() {
    var request = albumRequest("rg-1", "Mezzanine", .searching)
    #expect(RequestRowText.status(request, now: now, locale: english) == "searching · requested 2 hours ago")
    request.availability = availability(.available, albumId: 70)
    #expect(RequestRowText.status(request, now: now, locale: english) == "Ready to play · requested 2 hours ago")
    request.availability = availability(.downloading, message: "Downloading 2 of 12")
    #expect(RequestRowText.status(request, now: now, locale: english) == "Downloading 2 of 12 · requested 2 hours ago")
  }
}
```

**Step 2: Run them to see them fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter RequestRowTextTests
```

Expected: the build fails with `cannot find 'ServerDate' in scope` (and `RequestRowText`).

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shared/ServerDate.swift`:

```swift
import Foundation

/// The server's ISO 8601 times ("2026-11-03T10:00:00.000Z"), with or without milliseconds.
public enum ServerDate {
  public static func parse(_ text: String) -> Date? {
    (try? Date(text, strategy: .iso8601.year().month().day().time(includingFractionalSeconds: true)))
      ?? (try? Date(text, strategy: .iso8601))
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Requests/RequestRowText.swift`:

```swift
import Foundation
import PlayarrAPI

/// A Requests row's small print: Lidarr's message or the state, and when it was asked for (pages/Requests.tsx).
public enum RequestRowText {
  /// "Downloading 2 of 12 · requested 2 hours ago", "Ready to play · requested yesterday".
  public static func status(_ request: AlbumRequest, now: Date = Date(), locale: Locale = .current) -> String {
    let state = request.availability.state
    let what = request.availability.message ?? (state == .available ? "Ready to play" : state.rawValue)
    return "\(what) · requested \(ago(request.requestedAt, now: now, locale: locale))"
  }

  /// The web's ago(): days, hours or minutes, rounded, said the natural way ("yesterday"); under a minute "just now".
  public static func ago(_ iso: String, now: Date = Date(), locale: Locale = .current) -> String {
    guard let date = ServerDate.parse(iso) else { return "" }
    let seconds = date.timeIntervalSince(now)
    let formatter = RelativeDateTimeFormatter()
    formatter.locale = locale
    formatter.dateTimeStyle = .named
    for (unit, size) in [(Calendar.Component.day, 86_400.0), (.hour, 3_600), (.minute, 60)] where abs(seconds) >= size {
      var parts = DateComponents()
      parts.setValue(Int(TextFormat.jsRound(seconds / size)), for: unit)
      return formatter.localizedString(from: parts)
    }
    return "just now"
  }
}
```

**Step 4: Run them to see them pass**

Same command. Expected: `Test run with 2 tests` … `passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shared/ServerDate.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Requests/RequestRowText.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/RequestRowTextTests.swift
git commit -F - <<'EOF'
iOS: say how a request is doing and when it was asked for, as the Requests page does

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 10: The Request button, the requests pill and "Request the rest"

The controls, drawn: `Pill` is the web's small rounded monospaced control; `RequestButton` draws Task 2's states (a spinner while requesting, searching and importing, a fill behind the percentage, green "In library" and "3/12" opening the album, red Retry); `RequestsPill` is "2 requests in progress" on Search; `RequestRestButton` is Album.tsx's `RequestRest`. `DiscoverCover` is the one file that uses phase 4's image view (decision 8). Album pages hold an `AlbumDetail`, so `Album(_:)` takes the album out of it.

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/Album+Detail.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/Pill.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverCover.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Requests/RequestButton.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Requests/RequestsPill.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Requests/RequestRestButton.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/AlbumDetailTests.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/AlbumDetailTests.swift`:

```swift
import PlayarrAPI
import Testing
@testable import PlayarrUI

@Suite struct AlbumDetailTests {
  @Test func takesTheAlbumOutOfAnAlbumPage() {
    let detail = AlbumDetail(
      id: 70, title: "Mezzanine", artistId: 7, artistName: "Massive Attack", albumType: "Album", secondaryTypes: [], genres: [],
      duration: 3000, trackCount: 3, totalTrackCount: 11, mbid: "rg-1", tracks: [], discCount: 1, missingTracks: [])
    #expect(Album(detail) == album(mbid: "rg-1", have: 3, total: 11))
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter AlbumDetailTests
```

Expected: the build fails at `Album(detail)`: no initializer of `Album` takes an `AlbumDetail`.

**Step 3: Implement**

If Task 0 found phase 4's image view under another name than `CoverImage(path:size:)`, use it in `DiscoverCover.swift`.

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/Album+Detail.swift`:

```swift
import PlayarrAPI

extension Album {
  /// The album part of an album page's answer (AlbumDetail repeats Album's fields).
  public init(_ detail: AlbumDetail) {
    self.init(
      id: detail.id, title: detail.title, artistId: detail.artistId, artistName: detail.artistName, year: detail.year,
      releaseDate: detail.releaseDate, albumType: detail.albumType, secondaryTypes: detail.secondaryTypes, genres: detail.genres,
      duration: detail.duration, trackCount: detail.trackCount, totalTrackCount: detail.totalTrackCount, coverUrl: detail.coverUrl,
      addedAt: detail.addedAt, format: detail.format, mbid: detail.mbid, mayBeIncomplete: detail.mayBeIncomplete)
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/Pill.swift`:

```swift
import SwiftUI

/// The web's small rounded, monospaced, upper-case control (Request buttons, Requests pill, Try again).
/// How a Pill is drawn: filled with the accent (asks for something), outlined (in progress), green (in the
/// library), red (failed), or quiet.
enum PillTone { case filled, outlined, done, warning, quiet }

struct Pill<Label: View>: View {
  var style: PillTone = .outlined
  var small = false
  /// 0–1: a download's share, drawn behind the label.
  var progress: Double?
  @ViewBuilder let label: Label

  var body: some View {
    label
      .font(.system(size: small ? 10 : 11, weight: .medium, design: .monospaced))
      .textCase(.uppercase)
      .tracking(0.8)
      .lineLimit(1)
      .padding(.horizontal, small ? 10 : 14)
      .frame(height: small ? 28 : 32)
      .foregroundStyle(foreground)
      .background {
        ZStack(alignment: .leading) {
          if style == .filled { Capsule().fill(.tint) }
          if let progress {
            GeometryReader { box in
              Rectangle().fill(.tint.opacity(0.15)).frame(width: box.size.width * min(max(progress, 0), 1))
            }
            .clipShape(Capsule())
          }
          if style != .filled { Capsule().strokeBorder(border, lineWidth: 1) }
        }
      }
      .contentShape(Capsule())
  }

  private var foreground: AnyShapeStyle {
    switch style {
    case .filled: AnyShapeStyle(.background)
    case .outlined: AnyShapeStyle(.tint)
    case .done: AnyShapeStyle(.green)
    case .warning: AnyShapeStyle(.red)
    case .quiet: AnyShapeStyle(.secondary)
    }
  }

  private var border: AnyShapeStyle {
    switch style {
    case .filled, .outlined: AnyShapeStyle(.tint.opacity(0.4))
    case .done: AnyShapeStyle(.green.opacity(0.35))
    case .warning: AnyShapeStyle(.red.opacity(0.45))
    case .quiet: AnyShapeStyle(.separator)
    }
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverCover.swift`:

```swift
import SwiftUI

/// A cover or artist picture in this phase's screens. The one place that uses phase 4's image view, so a different
/// name there changes only this file.
struct DiscoverCover: View {
  let path: String?
  var size: CGFloat
  var round = false

  var body: some View {
    CoverImage(path: path, size: Int(size * 2))
      .frame(width: size, height: size)
      .clipShape(round ? AnyShape(Circle()) : AnyShape(RoundedRectangle(cornerRadius: 4)))
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Requests/RequestButton.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// One control for every state of an album that may not be in the library yet (components/Discover.tsx):
/// Request → Requesting (Looking up) → Searching → 42% → Importing → In library; Search again and Retry when Lidarr
/// is stuck; "3/12" and Request for an album partly here. Hidden where nothing may be asked for.
public struct RequestButton: View {
  let album: AlbumRef
  let availability: Availability
  var small: Bool

  @Environment(DiscoverContext.self) private var context: DiscoverContext?

  public init(album: AlbumRef, availability: Availability, small: Bool = false) {
    self.album = album
    self.availability = availability
    self.small = small
  }

  public var body: some View {
    if let context {
      control(context.requests.buttonState(for: album, availability: availability, allowed: context.gate.allowsRequests), context.requests)
    }
  }

  @ViewBuilder
  private func control(_ state: RequestButtonState, _ requests: RequestsModel) -> some View {
    switch state {
    case .hidden:
      EmptyView()
    case .requesting:
      Pill(style: .quiet, small: small) { HStack(spacing: 6) { ProgressView().controlSize(.mini); Text(state.label) } }
        .help(state.help ?? "")
    case .partial(let count, let summary, let albumId, let canRequest):
      HStack(spacing: 6) {
        if let albumId {
          NavigationLink(value: DiscoverDestination.libraryAlbum(id: albumId)) { Pill(style: .done, small: small) { Text(count) } }
            .buttonStyle(.plain)
            .accessibilityLabel("\(summary): open the album")
        } else {
          Pill(style: .done, small: small) { Text(count) }.accessibilityLabel(summary)
        }
        if canRequest {
          Button { requests.request(album) } label: {
            Pill(style: .filled, small: small) { Label("Request", systemImage: "arrow.down") }
          }
          .buttonStyle(.plain)
          .help("Request the whole album")
        }
      }
    case .request:
      ask(requests, style: .filled, icon: "arrow.down", state)
    case .searchAgain:
      ask(requests, style: .quiet, icon: "clock", state)
    case .retry:
      ask(requests, style: .warning, icon: "exclamationmark.triangle", state)
    case .searching, .importing:
      Pill(style: .outlined, small: small) { HStack(spacing: 6) { ProgressView().controlSize(.mini); Text(state.label) } }
        .help(state.help ?? "")
    case .downloading(let percent, _):
      Pill(style: .outlined, small: small, progress: Double(percent) / 100) { Label(state.label, systemImage: "arrow.down") }
        .help(state.help ?? "")
        .accessibilityLabel("Downloading, \(percent)%")
    case .inLibrary(let albumId):
      if let albumId {
        NavigationLink(value: DiscoverDestination.libraryAlbum(id: albumId)) {
          Pill(style: .done, small: small) { Label(state.label, systemImage: "checkmark") }
        }
        .buttonStyle(.plain)
      } else {
        Pill(style: .done, small: small) { Label(state.label, systemImage: "checkmark") }
      }
    }
  }

  private func ask(_ requests: RequestsModel, style: PillTone, icon: String, _ state: RequestButtonState) -> some View {
    Button { requests.request(album) } label: {
      Pill(style: style, small: small) { Label(state.label, systemImage: icon) }
    }
    .buttonStyle(.plain)
    .help(state.help ?? "")
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Requests/RequestsPill.swift`:

```swift
import SwiftUI

/// "2 requests in progress", opening Requests (Search, while any are on their way).
public struct RequestsPill: View {
  @Environment(DiscoverContext.self) private var context: DiscoverContext?

  public init() {}

  public var body: some View {
    if let count = context?.requests.activeCount, count > 0 {
      NavigationLink(value: DiscoverDestination.requests) {
        Pill(style: .outlined) {
          Label(TextFormat.plural(count, "request") + " in progress", systemImage: "arrow.triangle.2.circlepath")
        }
      }
      .buttonStyle(.plain)
    }
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Requests/RequestRestButton.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// "Request the rest" on an album page: only some of the album is here, so ask Lidarr for the whole of it, then show
/// how that's going (components/Discover.tsx RequestRest).
public struct RequestRestButton: View {
  let album: Album

  @Environment(DiscoverContext.self) private var context: DiscoverContext?

  public init(album: Album) {
    self.album = album
  }

  public var body: some View {
    if let rest = context?.requests.rest(of: album) {
      RequestButton(album: rest.album, availability: rest.availability)
    }
  }
}
```

**Step 4: Run it to see it pass, and build for the simulator**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter AlbumDetailTests
swift build --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --scratch-path /tmp/playarr-ios-build --triple arm64-apple-ios26.0-simulator --sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)"
```

Expected: `Test run with 1 test` … `passed`; `Build complete!`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/Album+Detail.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/Pill.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverCover.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Requests/RequestButton.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Requests/RequestsPill.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Requests/RequestRestButton.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/AlbumDetailTests.swift
git commit -F - <<'EOF'
iOS: the Request button in every state, the requests-in-progress pill, and Request the rest

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 11: Discover's cards, rows and Search section; the MusicBrainz wait and queue

components/Discover.tsx's `DiscoverAlbumCard` (the kind or "3 of 12" badge, the highlight ring), `DiscoverTrackRow` (artist and album leading on) and `DiscoverArtistCard`; Search.tsx's `DiscoverSection` (the header "Not in your library" with Lidarr · MusicBrainz · Deezer, skeleton rows, the error, "Nothing found for …", Songs with "Request the album it’s on", Albums and Artists shelves); `SlowLookup` (after 1.5 s) and the Library page's `MusicBrainzIndicator`. Views only: their rules were tested in Tasks 2 to 8.

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverSectionHeader.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverShelf.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverAlbumCard.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverTrackRow.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverArtistCard.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverSection.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/TryAgainButton.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/MusicBrainz/SlowLookup.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/MusicBrainz/MusicBrainzIndicator.swift`

**Step 1: Write them**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverSectionHeader.swift`:

```swift
import SwiftUI

/// A section title with its small upper-case kicker, as the web's SectionHeader.
struct DiscoverSectionHeader: View {
  let title: String
  var kicker: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      if let kicker {
        Text(kicker).font(.system(size: 11, design: .monospaced)).textCase(.uppercase).tracking(2).foregroundStyle(.secondary)
      }
      Text(title).font(.title2.weight(.semibold))
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(.isHeader)
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverShelf.swift`:

```swift
import SwiftUI

/// A row of cards that scrolls sideways, as the web's Shelf.
struct DiscoverShelf<Content: View>: View {
  @ViewBuilder let content: Content

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      LazyHStack(alignment: .top, spacing: 16) { content }.padding(.horizontal, 20)
    }
    .padding(.horizontal, -20)
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverAlbumCard.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// An album from MusicBrainz: cover, title, artist and year, what kind it is (or how much of it is here), and its
/// Request button. Opens the album when any of it is here, else the artist's discography.
public struct DiscoverAlbumCard: View {
  let album: DiscoverAlbum
  var highlighted = false
  var width: CGFloat = 160

  public init(album: DiscoverAlbum, highlighted: Bool = false, width: CGFloat = 160) {
    self.album = album
    self.highlighted = highlighted
    self.width = width
  }

  private var kind: String {
    let a = album.availability
    let partial = a.state == .partial || (a.have != nil && a.albumId != nil)
    if partial, let have = a.have, let total = a.total, total > 0 { return "\(have) of \(total)" }
    return album.secondaryTypes.first ?? album.type
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      NavigationLink(value: DiscoverDestination.card(album)) {
        VStack(alignment: .leading, spacing: 8) {
          DiscoverCover(path: album.coverUrl, size: width)
            .saturation(album.availability.state == .available || highlighted ? 1 : 0.85)
            .overlay(alignment: .topLeading) {
              if album.availability.state != .available {
                Text(kind)
                  .font(.system(size: 9, design: .monospaced)).textCase(.uppercase).tracking(1.5)
                  .padding(.horizontal, 6).padding(.vertical, 2)
                  .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 3))
                  .padding(8)
              }
            }
            .overlay {
              if highlighted { RoundedRectangle(cornerRadius: 4).strokeBorder(.tint, lineWidth: 2).padding(-4) }
            }
          VStack(alignment: .leading, spacing: 2) {
            Text(album.title).font(.subheadline).lineLimit(1)
            Text(album.year.map { "\(album.artistName) · \($0)" } ?? album.artistName)
              .font(.footnote).foregroundStyle(.secondary).lineLimit(1)
          }
        }
      }
      .buttonStyle(.plain)
      RequestButton(album: AlbumRef(mbid: album.mbid, artistName: album.artistName, albumTitle: album.title), availability: album.availability, small: true)
    }
    .frame(width: width, alignment: .leading)
    .id(album.mbid)
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverTrackRow.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// A song not in the library: its cover, title, artist and album (each leading on), length, and the Request button
/// for the album it's on. Opens its album when the album is (partly) here.
public struct DiscoverTrackRow: View {
  let track: DiscoverTrack

  public init(track: DiscoverTrack) {
    self.track = track
  }

  public var body: some View {
    HStack(spacing: 12) {
      if let opens = DiscoverDestination.row(track) {
        NavigationLink(value: opens) { heading }.buttonStyle(.plain)
      } else {
        heading
      }
      Spacer(minLength: 8)
      if let duration = track.duration {
        Text(TextFormat.clock(duration)).font(.footnote.monospacedDigit()).foregroundStyle(.secondary)
      }
      RequestButton(album: track.album, availability: track.availability, small: true)
    }
    .padding(.vertical, 6)
  }

  private var heading: some View {
    HStack(spacing: 12) {
      DiscoverCover(path: track.coverUrl, size: 44)
      VStack(alignment: .leading, spacing: 2) {
        Text(track.title).lineLimit(1)
        HStack(spacing: 4) {
          NavigationLink(track.artistName, value: DiscoverDestination.artist(id: track.artistId, mbid: track.artistMbid, name: track.artistName))
          Text("·").foregroundStyle(.tertiary)
          NavigationLink(
            track.albumTitle,
            value: DiscoverDestination.album(
              id: track.availability.state == .available ? track.availability.albumId : nil,
              artistMbid: track.artistMbid, artistName: track.artistName, title: track.albumTitle))
        }
        .buttonStyle(.plain)
        .font(.footnote)
        .foregroundStyle(.secondary)
        .lineLimit(1)
      }
    }
    .contentShape(Rectangle())
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverArtistCard.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// An artist from MusicBrainz or ListenBrainz: their library page when they're in it, else their discography.
public struct DiscoverArtistCard: View {
  let artist: DiscoverArtist
  var width: CGFloat = 132

  public init(artist: DiscoverArtist, width: CGFloat = 132) {
    self.artist = artist
    self.width = width
  }

  public var body: some View {
    NavigationLink(value: DiscoverDestination.card(artist)) {
      VStack(spacing: 8) {
        DiscoverCover(path: artist.imageUrl, size: width, round: true)
        Text(artist.name).font(.subheadline).lineLimit(1)
        Text(artist.artistId != nil ? "In your library" : (artist.disambiguation ?? artist.genres.first ?? "Artist"))
          .font(.system(size: 10, design: .monospaced)).textCase(.uppercase).tracking(1.5)
          .foregroundStyle(.secondary).lineLimit(1)
      }
      .frame(width: width)
    }
    .buttonStyle(.plain)
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverSection.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// Search's "Not in your library" (Search.tsx DiscoverSection): songs, albums and artists from MusicBrainz, Lidarr
/// and Deezer, each with request controls. Shown under the library results when the server has Lidarr.
public struct DiscoverSection: View {
  let query: String

  @Environment(DiscoverContext.self) private var context: DiscoverContext?

  /// `query`: what's typed, trimmed.
  public init(query: String) {
    self.query = query
  }

  public var body: some View {
    if let context, context.gate.hasLidarr, !query.isEmpty {
      DiscoverResultsView(context: context, query: query)
    }
  }
}

private struct DiscoverResultsView: View {
  let context: DiscoverContext
  let query: String
  @State private var model: DiscoverSearchModel

  init(context: DiscoverContext, query: String) {
    self.context = context
    self.query = query
    _model = State(initialValue: DiscoverSearchModel(context: context))
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 28) {
      Divider()
      VStack(alignment: .leading, spacing: 6) {
        Text("Lidarr · MusicBrainz · Deezer").font(.system(size: 11, design: .monospaced)).textCase(.uppercase).tracking(2).foregroundStyle(.secondary)
        HStack(spacing: 10) {
          Text("Not in your library").font(.largeTitle.weight(.semibold))
          if model.fetching { Circle().fill(.tint).frame(width: 8, height: 8).accessibilityLabel("Searching") }
        }
        Text("Request an album and Lidarr will search your indexers for it. It shows up here when it’s ready.")
          .font(.footnote).foregroundStyle(.secondary)
      }
      if model.loading {
        VStack(spacing: 12) { ForEach(0..<4, id: \.self) { _ in RoundedRectangle(cornerRadius: 6).fill(.quaternary).frame(height: 56) } }
      }
      if let error = model.error, model.results == nil {
        Text(error).font(.footnote).foregroundStyle(.red)
      }
      if model.nothing {
        Text("Nothing found for “\(model.answered)”.").font(.footnote).foregroundStyle(.secondary)
      }
      if !model.tracks.isEmpty {
        VStack(alignment: .leading, spacing: 8) {
          DiscoverSectionHeader(title: "Songs", kicker: "Request the album it’s on")
          ForEach(model.tracks, id: \.id) { DiscoverTrackRow(track: $0) }
        }
      }
      if !model.albums.isEmpty {
        VStack(alignment: .leading, spacing: 12) {
          DiscoverSectionHeader(title: "Albums")
          DiscoverShelf { ForEach(model.albums, id: \.mbid) { DiscoverAlbumCard(album: $0) } }
        }
      }
      if !model.artists.isEmpty {
        VStack(alignment: .leading, spacing: 12) {
          DiscoverSectionHeader(title: "Artists")
          DiscoverShelf { ForEach(model.artists, id: \.mbid) { DiscoverArtistCard(artist: $0) } }
        }
      }
    }
    .padding(.top, 32)
    .task(id: query) { model.update(query) }
    .onChange(of: context.generation(.discover)) { Task { await model.reload() } }
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/TryAgainButton.swift`:

```swift
import SwiftUI

/// "Try again" (or "Retrying…" while it does), after MusicBrainz couldn't be reached.
struct TryAgainButton: View {
  let busy: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) { Pill(style: .quiet) { Text(busy ? "Retrying…" : "Try again") } }
      .buttonStyle(.plain)
      .disabled(busy)
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/MusicBrainz/SlowLookup.swift`:

```swift
import SwiftUI

/// Explains a MusicBrainz wait instead of leaving a bare spinner (components/SlowLookup.tsx). Put it on screen while a
/// lookup runs: it appears after 1.5 s, and says when Playarr's own background matching is ahead in the line.
public struct SlowLookup: View {
  let what: String

  @Environment(DiscoverContext.self) private var context: DiscoverContext?
  @State private var shown = false

  /// `what`: "this artist’s albums", "“Air”".
  public init(what: String) {
    self.what = what
  }

  public var body: some View {
    Group {
      if shown {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
          Circle().fill(.tint).frame(width: 6, height: 6)
          Text(SlowLookupText.waiting(for: what, status: context?.musicBrainz.status))
            .font(.footnote).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
      }
    }
    .task {
      do { try await Task.sleep(for: SlowLookupText.after) } catch { return }
      shown = true
      await context?.musicBrainz.watch()
    }
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/MusicBrainz/MusicBrainzIndicator.swift`:

```swift
import SwiftUI

/// The MusicBrainz queue, while lookups wait (the desktop sidebar's footer; on the phone, the Library page's foot).
public struct MusicBrainzIndicator: View {
  @Environment(DiscoverContext.self) private var context: DiscoverContext?

  public init() {}

  public var body: some View {
    Group {
      if let status = context?.musicBrainz.status, status.queued > 0 {
        HStack(spacing: 8) {
          Circle().fill(.tint).frame(width: 6, height: 6)
          Text("MusicBrainz")
          Text(SlowLookupText.queued(status)).foregroundStyle(.secondary)
        }
        .font(.system(size: 11, design: .monospaced))
        .foregroundStyle(.secondary)
        .accessibilityElement(children: .combine)
        .accessibilityHint(SlowLookupText.explanation(status))
      }
    }
    .task { await context?.musicBrainz.watch() }
  }
}
```

**Step 2: Build for the Mac and the simulator**

```bash
swift build --disable-sandbox --package-path apps/ios/Packages/PlayarrUI
swift build --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --scratch-path /tmp/playarr-ios-build --triple arm64-apple-ios26.0-simulator --sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)"
```

Expected: `Build complete!` twice, with no warnings.

**Step 3: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverSectionHeader.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverShelf.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverAlbumCard.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverTrackRow.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverArtistCard.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverSection.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/TryAgainButton.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/MusicBrainz/SlowLookup.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/MusicBrainz/MusicBrainzIndicator.swift
git commit -F - <<'EOF'
iOS: Discover's album, song and artist cards, Search's Not in your library, and the MusicBrainz wait and queue

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 12: The Discover artist page, Find artist, "Not in your library" on an artist, and Requests

pages/DiscoverArtist.tsx (the hero with genres, the count and "Open in your library", Read more, the groups in a grid, the highlighted album scrolled into view, the discography error with Try again, similar artists), pages/FindArtist.tsx (decision 7), pages/Artist.tsx's `NotInLibrary`, components/SimilarArtists.tsx, and pages/Requests.tsx (the intro, each request with its cover, small print and download bar, its Request button, swipe or long-press to remove from the list, pull to refresh, the empty text). `discoverDestinations()` is what each tab's navigation stack gets (Task 21).

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/SimilarArtistsSection.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverArtistPage.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/FindArtistPage.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/NotInLibrarySection.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverDestinationView.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Requests/RequestsPage.swift`

**Step 1: Write them**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/SimilarArtistsSection.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// Artists like this one, from who real listeners play alongside them (ListenBrainz): those in the library, then the
/// others, opening their discography to request albums (components/SimilarArtists.tsx).
public struct SimilarArtistsSection: View {
  let mbid: String

  @Environment(DiscoverContext.self) private var context: DiscoverContext?
  @State private var artists: [DiscoverArtist]?
  @State private var failed = false

  public init(mbid: String) {
    self.mbid = mbid
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 28) {
      if failed {
        DiscoverSectionHeader(title: "Similar artists", kicker: SimilarArtistGroups.kicker)
        Text(SimilarArtistGroups.failed).font(.footnote).foregroundStyle(.secondary)
      } else if let artists {
        ForEach(SimilarArtistGroups.make(artists), id: \.title) { group in
          VStack(alignment: .leading, spacing: 12) {
            DiscoverSectionHeader(title: group.title, kicker: SimilarArtistGroups.kicker)
            DiscoverShelf { ForEach(group.artists, id: \.mbid) { DiscoverArtistCard(artist: $0) } }
          }
        }
      } else {
        DiscoverSectionHeader(title: "Similar artists", kicker: SimilarArtistGroups.kicker)
        DiscoverShelf { ForEach(0..<6, id: \.self) { _ in Circle().fill(.quaternary).frame(width: 132, height: 132) } }
      }
    }
    .task(id: mbid) {
      do {
        artists = try await context?.similarArtists(mbid)
        failed = false
      } catch is CancellationError {
      } catch {
        failed = true
      }
    }
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverArtistPage.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// An artist's discography from MusicBrainz, with what's in the library and what can be requested
/// (pages/DiscoverArtist.tsx): Albums, then EPs & soundtracks; `album` brings one into view and marks it.
public struct DiscoverArtistPage: View {
  let mbid: String
  let album: String?

  @Environment(DiscoverContext.self) private var context: DiscoverContext?

  public init(mbid: String, album: String? = nil) {
    self.mbid = mbid
    self.album = album
  }

  public var body: some View {
    if let context {
      DiscographyView(context: context, model: DiscoverArtistModel(context: context, mbid: mbid, album: album))
    }
  }
}

private struct DiscographyView: View {
  let context: DiscoverContext
  @State var model: DiscoverArtistModel
  @State private var bioOpen = false

  private let columns = [GridItem(.adaptive(minimum: 150), spacing: 16, alignment: .top)]

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        VStack(alignment: .leading, spacing: 32) {
          if let artist = model.artist, let discography = model.discography {
            hero(artist, discography)
            if let notice = discography.notice { Text(notice).font(.footnote).foregroundStyle(.secondary) }
            ForEach(discography.groups) { group in
              VStack(alignment: .leading, spacing: 12) {
                DiscoverSectionHeader(title: group.title, kicker: group.kicker)
                LazyVGrid(columns: columns, alignment: .leading, spacing: 24) {
                  ForEach(group.albums, id: \.mbid) { DiscoverAlbumCard(album: $0, highlighted: $0.mbid == discography.highlighted) }
                }
              }
            }
            if let failure = artist.discographyError {
              VStack(alignment: .leading, spacing: 8) {
                Text("Couldn’t load the discography from MusicBrainz right now.").font(.subheadline).foregroundStyle(.secondary)
                Text(failure).font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary)
                TryAgainButton(busy: model.loading) { Task { await model.load(again: true) } }
              }
            } else if let empty = discography.empty {
              Text(empty).foregroundStyle(.secondary)
            }
            SimilarArtistsSection(mbid: artist.mbid)
          } else if let error = model.error {
            VStack(alignment: .leading, spacing: 12) {
              Text(error).foregroundStyle(.secondary)
              TryAgainButton(busy: model.loading) { Task { await model.load(again: true) } }
            }
          } else {
            VStack(alignment: .leading, spacing: 16) {
              RoundedRectangle(cornerRadius: 4).fill(.quaternary).frame(width: 160, height: 14)
              RoundedRectangle(cornerRadius: 6).fill(.quaternary).frame(width: 280, height: 48)
              SlowLookup(what: "this artist’s albums")
              LazyVGrid(columns: columns, spacing: 16) {
                ForEach(0..<8, id: \.self) { _ in RoundedRectangle(cornerRadius: 4).fill(.quaternary).aspectRatio(1, contentMode: .fit) }
              }
            }
          }
        }
        .padding(20)
      }
      .onChange(of: model.discography?.highlighted) { _, mbid in
        guard let mbid else { return }
        withAnimation { proxy.scrollTo(mbid, anchor: .center) }
      }
    }
    .navigationTitle(model.artist?.name ?? "")
    .task(id: context.generation(.discoverArtist)) { await model.load() }
  }

  private func hero(_ artist: DiscoverArtistDetail, _ discography: Discography) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(artist.genres.isEmpty ? (artist.disambiguation ?? "Artist") : artist.genres.joined(separator: " · "))
        .font(.system(size: 11, design: .monospaced)).textCase(.uppercase).tracking(2.5).foregroundStyle(.secondary)
      Text(artist.name).font(.largeTitle.weight(.bold))
      HStack(spacing: 16) {
        Text(discography.summary)
        if let id = artist.artistId {
          NavigationLink(value: DiscoverDestination.libraryArtist(id: id)) { Label("Open in your library", systemImage: "arrow.right") }
            .foregroundStyle(.tint)
        }
      }
      .font(.system(size: 12, design: .monospaced))
      .foregroundStyle(.secondary)
      if let overview = artist.overview {
        Text(overview).font(.callout).foregroundStyle(.secondary).lineLimit(bioOpen ? nil : 3)
        Button(bioOpen ? "Less" : "Read more") { bioOpen.toggle() }
          .font(.system(size: 11, design: .monospaced)).textCase(.uppercase)
      }
    }
    .background(alignment: .topLeading) {
      DiscoverCover(path: artist.imageUrl, size: 360).blur(radius: 60).opacity(0.35).allowsHitTesting(false).accessibilityHidden(true)
    }
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/FindArtistPage.swift`:

```swift
import SwiftUI

/// Songs from outside the library only know an artist's name: look it up on MusicBrainz, then show what it leads to
/// in place (the web redirects: FindArtist.tsx).
public struct FindArtistPage: View {
  let name: String
  let album: String?

  @Environment(DiscoverContext.self) private var context: DiscoverContext?

  public init(name: String, album: String? = nil) {
    self.name = name
    self.album = album
  }

  public var body: some View {
    if let context {
      FindArtistView(context: context, model: FindArtistModel(client: context.client, name: name, album: album))
    }
  }
}

private struct FindArtistView: View {
  let context: DiscoverContext
  @State var model: FindArtistModel

  var body: some View {
    Group {
      if let destination = model.destination {
        DiscoverDestinationView(destination: destination)
      } else {
        ScrollView {
          VStack(alignment: .leading, spacing: 16) {
            Text("Artist").font(.system(size: 11, design: .monospaced)).textCase(.uppercase).tracking(2.5).foregroundStyle(.secondary)
            Text(model.name).font(.largeTitle.weight(.bold))
            if let error = model.error {
              Text(error).font(.footnote).foregroundStyle(.secondary)
              if !model.name.isEmpty {
                Button("Search for “\(model.name)” instead") { context.openSearch(model.name) }.font(.footnote)
              }
            } else {
              Text("Looking them up on MusicBrainz…").font(.system(size: 12, design: .monospaced)).foregroundStyle(.secondary)
              SlowLookup(what: "“\(model.name)”")
              RoundedRectangle(cornerRadius: 6).fill(.quaternary).frame(height: 190)
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(20)
        }
      }
    }
    .task { await model.load() }
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/NotInLibrarySection.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// On a library artist's page: their albums and EPs not in the library at all, from their MusicBrainz discography,
/// each with Request (pages/Artist.tsx NotInLibrary). Only for artists with a MusicBrainz id, on a server with Lidarr.
public struct NotInLibrarySection: View {
  let artistMbid: String
  let owned: [Album]

  @Environment(DiscoverContext.self) private var context: DiscoverContext?
  @State private var artist: DiscoverArtistDetail?
  @State private var failed = false
  @State private var loading = false

  private let columns = [GridItem(.adaptive(minimum: 150), spacing: 16, alignment: .top)]

  public init(artistMbid: String, owned: [Album]) {
    self.artistMbid = artistMbid
    self.owned = owned
  }

  public var body: some View {
    if let context, context.gate.hasLidarr {
      content
        .task(id: context.generation(.discoverArtist)) { await load(context) }
    }
  }

  @ViewBuilder private var content: some View {
    if failed || artist?.discographyError != nil {
      VStack(alignment: .leading, spacing: 12) {
        DiscoverSectionHeader(title: "Not in your library")
        Text("Couldn’t load the rest of this artist’s albums from MusicBrainz right now.").font(.footnote).foregroundStyle(.secondary)
        TryAgainButton(busy: loading) { context?.invalidate([.discoverArtist]) }
      }
    } else if let artist {
      VStack(alignment: .leading, spacing: 32) {
        ForEach(Discography.notInLibrary(artist, owned: owned)) { group in
          VStack(alignment: .leading, spacing: 12) {
            DiscoverSectionHeader(title: group.title, kicker: group.kicker)
            LazyVGrid(columns: columns, alignment: .leading, spacing: 24) {
              ForEach(group.albums, id: \.mbid) { DiscoverAlbumCard(album: $0) }
            }
          }
        }
      }
    } else {
      VStack(alignment: .leading, spacing: 12) {
        DiscoverSectionHeader(title: "Not in your library")
        LazyVGrid(columns: columns, spacing: 16) {
          ForEach(0..<4, id: \.self) { _ in RoundedRectangle(cornerRadius: 4).fill(.quaternary).aspectRatio(1, contentMode: .fit) }
        }
        SlowLookup(what: "the rest of this artist’s albums")
      }
    }
  }

  private func load(_ context: DiscoverContext) async {
    loading = true
    defer { loading = false }
    do {
      artist = try await context.discoverArtist(artistMbid)
      failed = false
    } catch is CancellationError {
    } catch {
      failed = true
    }
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverDestinationView.swift`:

```swift
import SwiftUI

/// The page a `DiscoverDestination` shows.
public struct DiscoverDestinationView: View {
  let destination: DiscoverDestination

  @Environment(DiscoverContext.self) private var context: DiscoverContext?

  public init(destination: DiscoverDestination) {
    self.destination = destination
  }

  public var body: some View {
    switch destination {
    case .libraryArtist(let id): context?.libraryArtistPage(id)
    case .libraryAlbum(let id): context?.libraryAlbumPage(id)
    case .discoverArtist(let mbid, let album): DiscoverArtistPage(mbid: mbid, album: album)
    case .findArtist(let name, let album): FindArtistPage(name: name, album: album)
    case .requests: RequestsPage()
    }
  }
}

extension View {
  /// Lets a navigation stack show Discover's pages (each tab's stack gets this once).
  public func discoverDestinations() -> some View {
    navigationDestination(for: DiscoverDestination.self) { DiscoverDestinationView(destination: $0) }
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Requests/RequestsPage.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// Albums asked of Lidarr, with live progress (pages/Requests.tsx). Swipe a row to take it off the list (Lidarr
/// keeps the album wanted).
public struct RequestsPage: View {
  @Environment(DiscoverContext.self) private var context: DiscoverContext?

  public init() {}

  public var body: some View {
    if let context {
      RequestsList(context: context, requests: context.requests)
    }
  }
}

private struct RequestsList: View {
  let context: DiscoverContext
  let requests: RequestsModel

  var body: some View {
    List {
      Section {
        Text("Albums you asked Lidarr to find. Progress updates live; finished albums land in your library automatically.")
          .font(.footnote).foregroundStyle(.secondary)
      }
      if let error = requests.error, requests.requests == nil {
        Text(error).foregroundStyle(.secondary)
      } else if let list = requests.requests {
        if list.isEmpty {
          HStack(spacing: 4) {
            Text("No requests yet.")
            Button("Search") { context.openSearch("") }.buttonStyle(.borderless)
            Text("for something that isn’t in your library and hit Request.")
          }
          .font(.footnote).foregroundStyle(.secondary)
        }
        ForEach(list, id: \.mbid) { request in
          row(request)
            .swipeActions {
              if context.gate.canRequest {
                Button("Remove", role: .destructive) { Task { await requests.remove(request) } }
              }
            }
            .contextMenu {
              if context.gate.canRequest {
                Button("Remove from this list", systemImage: "xmark") { Task { await requests.remove(request) } }
              }
            }
        }
      } else {
        ForEach(0..<3, id: \.self) { _ in RoundedRectangle(cornerRadius: 6).fill(.quaternary).frame(height: 64) }
      }
    }
    .navigationTitle(requests.requests.map { "Requests (\($0.count))" } ?? "Requests")
    .refreshable { await requests.refresh() }
    .task { if requests.requests == nil { await requests.refresh() } }
  }

  @ViewBuilder private func row(_ request: AlbumRequest) -> some View {
    HStack(spacing: 12) {
      if request.availability.state == .available, let id = request.availability.albumId {
        NavigationLink(value: DiscoverDestination.libraryAlbum(id: id)) { summary(request) }
      } else {
        summary(request)
      }
      RequestButton(album: AlbumRef(mbid: request.mbid, artistName: request.artistName, albumTitle: request.title), availability: request.availability, small: true)
        .buttonStyle(.borderless)
    }
    .accessibilityElement(children: .contain)
  }

  private func summary(_ request: AlbumRequest) -> some View {
    HStack(spacing: 12) {
      DiscoverCover(path: request.coverUrl, size: 64)
      VStack(alignment: .leading, spacing: 3) {
        Text(request.title).lineLimit(1)
        Text(request.artistName).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
        TimelineView(.periodic(from: .now, by: 60)) { clock in
          Text(RequestRowText.status(request, now: clock.date)).font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary).lineLimit(1)
        }
        if request.availability.state == .downloading {
          ProgressView(value: min(max(request.availability.progress ?? 0, 0), 1)).frame(maxWidth: 240)
        }
      }
    }
  }
}
```

**Step 2: Build for the Mac and the simulator**

Same two commands as Task 11. Expected: `Build complete!` twice.

**Step 3: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/SimilarArtistsSection.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverArtistPage.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/FindArtistPage.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/NotInLibrarySection.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverDestinationView.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Requests/RequestsPage.swift
git commit -F - <<'EOF'
iOS: the Discover artist page, Find artist, an artist's albums not in the library, similar artists, and the Requests page

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 13: Show metadata's wording

components/TrackMetadataDialog.tsx as values: the song's rows (empty ones left out), a file's rows, its tags, the sound analysis, `describeFormat`, `formatSize`, `describeMatch`, MusicBrainz links only for real ids, `primaryCopy`, the Match again button's four labels and outcomes, and phase 1's admin notes.

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Metadata/MetadataFormat.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/MetadataFormatTests.swift`

**Step 1: Write the failing tests**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/MetadataFormatTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@Suite struct MetadataFormatTests {
  static let recording = "8f1c2e7a-3b4d-4c5e-9f60-718293a4b5c6"

  static func metadata(copies: [TrackCopyMetadata] = [], disc: Int = 1, pathsHidden: Bool = false) -> TrackMetadata {
    TrackMetadata(
      trackId: 700, title: "Angel", artistName: "Massive Attack", albumTitle: "Mezzanine", trackNumber: 1, discNumber: disc,
      duration: 379.4, explicit: false, recordingId: recording, albumId: 70, releaseDate: "1998-04-20T00:00:00Z",
      albumType: "Album", secondaryTypes: ["Remaster"], genres: ["trip hop", "electronic"], artistId: 7, copies: copies,
      pathsHidden: pathsHidden)
  }

  static func copy(_ id: Int, kind: SourceKind, playing: Bool = false, path: String? = "/music/a.flac") -> TrackCopyMetadata {
    TrackCopyMetadata(
      fileId: id, playing: playing, source: .init(id: id, name: kind == .folder ? "NAS" : "Lidarr", kind: kind), path: path, size: 41_234_567,
      format: AudioFormat(codec: "FLAC", container: "flac", bits: 24, sampleRate: 96_000, channels: 2, lossless: true))
  }

  @Test func listsTheSongsFieldsLeavingOutEmptyOnes() {
    let rows = MetadataFormat.song(Self.metadata(disc: 2))
    #expect(rows.map(\.label) == ["Title", "Artist", "Album", "Track", "Duration", "Album type", "Released", "Genres", "Recording"])
    #expect(rows[3].value == .text("2-1"))
    #expect(rows[4].value == .text("6:19"))
    #expect(rows[5].value == .text("Album · Remaster"))
    #expect(rows[6].value == .text("1998-04-20"))
    #expect(rows[7].value == .text("trip hop, electronic"))
  }

  @Test func describesFormatsAndSizesAsTheWebDoes() {
    #expect(MetadataFormat.describe(AudioFormat(codec: "FLAC", container: "flac", bits: 24, sampleRate: 96_000, channels: 2, lossless: true)) == "FLAC · 24-bit / 96 kHz · stereo · lossless")
    #expect(MetadataFormat.describe(AudioFormat(codec: "FLAC", container: "flac", bits: 16, sampleRate: 44_100, lossless: true)) == "FLAC · 16-bit / 44.1 kHz · lossless")
    #expect(MetadataFormat.describe(AudioFormat(codec: "MP3", container: "mp3", bitrate: 319.6, channels: 1, lossless: false)) == "MP3 · 320 kbps · mono · lossy")
    #expect(MetadataFormat.describe(AudioFormat(codec: "AAC", container: "m4a", channels: 6, lossless: false)) == "AAC · 6 ch · lossy")
    #expect(MetadataFormat.size(1_610_612_736) == "1.50 GB")
    #expect(MetadataFormat.size(41_234_567) == "39.3 MB")
    #expect(MetadataFormat.size(524_288) == "512 KB")
  }

  @Test func saysHowAFileWasIdentified() {
    #expect(MetadataFormat.match(state: "auto", score: 0.934) == "Matched on MusicBrainz automatically (93%)")
    #expect(MetadataFormat.match(state: "manual", score: 0.5) == "Matched on MusicBrainz by you")
    #expect(MetadataFormat.match(state: "review", score: 0.61) == "Waiting for your review (61%)")
    #expect(MetadataFormat.match(state: "something", score: nil) == "something")
  }

  @Test func linksOnlyRealMusicBrainzIds() {
    #expect(MetadataFormat.musicBrainzURL(id: Self.recording, kind: "recording")?.absoluteString == "https://musicbrainz.org/recording/\(Self.recording)")
    #expect(MetadataFormat.musicBrainzURL(id: "track:12", kind: "recording") == nil)
  }

  @Test func listsAFilesRowsAndTags() {
    var c = Self.copy(1, kind: .folder)
    c.match = .init(state: "auto", score: 0.9)
    c.addedAt = "2026-11-03T10:00:00.000Z"
    let rows = MetadataFormat.copy(c, locale: Locale(identifier: "en_US"), timeZone: TimeZone(identifier: "UTC")!)
    #expect(rows.map(\.label) == ["Path", "Format", "Size", "Added", "Identified"])
    #expect(rows[0].value == .path("/music/a.flac"))
    #expect(rows[3].value == .text("Nov 3, 2026 at 10:00\u{202F}AM"))  // a narrow space before AM
    let tags = MetadataFormat.tags(FileTags(title: "Angel", trackNumber: 1, trackTotal: 11, genres: [], recordingMbid: "x"))
    #expect(tags.map(\.label) == ["Title", "Track", "Recording"])
    #expect(tags[1].value == .text("1 of 11"))
  }

  @Test func measuresTheSound() {
    let rows = MetadataFormat.sound(TrackMetadata.Analysis(bpm: 79.6, loudness: 0.8, dynamics: 1.2, brightness: -0.1, busyness: 0.333, bass: 0.5))
    #expect(rows.map(\.value) == [.text("80 BPM"), .text("Not analysed yet"), .meter(80), .meter(100), .meter(0), .meter(33), .meter(50)])
  }

  @Test func matchesAgainAFolderFileFirst() {
    let lidarr = Self.copy(1, kind: .lidarr, playing: true)
    let folder = Self.copy(2, kind: .folder)
    #expect(MetadataFormat.primaryCopy([lidarr, folder])?.fileId == 2)
    #expect(MetadataFormat.primaryCopy([lidarr])?.fileId == 1)
    #expect(MetadataFormat.rematchLabel(lidarr: true, busy: false) == "Refresh in Lidarr")
    #expect(MetadataFormat.rematchLabel(lidarr: false, busy: true) == "Matching…")
    #expect(MetadataFormat.outcome(.review) == "MusicBrainz has a few possible albums: pick one in Settings → Sources → Review matches.")
  }
}
```

**Step 2: Run them to see them fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter MetadataFormatTests
```

Expected: the build fails with `cannot find 'MetadataFormat' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Metadata/MetadataFormat.swift`:

```swift
import Foundation
import PlayarrAPI

/// Show metadata's wording (components/TrackMetadataDialog.tsx): rows, formats, sizes, matches and outcomes.
public enum MetadataFormat {
  /// A label and its value; rows without a value are left out.
  public struct Row: Equatable, Sendable, Identifiable {
    public let label: String
    public let value: Value
    public var id: String { label }
  }

  public enum Value: Equatable, Sendable {
    case text(String)
    /// A MusicBrainz id: a link when it is one, else "… (not on MusicBrainz yet)".
    case musicBrainz(id: String, kind: String)
    /// A path to copy.
    case path(String)
    /// 0–100.
    case meter(Int)
  }

  public static func rows(_ pairs: [(String, Value?)]) -> [Row] {
    pairs.compactMap { label, value in
      guard let value else { return nil }
      if case .text(let text) = value, text.isEmpty { return nil }
      return Row(label: label, value: value)
    }
  }

  /// The song's own rows.
  public static func song(_ m: TrackMetadata) -> [Row] {
    let type = ([m.albumType] + m.secondaryTypes).filter { !$0.isEmpty }.joined(separator: " · ")
    return rows([
      ("Title", .text(m.title)),
      ("Artist", .text(m.artistName)),
      ("Album", .text(m.albumTitle)),
      ("Track", .text(track(disc: m.discNumber, number: m.trackNumber))),
      ("Duration", .text(TextFormat.clock(m.duration))),
      ("Explicit", m.explicit ? .text("Yes") : nil),
      ("Album type", .text(type)),
      ("Released", m.releaseDate.map { .text(String($0.prefix(10))) }),
      ("Genres", .text(m.genres.joined(separator: ", "))),
      ("Recording", .musicBrainz(id: m.recordingId, kind: "recording")),
      ("Release group", m.albumMbid.map { .musicBrainz(id: $0, kind: "release-group") }),
      ("Artist id", m.artistMbid.map { .musicBrainz(id: $0, kind: "artist") }),
    ])
  }

  /// One file's rows.
  public static func copy(_ c: TrackCopyMetadata, locale: Locale = .current, timeZone: TimeZone = .current) -> [Row] {
    rows([
      ("Path", c.path.map(Value.path)),
      ("Read from", c.readPath.map(Value.path)),
      ("Format", .text(describe(c.format))),
      ("Size", .text(size(c.size))),
      ("Added", c.addedAt.flatMap { added($0, locale: locale, timeZone: timeZone) }.map(Value.text)),
      ("Identified", c.match.map { .text(match(state: $0.state, score: $0.score)) }),
    ])
  }

  /// A file's own tags.
  public static func tags(_ t: FileTags) -> [Row] {
    rows([
      ("Title", t.title.map(Value.text)),
      ("Artist", t.artist.map(Value.text)),
      ("Album artist", t.albumArtist.map(Value.text)),
      ("Album", t.album.map(Value.text)),
      ("Track", t.trackNumber.map { number in .text(t.trackTotal.map { "\(number) of \($0)" } ?? "\(number)") }),
      ("Disc", t.discNumber.map { .text("\($0)") }),
      ("Year", t.year.map { .text("\($0)") }),
      ("Genres", .text(t.genres.joined(separator: ", "))),
      ("Recording", t.recordingMbid.map { .musicBrainz(id: $0, kind: "recording") }),
      ("Release group", t.releaseGroupMbid.map { .musicBrainz(id: $0, kind: "release-group") }),
      ("Release", t.releaseId.map(Value.text)),
      ("Artist id", t.artistMbid.map { .musicBrainz(id: $0, kind: "artist") }),
      ("Album artist id", t.albumArtistMbid.map { .musicBrainz(id: $0, kind: "artist") }),
    ])
  }

  /// What the song sounds like.
  public static func sound(_ a: TrackMetadata.Analysis) -> [Row] {
    let notYet = Value.text("Not analysed yet")
    return rows([
      ("Tempo", a.bpm.map { $0 > 0 ? .text("\(Int(TextFormat.jsRound($0))) BPM") : notYet } ?? notYet),
      ("Beat", a.pulse.map { .meter(meter($0)) } ?? notYet),
      ("Loudness", .meter(meter(a.loudness))),
      ("Dynamics", .meter(meter(a.dynamics))),
      ("Brightness", .meter(meter(a.brightness))),
      ("Busyness", .meter(meter(a.busyness))),
      ("Bass", .meter(meter(a.bass))),
    ])
  }

  /// "5", or "2-5" on a second disc.
  public static func track(disc: Int, number: Int) -> String { disc > 1 ? "\(disc)-\(number)" : "\(number)" }

  /// "FLAC · 24-bit / 96 kHz · stereo · lossless", "MP3 · 320 kbps · stereo · lossy".
  public static func describe(_ f: AudioFormat) -> String {
    var parts = [f.codec]
    let depth = [f.bits.map { "\($0)-bit" }, f.sampleRate.map { "\(number(Double($0) / 1000)) kHz" }].compactMap { $0 }
    if !depth.isEmpty { parts.append(depth.joined(separator: " / ")) }
    if let bitrate = f.bitrate, bitrate > 0 { parts.append("\(Int(TextFormat.jsRound(bitrate))) kbps") }
    if let channels = f.channels, channels > 0 { parts.append(channels == 1 ? "mono" : channels == 2 ? "stereo" : "\(channels) ch") }
    parts.append(f.lossless ? "lossless" : "lossy")
    return parts.joined(separator: " · ")
  }

  /// "1.50 GB", "42.3 MB", "512 KB".
  public static func size(_ bytes: Int) -> String {
    let b = Double(bytes)
    if b >= pow(1024, 3) { return String(format: "%.2f GB", b / pow(1024, 3)) }
    if b >= pow(1024, 2) { return String(format: "%.1f MB", b / pow(1024, 2)) }
    return "\(Int(TextFormat.jsRound(b / 1024))) KB"
  }

  /// How a folder file was identified, with the score for automatic and doubtful matches.
  public static func match(state: String, score: Double?) -> String {
    let text = switch state {
    case "auto": "Matched on MusicBrainz automatically"
    case "manual": "Matched on MusicBrainz by you"
    case "review": "Waiting for your review"
    case "unmatched": "Not found on MusicBrainz: uses its tags"
    case "ignored": "Left unmatched by you: uses its tags"
    default: state
    }
    guard let score, state == "auto" || state == "review" else { return text }
    return "\(text) (\(Int(TextFormat.jsRound(score * 100)))%)"
  }

  /// A MusicBrainz page, when `id` is a MusicBrainz id (not Playarr's own "local:"/"track:" ids).
  public static func musicBrainzURL(id: String, kind: String) -> URL? {
    guard id.wholeMatch(of: #/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/#) != nil else { return nil }
    return URL(string: "https://musicbrainz.org/\(kind)/\(id)")
  }

  /// 0–1 as a whole percentage, clamped.
  public static func meter(_ value: Double) -> Int { Int(TextFormat.jsRound(min(1, max(0, value)) * 100)) }

  /// The file "Match again" acts on for the whole song: a folder file (the one that plays, if it's one), else a
  /// Lidarr file (refreshed in Lidarr).
  public static func primaryCopy(_ copies: [TrackCopyMetadata]) -> TrackCopyMetadata? {
    let folder = copies.filter { $0.source.kind == .folder }
    return folder.first { $0.playing } ?? folder.first ?? copies.first { $0.playing } ?? copies.first
  }

  /// The button: "Match again on MusicBrainz", "Refresh in Lidarr", and while it works "Matching…", "Asking Lidarr…".
  public static func rematchLabel(lidarr: Bool, busy: Bool) -> String {
    switch (lidarr, busy) {
    case (true, true): "Asking Lidarr…"
    case (false, true): "Matching…"
    case (true, false): "Refresh in Lidarr"
    case (false, false): "Match again on MusicBrainz"
    }
  }

  /// What matching a folder file again did.
  public static func outcome(_ state: RematchResult.Folder.State) -> String {
    switch state {
    case .auto, .manual: "Matched on MusicBrainz. The metadata is up to date."
    case .review: "MusicBrainz has a few possible albums: pick one in Settings → Sources → Review matches."
    case .unmatched: "Not found on MusicBrainz: the song keeps the tags in its file."
    case .ignored: "Left with the tags in its file."
    case .unknown: "Done."
    }
  }

  public static let pathsHiddenNote = "File paths and where sources live are shown to admins only."
  public static let rematchHiddenNote = "Matching a song again on MusicBrainz is for admins."

  private static func number(_ value: Double) -> String {
    value == value.rounded() ? String(Int(value)) : String(value)
  }

  private static func added(_ iso: String, locale: Locale, timeZone: TimeZone) -> String? {
    guard let date = ServerDate.parse(iso) else { return nil }
    var style = Date.FormatStyle(date: .abbreviated, time: .shortened)
    style.locale = locale
    style.timeZone = timeZone
    return date.formatted(style)
  }
}
```

**Step 4: Run them to see them pass**

Same command. Expected: `Test run with 7 tests` … `passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Metadata/MetadataFormat.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/MetadataFormatTests.swift
git commit -F - <<'EOF'
iOS: Show metadata's rows, formats, sizes, matches and outcomes in the web's words

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 14: Show metadata's model: loading, and matching a file again

`useTrackMetadata` (always fresh) and `useRematchFile`: the main button acts on `primaryCopy`, the other files of a song with several get their own; Lidarr's message or the folder outcome under the button; a match that moves the file to another song follows it there with a toast; everything is invalidated (the web invalidates every query). Paths, and with them Match again, are for admins (phase 1: the server sets `pathsHidden` for members).

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Metadata/TrackMetadataModel.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/TrackMetadataModelTests.swift`

**Step 1: Write the failing tests**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/TrackMetadataModelTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct TrackMetadataModelTests {
  let log = EventLog()

  private func model(_ handler: @escaping FakeServer.Handler) -> TrackMetadataModel {
    TrackMetadataModel(trackId: 700, client: fakeClient(handler), toast: log.toast, invalidate: log.invalidate)
  }

  @Test func offersMatchingAgainOnlyToAdmins() async {
    let folder = MetadataFormatTests.copy(1, kind: .folder, playing: true)
    let hidden = model { _ in (200, jsonText(MetadataFormatTests.metadata(copies: [MetadataFormatTests.copy(1, kind: .folder, path: nil)], pathsHidden: true))) }
    await hidden.load()
    #expect(hidden.primary == nil)
    let admin = model { _ in (200, jsonText(MetadataFormatTests.metadata(copies: [folder, MetadataFormatTests.copy(2, kind: .lidarr)]))) }
    await admin.load()
    #expect(admin.primary?.fileId == 1)
    #expect(admin.offersRematch(for: admin.metadata!.copies[1]))
    #expect(!admin.offersRematch(for: admin.metadata!.copies[0]))
  }

  @Test func saysWhatLidarrSaid() async {
    let m = model { request in
      request.httpMethod == "POST"
        ? (200, #"{"kind":"lidarr","message":"Lidarr is refreshing Massive Attack from MusicBrainz"}"#)
        : (200, jsonText(MetadataFormatTests.metadata(copies: [MetadataFormatTests.copy(5, kind: .lidarr)])))
    }
    await m.load()
    await m.rematch(m.metadata!.copies[0])
    #expect(m.outcomes[5] == .init(text: "Lidarr is refreshing Massive Attack from MusicBrainz", isError: false))
    #expect(log.invalidated == CacheFamily.allCases)
  }

  @Test func followsAFileToItsNewSong() async {
    let asked = Recorder<String>()
    let m = model { request in
      asked.append("\(request.httpMethod ?? "") \(request.url?.path() ?? "")")
      if request.httpMethod == "POST" { return (200, #"{"kind":"folder","state":"auto","trackId":901}"#) }
      return (200, jsonText(MetadataFormatTests.metadata(copies: [MetadataFormatTests.copy(1, kind: .folder)])))
    }
    await m.load()
    await m.rematch(m.metadata!.copies[0])
    #expect(m.trackId == 901)
    #expect(log.toasts == ["Matched on MusicBrainz. The metadata is up to date."])
    #expect(asked.all == ["GET /api/tracks/700/metadata", "POST /api/files/1/rematch", "GET /api/tracks/901/metadata"])
  }

  @Test func showsTheServersErrorUnderTheButton() async {
    let m = model { request in
      request.httpMethod == "POST"
        ? (403, #"{"error":"Admins only"}"#)
        : (200, jsonText(MetadataFormatTests.metadata(copies: [MetadataFormatTests.copy(1, kind: .folder)])))
    }
    await m.load()
    await m.rematch(m.metadata!.copies[0])
    #expect(m.outcomes[1] == .init(text: "Admins only", isError: true))
    #expect(m.rematching == nil)
  }

  @Test func saysWhyTheMetadataCouldntLoad() async {
    let m = model { _ in (404, #"{"error":"Song not found"}"#) }
    await m.load()
    #expect(m.error == "Song not found")
  }
}
```

**Step 2: Run them to see them fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter TrackMetadataModelTests
```

Expected: the build fails with `cannot find 'TrackMetadataModel' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Metadata/TrackMetadataModel.swift`:

```swift
import Observation
import PlayarrAPI

/// Show metadata: everything Playarr knows about a song and where each file of it is; admins can match a file
/// again on MusicBrainz, or ask Lidarr to refresh it (TrackMetadataDialog.tsx, useTrackMetadata, useRematchFile).
@MainActor @Observable
public final class TrackMetadataModel {
  /// What a "Match again" said, under its button.
  public struct Outcome: Equatable, Sendable {
    public let text: String
    public let isError: Bool
  }

  /// The song shown; a match can move the file to another song, and the sheet follows it.
  public private(set) var trackId: Int
  public private(set) var metadata: TrackMetadata?
  public private(set) var error: String?
  /// The file being matched again.
  public private(set) var rematching: Int?
  public private(set) var outcomes: [Int: Outcome] = [:]

  @ObservationIgnored private let client: APIClient
  @ObservationIgnored private let toast: @MainActor (String, Bool) -> Void
  @ObservationIgnored private let invalidate: @MainActor ([CacheFamily]) -> Void

  public init(
    trackId: Int, client: APIClient, toast: @escaping @MainActor (String, Bool) -> Void, invalidate: @escaping @MainActor ([CacheFamily]) -> Void
  ) {
    self.trackId = trackId
    self.client = client
    self.toast = toast
    self.invalidate = invalidate
  }

  /// The file the main "Match again" acts on; none when paths are hidden (the account isn't an admin).
  public var primary: TrackCopyMetadata? {
    guard let metadata, !metadata.pathsHidden else { return nil }
    return MetadataFormat.primaryCopy(metadata.copies)
  }

  /// With several files, each other file can be matched again on its own (admins only: they see paths).
  public func offersRematch(for copy: TrackCopyMetadata) -> Bool {
    guard let metadata else { return false }
    return metadata.copies.count > 1 && copy.fileId != primary?.fileId && copy.path != nil
  }

  /// Always fresh: files and matches change.
  public func load() async {
    do {
      metadata = try await client.send(API.Library.trackMetadata(id: trackId))
      error = nil
    } catch is CancellationError {
    } catch {
      self.error = error.localizedDescription
    }
  }

  public func rematch(_ copy: TrackCopyMetadata) async {
    guard rematching == nil else { return }
    rematching = copy.fileId
    outcomes[copy.fileId] = nil
    defer { rematching = nil }
    do {
      let result = try await client.send(API.Library.rematchFile(fileId: copy.fileId))
      // Everything showing songs may change.
      invalidate(CacheFamily.allCases)
      switch result {
      case .lidarr(let lidarr):
        outcomes[copy.fileId] = Outcome(text: lidarr.message, isError: false)
      case .folder(let folder):
        let text = MetadataFormat.outcome(folder.state)
        // A match can give the song its real MusicBrainz id, and with it another place in the catalog: follow it
        // there (this sheet reloads, so the outcome goes to a toast).
        if let moved = folder.trackId, moved != trackId {
          toast(text, false)
          trackId = moved
          outcomes = [:]
          metadata = nil
          await load()
        } else {
          outcomes[copy.fileId] = Outcome(text: text, isError: false)
          await load()
        }
      case .unknown:
        outcomes[copy.fileId] = Outcome(text: "Done.", isError: false)
      }
    } catch {
      outcomes[copy.fileId] = Outcome(text: error.localizedDescription, isError: true)
    }
  }
}
```

**Step 4: Run them to see them pass**

Same command. Expected: `Test run with 5 tests` … `passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Metadata/TrackMetadataModel.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/TrackMetadataModelTests.swift
git commit -F - <<'EOF'
iOS: load a song's metadata and match its files again, following a file to its new song

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 15: The Show metadata sheet

The sheet "Song metadata": title and artist · album, Match again (or the admins-only note), Song, File/Files with each source, "Plays", path with a copy button, Tags in the file, and Sound with meters. Links open MusicBrainz in Safari.

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Metadata/Pasteboard.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Metadata/TrackMetadataSheet.swift`

**Step 1: Write it**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Metadata/Pasteboard.swift`:

```swift
#if canImport(UIKit)
  import UIKit
#else
  import AppKit
#endif

/// Copies text for pasting elsewhere (a file's path).
enum Pasteboard {
  @MainActor static func copy(_ text: String) {
    #if canImport(UIKit)
      UIPasteboard.general.string = text
    #else
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(text, forType: .string)
    #endif
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Metadata/TrackMetadataSheet.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// Track menu → Show metadata: the song's fields and ids, each file with its source (and path, for admins), the
/// file's tags, the sound analysis, and "Match again on MusicBrainz" or "Refresh in Lidarr" (admins).
public struct TrackMetadataSheet: View {
  @State private var model: TrackMetadataModel
  @Environment(\.dismiss) private var dismiss

  public init(model: TrackMetadataModel) {
    _model = State(initialValue: model)
  }

  public var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 28) {
          if let error = model.error, model.metadata == nil {
            Text("Couldn’t load this song’s metadata: \(error)").foregroundStyle(.red)
          } else if let m = model.metadata {
            content(m)
          } else {
            VStack(alignment: .leading, spacing: 12) {
              RoundedRectangle(cornerRadius: 4).fill(.quaternary).frame(height: 32)
              RoundedRectangle(cornerRadius: 8).fill(.quaternary).frame(height: 160)
              RoundedRectangle(cornerRadius: 8).fill(.quaternary).frame(height: 128)
            }
            .accessibilityLabel("Loading metadata")
          }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .navigationTitle("Song metadata")
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
    }
    .task(id: model.trackId) { await model.load() }
  }

  @ViewBuilder private func content(_ m: TrackMetadata) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(m.title).font(.title3)
      Text("\(m.artistName) · \(m.albumTitle)").font(.subheadline).foregroundStyle(.secondary)
      if let primary = model.primary { rematch(primary) }
      if m.pathsHidden { Text(MetadataFormat.rematchHiddenNote).font(.footnote).foregroundStyle(.secondary).padding(.top, 8) }
    }
    section("Song") { rows(MetadataFormat.song(m)) }
    section(m.copies.count == 1 ? "File" : "Files (\(m.copies.count))") {
      if m.pathsHidden { Text(MetadataFormat.pathsHiddenNote).font(.footnote).foregroundStyle(.secondary) }
      ForEach(m.copies, id: \.fileId) { copyCard($0) }
    }
    if let analysis = m.analysis {
      section("Sound") { rows(MetadataFormat.sound(analysis)) }
    }
  }

  private func copyCard(_ c: TrackCopyMetadata) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 6) {
        Text(c.source.name)
        if let location = c.source.location { Text("· \(location)").foregroundStyle(.secondary).font(.footnote) }
        Spacer()
        if c.playing {
          Label("Plays", systemImage: "play.fill")
            .font(.system(size: 10, design: .monospaced)).textCase(.uppercase)
            .padding(.horizontal, 8).padding(.vertical, 2)
            .background(.tint.opacity(0.15), in: Capsule()).foregroundStyle(.tint)
        }
      }
      rows(MetadataFormat.copy(c))
      if model.offersRematch(for: c) { rematch(c) }
      if let tags = c.tags {
        DisclosureGroup("Tags in the file") { rows(MetadataFormat.tags(tags)).padding(.top, 6) }
          .font(.system(size: 11, design: .monospaced)).textCase(.uppercase)
      }
    }
    .padding(12)
    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.separator))
  }

  private func rematch(_ c: TrackCopyMetadata) -> some View {
    let lidarr = c.source.kind == .lidarr
    let busy = model.rematching == c.fileId
    return VStack(alignment: .leading, spacing: 8) {
      Button { Task { await model.rematch(c) } } label: {
        HStack(spacing: 8) {
          if busy { ProgressView().controlSize(.mini) } else { Image(systemName: "arrow.clockwise") }
          Text(MetadataFormat.rematchLabel(lidarr: lidarr, busy: busy))
        }
        .font(.footnote)
        .padding(.horizontal, 14).frame(height: 32)
        .overlay(Capsule().strokeBorder(.separator))
      }
      .buttonStyle(.plain)
      .disabled(model.rematching != nil)
      if busy && !lidarr { SlowLookup(what: "this album") }
      if let outcome = model.outcomes[c.fileId] {
        Text(outcome.text).font(.footnote).foregroundStyle(outcome.isError ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
      }
    }
    .padding(.top, 8)
  }

  private func section<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(title).font(.system(size: 11, design: .monospaced)).textCase(.uppercase).tracking(2).foregroundStyle(.secondary)
        .accessibilityAddTraits(.isHeader)
      content()
    }
  }

  private func rows(_ rows: [MetadataFormat.Row]) -> some View {
    Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 16, verticalSpacing: 6) {
      ForEach(rows) { row in
        GridRow {
          Text(row.label).font(.system(size: 11, design: .monospaced)).textCase(.uppercase).foregroundStyle(.secondary)
          value(row.value).font(.footnote).frame(maxWidth: .infinity, alignment: .leading)
        }
      }
    }
  }

  @ViewBuilder private func value(_ value: MetadataFormat.Value) -> some View {
    switch value {
    case .text(let text):
      Text(text).textSelection(.enabled)
    case .musicBrainz(let id, let kind):
      if let url = MetadataFormat.musicBrainzURL(id: id, kind: kind) {
        Link(destination: url) { Label(id, systemImage: "arrow.up.right.square").labelStyle(TrailingIcon()) }
          .font(.system(size: 12, design: .monospaced))
      } else {
        Text("\(id) (not on MusicBrainz yet)").font(.system(size: 12, design: .monospaced)).foregroundStyle(.secondary)
      }
    case .path(let path):
      HStack(alignment: .top, spacing: 8) {
        Text(path).font(.system(size: 12, design: .monospaced)).foregroundStyle(.secondary).textSelection(.enabled)
        Button { Pasteboard.copy(path) } label: { Image(systemName: "doc.on.doc") }
          .buttonStyle(.borderless)
          .accessibilityLabel("Copy path")
      }
    case .meter(let percent):
      HStack(spacing: 8) {
        ProgressView(value: Double(percent), total: 100).frame(width: 128)
        Text("\(percent)").font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary)
      }
      .accessibilityElement(children: .ignore)
      .accessibilityValue("\(percent) percent")
    }
  }
}

/// A label with its icon after the text, as the web's external-link mark.
private struct TrailingIcon: LabelStyle {
  func makeBody(configuration: Configuration) -> some View {
    HStack(spacing: 4) { configuration.title; configuration.icon }
  }
}
```

**Step 2: Build for the Mac and the simulator**

Same two commands as Task 11. Expected: `Build complete!` twice.

**Step 3: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Metadata/Pasteboard.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Metadata/TrackMetadataSheet.swift
git commit -F - <<'EOF'
iOS: the Show metadata sheet: fields, files with their paths for admins, tags, sound, and Match again

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 16: Mix points: the grid, the energy strip's layout, and the editor

MixPointsDialog.tsx's math from a `MixMapEntry`: the grid (bars from the first downbeat, or seconds without a beat; a phrase is 4 bars, or 10 s), snapping a drag, stepping from between two lines onto the next, milliseconds kept tidy; EnergyStrip.tsx's `phrasesAndBars` and `heardHeight`; and the editor (points set by hand or detected, shown in order a line apart, bounds, moving back onto the detected point clears it, changed, Reset's "anything set", the touch hint of decision 6).

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/MixPoints/MixGrid.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/MixPoints/EnergyLayout.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/MixPoints/MixPointsEditor.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/MixPointsMathTests.swift`

**Step 1: Write the failing tests**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/MixPointsMathTests.swift`:

```swift
import PlayarrAPI
import Testing
@testable import PlayarrUI

/// A song at 120 BPM (a bar is 2 s) whose first downbeat is 0.5 s in: bar lines at 0.5, 2.5, 4.5, …
func mixMap(bpm: Double = 120, duration: Double = 200, introEnd: Double = 16.5, outroStart: Double = 176.5, soundEnd: Double = 199, energy: [Double?] = [0.2, 1, nil, 0.5], cues: CuePoints? = nil) -> MixMapEntry {
  MixMapEntry(
    version: mixMapVersion, duration: duration, bpm: bpm, firstBeat: 0.5, downbeatOffset: 0, gridStable: true, beatConfidence: 0.9,
    introEnd: introEnd, outroStart: outroStart, coldStart: false, coldEnd: false, soundEnd: soundEnd, phraseEnergy: energy, cues: cues)
}

@Suite struct MixGridTests {
  let grid = MixGrid(map: mixMap())

  @Test func snapsToBarsFromTheFirstDownbeat() {
    #expect(grid == MixGrid(origin: 0.5, step: 2, big: 4))
    #expect(grid.snap(17.4, min: 0, max: 100) == 16.5)
    #expect(grid.snap(17.6, min: 0, max: 100) == 18.5)
    #expect(grid.snap(0.1, min: 0, max: 100) == 0.5)
    #expect(grid.snap(150, min: 0, max: 100) == 98.5)
  }

  @Test func stepsABarOrAPhraseLandingOnTheNextLineFirst() {
    #expect(grid.step(from: 16.5, by: 1, min: 0, max: 100) == 18.5)
    #expect(grid.step(from: 16.5, by: -4, min: 0, max: 100) == 8.5)
    #expect(grid.step(from: 17.3, by: 1, min: 0, max: 100) == 18.5)
    #expect(grid.step(from: 17.3, by: -1, min: 0, max: 100) == 16.5)
    #expect(grid.step(from: 2.5, by: -4, min: 0, max: 100) == 0.5)
  }

  @Test func movesByWholeSecondsWithoutABeat() {
    let seconds = MixGrid(map: mixMap(bpm: 0))
    #expect(seconds == MixGrid(origin: 0, step: 1, big: 10))
    #expect(seconds.step(from: 12.4, by: 10, min: 0, max: 100) == 22)
  }

  @Test func keepsMillisecondsTidy() {
    let odd = MixGrid(origin: 0.5, step: 2, big: 4)
    #expect(odd.line(9, min: 0, max: 100, fallback: 0) == 18.5)
    #expect(MixGrid.tidy(18.499999999) == 18.5)
  }

  @Test func fallsBackWhenNoLineFits() {
    #expect(grid.line(3, min: 1, max: 2, fallback: 7) == 2)
  }
}

@Suite struct EnergyLayoutTests {
  @Test func placesPhrasesAndBarsAcrossTheSong() {
    let layout = EnergyLayout(map: mixMap(duration: 100))
    #expect(layout.phrases.map(\.at) == [0.5, 8.5, 24.5])  // the unmeasured phrase is left blank
    #expect(layout.phrases[0].left == 0.005)
    #expect(abs(layout.phrases[0].width - 0.08) < 1e-9)
    #expect(layout.bars.count == 50)
    #expect(layout.bars.prefix(5).map(\.phrase) == [true, false, false, false, true])
    #expect(EnergyLayout(map: mixMap(bpm: 0)).phrases.isEmpty)
    #expect(abs(EnergyLayout.height(0.5) - 0.6598) < 0.001)
  }
}

@Suite struct MixPointsEditorTests {
  @Test func startsOnTheDetectedPoints() {
    let editor = MixPointsEditor(map: mixMap())
    #expect(editor.shown == (16.5, 176.5))
    #expect(!editor.setByHand(.mixIn))
    #expect(!editor.changed)
    #expect(!editor.anySet)
    #expect(editor.hint == "120 BPM. The markers snap to bars: drag one, or step it a bar or a phrase with its buttons.")
  }

  @Test func showsSavedPointsInOrder() {
    let backwards = MixPointsEditor(map: mixMap(cues: CuePoints(mixIn: 190, mixOut: 30.5)))
    #expect(backwards.shown == (28.5, 30.5))
    #expect(backwards.anySet)
  }

  @Test func dragsToTheNearestBarWithinBounds() {
    var editor = MixPointsEditor(map: mixMap())
    editor.drag(.mixIn, to: 33.2)
    #expect(editor.points.mixIn == 32.5)
    #expect(editor.changed)
    editor.drag(.mixIn, to: 500)
    #expect(editor.points.mixIn == 174.5)  // a bar before mix out
    editor.drag(.mixOut, to: 0)
    #expect(editor.time(.mixOut) == 176.5)  // a bar after mix in: the detected point, so nothing set by hand
    #expect(editor.points.mixOut == nil)
  }

  @Test func stepsABarOrAPhrase() {
    var editor = MixPointsEditor(map: mixMap())
    editor.step(.mixOut, forward: true, phrase: false)
    #expect(editor.points.mixOut == 178.5)
    editor.step(.mixOut, forward: false, phrase: true)
    #expect(editor.points.mixOut == 170.5)
  }

  @Test func forgetsAPointMovedBackOntoTheDetectedOne() {
    var editor = MixPointsEditor(map: mixMap())
    editor.step(.mixIn, forward: true, phrase: false)
    editor.step(.mixIn, forward: false, phrase: false)
    #expect(editor.points.mixIn == nil)
    #expect(!editor.changed)
  }

  @Test func savesAndResets() {
    var editor = MixPointsEditor(map: mixMap(cues: CuePoints(mixIn: 20.5)))
    #expect(editor.setByHand(.mixIn))
    editor.clear()
    #expect(editor.changed)
    #expect(editor.anySet)
    editor.didSave(.init())
    #expect(!editor.anySet)
    #expect(!editor.changed)
  }
}
```

**Step 2: Run them to see them fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter 'MixGridTests|EnergyLayoutTests|MixPointsEditorTests'
```

Expected: the build fails with `cannot find 'MixGrid' in scope` (and `EnergyLayout`, `MixPointsEditor`).

**Step 3: Implement**

If phase 5 already ported `phrasesAndBars` for the transition sheet, keep this `EnergyLayout` anyway only if phase 5's takes a different map type; otherwise use phase 5's and drop `EnergyLayout.swift` and its test.

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/MixPoints/MixGrid.swift`:

```swift
import PlayarrAPI

/// The lines Edit mix points' markers snap to: every bar from the music's first downbeat, or every second when no
/// beat was found; `big` steps make a phrase (4 bars) or 10 seconds (MixPointsDialog.tsx gridOf, snap, stepFrom).
public struct MixGrid: Equatable, Sendable {
  public let origin: Double
  public let step: Double
  public let big: Int

  /// Without a beat, the outer buttons move this many seconds.
  public static let secondsWithoutBeat = 10
  /// Float slack when deciding whether a time sits on a line.
  static let epsilon = 1e-6

  public init(origin: Double, step: Double, big: Int) {
    self.origin = origin
    self.step = step
    self.big = big
  }

  public init(map: MixMapEntry) {
    if map.bpm > 0 {
      let beat = 60 / map.bpm
      self.init(origin: map.firstBeat + map.downbeatOffset * beat, step: 4 * beat, big: 4)
    } else {
      self.init(origin: 0, step: 1, big: Self.secondsWithoutBeat)
    }
  }

  /// Milliseconds are plenty, and keep 0.5 + 9 × 2 from becoming 18.499999.
  public static func tidy(_ t: Double) -> Double { TextFormat.jsRound(t * 1000) / 1000 }

  /// The web's clamp: `lo` wins over nothing, `hi` over everything.
  static func clamp(_ v: Double, _ lo: Double, _ hi: Double) -> Double { min(max(v, lo), hi) }

  /// Line `index`, or the nearest line within [min, max]; `fallback` (clamped) when no line is.
  public func line(_ index: Int, min lower: Double, max upper: Double, fallback: Double) -> Double {
    let lo = Int((((lower - origin) / step) - Self.epsilon).rounded(.up))
    let hi = Int((((upper - origin) / step) + Self.epsilon).rounded(.down))
    guard lo <= hi else { return Self.clamp(fallback, lower, upper) }
    return Self.tidy(origin + Double(Swift.min(Swift.max(index, lo), hi)) * step)
  }

  /// The line nearest `t`, within [min, max] (a drag).
  public func snap(_ t: Double, min lower: Double, max upper: Double) -> Double {
    line(Int(TextFormat.jsRound((t - origin) / step)), min: lower, max: upper, fallback: t)
  }

  /// `n` lines on from `t` (back for a negative `n`); from between two lines, the first step lands on the next one.
  public func step(from t: Double, by n: Int, min lower: Double, max upper: Double) -> Double {
    let at = (t - origin) / step
    let from = n > 0 ? Int((at + Self.epsilon).rounded(.down)) : Int((at - Self.epsilon).rounded(.up))
    return line(from + n, min: lower, max: upper, fallback: t)
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/MixPoints/EnergyLayout.swift`:

```swift
import Foundation
import PlayarrAPI

/// A song's energy per 16-beat phrase over its bar lines, placed 0–1 across a picture of the whole song
/// (components/EnergyStrip.tsx phrasesAndBars). Nothing without a beat.
public struct EnergyLayout: Equatable, Sendable {
  public struct Phrase: Equatable, Sendable {
    /// Seconds into the song.
    public let at: Double
    public let energy: Double
    public let left: Double
    public let width: Double
  }

  public struct Bar: Equatable, Sendable {
    public let left: Double
    /// Every fourth bar starts a phrase.
    public let phrase: Bool
  }

  public let phrases: [Phrase]
  public let bars: [Bar]

  public init(map: MixMapEntry) {
    let duration = map.duration
    guard map.bpm > 0, duration > 0 else {
      phrases = []
      bars = []
      return
    }
    let beat = 60 / map.bpm
    let firstBar = map.firstBeat + map.downbeatOffset * beat
    let place = { (t: Double) in min(max(t, 0), duration) / duration }
    phrases = map.phraseEnergy.enumerated().compactMap { k, energy in
      // Not measured (an older map of a long song): left blank.
      guard let energy else { return nil }
      let at = firstBar + Double(k) * 16 * beat
      let end = min(at + 16 * beat, duration)
      guard end > 0, at < duration else { return nil }
      return Phrase(at: at, energy: energy, left: place(at), width: place(end) - place(at))
    }
    var bars: [Bar] = []
    var n = max(0, Int((-firstBar / (4 * beat)).rounded(.up)))
    while case let at = firstBar + Double(n) * 4 * beat, at <= duration {
      if at >= 0 { bars.append(Bar(left: place(at), phrase: n % 4 == 0)) }
      n += 1
    }
    self.bars = bars
  }

  /// How tall to draw a phrase of this energy: as loud as it sounds (about the level to the power 0.6), not as its
  /// level reads.
  public static func height(_ energy: Double) -> Double { pow(max(0, energy), 0.6) }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/MixPoints/MixPointsEditor.swift`:

```swift
import PlayarrAPI

/// Edit mix points' state for one song (MixPointsDialog.tsx Editor): the points set by hand (nil: the detected one),
/// where each marker shows, how far it may go, and what changed since it was saved.
public struct MixPointsEditor: Equatable, Sendable {
  public enum Point: Sendable, CaseIterable { case mixIn, mixOut }

  public struct Points: Equatable, Sendable {
    public var mixIn: Double?
    public var mixOut: Double?

    public init(mixIn: Double? = nil, mixOut: Double? = nil) {
      self.mixIn = mixIn
      self.mixOut = mixOut
    }

    subscript(point: Point) -> Double? {
      get { point == .mixIn ? mixIn : mixOut }
      set { if point == .mixIn { mixIn = newValue } else { mixOut = newValue } }
    }
  }

  public let duration: Double
  public let grid: MixGrid
  public let bpm: Double
  /// What the planner falls back to without points set by hand: the detected intro end and outro start.
  public let detected: (mixIn: Double, mixOut: Double)
  public private(set) var saved: Points
  public private(set) var points: Points

  public init(map: MixMapEntry) {
    duration = map.duration
    grid = MixGrid(map: map)
    bpm = map.bpm
    let finite = { (value: Double, fallback: Double) in value.isFinite ? value : fallback }
    let soundEnd = MixGrid.clamp(finite(map.soundEnd, map.duration), 0, map.duration)
    detected = (MixGrid.clamp(finite(map.introEnd, 0), 0, map.duration), MixGrid.clamp(finite(map.outroStart, soundEnd), 0, map.duration))
    saved = Points(mixIn: map.cues?.mixIn, mixOut: map.cues?.mixOut)
    points = saved
  }

  public static func == (a: Self, b: Self) -> Bool {
    a.duration == b.duration && a.grid == b.grid && a.saved == b.saved && a.points == b.points
  }

  /// Where the markers show: in order, mix in at least one line before mix out (the server wants it strictly
  /// before), even when the detection (or an old point) has them the wrong way round.
  public var shown: (mixIn: Double, mixOut: Double) {
    let mixOut = MixGrid.clamp(points.mixOut ?? detected.mixOut, min(grid.step, duration), duration)
    return (MixGrid.clamp(points.mixIn ?? detected.mixIn, 0, max(0, mixOut - grid.step)), mixOut)
  }

  public func time(_ point: Point) -> Double { point == .mixIn ? shown.mixIn : shown.mixOut }

  /// How far a marker may go: mix in up to a line before mix out, mix out from a line after mix in.
  public func bounds(_ point: Point) -> (min: Double, max: Double) {
    let s = shown
    return point == .mixIn ? (0, s.mixOut - grid.step) : (s.mixIn + grid.step, duration)
  }

  public func setByHand(_ point: Point) -> Bool { points[point] != nil }

  /// Something differs from what's saved.
  public var changed: Bool { points != saved }
  /// Reset has something to undo.
  public var anySet: Bool { [points.mixIn, points.mixOut, saved.mixIn, saved.mixOut].contains { $0 != nil } }

  /// Moves a marker to `t`; back on the detected point is no point set by hand.
  public mutating func move(_ point: Point, to t: Double) {
    let target = point == .mixIn ? detected.mixIn : detected.mixOut
    points[point] = abs(t - target) < 0.001 ? nil : t
  }

  /// A drag to `t` seconds: the nearest line within the marker's bounds.
  public mutating func drag(_ point: Point, to t: Double) {
    let (lo, hi) = bounds(point)
    let to = grid.snap(t, min: lo, max: hi)
    if to != time(point) { move(point, to: to) }
  }

  /// A bar (`phrase` false) or a phrase on (`forward`) or back: the marker's step buttons.
  public mutating func step(_ point: Point, forward: Bool, phrase: Bool) {
    let (lo, hi) = bounds(point)
    let n = (phrase ? grid.big : 1) * (forward ? 1 : -1)
    move(point, to: grid.step(from: time(point), by: n, min: lo, max: hi))
  }

  /// Back to the detected points (not saved yet).
  public mutating func clear() { points = Points() }

  /// The server has these now.
  public mutating func didSave(_ sent: Points) {
    saved = sent
    points = sent
  }

  /// "120 BPM. The markers snap to bars: …", or why they move by seconds.
  public var hint: String {
    bpm > 0
      ? "\(Int(TextFormat.jsRound(bpm))) BPM. The markers snap to bars: drag one, or step it a bar or a phrase with its buttons."
      : "No steady beat was found in this song, so the markers move by whole seconds (the outer buttons, \(MixGrid.secondsWithoutBeat))."
  }
}
```

**Step 4: Run them to see them pass**

Same command. Expected: `Test run with 12 tests` … `passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/MixPoints/MixGrid.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/MixPoints/EnergyLayout.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/MixPoints/MixPointsEditor.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/MixPointsMathTests.swift
git commit -F - <<'EOF'
iOS: mix points snap to bars and step by bars or phrases, from the song's mix map

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 17: Previews in the player, leaving the queue alone

Decision 1, in `PlayarrPlayer`: `Player.preview(_:from:length:)`, `endPreviews()` and `preview` (observable). `PreviewSession` holds the second engine and whether the queue goes on afterwards. Every command of the listener ends a preview without resuming (it goes through `change(_:)`, `play(...)` or `seek(to:)`); the 10 Hz tick moves the preview on and stops it after its seconds.

**Files:**
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Preview.swift`, `PreviewSession.swift`
- Modify: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Player.swift`
- Test: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/PlayerPreviewTests.swift`

**Step 1: Write the failing tests**

`apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/PlayerPreviewTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrPlayer

@MainActor
@Suite(.serialized)
struct PlayerPreviewTests {
  /// Plays the preview's engine for `seconds`, ticking the Player as the app's clock would.
  private func listen(_ player: Player, for seconds: Double) async throws {
    let audition = try #require(player.previews?.engine)
    for _ in 0..<Int((seconds * 10).rounded()) {
      _ = try await audition.render(seconds: 0.1)
      player.tick()
    }
  }

  @Test func aPreviewPausesTheQueueWhereItIsAndLeavesItAlone() async throws {
    let player = try Player.testing()
    player.play([song(1), song(2), song(3)], startAt: 1)
    try await player.play(for: 1)
    let (queue, order, pos, at) = (player.queue.queue, player.queue.order, player.queue.pos, player.time)
    player.preview(song(9), from: 30)
    #expect(player.preview == Preview(recordingId: "rec-9", from: 30))
    #expect(!player.queue.playing)
    #expect(player.engine.state == .paused)
    #expect(player.queue.queue == queue && player.queue.order == order && player.queue.pos == pos)
    #expect(abs(player.time - at) < 0.15)
  }

  @Test func aPreviewStopsAfterEightSecondsAndTheQueueWaitsForTheEnd() async throws {
    let player = try Player.testing()
    player.play([song(1)])
    try await player.play(for: 0.5)
    player.preview(song(9), from: 30)
    try await listen(player, for: 7)
    #expect(player.preview != nil)
    try await listen(player, for: 1.5)
    #expect(player.preview == nil)
    #expect(player.previews?.engine == nil)
    #expect(!player.queue.playing)
    player.endPreviews()
    #expect(player.queue.playing)
    #expect(player.previews == nil)
  }

  @Test func anotherPreviewTakesOverAndTheQueueStillGoesOnAfter() throws {
    let player = try Player.testing()
    player.play([song(1)])
    player.preview(song(9), from: 10)
    player.preview(song(9), from: 50)
    #expect(player.preview?.from == 50)
    player.endPreviews()
    #expect(player.queue.playing)
  }

  @Test func aPausedQueueStaysPaused() throws {
    let player = try Player.testing()
    player.play([song(1)])
    player.setPlaying(false)
    player.preview(song(9), from: 10)
    player.endPreviews()
    #expect(!player.queue.playing)
  }

  @Test func theListenerTakingOverEndsThePreview() throws {
    let player = try Player.testing()
    player.play([song(1), song(2)])
    player.preview(song(9), from: 10)
    player.setPlaying(true)  // play, on the mini player or the lock screen
    #expect(player.preview == nil)
    #expect(player.previews == nil)
    #expect(player.queue.playing)
    player.preview(song(9), from: 10)
    player.next()  // Next plays the next song, as on the web
    #expect(player.previews == nil)
    #expect(player.queue.pos == 1)
    #expect(player.queue.playing)
  }

  @Test func closingAfterTheListenerPausedLeavesTheQueuePaused() throws {
    let player = try Player.testing()
    player.play([song(1)])
    player.preview(song(9), from: 10)
    player.setPlaying(false)  // pause, on the lock screen
    player.endPreviews()
    #expect(!player.queue.playing)
  }

  @Test func aPreviewIsNeverReportedAsAPlay() async throws {
    let backend = FakeBackend()
    let player = try Player.testing(backend)
    player.preview(song(9, duration: 20), from: 0)
    try await listen(player, for: 8.5)
    player.endPreviews()
    try await Task.sleep(for: .milliseconds(50))
    #expect(backend.plays.withLock { $0.isEmpty })
    #expect(player.queue.pos == -1)
  }
}
```

**Step 2: Run them to see them fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter PlayerPreviewTests
```

Expected: the build fails with `cannot find 'Preview' in scope` and `value of type 'Player' has no member 'preview'`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Preview.swift`:

```swift
/// A preview playing (Edit mix points → Play from): which song, from where.
public struct Preview: Equatable, Sendable {
  public let recordingId: String
  /// Seconds into the song.
  public let from: Double
}
```

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PreviewSession.swift`:

```swift
/// The previews of one edit: whether the queue was playing before the first (it goes on after the last), and the
/// engine playing one now, until `until` seconds into its song.
@MainActor
struct PreviewSession {
  var resume: Bool
  var engine: AudioEngine?
  var until: Double = 0

  init(resume: Bool) {
    self.resume = resume
  }
}
```

Make these replacements in `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Player.swift` (each `old` appears once):

1. The preview's state, after the clock's task:

   Replace:

```swift
  @ObservationIgnored private var ticker: Task<Void, Never>?
```

   with:

```swift
  @ObservationIgnored private var ticker: Task<Void, Never>?
  /// Edit mix points' "Play from": the song previewing now, if any.
  public private(set) var preview: Preview?
  /// The previews of one edit, on their own engine, while the queue waits paused.
  @ObservationIgnored private(set) var previews: PreviewSession?
```

2. A new queue ends a preview, in `play(_:startAt:source:shuffle:at:)`:

   Replace:

```swift
  public func play(_ tracks: [Track], startAt index: Int = 0, source: PlaySource? = nil, shuffle: Bool = false, at seconds: Double? = nil) {
    queue.playTracks
```

   with:

```swift
  public func play(_ tracks: [Track], startAt index: Int = 0, source: PlaySource? = nil, shuffle: Bool = false, at seconds: Double? = nil) {
    endPreviews(resume: false)
    queue.playTracks
```

3. So does a seek, in `seek(to:)`:

   Replace:

```swift
  public func seek(to seconds: Double) {
    guard loaded != nil else { return }
```

   with:

```swift
  public func seek(to seconds: Double) {
    endPreviews(resume: false)
    guard loaded != nil else { return }
```

4. The 10 Hz tick moves a preview on, in `tick(now:)`:

   Replace:

```swift
    engine.pump()
```

   with:

```swift
    engine.pump()
    tickPreview()
```

5. Every other command of the listener ends one too, in `change(_:)`:

   Replace:

```swift
  private func change(_ edit: (inout QueueState) -> Void) {
    edit(&queue)
```

   with:

```swift
  private func change(_ edit: (inout QueueState) -> Void) {
    // The listener took over: a preview stops, and the queue does what they asked.
    endPreviews(resume: false)
    edit(&queue)
```

6. Append at the end of the file (an extension in the same file can use the Player's private members):

```swift
// MARK: Previews (Edit mix points → Play from)

extension Player {
  /// How long a preview plays.
  public static let previewSeconds: Double = 8

  /// Plays `track` from `seconds` for `length` seconds on a second engine, with the queue paused where it is: its
  /// engine keeps every buffer it scheduled (a transition too), so it goes on from the same sample. More previews
  /// may follow; `endPreviews()` lets the queue go on if it was playing before the first. A preview is never
  /// reported as a play, and the queue, its order and "Playing from" stay as they were.
  public func preview(_ track: Track, from seconds: Double, length: Double = Player.previewSeconds) {
    var previewing = previews ?? PreviewSession(resume: queue.playing)
    previewing.engine?.stop()
    previewing.engine = nil
    if queue.playing {
      queue.playing = false
      sync()
    }
    do {
      let audition = try makeEngine()
      let item = EngineItem(track: track, gainDb: gainDb(track), startAt: max(0, seconds))
      audition.onEvent = { [weak self] event in self?.previewEvent(event) }
      try? session?.activate()
      audition.load(item, playing: true)
      previewing.engine = audition
      previewing.until = item.startAt + length
      previews = previewing
      preview = Preview(recordingId: track.recordingId, from: item.startAt)
    } catch {
      previews = previewing
      preview = nil
      notice = Notice(text: "Couldn’t play a preview: \(error.localizedDescription)", isError: true)
    }
  }

  /// The edit is over (Edit mix points closed): a preview still playing stops, and the queue goes on if it was
  /// playing before the first preview.
  public func endPreviews() { endPreviews(resume: true) }

  func endPreviews(resume: Bool) {
    guard let ended = previews else { return }
    ended.engine?.stop()
    previews = nil
    preview = nil
    if resume, ended.resume, queue.pos >= 0 {
      queue.playing = true
      sync()
    }
  }

  /// The 10 Hz tick moves the preview on, and stops it after its few seconds.
  func tickPreview() {
    guard let previewing = previews, let audition = previewing.engine else { return }
    audition.pump()
    if audition.position >= previewing.until { stopPreview() }
  }

  private func previewEvent(_ event: EngineEvent) {
    switch event {
    case .advanced:
      break
    case .ended:
      stopPreview()
    case .failed(_, let failure):
      notice = Notice(text: failure.message, isError: true)
      stopPreview()
    }
  }

  /// This preview is done; the queue waits for `endPreviews()`.
  private func stopPreview() {
    previews?.engine?.stop()
    previews?.engine = nil
    preview = nil
  }
}
```

**Step 4: Run them to see them pass, then the whole package**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter PlayerPreviewTests
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer
```

Expected: `Test run with 7 tests` … `passed`; then every suite of the package passes (phase 3's tests are unchanged by this).

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Preview.swift \
  apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PreviewSession.swift \
  apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Player.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/PlayerPreviewTests.swift
git commit -F - <<'EOF'
iOS: preview a song from a point on a second engine while the queue waits paused, never counted as a play

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 18: Edit mix points' model

Loading the song's map (none: "This song hasn’t been analysed yet…"), dragging and stepping through Task 16's editor, "Play from" through Task 17's previews, Reset (no request when nothing was saved), Save (`PUT /api/recordings/:id/cues` with both points, null clearing one; "Mix points saved"), and afterwards the mix maps refreshed: the `mix-maps` family invalidated and the player told (`cuesChanged`, phase 5's hook in Task 21). Closing ends the previews.

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/MixPoints/MixPreviewing.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/MixPoints/MixPointsModel.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/MixPointsModelTests.swift`

**Step 1: Write the failing tests**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/MixPointsModelTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor final class FakePreviewer: MixPreviewing {
  var previews: [(id: Int, from: Double, length: Double)] = []
  var ended = 0
  func preview(_ track: Track, from seconds: Double, length: Double) { previews.append((track.id, seconds, length)) }
  func endPreviews() { ended += 1 }
}

@MainActor @Suite struct MixPointsModelTests {
  let log = EventLog()
  let previewer = FakePreviewer()

  static let song = Track(
    id: 7, recordingId: "rec-7", fileId: 7, albumId: 1, artistId: 1, title: "Angel", artistName: "Massive Attack", albumTitle: "Mezzanine",
    trackNumber: 1, discNumber: 1, duration: 200, explicit: false, format: AudioFormat(codec: "FLAC", container: "flac", lossless: true),
    size: 1, streamUrl: "/stream/7")

  private func model(cues: CuePoints? = nil, sent: Recorder<String>? = nil, status: Int = 200, onChange: @escaping @MainActor (String) -> Void = { _ in }) -> MixPointsModel {
    let maps = jsonText(["rec-7": mixMap(cues: cues)])
    let client = fakeClient { request in
      guard request.httpMethod == "PUT" else { return (200, maps) }
      sent?.append(request.bodyText)
      return status == 200 ? (200, "{}") : (status, #"{"error":"Song not found in the library"}"#)
    }
    return MixPointsModel(track: Self.song, client: client, player: previewer, toast: log.toast, invalidate: log.invalidate, cuesChanged: onChange)
  }

  @Test func saysWhenASongHasntBeenAnalysed() async {
    let m = MixPointsModel(track: Self.song, client: fakeClient { _ in (200, "{}") }, player: previewer, toast: log.toast, invalidate: log.invalidate, cuesChanged: { _ in })
    await m.load()
    #expect(m.loaded)
    #expect(m.editor == nil)
  }

  @Test func previewsEightSecondsFromAMarkerThenEndsOnClose() async {
    let m = model()
    await m.load()
    m.play(from: .mixOut)
    #expect(previewer.previews.map(\.from) == [176.5])
    #expect(previewer.previews.map(\.length) == [8])
    m.close()
    #expect(previewer.ended == 1)
  }

  @Test func savesBothPointsAndRefreshesTheMixMaps() async {
    let sent = Recorder<String>()
    var changed: [String] = []
    let m = model(sent: sent) { changed.append($0) }
    await m.load()
    m.drag(.mixIn, to: 33)
    #expect(await m.save())
    let body = try? JSONSerialization.jsonObject(with: Data(sent.all[0].utf8)) as? [String: Any]
    #expect(body?["mixIn"] as? Double == 32.5)
    #expect(body?["mixOut"] is NSNull)
    #expect(log.toasts == ["Mix points saved"])
    #expect(log.invalidated == [.mixMaps])
    #expect(changed == ["rec-7"])
    #expect(m.editor?.changed == false)
  }

  @Test func resetsWithoutTheServerWhenNothingWasSaved() async {
    let sent = Recorder<String>()
    let m = model(sent: sent)
    await m.load()
    m.step(.mixIn, forward: true, phrase: true)
    await m.reset()
    #expect(sent.all.isEmpty)
    #expect(m.editor?.points == .init())
  }

  @Test func resetsSavedPointsOnTheServer() async {
    let sent = Recorder<String>()
    let m = model(cues: CuePoints(mixIn: 20.5), sent: sent)
    await m.load()
    await m.reset()
    #expect(sent.all.count == 1)
    #expect(m.editor?.anySet == false)
    #expect(log.toasts.isEmpty)
  }

  @Test func saysWhySavingFailed() async {
    let m = model(status: 404)
    await m.load()
    m.drag(.mixOut, to: 150)
    #expect(await m.save() == false)
    #expect(m.saveError == "Couldn’t save the mix points: Song not found in the library")
  }
}
```

**Step 2: Run them to see them fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter MixPointsModelTests
```

Expected: the build fails with `cannot find type 'MixPreviewing' in scope` (and `MixPointsModel`).

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/MixPoints/MixPreviewing.swift`:

```swift
import PlayarrAPI
import PlayarrPlayer

/// What Edit mix points needs of the player: a few seconds of a song from a point, and the end of the edit.
@MainActor public protocol MixPreviewing: AnyObject {
  func preview(_ track: Track, from seconds: Double, length: Double)
  func endPreviews()
}

extension Player: MixPreviewing {}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/MixPoints/MixPointsModel.swift`:

```swift
import Observation
import PlayarrAPI
import PlayarrPlayer

/// Song menu → Edit mix points (MixPointsDialog.tsx): the song's energy over its bars with a mix-in and a mix-out
/// marker to move where the detection got them wrong, 8-second previews from each, Reset and Save (per recording, on
/// the server). Only offered with DJ mix on, the one setting that uses them.
@MainActor @Observable
public final class MixPointsModel {
  public let track: Track
  public private(set) var editor: MixPointsEditor?
  /// The strip's phrases and bars.
  public private(set) var layout: EnergyLayout?
  /// The server answered (a song not analysed yet has no map).
  public private(set) var loaded = false
  public private(set) var error: String?
  public private(set) var saving = false
  public private(set) var saveError: String?

  @ObservationIgnored private let client: APIClient
  @ObservationIgnored private weak var player: (any MixPreviewing)?
  @ObservationIgnored private let toast: @MainActor (String, Bool) -> Void
  @ObservationIgnored private let invalidate: @MainActor ([CacheFamily]) -> Void
  @ObservationIgnored private let cuesChanged: @MainActor (String) -> Void

  /// `cuesChanged`: the player forgets the song's map and asks again for a coming transition made with the old points.
  public init(
    track: Track, client: APIClient, player: (any MixPreviewing)?, toast: @escaping @MainActor (String, Bool) -> Void,
    invalidate: @escaping @MainActor ([CacheFamily]) -> Void, cuesChanged: @escaping @MainActor (String) -> Void
  ) {
    self.track = track
    self.client = client
    self.player = player
    self.toast = toast
    self.invalidate = invalidate
    self.cuesChanged = cuesChanged
  }

  public static let notAnalysed =
    "This song hasn’t been analysed yet, so there are no mix points to move. Playarr measures songs in the background: try again later."

  public func load() async {
    do {
      let maps = try await client.send(API.Playback.mixMaps(ids: [track.recordingId]))
      let map = maps[track.recordingId]
      editor = map.map(MixPointsEditor.init(map:))
      layout = map.map(EnergyLayout.init(map:))
      loaded = true
      error = nil
    } catch is CancellationError {
    } catch {
      self.error = error.localizedDescription
    }
  }

  public func drag(_ point: MixPointsEditor.Point, to seconds: Double) { editor?.drag(point, to: seconds) }

  public func step(_ point: MixPointsEditor.Point, forward: Bool, phrase: Bool) { editor?.step(point, forward: forward, phrase: phrase) }

  /// "Play from mix in": 8 seconds from the marker, through the player, the queue left as it is.
  public func play(from point: MixPointsEditor.Point) {
    guard let editor else { return }
    player?.preview(track, from: editor.time(point), length: Player.previewSeconds)
  }

  /// Back to the detected points; saved at once if any were saved (nothing to tell the server otherwise).
  public func reset() async {
    guard var editor else { return }
    guard editor.saved != MixPointsEditor.Points() else {
      editor.clear()
      self.editor = editor
      return
    }
    _ = await send(MixPointsEditor.Points())
  }

  /// Saves the points; true when saved ("Mix points saved", and the sheet closes).
  public func save() async -> Bool {
    guard let editor, editor.changed else { return false }
    guard await send(editor.points) else { return false }
    toast("Mix points saved", false)
    return true
  }

  /// The sheet closed: a preview still playing stops, and the queue goes on if it was playing.
  public func close() { player?.endPreviews() }

  private func send(_ points: MixPointsEditor.Points) async -> Bool {
    saving = true
    saveError = nil
    defer { saving = false }
    do {
      _ = try await client.send(API.Playback.setCues(recordingId: track.recordingId, mixIn: points.mixIn, mixOut: points.mixOut))
      editor?.didSave(points)
      // The server forgot the transitions made with the old points: a coming one is asked for afresh, and the
      // transition view and the planner's inputs both come from the mix maps.
      cuesChanged(track.recordingId)
      invalidate([.mixMaps])
      return true
    } catch {
      saveError = "Couldn’t save the mix points: \(error.localizedDescription)"
      return false
    }
  }
}
```

**Step 4: Run them to see them pass**

Same command. Expected: `Test run with 6 tests` … `passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/MixPoints/MixPreviewing.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/MixPoints/MixPointsModel.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/MixPointsModelTests.swift
git commit -F - <<'EOF'
iOS: Edit mix points' model: previews from each marker, Reset, Save, and the mix maps refreshed

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 19: The Edit mix points sheet

The strip drawn with `Canvas` (phrase columns as tall as they sound, the shaded overlaps, the dashed detected points, bar ticks with phrase starts stronger), the In and Out markers dragged with snapping and adjustable with VoiceOver, a card per point with its time, "Set by hand" or "Detected", the step buttons and "Play from mix in/out", the save error, Reset, and Cancel/Save in the toolbar (decision 6).

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/MixPoints/MixPointsStrip.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/MixPoints/MixPointsSheet.swift`

**Step 1: Write it**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/MixPoints/MixPointsStrip.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// The whole song's energy per phrase with its bars underneath, the stretches either end where it overlaps its
/// neighbours shaded, the detected points as dashed lines, and the two markers to drag: In above the strip, Out below,
/// so they never collide. A drag snaps to bars; VoiceOver's swipe up and down moves a marker a bar.
struct MixPointsStrip: View {
  let editor: MixPointsEditor
  let layout: EnergyLayout
  let onDrag: (MixPointsEditor.Point, Double) -> Void
  let onStep: (MixPointsEditor.Point, Bool) -> Void

  private let handleRow: CGFloat = 44
  private let stripHeight: CGFloat = 64

  var body: some View {
    GeometryReader { box in
      let width = box.size.width
      let x = { (t: Double) in CGFloat(min(max(t, 0), editor.duration) / max(editor.duration, 1)) * width }
      ZStack(alignment: .topLeading) {
        Canvas { context, size in
          let top = handleRow
          let shown = editor.shown
          let shade = Color.primary.opacity(0.08)
          context.fill(Path(CGRect(x: 0, y: top, width: x(shown.mixIn), height: stripHeight)), with: .color(shade))
          context.fill(Path(CGRect(x: x(shown.mixOut), y: top, width: size.width - x(shown.mixOut), height: stripHeight)), with: .color(shade))
          for phrase in layout.phrases {
            let h = max(2, CGFloat(EnergyLayout.height(phrase.energy)) * stripHeight)
            let rect = CGRect(x: phrase.left * size.width, y: top + stripHeight - h, width: max(1, phrase.width * size.width - 2), height: h)
            context.fill(Path(roundedRect: rect, cornerRadius: 3), with: .color(.accentColor))
          }
          for t in [editor.detected.mixIn, editor.detected.mixOut] {
            var line = Path()
            line.move(to: CGPoint(x: x(t), y: top))
            line.addLine(to: CGPoint(x: x(t), y: top + stripHeight))
            context.stroke(line, with: .color(.primary.opacity(0.45)), style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
          }
          for bar in layout.bars {
            let tick = CGRect(x: bar.left * size.width, y: top + stripHeight + 2, width: 1, height: bar.phrase ? 6 : 4)
            context.fill(Path(tick), with: .color(.primary.opacity(bar.phrase ? 0.4 : 0.15)))
          }
        }
        .accessibilityHidden(true)
        marker(.mixIn, label: "Mix in", handle: "In", x: x(editor.shown.mixIn), width: width)
        marker(.mixOut, label: "Mix out", handle: "Out", x: x(editor.shown.mixOut), width: width)
      }
    }
    .coordinateSpace(.named("strip"))
    .frame(height: handleRow * 2 + stripHeight + 8)
  }

  private func marker(_ point: MixPointsEditor.Point, label: String, handle: String, x: CGFloat, width: CGFloat) -> some View {
    let top = point == .mixIn
    return VStack(spacing: 0) {
      if top { handleView(handle) }
      Rectangle().fill(.primary).frame(width: 2, height: stripHeight + 8)
      if !top { handleView(handle) }
    }
    .frame(width: 44)
    .contentShape(Rectangle())
    .position(x: x, y: handleRow + (stripHeight + 8) / 2 + (top ? -handleRow / 2 : handleRow / 2))
    .gesture(
      DragGesture(minimumDistance: 0, coordinateSpace: .named("strip"))
        .onChanged { drag in onDrag(point, Double(drag.location.x / max(width, 1)) * editor.duration) }
    )
    .accessibilityElement()
    .accessibilityLabel(label)
    .accessibilityValue(TextFormat.clock(editor.time(point)))
    .accessibilityAdjustableAction { direction in
      switch direction {
      case .increment: onStep(point, true)
      case .decrement: onStep(point, false)
      @unknown default: break
      }
    }
  }

  private func handleView(_ text: String) -> some View {
    Text(text)
      .font(.system(size: 10, weight: .medium, design: .monospaced)).textCase(.uppercase)
      .padding(.horizontal, 8).frame(minWidth: 40, minHeight: 24)
      .background(Capsule().fill(.primary))
      .foregroundStyle(.background)
      .frame(height: handleRow)
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/MixPoints/MixPointsSheet.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// Edit mix points, as a sheet: the strip with its two markers, a card for each point (its time, set by hand or
/// detected, step buttons for a bar or a phrase, and "Play from"), Reset and Save.
public struct MixPointsSheet: View {
  @State private var model: MixPointsModel
  @Environment(\.dismiss) private var dismiss

  public init(model: MixPointsModel) {
    _model = State(initialValue: model)
  }

  public var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 24) {
          VStack(alignment: .leading, spacing: 2) {
            Text(model.track.title).font(.title3).lineLimit(1)
            Text(model.track.artistName).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
          }
          if let error = model.error {
            Text("Couldn’t load this song’s mix points: \(error)").foregroundStyle(.red)
          } else if let editor = model.editor, let layout = model.layout {
            editorView(editor, layout)
          } else if model.loaded {
            Text(MixPointsModel.notAnalysed).font(.subheadline).foregroundStyle(.secondary)
          } else {
            RoundedRectangle(cornerRadius: 8).fill(.quaternary).frame(height: 96).accessibilityLabel("Loading mix points")
          }
        }
        .padding(20)
      }
      .navigationTitle("Edit mix points")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button("Save") { Task { if await model.save() { dismiss() } } }
            .disabled(model.editor?.changed != true || model.saving)
        }
      }
    }
    .task { await model.load() }
    .onDisappear { model.close() }
  }

  @ViewBuilder private func editorView(_ editor: MixPointsEditor, _ layout: EnergyLayout) -> some View {
    Text(editor.hint).font(.subheadline).foregroundStyle(.secondary)
    VStack(alignment: .leading, spacing: 8) {
      Text("Energy through the song").font(.system(size: 11, design: .monospaced)).textCase(.uppercase).tracking(2).foregroundStyle(.secondary)
      MixPointsStrip(
        editor: editor, layout: layout,
        onDrag: { model.drag($0, to: $1) },
        onStep: { model.step($0, forward: $1, phrase: false) })
      HStack {
        Text("0:00")
        Spacer()
        Text(TextFormat.clock(editor.duration))
      }
      .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
      Text("The shaded ends are where this song can overlap the songs before and after it; the dashed lines are the points Playarr found on its own.")
        .font(.caption).foregroundStyle(.secondary)
    }
    card(editor, .mixIn, label: "Mix in", hint: "Where the song is fully in")
    card(editor, .mixOut, label: "Mix out", hint: "Where the song starts to give way")
    if let error = model.saveError { Text(error).font(.footnote).foregroundStyle(.red) }
    Button("Reset") { Task { await model.reset() } }
      .disabled(!editor.anySet || model.saving)
  }

  private func card(_ editor: MixPointsEditor, _ point: MixPointsEditor.Point, label: String, hint: String) -> some View {
    let beat = editor.bpm > 0
    return VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(label).font(.system(size: 11, design: .monospaced)).textCase(.uppercase).tracking(1.5).foregroundStyle(.secondary)
        Text(editor.setByHand(point) ? "Set by hand" : "Detected").font(.caption2).foregroundStyle(.secondary)
      }
      Text(TextFormat.clock(editor.time(point))).font(.title2.monospacedDigit())
      Text(hint).font(.caption).foregroundStyle(.secondary)
      HStack(spacing: 8) {
        stepButton(point, forward: false, phrase: true, icon: "backward.end.alt", label: beat ? "Back a phrase" : "Back 10 seconds")
        stepButton(point, forward: false, phrase: false, icon: "chevron.backward", label: beat ? "Back a bar" : "Back a second")
        stepButton(point, forward: true, phrase: false, icon: "chevron.forward", label: beat ? "On a bar" : "On a second")
        stepButton(point, forward: true, phrase: true, icon: "forward.end.alt", label: beat ? "On a phrase" : "On 10 seconds")
        Spacer()
        Button { model.play(from: point) } label: {
          Label("Play from \(label.lowercased())", systemImage: "play.fill").font(.footnote)
            .padding(.horizontal, 12).frame(minHeight: 44)
            .overlay(Capsule().strokeBorder(.separator))
        }
        .buttonStyle(.plain)
      }
    }
    .padding(12)
    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.separator))
  }

  private func stepButton(_ point: MixPointsEditor.Point, forward: Bool, phrase: Bool, icon: String, label: String) -> some View {
    Button { model.step(point, forward: forward, phrase: phrase) } label: {
      Image(systemName: icon).frame(width: 36, height: 44)
    }
    .buttonStyle(.borderless)
    .accessibilityLabel(label)
  }
}
```

**Step 2: Build for the Mac and the simulator**

Same two commands as Task 11. Expected: `Build complete!` twice.

**Step 3: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/MixPoints/MixPointsStrip.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/MixPoints/MixPointsSheet.swift
git commit -F - <<'EOF'
iOS: the Edit mix points sheet: the energy strip with draggable In and Out markers, step buttons and Play from

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 20: Opening the sheets from any song menu

`TrackSheets` (the web's `useUI` `metadataTrackId` and `mixPointsTrack`) lives in the `DiscoverContext`; `trackSheets(player:)` presents both sheets once at the root; `TrackLibraryMenuItems` is "Show metadata" and, with DJ mix on, "Edit mix points" (`useMixPointsItem`), for phase 4's menus.

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Sheets/TrackSheets.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Sheets/TrackSheetsModifier.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Sheets/TrackLibraryMenuItems.swift`
- Modify: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverContext.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/TrackSheetsTests.swift`

**Step 1: Write the failing tests**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/TrackSheetsTests.swift`:

```swift
import Foundation
import PlayarrAPI
import PlayarrPlayer
import Testing
@testable import PlayarrUI

@MainActor @Suite struct TrackSheetsTests {
  @Test func offersEditMixPointsOnlyWithDJMixOn() {
    let settings = PlaybackSettings(defaults: UserDefaults(suiteName: UUID().uuidString)!)
    let sheets = TrackSheets()
    sheets.settings = settings
    let song = MixPointsModelTests.song
    #expect(!sheets.offersMixPoints(for: song))
    settings.transitions = .dj
    #expect(sheets.offersMixPoints(for: song))
    var local = song
    local.recordingId = ""
    #expect(!sheets.offersMixPoints(for: local))
  }

  @Test func opensOneSheetPerSong() {
    let sheets = TrackSheets()
    sheets.showMetadata(700)
    #expect(sheets.metadata?.id == 700)
    sheets.editMixPoints(MixPointsModelTests.song)
    #expect(sheets.mixPoints?.id == 7)
  }
}
```

**Step 2: Run them to see them fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter TrackSheetsTests
```

Expected: the build fails with `cannot find 'TrackSheets' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Sheets/TrackSheets.swift`:

```swift
import Observation
import PlayarrAPI
import PlayarrPlayer

/// Which song sheet is open: Show metadata or Edit mix points (the web's useUI metadataTrackId and mixPointsTrack).
/// Song menus anywhere open them; the app's root presents them once (`trackSheets(player:)`).
@MainActor @Observable
public final class TrackSheets {
  /// A song id, for `.sheet(item:)`.
  public struct MetadataTarget: Identifiable, Hashable, Sendable {
    public let id: Int
  }

  public var metadata: MetadataTarget?
  public var mixPoints: Track?
  /// Settings → Playback on this device: Edit mix points is offered only with DJ mix on.
  @ObservationIgnored public var settings: PlaybackSettings?
  /// The player forgets a song's mix map and asks again for a coming transition made with old points (phase 5).
  @ObservationIgnored public var cuesChanged: @MainActor (String) -> Void = { _ in }

  public init() {}

  public func showMetadata(_ trackId: Int) { metadata = MetadataTarget(id: trackId) }

  public func editMixPoints(_ track: Track) { mixPoints = track }

  /// "Edit mix points" belongs in this song's menu: DJ mix is on (the only setting that uses them) and the song has
  /// a recording id to save them under.
  public func offersMixPoints(for track: Track) -> Bool {
    settings?.transitions == .dj && !track.recordingId.isEmpty
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Sheets/TrackSheetsModifier.swift`:

```swift
import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// Presents the song sheets the menus open, once, at the app's root.
struct TrackSheetsModifier: ViewModifier {
  let player: Player?

  @Environment(DiscoverContext.self) private var context: DiscoverContext?

  func body(content: Content) -> some View {
    if let context {
      @Bindable var sheets = context.sheets
      content
        .sheet(item: $sheets.metadata) { target in
          TrackMetadataSheet(
            model: TrackMetadataModel(trackId: target.id, client: context.client, toast: context.toast, invalidate: { context.invalidate($0) })
          )
          .environment(context)
        }
        .sheet(item: $sheets.mixPoints) { track in
          MixPointsSheet(
            model: MixPointsModel(
              track: track, client: context.client, player: player, toast: context.toast,
              invalidate: { context.invalidate($0) }, cuesChanged: context.sheets.cuesChanged)
          )
          .environment(context)
        }
        // Edit mix points is offered with DJ mix on, a setting of this device's player.
        .task(id: player.map(ObjectIdentifier.init)) { context.sheets.settings = player?.settings }
    } else {
      content
    }
  }
}

extension View {
  /// Show metadata and Edit mix points, opened from any song menu (put once on the signed-in root).
  public func trackSheets(player: Player?) -> some View {
    modifier(TrackSheetsModifier(player: player))
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Sheets/TrackLibraryMenuItems.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// The song menu's "Show metadata" and (with DJ mix on) "Edit mix points", for phase 4's track menus and Now Playing.
public struct TrackLibraryMenuItems: View {
  let track: Track

  @Environment(DiscoverContext.self) private var context: DiscoverContext?

  public init(track: Track) {
    self.track = track
  }

  public var body: some View {
    if let sheets = context?.sheets {
      Button("Show metadata", systemImage: "info.circle") { sheets.showMetadata(track.id) }
      if sheets.offersMixPoints(for: track) {
        Button("Edit mix points", systemImage: "waveform") { sheets.editMixPoints(track) }
      }
    }
  }
}
```

In `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverContext.swift`, replace:

```swift
  public let musicBrainz: MusicBrainzStatusModel
```

with:

```swift
  public let musicBrainz: MusicBrainzStatusModel
  /// Show metadata and Edit mix points.
  public let sheets = TrackSheets()
```

**Step 4: Run them to see them pass, then the whole package**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter TrackSheetsTests
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI
```

Expected: `Test run with 2 tests` … `passed`; then every suite of the package passes.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Sheets/TrackSheets.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Sheets/TrackSheetsModifier.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Sheets/TrackLibraryMenuItems.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/TrackSheetsTests.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverContext.swift
git commit -F - <<'EOF'
iOS: open Show metadata and Edit mix points from any song menu, Edit mix points only with DJ mix on

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---
### Task 21: Put it in the app: the account's context, and phase 4 and 6's slots

`AppModel` gets this phase's state (decision 8): `discover`, made again when the active account changes, given the account's new rights when they change, refreshed when the app comes back on screen; `isActive` for the notifier. `discoverRoot(_:)` does that once at the signed-in root and presents the song sheets. Then each slot gets its part.

**Files:**
- Modify: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/AppModel.swift`
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/AppModel+Discover.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverRoot.swift`
- Modify (the files Task 0 found): phase 4's signed-in root view, each tab's `NavigationStack`, the Search page, the Artist page, the Album page, the track ⋯ menu, Now Playing's ⋯ menu, the Library page; phase 6's recommendation row

**Step 1: The app model's new state**

In `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/AppModel.swift` (4-space indentation, as phase 2 wrote it), replace:

```swift
    public var showingAccounts = false
```

with:

```swift
    public var showingAccounts = false
    /// Discover, requests and the song sheets for the signed-in account (phase 8).
    public internal(set) var discover: DiscoverContext?
    /// The app is on screen (a request that lands in the background is a notification instead).
    public var isActive = true
```

**Step 2: Making the context, and the root modifier**

Use the names Task 0 found for phase 4's pages, toasts, cache, player and Search, and phase 5's hook (`{ _ in }` if it has none).

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/AppModel+Discover.swift`:

```swift
import Foundation
import PlayarrAPI
import PlayarrPlayer
import SwiftUI

extension AppModel {
  /// Makes the signed-in account's Discover state, keeps it when the account is the same (taking its new rights),
  /// and drops it when no one is signed in. Called whenever the active account changes.
  public func refreshDiscover() {
    guard let record = store.activeAccount, record.signedIn, let client = store.activeClient else {
      discover?.stop()
      discover = nil
      return
    }
    if let current = discover, current.account.id == record.account.id, current.client.baseURL == client.baseURL {
      current.update(record.account)
      return
    }
    discover?.stop()
    let context = DiscoverContext(
      client: client, account: record.account,
      notifier: LocalRequestNotifier { [weak self] in self?.isActive ?? true },
      toast: { [weak self] text, isError in self?.toasts.show(text, isError: isError) },
      forward: { [weak self] families in
        for family in families { self?.cache?.invalidate(prefix: family.rawValue) }
      })
    context.libraryArtistPage = { AnyView(ArtistPage(id: $0)) }
    context.libraryAlbumPage = { AnyView(AlbumPage(id: $0)) }
    context.openSearch = { [weak self] in self?.openSearch($0) }
    context.sheets.cuesChanged = { [weak self] in self?.player?.mixPointsChanged(recordingId: $0) }
    context.start()
    discover = context
  }

  /// The app came on screen or left it.
  public func scenePhaseChanged(_ phase: ScenePhase) {
    isActive = phase == .active
    if phase == .active { discover?.becameActive() }
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverRoot.swift`:

```swift
import SwiftUI

/// What this phase adds to the signed-in root, once: the account's Discover state in the environment, made again
/// when the account changes, refreshed when the app comes back on screen, and the song sheets.
struct DiscoverRoot: ViewModifier {
  let app: AppModel

  @Environment(\.scenePhase) private var scenePhase

  func body(content: Content) -> some View {
    content
      .trackSheets(player: app.player)
      .environment(app.discover)
      .task(id: app.store.active) { app.refreshDiscover() }
      .onChange(of: app.store.activeAccount?.account) { app.refreshDiscover() }
      .onChange(of: scenePhase) { _, phase in app.scenePhaseChanged(phase) }
  }
}

extension View {
  /// Discover, requests and the song sheets for the signed-in account (put once on the signed-in root).
  public func discoverRoot(_ app: AppModel) -> some View {
    modifier(DiscoverRoot(app: app))
  }
}
```

**Step 3: The slots**

Each snippet below was type-checked in a stand-in of the view it goes into. Put each where the comment says, in phase 4's (or 6's) file:

1. **The signed-in root view** (the view phase 4 shows once an account is active, which holds the tabs): add `.discoverRoot(model)` to its outermost view, where `model` is the `AppModel` it was given.

2. **Each tab's navigation stack** (Home, Search, Library, Queue): add `.discoverDestinations()` to the stack's root view, next to phase 4's own `.navigationDestination(for:)`:

```swift
NavigationStack(path: $path) {
  HomePage()  // phase 4's root view of the tab
    .discoverDestinations()
}
```

3. **The Search page** (Search.tsx): the pill under the search field, and the section after the library results. The empty text gains the web's tail when there's Lidarr: `"Nothing in your library matches “\(query)”." + (discover?.gate.hasLidarr == true ? " Here’s what’s out there:" : "")`, with `@Environment(DiscoverContext.self) private var discover: DiscoverContext?` in the page.

```swift
// under the search field
RequestsPill()
// … phase 4's library results …
// after them, at the end of the page's VStack
DiscoverSection(query: query.trimmingCharacters(in: .whitespaces))
```

4. **The Artist page** (Artist.tsx), after the album groups and before About; if phase 4 already shows similar artists, leave out the second line:

```swift
if let mbid = artist.mbid {
  NotInLibrarySection(artistMbid: mbid, owned: artist.albums)
  SimilarArtistsSection(mbid: mbid)
}
```

5. **The Album page** (Album.tsx), last in the row of Play, Shuffle, ⋯ and Download (it wraps on a phone):

```swift
RequestRestButton(album: Album(album))  // `album` is the page's AlbumDetail
```

6. **The track ⋯ menu** (TrackList.tsx 130-143) and **Now Playing's ⋯ menu** (NowPlaying.tsx 128-139): after "Go to artist":

```swift
TrackLibraryMenuItems(track: track)
```

7. **The Library page** (Library.tsx): the Requests row after Albums, only when there are requests, and the MusicBrainz queue at the foot (the desktop sidebar's footer, on the phone), with `@Environment(DiscoverContext.self) private var discover: DiscoverContext?` in the page:

```swift
if let count = discover?.requests.requests?.count, count > 0 {
  NavigationLink(value: DiscoverDestination.requests) {
    LabeledContent { Text("\(count)") } label: { Label("Requests", systemImage: "arrow.down.circle") }
  }
  .accessibilityIdentifier("library-requests")
}
// …
Section {
} footer: {
  MusicBrainzIndicator()
}
```

8. **Phase 6's recommendation row** ("Songs like these", PlaylistRecommendations.tsx 112), in its trailing slot for songs not in the library; its artist and album links use `DiscoverDestination.artist(id:mbid:name:)` and `.album(id:artistMbid:artistName:title:)` (`rec.artistId`, `rec.artistMbid`, `rec.track?.albumId`):

```swift
if let album = rec.album, let availability = rec.availability {
  RequestButton(album: album, availability: availability, small: true)
}
```

**Step 4: Build, test, and look**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI
make -C apps/ios build
```

Expected: every suite passes; `** BUILD SUCCEEDED **`. Then run the app on the simulator signed in to the dev server (the NAS isn't reachable from Claude's shell: ask the user to start the dev server if it needs the NAS) and check: Search → type an artist not in the library → "Not in your library" appears about half a second after typing stops; an album's Request turns to Requesting then Searching; Library shows Requests; a song's ⋯ → Show metadata opens the sheet.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/AppModel.swift \
  apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/AppModel+Discover.swift \
  apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Discover/DiscoverRoot.swift
git status --short   # the phase 4 and 6 files Step 3 changed: add each by its path (Task 0's notes), and nothing else
git commit -F - <<'EOF'
iOS: Discover, requests, Show metadata and Edit mix points in Search, Artist, Album, Library, the song menus and recommendations

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 22: A UI test that requests an album, against a pretend server in the app

Decision 9. `UITestServer` (Debug builds only) answers the endpoints of the flow and signs the app in when launched with `PLAYARR_UI_STUB=requests`. Its flow is unit-tested first; then the XCUITest searches, requests, sees Searching and both toasts, and finds the request in Library → Requests.

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/UITesting/UITestServer.swift`
- Modify: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/AppModel.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/UITestServerTests.swift`, `apps/ios/PlayarrUITests/RequestingTests.swift`

**Step 1: Write the failing unit test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/UITestServerTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

/// The pretend server the requesting UI test runs against behaves as that test expects.
@MainActor @Suite struct UITestServerTests {
  @Test func anAlbumRequestedFromSearchLandsOnTheSecondLook() async throws {
    setenv("PLAYARR_UI_STUB", "requests", 1)
    defer { unsetenv("PLAYARR_UI_STUB") }
    let app = try #require(UITestServer.appModel())
    let client = try #require(app.store.activeClient)
    let log = EventLog()
    let context = DiscoverContext(client: client, account: UITestServer.account, sleeper: ManualSleeper().sleeper, toast: log.toast)
    await context.refreshHealth()
    #expect(context.gate.allowsRequests)
    let found = try await context.discover("Mezzanine")
    let album = try #require(found.albums.first)
    #expect(context.requests.buttonState(for: AlbumRef(mbid: album.mbid, artistName: album.artistName, albumTitle: album.title), availability: album.availability, allowed: true) == .request)
    context.requests.request(AlbumRef(mbid: album.mbid, artistName: album.artistName, albumTitle: album.title))
    await eventually { log.toasts.count == 1 }
    #expect(log.toasts == ["Requested “Mezzanine”. Lidarr is searching for it"])
    await context.requests.refresh()
    #expect(log.toasts.last == "“Mezzanine” is ready to play")
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter UITestServerTests
```

Expected: the build fails with `cannot find 'UITestServer' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/UITesting/UITestServer.swift`:

```swift
#if DEBUG
  import Foundation
  import PlayarrAPI
  import Synchronization

  /// A pretend server inside the app for UI tests (launch environment `PLAYARR_UI_STUB=requests`): signed in as an
  /// account that may request, a server with Lidarr, one album to find and request, and a request that lands on the
  /// second look. Debug builds only.
  final class UITestServer: URLProtocol, @unchecked Sendable {  // URLProtocol isn't Sendable; its state is in `State`
    static let host = "stub.playarr.invalid"
    private static let state = Mutex(State())

    private struct State {
      var requested = false
      /// Looks at the requests since the album was requested.
      var looks = 0
    }

    /// The app model a UI test launches with, or nil for a normal launch.
    @MainActor static func appModel() -> AppModel? {
      guard ProcessInfo.processInfo.environment["PLAYARR_UI_STUB"] == "requests" else { return nil }
      let configuration = URLSessionConfiguration.ephemeral
      configuration.protocolClasses = [UITestServer.self]
      let directory = FileManager.default.temporaryDirectory.appending(path: "playarr-ui-\(UUID().uuidString)")
      let store = ServerStore(directory: directory, secrets: InMemorySecretStore(), session: URLSession(configuration: configuration))
      let base = URL(string: "http://\(host)")!
      try? store.signedIn(SignInResponse(token: "stub", account: account), server: server, at: base)
      return AppModel(store: store, browser: ServerBrowser(), appVersion: .current, device: .current())
    }

    static let account = Account(id: 2, username: "tester", name: "Tester", role: .member, canRequest: true, sources: nil, hasPassword: true)
    static let server = ServerInfo(id: "stub-server", name: "Stub", version: "1.0.0", minAppVersion: "1.0.0", setup: false)

    override class func canInit(with request: URLRequest) -> Bool { request.url?.host() == host }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
      guard let url = request.url else { return }
      let (status, body) = Self.answer(method: request.httpMethod ?? "GET", path: url.path())
      let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])
      if let response { client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed) }
      client?.urlProtocol(self, didLoad: body)
      client?.urlProtocolDidFinishLoading(self)
    }

    private static func answer(method: String, path: String) -> (Int, Data) {
      let mezzanine = AlbumRef(mbid: "rg-mezzanine", artistName: "Massive Attack", albumTitle: "Mezzanine")
      switch (method, path) {
      case ("GET", "/api/server"):
        return (200, json(server))
      case ("GET", "/api/auth/me"):
        return (200, json(account))
      case ("GET", "/api/health"):
        return (200, json(HealthStatus(ok: true, lidarr: .init(ok: true, version: "2.9"), media: .init(source: .local, ok: true), requests: true)))
      case ("GET", "/api/musicbrainz/status"):
        return (200, json(MusicBrainzStatus(queued: 0, background: 0, etaSeconds: 0, matching: 0)))
      case ("GET", "/api/search"):
        return (200, json(SearchResults(artists: [], albums: [], tracks: [])))
      case ("GET", "/api/discover/search"):
        let album = DiscoverAlbum(
          mbid: mezzanine.mbid ?? "", title: mezzanine.albumTitle, artistName: mezzanine.artistName, artistMbid: "a-massive-attack",
          year: 1998, type: "Album", secondaryTypes: [], availability: availability())
        return (200, json(DiscoverResults(artists: [], albums: [album], tracks: [])))
      case ("POST", "/api/requests"):
        state.withLock { $0.requested = true }
        return (200, json(request(Availability(state: .searching))))
      case ("GET", "/api/requests"):
        let made = state.withLock { s -> Bool in
          if s.requested { s.looks += 1 }
          return s.requested
        }
        return (200, json(made ? [request(availability())] : []))
      default:
        return (404, json(["error": "Not in the UI test server"]))
      }
    }

    /// Searching once requested; in the library from the second look at the requests on.
    private static func availability() -> Availability {
      let (requested, looks) = state.withLock { ($0.requested, $0.looks) }
      if !requested { return Availability(state: .noneValue) }
      return looks >= 2 ? Availability(state: .available, albumId: 70) : Availability(state: .searching)
    }

    private static func request(_ availability: Availability) -> AlbumRequest {
      AlbumRequest(mbid: "rg-mezzanine", title: "Mezzanine", artistName: "Massive Attack", requestedAt: "2026-11-03T10:00:00.000Z", availability: availability)
    }

    private static func json<T: Encodable>(_ value: T) -> Data { (try? JSONEncoder().encode(value)) ?? Data() }
  }
#endif
```

In `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/AppModel.swift`, replace:

```swift
    public static func live() -> AppModel {
        AppModel(store: .live(), browser: ServerBrowser(), appVersion: .current, device: .current())
    }
```

with:

```swift
    public static func live() -> AppModel {
        #if DEBUG
            if let stub = UITestServer.appModel() { return stub }
        #endif
        return AppModel(store: .live(), browser: ServerBrowser(), appVersion: .current, device: .current())
    }
```

(If phase 4 changed `live()`, put the three `#if DEBUG` lines first in its body.)

**Step 4: Run it to see it pass**

Same command. Expected: `Test run with 1 test` … `passed`.

**Step 5: The UI test**

The search field, the tab names and the toasts are phase 4's; if Task 0 found other names (a search field that isn't a `.searchable`, say), adjust the queries here.

`apps/ios/PlayarrUITests/RequestingTests.swift`:

```swift
import XCTest

/// Requesting an album from Search, against the app's pretend server (UITestServer, PLAYARR_UI_STUB=requests): the
/// button goes Request → Searching, the toasts say so, and the album lands on the next look at the requests.
final class RequestingTests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  func testRequestingAnAlbumFromSearch() {
    let app = XCUIApplication()
    app.launchEnvironment["PLAYARR_UI_STUB"] = "requests"
    app.launch()

    app.tabBars.buttons["Search"].tap()
    let field = app.searchFields.firstMatch
    XCTAssertTrue(field.waitForExistence(timeout: 10))
    field.tap()
    field.typeText("Mezzanine")

    XCTAssertTrue(app.staticTexts["Not in your library"].waitForExistence(timeout: 10))
    let request = app.buttons["Request"].firstMatch
    XCTAssertTrue(request.waitForExistence(timeout: 10))
    request.tap()

    XCTAssertTrue(app.staticTexts["Requested “Mezzanine”. Lidarr is searching for it"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["Searching"].waitForExistence(timeout: 10))
    // The requests are asked for every 10 s while one is on its way: the next look finds it in the library.
    XCTAssertTrue(app.staticTexts["“Mezzanine” is ready to play"].waitForExistence(timeout: 25))

    app.tabBars.buttons["Library"].tap()
    let requests = app.buttons["library-requests"]
    XCTAssertTrue(requests.waitForExistence(timeout: 10))
    requests.tap()
    XCTAssertTrue(app.staticTexts["Mezzanine"].waitForExistence(timeout: 10))
    let ready = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Ready to play")).firstMatch
    XCTAssertTrue(ready.waitForExistence(timeout: 10))
  }
}
```

```bash
make -C apps/ios test-app
```

Expected: `** TEST SUCCEEDED **`, with `RequestingTests.testRequestingAnAlbumFromSearch` among the passed tests (it takes about 15 s: the album lands on the next poll, 10 s after the request).

**Step 6: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/UITesting/UITestServer.swift \
  apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/AppModel.swift \
  apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/UITestServerTests.swift \
  apps/ios/PlayarrUITests/RequestingTests.swift
git commit -F - <<'EOF'
iOS: a UI test requests an album from Search against a pretend server inside the app

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 23: Record this phase's names in the conventions

The conventions file says a plan that adds shared names writes them there.

**Files:**
- Modify: `docs/plans/2026-11-03-ios-conventions.md`

**Step 1: Add to "Key types the phases build on"**, after the `PlayarrUI` line:

```markdown
  - `PlayarrUI` (phase 8): `DiscoverContext` (`@MainActor @Observable`, one per signed-in account, `AppModel.discover`, in the environment as `DiscoverContext?`: `client`, `account`, `health`, `gate: RequestGate`, `requests: RequestsModel`, `musicBrainz: MusicBrainzStatusModel`, `sheets: TrackSheets`, `invalidate(_: [CacheFamily])`, `generation(_:)`), `CacheFamily` (the web's query-key names; invalidations are passed on to `QueryCache` by name), `Sleeper` (every wait that polls or debounces, so tests use a fake clock), `DiscoverDestination` (pushed with `.discoverDestinations()` on each tab's stack), `RequestButton(album:availability:small:)`, `TrackLibraryMenuItems(track:)`, `TextFormat` (`clock`, `plural`, `wait`, `jsRound`), `TitleKey`, `ServerDate`. UI tests run against `UITestServer` (Debug, `PLAYARR_UI_STUB=<flow>`); later flows add their routes there.
  - `PlayarrPlayer` (phase 8): `Player.preview(_:from:length:)`, `Player.endPreviews()`, `Player.preview` (a second `AudioEngine` while the queue waits paused; never reported as a play), `Player.previewSeconds` = 8.
```

**Step 2: Commit**

```bash
git add docs/plans/2026-11-03-ios-conventions.md
git commit -F - <<'EOF'
iOS conventions: phase 8's Discover context, families of answers, the fake-able clock, previews and the UI test server

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 24: On a phone, then TestFlight

**Files:** none.

**Step 1: Install**

```bash
corepack pnpm ios:device
```

(Or, with no cabled phone, the TestFlight build of Step 3.) Sign in to the owner's server as an admin with requests on, on Wi-Fi.

**Step 2: The checklist** (each line: what to do, what should happen)

- [ ] **Search, Not in your library**: type an artist that isn't in the library. One letter: no Discover results. Two and more: "Not in your library" fills in about half a second after typing stops; albums already playable aren't listed, artists in the library aren't either; at most 8 songs.
- [ ] **Request**: tap Request on an album. "Requesting", then (if MusicBrainz is slow) "Looking up", then "Searching" or a percentage; the toast "Requested “…”. Lidarr is searching for it" (or "…on its schedule"). The first request asks for notification permission; allow it.
- [ ] **Progress**: "1 request in progress" on Search opens Requests; the row shows Lidarr's message, "requested just now", and a bar while downloading; it changes about every 10 s. Pull to refresh works. Swipe left → Remove takes it off the list (Lidarr still has it).
- [ ] **Landing on screen**: when it finishes, "“…” is ready to play"; the album is in Albums and Search without leaving the screen; its Discover card says In library and opens it.
- [ ] **Landing in the background**: request another album, play music, lock the phone. When it finishes, a notification "“…” is ready to play" arrives on the lock screen.
- [ ] **Coming back**: request an album with no music playing, switch to another app for a few minutes, come back: Requests is up to date at once.
- [ ] **Rights**: sign in as an account without "may request" (switch accounts): no Request, Search again or Retry anywhere; progress and In library still show; Requests rows can't be removed. Turn requests off in Settings → Requests on the web, as the admin: the buttons go within a minute.
- [ ] **Discover artist page**: from a Discover artist card. Genres, name, "N releases · M in your library", Read more and Less, Albums then EPs & soundtracks; Open in your library when they have music here; similar artists (in your library first). From a song's album link: that album is scrolled into view and outlined; a single's title gives the "isn’t among these albums and EPs" note.
- [ ] **Offline**: airplane mode, open a Discover artist page: the error with Try again ("Retrying…" while it asks); airplane mode off, Try again: the page loads.
- [ ] **Find artist**: a Discover song whose artist has only a name: tapping the artist shows "Looking them up on MusicBrainz…", then their page in place. A name MusicBrainz doesn't know: the server's message and "Search for “…” instead".
- [ ] **Artist page**: an artist with a MusicBrainz id shows "Albums not in your library" / "EPs & soundtracks not in your library" with Request.
- [ ] **Album page**: an album with missing songs ("· 3 missing") shows Request; after requesting, its progress there too; once the whole album is in, the button goes. A complete album, and an artist's Loose songs, never show it.
- [ ] **Recommendations**: a playlist's "Songs like these": songs not in the library have Request.
- [ ] **MusicBrainz queue**: rescan a folder source on the web (Settings → Sources): the Library page's foot shows "MusicBrainz · N queued" while lookups wait; VoiceOver reads the wait. A slow lookup (a discography) shows "Asking MusicBrainz for … It answers about one request per second" after 1.5 s.
- [ ] **Show metadata, admin**: a song's ⋯ → Show metadata: Song, Files with source, path (copy button copies it), Tags in the file, Sound meters; MusicBrainz ids open Safari; "Match again on MusicBrainz" on a folder song gives an outcome under the button; on a Lidarr song "Refresh in Lidarr" shows Lidarr's message. A song whose match moves it: the sheet follows to the new song with a toast.
- [ ] **Show metadata, member**: as a member: no paths, the two admins-only notes, no Match again.
- [ ] **Edit mix points, offered**: with Transitions on Crossfade, no "Edit mix points" in song menus; on DJ mix, it's there (and in Now Playing's ⋯).
- [ ] **Edit mix points, moving**: drag In and Out: they snap to bars and never cross (a bar apart); the four buttons move a bar or a phrase; a song without a beat moves by seconds (10 with the outer buttons). VoiceOver: swipe up and down on a marker moves it a bar and reads the time.
- [ ] **Edit mix points, previews**: while the queue plays, tap Play from mix in: the queue pauses and 8 s of the song play from the marker, then silence; Play from mix out: 8 s from there; close the sheet: the queue goes on from the very spot it paused (mid-transition too). With the queue paused before, it stays paused. During a preview, press play on the lock screen: the preview stops and the queue plays. Your listening shows no play for the previewed song.
- [ ] **Edit mix points, saving**: Save: "Mix points saved" and the sheet closes; the next DJ transition into or out of that song uses the new points (the transition sheet's picture moves). Reset: the detected points come back (and are saved if any were).

**Step 3: TestFlight**

If the checklist passes, ask the user whether to ship a build to TestFlight, as each phase ends with one. If yes, run in the background (15 to 45 minutes):

```bash
corepack pnpm ios:beta
```

Expected: the build is processed and handed to the internal group "Household", with this phase's commit subjects as What to Test.

---

## What later phases can rely on

```swift
// PlayarrUI
@MainActor @Observable public final class DiscoverContext {
  public let client: APIClient; public private(set) var account: Account; public private(set) var health: HealthStatus?
  public let requests: RequestsModel; public let musicBrainz: MusicBrainzStatusModel; public let sheets: TrackSheets
  public var gate: RequestGate { get }
  public var libraryArtistPage: @MainActor (Int) -> AnyView; public var libraryAlbumPage: @MainActor (Int) -> AnyView
  public var openSearch: @MainActor (String) -> Void
  public init(client:account:sleeper:notifier:toast:forward:)
  public func start(); func stop(); func becameActive(); func refreshHealth() async; func update(_ account: Account)
  public func generation(_ family: CacheFamily) -> Int; func invalidate(_ families: [CacheFamily])
  public func discover(_ query: String) async throws -> DiscoverResults
  public func discoverArtist(_ mbid: String) async throws -> DiscoverArtistDetail
  public func similarArtists(_ mbid: String) async throws -> [DiscoverArtist]
}
public struct RequestGate { hasLidarr: Bool; allowsRequests: Bool; canRequest: Bool; init(health:account:) }
public enum RequestButtonState { hidden, requesting(slow:), partial(count:summary:albumId:canRequest:), request, searching(message:),
  downloading(percent:message:), importing(message:), searchAgain(message:), retry(message:), inLibrary(albumId:)
  static func make(_:allowed:pending:); var label: String; var help: String?; var asks: Bool; var opensAlbum: Int? }
@MainActor @Observable public final class RequestsModel { requests: [AlbumRequest]?; error; pending; activeCount
  startPolling(); stopPolling(); refresh() async; request(_ album: AlbumRef); remove(_:) async
  buttonState(for:availability:allowed:); rest(of album: Album) -> (album: AlbumRef, availability: Availability)? }
public enum DiscoverDestination: Hashable { libraryArtist(id:), libraryAlbum(id:), discoverArtist(mbid:album:), findArtist(name:album:), requests
  static func artist(id:mbid:name:); static func album(id:artistMbid:artistName:title:) }
public enum CacheFamily: String, CaseIterable { albums, artists, artist, album, health, search, discover, requests, recommendations,
  discoverArtist, similarArtists, mixMaps, trackMetadata }
public struct Sleeper: Sendable { let sleep: @Sendable (Duration) async throws -> Void; static let live }
// Views: RequestButton(album:availability:small:), RequestsPill(), RequestRestButton(album:), RequestsPage(), DiscoverSection(query:),
// DiscoverAlbumCard, DiscoverTrackRow, DiscoverArtistCard, DiscoverArtistPage(mbid:album:), FindArtistPage(name:album:),
// NotInLibrarySection(artistMbid:owned:), SimilarArtistsSection(mbid:), SlowLookup(what:), MusicBrainzIndicator(),
// TrackMetadataSheet(model:), MixPointsSheet(model:), TrackLibraryMenuItems(track:)
// Modifiers: .discoverRoot(_ app: AppModel), .discoverDestinations(), .trackSheets(player:)

// PlayarrPlayer
extension Player {
  public private(set) var preview: Preview?            // stored in Player
  public static let previewSeconds: Double             // 8
  public func preview(_ track: Track, from seconds: Double, length: Double = Player.previewSeconds)
  public func endPreviews()
}
public struct Preview: Equatable, Sendable { recordingId: String; from: Double }
```
