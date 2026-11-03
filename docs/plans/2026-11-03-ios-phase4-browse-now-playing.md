# Native iOS app, Phase 4: Browsing and Now Playing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Day-to-day listening in the app. The signed-in app becomes the web's phone layout: tabs Home, Search, Library and Queue, a mini player above the tab bar, full-screen Now Playing (swipe down to close, lyrics, sleep timer, the ⋯ menu), toasts, and Settings with this device's Playback and Appearance. Home, Search, the Library hub, Artists, Albums, Artist and Album pages browse the library from a stale-while-revalidate cache kept on disk, with covers from a disk image cache and the accent colour taken from the album art with the web's algorithm.

**Architecture:** Everything lands in `PlayarrUI`, on top of phase 2's `AppModel`/`ServerStore`/`API.<Feature>`/`MediaURLs` and phase 3's `Player`. `AppModel` gains one `AccountSession` per active, signed-in account: its `any APISending` (the account's `APIClient`), `Player`, `QueryCache` (answers in memory, the library also on disk for 7 days, keyed like the web's persisted React Query keys), `ImageCache` (disk, asks for the sizes the server makes, token in the header through `MediaURLs`), and `AppRouter` (tab, each tab's stack of `Route`s, Now Playing open). Switching accounts closes the session (its player reports the song so far, saves its queue and lets go of the lock screen) and opens the next. Pages are thin SwiftUI views over small `@MainActor @Observable` models built from `Query<Value>` objects; models are tested with Swift Testing against `FakeAPI` and an offline player. Pages are values (`Route`) shown by one `RouteDestination`, inside a `NavigationStack` per tab today and a `NavigationSplitView` on iPad in phase 10. UI tests launch the app with `-UITestsDemo`: signed in to an in-memory demo library (`DemoAPI`), playing silence.

**Tech Stack:** Swift 6 language mode with strict concurrency (Xcode 27.2, Swift 6.4, tools version 6.2), SwiftUI for iOS 26 (`Tab`, `tabViewBottomAccessory`, `tabBarMinimizeBehavior`, `fullScreenCover`, `sensoryFeedback`, `onScrollPhaseChange`), Observation, CoreGraphics and ImageIO (accent colour, WebP covers), CryptoKit (image file names), Synchronization (`Mutex`), Swift Testing, XCUITest. No third-party packages.

**Design:** [2026-11-03-ios-app-design.md](2026-11-03-ios-app-design.md): Rollout phase 4; section 2 ("Screens", "Settings", "Data", "Accent colour"). Names, layout and commands: [2026-11-03-ios-conventions.md](2026-11-03-ios-conventions.md). What to port, with file references: [2026-11-03-ios-parity-inventory.md](2026-11-03-ios-parity-inventory.md) sections 1, 2 (Playback, Appearance), 3b (library browse), 4 (queue, radio, sleep), 5 (lyrics, accent) and 6 (local search). Builds on [phase 2](2026-11-03-ios-phase2-api-sign-in.md) and [phase 3](2026-11-03-ios-phase3-audio-engine.md).

---

## Where things stand (checked 2026-11-03, about 15:00 UTC)

- Phase 2 is on `main` (merged in `8a4d85a`): `PlayarrAPI` with the generated models, `APIClient`, `API.<Feature>`, `MediaURLs`, `ServerStore`; `PlayarrUI` with `AppModel` (`live()`, `empty()` for `-UITests`), `RootView`, `SignedInHomeView`, `AccountSwitcherView` and the sign-in flow. Its test target has `FakeServer` (a `URLProtocol` stub) in `AddServerModelTests.swift`, which Task 7 reuses.
- Phase 3 is planned, not built: `PlayarrPlayer` still holds `PlayerPlaceholder`. **This plan starts after phase 3 has landed** (Task 0 checks).
- The phase 9 plan (admin settings) was written in parallel and defines `APISending` (in `PlayarrAPI`), and the test doubles `FakeAPI` and `TestClock`. Phase 4 is built first, so Task 2 adds them with phase 9's code; phase 9's Tasks 1 and 2 then find them and keep them.
- How the code below was checked: see "Verified while writing" at the end.

## Key decisions in this plan

- **One session per account.** `AccountSession` holds everything that belongs to the signed-in account: its API, player, caches and router. `AppModel.syncSession()` (run by `RootView` whenever the active account or its signed-in state changes) closes the old session and opens the new one. The web resets its account's queries on a switch for the same reason: nothing of one account stays on screen for the next. Phase 3's `Player` keeps one player per account folder (`queue.json`, `pending-plays.json`); two `Player.live` at once would fight over the lock screen, so **Task 1 adds `Player.shutDown()`** (and `NowPlayingBridge.unregister()`) to phase 3's code.
- **`QueryCache` + `Query<Value>`, not a general store.** The cache is keyed by `QueryKey` (the web's key names: `artists`, `artist/7`, `albums/added/14`, `album/70`, …). Only the web's `KEPT` keys (`artists`, `artist`, `albums`, `album`, `favorites`, `playlists`, `playlist`, `mixes`, never a shuffle) go to disk, as `{ updatedAt, value }` JSON in the account's folder (`Application Support/Playarr/<server>/<account>/queries/`), and anything older than 7 days is dropped. `Query` shows the cached value at once and asks the server when it's missing or stale (the web's stale times: 5 min by default, health 30 s, favorites and playlists 60 s, mixes 30 s, a shuffle never). A failed ask keeps what's shown and reports an error only with nothing to show: offline browsing.
- **Images ask for the server's sizes.** The server snaps every `?size=` to 96, 160, 240, 320, 480, 640, 960 or 1200 px (`apps/server/src/routes/art.ts`). `ImageCache.pixels(points:scale:)` asks for the rung that covers what's shown on this screen (scale up to 3), so the server's cache and ours hit. Images go to `Caches/Playarr/<server>/<account>/images/` (the system may purge them), kept 60 days and 1500 files at most like the web's service worker. A failed image is asked once more with `&retry=1` after 1.5 s, as the web's `Cover` does.
- **The accent algorithm is ported line by line** (`apps/web/src/lib/color.ts`): 32×32 pixels (CoreGraphics in sRGB, as the canvas), 12 hue bins weighted `s² × (1 − |l − 0.5| × 2) + 0.001`, near-black (l < 0.08) and near-white (l > 0.95) dropped, nothing below a weight of 0.5, then saturation clamped to 45–90 % and lightness to 56–68 %, rounded like the web's `hsl()` string. The web has no tests for it; Task 8 adds them.
- **Haptics through SwiftUI's `sensoryFeedback`** (it compiles on the Mac, where `swift test` builds the package): play/pause, shuffle, repeat, reshuffle, reordering the queue, and a success/error tap with each toast.
- **Now Playing closes past 120 points or 600 points a second**, the web's thresholds, with a `DragGesture` on the header and cover (`NowPlayingModel.closes`), not the system's own dismissal.
- **The mini player sits in the tab bar's bottom accessory** (iOS 26), shown only while something is queued (`isEnabled:` from iOS 26.1).
- **Pages the app doesn't have yet are placeholders**, so every link on Home and in Library goes somewhere: Favorites, Playlists, a playlist, Made for you, a mix and Your listening (phase 6); the admin panels (phase 9). The heart in Now Playing shows but does nothing until phase 6.
- **Crossfade is offered on the phone** (the native engine can fade), so the Playback panel drops the web's "this device can't crossfade" sentence. Keyboard shortcuts (iPad with a keyboard, phase 10) and "On this device" storage (phase 7) aren't in the panel yet.
- **Two departures from the web, both fixes.** Clear's Undo checks the song as well as its queue index (a new queue reuses index 0, and the web's check then restores the old songs into the new queue). Playlist names are matched against what's typed rather than what was last searched, so they show even when the library search fails.
- **UI tests run against a demo library, not a server.** `-UITestsDemo` makes `AppModel.demo()`: a server store signed in to "Demo" in memory, `DemoAPI` answering from `Demo` (two artists, three albums, lyrics, a mix, a playlist, a favorite), and a `Player` whose songs are `SilentSource`s. The tests then need no network and no NAS (which Claude's shell can't reach anyway).

## Conventions

- Run everything from the repo root `/Users/bortignon/dev/playarr`. `pnpm` is `corepack pnpm` in Claude's shell.
- One package's tests: `swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI` (one suite: `--filter QueryCacheTests`). Same for `PlayarrAPI` and `PlayarrPlayer`. `--disable-sandbox` because SwiftPM's sandbox can't start inside Claude's shell.
- Build the UI package for the iPhone simulator (catches iOS-only API mistakes the Mac build can't): `swift build --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --triple arm64-apple-ios26.0-simulator --sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" --scratch-path /tmp/playarr-ui-ios`.
- Everything iOS (scripts, the three packages, then the app and its UI tests on a simulator): `make -C apps/ios test`.
- Swift: 2-space indentation in hand-written files (phase 2's `AppModel.swift` and `RootView.swift` keep their 4); one primary type per file, named after it; no force unwraps outside tests; Swift Testing in packages; user-facing text in the web's words. View models take `any APISending`, never `APIClient`.
- Commit after every task, on `main`, only that task's files, with the message given (plain English, no prefixes beyond the history's `iOS:`), ending with a blank line and `Co-Authored-By: Claude <noreply@anthropic.com>`. The pre-commit hook bumps the version: never bypass it. The user pushes (a push to `main` also deploys the server to the NAS, so ask first).

## Before you start

This plan relies on these names; Task 0 checks them.

- **Phase 2** (`docs/plans/2026-11-03-ios-phase2-api-sign-in.md`, on `main`): the models `Track`, `Album`, `AlbumDetail`, `MissingTrack`, `Artist`, `ArtistDetail`, `SearchResults`, `PlaylistSummary` (with phase 1's `owner`, `shared`, `mine`), `PlaylistCoverInfo`, `MixSummary`, `FavoriteTrack`, `HealthStatus`, `LibraryStats`, `ListeningStats`, `Lyrics` (`SyncedItem`, `Source`), `DiscoverArtist`, `AudioFormat`, `AlbumSort`, `Account`, `ServerInfo`, `SignInResponse`; `Endpoint`, `HTTPMethod`, `APIClient` (`send`, `static decode`), `APIError`, `LyricsAnswer`; `API.Server.health()`, `API.Library.*`, `API.Search.library(_:)`, `API.Favorites.list()`, `API.Playlists.list()`, `API.Mixes.list()`, `API.Stats.listening(_:)`, `API.Discover.similarArtists(mbid:)`, `API.Playback.radio(seeds:exclude:count:)`; `MediaURLs.art(_:size:)` and `request(for:)`; `ServerStore` (`activeAccount`, `server(_:)`, `client(for:)`, `mediaURLs(for:)`, `signedIn(_:server:at:)`, `markSignedOut(_:)`), `AccountRecord.key`, `AccountKey`, `InMemorySecretStore`, `AppVersion`, `DeviceInfo`; in `PlayarrUI`: `AppModel`, `RootView`, `AccountSwitcherView(model:)`, `SignedInHomeView`, and the test helper `FakeServer`.
- **Phase 3** (`docs/plans/2026-11-03-ios-phase3-audio-engine.md`, must have landed): `Player` (`init(backend:directory:settings:makeEngine:makeSource:)`, `static live(backend:directory:settings:)`, `queue`, `time`, `duration`, `loading`, `notice`, `sleep`, `start()`, `play(_:startAt:source:shuffle:at:)`, `playNext`, `addToQueue`, `jump(to:)`, `remove(at:)`, `setUpcoming`, `clearUpcoming`, `next()`, `previous()`, `toggleShuffle()`, `cycleRepeat()`, `setPlaying`, `togglePlay()`, `seek(to:)`, `startRadio(_:)`, `sleep(minutes:)`, `sleepAtEndOfSong()`, `cancelSleep()`, `appWillTerminate()`, `engine`, `nowPlaying`, and the private `ticker`), `Player.Notice`, `QueueState` (`currentTrack`, `upcoming(_:)`, `order`, `pos`, `queue`, `playing`, `shuffle`, `repeatMode`, `source`), `PlaySource`, `RepeatMode`, `PlaybackSettings` (`transitions`, `crossfade`, `levelVolume`, `autoplay`, `recordPlays`, `crossfades`), `SleepTimer.label(at:)`, `Radio.source(for:)`, `PlayerBackend`, `APIBackend(client:media:)`, `PCMSource`, `PCMBlock(left:right:)`, `EngineItem`, `AudioEngine(manualRendering:makeSource:)` and `state`, `NowPlayingBridge`, `JSONFile`, and in `PlayarrUI` (debug builds) `PlayerLabView(player:client:)` and `PlayerLabEntry`. Its test helpers `Player.testing(directory:)`, `song(_:)` and `temporaryDirectory()` (Task 1 uses them).

If a name differs, change it in the task that uses it, and nowhere else.

---

### Task 0: Check the starting point

**Files:** none.

**Step 1: Phase 2's and phase 3's names are there**

```bash
grep -n "public func client(for\|public func mediaURLs(for\|public var activeAccount" apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/ServerStore.swift
grep -n "public static func empty\|public init(store" apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/AppModel.swift
grep -n "final class FakeServer" apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/AddServerModelTests.swift
grep -n "public static func live\|public func appWillTerminate\|private var ticker\|public func startRadio" apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Player.swift
grep -n "public init(tuning: Tuning = Tuning(), manualRendering" apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/AudioEngine.swift
grep -n "public func label(at" apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/SleepTimer.swift
grep -rn "public struct PlayerLabView\|public struct PlayerLabEntry" apps/ios/Packages/PlayarrUI/Sources/PlayarrUI
grep -n "public var owner: String" apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/Models.generated.swift
```

Expected: every grep prints a line. If a Player or AudioEngine line is missing, phase 3 hasn't landed: stop and say so.

**Step 2: Everything builds and passes now**

```bash
make -C apps/ios test
```

Expected: the scripts' tests, the three packages' suites and the app's UI test pass. Note the counts: later tasks add to them.

---

### Task 1: A player can be shut down when its account is switched away

Phase 3's `Player.live` registers remote commands and runs a 10 Hz clock for the app's life. The app now makes one player per account, so the old one must report its song, save its queue, stop and let go of the lock screen before the next one starts.

**Files:**
- Modify: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Player.swift`
- Modify: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/NowPlayingBridge.swift`
- Test: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/PlayerTests.swift`

**Step 1: Write the failing test**

Add inside `struct PlayerTests` in `PlayerTests.swift`:

```swift
  @Test func shutsDownWhenItsAccountIsSwitchedAway() throws {
    let directory = temporaryDirectory()
    let player = try Player.testing(directory: directory)
    player.play([song(1), song(2)])
    player.shutDown()
    #expect(!player.queue.playing)
    #expect(player.engine.state == .idle)
    let saved = try #require(JSONFile<QueueState>(directory.appending(path: "queue.json")).read())
    #expect(saved.queue.count == 2)
    #expect(saved.pos == 0)
  }
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter PlayerTests
```

Expected: the build fails with `value of type 'Player' has no member 'shutDown'`.

**Step 3: Implement**

In `Player.swift`, add inside the class, right after `appWillTerminate()` (it needs the private `ticker`):

```swift
  /// The account is switched away from: the song so far is reported, the queue saved, the engine stopped, and the lock
  /// screen and remote commands let go, so the next account's player owns them.
  public func shutDown() {
    ticker?.cancel()
    ticker = nil
    appWillTerminate()
    queue.playing = false
    engine.stop()
    nowPlaying?.update(track: nil, elapsed: 0, playing: false)
    nowPlaying?.unregister()
    nowPlaying = nil
  }
```

In `NowPlayingBridge.swift`, add inside the class, after `update(track:elapsed:playing:)`:

```swift
  /// Lets go of the remote commands (the next player registers its own).
  public func unregister() {
    let center = MPRemoteCommandCenter.shared()
    let commands: [MPRemoteCommand] = [
      center.playCommand, center.pauseCommand, center.togglePlayPauseCommand, center.nextTrackCommand,
      center.previousTrackCommand, center.changePlaybackPositionCommand, center.likeCommand, center.stopCommand,
    ]
    for command in commands { command.removeTarget(nil) }
  }
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer
```

Expected: every PlayarrPlayer suite passes, `shutsDownWhenItsAccountIsSwitchedAway` included. If the engine reports another state after `stop()` than `.idle`, assert the one `AudioEngine.stop()` sets.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Player.swift apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/NowPlayingBridge.swift apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/PlayerTests.swift
git commit -F - <<'MSG'
iOS: shut a player down when its account is switched away: report the song, save the queue, let go of the lock screen

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 2: `APISending`, and the shared test doubles `FakeAPI` and `TestClock`

The conventions' seam between view models and the server, and the two test doubles every later phase shares. The code is the phase 9 plan's (its Tasks 1 and 2), so that phase finds them and keeps them. `FakeAPI` and `TestClock` go in `Support/` rather than phase 9's `Admin/`: they serve every screen.

**Files:**
- Create: `apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/APISending.swift`
- Test: `apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/APISendingTests.swift`
- Create: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/Support/FakeAPI.swift`, `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/Support/TestClock.swift`

First check that no other phase added them: `grep -rn "protocol APISending\|class FakeAPI\|class TestClock" apps/ios/Packages`. Keep any that exist (one of each), and skip its file below.

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/APISendingTests.swift`:

```swift
import Foundation
import Testing
@testable import PlayarrAPI

@Suite struct APISendingTests {
  @Test func theClientSendsThroughTheProtocol() async throws {
    let host = "sending-\(UUID().uuidString.lowercased()).invalid"
    let session = StubProtocol.session(host: host) { request in
      #expect(request.url?.path() == "/api/artists")
      #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer tok")
      return (200, Data(#"[{"id":7,"name":"Massive Attack","sortName":"Massive Attack","genres":[],"albumCount":1,"trackCount":2}]"#.utf8))
    }
    let sender: any APISending = APIClient(baseURL: URL(string: "http://\(host)")!, token: "tok", session: session)
    #expect(try await sender.send(API.Library.artists()).map(\.name) == ["Massive Attack"])
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrAPI --filter APISendingTests
```

Expected: the build fails with `cannot find type 'APISending' in scope`.

**Step 3: Implement the protocol and the test doubles**

`apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/APISending.swift`:

```swift
/// Sends an endpoint and decodes its answer: what screens and view models talk to, so tests can
/// answer them from a fake. `APIClient` is the real one.
public protocol APISending: Sendable {
  func send<T: Decodable & Sendable>(_ endpoint: Endpoint<T>) async throws -> T
}

extension APIClient: APISending {}
```

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/Support/FakeAPI.swift`:

```swift
import Foundation
import PlayarrAPI
import Synchronization

/// Answers view models' calls from canned JSON and remembers every call, with its body as sorted JSON.
/// Each "METHOD /path" has a queue of answers: they're given in order and the last one repeats.
final class FakeAPI: APISending, @unchecked Sendable {
  struct Call: Equatable, CustomStringConvertible {
    var method: HTTPMethod
    var path: String
    /// The body as JSON with sorted keys; nil without one.
    var body: String?

    var description: String { "\(method.rawValue) \(path)\(body.map { " \($0)" } ?? "")" }
  }

  private enum Answer {
    case json(String)
    case failure(any Error)
  }

  private struct State {
    var answers: [String: [Answer]] = [:]
    var calls: [Call] = []
  }

  private let state = Mutex(State())

  /// From now on, `method path` answers this JSON (an empty string for 204).
  func on(_ method: HTTPMethod, _ path: String, json: String) {
    state.withLock { $0.answers[key(method, path)] = [.json(json)] }
  }

  /// From now on, `method path` answers this value.
  func on(_ method: HTTPMethod, _ path: String, _ value: some Encodable) {
    on(method, path, json: Self.json(value))
  }

  /// Answered after the answers already queued for `method path`.
  func then(_ method: HTTPMethod, _ path: String, _ value: some Encodable) {
    then(method, path, json: Self.json(value))
  }

  func then(_ method: HTTPMethod, _ path: String, json: String) {
    state.withLock { $0.answers[key(method, path), default: []].append(.json(json)) }
  }

  /// From now on, `method path` fails as the server does: a status and its `{ error }` message.
  func fail(_ method: HTTPMethod, _ path: String, status: Int = 400, _ message: String) {
    state.withLock { $0.answers[key(method, path)] = [.failure(APIError.server(status: status, message: message))] }
  }

  var calls: [Call] { state.withLock { $0.calls } }

  func calls(_ method: HTTPMethod, _ path: String) -> [Call] {
    calls.filter { $0.method == method && $0.path == path }
  }

  /// The bodies sent to `method path`, in order.
  func bodies(_ method: HTTPMethod, _ path: String) -> [String] {
    calls(method, path).compactMap(\.body)
  }

  func send<T: Decodable & Sendable>(_ endpoint: Endpoint<T>) async throws -> T {
    let body = try endpoint.bodyData().map(Self.sorted)
    let answer: Answer? = state.withLock { state in
      state.calls.append(Call(method: endpoint.method, path: endpoint.path, body: body))
      let key = key(endpoint.method, endpoint.path)
      guard var queue = state.answers[key], let first = queue.first else { return nil }
      if queue.count > 1 {
        queue.removeFirst()
        state.answers[key] = queue
      }
      return first
    }
    switch answer {
    case nil:
      throw APIError.server(status: 404, message: "No fake answer for \(endpoint.method.rawValue) \(endpoint.path)")
    case .failure(let error):
      throw error
    case .json(let text):
      return try JSONDecoder().decode(T.self, from: Data((text.isEmpty ? "{}" : text).utf8))
    }
  }

  private func key(_ method: HTTPMethod, _ path: String) -> String { "\(method.rawValue) \(path)" }

  private static func json(_ value: some Encodable) -> String {
    // swiftlint:disable:next force_try
    String(decoding: try! JSONEncoder().encode(value), as: UTF8.self)
  }

  private static func sorted(_ data: Data) -> String {
    guard let object = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]),
      let sorted = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .fragmentsAllowed, .withoutEscapingSlashes])
    else { return String(decoding: data, as: UTF8.self) }
    return String(decoding: sorted, as: UTF8.self)
  }
}
```

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/Support/TestClock.swift`:

```swift
import Synchronization

/// A clock that only moves when a test says so. `nextSleep()` waits until something sleeps on it and
/// says for how long; `advance(by:)` wakes whoever's time has come. Polling loops are then followed step
/// by step: a loop only sleeps again once its refresh has finished.
final class TestClock: Clock, @unchecked Sendable {
  struct Instant: InstantProtocol, Hashable {
    var offset: Duration

    func advanced(by duration: Duration) -> Instant { Instant(offset: offset + duration) }
    func duration(to other: Instant) -> Duration { other.offset - offset }
    static func < (lhs: Instant, rhs: Instant) -> Bool { lhs.offset < rhs.offset }
  }

  private struct Sleeper {
    let id: Int
    let deadline: Instant
    let continuation: CheckedContinuation<Void, any Error>
  }

  private struct State {
    var now = Instant(offset: .zero)
    var sleepers: [Sleeper] = []
    var watchers: [CheckedContinuation<Void, Never>] = []
    var cancelled: Set<Int> = []
    var nextId = 0
  }

  private let state = Mutex(State())

  var now: Instant { state.withLock { $0.now } }
  var minimumResolution: Duration { .zero }

  func sleep(until deadline: Instant, tolerance: Duration?) async throws {
    let id = state.withLock { state in
      state.nextId += 1
      return state.nextId
    }
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
        let (watchers, outcome): ([CheckedContinuation<Void, Never>], Result<Void, any Error>?) = state.withLock { state in
          if state.cancelled.remove(id) != nil { return ([], .failure(CancellationError())) }
          if deadline <= state.now { return ([], .success(())) }
          state.sleepers.append(Sleeper(id: id, deadline: deadline, continuation: continuation))
          defer { state.watchers = [] }
          return (state.watchers, nil)
        }
        if let outcome { continuation.resume(with: outcome) }
        for watcher in watchers { watcher.resume() }
      }
    } onCancel: {
      let sleeper: Sleeper? = state.withLock { state in
        guard let index = state.sleepers.firstIndex(where: { $0.id == id }) else {
          state.cancelled.insert(id)
          return nil
        }
        return state.sleepers.remove(at: index)
      }
      sleeper?.continuation.resume(throwing: CancellationError())
    }
  }

  /// Waits until something sleeps on this clock, and says how long it asked to sleep for.
  func nextSleep() async -> Duration {
    while true {
      if let wait = pendingSleep { return wait }
      await withCheckedContinuation { (watcher: CheckedContinuation<Void, Never>) in
        let ready = state.withLock { state in
          if state.sleepers.isEmpty {
            state.watchers.append(watcher)
            return false
          }
          return true
        }
        if ready { watcher.resume() }
      }
    }
  }

  /// How long the first sleeper still has to sleep, if something is sleeping.
  var pendingSleep: Duration? {
    state.withLock { state in state.sleepers.first.map { state.now.duration(to: $0.deadline) } }
  }

  /// Moves time on and wakes whoever's deadline has come.
  func advance(by duration: Duration) {
    let due: [Sleeper] = state.withLock { state in
      state.now = state.now.advanced(by: duration)
      let now = state.now
      let due = state.sleepers.filter { $0.deadline <= now }
      state.sleepers.removeAll { $0.deadline <= now }
      return due
    }
    for sleeper in due { sleeper.continuation.resume() }
  }
}
```

**Step 4: Run it to see it pass, and the UI package still builds its tests**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrAPI
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI
```

Expected: every PlayarrAPI suite passes (`APISendingTests`: 1 test); PlayarrUI's phase 2 suites pass (the doubles compile, nothing uses them yet).

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/APISending.swift apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/APISendingTests.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/Support/FakeAPI.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/Support/TestClock.swift
git commit -F - <<'MSG'
iOS: a protocol for sending endpoints, so screens can be tested against a fake server, and a test clock

APIClient conforms as it is. FakeAPI and TestClock are the test doubles the
conventions share between phases.

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 3: The web's wording for times, durations, counts and formats

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Support/Format.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/FormatTests.swift`

Ports `formatTime`, `formatDuration`, `plural`, `formatBadge` and `isHiRes` from `apps/web/src/lib/format.ts`, and the album page's `addedAgo` (`apps/web/src/pages/Album.tsx`).

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/FormatTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@Suite struct FormatTests {
  @Test func writesTimesAsTheWebDoes() {
    #expect(Format.time(245) == "4:05")
    #expect(Format.time(3725) == "1:02:05")
    #expect(Format.time(-3) == "0:00")
    #expect(Format.time(.nan) == "0:00")
  }

  @Test func writesDurations() {
    #expect(Format.duration(2564) == "43 min")
    #expect(Format.duration(7300) == "2 hr 2 min")
    #expect(Format.duration(7200) == "2 hr")
  }

  @Test func countsInWords() {
    #expect(Format.plural(1, "track") == "1 track")
    #expect(Format.plural(12, "track") == "12 tracks")
  }

  @Test func namesTheFormat() {
    let hiRes = AudioFormat(codec: "FLAC", container: "flac", bits: 24, sampleRate: 88_200, lossless: true)
    let cd = AudioFormat(codec: "FLAC", container: "flac", bits: 16, sampleRate: 44_100, lossless: true)
    let mp3 = AudioFormat(codec: "MP3", container: "mp3", bitrate: 320, lossless: false)
    #expect(Format.badge(hiRes) == "FLAC 24/88.2")
    #expect(Format.badge(cd) == "FLAC 16/44.1")
    #expect(Format.badge(mp3) == "MP3 320")
    #expect(Format.badge(AudioFormat(codec: "AAC", container: "m4a", lossless: false)) == "AAC")
    #expect(Format.isHiRes(hiRes))
    #expect(!Format.isHiRes(cd))
    #expect(!Format.isHiRes(mp3))
  }

  @Test func saysWhenAnAlbumWasAdded() {
    let now = Format.parseDate("2026-11-03T12:00:00.000Z")!
    let english = Locale(identifier: "en_US")
    #expect(Format.addedAgo("2026-11-03T08:00:00Z", now: now, locale: english) == "today")
    #expect(Format.addedAgo("2026-10-31T12:00:00.000Z", now: now, locale: english) == "3 days ago")
    #expect(Format.addedAgo("2026-09-01T12:00:00.000Z", now: now, locale: english) == "2 months ago")
    #expect(Format.addedAgo("not a date", now: now) == nil)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter FormatTests
```

Expected: the build fails with `cannot find 'Format' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Support/Format.swift`:

```swift
import Foundation
import PlayarrAPI

/// Times, sizes and counts written as the web writes them (apps/web/src/lib/format.ts).
public enum Format {
  /// 245 → "4:05", 3725 → "1:02:05".
  public static func time(_ seconds: Double) -> String {
    let total = seconds.isFinite && seconds > 0 ? Int(seconds) : 0
    let s = total % 60
    let m = (total / 60) % 60
    let h = total / 3600
    let ss = s < 10 ? "0\(s)" : "\(s)"
    return h > 0 ? "\(h):\(m < 10 ? "0\(m)" : "\(m)"):\(ss)" : "\(m):\(ss)"
  }

  /// 2564 → "43 min", 7300 → "2 hr 2 min".
  public static func duration(_ seconds: Double) -> String {
    let h = Int(seconds / 3600)
    let m = Int((seconds.truncatingRemainder(dividingBy: 3600) / 60).rounded())
    if h == 0 { return "\(m) min" }
    return m > 0 ? "\(h) hr \(m) min" : "\(h) hr"
  }

  /// "1 track", "12 tracks".
  public static func plural(_ n: Int, _ word: String, _ pluralWord: String? = nil) -> String {
    "\(n) \(n == 1 ? word : pluralWord ?? "\(word)s")"
  }

  /// "FLAC 24/88.2", "MP3 320", "AAC".
  public static func badge(_ format: AudioFormat?) -> String? {
    guard let format else { return nil }
    if format.lossless {
      guard let bits = format.bits, let rate = format.sampleRate else { return format.codec }
      let khz = Double(rate) / 1000
      let spec = khz == khz.rounded() ? String(Int(khz)) : String(format: "%.1f", khz)
      return "\(format.codec) \(bits)/\(spec)"
    }
    guard let bitrate = format.bitrate else { return format.codec }
    return "\(format.codec) \(Int(bitrate))"
  }

  /// More than CD quality (16-bit/44.1 kHz).
  public static func isHiRes(_ format: AudioFormat?) -> Bool {
    guard let format, format.lossless else { return false }
    return (format.bits ?? 0) > 16 || (format.sampleRate ?? 0) > 48_000
  }

  /// "today", "3 days ago", "2 months ago": when an album entered the library.
  public static func addedAgo(_ iso: String, now: Date = Date(), locale: Locale = .current) -> String? {
    guard let date = parseDate(iso) else { return nil }
    let days = Int((date.timeIntervalSince(now) / 86_400).rounded())
    if days > -1 { return "today" }
    let relative = RelativeDateTimeFormatter()
    relative.locale = locale
    relative.dateTimeStyle = .named
    var parts = DateComponents()
    if days > -30 {
      parts.day = days
    } else if days > -365 {
      parts.month = Int((Double(days) / 30).rounded())
    } else {
      parts.year = Int((Double(days) / 365).rounded())
    }
    return relative.localizedString(from: parts)
  }

  /// The server's ISO 8601 dates, with or without fractions of a second.
  public static func parseDate(_ iso: String) -> Date? {
    let precise = ISO8601DateFormatter()
    precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return precise.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter FormatTests
```

Expected: 5 tests pass. (The web's comment on `formatDuration` says 7300 s is "2 hr 1 min"; its code, like this port, says "2 hr 2 min".)

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Support/Format.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/FormatTests.swift
git commit -F - <<'MSG'
iOS: song times, durations, counts and format badges in the web's words

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 4: A demo library and its server in memory

What the UI tests browse and what view-model tests start from: two artists, three albums (Mezzanine with two songs missing, Dummy on two discs and Hi-Res), timed lyrics for "Angel", a mix, a playlist, a favorite. `Demo.routes` lists the answers by method and path; `DemoAPI` serves them (and searches) in the app; `FakeAPI.demoLibrary()` loads them into the test double.

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Demo/Demo.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Demo/DemoAPI.swift`
- Create: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/Support/FakeAPI+Demo.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/DemoAPITests.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/DemoAPITests.swift`:

```swift
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@Suite struct DemoAPITests {
  @Test func answersLikeARealServer() async throws {
    let api = DemoAPI()
    #expect(try await api.send(API.Library.album(id: 70)).missingTracks.count == 2)
    #expect(try await api.send(API.Library.artist(id: 7)).albums.map(\.title) == ["Mezzanine", "Protection"])
    #expect(try await api.send(API.Search.library("dummy")).albums.map(\.title) == ["Dummy"])
    #expect(try await api.send(API.Library.lyrics(trackId: 700)).lyrics == Demo.lyrics)
    #expect(try await api.send(API.Library.lyrics(trackId: 701)).lyrics == nil)
    #expect(try await api.send(API.Playback.radio(seeds: ["rec-700"])).count == 3)
  }

  @Test func saysNotFoundForTheRest() async {
    await #expect(throws: APIError.server(status: 404, message: "Not found")) { try await DemoAPI().send(API.Library.album(id: 1)) }
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter DemoAPITests
```

Expected: the build fails with `cannot find 'DemoAPI' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Demo/Demo.swift`:

```swift
import Foundation
import PlayarrAPI

/// A small library in memory: what the UI tests browse (`-UITestsDemo`) and what view-model tests use as fakes.
/// Two artists, three albums (one with missing songs, one on two discs), lyrics, a mix, a playlist and a favorite.
public enum Demo {
  public static let baseURL = URL(string: "https://demo.playarr.invalid")!
  public static let server = ServerInfo(id: "demo-server", name: "Demo", version: "0.0.0", minAppVersion: "1.0.0", setup: false)
  public static let account = Account(id: 1, username: "demo", name: "Demo", role: .admin, canRequest: false, sources: nil, hasPassword: true)
  static let when = "2026-11-01T12:00:00.000Z"
  static let flac = AudioFormat(codec: "FLAC", container: "flac", bits: 16, sampleRate: 44_100, lossless: true)
  static let hiRes = AudioFormat(codec: "FLAC", container: "flac", bits: 24, sampleRate: 96_000, lossless: true)

  public static let artist = Artist(
    id: 7, name: "Massive Attack", sortName: "Massive Attack", genres: ["trip hop"],
    overview: "Bristol collective at the heart of trip hop.", albumCount: 2, trackCount: 5,
    imageUrl: "/art/artist/7/poster", mbid: "art-1")
  public static let otherArtist = Artist(
    id: 8, name: "Portishead", sortName: "Portishead", genres: ["trip hop"], albumCount: 1, trackCount: 3,
    imageUrl: "/art/artist/8/poster", mbid: "art-2")
  public static let artists = [artist, otherArtist]

  static func track(_ id: Int, _ title: String, album: Int, albumTitle: String, artist: Artist, number: Int, disc: Int = 1, duration: Double, format: AudioFormat = flac) -> Track {
    Track(
      id: id, recordingId: "rec-\(id)", fileId: 9000 + id, albumId: album, artistId: artist.id, title: title,
      artistName: artist.name, albumTitle: albumTitle, trackNumber: number, discNumber: disc, duration: duration,
      explicit: false, format: format, size: 30_000_000, streamUrl: "/stream/\(9000 + id)", coverUrl: "/art/album/\(album)/cover")
  }

  public static let mezzanineTracks = [
    track(700, "Angel", album: 70, albumTitle: "Mezzanine", artist: artist, number: 1, duration: 379),
    track(701, "Risingson", album: 70, albumTitle: "Mezzanine", artist: artist, number: 2, duration: 298),
    track(703, "Inertia Creeps", album: 70, albumTitle: "Mezzanine", artist: artist, number: 4, duration: 356),
  ]
  public static let protectionTracks = [
    track(710, "Protection", album: 71, albumTitle: "Protection", artist: artist, number: 1, duration: 471),
    track(711, "Karmacoma", album: 71, albumTitle: "Protection", artist: artist, number: 2, duration: 316),
  ]
  public static let dummyTracks = [
    track(800, "Mysterons", album: 80, albumTitle: "Dummy", artist: otherArtist, number: 1, duration: 306, format: hiRes),
    track(801, "Sour Times", album: 80, albumTitle: "Dummy", artist: otherArtist, number: 2, duration: 254, format: hiRes),
    track(810, "Glory Box", album: 80, albumTitle: "Dummy", artist: otherArtist, number: 1, disc: 2, duration: 306, format: hiRes),
  ]
  public static let tracks = mezzanineTracks + protectionTracks + dummyTracks

  public static let mezzanine = AlbumDetail(
    id: 70, title: "Mezzanine", artistId: 7, artistName: "Massive Attack", year: 1998, albumType: "Album",
    secondaryTypes: [], genres: ["trip hop"], duration: 1033, trackCount: 3, totalTrackCount: 5,
    coverUrl: "/art/album/70/cover", addedAt: when, format: flac, mbid: "rg-70",
    overview: "Darker and heavier than what came before.", tracks: mezzanineTracks, discCount: 1,
    missingTracks: [
      MissingTrack(recordingId: "rec-702", title: "Teardrop", trackNumber: 3, discNumber: 1, duration: 330),
      MissingTrack(recordingId: "rec-704", title: "Exchange", trackNumber: 5, discNumber: 1, duration: 251),
    ])
  public static let protection = AlbumDetail(
    id: 71, title: "Protection", artistId: 7, artistName: "Massive Attack", year: 1994, albumType: "Album",
    secondaryTypes: [], genres: ["trip hop"], duration: 787, trackCount: 2, totalTrackCount: 2,
    coverUrl: "/art/album/71/cover", addedAt: when, format: flac, tracks: protectionTracks, discCount: 1, missingTracks: [])
  public static let dummy = AlbumDetail(
    id: 80, title: "Dummy", artistId: 8, artistName: "Portishead", year: 1994, albumType: "Album",
    secondaryTypes: [], genres: ["trip hop"], duration: 866, trackCount: 3, totalTrackCount: 3,
    coverUrl: "/art/album/80/cover", addedAt: when, format: hiRes, tracks: dummyTracks, discCount: 2, missingTracks: [])
  public static let albumDetails = [mezzanine, protection, dummy]
  public static let albums = albumDetails.map(album)

  /// An album as lists show it.
  public static func album(_ detail: AlbumDetail) -> Album {
    Album(
      id: detail.id, title: detail.title, artistId: detail.artistId, artistName: detail.artistName, year: detail.year,
      albumType: detail.albumType, secondaryTypes: detail.secondaryTypes, genres: detail.genres, duration: detail.duration,
      trackCount: detail.trackCount, totalTrackCount: detail.totalTrackCount, coverUrl: detail.coverUrl,
      addedAt: detail.addedAt, format: detail.format, mbid: detail.mbid)
  }

  public static func artistDetail(_ artist: Artist) -> ArtistDetail {
    ArtistDetail(
      id: artist.id, name: artist.name, sortName: artist.sortName, genres: artist.genres, overview: artist.overview,
      albumCount: artist.albumCount, trackCount: artist.trackCount, imageUrl: artist.imageUrl, mbid: artist.mbid,
      albums: albums.filter { $0.artistId == artist.id })
  }

  public static let lyrics = Lyrics(
    synced: [
      Lyrics.SyncedItem(at: 0, text: "You are my angel"),
      Lyrics.SyncedItem(at: 12, text: "Come from way above"),
      Lyrics.SyncedItem(at: 24, text: "To bring me love"),
    ],
    source: .lrclib)

  public static let mix = MixSummary(
    key: "vibes", kind: .vibes, title: "Your vibes", subtitle: "Massive Attack and more",
    description: "Songs you play the most at this hour", trackCount: 3, duration: 1033,
    covers: ["/art/album/70/cover"], hue: 210, generatedAt: when, refreshesAt: when)

  public static let playlist = PlaylistSummary(
    id: 1, name: "Late night", description: "For the drive home", trackCount: 2, duration: 677,
    cover: PlaylistCoverInfo(url: "/art/playlist/1?v=demo", layout: .currents, variant: 0, frozen: true, stale: false, energy: 0.4, styles: [], analyzed: 2, total: 2, pending: false),
    updatedAt: when, owner: "Demo", shared: false, mine: true)

  public static let favorite = FavoriteTrack(
    id: 701, recordingId: "rec-701", fileId: 9701, albumId: 70, artistId: 7, title: "Risingson",
    artistName: "Massive Attack", albumTitle: "Mezzanine", trackNumber: 2, discNumber: 1, duration: 298,
    explicit: false, format: flac, size: 30_000_000, streamUrl: "/stream/9701", coverUrl: "/art/album/70/cover",
    favoritedAt: when)

  public static let health = HealthStatus(
    ok: true, media: HealthStatus.Media(source: .local, ok: true),
    library: LibraryStats(artists: 2, albums: 3, tracks: 8, durationSeconds: 2686, sizeBytes: 240_000_000, refreshedAt: when),
    requests: false)

  /// What the demo server answers, by method and path (search, which depends on what's typed, is `DemoAPI`'s).
  public static var routes: [(method: HTTPMethod, path: String, answer: any Encodable & Sendable)] {
    var routes: [(method: HTTPMethod, path: String, answer: any Encodable & Sendable)] = [
      (.get, "/api/health", health),
      (.get, "/api/artists", artists),
      (.get, "/api/albums", albums),
      (.get, "/api/albums/random", albums),
      (.get, "/api/tracks/random", tracks),
      (.get, "/api/plays/recent-albums", albums),
      (.get, "/api/favorites", [favorite]),
      (.get, "/api/playlists", [playlist]),
      (.get, "/api/mixes", [mix]),
      (.get, "/api/discover/artists/art-1/similar", [DiscoverArtist(mbid: "art-2", name: "Portishead", genres: ["trip hop"], artistId: 8)]),
      (.post, "/api/radio", dummyTracks),
    ]
    for artist in artists {
      routes.append((.get, "/api/artists/\(artist.id)", artistDetail(artist)))
      routes.append((.get, "/api/artists/\(artist.id)/tracks", tracks.filter { $0.artistId == artist.id }))
    }
    for album in albumDetails { routes.append((.get, "/api/albums/\(album.id)", album)) }
    for track in tracks { routes.append((.get, "/api/tracks/\(track.id)/lyrics", ["lyrics": track.id == 700 ? lyrics : nil])) }
    return routes
  }

  /// The library's search, as the server does it (enough of it): names and titles containing what's typed.
  public static func search(_ query: String) -> SearchResults {
    let q = query.lowercased()
    let match = { (text: String) in !q.isEmpty && text.lowercased().contains(q) }
    return SearchResults(
      artists: artists.filter { match($0.name) },
      albums: albums.filter { match($0.title) || match($0.artistName) },
      tracks: tracks.filter { match($0.title) || match($0.artistName) })
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Demo/DemoAPI.swift`:

```swift
import Foundation
import PlayarrAPI

/// A server in memory answering with the demo library (`Demo`): what the UI tests browse (`-UITestsDemo`).
public struct DemoAPI: APISending {
  private let answers: [String: any Encodable & Sendable]

  public init() {
    answers = Dictionary(Demo.routes.map { ("\($0.method.rawValue) \($0.path)", $0.answer) }, uniquingKeysWith: { _, last in last })
  }

  public func send<T: Decodable & Sendable>(_ endpoint: Endpoint<T>) async throws -> T {
    let answer: any Encodable & Sendable
    if endpoint.method == .get, endpoint.path == "/api/search" {
      answer = Demo.search(endpoint.query.first { $0.name == "q" }?.value ?? "")
    } else if let known = answers["\(endpoint.method.rawValue) \(endpoint.path)"] {
      answer = known
    } else {
      throw APIError.server(status: 404, message: "Not found")
    }
    return try APIClient.decode(T.self, from: try JSONEncoder().encode(answer))
  }
}
```

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/Support/FakeAPI+Demo.swift`:

```swift
import PlayarrAPI
@testable import PlayarrUI

extension FakeAPI {
  /// A fake server that answers with the demo library (`Demo.routes`); tests change the answers they need.
  static func demoLibrary() -> FakeAPI {
    let api = FakeAPI()
    for route in Demo.routes { api.on(route.method, route.path, route.answer) }
    return api
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter DemoAPITests
```

Expected: 2 tests pass.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Demo apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/Support/FakeAPI+Demo.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/DemoAPITests.swift
git commit -F - <<'MSG'
iOS: a small demo library with a server in memory, for UI tests and view-model tests

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 5: The answer cache: stale-while-revalidate, the library kept on disk for 7 days

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Data/QueryKey.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Data/QueryCache.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/QueryCacheTests.swift`

The web keeps its React Query cache in IndexedDB for 7 days, only for the keys in `KEPT` (`apps/web/src/lib/queryClient.ts`), and not a shuffle (`queryKey[1] !== 'random'`). Two asks for the same key at once make one request.

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/QueryCacheTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Synchronization
import Testing
@testable import PlayarrUI

@MainActor @Suite struct QueryCacheTests {
  let directory = FileManager.default.temporaryDirectory.appending(path: "queries-\(UUID().uuidString)", directoryHint: .isDirectory)

  @Test func keepsTheLibraryOnDiskForTheNextLaunch() async throws {
    let first = QueryCache(directory: directory)
    _ = try await first.fetch(.albums(.artist)) { ["Mezzanine"] }
    _ = try await first.fetch(.search("mezz")) { ["Mezzanine"] }
    await first.flush()

    let next = QueryCache(directory: directory)
    #expect(next.cached(.albums(.artist), as: [String].self)?.value == ["Mezzanine"])
    // Search answers, like the web's, aren't kept between launches.
    #expect(next.cached(.search("mezz"), as: [String].self) == nil)
  }

  @Test func neverKeepsAShuffle() {
    #expect(QueryKey.albums(.added, limit: 14).isKept)
    #expect(!QueryKey.randomAlbums(seed: 0).isKept)
    #expect(!QueryKey.health.isKept)
    #expect(QueryKey.playlist(3).isKept)
  }

  @Test func forgetsWhatIsOlderThanSevenDays() async throws {
    var clock = Date(timeIntervalSince1970: 1_800_000_000)
    let first = QueryCache(directory: directory) { clock }
    _ = try await first.fetch(.artists) { ["Massive Attack"] }
    await first.flush()
    clock += QueryCache.keepFor + 1
    let later = QueryCache(directory: directory) { clock }
    #expect(later.cached(.artists, as: [String].self) == nil)
  }

  @Test func isStaleAfterItsTime() async throws {
    var clock = Date(timeIntervalSince1970: 1_800_000_000)
    let cache = QueryCache(directory: nil) { clock }
    #expect(cache.isStale(.health, after: 30))
    _ = try await cache.fetch(.health) { 1 }
    #expect(!cache.isStale(.health, after: 30))
    clock += 30
    #expect(cache.isStale(.health, after: 30))
  }

  @Test func asksOnceForTwoAsksAtTheSameTime() async throws {
    let clock = TestClock()
    let asked = Mutex(0)
    let load: @Sendable () async throws -> [String] = {
      asked.withLock { $0 += 1 }
      // The server takes a second: the second ask comes while the first waits.
      try await clock.sleep(for: .seconds(1))
      return ["Massive Attack"]
    }
    let cache = QueryCache(directory: nil)
    async let first = cache.fetch(.artists, load)
    async let second = cache.fetch(.artists, load)
    _ = await clock.nextSleep()
    clock.advance(by: .seconds(1))
    #expect(try await first == second)
    #expect(asked.withLock { $0 } == 1)
  }

  @Test func invalidatingMakesAnAnswerStale() async throws {
    let cache = QueryCache(directory: nil)
    _ = try await cache.fetch(.playlists) { [1] }
    cache.invalidate("playlists")
    #expect(cache.isStale(.playlists, after: 60))
  }

  @Test func namesFilesSafely() {
    #expect(QueryKey.album(70).fileName == "album--70.json")
    #expect(!QueryKey.search("a/b").fileName.contains("/"))
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter QueryCacheTests
```

Expected: the build fails with `cannot find 'QueryCache' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Data/QueryKey.swift`:

```swift
import Foundation
import PlayarrAPI

/// What a cached answer is, named like the web's React Query keys (apps/web/src/lib/queries.ts).
public struct QueryKey: Hashable, Sendable, CustomStringConvertible {
  public let name: String
  public let parts: [String]

  public init(_ name: String, _ parts: String...) {
    self.name = name
    self.parts = parts
  }

  /// The library data kept on disk between launches, as the web's `KEPT` (apps/web/src/lib/queryClient.ts).
  public static let keptNames: Set<String> = ["artists", "artist", "albums", "album", "favorites", "playlists", "playlist", "mixes"]

  /// Kept on disk: library data, but not a shuffle (a fresh one each visit).
  public var isKept: Bool { Self.keptNames.contains(name) && parts.first != "random" }

  public var description: String { ([name] + parts).joined(separator: "/") }

  /// A file name for the key: letters, digits and dashes as they are, anything else as hex.
  var fileName: String {
    let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_."))
    let raw = ([name] + parts).joined(separator: "--")
    let safe = raw.unicodeScalars.allSatisfy { allowed.contains($0) && $0.isASCII }
    return (safe ? raw : raw.utf8.map { String(format: "%02x", $0) }.joined()) + ".json"
  }

  public static let artists = QueryKey("artists")
  public static func artist(_ id: Int) -> QueryKey { QueryKey("artist", String(id)) }
  public static func artistTracks(_ id: Int) -> QueryKey { QueryKey("artist-tracks", String(id)) }
  public static func albums(_ sort: AlbumSort, limit: Int? = nil) -> QueryKey {
    limit.map { QueryKey("albums", sort.rawValue, String($0)) } ?? QueryKey("albums", sort.rawValue)
  }
  public static func randomAlbums(seed: Int) -> QueryKey { QueryKey("albums", "random", String(seed)) }
  public static func album(_ id: Int) -> QueryKey { QueryKey("album", String(id)) }
  public static let favorites = QueryKey("favorites")
  public static let playlists = QueryKey("playlists")
  public static func playlist(_ id: Int) -> QueryKey { QueryKey("playlist", String(id)) }
  public static let mixes = QueryKey("mixes")
  public static let health = QueryKey("health")
  public static let recentAlbums = QueryKey("recent-albums")
  public static func search(_ query: String) -> QueryKey { QueryKey("search", query) }
  public static func lyrics(_ trackId: Int) -> QueryKey { QueryKey("lyrics", String(trackId)) }
  public static func stats(_ range: String) -> QueryKey { QueryKey("stats", range) }
  public static func similarArtists(_ mbid: String) -> QueryKey { QueryKey("similar-artists", mbid) }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Data/QueryCache.swift`:

```swift
import Foundation

/// Stale-while-revalidate for the server's answers, per server and account. Answers are kept in memory; the library
/// (`QueryKey.isKept`) is also kept on disk for 7 days, so the app opens with it on screen and browses offline, as the
/// web's persisted React Query cache does. Two asks for the same key at once make one request.
@MainActor
public final class QueryCache {
  /// How long kept answers stay on disk (the web's `KEEP_FOR`).
  public static let keepFor: TimeInterval = 7 * 24 * 60 * 60
  /// After this an answer is shown but asked again (the web's default `staleTime`).
  public static let defaultStaleAfter: TimeInterval = 5 * 60

  private struct Entry {
    var value: any Sendable
    var updatedAt: Date
  }

  private var memory: [QueryKey: Entry] = [:]
  private var inFlight: [QueryKey: Task<any Sendable, any Error>] = [:]
  private var writes: [Task<Void, Never>] = []
  private let disk: QueryDisk?
  private let now: () -> Date

  /// `directory` nil keeps nothing on disk.
  public init(directory: URL?, now: @escaping () -> Date = Date.init) {
    self.disk = directory.map(QueryDisk.init)
    self.now = now
  }

  /// The answer kept for `key` and when it came, from memory or else from disk; nil if none (or older than 7 days).
  public func cached<T: Codable & Sendable>(_ key: QueryKey, as type: T.Type = T.self) -> (value: T, updatedAt: Date)? {
    if let entry = memory[key], let value = entry.value as? T { return (value, entry.updatedAt) }
    guard key.isKept, let disk, let stored = disk.read(T.self, file: key.fileName) else { return nil }
    guard now().timeIntervalSince(stored.updatedAt) < Self.keepFor else {
      disk.remove(file: key.fileName)
      return nil
    }
    memory[key] = Entry(value: stored.value, updatedAt: stored.updatedAt)
    return (stored.value, stored.updatedAt)
  }

  /// No answer yet, or it's older than `after` seconds.
  public func isStale(_ key: QueryKey, after: TimeInterval) -> Bool {
    guard let updatedAt = memory[key]?.updatedAt else { return true }
    return now().timeIntervalSince(updatedAt) >= after
  }

  /// Asks the server (once, however many ask at the same time) and keeps the answer.
  public func fetch<T: Codable & Sendable>(_ key: QueryKey, _ load: @escaping @Sendable () async throws -> T) async throws -> T {
    if let running = inFlight[key] {
      guard let value = try await running.value as? T else { throw CancellationError() }
      return value
    }
    let task = Task<any Sendable, any Error> { try await load() }
    inFlight[key] = task
    defer { inFlight[key] = nil }
    guard let value = try await task.value as? T else { throw CancellationError() }
    set(value, for: key)
    return value
  }

  /// Fetches `key` in the background when there's no answer or it's stale: a page about to be opened.
  public func prefetch<T: Codable & Sendable>(_ key: QueryKey, staleAfter: TimeInterval = defaultStaleAfter, _ load: @escaping @Sendable () async throws -> T) {
    guard cached(key, as: T.self) == nil || isStale(key, after: staleAfter), inFlight[key] == nil else { return }
    Task { _ = try? await fetch(key, load) }
  }

  /// Keeps `value` as the answer for `key` now (in memory, and on disk when kept).
  public func set<T: Codable & Sendable>(_ value: T, for key: QueryKey) {
    let updatedAt = now()
    memory[key] = Entry(value: value, updatedAt: updatedAt)
    guard key.isKept, let disk else { return }
    let file = key.fileName
    writes.append(Task.detached { await disk.write(value, updatedAt: updatedAt, file: file) })
  }

  /// Every answer named `name` is asked again the next time it's shown.
  public func invalidate(_ name: String) {
    for key in memory.keys where key.name == name { memory[key]?.updatedAt = .distantPast }
  }

  /// Waits for answers being written to disk (tests, and before the app is closed).
  public func flush() async {
    let pending = writes
    writes = []
    for write in pending { await write.value }
  }

  /// Deletes answers kept on disk for more than 7 days.
  public func removeExpired() async {
    await disk?.removeOlder(than: now().addingTimeInterval(-Self.keepFor))
  }
}

/// The disk side of `QueryCache`: one JSON file per kept key, `{ updatedAt, value }`.
actor QueryDisk {
  private struct Stored<T: Codable>: Codable {
    var updatedAt: Date
    var value: T
  }

  nonisolated let directory: URL

  init(directory: URL) {
    self.directory = directory
  }

  nonisolated func read<T: Codable>(_ type: T.Type, file: String) -> (value: T, updatedAt: Date)? {
    guard let data = try? Data(contentsOf: directory.appending(path: file)),
      let stored = try? JSONDecoder().decode(Stored<T>.self, from: data)
    else { return nil }
    return (stored.value, stored.updatedAt)
  }

  nonisolated func remove(file: String) {
    try? FileManager.default.removeItem(at: directory.appending(path: file))
  }

  func write<T: Codable & Sendable>(_ value: T, updatedAt: Date, file: String) {
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      try JSONEncoder().encode(Stored(updatedAt: updatedAt, value: value)).write(to: directory.appending(path: file), options: .atomic)
    } catch {
      // A full disk loses the copy, not the answer: it's still in memory.
    }
  }

  func removeOlder(than date: Date) {
    let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
    for file in files {
      let modified = (try? file.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
      if modified < date { try? FileManager.default.removeItem(at: file) }
    }
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter QueryCacheTests
```

Expected: 7 tests pass.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Data/QueryKey.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Data/QueryCache.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/QueryCacheTests.swift
git commit -F - <<'MSG'
iOS: cache the server's answers per account, keeping the library on disk for 7 days like the web

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 6: One answer a screen shows: cached at once, then the server's

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Data/Query.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/QueryTests.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/QueryTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct QueryTests {
  @Test func showsWhatIsCachedThenTheServersAnswer() async throws {
    let cache = QueryCache(directory: nil)
    cache.set(["old"], for: .artists)
    let query = Query(.artists, cache: cache, staleAfter: 0) { ["new"] }
    #expect(query.value == ["old"])
    await query.load()
    #expect(query.value == ["new"])
  }

  @Test func doesntAskAgainWhileFresh() async throws {
    let api = FakeAPI()
    api.on(.get, "/api/artists", [Demo.artist])
    let cache = QueryCache(directory: nil)
    let query = Query(.artists, cache: cache) { try await api.send(API.Library.artists()) }
    await query.load()
    await query.load()
    #expect(api.calls.count == 1)
  }

  @Test func keepsWhatIsShownWhenTheServerCantBeReached() async throws {
    let api = FakeAPI()
    api.fail(.get, "/api/artists", status: 503, "Server busy")
    let cache = QueryCache(directory: nil)
    cache.set([Demo.artist], for: .artists)
    let query = Query(.artists, cache: cache, staleAfter: 0) { try await api.send(API.Library.artists()) }
    await query.load()
    #expect(query.value == [Demo.artist])
    #expect(query.error == nil)
  }

  @Test func explainsAFailureWithNothingToShow() async throws {
    let api = FakeAPI()
    api.fail(.get, "/api/artists", status: 503, "Server busy")
    let query = Query(.artists, cache: QueryCache(directory: nil)) { try await api.send(API.Library.artists()) }
    await query.load()
    #expect(query.value == nil)
    #expect(query.error == "Server busy")
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter QueryTests
```

Expected: the build fails with `cannot find 'Query' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Data/Query.swift`:

```swift
import Foundation
import Observation

/// One answer a screen shows: what's cached at once, then the server's when that was missing or stale. A failed ask
/// keeps what's on screen; `error` is set only when there's nothing to show.
@MainActor @Observable
public final class Query<Value: Codable & Sendable> {
  public private(set) var value: Value?
  public private(set) var error: String?
  public private(set) var isFetching = false

  @ObservationIgnored public let key: QueryKey
  @ObservationIgnored private let cache: QueryCache
  @ObservationIgnored private let staleAfter: TimeInterval
  @ObservationIgnored private let fetcher: @Sendable () async throws -> Value

  public init(_ key: QueryKey, cache: QueryCache, staleAfter: TimeInterval = QueryCache.defaultStaleAfter, fetch: @escaping @Sendable () async throws -> Value) {
    self.key = key
    self.cache = cache
    self.staleAfter = staleAfter
    self.fetcher = fetch
    value = cache.cached(key, as: Value.self)?.value
  }

  /// Nothing to show yet, and no error either.
  public var isPending: Bool { value == nil && error == nil }

  /// Asks the server when there's no answer or it's stale.
  public func load() async {
    guard value == nil || cache.isStale(key, after: staleAfter) else { return }
    await refresh()
  }

  /// Asks the server now (pull to refresh, Try again).
  public func refresh() async {
    isFetching = true
    defer { isFetching = false }
    do {
      value = try await cache.fetch(key, fetcher)
      error = nil
    } catch is CancellationError {
      // The screen went away.
    } catch {
      if value == nil { self.error = error.localizedDescription }
    }
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter QueryTests
```

Expected: 4 tests pass.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Data/Query.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/QueryTests.swift
git commit -F - <<'MSG'
iOS: screens show what's cached at once and ask the server when it's stale, keeping it on screen offline

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 7: The image cache: the server's sizes, the token in the header, on disk

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Data/ImageCache.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/ImageCacheTests.swift`
- Modify: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/AddServerModelTests.swift` (`FakeServer` fails a host without a handler as unreachable instead of crashing)

The tests use phase 2's `FakeServer` (in `AddServerModelTests.swift`): its handler answers `(status, body)` per host. Since this plan was written, `ServerRecord` gained a `localURL` (the home-network address) and `MediaURLs.onLocalAddress(_:)`: like `APIClient`, the image cache tries the home address when the public one can't be reached (implemented with Task 7). For that test, `FakeServer.startLoading` answers a host it has no handler for with `URLError(.cannotFindHost)` instead of force-unwrapping a missing handler.

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/ImageCacheTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Synchronization
import Testing
@testable import PlayarrUI

@Suite struct ImageCacheTests {
  let host = "img-\(UUID().uuidString.lowercased()).invalid"
  let directory = FileManager.default.temporaryDirectory.appending(path: "images-\(UUID().uuidString)", directoryHint: .isDirectory)

  func cache(_ handler: @escaping FakeServer.Handler) -> ImageCache {
    let media = MediaURLs(baseURL: URL(string: "http://\(host)")!, token: "tok")
    return ImageCache(directory: directory, media: media, session: FakeServer.session(host: host, handler), retryDelay: .zero)
  }

  @Test func asksForTheSizesTheServerMakes() {
    #expect(ImageCache.pixels(points: 44, scale: 3) == 160)
    #expect(ImageCache.pixels(points: 160, scale: 2) == 320)
    #expect(ImageCache.pixels(points: 320, scale: 3) == 960)
    #expect(ImageCache.pixels(points: 600, scale: 3) == 1200)
  }

  @Test func sendsTheTokenAndKeepsTheImageOnDisk() async {
    let asked = Mutex<[String]>([])
    let images = cache { request in
      asked.withLock { $0.append("\(request.url!.path())?\(request.url!.query() ?? "") \(request.value(forHTTPHeaderField: "Authorization") ?? "")") }
      return (200, "jpeg bytes")
    }
    #expect(await images.data("/art/album/70/cover", size: 320) == Data("jpeg bytes".utf8))
    #expect(asked.withLock { $0 } == ["/art/album/70/cover?size=320 Bearer tok"])

    // A new cache (the next launch) finds it on disk without asking.
    let next = cache { _ in (500, "") }
    #expect(await next.data("/art/album/70/cover", size: 320) == Data("jpeg bytes".utf8))
  }

  @Test func triesOnceMoreAfterAFailure() async {
    let asked = Mutex(0)
    let images = cache { request in
      asked.withLock { $0 += 1 }
      return request.url!.query()!.contains("retry=1") ? (200, "second time") : (503, "")
    }
    #expect(await images.data("/art/album/70/cover", size: 96) == Data("second time".utf8))
    #expect(asked.withLock { $0 } == 2)
  }

  @Test func givesUpAfterTheRetry() async {
    let images = cache { _ in (404, "") }
    #expect(await images.data("/art/album/70/cover", size: 96) == nil)
    #expect(await images.data(nil, size: 96) == nil)
  }

  @Test func prunesWhatWasntUsedFor60Days() async throws {
    let images = cache { _ in (200, "bytes") }
    _ = await images.data("/art/album/70/cover", size: 96)
    await images.prune(now: Date().addingTimeInterval(ImageCache.maxAge + 60))
    #expect(try FileManager.default.contentsOfDirectory(atPath: directory.path).isEmpty)
  }

  @Test func triesTheHomeAddressWhenThePublicOneCantBeReached() async {
    let home = "home-\(UUID().uuidString.lowercased()).invalid"
    // The public host has no handler: FakeServer fails it as an unreachable host.
    let session = FakeServer.session(host: home) { request in (200, "from home \(request.value(forHTTPHeaderField: "Authorization") ?? "")") }
    let media = MediaURLs(baseURL: URL(string: "https://\(host)")!, localURL: URL(string: "http://\(home)")!, token: "tok")
    let images = ImageCache(directory: directory, media: media, session: session, retryDelay: .zero)
    #expect(await images.data("/art/album/70/cover", size: 96) == Data("from home Bearer tok".utf8))
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter ImageCacheTests
```

Expected: the build fails with `cannot find 'ImageCache' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Data/ImageCache.swift`:

```swift
import CryptoKit
import Foundation
import PlayarrAPI

/// Covers and artist photos, per server and account: in memory, on disk, else from the server at one of the sizes it
/// makes (`apps/server/src/routes/art.ts` snaps every `?size=` to these), with the token in the header. A failed
/// image is asked once more after 1.5 s with `&retry=1`, as the web's `Cover` does. When the server's public address
/// can't be reached, its home-network one is tried (`MediaURLs.onLocalAddress`), as `APIClient` does.
public actor ImageCache {
  /// The sizes the server makes (px); asking for one of them hits its cache, and ours.
  public static let sizes = [96, 160, 240, 320, 480, 640, 960, 1200]
  /// Kept for 60 days, at most 1500 images (the web's service worker keeps art the same way).
  public static let maxAge: TimeInterval = 60 * 24 * 60 * 60
  public static let maxFiles = 1500

  /// The size to ask for an image shown `points` wide on a screen of `scale`.
  public static func pixels(points: Double, scale: Double) -> Int {
    let wanted = Int((points * min(max(scale, 1), 3)).rounded(.up))
    return sizes.first { $0 >= wanted } ?? sizes[sizes.count - 1]
  }

  private let directory: URL
  private let media: MediaURLs
  private let session: URLSession
  private let retryDelay: Duration
  private let memory = NSCache<NSURL, NSData>()
  private var inFlight: [URL: Task<Data?, Never>] = [:]

  public init(directory: URL, media: MediaURLs, session: URLSession = .shared, retryDelay: Duration = .milliseconds(1500)) {
    self.directory = directory
    self.media = media
    self.session = session
    self.retryDelay = retryDelay
    memory.totalCostLimit = 64 * 1024 * 1024
  }

  /// The address of `path` (a `coverUrl`, `imageUrl`…) at `size` px; nil without a path.
  public nonisolated func url(_ path: String?, size: Int) -> URL? { media.art(path, size: size) }

  /// The image's bytes (JPEG, PNG or WebP), or nil if there's none or it can't be had.
  public func data(_ path: String?, size: Int) async -> Data? {
    guard let url = url(path, size: size) else { return nil }
    return await data(for: url)
  }

  public func data(for url: URL) async -> Data? {
    if let hit = memory.object(forKey: url as NSURL) { return hit as Data }
    let file = self.file(for: url)
    if let data = try? Data(contentsOf: file) {
      try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: file.path)
      remember(data, for: url)
      return data
    }
    if let running = inFlight[url] { return await running.value }
    let task = Task { await download(url) }
    inFlight[url] = task
    let data = await task.value
    inFlight[url] = nil
    if let data {
      remember(data, for: url)
      try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      try? data.write(to: file, options: .atomic)
    }
    return data
  }

  /// Fetches images about to be shown.
  public func prefetch(_ paths: [String?], size: Int) {
    for path in paths {
      guard let url = url(path, size: size), memory.object(forKey: url as NSURL) == nil else { continue }
      Task { _ = await data(for: url) }
    }
  }

  /// Drops images unused for 60 days, then the least recently used beyond 1500.
  public func prune(now: Date = Date()) {
    let key = URLResourceKey.contentModificationDateKey
    let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [key])) ?? []
    let dated = files.map { ($0, (try? $0.resourceValues(forKeys: [key]))?.contentModificationDate ?? .distantPast) }
      .sorted { $0.1 > $1.1 }
    for (index, (file, modified)) in dated.enumerated() where index >= Self.maxFiles || now.timeIntervalSince(modified) > Self.maxAge {
      try? FileManager.default.removeItem(at: file)
    }
  }

  private func download(_ url: URL) async -> Data? {
    if let data = await get(url) { return data }
    try? await Task.sleep(for: retryDelay)
    guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
    components.queryItems = (components.queryItems ?? []) + [URLQueryItem(name: "retry", value: "1")]
    guard let retry = components.url else { return nil }
    return await get(retry)
  }

  private func get(_ url: URL) async -> Data? {
    let answer: (Data, URLResponse)
    do {
      answer = try await session.data(for: media.request(for: url))
    } catch {
      // The public address can't be reached (at home, behind a router that doesn't loop back): the home one.
      guard let local = media.onLocalAddress(url), let fromHome = try? await session.data(for: media.request(for: local)) else { return nil }
      answer = fromHome
    }
    guard (answer.1 as? HTTPURLResponse)?.statusCode == 200, !answer.0.isEmpty else { return nil }
    return answer.0
  }

  private func remember(_ data: Data, for url: URL) {
    memory.setObject(data as NSData, forKey: url as NSURL, cost: data.count)
  }

  private func file(for url: URL) -> URL {
    let digest = SHA256.hash(data: Data(url.absoluteString.utf8)).map { String(format: "%02x", $0) }.joined()
    return directory.appending(path: digest)
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter ImageCacheTests
```

Expected: 6 tests pass.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Data/ImageCache.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/ImageCacheTests.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/AddServerModelTests.swift docs/plans/2026-11-03-ios-phase4-browse-now-playing.md
git commit -F - <<'MSG'
iOS: keep covers on disk per account, asking for the sizes the server makes, with one retry like the web

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 8: The accent colour from album art, with the web's algorithm

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Theme/RGB.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Theme/AccentColor.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Theme/OKLCH.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/AccentColorTests.swift`

`OKLCH` is for mix covers: the server gives each mix an OKLCH hue, and `apps/web/src/components/Mixes.tsx` paints `oklch(0.32 0.09 h)` under the covers.

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/AccentColorTests.swift`:

```swift
import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers
@testable import PlayarrUI

@Suite struct AccentColorTests {
  /// 32×32 pixels: `count` of `color`, the rest `rest`.
  func pixels(_ color: (UInt8, UInt8, UInt8), count: Int = 1024, rest: (UInt8, UInt8, UInt8) = (0, 0, 0)) -> [UInt8] {
    (0..<1024).flatMap { i -> [UInt8] in
      let c = i < count ? color : rest
      return [c.0, c.1, c.2, 255]
    }
  }

  @Test func clampsAVividColourForADarkScreen() {
    // Pure red: hue 0, saturation 1 → clamped to 90 %, lightness 0.5 → 56 %.
    #expect(AccentColor.extract(rgba: pixels((255, 0, 0))) == .init(h: 0, s: 90, l: 56))
    #expect(AccentColor.extract(rgba: pixels((0, 0, 255))) == .init(h: 240, s: 90, l: 56))
  }

  @Test func ignoresNearBlackAndNearWhite() {
    #expect(AccentColor.extract(rgba: pixels((0, 0, 0))) == nil)
    #expect(AccentColor.extract(rgba: pixels((250, 250, 250))) == nil)
  }

  @Test func theMostColourfulHueWinsOverMoreGrey() {
    // A quarter of the cover is teal; the rest is mid grey (weight 0.001 per pixel).
    let mixed = pixels((0, 160, 160), count: 256, rest: (128, 128, 128))
    #expect(AccentColor.extract(rgba: mixed)?.h == 180)
  }

  @Test func needsEnoughColourToChoose() {
    // Two dark-ish blue pixels weigh less than the 0.5 the web asks for.
    #expect(AccentColor.extract(rgba: pixels((10, 10, 60), count: 2, rest: (0, 0, 0))) == nil)
  }

  @Test func turnsHSLIntoRGB() {
    let rgb = AccentColor.HSL(h: 0, s: 90, l: 56).rgb
    #expect(abs(rgb.r - 0.956) < 0.001)
    #expect(abs(rgb.g - 0.164) < 0.001)
    #expect(abs(rgb.b - 0.164) < 0.001)
  }

  @Test func readsAnImageFile() throws {
    let data = try png(width: 64, height: 64, rgb: (40, 200, 90))
    let accent = try #require(AccentColor.extract(imageData: data))
    #expect((130...145).contains(accent.h))
  }

  @Test func turnsOKLCHIntoRGB() {
    // oklch(62.8% 0.2577 29.23) is sRGB red.
    let red = OKLCH.rgb(l: 0.628, c: 0.2577, h: 29.23)
    #expect(abs(red.r - 1) < 0.01 && red.g < 0.02 && red.b < 0.02)
  }

  func png(width: Int, height: Int, rgb: (UInt8, UInt8, UInt8)) throws -> Data {
    var bytes = [UInt8](repeating: 255, count: width * height * 4)
    for i in stride(from: 0, to: bytes.count, by: 4) { (bytes[i], bytes[i + 1], bytes[i + 2]) = rgb }
    let space = try #require(CGColorSpace(name: CGColorSpace.sRGB))
    let context = try #require(CGContext(data: &bytes, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
    let image = try #require(context.makeImage())
    let out = NSMutableData()
    let destination = try #require(CGImageDestinationCreateWithData(out, UTType.png.identifier as CFString, 1, nil))
    CGImageDestinationAddImage(destination, image, nil)
    #expect(CGImageDestinationFinalize(destination))
    return out as Data
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter AccentColorTests
```

Expected: the build fails with `cannot find 'AccentColor' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Theme/RGB.swift`:

```swift
import SwiftUI

/// A colour as red, green and blue from 0 to 1 (sRGB).
public struct RGB: Hashable, Sendable {
  public var r: Double
  public var g: Double
  public var b: Double

  public init(r: Double, g: Double, b: Double) {
    self.r = r
    self.g = g
    self.b = b
  }

  /// `0xff7a1a`.
  public init(hex: UInt32) {
    self.init(r: Double((hex >> 16) & 0xff) / 255, g: Double((hex >> 8) & 0xff) / 255, b: Double(hex & 0xff) / 255)
  }

  public var color: Color { Color(.sRGB, red: r, green: g, blue: b) }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Theme/AccentColor.swift`:

```swift
import CoreGraphics
import Foundation
import ImageIO

/// The accent colour taken from album art, as apps/web/src/lib/color.ts does it: the cover drawn at 32×32, its
/// pixels sorted into 12 hue bins weighted by saturation and mid-lightness (near-black and near-white dropped),
/// the heaviest bin's average hue, with saturation clamped to 45–90 % and lightness to 56–68 %.
public enum AccentColor {
  /// A colour as hue (degrees), saturation and lightness (percent), rounded as the web's `hsl()` string.
  public struct HSL: Hashable, Sendable {
    public var h: Int
    public var s: Int
    public var l: Int

    public init(h: Int, s: Int, l: Int) {
      self.h = h
      self.s = s
      self.l = l
    }

    public var rgb: RGB {
      let s = Double(self.s) / 100
      let l = Double(self.l) / 100
      let c = (1 - abs(2 * l - 1)) * s
      let hue = Double(h).truncatingRemainder(dividingBy: 360) / 60
      let x = c * (1 - abs(hue.truncatingRemainder(dividingBy: 2) - 1))
      let (r, g, b): (Double, Double, Double) =
        switch hue {
        case ..<1: (c, x, 0)
        case ..<2: (x, c, 0)
        case ..<3: (0, c, x)
        case ..<4: (0, x, c)
        case ..<5: (x, 0, c)
        default: (c, 0, x)
        }
      let m = l - c / 2
      return RGB(r: r + m, g: g + m, b: b + m)
    }
  }

  static let side = 32

  /// The accent of 32×32 RGBA pixels (8 bits each), or nil when nothing in them is colourful enough.
  public static func extract(rgba: [UInt8]) -> HSL? {
    var buckets = [(w: Double, h: Double, s: Double, l: Double)](repeating: (0, 0, 0, 0), count: 12)
    for i in stride(from: 0, to: rgba.count - 3, by: 4) {
      let (h, s, l) = hsl(rgba[i], rgba[i + 1], rgba[i + 2])
      // Favour saturated mid-tones; ignore near-black and near-white pixels.
      let weight = s * s * (1 - abs(l - 0.5) * 2) + 0.001
      if l < 0.08 || l > 0.95 { continue }
      let b = Int((h * 12).rounded(.down)) % 12
      buckets[b].w += weight
      buckets[b].h += h * weight
      buckets[b].s += s * weight
      buckets[b].l += l * weight
    }
    let best = buckets.reduce(buckets[0]) { $1.w > $0.w ? $1 : $0 }
    guard best.w >= 0.5 else { return nil }
    let h = best.h / best.w
    let s = min(0.9, max(0.45, best.s / best.w))
    let l = min(0.68, max(0.56, best.l / best.w))
    return HSL(h: Int((h * 360).rounded()), s: Int((s * 100).rounded()), l: Int((l * 100).rounded()))
  }

  /// The accent of an image (JPEG, PNG or WebP bytes), drawn at 32×32 as the web draws it on a canvas.
  public static func extract(imageData: Data) -> HSL? {
    guard let source = CGImageSourceCreateWithData(imageData as CFData, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
      let space = CGColorSpace(name: CGColorSpace.sRGB)
    else { return nil }
    var pixels = [UInt8](repeating: 0, count: side * side * 4)
    let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
      guard let context = CGContext(
        data: buffer.baseAddress, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side * 4, space: space,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
      else { return false }
      context.interpolationQuality = .medium
      context.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))
      return true
    }
    return drawn ? extract(rgba: pixels) : nil
  }

  /// Hue (0–1), saturation and lightness of an 8-bit colour, as the web's `rgbToHsl`.
  static func hsl(_ r8: UInt8, _ g8: UInt8, _ b8: UInt8) -> (Double, Double, Double) {
    let r = Double(r8) / 255
    let g = Double(g8) / 255
    let b = Double(b8) / 255
    let high = max(r, g, b)
    let low = min(r, g, b)
    let l = (high + low) / 2
    if high == low { return (0, 0, l) }
    let d = high - low
    let s = l > 0.5 ? d / (2 - high - low) : d / (high + low)
    let h: Double =
      if high == r { (g - b) / d + (g < b ? 6 : 0) } else if high == g { (b - r) / d + 2 } else { (r - g) / d + 4 }
    return (h / 6, s, l)
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Theme/OKLCH.swift`:

```swift
import Foundation

/// CSS `oklch(l c h)` to sRGB, for mix covers: the server gives each mix a hue (apps/web/src/components/Mixes.tsx).
public enum OKLCH {
  public static func rgb(l: Double, c: Double, h: Double) -> RGB {
    let a = c * cos(h * .pi / 180)
    let b = c * sin(h * .pi / 180)
    let l1 = pow(l + 0.3963377774 * a + 0.2158037573 * b, 3)
    let m1 = pow(l - 0.1055613458 * a - 0.0638541728 * b, 3)
    let s1 = pow(l - 0.0894841775 * a - 1.2914855480 * b, 3)
    let red = 4.0767416621 * l1 - 3.3077115913 * m1 + 0.2309699292 * s1
    let green = -1.2684380046 * l1 + 2.6097574011 * m1 - 0.3413193965 * s1
    let blue = -0.0041960863 * l1 - 0.7034186147 * m1 + 1.7076147010 * s1
    return RGB(r: gamma(red), g: gamma(green), b: gamma(blue))
  }

  /// Linear light to sRGB, clipped to what a screen shows.
  static func gamma(_ x: Double) -> Double {
    let v = x <= 0.0031308 ? 12.92 * x : 1.055 * pow(x, 1 / 2.4) - 0.055
    return min(1, max(0, v))
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter AccentColorTests
```

Expected: 7 tests pass.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Theme/RGB.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Theme/AccentColor.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Theme/OKLCH.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/AccentColorTests.swift
git commit -F - <<'MSG'
iOS: take the accent colour from album art with the web's algorithm, and paint mix colours from OKLCH

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 9: Settings → Appearance on the device, and the theme

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Theme/AppearanceSettings.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Theme/Theme.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/ThemeTests.swift`

As `PlaybackSettings` keeps `playback.*` in UserDefaults, `AppearanceSettings` keeps `appearance.accent` (`album` or one of the web's six colours as hex), `appearance.motion`, `appearance.formatBadges` and `appearance.statsForNerds` (the overlay is phase 5's), with the web's defaults (`apps/web/src/lib/prefs.ts`).

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/ThemeTests.swift`:

```swift
import Foundation
import Testing
@testable import PlayarrUI

@MainActor @Suite struct ThemeTests {
  func settings() -> AppearanceSettings { AppearanceSettings(defaults: UserDefaults(suiteName: UUID().uuidString)!) }

  @Test func followsTheCoverUnlessAColourIsChosen() async {
    let appearance = settings()
    let theme = Theme(appearance: appearance)
    #expect(theme.accent == Theme.defaultAccent)
    appearance.accent = .fixed(.sky)
    #expect(theme.accent == RGB(hex: 0x38bdf8))
  }

  @Test func remembersTheChoices() {
    let defaults = UserDefaults(suiteName: UUID().uuidString)!
    let first = AppearanceSettings(defaults: defaults)
    first.accent = .fixed(.violet)
    first.motion = .reduce
    first.formatBadges = false
    let again = AppearanceSettings(defaults: defaults)
    #expect(again.accent == .fixed(.violet))
    #expect(again.motion == .reduce)
    #expect(!again.formatBadges)
    #expect(!again.statsForNerds)
  }

  @Test func motionFollowsTheDeviceOnlyOnSystem() {
    let appearance = settings()
    #expect(appearance.reduceMotion(system: true))
    appearance.motion = .full
    #expect(!appearance.reduceMotion(system: true))
    appearance.motion = .reduce
    #expect(appearance.reduceMotion(system: false))
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter ThemeTests
```

Expected: the build fails with `cannot find 'AppearanceSettings' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Theme/AppearanceSettings.swift`:

```swift
import Foundation
import Observation

/// Settings → Appearance, per device as on the web (apps/web/src/lib/prefs.ts), kept in UserDefaults.
@MainActor @Observable
public final class AppearanceSettings {
  /// The fixed accent colours; the first is Playarr's own orange.
  public enum Fixed: String, Sendable, CaseIterable {
    case orange = "#ff7a1a"
    case rose = "#f43f5e"
    case violet = "#a78bfa"
    case sky = "#38bdf8"
    case green = "#34d399"
    case yellow = "#facc15"

    public var name: String {
      switch self {
      case .orange: "Orange"
      case .rose: "Rose"
      case .violet: "Violet"
      case .sky: "Sky"
      case .green: "Green"
      case .yellow: "Yellow"
      }
    }

    public var rgb: RGB { RGB(hex: UInt32(rawValue.dropFirst(), radix: 16) ?? 0xff7a1a) }
  }

  public enum Accent: Hashable, Sendable {
    case album
    case fixed(Fixed)

    public static let all: [Accent] = [.album] + Fixed.allCases.map(Accent.fixed)

    public var name: String {
      switch self {
      case .album: "From the album art"
      case .fixed(let color): color.name
      }
    }

    var stored: String {
      switch self {
      case .album: "album"
      case .fixed(let color): color.rawValue
      }
    }

    init(stored: String?) {
      self = stored.flatMap(Fixed.init).map(Accent.fixed) ?? .album
    }
  }

  public enum Motion: String, Sendable, CaseIterable {
    case system, reduce, full

    public var label: String {
      switch self {
      case .system: "System"
      case .reduce: "Reduced"
      case .full: "Full"
      }
    }
  }

  public var accent: Accent { didSet { defaults.set(accent.stored, forKey: Key.accent) } }
  public var motion: Motion { didSet { defaults.set(motion.rawValue, forKey: Key.motion) } }
  /// "Show audio format badges".
  public var formatBadges: Bool { didSet { defaults.set(formatBadges, forKey: Key.formatBadges) } }
  /// "Stats for nerds": the overlay itself comes in phase 5.
  public var statsForNerds: Bool { didSet { defaults.set(statsForNerds, forKey: Key.statsForNerds) } }

  @ObservationIgnored private let defaults: UserDefaults

  private enum Key {
    static let accent = "appearance.accent"
    static let motion = "appearance.motion"
    static let formatBadges = "appearance.formatBadges"
    static let statsForNerds = "appearance.statsForNerds"
  }

  public init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    accent = Accent(stored: defaults.string(forKey: Key.accent))
    motion = defaults.string(forKey: Key.motion).flatMap(Motion.init) ?? .system
    formatBadges = defaults.object(forKey: Key.formatBadges) as? Bool ?? true
    statsForNerds = defaults.object(forKey: Key.statsForNerds) as? Bool ?? false
  }

  /// Whether to keep animations to a minimum, given the device's own setting.
  public func reduceMotion(system: Bool) -> Bool {
    switch motion {
    case .system: system
    case .reduce: true
    case .full: false
    }
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Theme/Theme.swift`:

```swift
import Foundation
import Observation
import SwiftUI

/// The accent colour: Playarr's orange, a fixed colour, or (by default) one taken from the cover of the song playing,
/// with the web's algorithm (`AccentColor`). Album pages tint their header with their own cover's colour.
@MainActor @Observable
public final class Theme {
  /// Playarr's orange, when a cover has no colour to give.
  public static let defaultAccent = RGB(hex: 0xff7a1a)
  /// Covers are read at this size (px), as the web reads them at 96.
  public static let sampleSize = 96

  public let appearance: AppearanceSettings
  /// The colour of the cover playing, when it has one.
  public private(set) var coverAccent: RGB?

  @ObservationIgnored private var known: [String: RGB?] = [:]
  @ObservationIgnored private var following: String?

  public init(appearance: AppearanceSettings) {
    self.appearance = appearance
  }

  /// The accent to use now.
  public var accent: RGB {
    switch appearance.accent {
    case .album: coverAccent ?? Self.defaultAccent
    case .fixed(let color): color.rgb
    }
  }

  /// Follows the song playing: its cover's colour becomes the accent.
  public func follow(cover path: String?, images: ImageCache?) async {
    following = path
    let color = await accent(of: path, images: images)
    if following == path { coverAccent = color }
  }

  /// The colour of a cover (nil when it has none), read once per cover.
  public func accent(of path: String?, images: ImageCache?) async -> RGB? {
    guard let path else { return nil }
    if let seen = known[path] { return seen }
    guard let images, let data = await images.data(path, size: Self.sampleSize) else { return nil }
    let color = await Task.detached { AccentColor.extract(imageData: data)?.rgb }.value
    known[path] = color
    return color
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter ThemeTests
```

Expected: 3 tests pass.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Theme/AppearanceSettings.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Theme/Theme.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/ThemeTests.swift
git commit -F - <<'MSG'
iOS: Settings → Appearance kept on the device, and an accent that follows the song playing

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 10: Toasts

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/ToastCenter.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/ToastCenterTests.swift`

The web's `apps/web/src/lib/toast.ts`: a repeated message shows once, three at most, gone after 3.5 s (7 s for an error); one with a button (Undo) stays until used. The timeouts sleep on an injected clock, so tests follow them with `TestClock`.

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/ToastCenterTests.swift`:

```swift
import Foundation
import Testing
@testable import PlayarrUI

@MainActor @Suite struct ToastCenterTests {
  @Test func showsAMessageOnceAndOnlyThreeAtATime() {
    let toasts = ToastCenter(clock: TestClock())
    toasts.push("Playing 1 track next")
    toasts.push("Playing 1 track next")
    #expect(toasts.toasts.count == 1)
    for n in 2...4 { toasts.push("Added \(n) tracks to queue") }
    #expect(toasts.toasts.map(\.message) == ["Added 2 tracks to queue", "Added 3 tracks to queue", "Added 4 tracks to queue"])
  }

  @Test func goesAfterThreeAndAHalfSeconds() async {
    let clock = TestClock()
    let toasts = ToastCenter(clock: clock)
    toasts.push("Sleep timer: music stopped")
    #expect(await clock.nextSleep() == .milliseconds(3500))
    clock.advance(by: .milliseconds(3500))
    while !toasts.toasts.isEmpty { await Task.yield() }
    #expect(toasts.toasts.isEmpty)
  }

  @Test func anErrorStaysSevenSeconds() async {
    let clock = TestClock()
    let toasts = ToastCenter(clock: clock)
    toasts.push("Cannot reach the Playarr server", tone: .error)
    #expect(await clock.nextSleep() == .seconds(7))
  }

  @Test func aToastWithAButtonStaysUntilUsed() {
    let clock = TestClock()
    let toasts = ToastCenter(clock: clock)
    var undone = false
    toasts.push("Cleared 3 tracks", action: .init("Undo") { undone = true })
    #expect(clock.pendingSleep == nil)
    toasts.perform(toasts.toasts[0])
    #expect(undone)
    #expect(toasts.toasts.isEmpty)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter ToastCenterTests
```

Expected: the build fails with `cannot find 'ToastCenter' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/ToastCenter.swift`:

```swift
import Foundation
import Observation

/// Short messages at the top of the screen, as the web's toasts (apps/web/src/lib/toast.ts): the same message twice
/// shows once, at most three at a time, gone after 3.5 s (7 s for errors). A toast with a button (Undo) stays until
/// the button is used or it's dismissed.
@MainActor @Observable
public final class ToastCenter {
  public enum Tone: Sendable { case info, error }

  public struct Action {
    public let label: String
    public let run: @MainActor () -> Void

    public init(_ label: String, run: @escaping @MainActor () -> Void) {
      self.label = label
      self.run = run
    }
  }

  public struct Toast: Identifiable {
    public let id: Int
    public let message: String
    public let tone: Tone
    public let action: Action?
  }

  public static let infoTime: Duration = .milliseconds(3500)
  public static let errorTime: Duration = .seconds(7)

  public private(set) var toasts: [Toast] = []

  @ObservationIgnored private var nextId = 1
  @ObservationIgnored private let clock: any Clock<Duration>

  public init(clock: any Clock<Duration> = ContinuousClock()) {
    self.clock = clock
  }

  public func push(_ message: String, tone: Tone = .info, action: Action? = nil) {
    // Every song failing for the same reason says so once.
    guard !toasts.contains(where: { $0.message == message }) else { return }
    let id = nextId
    nextId += 1
    toasts = Array((toasts + [Toast(id: id, message: message, tone: tone, action: action)]).suffix(3))
    guard action == nil else { return }
    let wait = tone == .error ? Self.errorTime : Self.infoTime
    Task { [clock, weak self] in
      try? await clock.sleep(for: wait)
      self?.dismiss(id)
    }
  }

  public func dismiss(_ id: Int) {
    toasts.removeAll { $0.id == id }
  }

  /// The toast's button: dismiss it and do what it says.
  public func perform(_ toast: Toast) {
    dismiss(toast.id)
    toast.action?.run()
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter ToastCenterTests
```

Expected: 4 tests pass.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/ToastCenter.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/ToastCenterTests.swift
git commit -F - <<'MSG'
iOS: toasts as the web's: one of each message, three at most, Undo stays until used

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 11: Pages as values, tabs and the router

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/Route.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/AppTab.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/AppRouter.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/SettingsPanel.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/RouterTests.swift`

`Route(href:)` reads the web's paths, because "Playing from" sources carry them (`/albums/70`, `/artists/7`, `/albums` for "Your whole library", `/favorites`, `/mixes/<key>`, `/playlists/<id>`), and so do links between pages. Settings' panels are routes too, so every push in a tab's stack is a value (no view-destination links in a typed path).

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/RouterTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct RouterTests {
  @Test func readsTheWebsPaths() {
    #expect(Route(href: "/albums/70") == .album(70))
    #expect(Route(href: "/artists/7") == .artist(7))
    #expect(Route(href: "/albums") == .albums(.artist))
    #expect(Route(href: "/albums?sort=added") == .albums(.added))
    #expect(Route(href: "/playlists/3") == .playlist(3))
    #expect(Route(href: "/mixes/genre-electronic") == .mix("genre-electronic"))
    #expect(Route(href: "/settings/listening?range=2026") == .listening)
    #expect(Route(href: "/settings/playback") == .settingsPanel(.playback))
    #expect(Route(href: "/settings/analysis") == .settingsPanel(.analysis))
    #expect(Route(href: "/nowhere") == nil)
  }

  @Test func opensPagesOnTheCurrentTab() {
    let router = AppRouter()
    router.select(.library)
    router.open(.artists)
    router.open(.artist(7))
    #expect(router.paths[.library] == [.artists, .artist(7)])
    #expect(router.paths[.home] == nil)
  }

  @Test func pickingTheTabShownGoesBackToItsFirstPage() {
    let router = AppRouter()
    router.open(.album(70))
    router.select(.home)
    #expect(router.paths[.home] == [])
  }

  @Test func nowPlayingClosesToGoSomewhere() {
    let router = AppRouter()
    router.nowPlaying = true
    router.open(href: "/albums/70")
    #expect(!router.nowPlaying)
    #expect(router.paths[.home] == [.album(70)])
    router.nowPlaying = true
    router.open(href: "/queue")
    #expect(router.tab == .queue)
    #expect(!router.nowPlaying)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter RouterTests
```

Expected: the build fails with `cannot find 'Route' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/Route.swift`:

```swift
import Foundation
import PlayarrAPI

/// A page the app can show, named after the web's routes (apps/web/src/routes.tsx). Pages are values, so the same
/// destinations work in the iPhone's tab stacks now and in an iPad split view later.
public enum Route: Hashable, Sendable {
  case album(Int)
  case artist(Int)
  case albums(AlbumSort)
  case artists
  case favorites
  case playlists
  case playlist(Int)
  case mixes
  case mix(String)
  case listening
  case settings
  case settingsPanel(SettingsPanel)

  /// The page at a web path ("/albums/70", "/albums?sort=added"), as "Playing from" links carry; nil if none.
  public init?(href: String) {
    guard let components = URLComponents(string: href) else { return nil }
    let parts = components.path.split(separator: "/").map(String.init)
    let query = { (name: String) in components.queryItems?.first { $0.name == name }?.value }
    switch (parts.first, parts.count) {
    case ("albums", 1): self = .albums(query("sort").map(AlbumSort.init(rawValue:)) ?? .artist)
    case ("albums", 2): guard let id = Int(parts[1]) else { return nil }; self = .album(id)
    case ("artists", 1): self = .artists
    case ("artists", 2): guard let id = Int(parts[1]) else { return nil }; self = .artist(id)
    case ("favorites", 1): self = .favorites
    case ("playlists", 1): self = .playlists
    case ("playlists", 2): guard let id = Int(parts[1]) else { return nil }; self = .playlist(id)
    case ("mixes", 1): self = .mixes
    case ("mixes", 2): self = .mix(parts[1])
    case ("stats", 1): self = .listening
    case ("settings", 1): self = .settings
    case ("settings", 2):
      if parts[1] == "listening" { self = .listening } else { self = SettingsPanel(rawValue: parts[1]).map(Route.settingsPanel) ?? .settings }
    default: return nil
    }
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/AppTab.swift`:

```swift
/// The phone's tabs, as the web's bottom bar (apps/web/src/components/Nav.tsx).
public enum AppTab: String, Hashable, Sendable, CaseIterable {
  case home, search, library, queue

  public var title: String {
    switch self {
    case .home: "Home"
    case .search: "Search"
    case .library: "Library"
    case .queue: "Queue"
    }
  }

  public var systemImage: String {
    switch self {
    case .home: "house"
    case .search: "magnifyingglass"
    case .library: "books.vertical"
    case .queue: "list.bullet"
    }
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/AppRouter.swift`:

```swift
import Foundation
import Observation

/// Where the app is: the tab, each tab's stack of pages, and whether Now Playing (and its lyrics) is open.
@MainActor @Observable
public final class AppRouter {
  public var tab: AppTab = .home
  public var paths: [AppTab: [Route]] = [:]
  public var nowPlaying = false
  public var lyrics = false

  public init() {}

  /// Picks a tab; picking the one shown goes back to its first page, as iOS tab bars do.
  public func select(_ tab: AppTab) {
    if tab == self.tab {
      paths[tab] = []
    } else {
      self.tab = tab
    }
  }

  /// Opens a page on top of the current tab.
  public func open(_ route: Route) {
    paths[tab, default: []].append(route)
  }

  /// Opens a web path ("Playing from" links): a page, or the Queue tab for "/queue".
  public func open(href: String) {
    if href == "/queue" {
      showQueue()
    } else if let route = Route(href: href) {
      go(route)
    }
  }

  /// From Now Playing: close it and open the page.
  public func go(_ route: Route) {
    nowPlaying = false
    open(route)
  }

  /// Now Playing → Open queue.
  public func showQueue() {
    nowPlaying = false
    tab = .queue
    paths[.queue] = []
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/SettingsPanel.swift`:

```swift
/// Settings' panels (apps/web/src/pages/Settings.tsx), minus Profiles (accounts replaced them) and Your listening
/// (a page of its own here). Playback and Appearance are this device's; the rest are the server's, for admins.
public enum SettingsPanel: String, Hashable, Sendable, CaseIterable {
  case playback, appearance, sources, mixes, analysis, requests, updates, accounts
  #if DEBUG
    case playerLab = "player-lab"
  #endif

  public var title: String {
    switch self {
    case .playback: "Playback"
    case .appearance: "Appearance"
    case .sources: "Sources"
    case .mixes: "Mixes"
    case .analysis: "Analysis"
    case .requests: "Requests"
    case .updates: "Updates"
    case .accounts: "Accounts"
    #if DEBUG
      case .playerLab: "Player lab"
    #endif
    }
  }

  /// The server's settings, shown to admins (built in phase 9).
  public static let server: [SettingsPanel] = [.sources, .mixes, .analysis, .requests, .updates, .accounts]
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter RouterTests
```

Expected: 4 tests pass.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/Route.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/AppTab.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/AppRouter.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/SettingsPanel.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/RouterTests.swift
git commit -F - <<'MSG'
iOS: pages as values read from the web's paths, the four tabs and a router for them and Now Playing

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---
### Task 12: One session per signed-in account

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Demo/SilentSource.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Demo/DemoPlayerBackend.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Session/AccountSession.swift`
- Modify (replace): `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/AppModel.swift`
- Create: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/Support/TestSession.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/SessionTests.swift`

`AppModel` gains this device's `PlaybackSettings` and `AppearanceSettings` (whoever is signed in), the `Theme`, the `ToastCenter`, and `session`. Its initializer keeps phase 2's four arguments first and adds defaulted ones, so phase 2's `AddServerModelTests` compile unchanged. `RootView` starts calling `syncSession()` in Task 25; until then nothing makes a session in the app.

Since this plan was written, `main`'s `AppModel` also wires Bonjour to `ServerStore.discovered(_:)` in its initializer (a known server found at home keeps that address as its local one) and asks `anonymousClient(for: server)` (the record, so the local address is tried too) in `checkActiveServer()`. The replacement below keeps both.

**Step 1: Write the test helper and the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/Support/TestSession.swift`:

```swift
import Foundation
import PlayarrAPI
import PlayarrPlayer
@testable import PlayarrUI

/// An app signed in to the demo library through `api`, with an offline player: view-model tests start here.
@MainActor
func demoModel(api: any APISending = FakeAPI.demoLibrary()) -> AppModel {
  let directory = FileManager.default.temporaryDirectory.appending(path: "playarr-\(UUID().uuidString)", directoryHint: .isDirectory)
  let store = ServerStore(directory: directory, secrets: InMemorySecretStore())
  try? store.signedIn(SignInResponse(token: "demo", account: Demo.account), server: Demo.server, at: Demo.baseURL)
  let defaults = UserDefaults(suiteName: UUID().uuidString)!
  let model = AppModel(
    store: store, browser: ServerBrowser(), appVersion: AppVersion("1.0.0"), device: DeviceInfo(name: "Test", platform: "ios"),
    playback: PlaybackSettings(defaults: defaults), appearance: AppearanceSettings(defaults: defaults),
    makeSession: { record, model in try AccountSession.demo(record, model: model, api: api, offline: true) })
  model.syncSession()
  return model
}

@MainActor
func demoSession(api: any APISending = FakeAPI.demoLibrary()) -> AccountSession {
  demoModel(api: api).session!
}
```

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/SessionTests.swift`:

```swift
import Foundation
import PlayarrAPI
import PlayarrPlayer
import Testing
@testable import PlayarrUI

@MainActor @Suite struct SessionTests {
  @Test func opensASessionForTheSignedInAccount() {
    let model = demoModel()
    #expect(model.session?.account.name == "Demo")
    #expect(model.session?.serverName == "Demo")
  }

  @Test func switchingAccountsClosesTheOneBefore() throws {
    let model = demoModel()
    let first = try #require(model.session)
    first.player.play(Demo.mezzanineTracks)
    let sam = Account(id: 2, username: "sam", name: "Sam", role: .member, canRequest: false, sources: nil, hasPassword: true)
    try model.store.signedIn(SignInResponse(token: "t2", account: sam), server: Demo.server, at: Demo.baseURL)
    model.syncSession()
    #expect(model.session?.account.name == "Sam")
    #expect(model.session !== first)
    // The first account's player stopped when it was switched away.
    #expect(!first.player.queue.playing)
  }

  @Test func noSessionOnceSignedOut() throws {
    let model = demoModel()
    let key = try #require(model.store.active)
    model.store.markSignedOut(key)
    model.syncSession()
    #expect(model.session == nil)
  }

  @Test func theDemoAppStartsSignedIn() {
    #expect(AppModel.demo().session?.account.username == "demo")
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter SessionTests
```

Expected: the build fails with `cannot find 'AccountSession' in scope` (and `extra arguments 'playback', 'appearance', 'makeSession'`).

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Demo/SilentSource.swift`:

```swift
import PlayarrPlayer

/// A song's worth of silence, for the demo and tests: the player runs (time moves, songs end) without a server.
public actor SilentSource: PCMSource {
  private var framesLeft: Int

  /// `seconds` long, from `frame` (44.1 kHz) on.
  public init(seconds: Double, from frame: Int64 = 0) {
    framesLeft = max(0, Int(seconds * 44_100) - Int(frame))
  }

  public func read(maxFrames: Int) async throws -> PCMBlock? {
    guard framesLeft > 0 else { return nil }
    let count = min(maxFrames, framesLeft)
    framesLeft -= count
    let zeros = [Float](repeating: 0, count: count)
    return PCMBlock(left: zeros, right: zeros)
  }

  public func close() async {
    framesLeft = 0
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Demo/DemoPlayerBackend.swift`:

```swift
import Foundation
import PlayarrAPI
import PlayarrPlayer

/// The player's server in the demo and tests: radio from the demo library, no levels, plays kept to itself.
public struct DemoPlayerBackend: PlayerBackend {
  let api: any APISending

  public init(api: any APISending) {
    self.api = api
  }

  public func levels(_ recordingIds: [String]) async throws -> [String: TrackLevel] { [:] }
  public func reportPlays(_ plays: [PlayReport]) async throws {}
  public func radio(seeds: [String], exclude: [String], count: Int) async throws -> [Track] {
    try await api.send(API.Playback.radio(seeds: seeds, exclude: exclude, count: count))
  }
  public func streamRequest(_ track: Track) -> URLRequest { URLRequest(url: Demo.baseURL.appending(path: track.streamUrl)) }
  public func levelledRequest(_ track: Track) -> URLRequest { streamRequest(track) }
  public func artwork(_ track: Track, size: Int) async -> Data? { nil }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Session/AccountSession.swift`:

```swift
import Foundation
import Observation
import PlayarrAPI
import PlayarrPlayer

/// Everything that belongs to the signed-in account: its server connection, player (queue, plays), answer cache,
/// image cache and where the app is. Switching accounts closes this and opens another, so nothing of one account
/// stays on screen for the next.
@MainActor @Observable
public final class AccountSession {
  public let key: AccountKey
  public let account: Account
  public let serverName: String
  public let api: any APISending
  /// The real client (nil in the demo): the debug Player lab asks for albums with it.
  public let client: APIClient?
  public let player: Player
  public let queries: QueryCache
  public let images: ImageCache
  public let router = AppRouter()
  public let toasts: ToastCenter

  public init(
    key: AccountKey, account: Account, serverName: String, api: any APISending, client: APIClient?, player: Player,
    queries: QueryCache, images: ImageCache, toasts: ToastCenter
  ) {
    self.key = key
    self.account = account
    self.serverName = serverName
    self.api = api
    self.client = client
    self.player = player
    self.queries = queries
    self.images = images
    self.toasts = toasts
  }

  /// The account's folder: Application Support/Playarr/<server id>/<account id>/ (queue, plays, stream cache, answers).
  public static func folder(for key: AccountKey) -> URL {
    URL.applicationSupportDirectory.appending(path: "Playarr/\(key.serverId)/\(key.accountId)", directoryHint: .isDirectory)
  }

  /// Images may be thrown away by the system: Caches/Playarr/<server id>/<account id>/images/.
  public static func imageFolder(for key: AccountKey) -> URL {
    URL.cachesDirectory.appending(path: "Playarr/\(key.serverId)/\(key.accountId)/images", directoryHint: .isDirectory)
  }

  /// The session for a signed-in account of `model.store`; nil when it has no token.
  public static func live(_ record: AccountRecord, model: AppModel) throws -> AccountSession? {
    guard let server = model.store.server(record.serverId), let client = model.store.client(for: record),
      let media = model.store.mediaURLs(for: record)
    else { return nil }
    let folder = folder(for: record.key)
    let player = try Player.live(backend: APIBackend(client: client, media: media), directory: folder, settings: model.playback)
    let queries = QueryCache(directory: folder.appending(path: "queries", directoryHint: .isDirectory))
    let images = ImageCache(directory: imageFolder(for: record.key), media: media)
    Task {
      await queries.removeExpired()
      await images.prune()
    }
    return AccountSession(
      key: record.key, account: record.account, serverName: server.name, api: client, client: client, player: player,
      queries: queries, images: images, toasts: model.toasts)
  }

  /// The demo library (`Demo`), playing silence: for the UI tests, and view-model tests (`offline`: an engine that
  /// renders only when asked, so no sound device is needed).
  public static func demo(_ record: AccountRecord, model: AppModel, api: any APISending = DemoAPI(), offline: Bool = false) throws -> AccountSession {
    let folder = FileManager.default.temporaryDirectory.appending(path: "playarr-demo-\(UUID().uuidString)", directoryHint: .isDirectory)
    typealias MakeEngine = @MainActor (@escaping @MainActor (EngineItem, Int64) -> any PCMSource) throws -> AudioEngine
    let rendersWhenAsked: MakeEngine = { makeSource in try AudioEngine(manualRendering: true, makeSource: makeSource) }
    let player = try Player(
      backend: DemoPlayerBackend(api: api), directory: folder, settings: model.playback,
      makeEngine: offline ? rendersWhenAsked : nil,
      makeSource: { item, frame in SilentSource(seconds: item.track.duration, from: frame) })
    if !offline { player.start() }
    return AccountSession(
      key: record.key, account: record.account, serverName: Demo.server.name, api: api, client: nil, player: player,
      queries: QueryCache(directory: nil), images: ImageCache(directory: folder.appending(path: "images"), media: MediaURLs(baseURL: Demo.baseURL, token: nil)),
      toasts: model.toasts)
  }

  /// The account is no longer the one shown: its song so far is reported and its queue saved.
  public func close() {
    player.shutDown()
  }
}
```

Replace `AppModel.swift` with (four spaces, like phase 2's file):

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/AppModel.swift`:

```swift
import Foundation
import Observation
import PlayarrAPI
import PlayarrPlayer

/// The app's root state: the servers and accounts, Bonjour, and what the root view shows.
@MainActor @Observable
public final class AppModel {
    /// Makes the session of a signed-in account (live, or the demo).
    public typealias SessionFactory = @MainActor (AccountRecord, AppModel) throws -> AccountSession?

    public let store: ServerStore
    public let browser: ServerBrowser
    public let appVersion: AppVersion
    public let device: DeviceInfo
    /// Settings → Playback and Appearance: this device's, whoever is signed in.
    public let playback: PlaybackSettings
    public let appearance: AppearanceSettings
    public let theme: Theme
    public let toasts = ToastCenter()
    /// The active account's session; nil while no account is signed in.
    public private(set) var session: AccountSession?
    /// The active server needs a newer app.
    public private(set) var tooOld: ServerInfo?
    /// A setup-code link to open (playarr://redeem).
    public var redeemLink: RedeemLink?
    public var showingAccounts = false

    @ObservationIgnored private let makeSession: SessionFactory

    public init(
        store: ServerStore, browser: ServerBrowser, appVersion: AppVersion, device: DeviceInfo,
        playback: PlaybackSettings = PlaybackSettings(), appearance: AppearanceSettings = AppearanceSettings(),
        makeSession: @escaping SessionFactory = AccountSession.live
    ) {
        self.store = store
        self.browser = browser
        self.appVersion = appVersion
        self.device = device
        self.playback = playback
        self.appearance = appearance
        self.theme = Theme(appearance: appearance)
        self.makeSession = makeSession
        // A known server found at home keeps that address as its local one.
        browser.onUpdate = { [weak store] servers in store?.discovered(servers) }
    }

    public static func live() -> AppModel {
        AppModel(store: .live(), browser: ServerBrowser(), appVersion: .current, device: .current())
    }

    /// No servers, and nothing kept: for UI tests (`-UITests`) and previews.
    public static func empty() -> AppModel {
        let directory = FileManager.default.temporaryDirectory.appending(path: "playarr-\(UUID().uuidString)", directoryHint: .isDirectory)
        return AppModel(store: ServerStore(directory: directory, secrets: InMemorySecretStore()), browser: ServerBrowser(), appVersion: .current, device: .current())
    }

    /// Signed in to the demo library, playing silence: for UI tests (`-UITestsDemo`). Nothing is kept.
    public static func demo() -> AppModel {
        let directory = FileManager.default.temporaryDirectory.appending(path: "playarr-\(UUID().uuidString)", directoryHint: .isDirectory)
        let store = ServerStore(directory: directory, secrets: InMemorySecretStore())
        try? store.signedIn(SignInResponse(token: "demo", account: Demo.account), server: Demo.server, at: Demo.baseURL)
        let defaults = UserDefaults(suiteName: "playarr-demo-\(UUID().uuidString)") ?? .standard
        let model = AppModel(
            store: store, browser: ServerBrowser(), appVersion: .current, device: .current(),
            playback: PlaybackSettings(defaults: defaults), appearance: AppearanceSettings(defaults: defaults),
            makeSession: { record, model in try AccountSession.demo(record, model: model) })
        model.syncSession()
        return model
    }

    /// Opens the session of the active, signed-in account, closing the one before; none while signed out.
    public func syncSession() {
        let record = store.activeAccount.flatMap { $0.signedIn ? $0 : nil }
        guard record?.key != session?.key else { return }
        session?.close()
        session = nil
        guard let record else { return }
        do {
            session = try makeSession(record, self)
        } catch {
            toasts.push(error.localizedDescription, tone: .error)
        }
    }

    /// playarr:// links: redeem a setup code.
    public func open(_ url: URL) {
        if let link = RedeemLink(url) { redeemLink = link }
    }

    /// Asks the active server who it is: its name may have changed, or it may need a newer app.
    public func checkActiveServer() async {
        guard let server = store.activeServer else { return }
        guard let info = try? await store.anonymousClient(for: server).send(API.Server.info()), info.id == server.id else { return }
        store.remember(info, at: server.baseURL)
        tooOld = info.supports(appVersion) ? nil : info
    }

    /// Someone came through a server's checks: it is new enough.
    func connected(to info: ServerInfo) {
        if info.supports(appVersion), tooOld?.id == info.id { tooOld = nil }
    }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI
```

Expected: every suite passes, `SessionTests` (4 tests) and phase 2's `AddServerModelTests` included.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Demo/SilentSource.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Demo/DemoPlayerBackend.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Session/AccountSession.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/AppModel.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/Support/TestSession.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/SessionTests.swift
git commit -F - <<'MSG'
iOS: one session per signed-in account (its player, caches and place in the app), closed when switching

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 13: What a song's ⋯ menu and an album's buttons do

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Actions/TrackActions.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/TrackActionsTests.swift`

`apps/web/src/player/actions.ts` and `radio.ts`: Play next and Add to queue toast "Playing 1 track next" / "Added 2 tracks to queue"; Start radio plays the song then songs like it, as "<title> radio"; an album card's Play is always in order, Shuffle shuffles; Go to album and Go to artist close Now Playing and open the page.

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/TrackActionsTests.swift`:

```swift
import Foundation
import PlayarrAPI
import PlayarrPlayer
import Testing
@testable import PlayarrUI

@MainActor @Suite struct TrackActionsTests {
  @Test func queuesSongsAndSaysSo() {
    let session = demoSession()
    session.player.play(Demo.mezzanineTracks)
    session.actions.playNext([Demo.dummyTracks[0]])
    session.actions.addToQueue(Demo.protectionTracks)
    #expect(session.player.queue.upcoming(5).map(\.title) == ["Mysterons", "Risingson", "Inertia Creeps", "Protection", "Karmacoma"])
    #expect(session.toasts.toasts.map(\.message) == ["Playing 1 track next", "Added 2 tracks to queue"])
  }

  @Test func startsARadioFromASong() async {
    let session = demoSession()
    await session.actions.startRadio(Demo.mezzanineTracks[0])
    #expect(session.player.queue.currentTrack?.title == "Angel")
    #expect(session.player.queue.source == PlaySource(label: "Angel radio", href: "/albums/70"))
    #expect(session.player.queue.queue.count == 1 + Demo.dummyTracks.count)
  }

  @Test func playsAndQueuesAlbums() async {
    let session = demoSession()
    await session.actions.playAlbum(80)
    #expect(session.player.queue.queue.map(\.title) == ["Mysterons", "Sour Times", "Glory Box"])
    #expect(session.player.queue.source == PlaySource(label: "Dummy", href: "/albums/80"))
    await session.actions.queueAlbum(71, next: true)
    #expect(session.player.queue.upcoming(2).map(\.title) == ["Protection", "Karmacoma"])
  }

  @Test func goesToTheSongsAlbumAndArtist() {
    let session = demoSession()
    session.router.nowPlaying = true
    session.actions.goToAlbum(Demo.dummyTracks[0])
    session.actions.goToArtist(Demo.dummyTracks[0])
    #expect(session.router.paths[.home] == [.album(80), .artist(8)])
    #expect(!session.router.nowPlaying)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter TrackActionsTests
```

Expected: the build fails with `value of type 'AccountSession' has no member 'actions'`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Actions/TrackActions.swift`:

```swift
import PlayarrAPI
import PlayarrPlayer

/// What a song's ⋯ menu and an album's buttons do (apps/web/src/player/actions.ts and radio.ts), with the web's toasts.
@MainActor
public struct TrackActions {
  let session: AccountSession

  public init(session: AccountSession) {
    self.session = session
  }

  public func playNext(_ tracks: [Track]) {
    session.player.playNext(tracks)
    session.toasts.push("Playing \(Format.plural(tracks.count, "track")) next")
  }

  public func addToQueue(_ tracks: [Track]) {
    session.player.addToQueue(tracks)
    session.toasts.push("Added \(Format.plural(tracks.count, "track")) to queue")
  }

  /// The song, then songs like it ("<title> radio").
  public func startRadio(_ track: Track) async {
    await session.player.startRadio(track)
  }

  public func goToAlbum(_ track: Track) { session.router.go(.album(track.albumId)) }
  public func goToArtist(_ track: Track) { session.router.go(.artist(track.artistId)) }

  /// An album card's Play or Shuffle: always in order unless shuffled ("Play means in order").
  public func playAlbum(_ id: Int, shuffle: Bool = false) async {
    guard let album = await album(id) else { return }
    session.player.play(album.tracks, source: PlaySource(label: album.title, href: "/albums/\(id)"), shuffle: shuffle)
  }

  /// An album card's Play next or Add to queue.
  public func queueAlbum(_ id: Int, next: Bool) async {
    guard let album = await album(id) else { return }
    next ? playNext(album.tracks) : addToQueue(album.tracks)
  }

  private func album(_ id: Int) async -> AlbumDetail? {
    let api = session.api
    do {
      return try await session.queries.fetch(.album(id)) { try await api.send(API.Library.album(id: id)) }
    } catch {
      session.toasts.push(error.localizedDescription, tone: .error)
      return nil
    }
  }
}

extension AccountSession {
  public var actions: TrackActions { TrackActions(session: self) }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter TrackActionsTests
```

Expected: 4 tests pass.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Actions/TrackActions.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/TrackActionsTests.swift
git commit -F - <<'MSG'
iOS: play next, add to queue, start radio and go to album or artist, with the web's toasts

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 14: Shared pieces: covers, badges, section headers, shelves, skeletons, errors, chips, prefetch

**Files:**
- Create in `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/`: `Platform.swift`, `Cover.swift`, `FormatBadge.swift`, `SectionHeader.swift`, `Shelf.swift`, `Skeleton.swift`, `ErrorState.swift`, `FlowLayout.swift`, `Prefetch.swift`

Views get no unit tests (their decisions live in the models); the check is that the package builds for the Mac and the iPhone simulator, and the UI tests of Task 26. `Platform.swift` keeps the iOS-only modifiers (`tabViewBottomAccessory`, `fullScreenCover`, `navigationBarTitleDisplayMode`, `tabBarMinimizeBehavior`) behind `#if os(iOS)`, so `swift test` still builds on the Mac. Prefetch waits until a card has rested on screen for 0.3 s (the web prefetches on hover intent, 80 ms, or a finger going down), so scrolling past a grid fetches nothing.

**Step 1: Write the views**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/Platform.swift`:

```swift
import SwiftUI

#if canImport(UIKit)
  import UIKit
#else
  import AppKit
#endif

/// The few things iOS and the Mac (where `swift test` builds this package) do differently.
extension View {
  /// The mini player: in the tab bar's accessory on iOS, over the bottom edge elsewhere.
  @ViewBuilder
  func miniPlayer<Content: View>(isShown: Bool, @ViewBuilder _ content: () -> Content) -> some View {
    #if os(iOS)
      if #available(iOS 26.1, *) {
        tabViewBottomAccessory(isEnabled: isShown, content: content)
      } else {
        tabViewBottomAccessory(content: content)
      }
    #else
      safeAreaInset(edge: .bottom) { if isShown { content() } }
    #endif
  }

  /// Now Playing covers the whole screen on iOS; a sheet elsewhere.
  func nowPlayingCover<Content: View>(isPresented: Binding<Bool>, @ViewBuilder content: @escaping () -> Content) -> some View {
    #if os(iOS)
      fullScreenCover(isPresented: isPresented, content: content)
    #else
      sheet(isPresented: isPresented, content: content)
    #endif
  }

  /// A page title in the bar, not a large one.
  func inlineTitle() -> some View {
    #if os(iOS)
      navigationBarTitleDisplayMode(.inline)
    #else
      self
    #endif
  }

  /// The tab bar shrinks while scrolling down, as Apple Music's does.
  func minimizingTabBar() -> some View {
    #if os(iOS)
      tabBarMinimizeBehavior(.onScrollDown)
    #else
      self
    #endif
  }
}

extension Image {
  /// An image from JPEG, PNG or WebP bytes.
  static func decoded(_ data: Data) -> Image? {
    #if canImport(UIKit)
      UIImage(data: data).map(Image.init(uiImage:))
    #else
      NSImage(data: data).map(Image.init(nsImage:))
    #endif
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/Cover.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// Album art or an artist photo, asked at the size it's shown (apps/web/src/components/Cover.tsx). Without one, a
/// record-label stand-in: grooves and initials.
struct Cover: View {
  let path: String?
  /// How wide it's shown, in points: picks the size asked for.
  let points: CGFloat
  /// Initials for the stand-in.
  var label = ""
  var circle = false
  var corner: CGFloat = 4

  @Environment(AccountSession.self) private var session
  @Environment(\.displayScale) private var scale
  @State private var image: Image?

  var body: some View {
    Color.clear
      .aspectRatio(1, contentMode: .fit)
      .overlay {
        if let image {
          image.resizable().scaledToFill()
        } else {
          CoverPlaceholder(label: label)
        }
      }
      .clipShape(circle ? AnyShape(Circle()) : AnyShape(RoundedRectangle(cornerRadius: corner)))
      .task(id: "\(path ?? "")@\(points)") { await load() }
      .accessibilityHidden(true)
  }

  private func load() async {
    let size = ImageCache.pixels(points: points, scale: scale)
    guard let data = await session.images.data(path, size: size) else {
      image = nil
      return
    }
    image = Image.decoded(data)
  }
}

/// A record label: concentric grooves and the first letters of the name in the accent colour.
struct CoverPlaceholder: View {
  let label: String
  @Environment(Theme.self) private var theme

  var initials: String {
    label.split(separator: " ").prefix(2).compactMap { $0.first.map { String($0).uppercased() } }.joined()
  }

  var body: some View {
    GeometryReader { geometry in
      let side = min(geometry.size.width, geometry.size.height)
      ZStack {
        Canvas { context, size in
          context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(Color(white: 0.09)))
          let center = CGPoint(x: size.width / 2, y: size.height / 2)
          for radius in stride(from: CGFloat(3), to: max(size.width, size.height), by: 5) {
            let ring = Path(ellipseIn: CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2))
            context.stroke(ring, with: .color(Color(white: 0.12)), lineWidth: 2)
          }
        }
        Circle()
          .fill(theme.accent.color.opacity(0.9))
          .frame(width: side * 0.38, height: side * 0.38)
          .overlay {
            Text(initials).font(.system(size: max(8, side * 0.14), weight: .semibold, design: .serif)).foregroundStyle(.black)
          }
      }
    }
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/FormatBadge.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// "FLAC 24/96" with a dot for lossless, in the accent colour for Hi-Res (apps/web/src/components/FormatBadge.tsx).
/// Hidden when Settings → Appearance turns badges off.
struct FormatBadge: View {
  let format: AudioFormat?
  @Environment(AppearanceSettings.self) private var appearance
  @Environment(Theme.self) private var theme

  var body: some View {
    if appearance.formatBadges, let text = Format.badge(format) {
      let hiRes = Format.isHiRes(format)
      let color = hiRes ? theme.accent.color : Color.secondary
      HStack(spacing: 4) {
        if format?.lossless == true { Circle().fill(color).frame(width: 4, height: 4) }
        Text(text.uppercased())
      }
      .font(.caption2.monospaced())
      .foregroundStyle(color)
      .padding(.horizontal, 5)
      .padding(.vertical, 1)
      .overlay(RoundedRectangle(cornerRadius: 3).stroke(color.opacity(0.5)))
      .accessibilityLabel(hiRes ? "Hi-Res lossless, \(text)" : format?.lossless == true ? "Lossless, \(text)" : "Lossy, \(text)")
    }
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/SectionHeader.swift`:

```swift
import SwiftUI

/// A section's small kicker, its title, and "See all" or a button (apps/web/src/components/Section.tsx).
struct SectionHeader<Action: View>: View {
  let title: String
  var kicker: String?
  var seeAll: Route?
  @ViewBuilder var action: () -> Action

  var body: some View {
    HStack(alignment: .lastTextBaseline) {
      VStack(alignment: .leading, spacing: 2) {
        if let kicker { Kicker(text: kicker) }
        Text(title).font(.title2.weight(.semibold)).accessibilityAddTraits(.isHeader)
      }
      Spacer()
      action()
      if let seeAll {
        NavigationLink(value: seeAll) { Kicker(text: "See all") }
          .accessibilityLabel("See all \(title)")
      }
    }
    .padding(.horizontal, 20)
    .padding(.bottom, 8)
  }
}

extension SectionHeader where Action == EmptyView {
  init(title: String, kicker: String? = nil, seeAll: Route? = nil) {
    self.init(title: title, kicker: kicker, seeAll: seeAll) { EmptyView() }
  }
}

/// The small, spaced, upper-case line above titles.
struct Kicker: View {
  let text: String

  var body: some View {
    Text(text.uppercased())
      .font(.caption2.monospaced())
      .tracking(2)
      .foregroundStyle(.secondary)
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/Shelf.swift`:

```swift
import SwiftUI

/// A row that scrolls sideways and stops on a card (apps/web/src/components/Section.tsx `Shelf`).
struct Shelf<Content: View>: View {
  @ViewBuilder var content: () -> Content

  var body: some View {
    ScrollView(.horizontal) {
      LazyHStack(alignment: .top, spacing: 16) { content() }
        .scrollTargetLayout()
    }
    .scrollTargetBehavior(.viewAligned)
    .contentMargins(.horizontal, 20, for: .scrollContent)
    .scrollIndicators(.hidden)
  }
}

/// How wide shelf cards are: about 42 % of a phone's width, at most 208 points (the web's `w-[42vw] max-w-52`).
enum ShelfCard {
  static let width: CGFloat = 160
  static let artistWidth: CGFloat = 150
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/Skeleton.swift`:

```swift
import SwiftUI

/// A grey stand-in while something loads.
struct Skeleton: View {
  var aspectRatio: CGFloat? = 1
  var height: CGFloat?

  var body: some View {
    RoundedRectangle(cornerRadius: 4)
      .fill(Color.secondary.opacity(0.15))
      .aspectRatio(aspectRatio, contentMode: .fit)
      .frame(height: height)
      .accessibilityHidden(true)
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/ErrorState.swift`:

```swift
import SwiftUI

/// A page that couldn't load: what went wrong and Try again (apps/web/src/components/Section.tsx `ErrorState`).
struct ErrorState: View {
  let message: String
  let retry: () async -> Void

  var body: some View {
    ContentUnavailableView {
      Text("Something skipped.").font(.title.weight(.semibold))
    } description: {
      Text(message)
    } actions: {
      Button("Try again", systemImage: "arrow.clockwise") { Task { await retry() } }
        .buttonStyle(.borderedProminent)
    }
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/FlowLayout.swift`:

```swift
import SwiftUI

/// Chips that wrap onto the next line ("Try an artist", playlists found).
struct FlowLayout: Layout {
  var spacing: CGFloat = 8

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let width = proposal.width ?? .infinity
    var x: CGFloat = 0
    var y: CGFloat = 0
    var line: CGFloat = 0
    var widest: CGFloat = 0
    for subview in subviews {
      let size = subview.sizeThatFits(.unspecified)
      if x > 0, x + size.width > width {
        y += line + spacing
        x = 0
        line = 0
      }
      x += size.width + spacing
      line = max(line, size.height)
      widest = max(widest, x - spacing)
    }
    return CGSize(width: min(widest, width), height: y + line)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    var x = bounds.minX
    var y = bounds.minY
    var line: CGFloat = 0
    for subview in subviews {
      let size = subview.sizeThatFits(.unspecified)
      if x > bounds.minX, x + size.width > bounds.maxX {
        y += line + spacing
        x = bounds.minX
        line = 0
      }
      subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
      x += size.width + spacing
      line = max(line, size.height)
    }
  }
}

/// A rounded chip that opens a page.
struct Chip: View {
  let text: String
  let route: Route

  var body: some View {
    NavigationLink(value: route) {
      Text(text)
        .font(.subheadline)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .overlay(Capsule().stroke(Color.secondary.opacity(0.4)))
    }
    .buttonStyle(.plain)
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/Prefetch.swift`:

```swift
import PlayarrAPI
import SwiftUI

extension View {
  /// Fetches what a card's page needs once the card has rested on screen for 0.3 s: by the time it's tapped, the page
  /// is usually ready. Scrolling past doesn't fetch (the web prefetches on hover intent the same way).
  func prefetch(_ action: @escaping @MainActor () -> Void) -> some View {
    task {
      try? await Task.sleep(for: .milliseconds(300))
      if !Task.isCancelled { action() }
    }
  }
}

extension AccountSession {
  /// An album page's data, its artist (for "More by") and its big cover.
  func prefetchAlbum(_ id: Int, cover: String?) {
    let api = self.api
    queries.prefetch(.album(id)) { try await api.send(API.Library.album(id: id)) }
    Task { await images.prefetch([cover], size: ImageCache.pixels(points: 320, scale: 3)) }
  }

  func prefetchArtist(_ id: Int) {
    let api = self.api
    queries.prefetch(.artist(id)) { try await api.send(API.Library.artist(id: id)) }
  }
}
```

**Step 2: Build for the Mac and the iPhone simulator**

```bash
swift build --disable-sandbox --package-path apps/ios/Packages/PlayarrUI
swift build --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --triple arm64-apple-ios26.0-simulator --sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" --scratch-path /tmp/playarr-ui-ios
```

Expected: both build with no errors and no warnings from these files.

**Step 3: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components
git commit -F - <<'MSG'
iOS: covers with a record-label stand-in, format badges, section headers, shelves, skeletons and prefetch on rest

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 15: Cards, song rows and the song menu

**Files:**
- Create in `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/`: `AlbumCard.swift`, `ArtistCard.swift`, `MixCard.swift`, `PlaylistCard.swift`, `TrackRow.swift`, `TrackMenu.swift`

Each row and card is one accessibility element with a spoken label ("Angel, Massive Attack, Mezzanine, 6:19"; "Mezzanine, Massive Attack · 1998 · 3 of 5"). Put `.accessibilityLabel` on the `Button`/`NavigationLink` itself, never with `.accessibilityElement(children: .ignore)` on it: that wraps the button in a second element, and the UI tests (and VoiceOver users) then find the label on an element that can't be tapped. The ⋯ menu's items also show on a long press (`contextMenu`), as iOS users expect; album cards get Play, Shuffle, Play next, Add to queue and Go to artist that way (the web's card Play button is hidden on phones).

**Step 1: Write the views**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/AlbumCard.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// An album in a grid or shelf: its cover, title (in the accent colour while it plays), artist, year, and "3 of 11"
/// when songs are missing (apps/web/src/components/Cards.tsx). Long press for Play, Shuffle and the queue.
struct AlbumCard: View {
  let album: Album
  var width: CGFloat?

  @Environment(AccountSession.self) private var session
  @Environment(Theme.self) private var theme

  var body: some View {
    let current = session.player.queue.currentTrack?.albumId == album.id
    NavigationLink(value: Route.album(album.id)) {
      VStack(alignment: .leading, spacing: 6) {
        Cover(path: album.coverUrl, points: width ?? 180, label: album.title)
          .shadow(color: .black.opacity(0.5), radius: 10, y: 6)
        Text(album.title).font(.subheadline).lineLimit(1).foregroundStyle(current ? theme.accent.color : .primary)
        Text(subtitle).font(.caption).lineLimit(1).foregroundStyle(.secondary)
      }
      .frame(width: width)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(album.title), \(subtitle)")
    .accessibilityAddTraits(current ? [.isButton, .isSelected] : .isButton)
    .contextMenu {
      Button("Play", systemImage: "play.fill") { Task { await session.actions.playAlbum(album.id) } }
      Button("Shuffle", systemImage: "shuffle") { Task { await session.actions.playAlbum(album.id, shuffle: true) } }
      Button("Play next", systemImage: "text.line.first.and.arrowtriangle.forward") { Task { await session.actions.queueAlbum(album.id, next: true) } }
      Button("Add to queue", systemImage: "text.append") { Task { await session.actions.queueAlbum(album.id, next: false) } }
      Button("Go to artist", systemImage: "music.mic") { session.router.open(.artist(album.artistId)) }
    }
    .prefetch { session.prefetchAlbum(album.id, cover: album.coverUrl) }
  }

  /// "Massive Attack · 1998 · 3 of 11".
  var subtitle: String {
    var parts = [album.artistName]
    if let year = album.year { parts.append(String(year)) }
    if album.trackCount < album.totalTrackCount { parts.append("\(album.trackCount) of \(album.totalTrackCount)") }
    return parts.joined(separator: " · ")
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/ArtistCard.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// An artist: photo with the name over it and their counts (apps/web/src/components/Cards.tsx).
struct ArtistCard: View {
  let artist: Artist
  var width: CGFloat?

  @Environment(AccountSession.self) private var session

  var body: some View {
    NavigationLink(value: Route.artist(artist.id)) {
      Cover(path: artist.imageUrl, points: width ?? 170, label: artist.name)
        .aspectRatio(4 / 5, contentMode: .fill)
        .overlay {
          LinearGradient(colors: [.clear, .black.opacity(0.2), .black.opacity(0.95)], startPoint: .top, endPoint: .bottom)
        }
        .overlay(alignment: .bottomLeading) {
          VStack(alignment: .leading, spacing: 4) {
            Text(artist.name).font(.title3.weight(.semibold)).foregroundStyle(.white).lineLimit(2)
            Kicker(text: counts)
          }
          .padding(12)
        }
        .clipShape(RoundedRectangle(cornerRadius: 4))
        .frame(width: width)
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(artist.name), \(counts)")
    .accessibilityAddTraits(.isButton)
    .prefetch { session.prefetchArtist(artist.id) }
  }

  var counts: String { "\(Format.plural(artist.albumCount, "album")) · \(Format.plural(artist.trackCount, "track"))" }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/MixCard.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// A mix on Home: up to four of its album covers under a wash of the mix's colour, "Made for you" and its title, then
/// a line about it (apps/web/src/components/Mixes.tsx).
struct MixCard: View {
  let mix: MixSummary
  var width: CGFloat = ShelfCard.width

  var body: some View {
    NavigationLink(value: Route.mix(mix.key)) {
      VStack(alignment: .leading, spacing: 6) {
        MixCover(mix: mix, width: width)
        Text(mix.subtitle).font(.subheadline).lineLimit(1)
        Text(Format.plural(mix.trackCount, "song")).font(.caption.monospaced()).foregroundStyle(.secondary)
      }
      .frame(width: width)
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(mix.title), \(mix.subtitle), \(Format.plural(mix.trackCount, "song"))")
    .accessibilityAddTraits(.isButton)
  }
}

/// The mix's cover, drawn here rather than on the server.
struct MixCover: View {
  let mix: MixSummary
  let width: CGFloat

  var body: some View {
    let covers = mix.covers.count >= 4 ? Array(mix.covers.prefix(4)) : Array(mix.covers.prefix(1))
    ZStack(alignment: .bottomLeading) {
      OKLCH.rgb(l: 0.32, c: 0.09, h: mix.hue).color
      if covers.count == 4 {
        Grid(horizontalSpacing: 0, verticalSpacing: 0) {
          GridRow { cover(covers[0]); cover(covers[1]) }
          GridRow { cover(covers[2]); cover(covers[3]) }
        }
        .saturation(0.85)
      } else if let first = covers.first {
        Cover(path: first, points: width, corner: 0).saturation(0.85)
      }
      LinearGradient(
        stops: [
          .init(color: OKLCH.rgb(l: 0.62, c: 0.17, h: mix.hue).color.opacity(0.35), location: 0),
          .init(color: OKLCH.rgb(l: 0.42, c: 0.14, h: mix.hue).color.opacity(0.72), location: 0.45),
          .init(color: OKLCH.rgb(l: 0.2, c: 0.07, h: mix.hue).color.opacity(0.95), location: 1),
        ], startPoint: .topLeading, endPoint: .bottomTrailing)
      VStack(alignment: .leading, spacing: 2) {
        Text("MADE FOR YOU").font(.system(size: width * 0.046, design: .monospaced)).tracking(2).foregroundStyle(.white.opacity(0.75))
        Text(mix.title).font(.system(size: width * 0.125, weight: .semibold, design: .serif)).foregroundStyle(.white).lineLimit(2)
      }
      .padding(width * 0.07)
    }
    .frame(width: width, height: width)
    .clipShape(RoundedRectangle(cornerRadius: 4))
  }

  private func cover(_ path: String) -> some View {
    Cover(path: path, points: width / 2, corner: 0)
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/PlaylistCard.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// A playlist: its generated cover (drawn by the server; no title on it below 120 points), name and songs.
struct PlaylistCard: View {
  let playlist: PlaylistSummary
  var width: CGFloat = ShelfCard.width

  var body: some View {
    NavigationLink(value: Route.playlist(playlist.id)) {
      VStack(alignment: .leading, spacing: 6) {
        PlaylistCover(cover: playlist.cover, points: width, name: playlist.name)
        Text(playlist.name).font(.subheadline).lineLimit(1)
        Text(Format.plural(playlist.trackCount, "song")).font(.caption.monospaced()).foregroundStyle(.secondary)
      }
      .frame(width: width)
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(playlist.name), \(Format.plural(playlist.trackCount, "song"))")
    .accessibilityAddTraits(.isButton)
  }
}

/// The playlist's artwork (apps/web/src/components/PlaylistCover.tsx).
struct PlaylistCover: View {
  /// Below this the title on the cover would be unreadable, and lists show the name beside it anyway.
  static let titleMinPoints: CGFloat = 120

  let cover: PlaylistCoverInfo
  let points: CGFloat
  let name: String

  var body: some View {
    let separator = cover.url.contains("?") ? "&" : "?"
    let path = points < Self.titleMinPoints ? cover.url + separator + "title=0" : cover.url
    Cover(path: path, points: points, label: name)
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/TrackRow.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// A song in a list (apps/web/src/components/TrackList.tsx): its number on album pages, or its cover with the
/// artist and album in mixed lists; the title in the accent colour while it plays; its length and the ⋯ menu.
struct TrackRow: View {
  enum Style { case album, mixed }

  let track: Track
  var style: Style = .album
  let onTap: () -> Void

  @Environment(AccountSession.self) private var session
  @Environment(Theme.self) private var theme

  var body: some View {
    let current = session.player.queue.currentTrack?.fileId == track.fileId
    let playing = current && session.player.queue.playing
    HStack(spacing: 12) {
      Button(action: onTap) {
        HStack(spacing: 12) {
          leading(current: current, playing: playing)
          VStack(alignment: .leading, spacing: 2) {
            Text(track.title).lineLimit(1).foregroundStyle(current ? theme.accent.color : .primary)
            if style == .mixed {
              Text("\(track.artistName) · \(track.albumTitle)").font(.footnote).lineLimit(1).foregroundStyle(.secondary)
            }
          }
          Spacer(minLength: 8)
          Text(Format.time(track.duration)).font(.footnote.monospacedDigit()).foregroundStyle(.secondary)
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(accessibilityLabel)
      .accessibilityValue(playing ? "Playing" : current ? "Paused" : "")
      .accessibilityHint(current ? "Plays or pauses the song" : "Plays the song")
      TrackMenu(track: track, showsAlbum: style == .mixed)
    }
    .padding(.vertical, 6)
    .contextMenu { TrackMenuItems(track: track, showsAlbum: style == .mixed) }
  }

  @ViewBuilder
  private func leading(current: Bool, playing: Bool) -> some View {
    switch style {
    case .album:
      Group {
        if current {
          Image(systemName: "waveform").symbolEffect(.variableColor.iterative, isActive: playing).foregroundStyle(theme.accent.color)
        } else {
          Text("\(track.trackNumber)").font(.subheadline.monospacedDigit()).foregroundStyle(.secondary)
        }
      }
      .frame(width: 28)
    case .mixed:
      Cover(path: track.coverUrl, points: 44, label: track.albumTitle)
        .frame(width: 44, height: 44)
        .overlay {
          if current {
            Image(systemName: "waveform").symbolEffect(.variableColor.iterative, isActive: playing)
              .foregroundStyle(.white).frame(maxWidth: .infinity, maxHeight: .infinity).background(.black.opacity(0.5))
          }
        }
    }
  }

  private var accessibilityLabel: String {
    let length = Format.time(track.duration)
    return style == .mixed ? "\(track.title), \(track.artistName), \(track.albumTitle), \(length)" : "\(track.trackNumber). \(track.title), \(length)"
  }
}

/// A song on the album that isn't in the library, greyed out in its place.
struct MissingTrackRow: View {
  let missing: MissingTrack

  var body: some View {
    HStack(spacing: 12) {
      Text("\(missing.trackNumber)").font(.subheadline.monospacedDigit()).frame(width: 28)
      Text(missing.title).lineLimit(1)
      Spacer()
      Text(Format.time(missing.duration)).font(.footnote.monospacedDigit())
    }
    .foregroundStyle(.secondary)
    .opacity(0.5)
    .padding(.vertical, 6)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(missing.trackNumber). \(missing.title), not in your library")
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/TrackMenu.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// A song's ⋯ button.
struct TrackMenu: View {
  let track: Track
  var showsAlbum = true

  var body: some View {
    Menu {
      TrackMenuItems(track: track, showsAlbum: showsAlbum)
    } label: {
      Image(systemName: "ellipsis")
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .foregroundStyle(.secondary)
    .accessibilityLabel("More for \(track.title)")
  }
}

/// What can be done with a song (apps/web/src/components/TrackList.tsx): Play next, Add to queue, Start radio,
/// Go to album (in mixed lists), Go to artist. Add to playlist (phase 6), Show metadata and Edit mix points (phase 8)
/// join them later.
struct TrackMenuItems: View {
  let track: Track
  var showsAlbum = true
  @Environment(AccountSession.self) private var session

  var body: some View {
    Button("Play next", systemImage: "text.line.first.and.arrowtriangle.forward") { session.actions.playNext([track]) }
    Button("Add to queue", systemImage: "text.append") { session.actions.addToQueue([track]) }
    Button("Start radio", systemImage: "dot.radiowaves.left.and.right") { Task { await session.actions.startRadio(track) } }
    if showsAlbum {
      Button("Go to album", systemImage: "square.stack") { session.actions.goToAlbum(track) }
    }
    Button("Go to artist", systemImage: "music.mic") { session.actions.goToArtist(track) }
  }
}
```

**Step 2: Build for the Mac and the iPhone simulator**

```bash
swift build --disable-sandbox --package-path apps/ios/Packages/PlayarrUI
swift build --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --triple arm64-apple-ios26.0-simulator --sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" --scratch-path /tmp/playarr-ui-ios
```

Expected: both build with no errors or warnings.

**Step 3: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/AlbumCard.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/ArtistCard.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/MixCard.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/PlaylistCard.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/TrackRow.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/TrackMenu.swift
git commit -F - <<'MSG'
iOS: album, artist, mix and playlist cards, song rows and the song menu

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 16: Home

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Home/HomeModel.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Home/HomeView.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/HomeModelTests.swift`

`apps/web/src/pages/Home.tsx`, in its order: the library line, Shuffle everything (300 random songs, shuffled, "Your whole library") and Resume (when paused), then Your mixes (hidden once the server says none), Year in review (December and January, only if that year has plays), Jump back in (from three albums), Favorites (the first five), Playlists, Recently added (14), Artists (20: those of the latest albums, then the biggest) and Rediscover (12 random albums with a dice to roll again). The web's "Who's listening" chooser is gone: accounts replaced profiles, and switching is in Library and Settings. `shelfArtists` comes with its web test, ported.

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/HomeModelTests.swift`:

```swift
import Foundation
import PlayarrAPI
import PlayarrPlayer
import Testing
@testable import PlayarrUI

@MainActor @Suite struct HomeModelTests {
  @Test func showsTheYearInReviewInDecemberAndJanuary() {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    let date = { (iso: String) in Format.parseDate(iso)! }
    #expect(HomeModel.reviewYear(now: date("2026-12-03T12:00:00Z"), calendar: calendar) == 2026)
    #expect(HomeModel.reviewYear(now: date("2027-01-20T12:00:00Z"), calendar: calendar) == 2026)
    #expect(HomeModel.reviewYear(now: date("2026-11-03T12:00:00Z"), calendar: calendar) == nil)
  }

  @Test func showsTheArtistsOfTheLatestAlbumsFirstThenTheBiggest() {
    // Ported from apps/web/src/pages/Home.test.ts.
    let artists = (0..<300).map { i in Artist(id: i, name: "\(i)", sortName: "\(i)", genres: [], albumCount: i % 7, trackCount: 1) }
    let recent = [250, 3, 250].map { id in Album(id: id, title: "", artistId: id, artistName: "", albumType: "Album", secondaryTypes: [], genres: [], duration: 0, trackCount: 1, totalTrackCount: 1) }
    let shelf = HomeModel.shelfArtists(artists, recent: recent)
    #expect(shelf.count == 20)
    #expect(shelf.prefix(2).map(\.id) == [250, 3])
    #expect(shelf.dropFirst(2).allSatisfy { $0.albumCount == 6 })
  }

  @Test func saysHowBigTheLibraryIs() async {
    let model = HomeModel(session: demoSession())
    await model.load()
    #expect(model.libraryLine == "8 tracks across 3 albums, 45 min of music waiting in your library.")
    #expect(model.jumpBackIn.count == 3)
    #expect(model.favoriteTracks.map(\.title) == ["Risingson"])
    #expect(model.showsMixes)
  }

  @Test func hidesJumpBackInUntilThreeAlbums() async {
    let api = FakeAPI.demoLibrary()
    api.on(.get, "/api/plays/recent-albums", Array(Demo.albums.prefix(2)))
    let model = HomeModel(session: demoSession(api: api))
    await model.load()
    #expect(model.jumpBackIn.isEmpty)
  }

  @Test func hidesTheYearInReviewOfAnotherYear() async {
    let api = FakeAPI.demoLibrary()
    let stats = ListeningStats(range: "2025", to: "2025-12-31", minutes: 600, plays: 12, songs: 3, artists: 1, days: 2, newArtists: 0, longestStreak: 1, topArtists: [.init(artist: Demo.artist, plays: 12, minutes: 600)], topAlbums: [], topTracks: [], topGenres: [], hours: [], weekdays: [], years: [2026])
    api.on(.get, "/api/stats", stats)
    let december = Format.parseDate("2026-12-03T12:00:00Z")!
    let model = HomeModel(session: demoSession(api: api), now: december)
    await model.load()
    #expect(model.yearInReview == nil)
  }

  @Test func shufflesTheWholeLibrary() async {
    let session = demoSession()
    let model = HomeModel(session: session)
    await model.shuffleEverything()
    #expect(session.player.queue.shuffle)
    #expect(session.player.queue.queue.count == Demo.tracks.count)
    #expect(session.player.queue.source == PlaySource(label: "Your whole library", href: "/albums"))
  }

  @Test func offersToResumeAPausedSong() {
    let session = demoSession()
    let model = HomeModel(session: session)
    #expect(model.resumable == nil)
    session.player.play(Demo.mezzanineTracks)
    session.player.setPlaying(false)
    #expect(model.resumable?.title == "Angel")
    model.resume()
    #expect(model.resumable == nil)
  }

  @Test func rollsTheDiceForOtherAlbums() async {
    let api = FakeAPI.demoLibrary()
    let model = HomeModel(session: demoSession(api: api))
    await model.load()
    await model.reshuffle()
    #expect(model.seed == 1)
    #expect(api.calls(.get, "/api/albums/random").count == 2)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter HomeModelTests
```

Expected: the build fails with `cannot find 'HomeModel' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Home/HomeModel.swift`:

```swift
import Foundation
import Observation
import PlayarrAPI
import PlayarrPlayer

/// Home, as apps/web/src/pages/Home.tsx: the library line, Shuffle everything and Resume, then Year in review
/// (December and January), Your mixes, Jump back in, Favorites, Playlists, Recently added, Artists and Rediscover.
@MainActor @Observable
final class HomeModel {
  /// How many artists the shelf shows; all of them are a tap away on Artists.
  static let shelfArtistCount = 20

  let health: Query<HealthStatus>
  let recent: Query<[Album]>
  let artists: Query<[Artist]>
  let favorites: Query<[FavoriteTrack]>
  let playlists: Query<[PlaylistSummary]>
  let mixes: Query<[MixSummary]>
  let heardLately: Query<[Album]>
  let review: Query<ListeningStats>?
  let reviewYear: Int?
  private(set) var rediscover: Query<[Album]>
  private(set) var seed = 0

  @ObservationIgnored private let session: AccountSession

  init(session: AccountSession, now: Date = Date()) {
    self.session = session
    let api = session.api
    let cache = session.queries
    health = Query(.health, cache: cache, staleAfter: 30) { try await api.send(API.Server.health()) }
    recent = Query(.albums(.added, limit: 14), cache: cache) { try await api.send(API.Library.albums(sort: .added, limit: 14)) }
    artists = Query(.artists, cache: cache) { try await api.send(API.Library.artists()) }
    favorites = Query(.favorites, cache: cache, staleAfter: 60) { try await api.send(API.Favorites.list()) }
    playlists = Query(.playlists, cache: cache, staleAfter: 60) { try await api.send(API.Playlists.list()) }
    mixes = Query(.mixes, cache: cache, staleAfter: 30) { try await api.send(API.Mixes.list()) }
    heardLately = Query(.recentAlbums, cache: cache, staleAfter: 60) { try await api.send(API.Library.recentAlbums()) }
    reviewYear = Self.reviewYear(now: now)
    review = reviewYear.map { year in
      Query(.stats(String(year)), cache: cache) { try await api.send(API.Stats.listening(String(year))) }
    }
    rediscover = Self.rediscover(seed: 0, session: session)
  }

  /// Everything at once; each section shows when its answer comes.
  func load() async {
    async let a: Void = health.load()
    async let b: Void = recent.load()
    async let c: Void = artists.load()
    async let d: Void = favorites.load()
    async let e: Void = playlists.load()
    async let f: Void = mixes.load()
    async let g: Void = heardLately.load()
    async let h: Void = rediscover.load()
    async let i: Void = review?.load() ?? ()
    _ = await (a, b, c, d, e, f, g, h, i)
  }

  /// Pull to refresh.
  func refresh() async {
    for query in [health.refresh, recent.refresh, artists.refresh, favorites.refresh, playlists.refresh, mixes.refresh, heardLately.refresh] {
      await query()
    }
  }

  /// "8 tracks across 3 albums, 44 min of music waiting in your library."
  var libraryLine: String? {
    guard let library = health.value?.library else { return nil }
    return "\(library.tracks) tracks across \(library.albums) albums, \(Format.duration(library.durationSeconds)) of music waiting in your library."
  }

  /// Year in review: the year that's ending (December) or just ended (January), if anything was played in it.
  var yearInReview: (year: Int, minutes: Int, top: Artist?)? {
    guard let year = reviewYear, let stats = review?.value, stats.plays > 0, stats.range == String(year) else { return nil }
    return (year, Int(stats.minutes), stats.topArtists.first?.artist)
  }

  /// Your mixes: hidden once the server says there are none.
  var showsMixes: Bool { mixes.value.map { !$0.isEmpty } ?? mixes.isPending }

  /// Jump back in: shown from three albums.
  var jumpBackIn: [Album] { (heardLately.value?.count ?? 0) >= 3 ? heardLately.value ?? [] : [] }

  /// The first five favorites, as songs to play.
  var favoriteTracks: [Track] { (favorites.value ?? []).prefix(5).map(\.track) }

  var shelf: [Artist] { Self.shelfArtists(artists.value, recent: recent.value) }

  /// Rediscover's dice: twelve other albums.
  func reshuffle() async {
    seed += 1
    rediscover = Self.rediscover(seed: seed, session: session)
    await rediscover.load()
  }

  /// Shuffle everything: 300 random songs from the library.
  func shuffleEverything() async {
    do {
      let tracks = try await session.api.send(API.Library.randomTracks(limit: 300))
      session.player.play(tracks, source: PlaySource(label: "Your whole library", href: "/albums"), shuffle: true)
    } catch {
      session.toasts.push(error.localizedDescription, tone: .error)
    }
  }

  /// The song to resume, when one is paused.
  var resumable: Track? {
    session.player.queue.playing ? nil : session.player.queue.currentTrack
  }

  func resume() { session.player.setPlaying(true) }

  static func rediscover(seed: Int, session: AccountSession) -> Query<[Album]> {
    let api = session.api
    return Query(.randomAlbums(seed: seed), cache: session.queries, staleAfter: .infinity) { try await api.send(API.Library.randomAlbums(limit: 12)) }
  }

  /// December: this year. January: last year. Otherwise none.
  static func reviewYear(now: Date, calendar: Calendar = .current) -> Int? {
    let parts = calendar.dateComponents([.year, .month], from: now)
    guard let year = parts.year else { return nil }
    switch parts.month {
    case 12: return year
    case 1: return year - 1
    default: return nil
    }
  }

  /// The artists of the latest albums first, then those with the most albums, never the whole roster.
  static func shelfArtists(_ artists: [Artist]?, recent: [Album]?) -> [Artist] {
    guard let artists else { return [] }
    let byId = Dictionary(artists.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    var picked: [Artist] = []
    var seen = Set<Int>()
    for album in recent ?? [] {
      if let artist = byId[album.artistId], seen.insert(artist.id).inserted { picked.append(artist) }
    }
    for artist in artists.sorted(by: { $0.albumCount > $1.albumCount }) where picked.count < shelfArtistCount {
      if seen.insert(artist.id).inserted { picked.append(artist) }
    }
    return Array(picked.prefix(shelfArtistCount))
  }
}

extension FavoriteTrack {
  /// The favorite as a song to play.
  public var track: Track {
    Track(
      id: id, recordingId: recordingId, fileId: fileId, albumId: albumId, artistId: artistId, title: title,
      artistName: artistName, albumTitle: albumTitle, trackNumber: trackNumber, discNumber: discNumber,
      duration: duration, explicit: explicit, format: format, size: size, streamUrl: streamUrl, coverUrl: coverUrl)
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Home/HomeView.swift`:

```swift
import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// Home (apps/web/src/pages/Home.tsx), every section in the web's order.
struct HomeView: View {
  @State private var model: HomeModel
  @Environment(Theme.self) private var theme
  @Environment(AccountSession.self) private var session

  init(session: AccountSession) {
    _model = State(initialValue: HomeModel(session: session))
  }

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 36) {
        intro
        if model.showsMixes { mixes }
        if let review = model.yearInReview { yearInReview(review) }
        if !model.jumpBackIn.isEmpty { albumShelf(model.jumpBackIn, title: "Jump back in", kicker: "Heard lately") }
        if !model.favoriteTracks.isEmpty { favorites }
        if let playlists = model.playlists.value, !playlists.isEmpty { playlistShelf(playlists) }
        albumShelf(model.recent.value, title: "Recently added", kicker: "Just added", seeAll: .albums(.added))
        artists
        rediscover
      }
      .padding(.vertical, 16)
    }
    .navigationTitle("Playarr")
    .task { await model.load() }
    .refreshable { await model.refresh() }
  }

  private var intro: some View {
    VStack(alignment: .leading, spacing: 20) {
      Text(model.libraryLine ?? "Loading library")
        .font(.callout)
        .foregroundStyle(.secondary)
        .redacted(reason: model.libraryLine == nil ? .placeholder : [])
      FlowLayout(spacing: 12) {
        Button { Task { await model.shuffleEverything() } } label: {
          Label("Shuffle everything", systemImage: "shuffle").padding(.horizontal, 8).padding(.vertical, 6)
        }
        .buttonStyle(.borderedProminent)
        .buttonBorderShape(.capsule)
        .tint(theme.accent.color)
        .foregroundStyle(.black)
        if let track = model.resumable {
          Button { model.resume() } label: {
            HStack(spacing: 10) {
              Cover(path: track.coverUrl, points: 36, label: track.albumTitle, circle: true).frame(width: 36, height: 36)
              VStack(alignment: .leading, spacing: 0) {
                Kicker(text: "Resume")
                Text(track.title).font(.subheadline).lineLimit(1)
              }
              Image(systemName: "play.fill")
            }
            .padding(.trailing, 12)
          }
          .buttonStyle(.bordered)
          .buttonBorderShape(.capsule)
          .accessibilityLabel("Resume \(track.title)")
        }
      }
    }
    .padding(.horizontal, 20)
  }

  private var mixes: some View {
    VStack(alignment: .leading, spacing: 0) {
      SectionHeader(title: "Your mixes", kicker: "Made for you", seeAll: .mixes)
      Shelf {
        if let mixes = model.mixes.value {
          ForEach(mixes, id: \.key) { MixCard(mix: $0) }
        } else {
          ForEach(0..<5, id: \.self) { _ in Skeleton().frame(width: ShelfCard.width) }
        }
      }
    }
  }

  private func yearInReview(_ review: (year: Int, minutes: Int, top: Artist?)) -> some View {
    NavigationLink(value: Route.listening) {
      HStack(spacing: 16) {
        if let top = review.top {
          Cover(path: top.imageUrl, points: 96, label: top.name).frame(width: 96, height: 96)
        }
        VStack(alignment: .leading, spacing: 4) {
          Text("YEAR IN REVIEW").font(.caption2.monospaced()).tracking(2).foregroundStyle(theme.accent.color)
          Text("Your \(String(review.year)) in music").font(.title.weight(.semibold))
          Text("\(review.minutes.formatted()) minutes\(review.top.map { ", most of all \($0.name)" } ?? "")")
            .font(.subheadline).foregroundStyle(.secondary)
        }
      }
      .padding(16)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(RoundedRectangle(cornerRadius: 12).fill(Color.secondary.opacity(0.12)))
    }
    .buttonStyle(.plain)
    .padding(.horizontal, 20)
  }

  private var favorites: some View {
    VStack(alignment: .leading, spacing: 0) {
      SectionHeader(title: "Favorites", kicker: "Songs you love", seeAll: .favorites)
      let tracks = model.favoriteTracks
      ForEach(Array(tracks.enumerated()), id: \.offset) { index, track in
        TrackRow(track: track, style: .mixed) {
          session.player.play(tracks, startAt: index, source: PlaySource(label: "Favorites", href: "/favorites"))
        }
        .padding(.horizontal, 20)
      }
    }
  }

  private func playlistShelf(_ playlists: [PlaylistSummary]) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      SectionHeader(title: "Playlists", kicker: "Made by you", seeAll: .playlists)
      Shelf { ForEach(playlists) { PlaylistCard(playlist: $0) } }
    }
  }

  private func albumShelf(_ albums: [Album]?, title: String, kicker: String, seeAll: Route? = nil) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      SectionHeader(title: title, kicker: kicker, seeAll: seeAll)
      Shelf {
        if let albums {
          ForEach(albums) { AlbumCard(album: $0, width: ShelfCard.width) }
        } else {
          ForEach(0..<6, id: \.self) { _ in Skeleton().frame(width: ShelfCard.width) }
        }
      }
    }
  }

  private var artists: some View {
    VStack(alignment: .leading, spacing: 0) {
      SectionHeader(title: "Artists", kicker: "The roster", seeAll: .artists)
      Shelf { ForEach(model.shelf) { ArtistCard(artist: $0, width: ShelfCard.artistWidth) } }
    }
  }

  private var rediscover: some View {
    VStack(alignment: .leading, spacing: 0) {
      SectionHeader(title: "Rediscover", kicker: "Pulled from the crates") {
        Button { Task { await model.reshuffle() } } label: {
          Image(systemName: "dice")
            .rotationEffect(.degrees(model.rediscover.isFetching ? 180 : 0))
            .animation(.easeInOut(duration: 0.5), value: model.rediscover.isFetching)
            .frame(width: 44, height: 44)
        }
        .accessibilityLabel("Reshuffle")
        .sensoryFeedback(.selection, trigger: model.seed)
      }
      LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 16)], spacing: 24) {
        ForEach(model.rediscover.value ?? []) { AlbumCard(album: $0) }
      }
      .padding(.horizontal, 20)
    }
  }
}
```

**Step 4: Run it to see it pass, and build for the simulator**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter HomeModelTests
swift build --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --triple arm64-apple-ios26.0-simulator --sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" --scratch-path /tmp/playarr-ui-ios
```

Expected: 8 tests pass; the simulator build succeeds.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Home apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/HomeModelTests.swift
git commit -F - <<'MSG'
iOS: Home, every section in the web's order, with Shuffle everything, Resume and Year in review

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 17: Search

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Search/SearchModel.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Search/SearchView.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/SearchModelTests.swift`

`apps/web/src/pages/Search.tsx`: Top result (the first artist), Tracks (six, then "Show all N tracks"), Playlists (names matched here, case- and accent-insensitively, eight at most), Albums, Artists (when more than one); "Not in your crates." when nothing matches; "Try an artist" (the 24 with the most music, then "All N artists") while empty. The view waits 250 ms between keystrokes before asking. The Discover section ("Not in your library") is phase 8: the view leaves a marked place for it below the library's results.

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/SearchModelTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct SearchModelTests {
  @Test func findsSongsAlbumsAndArtists() async {
    let api = FakeAPI.demoLibrary()
    api.on(.get, "/api/search", Demo.search("massive"))
    let model = SearchModel(session: demoSession(api: api))
    model.text = " massive "
    await model.search()
    #expect(model.topArtist?.name == "Massive Attack")
    #expect(model.tracks.count == 5)
    #expect(model.results?.albums.map(\.title) == ["Mezzanine", "Protection"])
    #expect(!model.isEmpty)
  }

  @Test func showsSixSongsThenAll() async {
    let api = FakeAPI.demoLibrary()
    let many = (0..<14).map { i in Demo.tracks[i % Demo.tracks.count] }
    api.on(.get, "/api/search", SearchResults(artists: [], albums: [], tracks: many))
    let model = SearchModel(session: demoSession(api: api))
    model.text = "a"
    await model.search()
    #expect(model.tracks.count == 6)
    #expect(model.showAllLabel == "Show all 14 tracks")
    model.showAllTracks = true
    #expect(model.tracks.count == 14)
    #expect(model.showAllLabel == nil)
  }

  @Test func matchesPlaylistNamesWithoutAccents() async {
    let api = FakeAPI.demoLibrary()
    var café = Demo.playlist
    café.name = "Café del Mar"
    api.on(.get, "/api/playlists", [café, Demo.playlist])
    let model = SearchModel(session: demoSession(api: api))
    await model.loadSuggestions()
    model.text = "CAFE"
    await model.search()
    #expect(model.playlistHits.map(\.name) == ["Café del Mar"])
  }

  @Test func saysWhenNothingMatches() async {
    let api = FakeAPI.demoLibrary()
    api.on(.get, "/api/search", Demo.search("zzz"))
    let model = SearchModel(session: demoSession(api: api))
    model.text = "zzz"
    await model.search()
    #expect(model.isEmpty)
  }

  @Test func suggestsTheArtistsWithTheMostMusic() async {
    let model = SearchModel(session: demoSession())
    await model.loadSuggestions()
    #expect(model.suggestions.map(\.name) == ["Massive Attack", "Portishead"])
    #expect(model.allArtistsLabel == nil)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter SearchModelTests
```

Expected: the build fails with `cannot find 'SearchModel' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Search/SearchModel.swift`:

```swift
import Foundation
import Observation
import PlayarrAPI

/// Search, as apps/web/src/pages/Search.tsx: the library's answer (top artist, songs, albums, artists) plus playlist
/// names matched here, accent-insensitively; "Try an artist" while empty. Discover ("Not in your library") is phase 8.
@MainActor @Observable
final class SearchModel {
  /// Songs shown before "Show all".
  static let tracksShown = 6
  /// Artists suggested while the field is empty.
  static let suggestedCount = 24
  static let playlistHitsShown = 8

  var text = ""
  private(set) var results: SearchResults?
  private(set) var searched = ""
  private(set) var isSearching = false
  private(set) var error: String?
  var showAllTracks = false

  let artists: Query<[Artist]>
  let playlists: Query<[PlaylistSummary]>

  @ObservationIgnored private let session: AccountSession

  init(session: AccountSession) {
    self.session = session
    let api = session.api
    artists = Query(.artists, cache: session.queries) { try await api.send(API.Library.artists()) }
    playlists = Query(.playlists, cache: session.queries, staleAfter: 60) { try await api.send(API.Playlists.list()) }
  }

  var query: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

  func loadSuggestions() async {
    await artists.load()
    await playlists.load()
  }

  /// Asks the library for what's typed (the view waits a moment between keystrokes before calling this).
  func search() async {
    let q = query
    showAllTracks = false
    guard !q.isEmpty else {
      results = nil
      searched = ""
      return
    }
    if let hit = session.queries.cached(.search(q), as: SearchResults.self) {
      results = hit.value
      searched = q
    }
    isSearching = true
    defer { isSearching = false }
    do {
      let api = session.api
      let answer = try await session.queries.fetch(.search(q)) { try await api.send(API.Search.library(q)) }
      guard q == query else { return }
      results = answer
      searched = q
      error = nil
    } catch is CancellationError {
    } catch {
      self.error = error.localizedDescription
    }
  }

  var topArtist: Artist? { results?.artists.first }

  var tracks: [Track] {
    guard let tracks = results?.tracks else { return [] }
    return showAllTracks ? tracks : Array(tracks.prefix(Self.tracksShown))
  }

  /// "Show all 14 tracks", when there are more than six.
  var showAllLabel: String? {
    guard !showAllTracks, let count = results?.tracks.count, count > Self.tracksShown else { return nil }
    return "Show all \(count) tracks"
  }

  /// Playlists whose names match what's typed (matched here, as the server's search doesn't look at them).
  var playlistHits: [PlaylistSummary] {
    let want = Self.fold(query)
    guard !want.isEmpty else { return [] }
    return Array((playlists.value ?? []).filter { Self.fold($0.name).contains(want) }.prefix(Self.playlistHitsShown))
  }

  /// The library has nothing for what was typed.
  var isEmpty: Bool {
    guard let results, !searched.isEmpty else { return false }
    return results.artists.isEmpty && results.albums.isEmpty && results.tracks.isEmpty && playlistHits.isEmpty
  }

  /// "Try an artist": those with the most music.
  var suggestions: [Artist] {
    let all = artists.value ?? []
    return Array(all.sorted { ($0.albumCount, $0.trackCount) > ($1.albumCount, $1.trackCount) }.prefix(Self.suggestedCount))
  }

  /// "All 312 artists", when there are more than the suggestions.
  var allArtistsLabel: String? {
    guard let count = artists.value?.count, count > Self.suggestedCount else { return nil }
    return "All \(count) artists"
  }

  /// Case- and accent-insensitive text, for matching playlist names.
  static func fold(_ text: String) -> String {
    text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil).trimmingCharacters(in: .whitespacesAndNewlines)
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Search/SearchView.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// Search (apps/web/src/pages/Search.tsx).
struct SearchView: View {
  @State private var model: SearchModel
  @Environment(AccountSession.self) private var session

  init(session: AccountSession) {
    _model = State(initialValue: SearchModel(session: session))
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 32) {
        if model.query.isEmpty {
          suggestions
        } else if model.isEmpty {
          notFound
        } else if model.results != nil {
          results
        }
        // Phase 8: "Not in your library" (Discover) goes here, below the library's results.
      }
      .padding(.vertical, 16)
    }
    .navigationTitle("Search")
    .searchable(text: $model.text, prompt: "Artists, albums, tracks")
    .overlay(alignment: .top) { if model.isSearching { ProgressView().padding(.top, 4) } }
    .task { await model.loadSuggestions() }
    .task(id: model.text) {
      // A moment between keystrokes: typing doesn't ask for every letter.
      try? await Task.sleep(for: .milliseconds(250))
      if !Task.isCancelled { await model.search() }
    }
  }

  private var suggestions: some View {
    VStack(alignment: .leading, spacing: 12) {
      if !model.suggestions.isEmpty {
        Kicker(text: "Try an artist")
        FlowLayout {
          ForEach(model.suggestions) { Chip(text: $0.name, route: .artist($0.id)) }
          if let all = model.allArtistsLabel { Chip(text: all, route: .artists) }
        }
      }
    }
    .padding(.horizontal, 20)
  }

  private var notFound: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("Not in your crates.").font(.title.weight(.semibold))
      Text("Nothing in your library matches “\(model.searched)”.").font(.subheadline).foregroundStyle(.secondary)
    }
    .padding(.horizontal, 20)
  }

  @ViewBuilder private var results: some View {
    if let top = model.topArtist {
      VStack(alignment: .leading, spacing: 0) {
        SectionHeader(title: "Top result")
        NavigationLink(value: Route.artist(top.id)) {
          HStack(spacing: 16) {
            Cover(path: top.imageUrl, points: 96, label: top.name, circle: true).frame(width: 96, height: 96)
            VStack(alignment: .leading, spacing: 4) {
              Text(top.name).font(.title.weight(.semibold))
              Kicker(text: "Artist")
            }
            Spacer()
          }
          .padding(16)
          .background(RoundedRectangle(cornerRadius: 10).fill(Color.secondary.opacity(0.08)))
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 20)
      }
    }
    if !model.tracks.isEmpty {
      VStack(alignment: .leading, spacing: 0) {
        SectionHeader(title: "Tracks")
        let tracks = model.tracks
        ForEach(Array(tracks.enumerated()), id: \.offset) { index, track in
          TrackRow(track: track, style: .mixed) { session.player.play(tracks, startAt: index) }
            .padding(.horizontal, 20)
        }
        if let label = model.showAllLabel {
          Button { model.showAllTracks = true } label: { Kicker(text: label) }
            .padding(.horizontal, 20)
            .padding(.top, 8)
        }
      }
    }
    if !model.playlistHits.isEmpty {
      VStack(alignment: .leading, spacing: 0) {
        SectionHeader(title: "Playlists")
        FlowLayout { ForEach(model.playlistHits) { Chip(text: "\($0.name) · \($0.trackCount)", route: .playlist($0.id)) } }
          .padding(.horizontal, 20)
      }
    }
    if let albums = model.results?.albums, !albums.isEmpty {
      VStack(alignment: .leading, spacing: 0) {
        SectionHeader(title: "Albums")
        Shelf { ForEach(albums) { AlbumCard(album: $0, width: ShelfCard.width) } }
      }
    }
    if let artists = model.results?.artists, artists.count > 1 {
      VStack(alignment: .leading, spacing: 0) {
        SectionHeader(title: "Artists")
        Shelf { ForEach(artists) { ArtistCard(artist: $0, width: ShelfCard.artistWidth) } }
      }
    }
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter SearchModelTests
```

Expected: 5 tests pass.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Search apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/SearchModelTests.swift
git commit -F - <<'MSG'
iOS: Search: top result, songs, playlists matched by name, albums and artists, and artists to try

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 18: The Library tab, Artists and Albums

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Library/AlbumsModel.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Library/LibraryView.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Library/ArtistsView.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Library/AlbumsView.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/PlaceholderPage.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/AlbumsModelTests.swift`

`apps/web/src/pages/Library.tsx`: Made for you, Your listening, Favorites (N songs), Artists (count), Albums (count), Settings, then the playlists. Downloads (phase 7) and Requests (phase 8) join when they exist; "New playlist" comes with playlists (phase 6). The account button in the bar opens phase 2's account switcher. Albums sort by Artist, Title, Year or Recently added from a menu in the bar (`apps/web/src/pages/Albums.tsx`).

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/AlbumsModelTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct AlbumsModelTests {
  @Test func asksForTheSortChosen() async {
    let api = FakeAPI.demoLibrary()
    let model = AlbumsModel(session: demoSession(api: api), sort: .artist)
    await model.albums.load()
    model.sort = .added
    await model.albums.load()
    #expect(model.albums.key == .albums(.added))
    #expect(model.albums.value?.count == 3)
    #expect(api.calls(.get, "/api/albums").count == 2)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter AlbumsModelTests
```

Expected: the build fails with `cannot find 'AlbumsModel' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Library/AlbumsModel.swift`:

```swift
import Foundation
import Observation
import PlayarrAPI

/// Albums, sorted by Artist, Title, Year or Recently added (apps/web/src/pages/Albums.tsx).
@MainActor @Observable
final class AlbumsModel {
  static let sorts: [(sort: AlbumSort, label: String)] = [(.artist, "Artist"), (.title, "Title"), (.year, "Year"), (.added, "Recently added")]

  var sort: AlbumSort {
    didSet { albums = Self.query(sort, session: session) }
  }
  private(set) var albums: Query<[Album]>

  @ObservationIgnored private let session: AccountSession

  init(session: AccountSession, sort: AlbumSort) {
    self.session = session
    self.sort = sort
    albums = Self.query(sort, session: session)
  }

  static func query(_ sort: AlbumSort, session: AccountSession) -> Query<[Album]> {
    let api = session.api
    return Query(.albums(sort), cache: session.queries) { try await api.send(API.Library.albums(sort: sort)) }
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Library/LibraryView.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// The Library tab (apps/web/src/pages/Library.tsx): everything that's yours in one place, and your playlists.
/// Downloads (phase 7) and Requests (phase 8) join the rows when they exist.
struct LibraryView: View {
  @State private var health: Query<HealthStatus>
  @State private var favorites: Query<[FavoriteTrack]>
  @State private var playlists: Query<[PlaylistSummary]>
  @Environment(AppModel.self) private var app
  @Environment(Theme.self) private var theme

  init(session: AccountSession) {
    let api = session.api
    _health = State(initialValue: Query(.health, cache: session.queries, staleAfter: 30) { try await api.send(API.Server.health()) })
    _favorites = State(initialValue: Query(.favorites, cache: session.queries, staleAfter: 60) { try await api.send(API.Favorites.list()) })
    _playlists = State(initialValue: Query(.playlists, cache: session.queries, staleAfter: 60) { try await api.send(API.Playlists.list()) })
  }

  var body: some View {
    let library = health.value?.library
    List {
      Section {
        row("Made for you", "sparkles", .mixes)
        row("Your listening", "chart.bar", .listening)
        row("Favorites", "heart", .favorites, detail: favorites.value.map { Format.plural($0.count, "song") })
        row("Artists", "music.mic", .artists, detail: library.map { String($0.artists) })
        row("Albums", "square.stack", .albums(.artist), detail: library.map { String($0.albums) })
        // Phase 9 finds Settings by this identifier.
        row("Settings", "gearshape", .settings).accessibilityIdentifier("settings")
      }
      if let playlists = playlists.value, !playlists.isEmpty {
        Section("Playlists") {
          ForEach(playlists) { playlist in
            NavigationLink(value: Route.playlist(playlist.id)) {
              HStack(spacing: 14) {
                PlaylistCover(cover: playlist.cover, points: 56, name: playlist.name).frame(width: 56, height: 56)
                VStack(alignment: .leading) {
                  Text(playlist.name).lineLimit(1)
                  Text(Format.plural(playlist.trackCount, "song")).font(.caption.monospaced()).foregroundStyle(.secondary)
                }
              }
            }
          }
        }
      }
    }
    .navigationTitle("Library")
    .toolbar {
      ToolbarItem(placement: .primaryAction) {
        Button("Accounts", systemImage: "person.crop.circle") { app.showingAccounts = true }
      }
    }
    .task {
      await health.load()
      await favorites.load()
      await playlists.load()
    }
    .refreshable {
      await health.refresh()
      await favorites.refresh()
      await playlists.refresh()
    }
  }

  private func row(_ title: String, _ icon: String, _ route: Route, detail: String? = nil) -> some View {
    NavigationLink(value: route) {
      HStack(spacing: 14) {
        Image(systemName: icon)
          .foregroundStyle(theme.accent.color)
          .frame(width: 40, height: 40)
          .background(RoundedRectangle(cornerRadius: 6).fill(Color.secondary.opacity(0.15)))
        Text(title)
        Spacer()
        if let detail { Text(detail).font(.caption.monospaced()).foregroundStyle(.secondary) }
      }
    }
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Library/ArtistsView.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// Every artist (apps/web/src/pages/Artists.tsx).
struct ArtistsView: View {
  @State private var artists: Query<[Artist]>

  init(session: AccountSession) {
    let api = session.api
    _artists = State(initialValue: Query(.artists, cache: session.queries) { try await api.send(API.Library.artists()) })
  }

  var body: some View {
    ScrollView {
      if let error = artists.error {
        ErrorState(message: error) { await artists.refresh() }
      } else {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 16)], spacing: 16) {
          if let all = artists.value {
            ForEach(all) { ArtistCard(artist: $0) }
          } else {
            ForEach(0..<8, id: \.self) { _ in Skeleton(aspectRatio: 4 / 5) }
          }
        }
        .padding(20)
      }
    }
    .navigationTitle("Artists")
    .navigationSubtitle(artists.value.map { Format.plural($0.count, "artist") } ?? "")
    .task { await artists.load() }
    .refreshable { await artists.refresh() }
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Library/AlbumsView.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// Every album, sorted by Artist, Title, Year or Recently added (apps/web/src/pages/Albums.tsx).
struct AlbumsView: View {
  @State private var model: AlbumsModel

  init(session: AccountSession, sort: AlbumSort) {
    _model = State(initialValue: AlbumsModel(session: session, sort: sort))
  }

  var body: some View {
    ScrollView {
      if let error = model.albums.error {
        ErrorState(message: error) { await model.albums.refresh() }
      } else {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 16)], spacing: 24) {
          if let albums = model.albums.value {
            ForEach(albums) { AlbumCard(album: $0) }
          } else {
            ForEach(0..<12, id: \.self) { _ in Skeleton() }
          }
        }
        .padding(20)
      }
    }
    .navigationTitle("Albums")
    .navigationSubtitle(model.albums.value.map { Format.plural($0.count, "album") } ?? "")
    .toolbar {
      ToolbarItem(placement: .primaryAction) {
        Menu {
          Picker("Sort albums", selection: $model.sort) {
            ForEach(AlbumsModel.sorts, id: \.sort) { Text($0.label).tag($0.sort) }
          }
        } label: {
          Label("Sort albums", systemImage: "arrow.up.arrow.down")
        }
      }
    }
    .task(id: model.sort) { await model.albums.load() }
    .refreshable { await model.albums.refresh() }
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/PlaceholderPage.swift`:

```swift
import SwiftUI

/// A page the app doesn't have yet (later phases replace these one by one).
struct PlaceholderPage: View {
  let title: String

  var body: some View {
    ContentUnavailableView(title, systemImage: "hammer", description: Text("Not in the app yet: use Playarr on the web for this for now."))
      .navigationTitle(title)
  }
}
```

**Step 4: Run it to see it pass, and build for the simulator**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter AlbumsModelTests
swift build --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --triple arm64-apple-ios26.0-simulator --sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" --scratch-path /tmp/playarr-ui-ios
```

Expected: 1 test passes; the simulator build succeeds (`navigationSubtitle` is iOS 26).

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Library apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/PlaceholderPage.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/AlbumsModelTests.swift
git commit -F - <<'MSG'
iOS: the Library tab, every artist, and every album sorted four ways

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 19: An artist

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Artist/ArtistModel.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Artist/ArtistView.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/ArtistModelTests.swift`

`apps/web/src/pages/Artist.tsx`: a hero (the wide fanart, or the square photo blurred), genres, Play and Shuffle (every song of the artist, "Play means in order"), the albums grouped as Albums, Soundtracks, EPs & Singles, Live & Compilations and Loose songs, similar artists in the library (ListenBrainz, `apps/web/src/components/SimilarArtists.tsx`), and About with "Read more". "Not in your library" and similar artists to discover open MusicBrainz pages (phase 8): the view leaves a marked place.

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/ArtistModelTests.swift`:

```swift
import Foundation
import PlayarrAPI
import PlayarrPlayer
import Testing
@testable import PlayarrUI

@MainActor @Suite struct ArtistModelTests {
  func album(_ id: Int, type: String = "Album", secondary: [String] = []) -> Album {
    Album(id: id, title: "\(id)", artistId: 1, artistName: "", albumType: type, secondaryTypes: secondary, genres: [], duration: 0, trackCount: 1, totalTrackCount: 1)
  }

  @Test func groupsAlbumsAsTheWebDoes() {
    let groups = ArtistModel.groups([
      album(1), album(2, type: "EP"), album(3, secondary: ["Soundtrack"]), album(4, secondary: ["Live"]),
      album(5, type: "Single"), album(6, type: "Loose"), album(7, secondary: ["Compilation"]),
    ])
    #expect(groups.map(\.title) == ["Albums", "Soundtracks", "EPs & Singles", "Live & Compilations", "Loose songs"])
    #expect(groups.map { $0.albums.map(\.id) } == [[1], [3], [2, 5], [4, 7], [6]])
  }

  @Test func showsSimilarArtistsInTheLibrary() async {
    let model = ArtistModel(id: 7, session: demoSession())
    await model.load()
    #expect(model.similarInLibrary.map(\.name) == ["Portishead"])
    #expect(model.counts == "2 albums · 5 tracks")
    #expect(model.kicker == "trip hop")
  }

  @Test func playsEverySongOfTheArtistInOrder() async {
    let session = demoSession()
    let model = ArtistModel(id: 7, session: session)
    await model.play()
    #expect(session.player.queue.queue.map(\.artistName).allSatisfy { $0 == "Massive Attack" })
    #expect(session.player.queue.source == PlaySource(label: "Massive Attack", href: "/artists/7"))
    #expect(!session.player.queue.shuffle)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter ArtistModelTests
```

Expected: the build fails with `cannot find 'ArtistModel' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Artist/ArtistModel.swift`:

```swift
import Foundation
import Observation
import PlayarrAPI
import PlayarrPlayer

/// An artist, as apps/web/src/pages/Artist.tsx: Play and Shuffle, the albums in groups, similar artists in the
/// library (from ListenBrainz), and About. "Not in your library" and similar artists to discover are phase 8.
@MainActor @Observable
final class ArtistModel {
  struct Group: Equatable {
    let title: String
    let albums: [Album]
  }

  let id: Int
  let artist: Query<ArtistDetail>
  private(set) var similar: Query<[DiscoverArtist]>?
  var bioOpen = false

  @ObservationIgnored private let session: AccountSession

  init(id: Int, session: AccountSession) {
    self.id = id
    self.session = session
    let api = session.api
    artist = Query(.artist(id), cache: session.queries) { try await api.send(API.Library.artist(id: id)) }
  }

  func load() async {
    await artist.load()
    if similar == nil, let mbid = artist.value?.mbid {
      let api = session.api
      similar = Query(.similarArtists(mbid), cache: session.queries, staleAfter: 60 * 60) { try await api.send(API.Discover.similarArtists(mbid: mbid)) }
    }
    await similar?.load()
  }

  var groups: [Group] { Self.groups(artist.value?.albums ?? []) }

  /// Similar artists with music in the library (their pages open here).
  var similarInLibrary: [DiscoverArtist] { (similar?.value ?? []).filter { $0.artistId != nil } }

  /// "2 albums · 5 tracks".
  var counts: String? {
    artist.value.map { "\(Format.plural($0.albumCount, "album")) · \(Format.plural($0.trackCount, "track"))" }
  }

  /// "trip hop · electronic", or "Artist".
  var kicker: String {
    let genres = artist.value?.genres.prefix(3) ?? []
    return genres.isEmpty ? "Artist" : genres.joined(separator: " · ")
  }

  func play(shuffle: Bool = false) async {
    do {
      let api = session.api
      let id = self.id
      let tracks = try await session.queries.fetch(.artistTracks(id)) { try await api.send(API.Library.artistTracks(id: id)) }
      let source = tracks.first.map { PlaySource(label: $0.artistName, href: "/artists/\(id)") }
      session.player.play(tracks, source: source, shuffle: shuffle)
    } catch {
      session.toasts.push(error.localizedDescription, tone: .error)
    }
  }

  /// Albums, Soundtracks, EPs & Singles, Live & Compilations, Loose songs (empty groups left out).
  static func groups(_ albums: [Album]) -> [Group] {
    var buckets: [[Album]] = Array(repeating: [], count: 5)
    for album in albums {
      let secondary = album.secondaryTypes.map { $0.lowercased() }
      let index =
        if album.albumType == "Loose" { 4 }
        else if secondary.contains("soundtrack") { 1 }
        else if secondary.contains(where: ["live", "compilation", "remix", "dj-mix", "mixtape/street"].contains) { 3 }
        else if album.albumType == "EP" || album.albumType == "Single" { 2 }
        else { 0 }
      buckets[index].append(album)
    }
    let titles = ["Albums", "Soundtracks", "EPs & Singles", "Live & Compilations", "Loose songs"]
    return zip(titles, buckets).compactMap { title, albums in albums.isEmpty ? nil : Group(title: title, albums: albums) }
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Artist/ArtistView.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// An artist (apps/web/src/pages/Artist.tsx).
struct ArtistView: View {
  @State private var model: ArtistModel
  @Environment(Theme.self) private var theme

  init(id: Int, session: AccountSession) {
    _model = State(initialValue: ArtistModel(id: id, session: session))
  }

  var body: some View {
    ScrollView {
      if let error = model.artist.error {
        ErrorState(message: error) { await model.artist.refresh() }
      } else if let artist = model.artist.value {
        VStack(alignment: .leading, spacing: 32) {
          hero(artist)
          ForEach(model.groups, id: \.title) { group in
            VStack(alignment: .leading, spacing: 0) {
              SectionHeader(title: group.title, kicker: Format.plural(group.albums.count, "release"))
              LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 16)], spacing: 24) {
                ForEach(group.albums) { AlbumCard(album: $0) }
              }
              .padding(.horizontal, 20)
            }
          }
          // Phase 8: "Not in your library" (the rest of the discography, with Request) goes here.
          similar
          if let overview = artist.overview { about(overview) }
        }
        .padding(.bottom, 24)
      } else {
        VStack(alignment: .leading, spacing: 16) {
          Skeleton(aspectRatio: nil, height: 360)
          Skeleton(aspectRatio: nil, height: 16).frame(width: 180).padding(.horizontal, 20)
        }
      }
    }
    .ignoresSafeArea(edges: .top)
    .inlineTitle()
    .task { await model.load() }
    .refreshable { await model.artist.refresh() }
  }

  private func hero(_ artist: ArtistDetail) -> some View {
    ZStack(alignment: .bottomLeading) {
      if let fanart = artist.fanartUrl {
        Cover(path: fanart, points: 600).aspectRatio(contentMode: .fill).frame(height: 380).clipped()
      } else {
        // No wide photo: the square one as a soft, blurred backdrop.
        Cover(path: artist.imageUrl, points: 240, label: artist.name)
          .aspectRatio(contentMode: .fill).frame(height: 380).clipped().blur(radius: 40).opacity(0.6).saturation(1.5)
      }
      LinearGradient(colors: [.clear, .black.opacity(0.45), .black], startPoint: .top, endPoint: .bottom)
      VStack(alignment: .leading, spacing: 12) {
        Kicker(text: model.kicker)
        Text(artist.name).font(.system(.largeTitle, design: .serif, weight: .bold)).lineLimit(2).minimumScaleFactor(0.5)
          .accessibilityAddTraits(.isHeader)
        HStack(spacing: 12) {
          Button { Task { await model.play() } } label: { Label("Play", systemImage: "play.fill").padding(.horizontal, 6) }
            .buttonStyle(.borderedProminent).tint(theme.accent.color).foregroundStyle(.black)
          Button { Task { await model.play(shuffle: true) } } label: { Label("Shuffle", systemImage: "shuffle") }
            .buttonStyle(.bordered)
          if let counts = model.counts { Text(counts).font(.caption.monospaced()).foregroundStyle(.secondary) }
        }
        .buttonBorderShape(.capsule)
      }
      .padding(20)
    }
    .frame(height: 380)
  }

  @ViewBuilder private var similar: some View {
    if model.similar?.error != nil {
      VStack(alignment: .leading, spacing: 0) {
        SectionHeader(title: "Similar artists", kicker: "From ListenBrainz")
        Text("Couldn’t reach ListenBrainz for similar artists right now.").font(.subheadline).foregroundStyle(.secondary).padding(.horizontal, 20)
      }
    } else if !model.similarInLibrary.isEmpty {
      VStack(alignment: .leading, spacing: 0) {
        SectionHeader(title: "Similar artists in your library", kicker: "From ListenBrainz")
        Shelf {
          ForEach(model.similarInLibrary, id: \.mbid) { artist in
            if let id = artist.artistId {
              NavigationLink(value: Route.artist(id)) {
                VStack(spacing: 8) {
                  Cover(path: artist.imageUrl, points: 140, label: artist.name, circle: true)
                  Text(artist.name).font(.subheadline).lineLimit(1)
                }
                .frame(width: 140)
              }
              .buttonStyle(.plain)
              .accessibilityLabel(artist.name)
            }
          }
        }
      }
    }
  }

  private func about(_ overview: String) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      SectionHeader(title: "About")
      Text(overview).font(.callout).foregroundStyle(.secondary).lineLimit(model.bioOpen ? nil : 5).padding(.horizontal, 20)
      Button { model.bioOpen.toggle() } label: { Kicker(text: model.bioOpen ? "Less" : "Read more") }
        .padding(.horizontal, 20)
    }
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter ArtistModelTests
```

Expected: 3 tests pass.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Artist apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/ArtistModelTests.swift
git commit -F - <<'MSG'
iOS: an artist's page: Play and Shuffle, albums in the web's groups, similar artists and About

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 20: An album

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Album/AlbumModel.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Album/AlbumView.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/AlbumModelTests.swift`

`apps/web/src/pages/Album.tsx` and `components/TrackList.tsx`: a header tinted with the album's own colour, "Album · 1998", the artist, "3 tracks · 17 min · 2 missing · added 3 days ago" and the format badge; Play/Pause/Resume, Shuffle and ⋯ (Play next, Add to queue, Go to artist); the songs with a header per disc when there are several and the missing songs greyed out in their place; liner notes; More by the artist. Download (phase 7), Add to playlist (phase 6) and "Request the rest" (phase 8) have marked places.

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/AlbumModelTests.swift`:

```swift
import Foundation
import PlayarrAPI
import PlayarrPlayer
import Testing
@testable import PlayarrUI

@MainActor @Suite struct AlbumModelTests {
  @Test func putsMissingSongsInTheirPlace() {
    let rows = AlbumModel.rows(Demo.mezzanine)
    let titles = rows.map { row -> String in
      switch row {
      case .disc(let n): "Disc \(n)"
      case .track(let track, _): track.title
      case .missing(let missing): "(\(missing.title))"
      }
    }
    #expect(titles == ["Angel", "Risingson", "(Teardrop)", "Inertia Creeps", "(Exchange)"])
  }

  @Test func headsEachDiscWhenThereAreSeveral() {
    let rows = AlbumModel.rows(Demo.dummy)
    #expect(rows.first == .disc(1))
    #expect(rows.filter { if case .disc = $0 { true } else { false } } == [.disc(1), .disc(2)])
    #expect(AlbumModel.rows(Demo.protection).allSatisfy { if case .disc = $0 { false } else { true } })
  }

  @Test func describesTheAlbum() async {
    let model = AlbumModel(id: 70, session: demoSession())
    await model.load()
    #expect(model.kicker == "Album · 1998")
    #expect(model.details(now: Format.parseDate("2026-11-04T12:00:00Z")!) == "3 tracks · 17 min · 2 missing · added 3 days ago")
    #expect(model.moreByArtist.map(\.title) == ["Protection"])
  }

  @Test func playsPausesAndResumes() async {
    let session = demoSession()
    let model = AlbumModel(id: 70, session: session)
    await model.load()
    #expect(model.playLabel == "Play")
    model.playOrPause()
    #expect(session.player.queue.source == PlaySource(label: "Mezzanine", href: "/albums/70"))
    #expect(model.playLabel == "Pause")
    model.playOrPause()
    #expect(model.playLabel == "Resume")
  }

  @Test func aSongTappedPlaysTheAlbumFromThere() async {
    let session = demoSession()
    let model = AlbumModel(id: 70, session: session)
    await model.load()
    model.tap(Demo.mezzanineTracks[1], index: 1)
    #expect(session.player.queue.currentTrack?.title == "Risingson")
    #expect(session.player.queue.queue.count == 3)
    model.shuffle()
    #expect(session.player.queue.shuffle)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter AlbumModelTests
```

Expected: the build fails with `cannot find 'AlbumModel' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Album/AlbumModel.swift`:

```swift
import Foundation
import Observation
import PlayarrAPI
import PlayarrPlayer

/// An album, as apps/web/src/pages/Album.tsx: header, Play/Pause/Resume, Shuffle, ⋯, the songs with disc headers and
/// missing songs greyed out in their place, liner notes and more by the artist. "Request the rest" is phase 8.
@MainActor @Observable
final class AlbumModel {
  enum Row: Equatable, Identifiable {
    case disc(Int)
    case track(Track, index: Int)
    case missing(MissingTrack)

    var id: String {
      switch self {
      case .disc(let n): "disc-\(n)"
      case .track(let track, let index): "track-\(track.id)-\(index)"
      case .missing(let missing): "missing-\(missing.recordingId)-\(missing.discNumber)-\(missing.trackNumber)"
      }
    }
  }

  let id: Int
  let album: Query<AlbumDetail>
  private(set) var artist: Query<ArtistDetail>?
  /// The cover's own colour, for the header's tint.
  private(set) var tint: RGB?

  @ObservationIgnored private let session: AccountSession
  @ObservationIgnored private let theme: Theme?

  init(id: Int, session: AccountSession, theme: Theme? = nil) {
    self.id = id
    self.session = session
    self.theme = theme
    let api = session.api
    album = Query(.album(id), cache: session.queries) { try await api.send(API.Library.album(id: id)) }
  }

  func load() async {
    await album.load()
    guard let detail = album.value else { return }
    if artist == nil {
      let api = session.api
      let artistId = detail.artistId
      artist = Query(.artist(artistId), cache: session.queries) { try await api.send(API.Library.artist(id: artistId)) }
    }
    await artist?.load()
    tint = await theme?.accent(of: detail.coverUrl, images: session.images)
  }

  var rows: [Row] {
    guard let album = album.value else { return [] }
    return Self.rows(album)
  }

  /// "Album · 1998".
  var kicker: String? {
    guard let album = album.value else { return nil }
    let kind = album.secondaryTypes.first ?? album.albumType
    return album.year.map { "\(kind) · \($0)" } ?? kind
  }

  /// "3 tracks · 17 min · 2 missing · added 3 days ago".
  func details(now: Date = Date()) -> String? {
    guard let album = album.value else { return nil }
    var parts = [Format.plural(album.trackCount, "track"), Format.duration(album.duration)]
    if album.trackCount < album.totalTrackCount { parts.append("\(album.totalTrackCount - album.trackCount) missing") }
    if let added = album.addedAt.flatMap({ Format.addedAgo($0, now: now) }) { parts.append("added \(added)") }
    return parts.joined(separator: " · ")
  }

  /// More by the artist: their other albums.
  var moreByArtist: [Album] { (artist?.value?.albums ?? []).filter { $0.id != id } }

  var isCurrent: Bool { session.player.queue.currentTrack?.albumId == id }
  var isPlaying: Bool { isCurrent && session.player.queue.playing }

  /// "Pause", "Resume" or "Play".
  var playLabel: String { isPlaying ? "Pause" : isCurrent ? "Resume" : "Play" }

  var source: PlaySource? { album.value.map { PlaySource(label: $0.title, href: "/albums/\($0.id)") } }

  /// The big button: pause or resume this album, or play it from the start, in order.
  func playOrPause() {
    if isCurrent {
      session.player.togglePlay()
    } else if let album = album.value {
      session.player.play(album.tracks, source: source)
    }
  }

  func shuffle() {
    guard let album = album.value else { return }
    session.player.play(album.tracks, source: source, shuffle: true)
  }

  /// A song tapped: pause or resume it if it's the one playing, else play the album from there.
  func tap(_ track: Track, index: Int) {
    if session.player.queue.currentTrack?.fileId == track.fileId {
      session.player.togglePlay()
    } else if let album = album.value {
      session.player.play(album.tracks, startAt: index, source: source)
    }
  }

  /// The album's songs and missing songs in disc and track order, with a header before each disc when there are several.
  static func rows(_ album: AlbumDetail) -> [Row] {
    let songs: [(disc: Int, number: Int, row: Row)] =
      album.tracks.enumerated().map { ($1.discNumber, $1.trackNumber, .track($1, index: $0)) }
      + album.missingTracks.map { ($0.discNumber, $0.trackNumber, .missing($0)) }
    let sorted = album.missingTracks.isEmpty ? songs : songs.sorted { ($0.disc, $0.number) < ($1.disc, $1.number) }
    var rows: [Row] = []
    var disc: Int?
    for song in sorted {
      if album.discCount > 1, song.disc != disc { rows.append(.disc(song.disc)) }
      disc = song.disc
      rows.append(song.row)
    }
    return rows
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Album/AlbumView.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// An album (apps/web/src/pages/Album.tsx).
struct AlbumView: View {
  @State private var model: AlbumModel
  @Environment(AccountSession.self) private var session
  @Environment(Theme.self) private var theme

  init(id: Int, session: AccountSession, theme: Theme) {
    _model = State(initialValue: AlbumModel(id: id, session: session, theme: theme))
  }

  var body: some View {
    ScrollView {
      if let error = model.album.error {
        ErrorState(message: error) { await model.album.refresh() }
      } else if let album = model.album.value {
        VStack(alignment: .leading, spacing: 24) {
          header(album)
          buttons(album)
          songs
          if let overview = album.overview { linerNotes(overview) }
          if !model.moreByArtist.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
              SectionHeader(title: "More by \(album.artistName)", kicker: "Discography", seeAll: .artist(album.artistId))
              Shelf { ForEach(model.moreByArtist) { AlbumCard(album: $0, width: ShelfCard.width) } }
            }
          }
        }
        .padding(.bottom, 24)
        .background(alignment: .top) { tint }
      } else {
        VStack(spacing: 16) {
          Skeleton().frame(width: 260)
          ForEach(0..<8, id: \.self) { _ in Skeleton(aspectRatio: nil, height: 36) }
        }
        .padding(20)
      }
    }
    .inlineTitle()
    .task { await model.load() }
    .refreshable { await model.album.refresh() }
  }

  /// The header's wash, tinted with the album's own colour.
  @ViewBuilder private var tint: some View {
    if let tint = model.tint {
      LinearGradient(
        stops: [.init(color: tint.color.opacity(0.32), location: 0), .init(color: tint.color.opacity(0.08), location: 0.55), .init(color: .clear, location: 1)],
        startPoint: .top, endPoint: .bottom
      )
      .frame(height: 520)
      .ignoresSafeArea()
    }
  }

  private func header(_ album: AlbumDetail) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      Cover(path: album.coverUrl, points: 280, label: album.title)
        .frame(maxWidth: 280)
        .frame(maxWidth: .infinity)
        .shadow(color: .black.opacity(0.6), radius: 24, y: 16)
        .padding(.bottom, 8)
      if let kicker = model.kicker { Kicker(text: kicker) }
      Text(album.title).font(.system(.largeTitle, design: .serif, weight: .bold)).accessibilityAddTraits(.isHeader)
      NavigationLink(value: Route.artist(album.artistId)) {
        HStack(spacing: 8) {
          if let image = model.artist?.value?.imageUrl {
            Cover(path: image, points: 24, circle: true).frame(width: 24, height: 24)
          }
          Text(album.artistName)
        }
      }
      .buttonStyle(.plain)
      HStack(spacing: 8) {
        if let details = model.details() { Text(details).font(.caption.monospaced()).foregroundStyle(.secondary) }
        FormatBadge(format: album.format)
      }
    }
    .padding(.horizontal, 20)
  }

  private func buttons(_ album: AlbumDetail) -> some View {
    HStack(spacing: 12) {
      Button { model.playOrPause() } label: {
        Label(model.playLabel, systemImage: model.isPlaying ? "pause.fill" : "play.fill").padding(.horizontal, 6)
      }
      .buttonStyle(.borderedProminent)
      .tint(theme.accent.color)
      .foregroundStyle(.black)
      .accessibilityLabel("\(model.playLabel) \(album.title)")
      .sensoryFeedback(.selection, trigger: model.isPlaying)
      Button { model.shuffle() } label: { Label("Shuffle", systemImage: "shuffle") }
        .buttonStyle(.bordered)
        .accessibilityLabel("Shuffle \(album.title)")
      Menu {
        Button("Play next", systemImage: "text.line.first.and.arrowtriangle.forward") { session.actions.playNext(album.tracks) }
        Button("Add to queue", systemImage: "text.append") { session.actions.addToQueue(album.tracks) }
        Button("Go to artist", systemImage: "music.mic") { session.router.open(.artist(album.artistId)) }
      } label: {
        Image(systemName: "ellipsis").frame(width: 44, height: 44)
      }
      .accessibilityLabel("More for \(album.title)")
      // Phase 7: Download. Phase 8: Request the rest.
    }
    .buttonBorderShape(.capsule)
    .padding(.horizontal, 20)
  }

  private var songs: some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(model.rows) { row in
        switch row {
        case .disc(let number):
          Label("Disc \(number)", systemImage: "opticaldisc")
            .font(.caption2.monospaced())
            .foregroundStyle(.secondary)
            .padding(.top, 16)
            .accessibilityAddTraits(.isHeader)
        case .track(let track, let index):
          TrackRow(track: track) { model.tap(track, index: index) }
        case .missing(let missing):
          MissingTrackRow(missing: missing)
        }
      }
    }
    .padding(.horizontal, 20)
  }

  private func linerNotes(_ overview: String) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Kicker(text: "Liner notes")
      Text(overview).font(.callout).foregroundStyle(.secondary)
    }
    .padding(.horizontal, 20)
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter AlbumModelTests
```

Expected: 5 tests pass.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Album apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/AlbumModelTests.swift
git commit -F - <<'MSG'
iOS: an album's page: disc headers, missing songs greyed out in place, liner notes and more by the artist

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 21: The queue

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Queue/QueueModel.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Queue/QueueView.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/QueueModelTests.swift`

`apps/web/src/pages/Queue.tsx`: Now playing "· from <source>" (a link), then "Up next · 4 tracks · 24 min": drag to reorder (the whole new order goes to the player when the drag ends, as `setUpcoming`), swipe or ⋯ to remove, tap to play from there, ⋯ Play next (for songs further down), Go to album, Go to artist; Clear with Undo; "The queue ends after this track."; "Nothing queued" with a way to Albums. Save as playlist comes with playlists (phase 6); the transition line (`TransitionView`) with phase 5.

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/QueueModelTests.swift`:

```swift
import Foundation
import PlayarrAPI
import PlayarrPlayer
import Testing
@testable import PlayarrUI

@MainActor @Suite struct QueueModelTests {
  func playing() -> (AccountSession, QueueModel) {
    let session = demoSession()
    session.player.play(Demo.mezzanineTracks + Demo.protectionTracks)
    return (session, QueueModel(session: session))
  }

  @Test func listsWhatComesNext() {
    let (_, model) = playing()
    #expect(model.current?.title == "Angel")
    #expect(model.upcoming.map(\.track.title) == ["Risingson", "Inertia Creeps", "Protection", "Karmacoma"])
    #expect(model.header == "Up next · 4 tracks · 24 min")
  }

  @Test func dragsASongToAnotherPlace() {
    let (_, model) = playing()
    model.move(from: [3], to: 0)
    #expect(model.upcoming.map(\.track.title) == ["Karmacoma", "Risingson", "Inertia Creeps", "Protection"])
  }

  @Test func removesAndPlaysNext() {
    let (_, model) = playing()
    model.remove([0, 2])
    #expect(model.upcoming.map(\.track.title) == ["Inertia Creeps", "Karmacoma"])
    model.playNext(model.upcoming[1])
    #expect(model.upcoming.map(\.track.title) == ["Karmacoma", "Inertia Creeps"])
    model.play(1)
    #expect(model.current?.title == "Inertia Creeps")
  }

  @Test func clearsWithUndo() throws {
    let (session, model) = playing()
    model.clear()
    #expect(model.upcoming.isEmpty)
    let toast = try #require(session.toasts.toasts.last)
    #expect(toast.message == "Cleared 4 tracks")
    session.toasts.perform(toast)
    #expect(model.upcoming.map(\.track.title) == ["Risingson", "Inertia Creeps", "Protection", "Karmacoma"])
  }

  @Test func undoDoesNothingOnceAnotherSongPlays() throws {
    let (session, model) = playing()
    model.clear()
    session.player.play(Demo.dummyTracks)
    session.toasts.perform(try #require(session.toasts.toasts.last))
    #expect(model.upcoming.map(\.track.title) == ["Sour Times", "Glory Box"])
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter QueueModelTests
```

Expected: the build fails with `cannot find 'QueueModel' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Queue/QueueModel.swift`:

```swift
import Foundation
import Observation
import PlayarrAPI
import PlayarrPlayer

/// The queue, as apps/web/src/pages/Queue.tsx: the song playing and where it's from, then Up next (drag to reorder,
/// tap to play from there, remove), and Clear with Undo. "Save as playlist" comes with playlists (phase 6).
@MainActor
struct QueueModel {
  struct Upcoming: Identifiable, Equatable {
    /// The song's index in the player's queue: unique even when a song is queued twice.
    let queueIndex: Int
    let track: Track
    var id: Int { queueIndex }
  }

  let session: AccountSession
  var player: Player { session.player }

  var current: Track? { player.queue.currentTrack }
  var source: PlaySource? { player.queue.source }

  var upcoming: [Upcoming] {
    let q = player.queue
    guard q.pos >= 0 else { return [] }
    return q.order.dropFirst(q.pos + 1).map { Upcoming(queueIndex: $0, track: q.queue[$0]) }
  }

  /// "Up next · 4 tracks · 21 min".
  var header: String {
    let songs = upcoming
    guard !songs.isEmpty else { return "Up next" }
    return "Up next · \(Format.plural(songs.count, "track")) · \(Format.duration(songs.reduce(0) { $0 + $1.track.duration }))"
  }

  /// Plays from the `offset`-th song of Up next.
  func play(_ offset: Int) {
    player.jump(to: player.queue.pos + 1 + offset)
  }

  /// Drag and drop in Up next (List's `onMove`): the new order is given to the player when the drag ends.
  func move(from source: IndexSet, to destination: Int) {
    var ids = upcoming.map(\.queueIndex)
    ids.move(fromOffsets: source, toOffset: destination)
    player.setUpcoming(ids)
  }

  func remove(_ offsets: IndexSet) {
    // From the end, so the positions still to remove don't move.
    for offset in offsets.sorted(by: >) { player.remove(at: player.queue.pos + 1 + offset) }
  }

  /// ⋯ → Play next (for songs further down).
  func playNext(_ song: Upcoming) {
    player.setUpcoming([song.queueIndex] + upcoming.map(\.queueIndex).filter { $0 != song.queueIndex })
  }

  /// Clears Up next, with Undo for a mis-tap (only while the same song plays).
  func clear() {
    let ids = upcoming.map(\.queueIndex)
    guard !ids.isEmpty, player.queue.pos >= 0 else { return }
    let playing = player.queue.order[player.queue.pos]
    let song = player.queue.currentTrack?.id
    player.clearUpcoming()
    let player = self.player
    session.toasts.push("Cleared \(Format.plural(ids.count, "track"))", action: .init("Undo") {
      let q = player.queue
      // The same entry of the same queue: a new queue reuses the indices.
      guard q.pos >= 0, q.order[q.pos] == playing, q.currentTrack?.id == song else { return }
      player.setUpcoming(ids + Array(q.order.dropFirst(q.pos + 1)))
    })
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Queue/QueueView.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// The Queue tab (apps/web/src/pages/Queue.tsx).
struct QueueView: View {
  let session: AccountSession
  @Environment(Theme.self) private var theme
  @State private var reordered = 0

  var body: some View {
    let model = QueueModel(session: session)
    Group {
      if let track = model.current {
        List {
          Section {
            nowPlaying(track)
          } header: {
            nowPlayingHeader(model)
          }
          Section {
            if model.upcoming.isEmpty {
              Text("The queue ends after this track.").foregroundStyle(.secondary)
            }
            ForEach(Array(model.upcoming.enumerated()), id: \.element.id) { offset, song in
              upNextRow(song, offset: offset, model: model)
            }
            .onMove { model.move(from: $0, to: $1); reordered += 1 }
            .onDelete { model.remove($0) }
          } header: {
            HStack {
              Text(model.header)
              Spacer()
              if !model.upcoming.isEmpty { Button("Clear") { model.clear() } }
            }
          }
        }
        .sensoryFeedback(.impact(weight: .light), trigger: reordered)
        #if os(iOS)
          .toolbar { EditButton() }
        #endif
      } else {
        ContentUnavailableView {
          Label("Nothing queued", systemImage: "list.bullet")
        } description: {
          Text("Pick an album to start listening.")
        } actions: {
          NavigationLink("Albums", value: Route.albums(.artist))
        }
      }
    }
    .navigationTitle("Queue")
  }

  private func nowPlayingHeader(_ model: QueueModel) -> some View {
    HStack(spacing: 4) {
      Text("Now playing")
      if let source = model.source {
        Text("· from")
        Button(source.label) { session.router.open(href: source.href) }
      }
    }
  }

  private func nowPlaying(_ track: Track) -> some View {
    HStack(spacing: 14) {
      Cover(path: track.coverUrl, points: 72, label: track.albumTitle).frame(width: 72, height: 72)
      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 8) {
          Image(systemName: "waveform").symbolEffect(.variableColor.iterative, isActive: session.player.queue.playing)
          Text(track.title).font(.headline).lineLimit(1)
        }
        .foregroundStyle(theme.accent.color)
        Button("\(track.artistName) · \(track.albumTitle)") { session.router.open(.album(track.albumId)) }
          .font(.subheadline).foregroundStyle(.secondary).lineLimit(1).buttonStyle(.plain)
        FormatBadge(format: track.format)
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Now playing: \(track.title), \(track.artistName)")
  }

  private func upNextRow(_ song: QueueModel.Upcoming, offset: Int, model: QueueModel) -> some View {
    let track = song.track
    return HStack(spacing: 12) {
      Button { model.play(offset) } label: {
        HStack(spacing: 12) {
          Cover(path: track.coverUrl, points: 44, label: track.albumTitle).frame(width: 44, height: 44)
          VStack(alignment: .leading, spacing: 2) {
            Text(track.title).lineLimit(1)
            Text(track.artistName).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
          }
          Spacer()
          Text(Format.time(track.duration)).font(.footnote.monospacedDigit()).foregroundStyle(.secondary)
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("\(track.title), \(track.artistName), \(Format.time(track.duration))")
      .accessibilityHint("Plays from this song")
      Menu {
        if offset > 0 { Button("Play next", systemImage: "text.line.first.and.arrowtriangle.forward") { model.playNext(song) } }
        Button("Go to album", systemImage: "square.stack") { session.router.open(.album(track.albumId)) }
        Button("Go to artist", systemImage: "music.mic") { session.router.open(.artist(track.artistId)) }
        Button("Remove from queue", systemImage: "xmark", role: .destructive) { model.remove([offset]) }
      } label: {
        Image(systemName: "ellipsis").frame(width: 44, height: 44).contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .foregroundStyle(.secondary)
      .accessibilityLabel("More for \(track.title)")
    }
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter QueueModelTests
```

Expected: 5 tests pass.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Queue apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/QueueModelTests.swift
git commit -F - <<'MSG'
iOS: the queue: up next with drag to reorder, remove, play from there, and Clear with Undo

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 22: Synced lyrics

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/NowPlaying/LyricsModel.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/NowPlaying/LyricsView.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/LyricsModelTests.swift`

`apps/web/src/components/LyricsView.tsx`: the line sung is the last whose `at` ≤ time + 0.15 s (binary search; its web test is ported); the view follows it unless the lines were scrolled by hand in the last 4 s; a line tapped plays from there; credits "Lyrics from LRCLIB" (a link) or "Lyrics from the file"; the states loading, "Lyrics are unavailable right now.", "No lyrics found for this song.", "Instrumental", plain words, timed words. Asked once per song with one retry (`staleTime: Infinity`, `retry: 1`).

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/LyricsModelTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct LyricsModelTests {
  @Test func findsTheLineBeingSung() {
    // Ported from apps/web/src/components/LyricsView.test.tsx.
    let lines: [Double] = [5, 10, 20]
    #expect(LyricsModel.lineAt(lines, time: 1) == -1)
    #expect(LyricsModel.lineAt(lines, time: 10) == 1)
    #expect(LyricsModel.lineAt(lines, time: 99) == 2)
    // A line shows 0.15 s before it's sung.
    #expect(LyricsModel.lineAt(lines, time: 4.9) == 0)
    #expect(LyricsModel.lineAt([], time: 3) == -1)
  }

  @Test func loadsTimedLyrics() async {
    let model = LyricsModel(trackId: 700, session: demoSession())
    await model.load()
    #expect(model.state == .synced(Demo.lyrics.synced!, .lrclib))
  }

  @Test func saysWhenThereAreNone() async {
    let model = LyricsModel(trackId: 701, session: demoSession())
    await model.load()
    #expect(model.state == .none)
  }

  @Test func saysWhenTheyCantBeHad() async {
    let api = FakeAPI.demoLibrary()
    api.fail(.get, "/api/tracks/700/lyrics", status: 503, "LRCLIB is down")
    let model = LyricsModel(trackId: 700, session: demoSession(api: api))
    await model.load()
    #expect(model.state == .unavailable)
    // Asked twice: once, and the one retry.
    #expect(api.calls(.get, "/api/tracks/700/lyrics").count == 2)
  }

  @Test func knowsInstrumentalsAndPlainWords() {
    #expect(LyricsModel.state(Lyrics(instrumental: true, source: .file)) == .instrumental)
    #expect(LyricsModel.state(Lyrics(plain: "Words", source: .file)) == .plain("Words", .file))
  }

  @Test func stopsFollowingForFourSecondsAfterAScroll() {
    let model = LyricsModel(trackId: 700, session: demoSession())
    let now = Date()
    #expect(model.follows(at: now))
    model.touched(at: now)
    #expect(!model.follows(at: now.addingTimeInterval(3.9)))
    #expect(model.follows(at: now.addingTimeInterval(4)))
  }

  @Test func aLineTappedPlaysFromThere() {
    let session = demoSession()
    session.player.play(Demo.mezzanineTracks)
    LyricsModel(trackId: 700, session: session).seek(to: Demo.lyrics.synced![1])
    #expect(session.player.time == 12)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter LyricsModelTests
```

Expected: the build fails with `cannot find 'LyricsModel' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/NowPlaying/LyricsModel.swift`:

```swift
import Foundation
import Observation
import PlayarrAPI

/// Now Playing → Lyrics (apps/web/src/components/LyricsView.tsx): the words of the song playing, following along when
/// they're timed. Following pauses for 4 s after scrolling by hand; a line tapped plays from there.
@MainActor @Observable
final class LyricsModel {
  enum State: Equatable {
    case loading
    case unavailable
    case none
    case instrumental
    case plain(String, Lyrics.Source)
    case synced([Lyrics.SyncedItem], Lyrics.Source)
  }

  /// Following pauses this long after the lines were scrolled by hand.
  static let followPause: TimeInterval = 4

  let trackId: Int
  private(set) var state: State = .loading
  @ObservationIgnored private var touchedAt = Date.distantPast
  @ObservationIgnored private let session: AccountSession

  init(trackId: Int, session: AccountSession) {
    self.trackId = trackId
    self.session = session
  }

  /// Asked once per song, with one retry, as the web does (`staleTime: Infinity`, `retry: 1`).
  func load() async {
    let api = session.api
    let id = trackId
    if let hit = session.queries.cached(.lyrics(id), as: LyricsAnswer.self) {
      state = Self.state(hit.value.lyrics)
      return
    }
    do {
      let answer = try await session.queries.fetch(.lyrics(id)) {
        do { return try await api.send(API.Library.lyrics(trackId: id)) } catch { return try await api.send(API.Library.lyrics(trackId: id)) }
      }
      state = Self.state(answer.lyrics)
    } catch is CancellationError {
    } catch {
      state = .unavailable
    }
  }

  static func state(_ lyrics: Lyrics?) -> State {
    guard let lyrics else { return .none }
    if lyrics.instrumental == true { return .instrumental }
    if let synced = lyrics.synced, !synced.isEmpty { return .synced(synced, lyrics.source) }
    if let plain = lyrics.plain { return .plain(plain, lyrics.source) }
    return .none
  }

  /// The lines were scrolled by hand.
  func touched(at now: Date = Date()) { touchedAt = now }

  /// Whether to scroll to the line being sung.
  func follows(at now: Date = Date()) -> Bool { now.timeIntervalSince(touchedAt) >= Self.followPause }

  func seek(to line: Lyrics.SyncedItem) {
    session.player.seek(to: line.at)
  }

  /// The line being sung at `time`: the last that started (0.15 s early); -1 before the first.
  nonisolated static func lineAt(_ lines: [Double], time: Double) -> Int {
    var low = 0
    var high = lines.count - 1
    var found = -1
    while low <= high {
      let mid = (low + high) / 2
      if lines[mid] <= time + 0.15 {
        found = mid
        low = mid + 1
      } else {
        high = mid - 1
      }
    }
    return found
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/NowPlaying/LyricsView.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// Now Playing → Lyrics (apps/web/src/components/LyricsView.tsx).
struct LyricsView: View {
  @State private var model: LyricsModel
  @Environment(AccountSession.self) private var session
  @Environment(AppearanceSettings.self) private var appearance
  @Environment(\.accessibilityReduceMotion) private var systemReduceMotion

  init(trackId: Int, session: AccountSession) {
    _model = State(initialValue: LyricsModel(trackId: trackId, session: session))
  }

  var body: some View {
    Group {
      switch model.state {
      case .loading:
        VStack(alignment: .leading, spacing: 16) {
          ForEach([0.7, 0.85, 0.55, 0.78], id: \.self) { width in
            GeometryReader { geometry in Skeleton(aspectRatio: nil, height: 28).frame(width: geometry.size.width * width) }.frame(height: 28)
          }
        }
        .accessibilityLabel("Loading lyrics")
      case .unavailable: notice("Lyrics are unavailable right now.")
      case .none: notice("No lyrics found for this song.")
      case .instrumental: notice("Instrumental")
      case .plain(let text, let source):
        ScrollView {
          VStack(alignment: .leading, spacing: 24) {
            Text(text).font(.title2.weight(.semibold))
            LyricsCredit(source: source)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.vertical, 24)
        }
      case .synced(let lines, let source):
        synced(lines, source: source)
      }
    }
    .task { await model.load() }
  }

  private func synced(_ lines: [Lyrics.SyncedItem], source: Lyrics.Source) -> some View {
    let times = lines.map(\.at)
    let current = LyricsModel.lineAt(times, time: session.player.time)
    return ScrollViewReader { proxy in
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
            Button { model.seek(to: line) } label: {
              Text(line.text.isEmpty ? "♪" : line.text)
                .font(.title2.weight(.semibold))
                .multilineTextAlignment(.leading)
                .foregroundStyle(index == current ? Color.primary : index < current ? Color.primary.opacity(0.35) : Color.primary.opacity(0.55))
            }
            .buttonStyle(.plain)
            .id(index)
            .accessibilityAddTraits(index == current ? .isSelected : [])
            .accessibilityHint("Plays from this line")
          }
          LyricsCredit(source: source).padding(.top, 24)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 120)
      }
      .scrollIndicators(.hidden)
      .onScrollPhaseChange { _, phase in
        if phase == .interacting { model.touched() }
      }
      .onChange(of: current) { _, line in
        guard model.follows() else { return }
        let reduce = appearance.reduceMotion(system: systemReduceMotion)
        withAnimation(reduce ? nil : .smooth) { proxy.scrollTo(max(0, line), anchor: .center) }
      }
    }
  }

  private func notice(_ text: String) -> some View {
    Text(text).font(.title3).foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

/// "Lyrics from LRCLIB" (a link) or "Lyrics from the file".
struct LyricsCredit: View {
  let source: Lyrics.Source

  var body: some View {
    Group {
      if source == .lrclib, let site = URL(string: "https://lrclib.net") {
        HStack(spacing: 4) {
          Text("LYRICS FROM")
          Link("LRCLIB", destination: site)
        }
      } else {
        Text("LYRICS FROM THE FILE")
      }
    }
    .font(.caption2.monospaced())
    .tracking(2)
    .foregroundStyle(.secondary)
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter LyricsModelTests
```

Expected: 7 tests pass.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/NowPlaying/LyricsModel.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/NowPlaying/LyricsView.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/LyricsModelTests.swift
git commit -F - <<'MSG'
iOS: timed lyrics that follow the song, pause following for 4 s after a scroll, and play from a tapped line

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 23: Now Playing, the sleep timer and the mini player

**Files:**
- Create in `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/NowPlaying/`: `NowPlayingModel.swift`, `Transport.swift`, `SeekBar.swift`, `SleepTimerMenu.swift`, `FavoriteButton.swift`, `NowPlayingView.swift`, `MiniPlayer.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/NowPlayingModelTests.swift`

`apps/web/src/components/NowPlaying.tsx`: the header (close, "Playing from" and its link, the sleep timer, Lyrics, ⋯ with Start radio, Go to album, Go to artist, Open queue; Add to playlist comes in phase 6, Show metadata and Edit mix points in phase 8), the cover shrinking a little while paused (or the lyrics), title, artist and badge, the heart (shown, wired in phase 6), the seek bar with the time left, and the transport. Swipe down on the header or cover closes it past 120 points or 600 points a second. `SleepTimer.tsx`: 15, 30, 45 minutes, an hour, 1.5 hours, "At the end of this song", "Turn off the timer", the minutes left on the button (counting down every 15 s). `PlayerBar.tsx`'s mini player: cover, title, artist, play/pause, next and a thin progress line. The transition line under the transport is phase 5's.

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/NowPlayingModelTests.swift`:

```swift
import Foundation
import PlayarrAPI
import PlayarrPlayer
import Testing
@testable import PlayarrUI

@MainActor @Suite struct NowPlayingModelTests {
  @Test func closesAtTheWebsThresholds() {
    #expect(!NowPlayingModel.closes(translation: 120, velocity: 600))
    #expect(NowPlayingModel.closes(translation: 121, velocity: 0))
    #expect(NowPlayingModel.closes(translation: 10, velocity: 601))
  }

  @Test func saysWhereTheMusicIsFrom() {
    let session = demoSession()
    let model = NowPlayingModel(session: session)
    session.player.play(Demo.mezzanineTracks)
    #expect(model.playingFrom == "Mezzanine")
    #expect(model.playingFromRoute == .album(70))
    session.player.play(Demo.dummyTracks, source: PlaySource(label: "Your whole library", href: "/albums"))
    #expect(model.playingFrom == "Your whole library")
    #expect(model.playingFromRoute == .albums(.artist))
    #expect(model.repeatLabel == "Repeat: off")
  }

  @Test func namesTheSleepTimersChoices() {
    #expect(NowPlayingModel.sleepMinutes.map(NowPlayingModel.sleepLabel) == ["In 15 minutes", "In 30 minutes", "In 45 minutes", "In an hour", "In 1.5 hours"])
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter NowPlayingModelTests
```

Expected: the build fails with `cannot find 'NowPlayingModel' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/NowPlaying/NowPlayingModel.swift`:

```swift
import CoreGraphics
import Foundation
import PlayarrAPI
import PlayarrPlayer

/// Now Playing's decisions (apps/web/src/components/NowPlaying.tsx), apart from its view.
@MainActor
struct NowPlayingModel {
  /// Swiping down closes Now Playing past 120 points, or flicked faster than 600 points a second.
  static let closeDistance: CGFloat = 120
  static let closeVelocity: CGFloat = 600

  static func closes(translation: CGFloat, velocity: CGFloat) -> Bool {
    translation > closeDistance || velocity > closeVelocity
  }

  let player: Player

  init(session: AccountSession) {
    player = session.player
  }

  init(player: Player) {
    self.player = player
  }

  /// "Playing from": the queue's source, else the song's album.
  var playingFrom: String? {
    player.queue.source?.label ?? player.queue.currentTrack?.albumTitle
  }

  /// Where "Playing from" goes.
  var playingFromRoute: Route? {
    if let href = player.queue.source?.href, let route = Route(href: href) { return route }
    return player.queue.currentTrack.map { .album($0.albumId) }
  }

  /// "Repeat: off", "Repeat: all", "Repeat: one".
  var repeatLabel: String { "Repeat: \(player.queue.repeatMode.rawValue)" }

  var remaining: String { "-" + Format.time(max(0, player.duration - player.time)) }

  /// The sleep timer's choices, as apps/web/src/components/SleepTimer.tsx.
  static let sleepMinutes: [Double] = [15, 30, 45, 60, 90]

  /// "In 15 minutes", "In an hour", "In 1.5 hours".
  static func sleepLabel(minutes: Double) -> String {
    if minutes < 60 { return "In \(Int(minutes)) minutes" }
    if minutes == 60 { return "In an hour" }
    let hours = minutes / 60
    return "In \(hours == hours.rounded() ? String(Int(hours)) : String(hours)) hours"
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/NowPlaying/Transport.swift`:

```swift
import PlayarrPlayer
import SwiftUI

/// Shuffle, previous, play or pause, next, repeat (apps/web/src/components/Transport.tsx).
struct Transport: View {
  let player: Player
  @Environment(Theme.self) private var theme

  var body: some View {
    let q = player.queue
    HStack {
      Button { player.toggleShuffle() } label: { Image(systemName: "shuffle").font(.title3) }
        .foregroundStyle(q.shuffle ? theme.accent.color : .secondary)
        .accessibilityLabel("Shuffle")
        .accessibilityAddTraits(q.shuffle ? .isSelected : [])
        .sensoryFeedback(.selection, trigger: q.shuffle)
      Spacer()
      Button { player.previous() } label: { Image(systemName: "backward.fill").font(.title) }
        .accessibilityLabel("Previous")
      Spacer()
      PlayPauseButton(player: player, size: 72)
      Spacer()
      Button { player.next() } label: { Image(systemName: "forward.fill").font(.title) }
        .accessibilityLabel("Next")
      Spacer()
      Button { player.cycleRepeat() } label: { Image(systemName: q.repeatMode == .one ? "repeat.1" : "repeat").font(.title3) }
        .foregroundStyle(q.repeatMode == .off ? .secondary : theme.accent.color)
        .accessibilityLabel(NowPlayingModel(player: player).repeatLabel)
        .sensoryFeedback(.selection, trigger: q.repeatMode)
    }
    .buttonStyle(.plain)
  }
}

/// Play or pause; a spinner while the song is loading.
struct PlayPauseButton: View {
  let player: Player
  var size: CGFloat = 44
  var filled = true

  var body: some View {
    let playing = player.queue.playing
    Button { player.togglePlay() } label: {
      ZStack {
        if filled { Circle().fill(.primary) }
        if player.loading && playing {
          ProgressView().tint(filled ? Color.black : Color.primary)
        } else {
          Image(systemName: playing ? "pause.fill" : "play.fill")
            .font(.system(size: size * 0.4))
            .foregroundStyle(filled ? Color.black : Color.primary)
        }
      }
      .frame(width: size, height: size)
    }
    .buttonStyle(.plain)
    .disabled(player.queue.pos < 0)
    .accessibilityLabel(playing ? "Pause" : "Play")
    .sensoryFeedback(.impact(weight: .medium), trigger: playing)
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/NowPlaying/SeekBar.swift`:

```swift
import PlayarrPlayer
import SwiftUI

/// Where the song is, and dragging to go elsewhere: the time so far and the time left.
struct SeekBar: View {
  let player: Player
  @State private var scrubbing: Double?

  var body: some View {
    let duration = max(player.duration, 1)
    VStack(spacing: 4) {
      Slider(
        value: Binding(get: { scrubbing ?? player.time }, set: { scrubbing = $0 }),
        in: 0...duration,
        onEditingChanged: { editing in
          if !editing, let to = scrubbing {
            player.seek(to: to)
            scrubbing = nil
          }
        }
      )
      .accessibilityLabel("Seek")
      .accessibilityValue(Format.time(scrubbing ?? player.time))
      HStack {
        Text(Format.time(scrubbing ?? player.time))
        Spacer()
        Text("-" + Format.time(max(0, player.duration - (scrubbing ?? player.time))))
      }
      .font(.caption.monospacedDigit())
      .foregroundStyle(.secondary)
      .accessibilityHidden(true)
    }
  }
}
```

The sleep timer's `TimelineView` redraws every 15 s; `.id(...)` makes a new choice show at once (without it the button kept its old label until the next tick, which the UI test caught).

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/NowPlaying/SleepTimerMenu.swift`:

```swift
import PlayarrPlayer
import SwiftUI

/// Now Playing → sleep timer (apps/web/src/components/SleepTimer.tsx): stop after a while, or at the end of this song.
struct SleepTimerMenu: View {
  let player: Player
  @Environment(Theme.self) private var theme

  var body: some View {
    let sleep = player.sleep
    // The minutes left count down while it's shown; a new choice redraws at once.
    TimelineView(.periodic(from: .now, by: 15)) { context in
      let label = sleep.label(at: context.date)
      Menu {
        ForEach(NowPlayingModel.sleepMinutes, id: \.self) { minutes in
          Button(NowPlayingModel.sleepLabel(minutes: minutes), systemImage: "moon") { player.sleep(minutes: minutes) }
        }
        Button("At the end of this song", systemImage: "moon") { player.sleepAtEndOfSong() }
        if label != nil {
          Button("Turn off the timer", systemImage: "moon.zzz", role: .destructive) { player.cancelSleep() }
        }
      } label: {
        HStack(spacing: 4) {
          Image(systemName: "moon")
          if let label { Text(label.uppercased()).font(.caption2.monospaced()) }
        }
        .frame(minWidth: 44, minHeight: 44)
        .foregroundStyle(label == nil ? Color.primary : theme.accent.color)
      }
      .accessibilityLabel(label.map { "Sleep timer: \($0)" } ?? "Sleep timer")
    }
    .id(sleep.endOfSong ? -1 : sleep.endsAt?.timeIntervalSince1970 ?? 0)
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/NowPlaying/FavoriteButton.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// The heart. Phase 6 makes it add and remove favorites; until then it's shown but does nothing.
struct FavoriteButton: View {
  let track: Track

  var body: some View {
    Button {} label: { Image(systemName: "heart").font(.title2).frame(width: 44, height: 44) }
      .buttonStyle(.plain)
      .disabled(true)
      .accessibilityLabel("Add to Favorites")
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/NowPlaying/NowPlayingView.swift`:

```swift
import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// Now Playing, over everything (apps/web/src/components/NowPlaying.tsx): swipe down to close, "Playing from", the
/// sleep timer, lyrics, the ⋯ menu, the cover (or lyrics), the song, the seek bar and the transport.
struct NowPlayingView: View {
  let session: AccountSession
  @Environment(Theme.self) private var theme
  @Environment(AppearanceSettings.self) private var appearance
  @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
  @State private var drag: CGFloat = 0

  var body: some View {
    let player = session.player
    let model = NowPlayingModel(session: session)
    @Bindable var router = session.router
    ZStack {
      if let track = player.queue.currentTrack {
        backdrop(track)
        VStack(spacing: 24) {
          header(model, track: track)
            .contentShape(Rectangle())
            .gesture(closeGesture)
          if router.lyrics {
            LyricsView(trackId: track.id, session: session).id(track.id)
          } else {
            cover(track, playing: player.queue.playing)
              .gesture(closeGesture)
          }
          song(track)
          SeekBar(player: player)
          Transport(player: player)
          Spacer(minLength: 0)
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 12)
      }
    }
    .offset(y: drag)
    .preferredColorScheme(.dark)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Now playing")
    .accessibilityIdentifier("nowPlaying")
    .accessibilityAction(.escape) { router.nowPlaying = false }
    .onChange(of: player.queue.currentTrack == nil) { _, empty in if empty { router.nowPlaying = false } }
  }

  private var closeGesture: some Gesture {
    DragGesture()
      .onChanged { drag = max(0, $0.translation.height) * 0.9 }
      .onEnded { value in
        if NowPlayingModel.closes(translation: value.translation.height, velocity: value.velocity.height) {
          session.router.nowPlaying = false
        } else {
          withAnimation(.spring(duration: 0.3)) { drag = 0 }
        }
      }
  }

  /// The cover itself, blown up and blurred.
  private func backdrop(_ track: Track) -> some View {
    ZStack {
      Color.black
      Cover(path: track.coverUrl, points: 300).scaleEffect(1.5).blur(radius: 90).opacity(0.55).saturation(1.5)
      RadialGradient(colors: [.clear, .black.opacity(0.5), .black.opacity(0.92)], center: .top, startRadius: 0, endRadius: 700)
    }
    .ignoresSafeArea()
  }

  private func header(_ model: NowPlayingModel, track: Track) -> some View {
    HStack {
      Button { session.router.nowPlaying = false } label: { Image(systemName: "chevron.down").font(.title2).frame(width: 44, height: 44) }
        .accessibilityLabel("Close now playing")
      Spacer()
      VStack(spacing: 2) {
        Kicker(text: "Playing from")
        Button(model.playingFrom ?? "") { if let route = model.playingFromRoute { session.router.go(route) } }
          .font(.footnote).lineLimit(1)
      }
      .accessibilityElement(children: .combine)
      Spacer()
      SleepTimerMenu(player: session.player)
      Button { session.router.lyrics.toggle() } label: { Image(systemName: "quote.bubble").font(.title3).frame(width: 44, height: 44) }
        .foregroundStyle(session.router.lyrics ? theme.accent.color : .primary)
        .accessibilityLabel("Lyrics")
        .accessibilityAddTraits(session.router.lyrics ? .isSelected : [])
      Menu {
        // Phase 6: Add to playlist…  Phase 8: Show metadata, Edit mix points.
        Button("Start radio", systemImage: "dot.radiowaves.left.and.right") { Task { await session.actions.startRadio(track) } }
        Button("Go to album", systemImage: "square.stack") { session.actions.goToAlbum(track) }
        Button("Go to artist", systemImage: "music.mic") { session.actions.goToArtist(track) }
        Button("Open queue", systemImage: "list.bullet") { session.router.showQueue() }
      } label: {
        Image(systemName: "ellipsis").font(.title3).frame(width: 44, height: 44)
      }
      .accessibilityLabel("More")
    }
    .buttonStyle(.plain)
  }

  private func cover(_ track: Track, playing: Bool) -> some View {
    let reduce = appearance.reduceMotion(system: systemReduceMotion)
    return Cover(path: track.coverUrl, points: 360, label: track.albumTitle, corner: 8)
      .shadow(color: .black.opacity(0.85), radius: 40, y: 30)
      .scaleEffect(playing ? 1 : 0.86)
      .animation(reduce ? nil : .spring(response: 0.45, dampingFraction: 0.7), value: playing)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .contentShape(Rectangle())
  }

  private func song(_ track: Track) -> some View {
    HStack(alignment: .top) {
      VStack(alignment: .leading, spacing: 6) {
        Text(track.title).font(.title.weight(.semibold)).lineLimit(2)
        HStack(spacing: 8) {
          Button(track.artistName) { session.actions.goToArtist(track) }
            .font(.title3).foregroundStyle(.secondary).buttonStyle(.plain)
          FormatBadge(format: track.format)
        }
      }
      Spacer()
      FavoriteButton(track: track)
    }
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/NowPlaying/MiniPlayer.swift`:

```swift
import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// The mini player above the tabs (apps/web/src/components/PlayerBar.tsx `MiniPlayer`): tap to open Now Playing.
struct MiniPlayer: View {
  let session: AccountSession
  @Environment(Theme.self) private var theme

  var body: some View {
    let player = session.player
    if let track = player.queue.currentTrack {
      HStack(spacing: 12) {
        Button { session.router.nowPlaying = true } label: {
          HStack(spacing: 12) {
            Cover(path: track.coverUrl, points: 36, label: track.albumTitle, corner: 6).frame(width: 36, height: 36)
            VStack(alignment: .leading, spacing: 0) {
              Text(track.title).font(.subheadline).lineLimit(1)
              Text(track.artistName).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
          }
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Open now playing")
        .accessibilityValue("\(track.title), \(track.artistName)")
        PlayPauseButton(player: player, size: 36, filled: false)
        Button { player.next() } label: { Image(systemName: "forward.fill").frame(width: 36, height: 36) }
          .buttonStyle(.plain)
          .accessibilityLabel("Next")
      }
      .padding(.horizontal, 12)
      .overlay(alignment: .bottom) {
        GeometryReader { geometry in
          let fraction = player.duration > 0 ? min(1, player.time / player.duration) : 0
          Capsule().fill(theme.accent.color).frame(width: geometry.size.width * fraction, height: 2)
        }
        .frame(height: 2)
        .padding(.horizontal, 12)
        .accessibilityHidden(true)
      }
      .accessibilityIdentifier("miniPlayer")
    }
  }
}
```

**Step 4: Run it to see it pass, and build for the simulator**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter NowPlayingModelTests
swift build --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --triple arm64-apple-ios26.0-simulator --sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" --scratch-path /tmp/playarr-ui-ios
```

Expected: 3 tests pass; the simulator build succeeds.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/NowPlaying/NowPlayingModel.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/NowPlaying/Transport.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/NowPlaying/SeekBar.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/NowPlaying/SleepTimerMenu.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/NowPlaying/FavoriteButton.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/NowPlaying/NowPlayingView.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/NowPlaying/MiniPlayer.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/NowPlayingModelTests.swift
git commit -F - <<'MSG'
iOS: Now Playing with swipe down to close, the sleep timer and lyrics, and the mini player

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 24: Settings: Playback and Appearance on this device, the server's panels for admins

**Files:**
- Create in `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/`: `PlaybackPanelModel.swift`, `SettingsView.swift`, `PlaybackPanel.swift`, `AppearancePanel.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/PlaybackPanelModelTests.swift`

`apps/web/src/pages/Settings.tsx`, `components/PlaybackPanel.tsx` and `AppearancePanel.tsx`, in their words. The list: who's signed in (opens the account switcher) and Your listening; "This device": Playback and Appearance ("These settings are for this device."); for admins, "Server": Sources, Mixes, Analysis, Requests, Updates and Accounts ("These settings apply to everyone.", placeholders until phase 9); in debug builds, phase 3's Player lab, playing through this account's player; the version. Choosing Crossfade or DJ mix with no length yet starts at 6 s (`setTransitions` in `apps/web/src/lib/prefs.ts`).

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/PlaybackPanelModelTests.swift`:

```swift
import Foundation
import PlayarrPlayer
import Testing
@testable import PlayarrUI

@MainActor @Suite struct PlaybackPanelModelTests {
  @Test func aFadeStartsAtSixSeconds() {
    let settings = PlaybackSettings(defaults: UserDefaults(suiteName: UUID().uuidString)!)
    let panel = PlaybackPanelModel(settings: settings)
    panel.choose(.crossfade)
    #expect(settings.crossfade == 6)
    settings.crossfade = 12
    panel.choose(.dj)
    #expect(settings.crossfade == 12)
    #expect(PlaybackPanelModel.lengths == [3, 6, 9, 12])
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter PlaybackPanelModelTests
```

Expected: the build fails with `cannot find 'PlaybackPanelModel' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/PlaybackPanelModel.swift`:

```swift
import PlayarrPlayer

/// Settings → Playback's one rule beyond storing (apps/web/src/lib/prefs.ts `setTransitions`): a fade of 0 seconds
/// would sound like Off, so choosing Crossfade or DJ mix starts at 6 s.
@MainActor
struct PlaybackPanelModel {
  static let firstCrossfade: Double = 6
  /// Lengths offered once Crossfade or DJ mix is chosen: 0 would just be Off.
  static let lengths = PlaybackSettings.crossfades.filter { $0 > 0 }

  let settings: PlaybackSettings

  func choose(_ transitions: PlaybackSettings.Transitions) {
    settings.transitions = transitions
    if transitions != .off, settings.crossfade == 0 { settings.crossfade = Self.firstCrossfade }
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/SettingsView.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// Settings (apps/web/src/pages/Settings.tsx): who's signed in, this device's Playback and Appearance, and for admins
/// the server's panels (built in phase 9).
struct SettingsView: View {
  let session: AccountSession
  @Environment(AppModel.self) private var app

  var body: some View {
    List {
      Section {
        Button { app.showingAccounts = true } label: {
          LabeledContent("Signed in as \(session.account.name)", value: session.serverName)
        }
        .accessibilityHint("Switch accounts or add one")
        NavigationLink("Your listening", value: Route.listening)
      }
      Section {
        NavigationLink(SettingsPanel.playback.title, value: Route.settingsPanel(.playback))
        NavigationLink(SettingsPanel.appearance.title, value: Route.settingsPanel(.appearance))
      } header: {
        Text("This device")
      } footer: {
        Text("These settings are for this device.")
      }
      if session.account.role == .admin {
        Section {
          ForEach(SettingsPanel.server, id: \.self) { panel in
            NavigationLink(panel.title, value: Route.settingsPanel(panel))
          }
        } header: {
          Text("Server")
        } footer: {
          Text("These settings apply to everyone.")
        }
      }
      #if DEBUG
        if session.client != nil {
          Section("Debug") { NavigationLink(SettingsPanel.playerLab.title, value: Route.settingsPanel(.playerLab)) }
        }
      #endif
      Section {
      } footer: {
        Text("Playarr \(app.appVersion.description)").frame(maxWidth: .infinity)
      }
    }
    .navigationTitle("Settings")
  }
}

/// One panel of Settings.
struct SettingsPanelView: View {
  let panel: SettingsPanel
  let session: AccountSession
  @Environment(AppModel.self) private var app

  var body: some View {
    switch panel {
    case .playback: PlaybackPanel(settings: app.playback)
    case .appearance: AppearancePanel(appearance: app.appearance)
    #if DEBUG
      case .playerLab:
        if let client = session.client { PlayerLabView(player: session.player, client: client) }
    #endif
    default: PlaceholderPage(title: panel.title)
    }
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/PlaybackPanel.swift`:

```swift
import PlayarrPlayer
import SwiftUI

/// Settings → Playback, for this device (apps/web/src/components/PlaybackPanel.tsx). The engine can fade on a
/// phone, so Crossfade is offered here, unlike the web on an iPhone. "On this device" storage comes in phase 7.
struct PlaybackPanel: View {
  @Bindable var settings: PlaybackSettings

  var body: some View {
    let panel = PlaybackPanelModel(settings: settings)
    Form {
      Section("Playing") {
        Toggle(isOn: $settings.autoplay) {
          Text("Keep playing when the queue ends")
          Text("Carries on with songs from your library like the last ones you heard.")
        }
        Toggle(isOn: $settings.recordPlays) {
          Text("Count what this device plays")
          Text("Off for a party speaker or a guest’s phone: what plays here won’t shape everyone’s mixes.")
        }
      }
      Section {
        Toggle(isOn: $settings.levelVolume) {
          Text("Even out the volume")
          Text("Every song plays as loud as the next (−14 LUFS, as streaming services do): loud ones turned down, quiet ones up as far as they can go. An album played in order keeps its own quiet and loud songs. Songs are levelled once Settings → Analysis has measured their loudness.")
        }
        Picker("Transitions", selection: Binding(get: { settings.transitions }, set: { panel.choose($0) })) {
          Text("Off").tag(PlaybackSettings.Transitions.off)
          Text("Crossfade").tag(PlaybackSettings.Transitions.crossfade)
          Text("DJ mix").tag(PlaybackSettings.Transitions.dj)
        }
        .pickerStyle(.segmented)
        if settings.transitions != .off {
          Picker(settings.transitions == .crossfade ? "Crossfade length" : "Fade length", selection: $settings.crossfade) {
            ForEach(PlaybackPanelModel.lengths, id: \.self) { Text("\(Int($0)) s").tag($0) }
          }
          .pickerStyle(.segmented)
        }
      } header: {
        Text("Sound")
      } footer: {
        switch settings.transitions {
        case .off: Text("Songs always follow each other without a gap.")
        case .crossfade: Text("Fades each song into the next. Never between songs of an album played in order.")
        case .dj: Text("Songs are mixed like a DJ would, when their beats allow: long blends, quick mixes or straight on. Songs that can’t be mixed on the beat fade into each other for this long. How many songs are ready for DJ mix: Settings → Analysis.")
        }
      }
    }
    .navigationTitle("Playback")
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/AppearancePanel.swift`:

```swift
import SwiftUI

/// Settings → Appearance, for this device (apps/web/src/components/AppearancePanel.tsx).
struct AppearancePanel: View {
  @Bindable var appearance: AppearanceSettings

  var body: some View {
    Form {
      Section {
        HStack(spacing: 12) {
          ForEach(AppearanceSettings.Accent.all, id: \.self) { accent in
            swatch(accent)
          }
        }
        .padding(.vertical, 4)
      } header: {
        Text("Accent color")
      } footer: {
        Text(appearance.accent == .album ? "From the album art: the color follows the song playing." : "\(appearance.accent.name), whatever is playing.")
      }
      Section {
        Picker("Motion", selection: $appearance.motion) {
          ForEach(AppearanceSettings.Motion.allCases, id: \.self) { Text($0.label).tag($0) }
        }
        .pickerStyle(.segmented)
      } header: {
        Text("Motion")
      } footer: {
        Text("System follows this device’s setting for reduced motion. Reduced keeps animations to a minimum; Full always plays them.")
      }
      Section("Audio format") {
        Toggle(isOn: $appearance.formatBadges) {
          Text("Show audio format badges")
          Text("The FLAC, MP3 and Hi-Res labels in the player, Now Playing, the queue and on albums.")
        }
      }
      Section("For the curious") {
        Toggle(isOn: $appearance.statsForNerds) {
          Text("Stats for nerds")
          Text("An overlay with everything Playarr knows about the song playing: its tempo, key and beat grid as it plays, intro, outro and drop, loudness and the gain applied, the stream and its buffer, and the next transition.")
        }
      }
    }
    .navigationTitle("Appearance")
  }

  private func swatch(_ accent: AppearanceSettings.Accent) -> some View {
    let chosen = appearance.accent == accent
    return Button { appearance.accent = accent } label: {
      Group {
        switch accent {
        case .album:
          RoundedRectangle(cornerRadius: 6).fill(
            LinearGradient(colors: [RGB(hex: 0xff7a1a).color, RGB(hex: 0xf43f5e).color, RGB(hex: 0xa78bfa).color, RGB(hex: 0x38bdf8).color], startPoint: .topLeading, endPoint: .bottomTrailing))
        case .fixed(let color):
          Circle().fill(color.rgb.color)
        }
      }
      .frame(width: 36, height: 36)
      .overlay { if chosen { Image(systemName: "checkmark").font(.footnote.weight(.bold)).foregroundStyle(.black) } }
    }
    .buttonStyle(.plain)
    .accessibilityLabel(accent.name)
    .accessibilityAddTraits(chosen ? [.isButton, .isSelected] : .isButton)
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter PlaybackPanelModelTests
```

Expected: 1 test passes.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/PlaybackPanelModel.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/SettingsView.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/PlaybackPanel.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/AppearancePanel.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/PlaybackPanelModelTests.swift
git commit -F - <<'MSG'
iOS: Settings: Playback and Appearance for this device, the server's panels listed for admins

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 25: The signed-in app: tabs, mini player, Now Playing and toasts

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/ToastsView.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/RouteDestination.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/AppShell.swift`
- Modify (replace): `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/RootView.swift`, `apps/ios/Playarr/PlayarrApp.swift`
- Delete: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/SignedInHomeView.swift` (phase 2's stand-in home, with phase 3's `.playerLab(for:)` on it), `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/PlayerLabEntry.swift` (phase 3's floating lab button: it made a second `Player.live`; the lab now opens from Settings with the session's player)

`AppShell` is a `TabView` of the four tabs, each a `NavigationStack` over the router's path for that tab, with `RouteDestination` for every page. The search tab has the search role (iOS 26 sets it apart in the tab bar). The mini player is the tab bar's bottom accessory; Now Playing is a full-screen cover; toasts float at the top (over Now Playing too), each read out by VoiceOver; the player's notices ("Sleep timer: music stopped", stream errors) become toasts; the accent follows the cover playing; Settings → Appearance → Motion → Reduced turns animations off throughout. `RootView` makes the session (`syncSession()`) whenever the active account or its signed-in state changes and shows `AppShell` once it's there.

**Step 1: Write the shell**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/ToastsView.swift`:

```swift
import SwiftUI

/// The toasts at the top of the screen (apps/web/src/components/Toasts.tsx). VoiceOver reads each one out.
struct ToastsView: View {
  @Environment(ToastCenter.self) private var center
  @Environment(Theme.self) private var theme

  var body: some View {
    VStack(spacing: 8) {
      ForEach(center.toasts) { toast in
        HStack(spacing: 12) {
          Text(toast.message).font(.subheadline)
          if let action = toast.action {
            Spacer(minLength: 8)
            Button(action.label) { center.perform(toast) }.foregroundStyle(theme.accent.color)
            Button("Later") { center.dismiss(toast.id) }.foregroundStyle(.secondary)
          }
        }
        .font(.caption.weight(.semibold))
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.regularMaterial, in: Capsule())
        .overlay(Capsule().stroke(toast.tone == .error ? Color.red.opacity(0.4) : Color.secondary.opacity(0.2)))
        .foregroundStyle(toast.tone == .error ? Color.red : Color.primary)
        .onTapGesture { if toast.action == nil { center.dismiss(toast.id) } }
        .transition(.move(edge: .top).combined(with: .opacity))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isStaticText)
        .sensoryFeedback(toast.tone == .error ? .error : .success, trigger: toast.id)
      }
    }
    .padding(.horizontal, 16)
    .animation(.spring(duration: 0.3), value: center.toasts.map(\.id))
    .onChange(of: center.toasts.last?.id) { _, _ in
      if let message = center.toasts.last?.message { AccessibilityNotification.Announcement(message).post() }
    }
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/RouteDestination.swift`:

```swift
import SwiftUI

/// The page for a route: the same in every tab's stack (and, later, in an iPad split view).
struct RouteDestination: View {
  let route: Route
  let session: AccountSession
  @Environment(Theme.self) private var theme

  var body: some View {
    switch route {
    case .album(let id): AlbumView(id: id, session: session, theme: theme)
    case .artist(let id): ArtistView(id: id, session: session)
    case .albums(let sort): AlbumsView(session: session, sort: sort)
    case .artists: ArtistsView(session: session)
    case .settings: SettingsView(session: session)
    case .settingsPanel(let panel): SettingsPanelView(panel: panel, session: session)
    case .favorites: PlaceholderPage(title: "Favorites")  // phase 6
    case .playlists: PlaceholderPage(title: "Playlists")  // phase 6
    case .playlist: PlaceholderPage(title: "Playlist")  // phase 6
    case .mixes: PlaceholderPage(title: "Made for you")  // phase 6
    case .mix: PlaceholderPage(title: "Mix")  // phase 6
    case .listening: PlaceholderPage(title: "Your listening")  // phase 6
    }
  }
}

extension View {
  /// Every page a tab's stack can show.
  func routeDestinations(_ session: AccountSession) -> some View {
    navigationDestination(for: Route.self) { RouteDestination(route: $0, session: session) }
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/AppShell.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// The signed-in app on a phone: Home, Search, Library and Queue tabs (apps/web/src/components/Nav.tsx), the mini
/// player above them, Now Playing over everything, and toasts.
struct AppShell: View {
  let model: AppModel
  let session: AccountSession
  @Environment(\.accessibilityReduceMotion) private var systemReduceMotion

  var body: some View {
    @Bindable var router = session.router
    TabView(selection: Binding(get: { router.tab }, set: { router.select($0) })) {
      ForEach(AppTab.allCases, id: \.self) { tab in
        Tab(tab.title, systemImage: tab.systemImage, value: tab, role: tab == .search ? .search : nil) {
          NavigationStack(path: Binding(get: { router.paths[tab] ?? [] }, set: { router.paths[tab] = $0 })) {
            root(tab).routeDestinations(session)
          }
        }
      }
    }
    .minimizingTabBar()
    .miniPlayer(isShown: session.player.queue.currentTrack != nil) { MiniPlayer(session: session) }
    .nowPlayingCover(isPresented: $router.nowPlaying) {
      NowPlayingView(session: session).environment(session).environment(model.theme).environment(model.appearance)
        .overlay(alignment: .top) { ToastsView().environment(model.toasts).environment(model.theme) }
    }
    .overlay(alignment: .top) { ToastsView() }
    .sheet(isPresented: Binding(get: { model.showingAccounts }, set: { model.showingAccounts = $0 })) { AccountSwitcherView(model: model) }
    // Settings → Appearance → Motion: Reduced keeps animations to a minimum, whatever the device says.
    .transaction { if model.appearance.reduceMotion(system: systemReduceMotion) { $0.animation = nil } }
    .tint(model.theme.accent.color)
    .preferredColorScheme(.dark)
    .environment(session)
    .environment(model)
    .environment(model.theme)
    .environment(model.appearance)
    .environment(model.toasts)
    .task(id: session.player.queue.currentTrack?.coverUrl) {
      await model.theme.follow(cover: session.player.queue.currentTrack?.coverUrl, images: session.images)
    }
    .onChange(of: session.player.notice) { _, notice in
      if let notice { model.toasts.push(notice.text, tone: notice.isError ? .error : .info) }
    }
  }

  @ViewBuilder private func root(_ tab: AppTab) -> some View {
    switch tab {
    case .home: HomeView(session: session)
    case .search: SearchView(session: session)
    case .library: LibraryView(session: session)
    case .queue: QueueView(session: session)
    }
  }
}
```

Replace `RootView.swift` with (four spaces, like phase 2's file):

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
            .task(id: model.store.activeAccount) { model.syncSession() }
    }

    @ViewBuilder private var content: some View {
        if let info = model.tooOld {
            UpdateRequiredView(serverName: info.name, minAppVersion: info.minAppVersion, appVersion: model.appVersion.description)
        } else if let server = model.store.activeServer, let account = model.store.activeAccount {
            if account.signedIn {
                if let session = model.session, session.key == account.key {
                    AppShell(model: model, session: session)
                } else {
                    ProgressView()
                }
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

Replace `apps/ios/Playarr/PlayarrApp.swift` with:

`apps/ios/Playarr/PlayarrApp.swift`:

```swift
import Foundation
import PlayarrUI
import SwiftUI

@main
struct PlayarrApp: App {
  @State private var model = PlayarrApp.makeModel()

  var body: some Scene {
    WindowGroup {
      RootView(model: model)
        .onOpenURL { model.open($0) }
    }
  }

  /// UI tests launch with `-UITests` (no servers, nothing kept between runs), plus `-UITestsDemo` to start signed in
  /// to the demo library, playing silence.
  static func makeModel() -> AppModel {
    let arguments = ProcessInfo.processInfo.arguments
    if arguments.contains("-UITestsDemo") { return .demo() }
    if arguments.contains("-UITests") { return .empty() }
    return .live()
  }
}
```

Then delete the two files:

```bash
git rm apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/SignedInHomeView.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/PlayerLabEntry.swift
```

**Step 2: Build everything and run every test**

```bash
swift build --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --triple arm64-apple-ios26.0-simulator --sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" --scratch-path /tmp/playarr-ui-ios
make -C apps/ios test
```

Expected: the simulator build has no errors or warnings from PlayarrUI; every package suite passes (PlayarrUI: phase 2's 5 tests plus this plan's 87) and so does phase 2's `LaunchTests` (`-UITests` still opens "Add a server"). The test log may show UIKit's runtime warning "Adding '_UIReparentingView' as a subview of UIHostingController.view is not supported" while a menu opens over the full-screen cover: it's the system's own, not a failure.

**Step 3: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/ToastsView.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/RouteDestination.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/AppShell.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/RootView.swift apps/ios/Playarr/PlayarrApp.swift
git commit -F - <<'MSG'
iOS: the signed-in app: Home, Search, Library and Queue tabs, the mini player, Now Playing and toasts

The Player lab moves from a floating button to Settings in debug builds,
playing through the account's own player. UI tests can start signed in to a
demo library with -UITestsDemo.

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

(`git rm` already staged the two deletions; they go in this commit.)

---

### Task 26: UI tests: browse, play, Now Playing, the queue, search and settings

**Files:**
- Test: `apps/ios/PlayarrUITests/BrowseTests.swift`
- Modify: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Player.swift`, test in `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/PlayerTests.swift` (found by `testTheQueueClearsWithUndo`, see below)

Against the demo library, so no server is needed.

Found while running these against phase 3's real code: its `Player.continueRadio()` asked for a radio continuation on every queue change, so Clear (leaving the song playing as the last one) brought three radio songs straight back and "The queue ends after this track." never showed. The web asks only when a song starts (`useAutoplay` runs on the current `fileId`). The fix: `continueRadio()` checks each song once, when it becomes the current entry (`radioAskedAt` is set before `Radio.continuation` is asked), with the test `clearingUpNextDoesntStartARadio` in `PlayerTests`:

```swift
  @Test func clearingUpNextDoesntStartARadio() async throws {
    // The web asks for more only when the last song starts (radio.ts), so Clear leaves the queue ending here.
    let backend = FakeBackend()
    backend.radioAnswer.withLock { $0 = [song(10), song(11)] }
    let player = try Player.testing(backend)
    player.play([song(1), song(2), song(3)])
    player.clearUpcoming()
    try await Task.sleep(for: .milliseconds(50))
    #expect(backend.radioAsks.withLock { $0.isEmpty })
    #expect(player.queue.queue.count == 3)
    #expect(player.queue.upcoming(5).isEmpty)
  }
```

```swift
  private func continueRadio() {
    guard let entry = currentEntry, entry != radioAskedAt else { return }
    radioAskedAt = entry
    guard let ask = Radio.continuation(for: queue, autoplay: settings.autoplay) else { return }
    // … as before
``` The swipe is a press-and-drag from 30 % down the screen (the cover), 300 points down and fast: XCUITest's `swipeDown()` on an element starts at its centre, which is below the cover where nothing closes.

**Step 1: Write the tests**

`apps/ios/PlayarrUITests/BrowseTests.swift`:

```swift
import XCTest

/// Day-to-day listening on the simulator, against the demo library (`-UITestsDemo`: signed in, playing silence).
final class BrowseTests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  private func launch() -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-UITests", "-UITestsDemo"]
    app.launch()
    return app
  }

  @MainActor
  func testHomeOpensAnAlbumThatPlaysAndNowPlayingOpensAndCloses() {
    let app = launch()
    XCTAssertTrue(app.staticTexts["8 tracks across 3 albums, 45 min of music waiting in your library."].waitForExistence(timeout: 10))

    app.buttons["Mezzanine, Massive Attack · 1998 · 3 of 5"].firstMatch.tap()
    XCTAssertTrue(app.staticTexts["LINER NOTES"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["3. Teardrop, not in your library"].exists || app.otherElements["3. Teardrop, not in your library"].exists)

    app.buttons["Play Mezzanine"].tap()
    XCTAssertTrue(app.buttons["Pause Mezzanine"].waitForExistence(timeout: 5))

    app.buttons["Open now playing"].tap()
    let close = app.buttons["Close now playing"]
    XCTAssertTrue(close.waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Angel"].exists)
    XCTAssertTrue(app.buttons["Mezzanine"].exists)  // Playing from

    app.buttons["Lyrics"].tap()
    XCTAssertTrue(app.buttons["You are my angel"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["LYRICS FROM"].exists)
    app.buttons["Lyrics"].tap()

    app.buttons["Sleep timer"].tap()
    app.buttons["In 15 minutes"].tap()
    XCTAssertTrue(app.buttons["Sleep timer: 15 min"].waitForExistence(timeout: 5))

    // Swipe down on the cover, as far as a thumb does.
    let cover = app.otherElements["nowPlaying"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
    cover.press(forDuration: 0.05, thenDragTo: cover.withOffset(CGVector(dx: 0, dy: 300)), withVelocity: .fast, thenHoldForDuration: 0)
    XCTAssertTrue(close.waitForNonExistence(timeout: 5))
    XCTAssertTrue(app.buttons["Open now playing"].exists)
  }

  @MainActor
  func testTheQueueClearsWithUndo() {
    let app = launch()
    app.buttons["Mezzanine, Massive Attack · 1998 · 3 of 5"].firstMatch.tap()
    app.buttons["Play Mezzanine"].tap()
    app.tabBars.buttons["Queue"].tap()
    XCTAssertTrue(app.buttons["Risingson, Massive Attack, 4:58"].waitForExistence(timeout: 5))
    app.buttons["Clear"].tap()
    XCTAssertTrue(app.staticTexts["The queue ends after this track."].waitForExistence(timeout: 5))
    app.buttons["Undo"].tap()
    XCTAssertTrue(app.buttons["Risingson, Massive Attack, 4:58"].waitForExistence(timeout: 5))
  }

  @MainActor
  func testSearchFindsAnArtist() {
    let app = launch()
    app.tabBars.buttons["Search"].tap()
    XCTAssertTrue(app.buttons["Portishead"].waitForExistence(timeout: 5))  // Try an artist
    let field = app.searchFields.firstMatch
    field.tap()
    field.typeText("portis")
    XCTAssertTrue(app.staticTexts["Top result"].waitForExistence(timeout: 5))
    app.buttons["Mysterons, Portishead, Dummy, 5:06"].tap()
    XCTAssertTrue(app.buttons["Open now playing"].waitForExistence(timeout: 5))
  }

  @MainActor
  func testAppearanceChangesTheAccent() {
    let app = launch()
    app.tabBars.buttons["Library"].tap()
    app.buttons["Settings"].tap()
    app.buttons["Appearance"].tap()
    app.buttons["Violet"].tap()
    XCTAssertTrue(app.staticTexts["Violet, whatever is playing."].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["Violet"].isSelected)
  }
}
```

**Step 2: Run them**

```bash
make -C apps/ios test-app
```

Expected: `BrowseTests` (4 tests) and `LaunchTests` pass. If the log says "Restarting after unexpected exit, crash, or test timeout" and another `xcodebuild` (another session) is using the same simulator, run on one of your own: `xcrun simctl create playarr-check "iPhone 17 Pro"`, then `make -C apps/ios test-app SIMULATOR=playarr-check` (this happened while the plan was written: two sessions shared "iPhone 17 Pro"). If a test fails on its own, `xcrun simctl io booted screenshot /tmp/fail.png` and the test's `app.debugDescription` (print it before the failing line) show what was on screen; fix the view (not the test's label) unless the label in the test is the one that's wrong.

**Step 3: Commit**

```bash
git add apps/ios/PlayarrUITests/BrowseTests.swift apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Player.swift apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/PlayerTests.swift docs/plans/2026-11-03-ios-phase4-browse-now-playing.md
git commit -F - <<'MSG'
iOS UI tests: play an album from Home, open and close Now Playing, clear the queue with Undo, search, choose an accent

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 27: Walk through it on the simulator against the dev server

No code. If something is wrong, fix it test-first in the task that owns it and commit there.

**Step 1: The dev server and the app**

The NAS isn't reachable from Claude's shell (macOS Local Network). Ask the user to start the dev server if its media source is on the NAS (`corepack pnpm -C apps/server dev`), or start it if the source is local. Then:

```bash
make -C apps/ios build
xcrun simctl boot "iPhone 17 Pro" 2>/dev/null || true
xcrun simctl install booted apps/ios/build/DerivedData/Build/Products/Debug-iphonesimulator/Playarr.app
xcrun simctl launch booted me.tracklistme.playarr
```

Sign in to the dev server (phase 2's flow).

**Step 2: Check, each against the web app open beside it**

1. Home: every section of the web's Home is there in the same order with the same items; pull to refresh works; the dice rolls new albums.
2. Quit and reopen with Wi-Fi off on the Mac: Home, Artists, Albums and an album opened before show at once (from disk); covers seen before show.
3. Album: disc headers on a multi-disc album, missing songs greyed, liner notes, More by; the header tint matches the web's for the same album.
4. Play an album: the mini player appears above the tabs; the accent turns to the cover's colour (Settings → Appearance → Orange keeps it orange).
5. Now Playing: "Playing from" opens the album; lyrics follow the song; scroll them and they stop following for 4 s; tap a line and it plays from there; swipe down closes it; a short slow drag springs back.
6. Queue: drag a song to the top, swipe one away, Clear then Undo.
7. Search: type an artist's name; Top result, songs (Show all), albums; a playlist's name without its accents finds it.
8. Settings → Playback: Crossfade starts at 6 s; the setting stays after a relaunch. Account button → switch to another account: Home shows that account's mixes and Jump back in, and the first account's queue is back when switching back.

---

### Task 28: On the phone, then TestFlight

**Step 1: Install**

```bash
corepack pnpm ios:device
```

(Or skip to Step 3 and install from TestFlight: the team has no registered devices, see phase 0.)

**Step 2: The checklist (each line: what to do, what should happen)**

- [ ] **Cold start offline** (airplane mode, open the app): Home, Library and pages visited before appear at once from the cache; nothing hangs; covers seen before show.
- [ ] **Lock screen from Now Playing**: lock while playing; the song shows on the lock screen; unlock: Now Playing shows the same song and time.
- [ ] **Swipe down**: Now Playing closes past a short flick or a long drag; a slow short drag springs back.
- [ ] **Mini player**: the tab bar shrinks while scrolling down Home and the mini player stays reachable; tap opens Now Playing.
- [ ] **Haptics**: play/pause, shuffle, repeat, reordering the queue and toasts tap gently.
- [ ] **Dynamic Type** (Settings → Accessibility → Larger Text, largest): pages stay readable; titles wrap; nothing overlaps the transport.
- [ ] **VoiceOver**: every button in Now Playing, the mini player, a song row and an album card says what it is; a toast is read out; a song row says "Playing" or "Paused".
- [ ] **Reduce Motion** (system) with Settings → Appearance → Motion → System: the cover doesn't spring and lyrics jump instead of scrolling; Motion → Full brings the animations back.
- [ ] **Sleep timer**: "In 15 minutes" shows "15 MIN" on the button and counts down; "At the end of this song" stops after the song, with the next one shown paused.
- [ ] **Start radio** from a song's ⋯: the song plays, then similar songs; "Playing from" says "<title> radio".
- [ ] **Account switch**: switch accounts from Library; the first account's music stops, its queue is kept; the lock screen shows nothing from the first account.
- [ ] **Data use**: scroll the Albums grid quickly to the end: covers load, page data isn't fetched for every card (a card has to rest on screen first).

**Step 3: TestFlight**

If the checklist passes, ask the user whether to ship a build to TestFlight: `corepack pnpm ios:beta` (15 to 45 minutes; run it in the background), or push to `main`, which uploads through GitHub Actions. A push to `main` also deploys the server to the user's NAS, so only push when the user says so.

---

## What later phases can rely on

`PlayarrAPI`:

```swift
public protocol APISending: Sendable { func send<T: Decodable & Sendable>(_ endpoint: Endpoint<T>) async throws -> T }
extension APIClient: APISending {}
```

`PlayarrPlayer` (added to phase 3's `Player`): `public func shutDown()`; `NowPlayingBridge.unregister()`.

`PlayarrUI` (abridged):

```swift
@MainActor @Observable public final class AppModel {          // phase 2's, plus:
  public typealias SessionFactory = @MainActor (AccountRecord, AppModel) throws -> AccountSession?
  public init(store:browser:appVersion:device:playback: PlaybackSettings = .init(), appearance: AppearanceSettings = .init(), makeSession: @escaping SessionFactory = AccountSession.live)
  public let playback: PlaybackSettings; public let appearance: AppearanceSettings; public let theme: Theme; public let toasts: ToastCenter
  public private(set) var session: AccountSession?
  public func syncSession()
  public static func demo() -> AppModel                       // -UITestsDemo
}
@MainActor @Observable public final class AccountSession {
  public let key: AccountKey, account: Account, serverName: String, api: any APISending, client: APIClient?
  public let player: Player, queries: QueryCache, images: ImageCache, router: AppRouter, toasts: ToastCenter
  public static func live(_ record: AccountRecord, model: AppModel) throws -> AccountSession?
  public static func demo(_ record: AccountRecord, model: AppModel, api: any APISending = DemoAPI(), offline: Bool = false) throws -> AccountSession
  public static func folder(for key: AccountKey) -> URL          // Application Support/Playarr/<server>/<account>/
  public static func imageFolder(for key: AccountKey) -> URL     // Caches/Playarr/<server>/<account>/images/
  public var actions: TrackActions
  public func close()
}
public struct QueryKey: Hashable, Sendable { name: String; parts: [String]; isKept: Bool; static keptNames; .artists, .artist(_:), .artistTracks(_:), .albums(_:limit:), .randomAlbums(seed:), .album(_:), .favorites, .playlists, .playlist(_:), .mixes, .health, .recentAlbums, .search(_:), .lyrics(_:), .stats(_:), .similarArtists(_:) }
@MainActor public final class QueryCache {
  public static let keepFor: TimeInterval; public static let defaultStaleAfter: TimeInterval
  public init(directory: URL?, now: @escaping () -> Date = Date.init)
  public func cached<T: Codable & Sendable>(_ key: QueryKey, as: T.Type) -> (value: T, updatedAt: Date)?
  public func isStale(_ key: QueryKey, after: TimeInterval) -> Bool
  public func fetch<T: Codable & Sendable>(_ key: QueryKey, _ load: @escaping @Sendable () async throws -> T) async throws -> T
  public func prefetch<T: Codable & Sendable>(_ key: QueryKey, staleAfter: TimeInterval, _ load: …)
  public func set<T: Codable & Sendable>(_ value: T, for key: QueryKey)
  public func invalidate(_ name: String)                        // e.g. "favorites" after a change (phase 6)
  public func flush() async; public func removeExpired() async
}
@MainActor @Observable public final class Query<Value: Codable & Sendable> {
  public init(_ key: QueryKey, cache: QueryCache, staleAfter: TimeInterval = …, fetch: @escaping @Sendable () async throws -> Value)
  public private(set) var value: Value?, error: String?, isFetching: Bool; public var isPending: Bool
  public func load() async; public func refresh() async
}
public actor ImageCache {
  public static let sizes: [Int]; public static func pixels(points: Double, scale: Double) -> Int
  public init(directory: URL, media: MediaURLs, session: URLSession = .shared, retryDelay: Duration = .milliseconds(1500))
  public nonisolated func url(_ path: String?, size: Int) -> URL?
  public func data(_ path: String?, size: Int) async -> Data?; public func data(for url: URL) async -> Data?
  public func prefetch(_ paths: [String?], size: Int); public func prune(now: Date = Date())
}
public enum AccentColor { struct HSL { h, s, l: Int; var rgb: RGB }; static func extract(rgba: [UInt8]) -> HSL?; static func extract(imageData: Data) -> HSL? }
public enum OKLCH { static func rgb(l: Double, c: Double, h: Double) -> RGB }
public struct RGB: Hashable, Sendable { r, g, b: Double; init(hex: UInt32); var color: Color }
@MainActor @Observable public final class AppearanceSettings { accent: Accent (.album | .fixed(Fixed)), motion: Motion, formatBadges: Bool, statsForNerds: Bool; func reduceMotion(system: Bool) -> Bool }   // UserDefaults appearance.*
@MainActor @Observable public final class Theme { static defaultAccent; let appearance; var accent: RGB; var coverAccent: RGB?; func follow(cover:images:) async; func accent(of:images:) async -> RGB? }
@MainActor @Observable public final class ToastCenter { init(clock: any Clock<Duration> = ContinuousClock()); var toasts: [Toast]; func push(_:tone:action:); func dismiss(_:); func perform(_:) }
public enum Route: Hashable, Sendable { album(Int), artist(Int), albums(AlbumSort), artists, favorites, playlists, playlist(Int), mixes, mix(String), listening, settings, settingsPanel(SettingsPanel); init?(href: String) }
public enum AppTab: String { home, search, library, queue }
@MainActor @Observable public final class AppRouter { tab, paths: [AppTab: [Route]], nowPlaying, lyrics; select(_:), open(_:), open(href:), go(_:), showQueue() }
public enum SettingsPanel: String { playback, appearance, sources, mixes, analysis, requests, updates, accounts (+ playerLab in debug); title; static server }
@MainActor public struct TrackActions { playNext(_:), addToQueue(_:), startRadio(_:) async, goToAlbum(_:), goToArtist(_:), playAlbum(_:shuffle:) async, queueAlbum(_:next:) async }
public enum Format { time(_:), duration(_:), plural(_:_:_:), badge(_:), isHiRes(_:), addedAgo(_:now:locale:), parseDate(_:) }
public enum Demo { … the demo library …; static routes; static search(_:) }; public struct DemoAPI: APISending; public actor SilentSource: PCMSource; public struct DemoPlayerBackend: PlayerBackend
extension FavoriteTrack { public var track: Track }
```

Internal, for later phases inside `PlayarrUI`: `RouteDestination` (add a case's page there when it stops being a placeholder), `TrackMenuItems` (append Add to playlist, Show metadata, Edit mix points), `FavoriteButton` (wire it in phase 6), `PlaceholderPage`, the components in `Components/`, `SettingsPanelView` (phase 9 replaces its `default:` placeholder per panel). Tests: `FakeAPI`, `TestClock`, `FakeAPI.demoLibrary()`, `demoModel(api:)`, `demoSession(api:)`.

## Verified while writing

All the Swift in this plan was compiled and run before it was written down, in scratch packages under `/tmp`:

- `PlayarrAPI`: `main`'s real sources (phase 2 as merged, with phase 1's playlist owner fields), plus `APISending`. `APISendingTests` passed against `main`'s real test target (its `StubProtocol`).
- `PlayarrPlayer`: a stand-in with phase 3's public names and signatures. `QueueState`, `PlaybackSettings`, `SleepTimer`, `Radio`, `PlayerBackend`/`APIBackend` and `PCMSource` were copied verbatim from the phase 3 plan; `Player`, `AudioEngine`, `PCMBlock`, `EngineItem`, `NowPlayingBridge`, `LevelStore` and `JSONFile` were stand-ins whose queue methods call the real `QueueState`, so the view-model tests exercised the real queue rules. Task 1's `shutDown()` was checked only against the stand-in, so its test is the one to watch when it meets the real engine.
- `PlayarrUI`: `main`'s phase 2 sources, plus every file of this plan. `swift test --disable-sandbox` passed 92 tests in 21 suites (this plan's 87 in 20 suites, plus phase 2's 5), three runs in a row; `swift build` for `arm64-apple-ios26.0-simulator` (iOS 27.2 SDK) gave no errors or warnings.
- The app: a copy of `apps/ios` with those packages, generated with the pinned XcodeGen and tested with `xcodebuild test` on iPhone 17 Pro simulators (the shared one, and a dedicated one on the iOS 26.1 runtime): `BrowseTests` (4) and phase 2's `LaunchTests` passed. Three bugs were found that way and are fixed in the code above: row labels on a wrapper element (Task 15's note), the sleep timer's label not updating (Task 23's note), and the swipe needing a hit area on the cover (`contentShape`).
- Not verified: anything against the real phase 3 engine (sound, the lock screen, `shutDown()` on a real `AudioEngine`), a real server (Task 27), a device (Task 28).

## Not in this phase

DJ transitions, the transition line and sheet, and Stats for nerds' overlay (phase 5); favorites (the heart), playlists, mixes, Made for you, Your listening, Add to playlist and Save as playlist (phase 6); downloads and "On this device" (phase 7); Discover ("Not in your library" on Search and Artist pages, discover artist pages), requests, Request the rest, Show metadata and Edit mix points (phase 8); the admin panels (phase 9); the iPad split view, keyboard shortcuts and the full accessibility audit (phase 10).
