# Native iOS app, Phase 6: Favorites, Playlists, Mixes and Your Listening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Parity for listening features. The heart works everywhere (song rows, Now Playing, the lock screen's like command) with an optimistic toggle that goes back when the server says no; Favorites plays and shuffles; playlists can be made, filled from any song's menu or the queue, opened, renamed and described, given one of six generated covers, reordered by dragging, shared or kept private, and deleted, with "Songs like these" under your own; others' shared playlists are read-only; Made for you shows each mix with the web's cover (album art under a wash of its OKLCH colour), with New mix, Save as playlist and the time zone sent on every call; Your listening shows each period's report with Swift Charts, and Home links to the year in review.

**Architecture:** Phase 4's `AccountSession` (one per signed-in account) gains three observable stores, `FavoritesStore`, `PlaylistsStore` and `MixesStore`, which keep their answers in phase 4's `QueryCache` under the web's kept keys (`favorites`, `playlists`, `playlist/<id>`, `mixes`), so the app opens with them on screen. Every screen that shows favorites, playlists or mixes (Home, Library, the heart, Add to playlist) reads the same store, so a change shows everywhere at once. Pages are thin SwiftUI views over `@MainActor @Observable` models (`PlaylistModel`, `MixModel`, `StatsModel`, `CoverPickerModel`, `RecommendationsModel`, `AddToPlaylistModel`) that take the session, an injected clock where they poll (covers every 4 s while drawn; mixes 5 s after they're due), and the time zone. One "Add to playlist" sheet hangs on the signed-in shell and any screen opens it with `session.addToPlaylist(_:)`. Phase 4's demo server learns to remember favorites and playlists, so the UI tests make, fill, reorder and delete a playlist without a server.

**Tech Stack:** Swift 6.4 (Xcode 27.2), Swift 6 language mode with strict concurrency, SwiftUI for iOS 26, Swift Charts, Observation, MediaPlayer (`MPRemoteCommandCenter.likeCommand`), Swift Testing, XCUITest. No third-party code.

**Design:** [2026-11-03-ios-app-design.md](2026-11-03-ios-app-design.md): Rollout phase 6, section 1 ("Per-account data"). Names and contracts: [2026-11-03-ios-conventions.md](2026-11-03-ios-conventions.md). What to port, with file references: [2026-11-03-ios-parity-inventory.md](2026-11-03-ios-parity-inventory.md), sections 1 (Favorites, Playlists, Playlist, Mixes, Mix, Your listening, Add to playlist), 3b (favorites, playlists, mixes, stats) and 5 (playlist and mix covers). Server and web side of ownership: [phase 1](2026-11-03-ios-phase1-accounts.md), Tasks 14, 15 and 22. Builds on [phase 2](2026-11-03-ios-phase2-api-sign-in.md), [phase 3](2026-11-03-ios-phase3-audio-engine.md) and [phase 4](2026-11-03-ios-phase4-browse-now-playing.md). This plan covers phase 6 only.

---

## Where things stand (checked 2026-11-03, about 17:00 UTC)

- Phases 1 to 4 are on `main`, and phase 5 is landing (`8e22d1d` "Add Stats for nerds to the iOS app"). Phase 4 left phase 6 its seams: placeholder pages for `.favorites`, `.playlists`, `.playlist`, `.mixes`, `.mix` and `.listening` in `RouteDestination`; a `FavoriteButton` in Now Playing that does nothing; `TrackMenuItems` waiting for "Add to playlist…"; "Phase 6" comments in Now Playing's menu and the Queue. It already ports the mix cover (`MixCard`/`MixCover`), `OKLCH.rgb(l:c:h:)`, the playlist cover (`PlaylistCover`), Home's "Your mixes" and "Year in review" shelves, and `Format` (`plural`, `duration`, `time`, `parseDate`).
- On the server, phase 1 made favorites per account and gave playlists an owner (`PlaylistSummary.owner`, `shared`, `mine`; `shared` on `POST`/`PATCH /api/playlists`; 403 for anyone else's change). The generated Swift models already have the three fields; phase 2's `API.Playlists.create`/`update` don't send `shared` yet (Task 1).
- Every Swift file below was compiled and its tests run against `main`'s real code as of this writing (see "Verified while writing" at the end).

## Key decisions in this plan

- **One store per kind of data, on the session, instead of a `Query` per screen.** Phase 4's Home and Library each made their own `Query` for favorites and playlists. A `Query` keeps its own copy, so a heart tapped on an album page wouldn't show in Home's favorites until it asked again, and the heart on each row needs a fast "is this a favorite?" anyway. `FavoritesStore`, `PlaylistsStore` and `MixesStore` live on `AccountSession` (made in its `init`, so the demo, the tests and the live app all get them), keep their answers in the session's `QueryCache` under the same keys the web persists, and Home and Library read them (Task 9). Switching accounts makes a new session, so nothing of one account's stays on screen, as on the web.
- **The heart is optimistic, with the web's rollback and a guard the web doesn't need.** A toggle changes the list at once, sends PUT or DELETE, puts the old list back with "Couldn't update favorites: <message>" if the server says no, then asks for the list again (`useToggleFavorite`). The web cancels in-flight list queries first; here a counter does it: a list answer that was asked for before a toggle (or while one is in flight) is dropped, so it can't undo the heart on screen.
- **Reordering is sent on the drop, and only when the order changed.** SwiftUI's `onMove` reports a drop, which is the web's `onDragEnd`. `PlaylistModel.move` moves the songs on screen at once, compares the new `itemIds` with the server's order, sends `PUT /order` only when they differ, takes the server's answer, and puts the old order back (with the server's message) if it fails. `PlaylistModel.moved(_:fromOffsets:toOffset:)` is the same arithmetic as `onMove` and is tested on its own. On iOS the page also has an Edit button (reorder handles), which is what VoiceOver users and the UI test use.
- **Ownership is decided in the models, from `mine`.** `PlaylistModel.actions` and `actions(for:)` build the ⋯ menus (Rename, Play next, Add to queue, New cover…, Share with everyone or Stop sharing, Delete playlist; and per song Play next, Add to queue, Add to playlist…, Go to album, Go to artist, Remove from playlist), and every change returns early unless the playlist is yours, so another account's shared playlist plays and queues but can't be changed, and nothing is sent. "Add to playlist" lists only your own (`PlaylistsStore.mine`). "Songs like these" shows only under your own (its Add changes the playlist), as phase 1's web task does.
- **Covers are the server's; the app shows and polls.** The cover picker asks the server for six candidates (`/art/playlist/:id/preview?layout&variant`, through phase 4's `Cover` and `ImageCache`, which add `size`), starting at the cover's own variation + 1 and moving on with Shuffle; "Use this" sends `PUT /cover`. While a cover is still being drawn (`cover.pending`), the Playlists grid and the playlist page ask again every 4 s on an injected clock (the web's `COVER_POLL_MS`), and a change that leaves a cover pending starts polling again (`pollRound`).
- **Mix covers reuse phase 4's port, with the web's angle.** Phase 4's `OKLCH.rgb(l:c:h:)` (Björn Ottosson's matrices, sRGB, clipped) is kept; Task 3 checks it against CSS Color 4's own values for the sRGB primaries, white and grey. Phase 4's `MixCover` runs its wash from the top-left corner to the bottom-right (135°); the web's is `linear-gradient(165deg, …)`. `CSSGradient.points(angle:)` turns a CSS angle into SwiftUI unit points (the line through the centre, long enough for the corners) and `MixCover` uses 165°.
- **The time zone goes with every mix call.** Phase 2's `API.Mixes` already adds `?tz=`; `MixesStore` and `MixModel` take a `timeZone` (default `TimeZone.current`) and pass it on every call, so tests can check `tz=Europe/Rome` was sent. Mixes are asked again 5 s after the next is due, 15 s when that's past, and every minute otherwise (`mixRecheck`), while their screen is up.
- **Your listening keeps its period in the route.** Phase 4's `Route.listening` has no period, so the year in review card and "Playing from" links to `/settings/listening?range=2025` lost it. Task 20 adds `Route.listeningRange(StatsRange)` (`Route(href:)` reads `range`), and Home's year in review opens its year. The charts are Swift Charts bars in the accent colour, the busiest column named above them ("Most: 9 PM · 2 h 5 min") and the one under the finger instead; each chart reads its numbers to VoiceOver.
- **The lock screen's like command toggles the song playing.** Phase 3's `NowPlayingBridge.Commands.like` is fixed when the player is made, and `AccountSession.live` makes the player before the session. So `Player.live` gains a `like: (Track) -> Void` parameter, and the session passes a closure that finds the session through a weak `SessionReference` filled in once it exists. `NowPlayingBridge.setLiked(_:)` shows the state (the command's `isActive`, "Add to favorites" / "Remove from favorites"), kept in step by the shell.
- **The demo server remembers.** Phase 4's `DemoAPI` answers from fixed routes. `DemoState` (a `Mutex`) now answers favorites, playlists (create, rename, share, add, remove, reorder, cover, delete, recommendations), the mix's page, regenerate and save, and stats, so the UI tests (`-UITestsDemo`) need no server, as phase 4's do.
- **Deviations from the web, all small.** A playlist row's ⋯ menu also has "Add to playlist…" (the brief asks for it from every song's menu; the web's playlist rows lack it). "Tune your mixes" isn't on Made for you until phase 9 brings Settings → Mixes. Download (phase 7), Show metadata and the request button (phase 8) have marked places. Out-of-gamut OKLCH colours are clipped in sRGB, where Safari would draw them in Display P3 on an iPhone: the mix washes are dark and well inside sRGB, so they look the same.

## Conventions

- Run everything from the repo root `/Users/bortignon/dev/playarr`. `pnpm` is `corepack pnpm` in Claude's shell.
- One package's tests: `swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI` (one suite: `--filter FavoritesStoreTests`). Same for `PlayarrAPI` and `PlayarrPlayer`. `--disable-sandbox` because SwiftPM's sandbox can't start inside Claude's shell.
- Build the UI package for the iPhone simulator (catches iOS-only API mistakes the Mac build can't):
  ```bash
  swift build --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --triple arm64-apple-ios26.0-simulator --sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" --scratch-path /tmp/playarr-ui-ios
  ```
- Everything iOS (scripts, the three packages, then the app and its UI tests on a simulator): `make -C apps/ios test`. Use a simulator of your own, never the shared one: `xcrun simctl create "Playarr P6" "iPhone 17 Pro"` once, then `make -C apps/ios test-app SIMULATOR="Playarr P6"`.
- Swift: 2-space indentation in hand-written files; phase 2's four-space files (`API+Playlists.swift`, `AppModel.swift`) keep their four. One primary type per file, named after it. No force unwraps outside tests. Swift Testing in packages, XCUITest for the app. View models take the session (its `api` is `any APISending`), and polling ones an injected `clock: any Clock<Duration>`. Tests use phase 4's shared `FakeAPI`, `TestClock` and `demoSession(api:)`.
- User-facing text is the web's, copied from the components named in each task. Where the web names the browser, say "this device".
- Below, `UI/…` is short for `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/…` and `UITests/…` for `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/…` (the package's tests, not the XCUITest target `apps/ios/PlayarrUITests/`). Code blocks always give the full path.
- Commit after every task, on `main`, only that task's files, with the message given (plain-English subject, a body where useful, a blank line, the `Co-Authored-By` line). The pre-commit hook bumps the version: never bypass it. The user pushes (a push to `main` also deploys the server to the NAS, so ask first).

## Before you start

Phases 1 to 4 are done (and phase 5 may be). This plan relies on these names; Task 0 checks them.

- **Phase 1 (server):** per-account favorites (`/api/favorites`), playlists with `owner`, `shared`, `mine`, `shared` accepted by `POST`/`PATCH /api/playlists`, 403 for another account's change, `/art/playlist/:id/preview`.
- **Phase 2 (`PlayarrAPI`):** the models `Track`, `FavoriteTrack`, `PlaylistSummary`, `PlaylistDetail`, `PlaylistItem`, `PlaylistCoverInfo` (`url`, `layout`, `variant`, `frozen`, `stale`, `tempo`, `energy`, `styles`, `era`, `analyzed`, `total`, `pending`), `CoverLayout` (`.currents`…`.blocks`, `.unknown`), `Recommendations`, `RecommendedTrack`, `AlbumRef`, `MixSummary`, `MixDetail`, `MixKind`, `ListeningStats` (and its nested `TopArtistsItem`, `TopTracksItem`, `FirstSong`), `StatsRange` (= `String`); `Endpoint`, `HTTPMethod`, `NoContent`, `APIError`; `API.Favorites.list()/add(recordingId:)/remove(recordingId:)`, `API.Playlists.list()/get(id:)/create(name:description:recordingIds:)/update(id:name:description:)/delete(id:)/addItems(id:recordingIds:)/removeItem(id:itemId:)/reorder(id:itemIds:)/setCover(id:layout:variant:)/recommendations(id:variant:)`, `API.Mixes.list(timeZone:)/get(key:timeZone:)/regenerate(key:timeZone:)/save(key:timeZone:)`, `API.Stats.listening(_:)`.
- **Phase 3 (`PlayarrPlayer`):** `Player` (`queue`, `play(_:startAt:source:shuffle:at:)`, `playNext`, `addToQueue`, `nowPlaying`), `Player.live(backend:directory:settings:)` in `PlayerLive.swift`, `QueueState` (`currentTrack`, `order`, `pos`, `queue`, `upcoming(_:)`, `source`, `shuffle`), `PlaySource`, `NowPlayingBridge` (`Commands(play:pause:toggle:next:previous:seek:like:)`, and phase 4's `unregister()`).
- **Phase 4 (`PlayarrUI`):** `AccountSession` (`api`, `player`, `queries`, `toasts`, `router`, `actions`, `live(_:model:)`, `demo(_:model:api:offline:)`), `QueryCache` (`cached(_:as:)`, `set(_:for:)`, `fetch(_:_:)`), `QueryKey` (`.favorites`, `.playlists`, `.playlist(_:)`, `.mixes`, `.stats(_:)`), `ToastCenter` (`push(_:tone:)`, `toasts`), `TrackActions` (`playNext`, `addToQueue`, `goToAlbum`, `goToArtist`), `Route` and `Route(href:)`, `AppRouter.open(_:)`, `RouteDestination`, `PlaceholderPage`, `Theme` (`accent.color`), `OKLCH.rgb(l:c:h:)` and `RGB` (`r`, `g`, `b`), `Format` (`plural`, `duration`, `time`, `parseDate`), the components `Cover(path:points:label:circle:corner:)`, `PlaylistCover(cover:points:name:)`, `PlaylistCard`, `MixCard`/`MixCover(mix:width:)`, `TrackRow(track:style:onTap:)`, `TrackMenuItems`, `Kicker`, `Skeleton`, `ErrorState`, `ShelfCard.width`, `AlbumCard`; the pages `HomeModel`/`HomeView`, `LibraryView`, `QueueView`, `NowPlayingView`, `FavoriteButton` (a placeholder), `AppShell`; the demo `Demo`, `DemoAPI`; the test helpers `FakeAPI` (`on`, `then`, `fail`, `calls`, `bodies`), `FakeAPI.demoLibrary()`, `TestClock`, `demoSession(api:)`.
- **Phase 5:** nothing; it adds lines next to some of the anchors below (`TransitionLine`, the Stats for nerds overlay), which don't overlap them.

If a name differs, change it in the task that uses it, and nowhere else.

---

### Task 0: Check the starting point

**Files:** none.

**Step 1: The names this plan uses are there**

```bash
grep -n "public static func create(name: String, description: String? = nil, recordingIds: \[String\]? = nil) ->" apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/Endpoints/API+Playlists.swift
grep -n "public var mine: Bool" apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/Models.generated.swift
grep -n "public static func live(backend: any PlayerBackend, directory: URL, settings: PlaybackSettings = PlaybackSettings()) throws -> Player" apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PlayerLive.swift
grep -n "public func unregister()" apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/NowPlayingBridge.swift
grep -n "public final class AccountSession\|public let toasts: ToastCenter" apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Session/AccountSession.swift
grep -n "PlaceholderPage(title: \"Favorites\")  // phase 6" apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/RouteDestination.swift
grep -n "Phase 6 makes it add and remove favorites" apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/NowPlaying/FavoriteButton.swift
grep -n "public enum OKLCH" apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Theme/OKLCH.swift
grep -n "func demoSession" apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/Support/TestSession.swift
grep -rn "enum Polling\|class Gate\|actor Gate" apps/ios/Packages/PlayarrUI
```

Expected: every grep but the last prints a line; the last prints nothing (if phase 9 already added `Polling`, skip creating it in Task 2 and use it; if a `Gate` exists in the UI tests, keep it and skip that file).

**Step 2: Everything passes now**

```bash
make -C apps/ios test SIMULATOR="Playarr P6"
```

Expected: the scripts' tests, the three packages' suites and the app's UI tests pass. Note the counts: later tasks add to them. (Create the simulator first if it doesn't exist: `xcrun simctl create "Playarr P6" "iPhone 17 Pro"`.)

---

### Task 1: Playlists can be shared from the app

Phase 1 accepts `shared` on `POST` and `PATCH /api/playlists`; phase 2's endpoints don't send it yet. `nil` leaves it out of the JSON (the server's default for a new playlist is private), as phase 2's other patch bodies do.

**Files:**
- Modify: `apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/Endpoints/API+Playlists.swift` (four spaces, like the file)
- Test: `apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/ListeningEndpointTests.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/ListeningEndpointTests.swift`:

```swift
import Foundation
import Testing
@testable import PlayarrAPI

/// Playlists can be shared with everyone on the server (phase 1's `shared`), from the app too.
@Suite struct ListeningEndpointTests {
  private func body<T>(_ endpoint: Endpoint<T>) throws -> [String: Any] {
    let data = try #require(try endpoint.bodyData())
    return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
  }

  @Test func sharesAPlaylistOnlyWhenAsked() throws {
    #expect(try body(API.Playlists.create(name: "Road trip")).keys.sorted() == ["name"])
    let shared = try body(API.Playlists.create(name: "Road trip", recordingIds: ["track:1"], shared: true))
    #expect(shared["shared"] as? Bool == true)
    #expect(shared["recordingIds"] as? [String] == ["track:1"])
  }

  @Test func changesOnlyWhatAPatchSays() throws {
    let stop = try body(API.Playlists.update(id: 5, shared: false))
    #expect(stop.keys.sorted() == ["shared"])
    #expect(stop["shared"] as? Bool == false)
    #expect(try body(API.Playlists.update(id: 5, name: "Night", description: "")).keys.sorted() == ["description", "name"])
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrAPI --filter ListeningEndpointTests
```

Expected: the build fails with `extra argument 'shared' in call`.

**Step 3: Implement**

In `API+Playlists.swift`, the two constructors:

Replace:

```swift
        public static func create(name: String, description: String? = nil, recordingIds: [String]? = nil) -> Endpoint<PlaylistDetail> {
            Endpoint(.post, "/api/playlists", body: CreateBody(name: name, description: description, recordingIds: recordingIds))
        }

        public static func update(id: Int, name: String? = nil, description: String? = nil) -> Endpoint<PlaylistDetail> {
            Endpoint(.patch, "/api/playlists/\(id)", body: UpdateBody(name: name, description: description))
        }
```

with:

```swift
        /// `shared`: visible to every account on the server (nil leaves the server's default, private).
        public static func create(name: String, description: String? = nil, recordingIds: [String]? = nil, shared: Bool? = nil) -> Endpoint<PlaylistDetail> {
            Endpoint(.post, "/api/playlists", body: CreateBody(name: name, description: description, recordingIds: recordingIds, shared: shared))
        }

        /// Only the fields given change. Only the playlist's owner may call it (403 otherwise).
        public static func update(id: Int, name: String? = nil, description: String? = nil, shared: Bool? = nil) -> Endpoint<PlaylistDetail> {
            Endpoint(.patch, "/api/playlists/\(id)", body: UpdateBody(name: name, description: description, shared: shared))
        }
```

`CreateBody`:

Replace:

```swift
            let recordingIds: [String]?
        }
```

with:

```swift
            let recordingIds: [String]?
            let shared: Bool?
        }
```

`UpdateBody`:

Replace:

```swift
        private struct UpdateBody: Encodable, Sendable {
            let name: String?
            let description: String?
        }
```

with:

```swift
        private struct UpdateBody: Encodable, Sendable {
            let name: String?
            let description: String?
            let shared: Bool?
        }
```

**Step 4: Run the package to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrAPI
```

Expected: every PlayarrAPI suite passes, `ListeningEndpointTests` (2 tests) included; phase 2's `EndpointTests` still send only what they set.

**Commit**

```bash
git add apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/Endpoints/API+Playlists.swift apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/ListeningEndpointTests.swift
git commit -F - <<'MSG'
iOS: share a playlist with everyone on the server, or stop, from the app

API.Playlists.create and update take shared (nil leaves it out), as
phase 1's server accepts.

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 2: Test helpers: queries and held answers in `FakeAPI`, a gate, phase 6's songs, and the polling loop

The mix tests need to see the `?tz=` each call sent, and the favorites tests need an answer held back to look at the heart before the server answers. `FakeAPI` gains `queries(_:_:)` and `before(_:)`; `Gate` holds a call until the test opens it. `Polling.run` is phase 9's loop (its Task 2 has the same code): phase 6 is built first, so it adds it under `UI/Support/`, where phase 9 should find it instead of making another (see the convention note at the end).

**Files:**
- Modify: `UITests/Support/FakeAPI.swift`
- Create: `UITests/Support/Gate.swift`, `UITests/Support/Listening.swift`
- Create: `UI/Support/Polling.swift`
- Test: `UITests/PollingTests.swift`

**Step 1: Write the test doubles and the failing test**

In `UITests/Support/FakeAPI.swift`, the state remembers queries and a hook:

Replace:

```swift
  private struct State {
    var answers: [String: [Answer]] = [:]
    var calls: [Call] = []
  }
```

with:

```swift
  private struct State {
    var answers: [String: [Answer]] = [:]
    var calls: [Call] = []
    /// Each call's query string, by "METHOD path" ("tz=Europe/Rome").
    var queries: [String: [String]] = [:]
    var before: (@Sendable (Call) async -> Void)?
  }
```

and `send` records the query, then runs the hook before answering (the rest of `send` stays):

Replace:

```swift
  func send<T: Decodable & Sendable>(_ endpoint: Endpoint<T>) async throws -> T {
    let body = try endpoint.bodyData().map(Self.sorted)
    let answer: Answer? = state.withLock { state in
      state.calls.append(Call(method: endpoint.method, path: endpoint.path, body: body))
      let key = key(endpoint.method, endpoint.path)
```

with:

```swift
  /// The query strings sent to `method path`, in order ("tz=Europe/Rome").
  func queries(_ method: HTTPMethod, _ path: String) -> [String] {
    state.withLock { $0.queries[key(method, path)] ?? [] }
  }

  /// Runs before each answer, after the call is recorded: a test holds an answer back with a `Gate`.
  func before(_ hook: @escaping @Sendable (Call) async -> Void) {
    state.withLock { $0.before = hook }
  }

  func send<T: Decodable & Sendable>(_ endpoint: Endpoint<T>) async throws -> T {
    let body = try endpoint.bodyData().map(Self.sorted)
    let call = Call(method: endpoint.method, path: endpoint.path, body: body)
    let before = state.withLock { state in
      state.calls.append(call)
      state.queries[key(endpoint.method, endpoint.path), default: []]
        .append(endpoint.query.map { "\($0.name)=\($0.value ?? "")" }.joined(separator: "&"))
      return state.before
    }
    await before?(call)
    let answer: Answer? = state.withLock { state in
      let key = key(endpoint.method, endpoint.path)
```

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/Support/Gate.swift`:

```swift
/// Holds callers back until a test opens it: an answer from `FakeAPI` that hasn't arrived yet.
actor Gate {
  private var open = false
  private var waiting: [CheckedContinuation<Void, Never>] = []

  func wait() async {
    if open { return }
    await withCheckedContinuation { waiting.append($0) }
  }

  func release() {
    open = true
    for continuation in waiting { continuation.resume() }
    waiting = []
  }
}
```

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/Support/Listening.swift`:

```swift
import PlayarrAPI
@testable import PlayarrUI

/// Playlists, mixes and stats for the phase 6 tests, built from the demo library's songs (Angel, Risingson,
/// Inertia Creeps, …), with only what each test cares about to say.
enum Listening {
  static let angel = Demo.mezzanineTracks[0]
  static let risingson = Demo.mezzanineTracks[1]
  static let inertia = Demo.mezzanineTracks[2]

  static func cover(pending: Bool = false, layout: CoverLayout = .ridges, variant: Int = 0) -> PlaylistCoverInfo {
    PlaylistCoverInfo(
      url: "/art/playlist/5?v=1", layout: layout, variant: variant, frozen: !pending, stale: false, energy: 0.5, styles: [],
      analyzed: pending ? 1 : 3, total: 3, pending: pending)
  }

  /// A playlist item: its id, and the song when the viewer's library has it.
  static func item(_ itemId: Int, _ track: Track?) -> PlaylistItem {
    PlaylistItem(
      itemId: itemId, recordingId: track?.recordingId ?? "rec-gone-\(itemId)", title: track?.title ?? "Gone \(itemId)",
      artistName: "Massive Attack", albumTitle: "Mezzanine", addedAt: "2026-11-03T10:00:00.000Z", track: track)
  }

  /// Angel, Risingson and Inertia Creeps as items 1, 2 and 3.
  static let three = [item(1, angel), item(2, risingson), item(3, inertia)]

  static func playlist(
    _ id: Int = 5, _ name: String = "Road trip", items: [PlaylistItem] = [], mine: Bool = true, shared: Bool = false,
    owner: String = "Demo", pending: Bool = false
  ) -> PlaylistDetail {
    PlaylistDetail(
      id: id, name: name, description: "", trackCount: items.count, duration: items.compactMap(\.track).reduce(0) { $0 + $1.duration },
      cover: cover(pending: pending), updatedAt: "2026-11-03T10:00:00.000Z", owner: owner, shared: shared, mine: mine, items: items)
  }

  static func summary(_ detail: PlaylistDetail) -> PlaylistSummary {
    PlaylistSummary(
      id: detail.id, name: detail.name, description: detail.description, trackCount: detail.trackCount, duration: detail.duration,
      cover: detail.cover, updatedAt: detail.updatedAt, owner: detail.owner, shared: detail.shared, mine: detail.mine)
  }

  static func mix(refreshesAt: String = "2026-11-03T12:00:00.000Z", tracks: [Track] = []) -> MixDetail {
    MixDetail(
      key: "vibes", kind: .vibes, title: "Your vibes", subtitle: "Massive Attack and more", description: "Songs you play the most",
      trackCount: tracks.count, duration: tracks.reduce(0) { $0 + $1.duration }, covers: [], hue: 210,
      generatedAt: "2026-11-03T10:00:00.000Z", refreshesAt: refreshesAt, tracks: tracks)
  }

  static func summary(_ mix: MixDetail) -> MixSummary {
    MixSummary(
      key: mix.key, kind: mix.kind, title: mix.title, subtitle: mix.subtitle, description: mix.description, trackCount: mix.trackCount,
      duration: mix.duration, covers: mix.covers, hue: mix.hue, generatedAt: mix.generatedAt, refreshesAt: mix.refreshesAt)
  }

  static func stats(range: String = "month", plays: Int = 40, years: [Int] = [2026, 2025]) -> ListeningStats {
    ListeningStats(
      range: range, to: "2026-11-03T10:00:00.000Z", minutes: 95, plays: plays, songs: 37, artists: 12, days: 9, newArtists: 1234,
      longestStreak: 1, topArtists: [.init(artist: Demo.artist, plays: 20, minutes: 80)], topAlbums: [],
      topTracks: [.init(track: angel, plays: 5), .init(track: risingson, plays: 3)], topGenres: [],
      hours: Array(repeating: 0, count: 24), weekdays: Array(repeating: 0, count: 7), years: years)
  }
}
```

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/PollingTests.swift`:

```swift
import Testing
@testable import PlayarrUI

@MainActor @Suite struct PollingTests {
  @Test func refreshesThenWaitsTheIntervalUntilItSaysStop() async {
    let clock = TestClock()
    var refreshes = 0
    var interval: Duration? = .seconds(4)
    let task = Task { await Polling.run(clock: clock, interval: { interval }, refresh: { refreshes += 1 }) }
    #expect(await clock.nextSleep() == .seconds(4))
    #expect(refreshes == 1)
    interval = nil
    clock.advance(by: .seconds(4))
    await task.value
    #expect(refreshes == 2)
  }

  @Test func stopsWhenCancelled() async {
    let clock = TestClock()
    let task = Task { await Polling.run(clock: clock, interval: { .seconds(4) }, refresh: {}) }
    _ = await clock.nextSleep()
    task.cancel()
    await task.value
    #expect(clock.pendingSleep == nil)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter PollingTests
```

Expected: the build fails with `cannot find 'Polling' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Support/Polling.swift`:

```swift
/// Asks the server again and again while a screen is up: `refresh`, then wait `interval()` on `clock`,
/// until the task is cancelled (the screen went away) or `interval()` says nil (nothing to follow).
@MainActor
enum Polling {
  static func run(clock: any Clock<Duration>, interval: () -> Duration?, refresh: () async -> Void) async {
    while !Task.isCancelled {
      await refresh()
      guard let wait = interval() else { return }
      do {
        try await clock.sleep(for: wait)
      } catch {
        return
      }
    }
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter PollingTests
```

Expected: `Test run with 2 tests in 1 suite passed`.

**Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/Support/FakeAPI.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/Support/Gate.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/Support/Listening.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/PollingTests.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Support/Polling.swift
git commit -F - <<'MSG'
iOS: a polling loop for screens that follow the server, and test helpers to see queries and hold answers back

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 3: The web's words for minutes and when a mix changes, and the mix cover's angle

Ports `minutesLabel` (pages/Stats.tsx), `toLocaleString` counts, and `changesLabel` (pages/Mix.tsx) into phase 4's `Format`; `CSSGradient` places a CSS angle on a box. The same test checks phase 4's `OKLCH.rgb` against CSS Color 4's values.

**Files:**
- Create: `UI/Support/Format+Listening.swift`, `UI/Theme/CSSGradient.swift`
- Test: `UITests/ListeningFormatTests.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/ListeningFormatTests.swift`:

```swift
import Foundation
import SwiftUI
import Testing
@testable import PlayarrUI

@Suite struct ListeningFormatTests {
  let english = Locale(identifier: "en_US")

  @Test func saysMinutesHeard() {
    #expect(Format.minutes(45, locale: english) == "45 min")
    #expect(Format.minutes(95, locale: english) == "1 h 35 min")
    #expect(Format.minutes(120, locale: english) == "2 h")
    #expect(Format.minutes(61_000, locale: english) == "1,016 h 40 min")
    #expect(Format.number(5678, locale: english) == "5,678")
  }

  @Test func saysWhenAMixChanges() throws {
    let now = try #require(Format.parseDate("2026-11-03T10:00:00.000Z"))  // a Tuesday
    #expect(Format.changes(at: now.addingTimeInterval(40 * 60), now: now) == "Changes in 40 min")
    #expect(Format.changes(at: now.addingTimeInterval(10), now: now) == "Changes in 1 min")
    #expect(Format.changes(at: now.addingTimeInterval(9 * 3600), now: now) == "Changes in 9 h")
    let utc = TimeZone(identifier: "UTC")!
    #expect(Format.changes(at: now.addingTimeInterval(6 * 86400), now: now, locale: english, timeZone: utc) == "Changes on Monday")
  }

  private func close(_ rgb: RGB, _ r: Double, _ g: Double, _ b: Double) -> Bool {
    abs(rgb.r - r) < 0.002 && abs(rgb.g - g) < 0.002 && abs(rgb.b - b) < 0.002
  }

  /// CSS Color 4's own conversions of the sRGB primaries, white and a mid grey.
  @Test func turnsKnownOKLCHColoursIntoSRGB() {
    #expect(close(OKLCH.rgb(l: 0.627_955, c: 0.257_683, h: 29.233_885), 1, 0, 0))
    #expect(close(OKLCH.rgb(l: 0.866_440, c: 0.294_827, h: 142.495_339), 0, 1, 0))
    #expect(close(OKLCH.rgb(l: 0.452_014, c: 0.313_214, h: 264.052_021), 0, 0, 1))
    #expect(close(OKLCH.rgb(l: 1, c: 0, h: 0), 1, 1, 1))
    #expect(close(OKLCH.rgb(l: 0.598_708, c: 0, h: 0), 0.5, 0.5, 0.5))
    let wide = OKLCH.rgb(l: 0.62, c: 0.4, h: 150)
    for channel in [wide.r, wide.g, wide.b] { #expect((0...1).contains(channel)) }
  }

  @Test func placesCSSGradientAngles() {
    let down = CSSGradient.points(angle: 180)
    #expect(abs(down.start.x - 0.5) < 1e-9 && abs(down.start.y) < 1e-9 && abs(down.end.y - 1) < 1e-9)
    let right = CSSGradient.points(angle: 90)
    #expect(abs(right.start.x) < 1e-9 && abs(right.end.x - 1) < 1e-9 && abs(right.end.y - 0.5) < 1e-9)
    // The mix cover's 165deg: mostly down, a little to the right, corner to corner.
    let mix = CSSGradient.points(angle: 165)
    #expect(abs(mix.start.x - 0.341_5) < 0.001 && abs(mix.start.y - -0.091_5) < 0.001)
    #expect(abs(mix.end.x - 0.658_5) < 0.001 && abs(mix.end.y - 1.091_5) < 0.001)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter ListeningFormatTests
```

Expected: the build fails with `type 'Format' has no member 'minutes'` and `cannot find 'CSSGradient' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Support/Format+Listening.swift`:

```swift
import Foundation

extension Format {
  /// 5678 → "5,678" in English.
  public static func number(_ value: Int, locale: Locale = .current) -> String {
    value.formatted(.number.locale(locale))
  }

  /// Minutes heard: 45 → "45 min", 95 → "1 h 35 min", 120 → "2 h" (pages/Stats.tsx minutesLabel).
  public static func minutes(_ value: Double, locale: Locale = .current) -> String {
    let m = Int(value.rounded())
    if m < 60 { return "\(m) min" }
    return "\(number(m / 60, locale: locale)) h" + (m % 60 == 0 ? "" : " \(m % 60) min")
  }

  /// When a mix is made again: "Changes in 40 min", "Changes in 9 h", "Changes on Monday" (pages/Mix.tsx changesLabel).
  public static func changes(at date: Date, now: Date = Date(), locale: Locale = .current, timeZone: TimeZone = .current) -> String {
    let minutes = max(1, Int((date.timeIntervalSince(now) / 60).rounded()))
    if minutes < 90 { return "Changes in \(minutes) min" }
    if minutes < 24 * 60 { return "Changes in \(Int((Double(minutes) / 60).rounded())) h" }
    var style = Date.FormatStyle(locale: locale, timeZone: timeZone).weekday(.wide)
    style.calendar = Calendar(identifier: .gregorian)
    return "Changes on \(date.formatted(style))"
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Theme/CSSGradient.swift`:

```swift
import SwiftUI

/// Where a CSS `linear-gradient(<angle>deg, …)` starts and ends on a box, as SwiftUI unit points. CSS angles turn
/// clockwise from "to top", and the gradient line runs through the centre, long enough for the corners to get the
/// first and last colours.
enum CSSGradient {
  static func points(angle degrees: Double, width: Double = 1, height: Double = 1) -> (start: UnitPoint, end: UnitPoint) {
    let radians = degrees * .pi / 180
    // The direction on screen (y grows downwards): 0deg is up, 90deg right, 180deg down.
    let (dx, dy) = (sin(radians), -cos(radians))
    let length = abs(width * dx) + abs(height * dy)
    let half = (x: dx * length / 2 / width, y: dy * length / 2 / height)
    return (UnitPoint(x: 0.5 - half.x, y: 0.5 - half.y), UnitPoint(x: 0.5 + half.x, y: 0.5 + half.y))
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter ListeningFormatTests
```

Expected: `Test run with 4 tests in 1 suite passed`. (`turnsKnownOKLCHColoursIntoSRGB` passes against phase 4's `OKLCH` unchanged; if it doesn't, fix `OKLCH.swift`, not the expected values: they are CSS Color 4's.)

**Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Support/Format+Listening.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Theme/CSSGradient.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/ListeningFormatTests.swift
git commit -F - <<'MSG'
iOS: minutes heard and when a mix changes in the web's words, and CSS gradient angles

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 4: Favorites: an optimistic heart that goes back when the server says no

Ports `useFavorites`, `useIsFavorite` and `useToggleFavorite` (apps/web/src/lib/queries.ts). The store keeps the list in the session's cache under `favorites`, so the app opens with it.

**Files:**
- Create: `UI/Pages/Favorites/FavoritesStore.swift`, `UI/Pages/Favorites/FavoriteTrack+Song.swift`
- Test: `UITests/FavoritesStoreTests.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/FavoritesStoreTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct FavoritesStoreTests {
  let api = FakeAPI()
  let toasts = ToastCenter(clock: TestClock())

  func store() -> FavoritesStore { FavoritesStore(api: api, queries: QueryCache(directory: nil), toasts: toasts) }

  @Test func heartsASongAtOnceAndKeepsWhatTheServerSays() async {
    api.on(.get, "/api/favorites", [Demo.favorite])
    let favorites = store()
    await favorites.load()
    let gate = Gate()
    api.before { call in if call.method == .put { await gate.wait() } }
    api.on(.put, "/api/favorites/rec-700", json: "")
    let toggling = Task { await favorites.toggle(Listening.angel) }
    while api.calls(.put, "/api/favorites/rec-700").isEmpty { await Task.yield() }
    #expect(favorites.isFavorite("rec-700"))
    #expect(favorites.tracks?.map(\.title) == ["Angel", "Risingson"])
    api.on(.get, "/api/favorites", [FavoriteTrack(Listening.angel, favoritedAt: "2026-11-03T10:00:00.000Z"), Demo.favorite])
    await gate.release()
    await toggling.value
    #expect(api.calls(.get, "/api/favorites").count == 2)
    #expect(favorites.tracks?.map(\.title) == ["Angel", "Risingson"])
  }

  @Test func putsTheHeartBackWhenTheServerSaysNo() async {
    api.on(.get, "/api/favorites", [Demo.favorite])
    let favorites = store()
    await favorites.load()
    api.fail(.delete, "/api/favorites/rec-701", status: 404, "Song not found in the library")
    await favorites.toggle(Listening.risingson)
    #expect(favorites.isFavorite("rec-701"))
    #expect(favorites.tracks?.map(\.title) == ["Risingson"])
    #expect(toasts.toasts.map(\.message) == ["Couldn't update favorites: Song not found in the library"])
    #expect(toasts.toasts.map(\.tone) == [.error])
  }

  @Test func aListAskedForBeforeAToggleDoesntUndoIt() async {
    let gate = Gate()
    api.on(.get, "/api/favorites", json: "[]")
    api.on(.put, "/api/favorites/rec-703", json: "")
    api.before { call in if call.method == .get { await gate.wait() } }
    let favorites = store()
    let loading = Task { await favorites.load() }
    while api.calls(.get, "/api/favorites").isEmpty { await Task.yield() }
    api.before { _ in }
    api.on(.get, "/api/favorites", [FavoriteTrack(Listening.inertia, favoritedAt: "2026-11-03T10:00:00.000Z")])
    await favorites.toggle(Listening.inertia)
    await gate.release()
    await loading.value
    #expect(favorites.isFavorite("rec-703"))
  }

  @Test func opensWithTheFavoritesKeptLastTime() {
    let queries = QueryCache(directory: nil)
    queries.set([Demo.favorite], for: .favorites)
    let favorites = FavoritesStore(api: api, queries: queries, toasts: toasts)
    #expect(favorites.isFavorite("rec-701"))
    #expect(favorites.duration == 298)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter FavoritesStoreTests
```

Expected: the build fails with `cannot find 'FavoritesStore' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Favorites/FavoriteTrack+Song.swift`:

```swift
import PlayarrAPI

extension FavoriteTrack {
  /// A song hearted at `favoritedAt` (ISO 8601), as GET /api/favorites lists it.
  init(_ track: Track, favoritedAt: String) {
    self.init(
      id: track.id, recordingId: track.recordingId, fileId: track.fileId, albumId: track.albumId, artistId: track.artistId,
      title: track.title, artistName: track.artistName, albumTitle: track.albumTitle, trackNumber: track.trackNumber,
      discNumber: track.discNumber, duration: track.duration, explicit: track.explicit, format: track.format, size: track.size,
      streamUrl: track.streamUrl, coverUrl: track.coverUrl, favoritedAt: favoritedAt)
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Favorites/FavoritesStore.swift`:

```swift
import Foundation
import Observation
import PlayarrAPI
import PlayarrPlayer

/// The account's favorite songs, and the heart on every song: a toggle shows at once, goes back if the server says no
/// (with the web's toast), and the list is asked for again either way (apps/web/src/lib/queries.ts useToggleFavorite).
/// Kept in the answer cache under `favorites`, so the app opens with them.
@MainActor @Observable
public final class FavoritesStore {
  /// Newest first; nil until known.
  public private(set) var tracks: [FavoriteTrack]?
  public private(set) var error: String?
  private var ids: Set<String> = []

  @ObservationIgnored private let api: any APISending
  @ObservationIgnored private let queries: QueryCache
  @ObservationIgnored private let toasts: ToastCenter
  /// Bumped by every toggle, so a list asked for before one doesn't undo it on screen.
  @ObservationIgnored private var changes = 0
  @ObservationIgnored private var inFlight = 0

  public static let source = PlaySource(label: "Favorites", href: "/favorites")

  public init(api: any APISending, queries: QueryCache, toasts: ToastCenter) {
    self.api = api
    self.queries = queries
    self.toasts = toasts
    show(queries.cached(.favorites, as: [FavoriteTrack].self)?.value)
  }

  public func isFavorite(_ recordingId: String) -> Bool { ids.contains(recordingId) }

  /// Seconds of music in the list.
  public var duration: Double { tracks?.reduce(0) { $0 + $1.duration } ?? 0 }

  public func load() async {
    let asked = changes
    do {
      let fresh = try await api.send(API.Favorites.list())
      guard asked == changes, inFlight == 0 else { return }
      show(fresh)
      error = nil
      queries.set(fresh, for: .favorites)
    } catch {
      if tracks == nil { self.error = error.localizedDescription }
    }
  }

  public func toggle(_ track: Track) async {
    await set(track, favorite: !isFavorite(track.recordingId))
  }

  public func set(_ track: Track, favorite: Bool) async {
    let previous = tracks
    changes += 1
    inFlight += 1
    let rest = (tracks ?? []).filter { $0.recordingId != track.recordingId }
    show(favorite ? [FavoriteTrack(track, favoritedAt: Date().formatted(.iso8601))] + rest : rest)
    do {
      if favorite {
        _ = try await api.send(API.Favorites.add(recordingId: track.recordingId))
      } else {
        _ = try await api.send(API.Favorites.remove(recordingId: track.recordingId))
      }
      inFlight -= 1
    } catch {
      inFlight -= 1
      show(previous)
      toasts.push("Couldn't update favorites: \(error.localizedDescription)", tone: .error)
    }
    if inFlight == 0 {
      changes += 1
      await load()
    }
  }

  private func show(_ list: [FavoriteTrack]?) {
    tracks = list
    ids = Set((list ?? []).map(\.recordingId))
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter FavoritesStoreTests
```

Expected: `Test run with 4 tests in 1 suite passed`.

**Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Favorites/FavoritesStore.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Favorites/FavoriteTrack+Song.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/FavoritesStoreTests.swift
git commit -F - <<'MSG'
iOS: favorites with an optimistic heart that goes back when the server says no

A list asked for before a toggle, or while one is in flight, is dropped,
so it can't undo the heart on screen.

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 5: Playlists: the list, New playlist and Add, with covers polled while they're drawn

Ports `usePlaylists` (polling every 4 s while a cover is pending) and the `create` and `add` mutations of `usePlaylistMutations`, with their toasts. `settled` is the web's `settle`: keep the answer for the playlist's page (`playlist/<id>`) and ask for the list again.

**Files:**
- Create: `UI/Pages/Playlists/PlaylistsStore.swift`
- Test: `UITests/PlaylistsStoreTests.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/PlaylistsStoreTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct PlaylistsStoreTests {
  let api = FakeAPI()
  let toasts = ToastCenter(clock: TestClock())

  func store(clock: any Clock<Duration> = ContinuousClock()) -> PlaylistsStore {
    PlaylistsStore(api: api, queries: QueryCache(directory: nil), toasts: toasts, clock: clock)
  }

  @Test func offersOnlyYourOwnToAddTo() async {
    let mine = Listening.summary(Listening.playlist(1, "Mine"))
    let theirs = Listening.summary(Listening.playlist(2, "Theirs", mine: false, shared: true, owner: "Sam"))
    api.on(.get, "/api/playlists", [theirs, mine])
    let store = store()
    await store.load()
    #expect(store.playlists?.map(\.name) == ["Theirs", "Mine"])
    #expect(store.mine.map(\.name) == ["Mine"])
  }

  @Test func createsWithTheSongsAndSaysSo() async {
    let made = Listening.playlist(9, "Night", items: Array(Listening.three.prefix(2)))
    api.on(.post, "/api/playlists", made)
    api.on(.get, "/api/playlists", [Listening.summary(made)])
    let store = store()
    #expect(await store.create(name: "Night", tracks: [Listening.angel, Listening.risingson])?.id == 9)
    #expect(api.bodies(.post, "/api/playlists") == [#"{"name":"Night","recordingIds":["rec-700","rec-701"]}"#])
    #expect(store.playlists?.map(\.id) == [9])
    api.on(.post, "/api/playlists", Listening.playlist(10, "Empty"))
    _ = await store.create(name: "Empty")
    #expect(api.bodies(.post, "/api/playlists").last == #"{"name":"Empty"}"#)
    #expect(toasts.toasts.map(\.message) == ["Created “Night” with 2 songs", "Created “Empty”"])
  }

  @Test func addsSongsAndSaysWhere() async {
    api.on(.post, "/api/playlists/5/items", Listening.playlist(items: [Listening.three[0]]))
    api.on(.get, "/api/playlists", json: "[]")
    let store = store()
    _ = await store.add([Listening.angel], to: 5)
    _ = await store.add([Listening.angel, Listening.risingson], to: 5)
    #expect(api.bodies(.post, "/api/playlists/5/items").first == #"{"recordingIds":["rec-700"]}"#)
    #expect(toasts.toasts.map(\.message) == ["Added “Angel” to “Road trip”", "Added 2 songs to “Road trip”"])
  }

  @Test func pollsEveryFourSecondsWhileACoverIsDrawn() async {
    let clock = TestClock()
    api.on(.get, "/api/playlists", [Listening.summary(Listening.playlist(pending: true))])
    api.then(.get, "/api/playlists", [Listening.summary(Listening.playlist(pending: false))])
    let store = store(clock: clock)
    let polling = Task { await store.poll() }
    #expect(await clock.nextSleep() == .seconds(4))
    clock.advance(by: .seconds(4))
    await polling.value
    #expect(api.calls(.get, "/api/playlists").count == 2)
    #expect(store.playlists?.first?.cover.pending == false)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter PlaylistsStoreTests
```

Expected: the build fails with `cannot find 'PlaylistsStore' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Playlists/PlaylistsStore.swift`:

```swift
import Foundation
import Observation
import PlayarrAPI

/// The account's playlists and those shared with everyone on the server, most recently changed first. Creating and
/// adding go through here, so every screen sees the change (apps/web/src/lib/queries.ts usePlaylistMutations). Kept in
/// the answer cache under `playlists`, each playlist's songs under `playlist/<id>`.
@MainActor @Observable
public final class PlaylistsStore {
  public private(set) var playlists: [PlaylistSummary]?
  public private(set) var error: String?
  /// Bumped when a change leaves a cover still being drawn: the screens start polling again.
  public private(set) var pollRound = 0

  @ObservationIgnored let api: any APISending
  @ObservationIgnored let queries: QueryCache
  @ObservationIgnored private let toasts: ToastCenter
  @ObservationIgnored private let clock: any Clock<Duration>
  /// While the server is still listening to new songs, covers refine: ask every 4 s.
  static let coverPoll = Duration.seconds(4)

  public init(api: any APISending, queries: QueryCache, toasts: ToastCenter, clock: any Clock<Duration> = ContinuousClock()) {
    self.api = api
    self.queries = queries
    self.toasts = toasts
    self.clock = clock
    playlists = queries.cached(.playlists, as: [PlaylistSummary].self)?.value
  }

  /// Only your own: "Add to playlist" lists these (others' shared playlists can't be changed).
  public var mine: [PlaylistSummary] { playlists?.filter(\.mine) ?? [] }

  public func load() async {
    do {
      let fresh = try await api.send(API.Playlists.list())
      playlists = fresh
      error = nil
      queries.set(fresh, for: .playlists)
    } catch {
      if playlists == nil { self.error = error.localizedDescription }
    }
  }

  /// Asks again every 4 s while a cover is still being drawn, while the screen is up.
  public func poll() async {
    await Polling.run(
      clock: clock,
      interval: { [weak self] in self?.playlists?.contains(where: \.cover.pending) == true ? Self.coverPoll : nil },
      refresh: { [weak self] in await self?.load() })
  }

  /// "New playlist", with these songs (none from Playlists or Library). Toasts as the web does.
  public func create(name: String, tracks: [Track] = []) async -> PlaylistDetail? {
    do {
      let playlist = try await api.send(API.Playlists.create(name: name, recordingIds: tracks.isEmpty ? nil : tracks.map(\.recordingId)))
      toasts.push(
        playlist.trackCount > 0
          ? "Created “\(playlist.name)” with \(Format.plural(playlist.trackCount, "song"))" : "Created “\(playlist.name)”")
      await settled(playlist)
      return playlist
    } catch {
      toasts.push(error.localizedDescription, tone: .error)
      return nil
    }
  }

  /// Adds songs at the end of one of your playlists.
  public func add(_ tracks: [Track], to id: Int) async -> PlaylistDetail? {
    guard !tracks.isEmpty else { return nil }
    do {
      let playlist = try await api.send(API.Playlists.addItems(id: id, recordingIds: tracks.map(\.recordingId)))
      toasts.push("Added \(tracks.count == 1 ? "“\(tracks[0].title)”" : "\(tracks.count) songs") to “\(playlist.name)”")
      await settled(playlist)
      return playlist
    } catch {
      toasts.push(error.localizedDescription, tone: .error)
      return nil
    }
  }

  /// The server answered a playlist after a change: keep it for its page, and ask for the list again.
  func settled(_ playlist: PlaylistDetail) async {
    queries.set(playlist, for: .playlist(playlist.id))
    if playlist.cover.pending { pollRound += 1 }
    await load()
  }

  /// A playlist was deleted.
  func removed(_ id: Int) async {
    playlists?.removeAll { $0.id == id }
    await load()
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter PlaylistsStoreTests
```

Expected: `Test run with 4 tests in 1 suite passed`.

**Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Playlists/PlaylistsStore.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/PlaylistsStoreTests.swift
git commit -F - <<'MSG'
iOS: the account's playlists and shared ones, made and added to with the web's toasts, asked again while covers are drawn

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 6: Mixes: asked for in the device's time zone, again when the next is due

Ports `useMixes` and `mixRecheck` (apps/web/src/lib/queries.ts).

**Files:**
- Create: `UI/Pages/Mixes/MixesStore.swift`
- Test: `UITests/MixesStoreTests.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/MixesStoreTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct MixesStoreTests {
  let api = FakeAPI()

  @Test func asksInTheDevicesTimeZone() async {
    api.on(.get, "/api/mixes", [Listening.summary(Listening.mix())])
    let mixes = MixesStore(api: api, queries: QueryCache(directory: nil), timeZone: TimeZone(identifier: "Europe/Rome")!)
    await mixes.load()
    #expect(api.queries(.get, "/api/mixes") == ["tz=Europe/Rome"])
    #expect(mixes.mixes?.map(\.title) == ["Your vibes"])
  }

  @Test func asksAgainWhenTheNextMixIsDue() {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    #expect(MixesStore.recheck(due: [now.addingTimeInterval(3600), now.addingTimeInterval(60)], now: now) == .seconds(65))
    #expect(MixesStore.recheck(due: [now.addingTimeInterval(-30)], now: now) == .seconds(15))
    #expect(MixesStore.recheck(due: [], now: now) == .seconds(60))
  }

  @Test func keepsAskingWhileTheScreenIsUp() async {
    let clock = TestClock()
    api.on(.get, "/api/mixes", [Listening.summary(Listening.mix(refreshesAt: "2000-01-01T00:00:00.000Z"))])
    let mixes = MixesStore(api: api, queries: QueryCache(directory: nil), clock: clock)
    let polling = Task { await mixes.poll() }
    #expect(await clock.nextSleep() == .seconds(15))
    clock.advance(by: .seconds(15))
    _ = await clock.nextSleep()
    polling.cancel()
    await polling.value
    #expect(api.calls(.get, "/api/mixes").count == 2)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter MixesStoreTests
```

Expected: the build fails with `cannot find 'MixesStore' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Mixes/MixesStore.swift`:

```swift
import Foundation
import Observation
import PlayarrAPI

/// Made for you: the account's mixes, asked for in the device's time zone. Each changes on its own schedule (an hour,
/// a day, a week), so while a screen shows them they're asked for again 5 s after the next one is due
/// (apps/web/src/lib/queries.ts useMixes). Kept in the answer cache under `mixes`.
@MainActor @Observable
public final class MixesStore {
  public private(set) var mixes: [MixSummary]?
  public private(set) var error: String?

  @ObservationIgnored private let api: any APISending
  @ObservationIgnored private let queries: QueryCache
  @ObservationIgnored private let clock: any Clock<Duration>
  @ObservationIgnored let timeZone: TimeZone

  public init(api: any APISending, queries: QueryCache, clock: any Clock<Duration> = ContinuousClock(), timeZone: TimeZone = .current) {
    self.api = api
    self.queries = queries
    self.clock = clock
    self.timeZone = timeZone
    mixes = queries.cached(.mixes, as: [MixSummary].self)?.value
  }

  public func load() async {
    do {
      let fresh = try await api.send(API.Mixes.list(timeZone: timeZone))
      mixes = fresh
      error = nil
      queries.set(fresh, for: .mixes)
    } catch {
      if mixes == nil { self.error = error.localizedDescription }
    }
  }

  /// Asks again when the next mix is due, while the screen is up.
  public func poll() async {
    await Polling.run(
      clock: clock,
      interval: { [weak self] in Self.recheck(due: (self?.mixes ?? []).compactMap { Format.parseDate($0.refreshesAt) }) },
      refresh: { [weak self] in await self?.load() })
  }

  /// How long to wait before asking again: 5 s after the first mix is due, 15 s if that's already past (the server
  /// serves the old ones while it makes the new), a minute when there's nothing to wait for.
  static func recheck(due: [Date], now: Date = Date()) -> Duration {
    guard let first = due.min() else { return .seconds(60) }
    let wait = first.timeIntervalSince(now) + 5
    return wait > 0 ? .milliseconds(Int64((wait * 1000).rounded())) : .seconds(15)
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter MixesStoreTests
```

Expected: `Test run with 3 tests in 1 suite passed`.

**Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Mixes/MixesStore.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/MixesStoreTests.swift
git commit -F - <<'MSG'
iOS: the account's mixes, asked for in this device's time zone and again when the next one is due

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 7: Each session has its favorites, playlists and mixes, and opens Add to playlist

The stores are made in `AccountSession.init`, so the live app, the demo and the tests all have them, and a new account gets new ones. `picking` is what the Add to playlist sheet (Task 17) shows.

**Files:**
- Modify: `UI/Session/AccountSession.swift`
- Create: `UI/Pages/Playlists/PlaylistPick.swift`, `UI/Pages/Playlists/AccountSession+Playlists.swift`
- Test: `UITests/AccountSessionListeningTests.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/AccountSessionListeningTests.swift`:

```swift
import Foundation
import PlayarrAPI
import PlayarrPlayer
import Testing
@testable import PlayarrUI

@MainActor @Suite struct AccountSessionListeningTests {
  @Test func eachSessionHasItsOwnFavoritesPlaylistsAndMixes() async {
    let api = FakeAPI.demoLibrary()
    let session = demoSession(api: api)
    await session.refreshListening()
    #expect(session.favorites.isFavorite("rec-701"))
    #expect(session.playlists.playlists?.map(\.name) == ["Late night"])
    #expect(session.mixes.mixes?.map(\.key) == ["vibes"])
    #expect(demoSession(api: FakeAPI()).favorites.tracks == nil)
  }

  @Test func opensAddToPlaylistFromAnyScreen() {
    let session = demoSession()
    session.addToPlaylist([Listening.angel])
    #expect(session.picking?.tracks.map(\.title) == ["Angel"])
  }

  @Test func savesTheQueueFromTheSongPlayingOn() {
    let session = demoSession()
    session.player.play(Demo.mezzanineTracks + Demo.protectionTracks, startAt: 1)
    #expect(AccountSession.queueToSave(session.player.queue).map(\.title) == ["Risingson", "Inertia Creeps", "Protection", "Karmacoma"])
    #expect(AccountSession.queueToSave(QueueState()).isEmpty)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter AccountSessionListeningTests
```

Expected: the build fails with `value of type 'AccountSession' has no member 'refreshListening'` (and `favorites`, `addToPlaylist`, …).

**Step 3: Implement**

In `AccountSession.swift`, the stored properties:

Replace:

```swift
  public let router = AppRouter()
  public let toasts: ToastCenter
```

with:

```swift
  public let router = AppRouter()
  public let toasts: ToastCenter
  /// The account's own: favorites, playlists and mixes (phase 6).
  public let favorites: FavoritesStore
  public let playlists: PlaylistsStore
  public let mixes: MixesStore
  /// "Add to playlist" waiting to be shown (AccountSession.addToPlaylist).
  public var picking: PlaylistPick?
```

and the end of `init`:

Replace:

```swift
    self.images = images
    self.toasts = toasts
  }
```

with:

```swift
    self.images = images
    self.toasts = toasts
    favorites = FavoritesStore(api: api, queries: queries, toasts: toasts)
    playlists = PlaylistsStore(api: api, queries: queries, toasts: toasts)
    mixes = MixesStore(api: api, queries: queries)
  }
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Playlists/PlaylistPick.swift`:

```swift
import Foundation
import PlayarrAPI

/// Songs waiting for "Add to playlist" (none: "New playlist"), shown by the sheet on the signed-in app.
public struct PlaylistPick: Identifiable {
  public let id = UUID()
  public let tracks: [Track]
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Playlists/AccountSession+Playlists.swift`:

```swift
import PlayarrAPI
import PlayarrPlayer

extension AccountSession {
  /// Opens "Add to playlist" for these songs (none: "New playlist"), from any screen.
  public func addToPlaylist(_ tracks: [Track]) { picking = PlaylistPick(tracks: tracks) }

  /// Queue → "Save as playlist": the song playing, then what's up next in play order.
  static func queueToSave(_ queue: QueueState) -> [Track] {
    guard let current = queue.currentTrack else { return [] }
    return [current] + queue.order.dropFirst(queue.pos + 1).map { queue.queue[$0] }
  }
}

extension AccountSession {
  /// Favorites, playlists and mixes asked for again (pull to refresh on Home and Library).
  func refreshListening() async {
    async let favorites: Void = favorites.load()
    async let playlists: Void = playlists.load()
    async let mixes: Void = mixes.load()
    _ = await (favorites, playlists, mixes)
  }
}
```

**Step 4: Run the package to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI
```

Expected: every suite passes, `AccountSessionListeningTests` (3 tests) included.

**Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Session/AccountSession.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Playlists/PlaylistPick.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Playlists/AccountSession+Playlists.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/AccountSessionListeningTests.swift
git commit -F - <<'MSG'
iOS: each account's session holds its favorites, playlists and mixes, and opens Add to playlist from any screen

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 8: The heart on every song and in Now Playing

Phase 4's `FavoriteButton` was shown but disabled. It now toggles the song in `session.favorites`, fills in the accent colour, bounces when hearted (with a light tap), and has the web's labels ("Add “Angel” to favorites" / "Remove “Angel” from favorites", selected while hearted). Song rows get it before their ⋯, at row size (44-point target, body-size heart).

**Files:**
- Modify: `UI/NowPlaying/FavoriteButton.swift` (whole file)
- Modify: `UI/Components/TrackRow.swift`

**Step 1: Replace the button**

Replace `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/NowPlaying/FavoriteButton.swift` with:

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/NowPlaying/FavoriteButton.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// The heart on a song, wherever it shows (song rows, Now Playing): fills at once, and goes back if the server says no
/// (apps/web/src/components/FavoriteButton.tsx).
struct FavoriteButton: View {
  enum Size { case row, large }

  let track: Track
  var size: Size = .large
  @Environment(AccountSession.self) private var session
  @Environment(Theme.self) private var theme
  @State private var popped = 0

  var body: some View {
    let favorite = session.favorites.isFavorite(track.recordingId)
    Button {
      if !favorite { popped += 1 }
      Task { await session.favorites.toggle(track) }
    } label: {
      Image(systemName: favorite ? "heart.fill" : "heart")
        .font(size == .large ? .title2 : .body)
        .foregroundStyle(favorite ? theme.accent.color : .secondary)
        .symbolEffect(.bounce, value: popped)
        // 44 points to tap, whatever it looks like.
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .sensoryFeedback(.impact(weight: .light), trigger: popped)
    .accessibilityLabel(favorite ? "Remove “\(track.title)” from favorites" : "Add “\(track.title)” to favorites")
    .accessibilityAddTraits(favorite ? .isSelected : [])
  }
}
```

**Step 2: Put it on song rows**

In `UI/Components/TrackRow.swift`:

Replace:

```swift
      .accessibilityHint(current ? "Plays or pauses the song" : "Plays the song")
      TrackMenu(track: track, showsAlbum: style == .mixed)
```

with:

```swift
      .accessibilityHint(current ? "Plays or pauses the song" : "Plays the song")
      FavoriteButton(track: track, size: .row)
      TrackMenu(track: track, showsAlbum: style == .mixed)
```

**Step 3: Build for the Mac and the iPhone simulator, and run the package**

```bash
swift build --disable-sandbox --package-path apps/ios/Packages/PlayarrUI
swift build --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --triple arm64-apple-ios26.0-simulator --sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" --scratch-path /tmp/playarr-ui-ios
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI
```

Expected: both builds succeed with no warnings, and every suite passes. Now Playing's call `FavoriteButton(track: track)` is unchanged (`size` defaults to `.large`).

**Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/NowPlaying/FavoriteButton.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/TrackRow.swift
git commit -F - <<'MSG'
iOS: the heart on every song and in Now Playing adds and removes favorites

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 9: Home and Library show the account's favorites, playlists and mixes from its stores

Phase 4's `HomeModel` and `LibraryView` each asked for favorites, playlists and mixes with their own `Query`. They now read the session's stores, so a heart, a new playlist or a new mix shows on Home and in Library at once. Pull to refresh asks the stores again.

**Files:**
- Modify: `UI/Pages/Home/HomeModel.swift`, `UI/Pages/Home/HomeView.swift`, `UI/Pages/Library/LibraryView.swift`

**Step 1: Home**

In `HomeModel.swift`, remove the three queries (properties and their lines in `init`):

Replace:

```swift
  let favorites: Query<[FavoriteTrack]>
  let playlists: Query<[PlaylistSummary]>
  let mixes: Query<[MixSummary]>
```

with:

```swift

```

Replace:

```swift
    favorites = Query(.favorites, cache: cache, staleAfter: 60) { try await api.send(API.Favorites.list()) }
    playlists = Query(.playlists, cache: cache, staleAfter: 60) { try await api.send(API.Playlists.list()) }
    mixes = Query(.mixes, cache: cache, staleAfter: 30) { try await api.send(API.Mixes.list()) }
```

with:

```swift

```

`load()` asks the stores:

Replace:

```swift
    async let d: Void = favorites.load()
    async let e: Void = playlists.load()
    async let f: Void = mixes.load()
```

with:

```swift
    async let d: Void = session.favorites.load()
    async let e: Void = session.playlists.load()
    async let f: Void = session.mixes.load()
```

`refresh()` too:

Replace:

```swift
    for query in [health.refresh, recent.refresh, artists.refresh, favorites.refresh, playlists.refresh, mixes.refresh, heardLately.refresh] {
      await query()
    }
```

with:

```swift
    for query in [health.refresh, recent.refresh, artists.refresh, heardLately.refresh] {
      await query()
    }
    await session.refreshListening()
```

and the two computed properties read them:

Replace:

```swift
  var showsMixes: Bool { mixes.value.map { !$0.isEmpty } ?? mixes.isPending }
```

with:

```swift
  var showsMixes: Bool { session.mixes.mixes.map { !$0.isEmpty } ?? (session.mixes.error == nil) }
```

Replace:

```swift
  var favoriteTracks: [Track] { (favorites.value ?? []).prefix(5).map(\.track) }
```

with:

```swift
  var favoriteTracks: [Track] { (session.favorites.tracks ?? []).prefix(5).map(\.track) }
```

In `HomeView.swift`:

Replace:

```swift
        if let mixes = model.mixes.value {
```

with:

```swift
        if let mixes = session.mixes.mixes {
```

Replace:

```swift
        if let playlists = model.playlists.value, !playlists.isEmpty { playlistShelf(playlists) }
```

with:

```swift
        if let playlists = session.playlists.playlists, !playlists.isEmpty { playlistShelf(playlists) }
```

**Step 2: Library**

In `LibraryView.swift`, the session replaces the two queries:

Replace:

```swift
  @State private var health: Query<HealthStatus>
  @State private var favorites: Query<[FavoriteTrack]>
  @State private var playlists: Query<[PlaylistSummary]>
```

with:

```swift
  @State private var health: Query<HealthStatus>
  let session: AccountSession
```

Replace:

```swift
    _health = State(initialValue: Query(.health, cache: session.queries, staleAfter: 30) { try await api.send(API.Server.health()) })
    _favorites = State(initialValue: Query(.favorites, cache: session.queries, staleAfter: 60) { try await api.send(API.Favorites.list()) })
    _playlists = State(initialValue: Query(.playlists, cache: session.queries, staleAfter: 60) { try await api.send(API.Playlists.list()) })
```

with:

```swift
    self.session = session
    _health = State(initialValue: Query(.health, cache: session.queries, staleAfter: 30) { try await api.send(API.Server.health()) })
```

Replace:

```swift
        row("Favorites", "heart", .favorites, detail: favorites.value.map { Format.plural($0.count, "song") })
```

with:

```swift
        row("Favorites", "heart", .favorites, detail: session.favorites.tracks.map { Format.plural($0.count, "song") })
```

Replace:

```swift
      if let playlists = playlists.value, !playlists.isEmpty {
```

with:

```swift
      if let playlists = session.playlists.playlists, !playlists.isEmpty {
```

Replace:

```swift
      await health.load()
      await favorites.load()
      await playlists.load()
```

with:

```swift
      await health.load()
      await session.favorites.load()
      await session.playlists.load()
```

Replace:

```swift
      await health.refresh()
      await favorites.refresh()
      await playlists.refresh()
```

with:

```swift
      await health.refresh()
      await session.refreshListening()
```

**Step 3: Run the package, and build for the simulator**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI
swift build --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --triple arm64-apple-ios26.0-simulator --sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" --scratch-path /tmp/playarr-ui-ios
```

Expected: every suite passes, phase 4's `HomeModelTests` included (`favoriteTracks` and `showsMixes` now come from the stores the demo session filled), and the build has no warnings.

**Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Home/HomeModel.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Home/HomeView.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Library/LibraryView.swift
git commit -F - <<'MSG'
iOS: Home and Library show the account's favorites, playlists and mixes from the session, so a change shows at once

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 10: The lock screen's like button hearts the song playing

Phase 3's remote commands are fixed when the player is made, and phase 4's `AccountSession.live` makes the player before the session. `Player.live` takes a `like` closure for the song playing; the session passes one that finds itself through a weak reference filled in once it exists. The shell keeps the command's state in step with the heart.

**Files:**
- Modify: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PlayerLive.swift`, `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/NowPlayingBridge.swift`
- Test: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/NowPlayingLikeTests.swift`
- Create: `UI/Session/SessionReference.swift`
- Modify: `UI/Session/AccountSession.swift` (`live`), `UI/Shell/AppShell.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/NowPlayingLikeTests.swift`:

```swift
import Foundation
import MediaPlayer
import PlayarrAPI
import Testing
@testable import PlayarrPlayer

@MainActor @Suite(.serialized) struct NowPlayingLikeTests {
  private func bridge(like: (() -> Void)?) -> NowPlayingBridge {
    NowPlayingBridge(
      commands: NowPlayingBridge.Commands(play: {}, pause: {}, toggle: {}, next: {}, previous: {}, seek: { _ in }, like: like),
      artwork: { _ in nil })
  }

  @Test func showsWhetherTheSongIsAFavorite() {
    let bridge = bridge(like: {})
    let like = MPRemoteCommandCenter.shared().likeCommand
    #expect(like.isEnabled)
    bridge.setLiked(true)
    #expect(like.isActive)
    #expect(like.localizedTitle == "Remove from favorites")
    bridge.setLiked(false)
    #expect(!like.isActive)
    #expect(like.localizedTitle == "Add to favorites")
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter NowPlayingLikeTests
```

Expected: the build fails with `value of type 'NowPlayingBridge' has no member 'setLiked'`.

**Step 3: Implement in the player**

In `NowPlayingBridge.swift`, before `unregister()`:

Replace:

```swift
  /// Lets go of the remote commands (the next player registers its own).
```

with:

```swift
  /// Whether the song playing is a favorite: the like command shows it (filled) and says what a press does.
  public func setLiked(_ liked: Bool) {
    let like = MPRemoteCommandCenter.shared().likeCommand
    like.isActive = liked
    like.localizedTitle = liked ? "Remove from favorites" : "Add to favorites"
  }

  /// Lets go of the remote commands (the next player registers its own).
```

In `PlayerLive.swift`, the import (for `Track`):

Replace:

```swift
import Foundation
```

with:

```swift
import Foundation
import PlayarrAPI
```

the signature:

Replace:

```swift
  /// The player as the app runs it: lock-screen controls and Now Playing, the audio session (iOS), the network for
  /// prefetching, its 10 Hz clock, and a last report when the app is closed.
  public static func live(backend: any PlayerBackend, directory: URL, settings: PlaybackSettings = PlaybackSettings()) throws -> Player {
```

with:

```swift
  /// The player as the app runs it: lock-screen controls and Now Playing, the audio session (iOS), the network for
  /// prefetching, its 10 Hz clock, and a last report when the app is closed. `like` is what the lock screen's like
  /// command does with the song playing (the app toggles it in favorites); nil leaves the command off.
  public static func live(
    backend: any PlayerBackend, directory: URL, settings: PlaybackSettings = PlaybackSettings(),
    like: (@MainActor (Track) -> Void)? = nil
  ) throws -> Player {
```

and the commands:

Replace:

```swift
        seek: { [weak player] in player?.seek(to: $0) }),
```

with:

```swift
        seek: { [weak player] in player?.seek(to: $0) },
        like: like.map { like in
          { [weak player] in
            guard let track = player?.queue.currentTrack else { return }
            like(track)
          }
        }),
```

**Step 4: Run the player's tests**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer
```

Expected: every PlayarrPlayer suite passes, `NowPlayingLikeTests` (1 test) included. (`MPRemoteCommandCenter` exists on the Mac, so the test runs there.)

**Step 5: The session hearts the song; the shell shows it**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Session/SessionReference.swift`:

```swift
/// A weak way back to a session from something made before it (the player's lock-screen like command).
@MainActor
final class SessionReference {
  weak var session: AccountSession?
}
```

In `AccountSession.live`:

Replace:

```swift
    let folder = folder(for: record.key)
    let player = try Player.live(backend: APIBackend(client: client, media: media), directory: folder, settings: model.playback)
```

with:

```swift
    let folder = folder(for: record.key)
    // The lock screen's like button toggles the song playing in this account's favorites (the session is made below).
    let owner = SessionReference()
    let player = try Player.live(backend: APIBackend(client: client, media: media), directory: folder, settings: model.playback) { track in
      guard let session = owner.session else { return }
      Task { await session.favorites.toggle(track) }
    }
```

and its end:

Replace:

```swift
    return AccountSession(
      key: record.key, account: record.account, serverName: server.name, api: client, client: client, player: player,
      queries: queries, images: images, toasts: model.toasts)
```

with:

```swift
    let session = AccountSession(
      key: record.key, account: record.account, serverName: server.name, api: client, client: client, player: player,
      queries: queries, images: images, toasts: model.toasts)
    owner.session = session
    return session
```

In `AppShell.swift`, before the notice handler:

Replace:

```swift
    .onChange(of: session.player.notice) { _, notice in
```

with:

```swift
    // The lock screen's like button shows whether the song playing is a favorite.
    .onChange(of: session.player.queue.currentTrack.map { session.favorites.isFavorite($0.recordingId) } ?? false, initial: true) { _, liked in
      session.player.nowPlaying?.setLiked(liked)
    }
    .onChange(of: session.player.notice) { _, notice in
```

**Step 6: Build and test**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI
swift build --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --triple arm64-apple-ios26.0-simulator --sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" --scratch-path /tmp/playarr-ui-ios
```

Expected: every suite passes; the build has no warnings. (The like command itself is checked on the phone, at the end.)

**Commit**

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PlayerLive.swift apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/NowPlayingBridge.swift apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/NowPlayingLikeTests.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Session/SessionReference.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Session/AccountSession.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/AppShell.swift
git commit -F - <<'MSG'
iOS: the lock screen's like button hearts the song playing and shows whether it's a favorite

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 11: The Favorites page

`apps/web/src/pages/Favorites.tsx`: Play and Shuffle ("Favorites" as where it plays from), "12 songs · 43 min", the songs as phase 4's mixed rows (each with its heart, so unhearting one takes it off the list), "Nothing hearted yet." when empty. Download is phase 7's (a marked place).

**Files:**
- Create: `UI/Pages/Favorites/FavoritesView.swift`
- Modify: `UI/Shell/RouteDestination.swift`

**Step 1: Write the page**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Favorites/FavoritesView.swift`:

```swift
import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// Favorites: Play and Shuffle (Download joins in phase 7), then the songs with their hearts
/// (apps/web/src/pages/Favorites.tsx).
struct FavoritesView: View {
  let session: AccountSession
  @Environment(Theme.self) private var theme

  var body: some View {
    let favorites = session.favorites
    ScrollView {
      if let list = favorites.tracks {
        if list.isEmpty {
          empty
        } else {
          let tracks = list.map(\.track)
          VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 12) {
              Button("Play", systemImage: "play.fill") { session.player.play(tracks, source: FavoritesStore.source) }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .tint(theme.accent.color)
                .foregroundStyle(.black)
              Button("Shuffle", systemImage: "shuffle") { session.player.play(tracks, source: FavoritesStore.source, shuffle: true) }
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
              // Phase 7: Download for Favorites.
              Text("\(Format.plural(tracks.count, "song")) · \(Format.duration(favorites.duration))")
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
            }
            LazyVStack(spacing: 0) {
              ForEach(Array(tracks.enumerated()), id: \.element.id) { index, track in
                TrackRow(track: track, style: .mixed) {
                  session.player.play(tracks, startAt: index, source: FavoritesStore.source)
                }
              }
            }
          }
          .padding(.horizontal, 20)
        }
      } else if let error = favorites.error {
        ErrorState(message: error) { await favorites.load() }
      } else {
        LazyVStack(spacing: 12) { ForEach(0..<6, id: \.self) { _ in Skeleton(aspectRatio: nil, height: 56) } }.padding(.horizontal, 20)
      }
    }
    .navigationTitle("Favorites")
    .task { await favorites.load() }
    .refreshable { await favorites.load() }
  }

  private var empty: some View {
    VStack(alignment: .leading, spacing: 12) {
      Image(systemName: "heart").font(.largeTitle).foregroundStyle(.secondary)
      Text("Nothing hearted yet.").font(.title.weight(.semibold))
      Text("Tap the heart next to any song: in an album, the queue, the player or Now Playing. It shows up here, on every device.")
        .foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(20)
    .padding(.top, 40)
  }
}
```

In `RouteDestination.swift`:

Replace:

```swift
    case .favorites: PlaceholderPage(title: "Favorites")  // phase 6
```

with:

```swift
    case .favorites: FavoritesView(session: session)
```

**Step 2: Build for the Mac and the simulator**

```bash
swift build --disable-sandbox --package-path apps/ios/Packages/PlayarrUI
swift build --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --triple arm64-apple-ios26.0-simulator --sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" --scratch-path /tmp/playarr-ui-ios
```

Expected: both build with no errors or warnings. The page is exercised by Task 23's UI test.

**Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Favorites/FavoritesView.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/RouteDestination.swift
git commit -F - <<'MSG'
iOS: the Favorites page: Play, Shuffle and the hearted songs

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 12: A playlist's page, as a model: ownership, reordering on the drop, and every change

Ports `PlaylistPage`'s logic (apps/web/src/pages/Playlist.tsx, with phase 1 Task 22's ownership) and the `update`, `remove`, `reorder`, `setCover` and `destroy` mutations. The model starts from the cached `playlist/<id>`, so a playlist opened before shows at once.

**Files:**
- Create: `UI/Pages/Playlists/PlaylistModel.swift`, `UI/Pages/Playlists/PlaylistAction.swift`, `UI/Pages/Playlists/PlaylistRowAction.swift`
- Test: `UITests/PlaylistModelTests.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/PlaylistModelTests.swift`:

```swift
import Foundation
import PlayarrAPI
import PlayarrPlayer
import Testing
@testable import PlayarrUI

@MainActor @Suite struct PlaylistModelTests {
  let api = FakeAPI.demoLibrary()
  let three = Listening.three

  func model(_ playlist: PlaylistDetail, clock: any Clock<Duration> = ContinuousClock()) async -> (PlaylistModel, AccountSession) {
    api.on(.get, "/api/playlists/\(playlist.id)", playlist)
    api.on(.get, "/api/playlists", [Listening.summary(playlist)])
    let session = demoSession(api: api)
    let model = PlaylistModel(id: playlist.id, session: session, clock: clock)
    await model.load()
    return (model, session)
  }

  // MARK: Reordering

  @Test func movesTheWayOnMoveReportsADrop() {
    #expect(PlaylistModel.moved([1, 2, 3], fromOffsets: [2], toOffset: 0) == [3, 1, 2])
    #expect(PlaylistModel.moved([1, 2, 3], fromOffsets: [0], toOffset: 3) == [2, 3, 1])
    #expect(PlaylistModel.moved([1, 2, 3, 4], fromOffsets: [0, 2], toOffset: 4) == [2, 4, 1, 3])
    #expect(PlaylistModel.moved([1, 2, 3], fromOffsets: [1], toOffset: 1) == [1, 2, 3])
  }

  @Test func sendsTheNewOrderWhenASongIsDropped() async {
    let (model, _) = await model(Listening.playlist(items: three))
    api.on(.put, "/api/playlists/5/order", Listening.playlist(items: [three[2], three[0], three[1]]))
    await model.move(fromOffsets: [2], toOffset: 0)
    #expect(api.bodies(.put, "/api/playlists/5/order") == [#"{"itemIds":[3,1,2]}"#])
    #expect(model.items.map(\.itemId) == [3, 1, 2])
  }

  @Test func sendsNothingWhenTheOrderDidntChange() async {
    let (model, _) = await model(Listening.playlist(items: three))
    await model.move(fromOffsets: [1], toOffset: 2)
    #expect(api.calls(.put, "/api/playlists/5/order").isEmpty)
    #expect(model.items.map(\.itemId) == [1, 2, 3])
  }

  @Test func putsTheSongsBackWhenTheServerSaysNo() async {
    let (model, session) = await model(Listening.playlist(items: three))
    api.fail(.put, "/api/playlists/5/order", "Order must list every item in the playlist exactly once")
    await model.move(fromOffsets: [0], toOffset: 3)
    #expect(model.items.map(\.itemId) == [1, 2, 3])
    #expect(session.toasts.toasts.map(\.message) == ["Order must list every item in the playlist exactly once"])
  }

  // MARK: Whose it is

  @Test func offersNoWayToChangeSomeoneElsesSharedPlaylist() async {
    let (model, _) = await model(Listening.playlist(items: three, mine: false, shared: true, owner: "Sam"))
    #expect(model.sharing == "Shared by Sam")
    #expect(model.actions == [.playNext, .addToQueue])
    #expect(!model.canPickCover)
    #expect(model.actions(for: three[0]) == [.playNext, .addToQueue, .addToPlaylist, .goToAlbum, .goToArtist])
    await model.move(fromOffsets: [2], toOffset: 0)
    await model.setShared(false)
    #expect(await model.save(name: "Mine now", description: ""))
    #expect(!(await model.delete()))
    #expect(!(await model.setCover(layout: .blocks, variant: 1)))
    #expect(api.calls.filter { $0.method != .get }.isEmpty)
    #expect(model.items.map(\.itemId) == [1, 2, 3])
  }

  @Test func letsTheOwnerShareAndStopSharing() async {
    let (model, _) = await model(Listening.playlist(items: three))
    #expect(model.sharing == nil)
    #expect(model.actions == [.rename, .playNext, .addToQueue, .newCover, .share, .delete])
    api.on(.patch, "/api/playlists/5", Listening.playlist(items: three, shared: true))
    await model.setShared(true)
    #expect(api.bodies(.patch, "/api/playlists/5") == [#"{"shared":true}"#])
    #expect(model.sharing == "Shared with everyone on this server")
    #expect(model.actions.contains(.stopSharing))
    #expect(model.actions(for: three[0]).last == .remove)
  }

  @Test func offersOnlyWhatAnEmptyOrUnavailablePlaylistCanDo() async {
    let (empty, _) = await model(Listening.playlist(items: []))
    #expect(empty.actions == [.rename, .share, .delete])
    let (gone, _) = await model(Listening.playlist(6, items: [Listening.item(1, nil), Listening.item(2, Listening.risingson)]))
    #expect(gone.facts == "2 songs · 5 min · 1 not in library")
    #expect(gone.actions(for: gone.items[0]) == [.remove])
  }

  // MARK: Changes

  @Test func renamesButAnEmptyNameCancels() async {
    let (model, _) = await model(Listening.playlist(items: three))
    #expect(await model.save(name: "  ", description: "x"))
    #expect(api.calls(.patch, "/api/playlists/5").isEmpty)
    api.on(.patch, "/api/playlists/5", Listening.playlist(5, "Night drive", items: three))
    #expect(await model.save(name: "Night drive", description: "Late"))
    #expect(api.bodies(.patch, "/api/playlists/5") == [#"{"description":"Late","name":"Night drive"}"#])
    #expect(model.playlist?.name == "Night drive")
  }

  @Test func removesASongAndDeletesThePlaylist() async {
    let (model, session) = await model(Listening.playlist(items: three))
    api.on(.delete, "/api/playlists/5/items/2", Listening.playlist(items: [three[0], three[2]]))
    await model.remove(three[1])
    #expect(model.items.map(\.itemId) == [1, 3])
    api.on(.delete, "/api/playlists/5", json: "")
    api.on(.get, "/api/playlists", json: "[]")
    #expect(await model.delete())
    #expect(api.calls(.delete, "/api/playlists/5").count == 1)
    #expect(session.playlists.playlists?.isEmpty == true)
  }

  @Test func playsFromATappedSongSkippingTheUnavailable() async {
    let (model, session) = await model(Listening.playlist(items: [Listening.item(1, nil), three[1], three[2]]))
    model.play(from: model.items[2])
    #expect(session.player.queue.queue.map(\.title) == ["Risingson", "Inertia Creeps"])
    #expect(session.player.queue.currentTrack?.title == "Inertia Creeps")
    #expect(session.player.queue.source == PlaySource(label: "Road trip", href: "/playlists/5"))
    model.queue(next: true)
    #expect(session.toasts.toasts.map(\.message) == ["Playing 2 tracks next"])
  }

  @Test func pollsEveryFourSecondsWhileTheCoverIsDrawn() async {
    let clock = TestClock()
    let (model, _) = await model(Listening.playlist(pending: true), clock: clock)
    api.then(.get, "/api/playlists/5", Listening.playlist(pending: false))
    let polling = Task { await model.poll() }
    #expect(await clock.nextSleep() == .seconds(4))
    clock.advance(by: .seconds(4))
    await polling.value
    #expect(model.playlist?.cover.pending == false)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter PlaylistModelTests
```

Expected: the build fails with `cannot find 'PlaylistModel' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Playlists/PlaylistAction.swift`:

```swift
/// An item of the playlist's ⋯ menu ("Playlist actions"), in the web's order and words.
public enum PlaylistAction: Hashable, Sendable {
  case rename, playNext, addToQueue, newCover, share, stopSharing, delete

  public var label: String {
    switch self {
    case .rename: "Rename"
    case .playNext: "Play next"
    case .addToQueue: "Add to queue"
    case .newCover: "New cover…"
    case .share: "Share with everyone"
    case .stopSharing: "Stop sharing"
    case .delete: "Delete playlist"
    }
  }

  public var systemImage: String {
    switch self {
    case .rename: "pencil"
    case .playNext: "text.line.first.and.arrowtriangle.forward"
    case .addToQueue: "text.line.last.and.arrowtriangle.forward"
    case .newCover: "paintpalette"
    case .share: "person.2"
    case .stopSharing: "lock"
    case .delete: "trash"
    }
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Playlists/PlaylistRowAction.swift`:

```swift
/// An item of a song's ⋯ menu on a playlist page, in the web's order and words. Show metadata joins it in
/// phase 8.
public enum PlaylistRowAction: Hashable, Sendable {
  case playNext, addToQueue, addToPlaylist, goToAlbum, goToArtist, remove

  public var label: String {
    switch self {
    case .playNext: "Play next"
    case .addToQueue: "Add to queue"
    case .addToPlaylist: "Add to playlist…"
    case .goToAlbum: "Go to album"
    case .goToArtist: "Go to artist"
    case .remove: "Remove from playlist"
    }
  }

  public var systemImage: String {
    switch self {
    case .playNext: "text.line.first.and.arrowtriangle.forward"
    case .addToQueue: "text.line.last.and.arrowtriangle.forward"
    case .addToPlaylist: "music.note.list"
    case .goToAlbum: "square.stack"
    case .goToArtist: "music.mic"
    case .remove: "xmark"
    }
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Playlists/PlaylistModel.swift`:

```swift
import Foundation
import Observation
import PlayarrAPI
import PlayarrPlayer

/// One playlist's page (apps/web/src/pages/Playlist.tsx). Another account's shared playlist plays like any other but
/// offers no way to change it; only its owner renames, describes, reorders, removes songs, picks a cover, shares or
/// stops sharing, and deletes it. Reordering shows at once and is sent when the song is dropped.
@MainActor @Observable
final class PlaylistModel {
  let id: Int
  private(set) var playlist: PlaylistDetail?
  /// The songs in the order on screen (moved at once by a drag; the server's order otherwise).
  private(set) var items: [PlaylistItem] = []
  private(set) var error: String?
  /// Bumped when a change leaves the cover still being drawn: the page starts polling again.
  private(set) var pollRound = 0
  private(set) var busy = false

  @ObservationIgnored let session: AccountSession
  @ObservationIgnored private let clock: any Clock<Duration>

  init(id: Int, session: AccountSession, clock: any Clock<Duration> = ContinuousClock()) {
    self.id = id
    self.session = session
    self.clock = clock
    if let kept = session.queries.cached(.playlist(id), as: PlaylistDetail.self)?.value { show(kept) }
  }

  // MARK: What the page shows

  /// The viewer owns it: everything that changes it is offered.
  var mine: Bool { playlist?.mine ?? false }
  var playable: [Track] { items.compactMap(\.track) }
  var unavailable: Int { items.count - playable.count }
  var canPickCover: Bool { mine && !items.isEmpty }
  var source: PlaySource? { playlist.map { PlaySource(label: $0.name, href: "/playlists/\($0.id)") } }

  /// "12 songs · 43 min · 2 not in library".
  var facts: String {
    guard let playlist else { return "" }
    var line = "\(Format.plural(items.count, "song")) · \(Format.duration(playlist.duration))"
    if unavailable > 0 { line += " · \(unavailable) not in library" }
    return line
  }

  /// Whose it is, when that's worth saying.
  var sharing: String? {
    guard let playlist, !playlist.mine || playlist.shared else { return nil }
    return playlist.mine ? "Shared with everyone on this server" : "Shared by \(playlist.owner)"
  }

  /// The ⋯ menu ("Playlist actions").
  var actions: [PlaylistAction] {
    guard let playlist else { return [] }
    var actions: [PlaylistAction] = mine ? [.rename] : []
    if !playable.isEmpty { actions += [.playNext, .addToQueue] }
    if mine && !items.isEmpty { actions.append(.newCover) }
    if mine { actions += [playlist.shared ? .stopSharing : .share, .delete] }
    return actions
  }

  /// A song's ⋯ menu.
  func actions(for item: PlaylistItem) -> [PlaylistRowAction] {
    (item.track == nil ? [] : [.playNext, .addToQueue, .addToPlaylist, .goToAlbum, .goToArtist]) + (mine ? [.remove] : [])
  }

  // MARK: Asking the server

  func load() async {
    do {
      let fresh = try await session.api.send(API.Playlists.get(id: id))
      show(fresh)
      error = nil
      session.queries.set(fresh, for: .playlist(id))
    } catch {
      if playlist == nil { self.error = error.localizedDescription }
    }
  }

  /// Asks again every 4 s while the cover is being drawn, while the page is up.
  func poll() async {
    await Polling.run(
      clock: clock,
      interval: { [weak self] in self?.playlist?.cover.pending == true ? PlaylistsStore.coverPoll : nil },
      refresh: { [weak self] in await self?.load() })
  }

  // MARK: Playing

  func play(shuffle: Bool) {
    guard !playable.isEmpty else { return }
    session.player.play(playable, source: source, shuffle: shuffle)
  }

  /// Tapping a song plays the playlist from there.
  func play(from item: PlaylistItem) {
    guard let track = item.track, let index = playable.firstIndex(of: track) else { return }
    session.player.play(playable, startAt: index, source: source)
  }

  func queue(next: Bool) {
    guard !playable.isEmpty else { return }
    next ? session.actions.playNext(playable) : session.actions.addToQueue(playable)
  }

  // MARK: Changing it (its owner only)

  /// Rename and describe. An empty name cancels, as on the web. True when the page can stop editing.
  func save(name: String, description: String) async -> Bool {
    guard mine, !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return true }
    let id = id
    return await change { try await $0.send(API.Playlists.update(id: id, name: name, description: description)) }
  }

  func setShared(_ shared: Bool) async {
    guard mine else { return }
    let id = id
    _ = await change { try await $0.send(API.Playlists.update(id: id, shared: shared)) }
  }

  func setCover(layout: CoverLayout, variant: Int) async -> Bool {
    guard mine else { return false }
    let id = id
    return await change { try await $0.send(API.Playlists.setCover(id: id, layout: layout, variant: variant)) }
  }

  func remove(_ item: PlaylistItem) async {
    guard mine else { return }
    let id = id
    _ = await change { try await $0.send(API.Playlists.removeItem(id: id, itemId: item.itemId)) }
  }

  /// Adds songs ("Songs like these"' Add). True when they were added.
  func add(_ tracks: [Track]) async -> Bool {
    guard mine, let playlist = await session.playlists.add(tracks, to: id) else { return false }
    show(playlist)
    if playlist.cover.pending { pollRound += 1 }
    return true
  }

  /// A drag ended: the songs move at once, and the new order is sent if it differs from the server's. If the server
  /// says no, they go back.
  func move(fromOffsets source: IndexSet, toOffset destination: Int) async {
    guard mine, let playlist else { return }
    items = Self.moved(items, fromOffsets: source, toOffset: destination)
    let order = items.map(\.itemId)
    guard order != playlist.items.map(\.itemId) else { return }
    do {
      let answer = try await session.api.send(API.Playlists.reorder(id: id, itemIds: order))
      show(answer)
      await session.playlists.settled(answer)
    } catch {
      show(playlist)
      session.toasts.push(error.localizedDescription, tone: .error)
    }
  }

  /// Deletes the playlist. True when it's gone (the page goes back).
  func delete() async -> Bool {
    guard mine else { return false }
    do {
      _ = try await session.api.send(API.Playlists.delete(id: id))
      await session.playlists.removed(id)
      return true
    } catch {
      session.toasts.push(error.localizedDescription, tone: .error)
      return false
    }
  }

  /// `items` with the ones at `source` moved before `destination` (an index in the list before the move), as SwiftUI's
  /// `onMove` reports a drop.
  static func moved<T>(_ items: [T], fromOffsets source: IndexSet, toOffset destination: Int) -> [T] {
    let moving = source.map { items[$0] }
    var rest = items.enumerated().filter { !source.contains($0.offset) }.map(\.element)
    rest.insert(contentsOf: moving, at: destination - source.count(in: 0..<destination))
    return rest
  }

  private func change(_ send: (any APISending) async throws -> PlaylistDetail) async -> Bool {
    busy = true
    defer { busy = false }
    do {
      let answer = try await send(session.api)
      show(answer)
      if answer.cover.pending { pollRound += 1 }
      await session.playlists.settled(answer)
      return true
    } catch {
      session.toasts.push(error.localizedDescription, tone: .error)
      return false
    }
  }

  private func show(_ detail: PlaylistDetail) {
    playlist = detail
    items = detail.items
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter PlaylistModelTests
```

Expected: `Test run with 11 tests in 1 suite passed`.

**Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Playlists/PlaylistModel.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Playlists/PlaylistAction.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Playlists/PlaylistRowAction.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/PlaylistModelTests.swift
git commit -F - <<'MSG'
iOS: a playlist's page model: only its owner changes it, and a reorder is sent on the drop when the order changed

The songs move at once and go back with the server's message if it says
no. Another account's shared playlist plays and queues, and nothing it
does is sent.

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 13: The cover picker and the note about the cover

`components/CoverPicker.tsx` (six styles in its order, starting at the cover's variation + 1, Shuffle moves on) and `CoverNote` in pages/Playlist.tsx (what each layout draws, and the facts).

**Files:**
- Create: `UI/Pages/Playlists/CoverPickerModel.swift`, `UI/Pages/Playlists/CoverNote.swift`
- Test: `UITests/CoverPickerTests.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/CoverPickerTests.swift`:

```swift
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct CoverPickerTests {
  @Test func startsPastTheCoversOwnVariationAndShufflesOn() {
    var playlist = Listening.playlist(items: [Listening.three[0]])
    playlist.cover = Listening.cover(layout: .horizon, variant: 2)
    let picker = CoverPickerModel(playlist: playlist)
    #expect(CoverPickerModel.styles.map(\.label) == ["Currents", "Colonies", "Horizon", "Ridges", "Grooves", "Blocks"])
    #expect(picker.chosen == .horizon)
    #expect(picker.intro == "Drawn from the 1 songs in this playlist as they are now.")
    #expect(picker.preview(.currents) == "/art/playlist/5/preview?layout=currents&variant=3")
    picker.shuffle()
    #expect(picker.preview(.blocks) == "/art/playlist/5/preview?layout=blocks&variant=4")
  }

  @Test func describesWhatTheCoverIsMadeOf() {
    var cover = Listening.cover(layout: .ridges)
    cover.tempo = 120
    cover.styles = ["Electronic", "House"]
    cover.era = [1990, 1999]
    cover.energy = 0.724
    let note = CoverNote(cover)
    #expect(note.listening == nil)
    #expect(note.story == "Each line is a song, traced from its loudness over time.")
    #expect(note.facts == "120 BPM · Electronic / House · 1990–1999 · energy 72%")
    cover.era = [2001, 2001]
    cover.tempo = nil
    cover.styles = []
    #expect(CoverNote(cover).facts == "2001 · energy 72%")
  }

  @Test func saysItsStillListeningUntilTheCoverIsPinned() {
    #expect(CoverNote(Listening.cover(pending: true)).listening == "Listening to the songs to draw the cover… 1 of 3")
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter CoverPickerTests
```

Expected: the build fails with `cannot find 'CoverPickerModel' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Playlists/CoverPickerModel.swift`:

```swift
import Observation
import PlayarrAPI

/// "New cover": one candidate per style, drawn by the server from the playlist's songs as they are now;
/// Shuffle asks for other variations (components/CoverPicker.tsx).
@MainActor @Observable
final class CoverPickerModel {
  /// The six layouts, in the picker's order, with their names.
  static let styles: [(layout: CoverLayout, label: String)] = [
    (.currents, "Currents"), (.colonies, "Colonies"), (.horizon, "Horizon"), (.ridges, "Ridges"), (.grooves, "Grooves"), (.blocks, "Blocks"),
  ]

  let playlistId: Int
  let intro: String
  /// Starts past the cover's own variation, so every candidate is new.
  private(set) var variant: Int
  var chosen: CoverLayout

  init(playlist: PlaylistDetail) {
    playlistId = playlist.id
    intro = "Drawn from the \(playlist.trackCount) songs in this playlist as they are now."
    variant = playlist.cover.variant + 1
    chosen = playlist.cover.layout
  }

  func shuffle() { variant += 1 }

  /// The server path of a candidate (the image loader adds `size`), as MediaURLs.playlistCoverPreview builds it.
  func preview(_ layout: CoverLayout) -> String {
    "/art/playlist/\(playlistId)/preview?layout=\(layout.rawValue)&variant=\(variant)"
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Playlists/CoverNote.swift`:

```swift
import PlayarrAPI

/// What the generated cover is made of, so it reads as a portrait of the music rather than decoration
/// (pages/Playlist.tsx CoverNote).
struct CoverNote: Equatable {
  /// "Listening to the songs to draw the cover… 3 of 12" while it's still being drawn.
  var listening: String?
  /// How the layout draws the songs.
  var story: String
  /// "120 BPM · Electronic / House · 1990–1999 · energy 72%".
  var facts: String
  /// The playlist changed a lot since the cover was drawn.
  var stale: Bool

  init(_ cover: PlaylistCoverInfo) {
    listening = cover.pending && !cover.frozen ? "Listening to the songs to draw the cover… \(cover.analyzed) of \(cover.total)" : nil
    story = Self.story(cover.layout)
    var facts: [String] = []
    if let tempo = cover.tempo, tempo > 0 { facts.append("\(tempo.formatted(.number.precision(.fractionLength(0...1)).grouping(.never))) BPM") }
    if !cover.styles.isEmpty { facts.append(cover.styles.joined(separator: " / ")) }
    if let era = cover.era, let from = era.first, let to = era.last { facts.append(from == to ? String(from) : "\(from)–\(to)") }
    facts.append("energy \(Int((cover.energy * 100).rounded()))%")
    self.facts = facts.joined(separator: " · ")
    stale = cover.stale
  }

  static func story(_ layout: CoverLayout) -> String {
    switch layout {
    case .ridges: "Each line is a song, traced from its loudness over time."
    case .grooves: "A record of the playlist: each band of grooves is a song, as wide as it is long."
    case .blocks: "A tile per song, sized by its length; each shape follows how it sounds."
    case .horizon: "Each hill is a song’s loudness over time. The slower the music, the bigger the sun."
    case .currents: "Each ribbon belongs to a song: a steady beat flows smoothly, free time swirls; louder songs run wider."
    case .colonies: "Each style is a slime-mould species in its own colour, growing with its songs’ tempo and beat."
    case .unknown: "Drawn from what the songs sound like."
    }
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter CoverPickerTests
```

Expected: `Test run with 3 tests in 1 suite passed`.

**Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Playlists/CoverPickerModel.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Playlists/CoverNote.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/CoverPickerTests.swift
git commit -F - <<'MSG'
iOS: the cover picker's six styles and Shuffle, and what a playlist's cover is drawn from

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 14: "Songs like these"

`components/PlaylistRecommendations.tsx`: hidden without seeds, the last set kept while the next comes, Add takes a song off the list, eight songs you don't have until "Show all 14".

**Files:**
- Create: `UI/Pages/Playlists/RecommendationsModel.swift`
- Test: `UITests/RecommendationsModelTests.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/RecommendationsModelTests.swift`:

```swift
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct RecommendationsModelTests {
  let api = FakeAPI.demoLibrary()

  func recommendation(_ track: Track?, _ title: String) -> RecommendedTrack {
    RecommendedTrack(
      recordingId: track?.recordingId ?? "rec-\(title)", title: title, artistName: "Portishead", albumTitle: "Dummy", because: "Angel",
      track: track, album: track == nil ? AlbumRef(artistName: "Portishead", albumTitle: "Third") : nil)
  }

  func model() async -> RecommendationsModel {
    let playlist = Listening.playlist(items: [Listening.three[0]])
    api.on(.get, "/api/playlists/5", playlist)
    api.on(.get, "/api/playlists", [Listening.summary(playlist)])
    let model = PlaylistModel(id: 5, session: demoSession(api: api))
    await model.load()
    return RecommendationsModel(playlist: model)
  }

  @Test func addsASongYouHaveAndTakesItOffTheList() async {
    let mysterons = Demo.dummyTracks[0]
    api.on(.get, "/api/playlists/5/recommendations", Recommendations(owned: [recommendation(mysterons, "Mysterons")], missing: [], seedCount: 1))
    api.on(.post, "/api/playlists/5/items", Listening.playlist(items: [Listening.three[0], Listening.item(4, mysterons)]))
    let recs = await model()
    await recs.load()
    await recs.add(recs.owned[0])
    #expect(api.bodies(.post, "/api/playlists/5/items") == [#"{"recordingIds":["rec-800"]}"#])
    #expect(recs.owned.isEmpty)
    #expect(recs.empty)
  }

  @Test func showsEightMissingSongsUntilAskedForAll() async {
    let missing = (1...14).map { recommendation(nil, "Missing \($0)") }
    api.on(.get, "/api/playlists/5/recommendations", Recommendations(owned: [], missing: missing, seedCount: 3))
    let recs = await model()
    await recs.load()
    #expect(recs.shownMissing.count == 8)
    #expect(recs.moreLabel == "Show all 14")
    recs.showAll = true
    #expect(recs.shownMissing.count == 14)
    #expect(recs.moreLabel == "Show fewer")
  }

  @Test func asksForAnotherSetAndHidesWithoutSeeds() async {
    api.on(.get, "/api/playlists/5/recommendations", Recommendations(owned: [], missing: [], seedCount: 0))
    let recs = await model()
    await recs.newMix()
    #expect(api.queries(.get, "/api/playlists/5/recommendations") == ["variant=1"])
    #expect(recs.hidden)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter RecommendationsModelTests
```

Expected: the build fails with `cannot find 'RecommendationsModel' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Playlists/RecommendationsModel.swift`:

```swift
import Foundation
import Observation
import PlayarrAPI

/// "Songs like these" under your own playlist: ListenBrainz neighbours, split into songs you have (Add) and songs you
/// don't (requested in phase 8). New mix asks for another set (apps/web/src/components/PlaylistRecommendations.tsx).
@MainActor @Observable
final class RecommendationsModel {
  static let missingPreview = 8

  private(set) var recommendations: Recommendations?
  private(set) var error: String?
  private(set) var loading = false
  private(set) var variant = 0
  var showAll = false
  /// Songs added from here: they leave the list.
  private(set) var added: Set<String> = []

  @ObservationIgnored private let playlist: PlaylistModel

  init(playlist: PlaylistModel) {
    self.playlist = playlist
  }

  /// Nothing to show: no songs to start from.
  var hidden: Bool { recommendations?.seedCount == 0 }
  var owned: [RecommendedTrack] { (recommendations?.owned ?? []).filter { !added.contains($0.recordingId) } }
  var missing: [RecommendedTrack] { recommendations?.missing ?? [] }
  var shownMissing: [RecommendedTrack] { showAll ? missing : Array(missing.prefix(Self.missingPreview)) }
  /// "Show all 14" / "Show fewer", when there are more than the preview.
  var moreLabel: String? { missing.count > Self.missingPreview ? (showAll ? "Show fewer" : "Show all \(missing.count)") : nil }
  /// ListenBrainz knows nothing to suggest.
  var empty: Bool { recommendations != nil && owned.isEmpty && missing.isEmpty }

  /// Keeps the last set on screen while the next one comes.
  func load() async {
    loading = true
    defer { loading = false }
    do {
      recommendations = try await playlist.session.api.send(API.Playlists.recommendations(id: playlist.id, variant: variant))
      error = nil
    } catch {
      self.error = error.localizedDescription
    }
  }

  func newMix() async {
    variant += 1
    showAll = false
    await load()
  }

  func add(_ recommendation: RecommendedTrack) async {
    guard let track = recommendation.track else { return }
    if await playlist.add([track]) { added.insert(recommendation.recordingId) }
  }

  func play(_ recommendation: RecommendedTrack) {
    guard let track = recommendation.track else { return }
    playlist.session.player.play([track])
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter RecommendationsModelTests
```

Expected: `Test run with 3 tests in 1 suite passed`.

**Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Playlists/RecommendationsModel.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/RecommendationsModelTests.swift
git commit -F - <<'MSG'
"Songs like these" under your own playlist: add the ones you have, see the ones you don't

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 15: Add to playlist, as a model

`components/AddToPlaylistDialog.tsx`: "New playlist" with no songs, "Add “Angel”" or "Add 2 songs" otherwise; your own playlists only; Create only with a name.

**Files:**
- Create: `UI/Pages/Playlists/AddToPlaylistModel.swift`
- Test: `UITests/AddToPlaylistModelTests.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/AddToPlaylistModelTests.swift`:

```swift
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct AddToPlaylistModelTests {
  let api = FakeAPI()

  func store() async -> PlaylistsStore {
    api.on(.get, "/api/playlists", [
      Listening.summary(Listening.playlist(1, "Mine")), Listening.summary(Listening.playlist(2, "Theirs", mine: false, shared: true)),
    ])
    let store = PlaylistsStore(api: api, queries: QueryCache(directory: nil), toasts: ToastCenter(clock: TestClock()))
    await store.load()
    return store
  }

  @Test func namesWhatItAdds() async {
    let store = await store()
    #expect(AddToPlaylistModel(tracks: [], store: store).title == "New playlist")
    #expect(AddToPlaylistModel(tracks: [Listening.angel], store: store).title == "Add “Angel”")
    #expect(AddToPlaylistModel(tracks: [Listening.angel, Listening.risingson], store: store).title == "Add 2 songs")
  }

  @Test func offersYourOwnPlaylistsOnlyWhenThereAreSongs() async {
    let store = await store()
    let adding = AddToPlaylistModel(tracks: [Listening.angel], store: store)
    #expect(!adding.creating)
    #expect(adding.choices.map(\.name) == ["Mine"])
    let making = AddToPlaylistModel(tracks: [], store: store)
    #expect(making.creating)
    #expect(making.choices.isEmpty)
  }

  @Test func createsOnlyWithAName() async {
    let store = await store()
    let making = AddToPlaylistModel(tracks: [Listening.angel], store: store)
    making.name = "   "
    #expect(!making.canCreate)
    #expect(await making.create() == nil)
    #expect(api.calls(.post, "/api/playlists").isEmpty)
    api.on(.post, "/api/playlists", Listening.playlist(7, "Night", items: [Listening.three[0]]))
    making.name = "Night"
    #expect(await making.create()?.id == 7)
    #expect(api.bodies(.post, "/api/playlists") == [#"{"name":"Night","recordingIds":["rec-700"]}"#])
  }

  @Test func addsToAnExistingPlaylist() async {
    let store = await store()
    api.on(.post, "/api/playlists/1/items", Listening.playlist(1, "Mine", items: [Listening.three[0]]))
    let adding = AddToPlaylistModel(tracks: [Listening.angel], store: store)
    #expect(await adding.add(to: adding.choices[0]))
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter AddToPlaylistModelTests
```

Expected: the build fails with `cannot find 'AddToPlaylistModel' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Playlists/AddToPlaylistModel.swift`:

```swift
import Foundation
import Observation
import PlayarrAPI

/// "Add to playlist": make a new playlist with the songs, or add them to one of your own
/// (components/AddToPlaylistDialog.tsx). With no songs it's "New playlist".
@MainActor @Observable
final class AddToPlaylistModel {
  let tracks: [Track]
  var creating: Bool
  var name = ""
  private(set) var busy = false

  @ObservationIgnored private let store: PlaylistsStore

  init(tracks: [Track], store: PlaylistsStore) {
    self.tracks = tracks
    self.store = store
    creating = tracks.isEmpty
  }

  var title: String {
    switch tracks.count {
    case 0: "New playlist"
    case 1: "Add “\(tracks[0].title)”"
    default: "Add \(tracks.count) songs"
    }
  }

  /// Your own playlists (others' shared ones can't be changed); none when making a new one from nothing.
  var choices: [PlaylistSummary] { tracks.isEmpty ? [] : store.mine }
  var canCreate: Bool { !busy && !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

  /// The new playlist, or nil (the server's message is a toast).
  func create() async -> PlaylistDetail? {
    guard canCreate else { return nil }
    busy = true
    defer { busy = false }
    return await store.create(name: name, tracks: tracks)
  }

  /// True when the songs were added.
  func add(to playlist: PlaylistSummary) async -> Bool {
    guard !busy else { return false }
    busy = true
    defer { busy = false }
    return await store.add(tracks, to: playlist.id) != nil
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter AddToPlaylistModelTests
```

Expected: `Test run with 4 tests in 1 suite passed`.

**Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Playlists/AddToPlaylistModel.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/AddToPlaylistModelTests.swift
git commit -F - <<'MSG'
iOS: Add to playlist: a new playlist with the songs, or one of your own

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 16: The playlist screens

The Playlists grid ("New playlist" first), the playlist page (pages/Playlist.tsx: cover tap → New cover, tap the name or description to edit them, the facts and whose it is, the cover note, Play, Shuffle, ⋯, the songs with their hearts and menus, greyed out when not in your library, hold-and-drag or Edit to reorder, "Songs like these" under your own, Delete with the web's confirmation), the cover picker sheet, and the recommendations section. A playlist card says whose it is when it isn't yours ("12 songs · Sam").

Notes from building it: buttons in one `List` row need a bordered or plain style each (or a tap on the row fires them all); a plain-styled button in a list row takes taps only on its words unless it has a `contentShape`; `FlowLayout` squeezes bordered buttons in a list row, so the action rows are `HStack`s.

**Files:**
- Create in `UI/Pages/Playlists/`: `PlaylistsView.swift`, `PlaylistView.swift`, `PlaylistItemRow.swift`, `CoverPickerView.swift`, `RecommendationsSection.swift`
- Modify: `UI/Components/PlaylistCard.swift`, `UI/Shell/RouteDestination.swift`

**Step 1: Write the views**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Playlists/PlaylistsView.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// Playlists: "New playlist", then every playlist you can see, with whose it is when it isn't yours
/// (apps/web/src/pages/Playlists.tsx).
struct PlaylistsView: View {
  let session: AccountSession

  var body: some View {
    let store = session.playlists
    ScrollView {
      if let error = store.error {
        ErrorState(message: error) { await store.load() }
      } else {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: ShelfCard.width), spacing: 16, alignment: .top)], alignment: .leading, spacing: 24) {
          Button { session.addToPlaylist([]) } label: {
            VStack(spacing: 12) {
              Image(systemName: "plus").font(.title2).frame(width: 48, height: 48).background(Circle().fill(.tint)).foregroundStyle(.black)
              Text("New playlist")
            }
            .frame(width: ShelfCard.width, height: ShelfCard.width)
            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Color.secondary.opacity(0.4), style: StrokeStyle(lineWidth: 1, dash: [4])))
          }
          .buttonStyle(.plain)
          .accessibilityIdentifier("playlists.new")
          if let playlists = store.playlists {
            ForEach(playlists) { PlaylistCard(playlist: $0) }
          } else {
            ForEach(0..<5, id: \.self) { _ in Skeleton().frame(width: ShelfCard.width) }
          }
        }
        .padding(20)
      }
    }
    .navigationTitle("Playlists")
    .task(id: store.pollRound) { await store.poll() }
    .refreshable { await store.load() }
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Playlists/PlaylistItemRow.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// A song on a playlist page: greyed out when the viewer's library doesn't have it, the heart, its length and its ⋯
/// menu (apps/web/src/pages/Playlist.tsx PlaylistRow).
struct PlaylistItemRow: View {
  let item: PlaylistItem
  let actions: [PlaylistRowAction]
  let onTap: () -> Void
  let perform: (PlaylistRowAction) -> Void

  @Environment(AccountSession.self) private var session
  @Environment(Theme.self) private var theme

  var body: some View {
    let current = item.track.map { session.player.queue.currentTrack?.fileId == $0.fileId } ?? false
    HStack(spacing: 12) {
      Button(action: onTap) {
        HStack(spacing: 12) {
          Cover(path: item.track?.coverUrl, points: 44, label: item.albumTitle).frame(width: 44, height: 44)
          VStack(alignment: .leading, spacing: 2) {
            Text(item.title).lineLimit(1).foregroundStyle(current ? theme.accent.color : .primary)
            HStack(spacing: 6) {
              Text("\(item.artistName) · \(item.albumTitle)").lineLimit(1)
              if item.track == nil { Text("NOT IN LIBRARY").font(.caption2.monospaced()) }
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
          }
          Spacer(minLength: 8)
          if let track = item.track {
            Text(Format.time(track.duration)).font(.footnote.monospacedDigit()).foregroundStyle(.secondary)
          }
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(item.track == nil)
      .accessibilityLabel(label)
      if let track = item.track { FavoriteButton(track: track, size: .row) }
      if !actions.isEmpty {
        Menu {
          ForEach(actions, id: \.self) { action in
            Button(action.label, systemImage: action.systemImage, role: action == .remove ? .destructive : nil) { perform(action) }
          }
        } label: {
          Image(systemName: "ellipsis").frame(width: 44, height: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .accessibilityLabel("More for \(item.title)")
      }
    }
    .opacity(item.track == nil ? 0.5 : 1)
    .padding(.vertical, 2)
  }

  private var label: String {
    guard let track = item.track else { return "\(item.title), \(item.artistName), not in your library" }
    return "\(item.title), \(item.artistName), \(item.albumTitle), \(Format.time(track.duration))"
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Playlists/CoverPickerView.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// "New cover": one candidate per style from the server, Shuffle for others, "Use this" to keep the chosen one
/// (apps/web/src/components/CoverPicker.tsx).
struct CoverPickerView: View {
  let playlist: PlaylistModel
  @State private var picker: CoverPickerModel
  @Environment(\.dismiss) private var dismiss
  @Environment(Theme.self) private var theme

  init(playlist: PlaylistModel, detail: PlaylistDetail) {
    self.playlist = playlist
    _picker = State(initialValue: CoverPickerModel(playlist: detail))
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        Text(picker.intro).font(.subheadline).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 16) {
          ForEach(CoverPickerModel.styles, id: \.layout) { style in
            let chosen = picker.chosen == style.layout
            Button { picker.chosen = style.layout } label: {
              VStack(alignment: .leading, spacing: 6) {
                // Some styles take a few seconds to draw: the cover's stand-in shows until they arrive.
                Cover(path: picker.preview(style.layout), points: 170, label: style.label, corner: 6)
                  .id("\(style.layout.rawValue)-\(picker.variant)")
                  .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(chosen ? theme.accent.color : .clear, lineWidth: 3))
                Kicker(text: style.label)
              }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(style.label) cover")
            .accessibilityAddTraits(chosen ? [.isButton, .isSelected] : .isButton)
          }
        }
        .padding(.top, 8)
      }
      .padding(20)
      .navigationTitle("New cover")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .secondaryAction) { Button("Shuffle", systemImage: "dice") { picker.shuffle() } }
        ToolbarItem(placement: .confirmationAction) {
          Button("Use this") {
            Task { if await playlist.setCover(layout: picker.chosen, variant: picker.variant) { dismiss() } }
          }
          .disabled(playlist.busy)
        }
      }
    }
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Playlists/RecommendationsSection.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// "Songs like these" under your own playlist: Add the songs you have; the ones you don't get a request button in
/// phase 8 (apps/web/src/components/PlaylistRecommendations.tsx).
struct RecommendationsSection: View {
  @State private var model: RecommendationsModel

  init(playlist: PlaylistModel) {
    _model = State(initialValue: RecommendationsModel(playlist: playlist))
  }

  var body: some View {
    Group {
      if !model.hidden {
        Section {
          if model.recommendations == nil, model.loading {
            ProgressView().frame(maxWidth: .infinity)
          } else if let error = model.error, model.recommendations == nil {
            VStack(alignment: .leading, spacing: 8) {
              Text("Couldn’t reach ListenBrainz. \(error)").foregroundStyle(.secondary)
              Button("Try again") { Task { await model.load() } }
            }
          } else if model.empty {
            Text("ListenBrainz doesn’t know these songs well enough to suggest anything yet. Try a new mix or add a few more songs.")
              .foregroundStyle(.secondary)
          }
          if !model.owned.isEmpty {
            Kicker(text: "Already in your library")
            ForEach(model.owned, id: \.recordingId) { recommendation in
              row(recommendation) {
                Button("Add", systemImage: "plus") { Task { await model.add(recommendation) } }
                  .buttonStyle(.bordered)
                  .controlSize(.small)
                  .accessibilityLabel("Add \(recommendation.title) to playlist")
              }
            }
          }
          if !model.missing.isEmpty {
            Kicker(text: "Not in your library yet")
            ForEach(model.shownMissing, id: \.recordingId) { recommendation in
              row(recommendation) {
                // Phase 8: RequestButton(album: recommendation.album, availability: recommendation.availability).
                EmptyView()
              }
            }
            if let more = model.moreLabel {
              Button(more) { model.showAll.toggle() }.font(.caption.monospaced())
            }
          }
        } header: {
          HStack(alignment: .lastTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
              Kicker(text: "From ListenBrainz")
              Text("Songs like these").font(.title2.weight(.semibold)).foregroundStyle(.primary).textCase(nil)
            }
            Spacer()
            Button("New mix", systemImage: "dice") { Task { await model.newMix() } }
              .disabled(model.loading)
              .textCase(nil)
          }
        }
        .opacity(model.loading && model.recommendations != nil ? 0.6 : 1)
      }
    }
    .task { await model.load() }
  }

  private func row(_ recommendation: RecommendedTrack, @ViewBuilder action: () -> some View) -> some View {
    HStack(spacing: 12) {
      Button { model.play(recommendation) } label: {
        HStack(spacing: 12) {
          Cover(path: recommendation.coverUrl, points: 44, label: recommendation.albumTitle).frame(width: 44, height: 44)
          VStack(alignment: .leading, spacing: 2) {
            Text(recommendation.title).lineLimit(1)
            Text("\(recommendation.artistName) · \(recommendation.albumTitle)").font(.footnote).foregroundStyle(.secondary).lineLimit(1)
            if !recommendation.because.isEmpty {
              Text("like \(recommendation.because)").font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
          }
          Spacer(minLength: 8)
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(recommendation.track == nil)
      action()
    }
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Playlists/PlaylistView.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// A playlist's page (apps/web/src/pages/Playlist.tsx): the cover (tap for a new one), name and description (tap to
/// edit), whose it is, Play, Shuffle, the ⋯ menu, the songs (hold and drag, or Edit, to reorder; sent on the drop) and
/// "Songs like these". Someone else's shared playlist shows the same page without the ways to change it.
struct PlaylistView: View {
  @State private var model: PlaylistModel
  @Environment(Theme.self) private var theme
  @Environment(\.dismiss) private var dismiss
  @State private var editing = false
  @State private var name = ""
  @State private var details = ""
  @State private var pickingCover = false
  @State private var confirmingDelete = false

  init(id: Int, session: AccountSession) {
    _model = State(initialValue: PlaylistModel(id: id, session: session))
  }

  var body: some View {
    Group {
      if let playlist = model.playlist {
        page(playlist)
      } else if let error = model.error {
        ErrorState(message: error) { await model.load() }
      } else {
        ProgressView()
      }
    }
    .task(id: model.pollRound) { await model.poll() }
  }

  private func page(_ playlist: PlaylistDetail) -> some View {
    List {
      Section { header(playlist) }
        .listRowSeparator(.hidden)
      Section {
        if model.items.isEmpty {
          Text("This playlist is empty. Use Add to playlist… from any song’s ⋯ menu, an album, the queue or Now Playing.")
            .foregroundStyle(.secondary)
        }
        ForEach(model.items, id: \.itemId) { item in
          PlaylistItemRow(item: item, actions: model.actions(for: item), onTap: { model.play(from: item) }) { perform($0, on: item) }
        }
        .onMove(perform: model.mine ? { source, destination in Task { await model.move(fromOffsets: source, toOffset: destination) } } : nil)
      }
      if model.mine, !model.items.isEmpty {
        RecommendationsSection(playlist: model)
      }
    }
    .listStyle(.plain)
    .navigationTitle(playlist.name)
    #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { if model.mine, model.items.count > 1 { EditButton() } }
    #endif
    .refreshable { await model.load() }
    .sheet(isPresented: $pickingCover) { CoverPickerView(playlist: model, detail: playlist) }
    .confirmationDialog("Delete playlist?", isPresented: $confirmingDelete, titleVisibility: .visible) {
      Button("Delete", role: .destructive) {
        Task { if await model.delete() { dismiss() } }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("“\(playlist.name)” will be deleted. The songs stay in your library. This can’t be undone.")
    }
  }

  @ViewBuilder private func header(_ playlist: PlaylistDetail) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Button { pickingCover = true } label: {
        PlaylistCover(cover: playlist.cover, points: 256, name: playlist.name)
          .frame(maxWidth: 256)
          .shadow(color: .black.opacity(0.8), radius: 30, y: 20)
      }
      .buttonStyle(.plain)
      .disabled(!model.canPickCover)
      .accessibilityLabel("New cover")
      .frame(maxWidth: .infinity)

      Kicker(text: "Playlist")
      if editing {
        TextField("Playlist name", text: $name).font(.largeTitle.weight(.semibold)).accessibilityIdentifier("playlist.editName")
        TextField("Add a description", text: $details, axis: .vertical).lineLimit(2...4)
        HStack {
          Button("Save") { Task { if await model.save(name: name, description: details) { editing = false } } }
            .buttonStyle(.borderedProminent)
          Button("Cancel") { editing = false }.buttonStyle(.bordered)
        }
      } else {
        Text(playlist.name).font(.largeTitle.weight(.semibold)).onTapGesture(perform: startEditing)
        if !playlist.description.isEmpty {
          Text(playlist.description).foregroundStyle(.secondary).onTapGesture(perform: startEditing)
        }
      }
      Text(model.facts).font(.caption.monospaced()).foregroundStyle(.secondary)
      if let sharing = model.sharing {
        Text(sharing).font(.caption.monospaced()).foregroundStyle(.secondary)
      }
      if model.canPickCover { coverNote(CoverNote(playlist.cover)) }

      HStack(spacing: 12) {
        Button("Play", systemImage: "play.fill") { model.play(shuffle: false) }
          .buttonStyle(.borderedProminent)
          .buttonBorderShape(.capsule)
          .tint(theme.accent.color)
          .foregroundStyle(.black)
          .disabled(model.playable.isEmpty)
          .accessibilityLabel("Play \(playlist.name)")
        Button("Shuffle", systemImage: "shuffle") { model.play(shuffle: true) }
          .buttonStyle(.bordered)
          .buttonBorderShape(.capsule)
          .disabled(model.playable.isEmpty)
          .accessibilityLabel("Shuffle \(playlist.name)")
        // Phase 7: Download for this playlist.
        Menu {
          ForEach(model.actions, id: \.self) { action in
            Button(action.label, systemImage: action.systemImage, role: action == .delete ? .destructive : nil) { perform(action) }
          }
        } label: {
          Image(systemName: "ellipsis").frame(width: 44, height: 44)
        }
        .accessibilityLabel("Playlist actions")
      }
    }
  }

  private func coverNote(_ note: CoverNote) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      if let listening = note.listening {
        Label(listening, systemImage: "circle.fill").symbolEffect(.pulse).font(.footnote).foregroundStyle(.secondary)
      } else {
        Text(note.story).font(.footnote).foregroundStyle(.secondary)
        Text(note.facts.uppercased()).font(.caption2.monospaced()).foregroundStyle(.secondary)
        Button(note.stale ? "The playlist has changed a lot since this cover was drawn. New cover" : "New cover") { pickingCover = true }
          .font(.caption.monospaced())
      }
    }
  }

  private func startEditing() {
    guard model.mine, let playlist = model.playlist else { return }
    name = playlist.name
    details = playlist.description
    editing = true
  }

  private func perform(_ action: PlaylistAction) {
    switch action {
    case .rename: startEditing()
    case .playNext: model.queue(next: true)
    case .addToQueue: model.queue(next: false)
    case .newCover: pickingCover = true
    case .share: Task { await model.setShared(true) }
    case .stopSharing: Task { await model.setShared(false) }
    case .delete: confirmingDelete = true
    }
  }

  private func perform(_ action: PlaylistRowAction, on item: PlaylistItem) {
    let session = model.session
    if action == .remove {
      Task { await model.remove(item) }
      return
    }
    guard let track = item.track else { return }
    switch action {
    case .playNext: session.actions.playNext([track])
    case .addToQueue: session.actions.addToQueue([track])
    case .addToPlaylist: session.addToPlaylist([track])
    case .goToAlbum: session.actions.goToAlbum(track)
    case .goToArtist: session.actions.goToArtist(track)
    case .remove: break
    }
  }
}
```

In `UI/Components/PlaylistCard.swift` (pages/Playlists.tsx: whose it is when it isn't yours):

Replace:

```swift
        Text(Format.plural(playlist.trackCount, "song")).font(.caption.monospaced()).foregroundStyle(.secondary)
      }
```

with:

```swift
        Text(subtitle).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1)
      }
```

Replace:

```swift
    .accessibilityLabel("\(playlist.name), \(Format.plural(playlist.trackCount, "song"))")
    .accessibilityAddTraits(.isButton)
  }
}
```

with:

```swift
    .accessibilityLabel("\(playlist.name), \(subtitle)")
    .accessibilityAddTraits(.isButton)
  }

  /// "12 songs", and whose it is when it isn't yours: "12 songs · Sam".
  var subtitle: String { Format.plural(playlist.trackCount, "song") + (playlist.mine ? "" : " · \(playlist.owner)") }
}
```

In `RouteDestination.swift`:

Replace:

```swift
    case .playlists: PlaceholderPage(title: "Playlists")  // phase 6
    case .playlist: PlaceholderPage(title: "Playlist")  // phase 6
```

with:

```swift
    case .playlists: PlaylistsView(session: session)
    case .playlist(let id): PlaylistView(id: id, session: session)
```

**Step 2: Build for the Mac and the simulator**

```bash
swift build --disable-sandbox --package-path apps/ios/Packages/PlayarrUI
swift build --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --triple arm64-apple-ios26.0-simulator --sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" --scratch-path /tmp/playarr-ui-ios
```

Expected: both build with no errors or warnings.

`PlaylistsView` opens "New playlist" through `session.addToPlaylist([])`, and a song's ⋯ "Add to playlist…" too: the sheet that shows it comes in Task 17, so until then those two do nothing visible.

**Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Playlists/PlaylistsView.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Playlists/PlaylistView.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Playlists/PlaylistItemRow.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Playlists/CoverPickerView.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Playlists/RecommendationsSection.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/PlaylistCard.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/RouteDestination.swift
git commit -F - <<'MSG'
iOS: the Playlists grid and a playlist's page: new cover, rename, reorder, share, delete, and songs like these

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 17: Add to playlist from every song, Now Playing and the queue; New playlist in Library

One sheet on the shell (`addToPlaylistSheet`) shows whatever `session.addToPlaylist(_:)` asked for. A playlist made from nothing (New playlist) opens once made. The song menu gets "Add to playlist…" in the web's place (after Add to queue), Now Playing's ⋯ first (components/NowPlaying.tsx), the Queue "Save as playlist" (the song playing and what's up next, pages/Queue.tsx), and Library "New playlist" above its playlists (pages/Library.tsx), with the section always shown.

**Files:**
- Create: `UI/Pages/Playlists/AddToPlaylistSheet.swift`
- Modify: `UI/Shell/AppShell.swift`, `UI/Components/TrackMenu.swift`, `UI/NowPlaying/NowPlayingView.swift`, `UI/Pages/Queue/QueueView.swift`, `UI/Pages/Library/LibraryView.swift`

**Step 1: The sheet**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Playlists/AddToPlaylistSheet.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// "Add to playlist" and "New playlist" (apps/web/src/components/AddToPlaylistDialog.tsx). A playlist made from nothing
/// opens once it's made.
struct AddToPlaylistSheet: View {
  let session: AccountSession
  @State private var model: AddToPlaylistModel
  @Environment(\.dismiss) private var dismiss
  @FocusState private var naming: Bool

  init(tracks: [Track], session: AccountSession) {
    self.session = session
    _model = State(initialValue: AddToPlaylistModel(tracks: tracks, store: session.playlists))
  }

  var body: some View {
    NavigationStack {
      List {
        if model.creating {
          HStack {
            TextField("Playlist name", text: $model.name)
              .focused($naming)
              .submitLabel(.done)
              .onSubmit(create)
              .accessibilityIdentifier("playlist.name")
            Button("Create", action: create)
              .buttonStyle(.borderedProminent)
              .disabled(!model.canCreate)
              .accessibilityIdentifier("playlist.create")
          }
        } else {
          Button("New playlist", systemImage: "plus") {
            model.creating = true
            naming = true
          }
        }
        ForEach(model.choices) { playlist in
          Button {
            Task { if await model.add(to: playlist) { dismiss() } }
          } label: {
            HStack(spacing: 12) {
              PlaylistCover(cover: playlist.cover, points: 48, name: playlist.name).frame(width: 48, height: 48)
              VStack(alignment: .leading) {
                Text(playlist.name).lineLimit(1)
                Text(Format.plural(playlist.trackCount, "song")).font(.caption.monospaced()).foregroundStyle(.secondary)
              }
              Spacer(minLength: 0)
            }
            // The whole row, not just its words, takes the tap.
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .disabled(model.busy)
          .accessibilityLabel(playlist.name)
        }
      }
      .navigationTitle(model.title)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
      }
      .onAppear { naming = model.creating }
    }
    .presentationDetents([.medium, .large])
  }

  private func create() {
    Task {
      guard let playlist = await model.create() else { return }
      dismiss()
      if model.tracks.isEmpty { session.router.open(.playlist(playlist.id)) }
    }
  }
}

extension View {
  /// The "Add to playlist" sheet any screen opens with `AccountSession.addToPlaylist(_:)`.
  func addToPlaylistSheet(_ session: AccountSession) -> some View {
    sheet(item: Binding(get: { session.picking }, set: { session.picking = $0 })) { pick in
      AddToPlaylistSheet(tracks: pick.tracks, session: session)
    }
  }
}
```

In `AppShell.swift`:

Replace:

```swift
    .sheet(isPresented: Binding(get: { model.showingAccounts }, set: { model.showingAccounts = $0 })) { AccountSwitcherView(model: model) }
```

with:

```swift
    .sheet(isPresented: Binding(get: { model.showingAccounts }, set: { model.showingAccounts = $0 })) { AccountSwitcherView(model: model) }
    .addToPlaylistSheet(session)
```

**Step 2: Where it opens from**

In `TrackMenu.swift` (`TrackMenuItems`):

Replace:

```swift
    Button("Add to queue", systemImage: "text.append") { session.actions.addToQueue([track]) }
```

with:

```swift
    Button("Add to queue", systemImage: "text.append") { session.actions.addToQueue([track]) }
    Button("Add to playlist…", systemImage: "music.note.list") { session.addToPlaylist([track]) }
```

In `NowPlayingView.swift`, the ⋯ menu:

Replace:

```swift
        // Phase 6: Add to playlist…  Phase 8: Show metadata, Edit mix points.
```

with:

```swift
        // Phase 8: Show metadata, Edit mix points.
        Button("Add to playlist…", systemImage: "music.note.list") { session.addToPlaylist([track]) }
```

In `QueueView.swift`, the toolbar:

Replace:

```swift
        #if os(iOS)
          .toolbar { EditButton() }
        #endif
```

with:

```swift
        .toolbar {
          ToolbarItem(placement: .secondaryAction) {
            Button("Save as playlist", systemImage: "text.badge.plus") {
              session.addToPlaylist(AccountSession.queueToSave(session.player.queue))
            }
          }
          #if os(iOS)
            ToolbarItem(placement: .primaryAction) { EditButton() }
          #endif
        }
```

In `LibraryView.swift`, the playlists section starts with New playlist and is always there:

Replace:

```swift
      if let playlists = session.playlists.playlists, !playlists.isEmpty {
        Section("Playlists") {
          ForEach(playlists) { playlist in
```

with:

```swift
      Section {
        Button { session.addToPlaylist([]) } label: {
          HStack(spacing: 14) {
            Image(systemName: "plus")
              .foregroundStyle(theme.accent.color)
              .frame(width: 56, height: 56)
              .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.secondary.opacity(0.4), style: StrokeStyle(lineWidth: 1, dash: [4])))
            Text("New playlist")
          }
        }
        .accessibilityIdentifier("library.newPlaylist")
        if let playlists = session.playlists.playlists {
          ForEach(playlists) { playlist in
```

and its end gets a header that opens the Playlists grid:

Replace:

```swift
          }
        }
      }
    }
    .navigationTitle("Library")
```

with:

```swift
          }
        }
      } header: {
        NavigationLink(value: Route.playlists) { Text("Playlists") }
      }
    }
    .navigationTitle("Library")
```

**Step 3: Build and test**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI
swift build --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --triple arm64-apple-ios26.0-simulator --sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" --scratch-path /tmp/playarr-ui-ios
```

Expected: every suite passes; the build has no warnings.

**Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Playlists/AddToPlaylistSheet.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/AppShell.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/TrackMenu.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/NowPlaying/NowPlayingView.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Queue/QueueView.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Library/LibraryView.swift
git commit -F - <<'MSG'
iOS: Add to playlist from every song, Now Playing and the queue, and New playlist in Library

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 18: A mix's page, as a model

`pages/Mix.tsx` with `useMix`, `useRegenerateMix` and `useSaveMix`: "25 songs · 1 hr 32 min · Changes in 9 h", New mix ("Mixing…"), Save as playlist ("Saved as “…”", the page opens it), Play next, Add to queue, the time zone on every call.

**Files:**
- Create: `UI/Pages/Mixes/MixModel.swift`
- Test: `UITests/MixModelTests.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/MixModelTests.swift`:

```swift
import Foundation
import PlayarrAPI
import PlayarrPlayer
import Testing
@testable import PlayarrUI

@MainActor @Suite struct MixModelTests {
  let api = FakeAPI.demoLibrary()
  let rome = TimeZone(identifier: "Europe/Rome")!

  @Test func sendsTheDevicesTimeZoneWithEveryCall() async {
    api.on(.get, "/api/mixes/vibes", Listening.mix())
    api.on(.post, "/api/mixes/vibes/regenerate", Listening.mix())
    api.on(.post, "/api/mixes/vibes/save", Listening.playlist(9, "Your vibes · 3 Nov"))
    let session = demoSession(api: api)
    let mixes = MixesStore(api: api, queries: QueryCache(directory: nil), timeZone: rome)
    await mixes.load()
    let mix = MixModel(key: "vibes", session: session, timeZone: rome)
    await mix.load()
    await mix.regenerate()
    #expect(await mix.save()?.id == 9)
    // The list asked again after New mix comes from the session's store, in this device's own zone.
    #expect(api.queries(.get, "/api/mixes") == ["tz=Europe/Rome", "tz=\(TimeZone.current.identifier)"])
    for (method, path) in [(HTTPMethod.get, "/api/mixes/vibes"), (.post, "/api/mixes/vibes/regenerate"), (.post, "/api/mixes/vibes/save")] {
      #expect(api.queries(method, path) == ["tz=Europe/Rome"], "\(path)")
    }
    #expect(session.toasts.toasts.map(\.message) == ["Saved as “Your vibes · 3 Nov”"])
  }

  @Test func saysWhatTheMixIsAndWhenItChanges() async throws {
    api.on(.get, "/api/mixes/vibes", Listening.mix(refreshesAt: "2026-11-03T19:00:00.000Z", tracks: [Listening.angel, Listening.risingson]))
    let mix = MixModel(key: "vibes", session: demoSession(api: api))
    await mix.load()
    let now = try #require(Format.parseDate("2026-11-03T10:00:00.000Z"))
    #expect(mix.facts(now: now) == "2 songs · 11 min · Changes in 9 h")
  }

  @Test func saysWhenANewMixCouldntBeMade() async {
    api.on(.get, "/api/mixes/vibes", Listening.mix())
    api.fail(.post, "/api/mixes/vibes/regenerate", status: 500, "Not enough songs")
    let session = demoSession(api: api)
    let mix = MixModel(key: "vibes", session: session)
    await mix.load()
    await mix.regenerate()
    #expect(session.toasts.toasts.map(\.message) == ["Couldn’t make a new mix: Not enough songs"])
    #expect(!mix.regenerating)
    #expect(mix.mix != nil)
  }

  @Test func playsShufflesAndQueuesTheMix() async {
    api.on(.get, "/api/mixes/vibes", Listening.mix(tracks: [Listening.angel, Listening.risingson]))
    let session = demoSession(api: api)
    let mix = MixModel(key: "vibes", session: session)
    await mix.load()
    mix.play(shuffle: true)
    #expect(session.player.queue.shuffle)
    #expect(session.player.queue.source == PlaySource(label: "Your vibes", href: "/mixes/vibes"))
    mix.queue(next: false)
    #expect(session.toasts.toasts.map(\.message) == ["Added 2 tracks to queue"])
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter MixModelTests
```

Expected: the build fails with `cannot find 'MixModel' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Mixes/MixModel.swift`:

```swift
import Foundation
import Observation
import PlayarrAPI
import PlayarrPlayer

/// One mix's page: why these songs, when it changes, Play, Shuffle, New mix, Save as playlist, Play next and Add to
/// queue (apps/web/src/pages/Mix.tsx). Every call says the device's time zone.
@MainActor @Observable
final class MixModel {
  let key: String
  private(set) var mix: MixDetail?
  private(set) var error: String?
  /// "New mix" is being made ("Mixing…").
  private(set) var regenerating = false
  private(set) var saving = false

  @ObservationIgnored private let session: AccountSession
  @ObservationIgnored private let clock: any Clock<Duration>
  @ObservationIgnored private let timeZone: TimeZone

  init(key: String, session: AccountSession, clock: any Clock<Duration> = ContinuousClock(), timeZone: TimeZone = .current) {
    self.key = key
    self.session = session
    self.clock = clock
    self.timeZone = timeZone
  }

  var source: PlaySource { PlaySource(label: mix?.title ?? "", href: "/mixes/\(key)") }

  /// "25 songs · 1 hr 32 min · Changes in 9 h".
  func facts(now: Date = Date()) -> String {
    guard let mix else { return "" }
    var parts = [Format.plural(mix.trackCount, "song"), Format.duration(mix.duration)]
    if let due = Format.parseDate(mix.refreshesAt) { parts.append(Format.changes(at: due, now: now, timeZone: timeZone)) }
    return parts.joined(separator: " · ")
  }

  func load() async {
    do {
      mix = try await session.api.send(API.Mixes.get(key: key, timeZone: timeZone))
      error = nil
    } catch {
      if mix == nil { self.error = error.localizedDescription }
    }
  }

  /// Asks again 5 s after the mix is due to change, while the page is up.
  func poll() async {
    await Polling.run(
      clock: clock,
      interval: { [weak self] in MixesStore.recheck(due: [self?.mix?.refreshesAt].compactMap { $0.flatMap(Format.parseDate) }) },
      refresh: { [weak self] in await self?.load() })
  }

  /// "New mix": another draw for the same hour, day or week.
  func regenerate() async {
    guard !regenerating else { return }
    regenerating = true
    defer { regenerating = false }
    do {
      mix = try await session.api.send(API.Mixes.regenerate(key: key, timeZone: timeZone))
      await session.mixes.load()
    } catch {
      session.toasts.push("Couldn’t make a new mix: \(error.localizedDescription)", tone: .error)
    }
  }

  /// "Save as playlist": keeps the mix as an ordinary playlist and answers it, so the page can open it.
  func save() async -> PlaylistDetail? {
    guard !saving else { return nil }
    saving = true
    defer { saving = false }
    do {
      let playlist = try await session.api.send(API.Mixes.save(key: key, timeZone: timeZone))
      session.toasts.push("Saved as “\(playlist.name)”")
      await session.playlists.settled(playlist)
      return playlist
    } catch {
      session.toasts.push("Couldn’t save the mix: \(error.localizedDescription)", tone: .error)
      return nil
    }
  }

  func play(shuffle: Bool) {
    guard let tracks = mix?.tracks, !tracks.isEmpty else { return }
    session.player.play(tracks, source: source, shuffle: shuffle)
  }

  func queue(next: Bool) {
    guard let tracks = mix?.tracks, !tracks.isEmpty else { return }
    next ? session.actions.playNext(tracks) : session.actions.addToQueue(tracks)
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter MixModelTests
```

Expected: `Test run with 4 tests in 1 suite passed`.

**Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Mixes/MixModel.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/MixModelTests.swift
git commit -F - <<'MSG'
iOS: a mix's page model: New mix, Save as playlist and the queue, in this device's time zone

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 19: Made for you and a mix's page, with the web's cover angle

**Files:**
- Create: `UI/Pages/Mixes/MixesView.swift`, `UI/Pages/Mixes/MixView.swift`
- Modify: `UI/Components/MixCard.swift`, `UI/Shell/RouteDestination.swift`

**Step 1: Write the pages**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Mixes/MixesView.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// Made for you: every mix (apps/web/src/pages/Mixes.tsx). "Tune your mixes" (Settings → Mixes) comes with phase 9's
/// panel.
struct MixesView: View {
  let session: AccountSession

  var body: some View {
    let store = session.mixes
    ScrollView {
      if let mixes = store.mixes {
        if mixes.isEmpty {
          Text(
            "No mixes yet. They appear as you listen and as Playarr learns about your library’s songs (their genres, years and sound), which takes a little while after adding music."
          )
          .foregroundStyle(.secondary)
          .padding(20)
        } else {
          LazyVGrid(columns: [GridItem(.adaptive(minimum: ShelfCard.width), spacing: 16, alignment: .top)], spacing: 24) {
            ForEach(mixes, id: \.key) { MixCard(mix: $0) }
          }
          .padding(20)
        }
      } else if let error = store.error {
        ErrorState(message: error) { await store.load() }
      } else {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: ShelfCard.width), spacing: 16)], spacing: 24) {
          ForEach(0..<8, id: \.self) { _ in Skeleton().frame(width: ShelfCard.width) }
        }
        .padding(20)
      }
    }
    .navigationTitle("Made for you")
    .task { await store.poll() }
    .refreshable { await store.load() }
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Mixes/MixView.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// A mix's page: why these songs, when it changes, Play, Shuffle, New mix, the ⋯ menu (Save as playlist, Play next,
/// Add to queue) and the songs (apps/web/src/pages/Mix.tsx). Download joins in phase 7.
struct MixView: View {
  let session: AccountSession
  @State private var model: MixModel
  @Environment(Theme.self) private var theme

  init(key: String, session: AccountSession) {
    self.session = session
    _model = State(initialValue: MixModel(key: key, session: session))
  }

  var body: some View {
    Group {
      if let mix = model.mix {
        ScrollView {
          VStack(alignment: .leading, spacing: 16) {
            MixCover(mix: Self.summary(mix), width: 256)
              .shadow(color: .black.opacity(0.8), radius: 30, y: 20)
              .frame(maxWidth: .infinity)
            Kicker(text: "Made for you")
            Text(mix.title).font(.largeTitle.weight(.semibold))
            Text(mix.description).foregroundStyle(.secondary)
            TimelineView(.periodic(from: .now, by: 60)) { context in
              Text(model.facts(now: context.date)).font(.caption.monospaced()).foregroundStyle(.secondary)
            }
            HStack(spacing: 12) {
              Button("Play", systemImage: "play.fill") { model.play(shuffle: false) }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .tint(theme.accent.color)
                .foregroundStyle(.black)
                .disabled(mix.tracks.isEmpty)
                .accessibilityLabel("Play \(mix.title)")
              Button("Shuffle", systemImage: "shuffle") { model.play(shuffle: true) }
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .disabled(mix.tracks.isEmpty)
                .accessibilityLabel("Shuffle \(mix.title)")
              Button(model.regenerating ? "Mixing…" : "New mix", systemImage: "arrow.clockwise") { Task { await model.regenerate() } }
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .disabled(model.regenerating)
              // Phase 7: Download for this mix.
              Menu {
                Button("Save as playlist", systemImage: "bookmark") {
                  // Opens the new playlist, so it's clear what was made and where it lives.
                  Task { if let playlist = await model.save() { session.router.open(.playlist(playlist.id)) } }
                }
                Button("Play next", systemImage: "text.line.first.and.arrowtriangle.forward") { model.queue(next: true) }
                Button("Add to queue", systemImage: "text.append") { model.queue(next: false) }
              } label: {
                Image(systemName: "ellipsis").frame(width: 44, height: 44)
              }
              .accessibilityLabel("Mix actions")
            }
            LazyVStack(spacing: 0) {
              ForEach(Array(mix.tracks.enumerated()), id: \.element.id) { index, track in
                TrackRow(track: track, style: .mixed) { session.player.play(mix.tracks, startAt: index, source: model.source) }
              }
            }
          }
          .padding(20)
        }
      } else if let error = model.error {
        ErrorState(message: error) { await model.load() }
      } else {
        ProgressView()
      }
    }
    .navigationTitle(model.mix?.title ?? "")
    #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
    #endif
    .task { await model.poll() }
  }

  /// The mix as its cover draws it.
  static func summary(_ mix: MixDetail) -> MixSummary {
    MixSummary(
      key: mix.key, kind: mix.kind, title: mix.title, subtitle: mix.subtitle, description: mix.description, trackCount: mix.trackCount,
      duration: mix.duration, covers: mix.covers, hue: mix.hue, generatedAt: mix.generatedAt, refreshesAt: mix.refreshesAt)
  }
}
```

In `UI/Components/MixCard.swift` (`MixCover`), the wash at the web's angle:

Replace:

```swift
    let covers = mix.covers.count >= 4 ? Array(mix.covers.prefix(4)) : Array(mix.covers.prefix(1))
```

with:

```swift
    let covers = mix.covers.count >= 4 ? Array(mix.covers.prefix(4)) : Array(mix.covers.prefix(1))
    // The web's `linear-gradient(165deg, …)`: mostly down, a little to the right.
    let wash = CSSGradient.points(angle: 165)
```

Replace:

```swift
        ], startPoint: .topLeading, endPoint: .bottomTrailing)
```

with:

```swift
        ], startPoint: wash.start, endPoint: wash.end)
```

In `RouteDestination.swift`:

Replace:

```swift
    case .mixes: PlaceholderPage(title: "Made for you")  // phase 6
    case .mix: PlaceholderPage(title: "Mix")  // phase 6
```

with:

```swift
    case .mixes: MixesView(session: session)
    case .mix(let key): MixView(key: key, session: session)
```

**Step 2: Build for the Mac and the simulator**

```bash
swift build --disable-sandbox --package-path apps/ios/Packages/PlayarrUI
swift build --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --triple arm64-apple-ios26.0-simulator --sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" --scratch-path /tmp/playarr-ui-ios
```

Expected: both build with no errors or warnings.

**Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Mixes/MixesView.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Mixes/MixView.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/MixCard.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/RouteDestination.swift
git commit -F - <<'MSG'
iOS: Made for you and a mix's page, with the mix cover's wash at the web's angle

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 20: Your listening, as a model, with its charts' data and the period in the route

`pages/Stats.tsx` (`ListeningStatsView`, `Report`) and `components/ColumnChart.tsx`. Hours are labelled as the device writes them ("12 AM"; the narrow no-break space before AM/PM is what browsers write too), weekdays Sunday first (as the server counts), months for a calendar year.

**Files:**
- Create: `UI/Pages/Stats/StatsModel.swift`, `UI/Pages/Stats/ListeningChart.swift`
- Modify: `UI/Shell/Route.swift`, `UI/Shell/RouteDestination.swift`, `UITests/RouterTests.swift`
- Test: `UITests/StatsModelTests.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/StatsModelTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct StatsModelTests {
  let api = FakeAPI.demoLibrary()
  let english = Locale(identifier: "en_US")

  @Test func offersThePeriodsThenEachYear() async {
    api.on(.get, "/api/stats", Listening.stats())
    let model = StatsModel(session: demoSession(api: api))
    await model.load()
    #expect(model.periods.map(\.label) == ["4 weeks", "6 months", "12 months", "All time", "2026", "2025"])
    #expect(api.queries(.get, "/api/stats") == ["range=month"])
    api.on(.get, "/api/stats", Listening.stats(range: "2025"))
    await model.select("2025")
    #expect(model.isYear)
    #expect(api.queries(.get, "/api/stats").last == "range=2025")
    await model.select("next week")
    #expect(model.range == "2025")
  }

  @Test func readsAnUnknownRangeAsFourWeeks() {
    let session = demoSession(api: api)
    #expect(StatsModel(range: "decade", session: session).range == "month")
    #expect(StatsModel(range: "2024", session: session).range == "2024")
  }

  @Test func saysTheReportInTheWebsWords() {
    let stats = Listening.stats()
    #expect(StatsModel.summary(stats) == "37 songs by 12 artists, on 9 days.")
    #expect(StatsModel.tiles(stats, locale: english).map(\.value) == ["40", "1 day", "1,234", "11 min"])
  }

  @Test func playsTheTopSongsOfTheYear() async {
    api.on(.get, "/api/stats", Listening.stats(range: "2025"))
    let session = demoSession(api: api)
    let model = StatsModel(range: "2025", session: session)
    await model.load()
    model.playTop(all: true)
    #expect(session.player.queue.source == .init(label: "Your top songs of 2025", href: "/settings/listening?range=2025"))
    model.playTop(from: 1, all: false)
    #expect(session.player.queue.source?.label == "Your top songs")
    #expect(session.player.queue.currentTrack?.title == "Risingson")
  }

  @Test func shapesTheChartsWithTheBusiestLabelled() {
    var hours = Array(repeating: 0.0, count: 24)
    hours[21] = 125
    hours[8] = 30
    let chart = ListeningChart.hours(hours, locale: english)
    // Between the hour and AM/PM: a narrow no-break space, as browsers' toLocaleTimeString writes it.
    #expect(chart.columns.count == 24)
    #expect(chart.columns[0].label == "12\u{202F}AM")
    #expect(chart.columns[21].label == "9\u{202F}PM")
    #expect(chart.columns.filter(\.tick).map(\.id) == [0, 6, 12, 18])
    #expect(chart.caption(locale: english) == "Most: 9\u{202F}PM · 2 h 5 min")
    #expect(chart.caption(selected: 8, locale: english) == "8\u{202F}AM · 30 min")
    #expect(ListeningChart.weekdays(Array(repeating: 0, count: 7), locale: english).columns.first?.label == "Sun")
    #expect(ListeningChart.weekdays(Array(repeating: 0, count: 7), locale: english).caption() == nil)
    #expect(ListeningChart.months(Array(repeating: 1, count: 12), locale: english).columns.last?.label == "Dec")
  }

  @Test func readsTheWebsListeningLinks() {
    #expect(Route(href: "/settings/listening?range=2025") == .listeningRange("2025"))
    #expect(Route(href: "/stats") == .listening)
    #expect(Route(href: "/settings/listening") == .listening)
  }
}
```

Phase 4's `RouterTests` expected the period to be dropped; it's kept now. In `UITests/RouterTests.swift`:

Replace:

```swift
    #expect(Route(href: "/settings/listening?range=2026") == .listening)
```

with:

```swift
    #expect(Route(href: "/settings/listening?range=2026") == .listeningRange("2026"))
```

**Step 2: Run them to see them fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter StatsModelTests
```

Expected: the build fails with `cannot find 'StatsModel' in scope` and `type 'Route' has no member 'listeningRange'`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Stats/StatsModel.swift`:

```swift
import Foundation
import Observation
import PlayarrAPI
import PlayarrPlayer

/// Your listening: what you played most, and when, for a period; each calendar year has a year in review
/// (apps/web/src/pages/Stats.tsx). The last report stays on screen while the next period loads.
@MainActor @Observable
final class StatsModel {
  struct Period: Hashable, Sendable {
    let range: StatsRange
    let label: String
  }

  static let fixed = [
    Period(range: "month", label: "4 weeks"), Period(range: "halfyear", label: "6 months"),
    Period(range: "year", label: "12 months"), Period(range: "all", label: "All time"),
  ]

  /// Shown when nothing was played in the period.
  static let nothingPlayed =
    "Nothing played in this period yet. Songs count once heard for 30 seconds, from every device that counts its plays (Settings → Playback)."

  private(set) var range: StatsRange
  private(set) var stats: ListeningStats?
  private(set) var error: String?
  private(set) var loading = false

  @ObservationIgnored private let session: AccountSession

  init(range: StatsRange? = nil, session: AccountSession) {
    self.range = range.flatMap { Self.isValid($0) ? $0 : nil } ?? "month"
    self.session = session
    stats = session.queries.cached(.stats(self.range), as: ListeningStats.self)?.value
  }

  /// A calendar year ("2026") rather than a period.
  static func isYear(_ range: StatsRange) -> Bool { range.count == 4 && range.allSatisfy(\.isNumber) }
  static func isValid(_ range: StatsRange) -> Bool { fixed.contains { $0.range == range } || isYear(range) }

  var isYear: Bool { Self.isYear(range) }

  /// The four periods, then each year with history, newest first.
  var periods: [Period] { Self.fixed + (stats?.years ?? []).map { Period(range: String($0), label: String($0)) } }

  func select(_ range: StatsRange) async {
    guard range != self.range, Self.isValid(range) else { return }
    self.range = range
    await load()
  }

  func load() async {
    let asked = range
    loading = true
    defer { loading = false }
    do {
      let api = session.api
      let fresh = try await session.queries.fetch(.stats(asked)) { try await api.send(API.Stats.listening(asked)) }
      guard asked == range else { return }
      stats = fresh
      error = nil
    } catch {
      guard asked == range else { return }
      if stats == nil { self.error = error.localizedDescription }
    }
  }

  /// "Play them", or a tap on one of the top songs.
  func playTop(from index: Int = 0, all: Bool) {
    guard let stats, !stats.topTracks.isEmpty else { return }
    let label = all && isYear ? "Your top songs of \(stats.range)" : "Your top songs"
    session.player.play(
      stats.topTracks.map(\.track), startAt: index, source: PlaySource(label: label, href: "/settings/listening?range=\(stats.range)"))
  }

  /// "37 songs by 12 artists, on 9 days."
  static func summary(_ stats: ListeningStats) -> String {
    "\(Format.plural(stats.songs, "song")) by \(Format.plural(stats.artists, "artist")), on \(Format.plural(stats.days, "day"))."
  }

  /// The four figures under the minutes.
  static func tiles(_ stats: ListeningStats, locale: Locale = .current) -> [(label: String, value: String)] {
    [
      ("Plays", Format.number(stats.plays, locale: locale)),
      ("Longest streak", Format.plural(stats.longestStreak, "day")),
      ("New artists", Format.number(stats.newArtists, locale: locale)),
      ("A day, on average", Format.minutes((stats.minutes / Double(max(1, stats.days))).rounded(), locale: locale)),
    ]
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Stats/ListeningChart.swift`:

```swift
import Foundation

/// One measure across ordered categories (hours, weekdays, months) as columns, shaped for Swift Charts:
/// the busiest labelled, every column's full label for VoiceOver and the numbers (components/ColumnChart.tsx).
struct ListeningChart: Equatable {
  struct Column: Identifiable, Equatable {
    let id: Int
    let label: String
    let minutes: Double
    /// Gets an axis label underneath.
    let tick: Bool
  }

  let title: String
  let columns: [Column]

  init(title: String, minutes: [Double], labels: [String], tick: (Int) -> Bool = { _ in true }) {
    self.title = title
    columns = zip(minutes.indices, zip(minutes, labels)).map { Column(id: $0, label: $1.1, minutes: $1.0, tick: tick($0)) }
  }

  /// The busiest column, when anything was heard.
  var peak: Column? {
    guard let top = columns.max(by: { $0.minutes < $1.minutes }), top.minutes > 0 else { return nil }
    return columns.first { $0.minutes == top.minutes }
  }

  /// "Most: 9 PM · 2 h 5 min", or the column the finger is on.
  func caption(selected: Int? = nil, locale: Locale = .current) -> String? {
    if let selected, let column = columns.first(where: { $0.id == selected }), column.minutes > 0 {
      return "\(column.label) · \(Format.minutes(column.minutes, locale: locale))"
    }
    return peak.map { "Most: \($0.label) · \(Format.minutes($0.minutes, locale: locale))" }
  }

  static func hours(_ minutes: [Double], locale: Locale = .current) -> ListeningChart {
    let formatter = DateFormatter()
    formatter.locale = locale
    formatter.timeZone = TimeZone(identifier: "UTC")
    formatter.setLocalizedDateFormatFromTemplate("j")
    let labels = (0..<24).map { formatter.string(from: Date(timeIntervalSince1970: Double($0) * 3600)) }
    return ListeningChart(title: "By hour of the day", minutes: minutes, labels: labels, tick: { $0 % 6 == 0 })
  }

  /// Sunday first, as the server counts.
  static func weekdays(_ minutes: [Double], locale: Locale = .current) -> ListeningChart {
    var calendar = Calendar(identifier: .gregorian)
    calendar.locale = locale
    return ListeningChart(title: "By day of the week", minutes: minutes, labels: calendar.shortWeekdaySymbols)
  }

  static func months(_ minutes: [Double], locale: Locale = .current) -> ListeningChart {
    var calendar = Calendar(identifier: .gregorian)
    calendar.locale = locale
    return ListeningChart(title: "By month", minutes: minutes, labels: calendar.shortMonthSymbols)
  }
}
```

In `UI/Shell/Route.swift`, the case:

Replace:

```swift
  case listening
```

with:

```swift
  case listening
  /// Your listening for a period or a calendar year ("halfyear", "2025"): the web's `?range=`.
  case listeningRange(StatsRange)
```

and `init(href:)` reads the period:

Replace:

```swift
    case ("stats", 1): self = .listening
```

with:

```swift
    case ("stats", 1): self = query("range").map(Route.listeningRange) ?? .listening
```

Replace:

```swift
      if parts[1] == "listening" { self = .listening } else {
```

with:

```swift
      if parts[1] == "listening" { self = query("range").map(Route.listeningRange) ?? .listening } else {
```

In `RouteDestination.swift`, until Task 21:

Replace:

```swift
    case .listening: PlaceholderPage(title: "Your listening")  // phase 6
```

with:

```swift
    case .listening, .listeningRange: PlaceholderPage(title: "Your listening")  // Task 21
```

**Step 4: Run them to see them pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter "StatsModelTests|RouterTests"
```

Expected: `Test run with 10 tests in 2 suites passed` (6 in `StatsModelTests`, phase 4's 4 in `RouterTests`).

**Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Stats/StatsModel.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Stats/ListeningChart.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/Route.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/RouteDestination.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/RouterTests.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/StatsModelTests.swift
git commit -F - <<'MSG'
iOS: Your listening's periods, report and chart data, and a route that keeps the period

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 21: The Your listening page with Swift Charts, and Home's year in review opens its year

**Files:**
- Create: `UI/Pages/Stats/StatsView.swift`, `UI/Pages/Stats/ColumnChartView.swift`
- Modify: `UI/Shell/RouteDestination.swift`, `UI/Pages/Home/HomeView.swift`

**Step 1: Write the page and the chart**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Stats/ColumnChartView.swift`:

```swift
import Charts
import SwiftUI

/// One measure across hours, weekdays or months as columns in the accent colour: the busiest named above, any other
/// under the finger, and the numbers for VoiceOver (apps/web/src/components/ColumnChart.tsx).
struct ColumnChartView: View {
  let chart: ListeningChart
  var height: CGFloat = 140
  @State private var selected: Int?
  @Environment(Theme.self) private var theme

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .firstTextBaseline) {
        Kicker(text: chart.title)
        Spacer()
        if let caption = chart.caption(selected: selected) {
          Text(caption).font(.footnote.monospacedDigit()).foregroundStyle(.secondary)
        }
      }
      Chart(chart.columns) { column in
        BarMark(x: .value("When", column.id), y: .value("Minutes", column.minutes))
          .foregroundStyle(theme.accent.color.opacity(selected == nil || selected == column.id ? 1 : 0.45))
          .cornerRadius(4)
      }
      .chartXScale(domain: -0.5...(Double(chart.columns.count) - 0.5))
      .chartXAxis {
        AxisMarks(values: chart.columns.filter(\.tick).map(\.id)) { value in
          AxisValueLabel {
            if let id = value.as(Int.self) { Text(chart.columns[id].label).font(.caption2.monospaced()) }
          }
        }
      }
      .chartYAxis(.hidden)
      .chartXSelection(value: $selected)
      .frame(height: height)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(chart.title)
      .accessibilityValue(chart.columns.map { "\($0.label): \(Format.minutes($0.minutes))" }.joined(separator: ", "))
    }
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Stats/StatsView.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// Your listening: the period (4 weeks, 6 months, 12 months, all time or a year), the minutes and figures, the artist of
/// the year, top artists, songs and albums, when you listen, and your sound (apps/web/src/pages/Stats.tsx).
struct StatsView: View {
  let session: AccountSession
  @State private var model: StatsModel
  @Environment(Theme.self) private var theme

  init(range: StatsRange?, session: AccountSession) {
    self.session = session
    _model = State(initialValue: StatsModel(range: range, session: session))
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 32) {
        if model.isYear { Text("Your \(model.range)").font(.largeTitle.weight(.semibold)) }
        ScrollView(.horizontal) {
          HStack(spacing: 8) {
            ForEach(model.periods, id: \.self) { period in
              Button(period.label) { Task { await model.select(period.range) } }
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .tint(period.range == model.range ? theme.accent.color : .secondary)
                .accessibilityAddTraits(period.range == model.range ? .isSelected : [])
            }
          }
        }
        .scrollIndicators(.hidden)
        if let stats = model.stats {
          if stats.plays == 0 {
            Text(StatsModel.nothingPlayed).foregroundStyle(.secondary)
          } else {
            report(stats).opacity(model.loading ? 0.6 : 1)
          }
        } else if let error = model.error {
          ErrorState(message: error) { await model.load() }
        } else {
          Skeleton(aspectRatio: nil, height: 96)
          Skeleton(aspectRatio: nil, height: 240)
        }
      }
      .padding(20)
    }
    .navigationTitle("Your listening")
    .task { await model.load() }
    .refreshable { await model.load() }
  }

  @ViewBuilder private func report(_ stats: ListeningStats) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      if model.isYear { Text("YEAR IN REVIEW").font(.caption2.monospaced()).tracking(2).foregroundStyle(theme.accent.color) }
      HStack(alignment: .firstTextBaseline, spacing: 10) {
        Text(Format.number(Int(stats.minutes.rounded()))).font(.system(size: 56, weight: .semibold)).monospacedDigit()
        Text("minutes").font(.title3).foregroundStyle(.secondary)
      }
      Text(StatsModel.summary(stats)).foregroundStyle(.secondary)
      Grid(alignment: .leading, horizontalSpacing: 24, verticalSpacing: 16) {
        let tiles = StatsModel.tiles(stats)
        GridRow { tile(tiles[0]); tile(tiles[1]) }
        GridRow { tile(tiles[2]); tile(tiles[3]) }
      }
      .padding(.top, 12)
    }
    if model.isYear, let top = stats.topArtists.first {
      NavigationLink(value: Route.artist(top.artist.id)) {
        HStack(alignment: .bottom, spacing: 16) {
          Cover(path: top.artist.imageUrl, points: 120, label: top.artist.name).frame(width: 120, height: 120)
          VStack(alignment: .leading, spacing: 4) {
            Kicker(text: "Your artist of the year")
            Text(top.artist.name).font(.title.weight(.semibold))
            Text(artistLine(top, first: stats.firstSong)).font(.subheadline).foregroundStyle(.secondary)
          }
        }
      }
      .buttonStyle(.plain)
    }
    section("Top artists") {
      ForEach(Array(stats.topArtists.enumerated()), id: \.element.artist.id) { index, item in
        NavigationLink(value: Route.artist(item.artist.id)) {
          HStack(spacing: 14) {
            Text("\(index + 1)").font(.subheadline.monospacedDigit()).foregroundStyle(.secondary).frame(width: 24, alignment: .trailing)
            Cover(path: item.artist.imageUrl, points: 48, label: item.artist.name, circle: true).frame(width: 48, height: 48)
            Text(item.artist.name).lineLimit(1)
            Spacer()
            Text("\(Format.minutes(item.minutes)) · \(Format.plural(item.plays, "play"))").font(.footnote.monospacedDigit()).foregroundStyle(.secondary)
          }
        }
        .buttonStyle(.plain)
      }
    }
    section("Top songs") {
      Button("Play them", systemImage: "play.fill") { model.playTop(all: true) }
        .buttonStyle(.borderedProminent)
        .buttonBorderShape(.capsule)
        .tint(theme.accent.color)
        .foregroundStyle(.black)
      ForEach(Array(stats.topTracks.enumerated()), id: \.element.track.id) { index, item in
        Button { model.playTop(from: index, all: false) } label: {
          HStack(spacing: 14) {
            Text("\(index + 1)").font(.subheadline.monospacedDigit()).foregroundStyle(.secondary).frame(width: 24, alignment: .trailing)
            Cover(path: item.track.coverUrl, points: 44, label: item.track.albumTitle).frame(width: 44, height: 44)
            VStack(alignment: .leading) {
              Text(item.track.title).lineLimit(1)
              Text(item.track.artistName).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            Text(Format.plural(item.plays, "play")).font(.footnote.monospacedDigit()).foregroundStyle(.secondary)
          }
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
      }
    }
    if !stats.topAlbums.isEmpty {
      section("Top albums") {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 16, alignment: .top)], spacing: 24) {
          ForEach(stats.topAlbums.prefix(6), id: \.album.id) { AlbumCard(album: $0.album) }
        }
      }
    }
    section("When you listen") {
      ColumnChartView(chart: .hours(stats.hours))
      ColumnChartView(chart: .weekdays(stats.weekdays))
      if let months = stats.months { ColumnChartView(chart: .months(months)) }
    }
    if !stats.topGenres.isEmpty {
      section("Your sound") {
        FlowLayout(spacing: 8) {
          ForEach(stats.topGenres, id: \.genre) { genre in
            HStack(spacing: 6) {
              Text(genre.genre)
              Text(Format.minutes(genre.minutes)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .overlay(Capsule().strokeBorder(Color.secondary.opacity(0.3)))
          }
        }
      }
    }
  }

  private func tile(_ tile: (label: String, value: String)) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(tile.label).font(.footnote).foregroundStyle(.secondary)
      Text(tile.value).font(.title2.weight(.semibold)).monospacedDigit()
    }
  }

  private func section(_ title: String, @ViewBuilder content: () -> some View) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(title).font(.title.weight(.semibold)).accessibilityAddTraits(.isHeader)
      content()
    }
  }

  /// "1 h 50 min over 20 plays · your year started with Angel".
  private func artistLine(_ top: ListeningStats.TopArtistsItem, first: ListeningStats.FirstSong?) -> String {
    "\(Format.minutes(top.minutes)) over \(Format.plural(top.plays, "play"))" + (first.map { " · your year started with \($0.track.title)" } ?? "")
  }
}
```

In `RouteDestination.swift`:

Replace:

```swift
    case .listening, .listeningRange: PlaceholderPage(title: "Your listening")  // Task 21
```

with:

```swift
    case .listening: StatsView(range: nil, session: session)
    case .listeningRange(let range): StatsView(range: range, session: session)
```

In `HomeView.swift`, the year in review card opens its year (the web's `/settings/listening?range=<year>`):

Replace:

```swift
    NavigationLink(value: Route.listening) {
```

with:

```swift
    NavigationLink(value: Route.listeningRange(String(review.year))) {
```

**Step 2: Build for the Mac and the simulator, and run the package**

```bash
swift build --disable-sandbox --package-path apps/ios/Packages/PlayarrUI
swift build --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --triple arm64-apple-ios26.0-simulator --sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" --scratch-path /tmp/playarr-ui-ios
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI
```

Expected: both build with no errors or warnings; every suite passes.

**Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Stats/StatsView.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Stats/ColumnChartView.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/RouteDestination.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Home/HomeView.swift
git commit -F - <<'MSG'
iOS: Your listening: the report, top artists, songs and albums, when you listen in charts, and your sound

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 22: The demo server remembers favorites and playlists

So the UI tests can heart a song and make, fill, reorder and delete a playlist without a server. Unknown ids answer 404 "Not found" as the demo does; a song not in the demo library answers the server's "Song … is not in the library".

**Files:**
- Create: `UI/Demo/DemoState.swift`, `UI/Demo/Demo+Listening.swift`
- Modify: `UI/Demo/DemoAPI.swift`
- Test: `UITests/DemoStateTests.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/DemoStateTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

/// The demo server remembers favorites and playlists, so the UI tests can change them.
@Suite struct DemoStateTests {
  @Test func heartsAndUnheartsASong() async throws {
    let api = DemoAPI()
    _ = try await api.send(API.Favorites.add(recordingId: "rec-700"))
    #expect(try await api.send(API.Favorites.list()).map(\.title) == ["Angel", "Risingson"])
    _ = try await api.send(API.Favorites.remove(recordingId: "rec-701"))
    #expect(try await api.send(API.Favorites.list()).map(\.title) == ["Angel"])
  }

  @Test func makesFillsReordersAndDeletesAPlaylist() async throws {
    let api = DemoAPI()
    let made = try await api.send(API.Playlists.create(name: "UI test"))
    #expect(made.id == 2)
    #expect(try await api.send(API.Playlists.list()).map(\.name) == ["UI test", "Late night"])
    _ = try await api.send(API.Playlists.addItems(id: 2, recordingIds: ["rec-700"]))
    let two = try await api.send(API.Playlists.addItems(id: 2, recordingIds: ["rec-701"]))
    #expect(two.items.map(\.title) == ["Angel", "Risingson"])
    #expect(two.trackCount == 2)
    let moved = try await api.send(API.Playlists.reorder(id: 2, itemIds: two.items.map(\.itemId).reversed()))
    #expect(moved.items.map(\.title) == ["Risingson", "Angel"])
    #expect(try await api.send(API.Playlists.recommendations(id: 2)).owned.map(\.title) == ["Inertia Creeps", "Protection"])
    _ = try await api.send(API.Playlists.delete(id: 2))
    await #expect(throws: APIError.server(status: 404, message: "Not found")) { try await api.send(API.Playlists.get(id: 2)) }
  }

  @Test func savesTheMixAsAPlaylist() async throws {
    let api = DemoAPI()
    let saved = try await api.send(API.Mixes.save(key: "vibes"))
    #expect(saved.name == "Your vibes · 3 Nov")
    #expect(saved.trackCount == 3)
    #expect(try await api.send(API.Stats.listening("2026")).months?.count == 12)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter DemoStateTests
```

Expected: `makesFillsReordersAndDeletesAPlaylist` and the others fail with `Not found` (the demo has no such routes yet).

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Demo/Demo+Listening.swift`:

```swift
import PlayarrAPI

extension Demo {
  /// "Late night" with its songs (Angel and Risingson), as GET /api/playlists/1 answers it.
  static let lateNight = PlaylistDetail(
    id: playlist.id, name: playlist.name, description: playlist.description, trackCount: 2, duration: 677, cover: playlist.cover,
    updatedAt: playlist.updatedAt, owner: playlist.owner, shared: playlist.shared, mine: playlist.mine,
    items: mezzanineTracks.prefix(2).enumerated().map { index, track in
      PlaylistItem(
        itemId: index + 1, recordingId: track.recordingId, title: track.title, artistName: track.artistName,
        albumTitle: track.albumTitle, addedAt: when, track: track)
    })

  /// "Your vibes" with its songs.
  static let mixDetail = MixDetail(
    key: mix.key, kind: mix.kind, title: mix.title, subtitle: mix.subtitle, description: mix.description, trackCount: 3,
    duration: 1033, covers: mix.covers, hue: mix.hue, generatedAt: mix.generatedAt, refreshesAt: mix.refreshesAt,
    tracks: mezzanineTracks)

  /// A month of listening (or a calendar year): Massive Attack most of all.
  static func stats(range: String) -> ListeningStats {
    var hours = Array(repeating: 0.0, count: 24)
    hours[21] = 125
    hours[8] = 30
    return ListeningStats(
      range: range, to: when, minutes: 155, plays: 31, songs: 8, artists: 2, days: 6, newArtists: 1, longestStreak: 3,
      topArtists: [.init(artist: artist, plays: 20, minutes: 110), .init(artist: otherArtist, plays: 11, minutes: 45)],
      topAlbums: [.init(album: albums[0], plays: 14, minutes: 80)],
      topTracks: mezzanineTracks.map { .init(track: $0, plays: 5) }, topGenres: [.init(genre: "trip hop", minutes: 155)],
      hours: hours, weekdays: [10, 20, 30, 25, 20, 30, 20], months: range.count == 4 ? Array(repeating: 12, count: 12) : nil,
      firstSong: .init(track: mezzanineTracks[0], at: when), years: [2026])
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Demo/DemoState.swift`:

```swift
import Foundation
import PlayarrAPI
import Synchronization

/// What the demo server remembers between calls: favorites and playlists change, as on a real server, so the UI tests
/// can heart a song, make a playlist, add to it, reorder it and delete it (`-UITestsDemo`). Mixes, recommendations and
/// listening stats answer from the demo library.
final class DemoState: Sendable {
  private struct Library {
    var favorites = [Demo.favorite]
    var playlists = [Demo.lateNight]
    var nextPlaylist = 2
    var nextItem = 100
  }

  private let library = Mutex(Library())

  /// The answer to `method path`, or nil when it isn't one of these.
  func answer(_ method: HTTPMethod, _ path: String, query: [URLQueryItem], body: Data?) throws -> (any Encodable & Sendable)? {
    // "/api/playlists/5/items" → ["playlists", "5", "items"]
    var parts = path.split(separator: "/").map(String.init)
    guard parts.first == "api" else { return nil }
    parts.removeFirst()
    let first = parts.first ?? ""
    let second = parts.count > 1 ? parts[1] : nil
    switch (method, first, parts.count) {
    case (.get, "favorites", 1):
      return library.withLock { $0.favorites }
    case (.put, "favorites", 2):
      guard let track = Demo.tracks.first(where: { $0.recordingId == second }) else { throw Self.notFound }
      library.withLock { state in
        if !state.favorites.contains(where: { $0.recordingId == track.recordingId }) {
          state.favorites.insert(FavoriteTrack(track, favoritedAt: Date().formatted(.iso8601)), at: 0)
        }
      }
      return NoBody()
    case (.delete, "favorites", 2):
      library.withLock { $0.favorites.removeAll { $0.recordingId == second } }
      return NoBody()
    case (.get, "playlists", 1):
      return library.withLock { $0.playlists.map(Self.summary) }
    case (.post, "playlists", 1):
      let input = try JSONDecoder().decode(Input.self, from: body ?? Data("{}".utf8))
      return try library.withLock { state in
        let id = state.nextPlaylist
        state.nextPlaylist += 1
        var playlist = Self.playlist(id: id, name: input.name ?? "", description: input.description ?? "", shared: input.shared ?? false)
        playlist.items = try Self.items(input.recordingIds ?? [], next: &state.nextItem)
        state.playlists.insert(Self.counted(playlist), at: 0)
        return state.playlists[0]
      }
    case (_, "playlists", _):
      guard let id = second.flatMap(Int.init) else { return nil }
      return try playlist(method, id: id, rest: Array(parts.dropFirst(2)), body: body)
    case (.get, "mixes", 2) where second == Demo.mix.key:
      return Demo.mixDetail
    case (.post, "mixes", 3) where second == Demo.mix.key && parts[2] == "regenerate":
      return Demo.mixDetail
    case (.post, "mixes", 3) where second == Demo.mix.key && parts[2] == "save":
      let input = Input(name: "\(Demo.mix.title) · 3 Nov", recordingIds: Demo.mixDetail.tracks.map(\.recordingId))
      return try answer(.post, "/api/playlists", query: [], body: try JSONEncoder().encode(input))
    case (.get, "stats", 1):
      return Demo.stats(range: query.first { $0.name == "range" }?.value ?? "month")
    default:
      return nil
    }
  }

  private func playlist(_ method: HTTPMethod, id: Int, rest: [String], body: Data?) throws -> (any Encodable & Sendable)? {
    try library.withLock { state in
      guard let index = state.playlists.firstIndex(where: { $0.id == id }) else { throw Self.notFound }
      var playlist = state.playlists[index]
      switch (method, rest.first ?? "", rest.count) {
      case (.get, "", 0):
        return playlist
      case (.get, "recommendations", 1):
        // Songs from the library not in the playlist yet, "like" its first song.
        let have = Set(playlist.items.map(\.recordingId))
        let owned = Demo.tracks.filter { !have.contains($0.recordingId) }.prefix(2).map { track in
          RecommendedTrack(
            recordingId: track.recordingId, title: track.title, artistName: track.artistName, albumTitle: track.albumTitle,
            coverUrl: track.coverUrl, because: playlist.items.first?.title ?? "", track: track, artistId: track.artistId)
        }
        return Recommendations(owned: Array(owned), missing: [], seedCount: playlist.items.isEmpty ? 0 : 1)
      case (.delete, "", 0):
        state.playlists.remove(at: index)
        return NoBody()
      case (.patch, "", 0):
        let input = try JSONDecoder().decode(Input.self, from: body ?? Data("{}".utf8))
        playlist.name = input.name ?? playlist.name
        playlist.description = input.description ?? playlist.description
        playlist.shared = input.shared ?? playlist.shared
      case (.post, "items", 1):
        let input = try JSONDecoder().decode(Input.self, from: body ?? Data("{}".utf8))
        playlist.items += try Self.items(input.recordingIds ?? [], next: &state.nextItem)
      case (.delete, "items", 2):
        playlist.items.removeAll { String($0.itemId) == rest[1] }
      case (.put, "order", 1):
        let order = try JSONDecoder().decode(Order.self, from: body ?? Data("{}".utf8)).itemIds
        playlist.items = order.compactMap { id in playlist.items.first { $0.itemId == id } }
      case (.put, "cover", 1):
        let cover = try JSONDecoder().decode(CoverInput.self, from: body ?? Data("{}".utf8))
        playlist.cover.layout = cover.layout
        playlist.cover.variant = cover.variant
      default:
        return nil
      }
      state.playlists[index] = Self.counted(playlist)
      return state.playlists[index]
    }
  }

  private struct Input: Codable {
    var name: String?
    var description: String?
    var recordingIds: [String]?
    var shared: Bool?
  }

  private struct Order: Decodable { var itemIds: [Int] }
  private struct CoverInput: Decodable {
    var layout: CoverLayout
    var variant: Int
  }

  /// A 204: `NoContent` decodes from it.
  private struct NoBody: Encodable, Sendable {}

  private static let notFound = APIError.server(status: 404, message: "Not found")

  private static func items(_ recordingIds: [String], next: inout Int) throws -> [PlaylistItem] {
    try recordingIds.map { id in
      guard let track = Demo.tracks.first(where: { $0.recordingId == id }) else { throw APIError.server(status: 404, message: "Song \(id) is not in the library") }
      next += 1
      return PlaylistItem(
        itemId: next, recordingId: id, title: track.title, artistName: track.artistName, albumTitle: track.albumTitle,
        addedAt: Demo.when, track: track)
    }
  }

  private static func playlist(id: Int, name: String, description: String, shared: Bool) -> PlaylistDetail {
    PlaylistDetail(
      id: id, name: name, description: description, trackCount: 0, duration: 0,
      cover: PlaylistCoverInfo(
        url: "/art/playlist/\(id)?v=demo", layout: .currents, variant: 0, frozen: true, stale: false, energy: 0.4, styles: [], analyzed: 0,
        total: 0, pending: false),
      updatedAt: Demo.when, owner: Demo.account.name, shared: shared, mine: true, items: [])
  }

  private static func counted(_ playlist: PlaylistDetail) -> PlaylistDetail {
    var playlist = playlist
    playlist.trackCount = playlist.items.count
    playlist.duration = playlist.items.compactMap(\.track).reduce(0) { $0 + $1.duration }
    playlist.cover.total = playlist.items.count
    playlist.cover.analyzed = playlist.items.count
    return playlist
  }

  static func summary(_ playlist: PlaylistDetail) -> PlaylistSummary {
    PlaylistSummary(
      id: playlist.id, name: playlist.name, description: playlist.description, trackCount: playlist.trackCount,
      duration: playlist.duration, cover: playlist.cover, updatedAt: playlist.updatedAt, owner: playlist.owner,
      shared: playlist.shared, mine: playlist.mine)
  }
}
```

In `DemoAPI.swift`:

Replace:

```swift
  private let answers: [String: any Encodable & Sendable]
```

with:

```swift
  private let answers: [String: any Encodable & Sendable]
  /// Favorites and playlists change as on a real server (phase 6).
  private let state = DemoState()
```

Replace:

```swift
    let answer: any Encodable & Sendable
    if endpoint.method == .get, endpoint.path == "/api/search" {
```

with:

```swift
    let answer: any Encodable & Sendable
    if let remembered = try state.answer(endpoint.method, endpoint.path, query: endpoint.query, body: try endpoint.bodyData()) {
      answer = remembered
    } else if endpoint.method == .get, endpoint.path == "/api/search" {
```

**Step 4: Run them to see them pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter "DemoStateTests|DemoAPITests"
```

Expected: `Test run with 5 tests in 2 suites passed`.

**Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Demo/DemoState.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Demo/Demo+Listening.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Demo/DemoAPI.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/DemoStateTests.swift
git commit -F - <<'MSG'
iOS demo: remember favorites and playlists, and answer a mix, its new draw and its save, and listening stats

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 23: UI tests: make a playlist, add songs, reorder them and delete it; a heart shows in Favorites

Against the demo library (`-UITestsDemo`), like phase 4's `BrowseTests`. Two things learnt running them: the songs of a new playlist sit behind the tab bar, and a drag that starts at the screen's bottom edge is the system's go-home gesture (the app leaves), so the test scrolls up first; and the reorder handles (Edit) are what a test can drag reliably.

**Files:**
- Test: `apps/ios/PlayarrUITests/PlaylistsTests.swift`

**Step 1: Write the tests**

`apps/ios/PlayarrUITests/PlaylistsTests.swift`:

```swift
import XCTest

/// Favorites and playlists on the simulator, against the demo library (`-UITestsDemo`: signed in, playing silence; the
/// demo server remembers favorites and playlists while the app runs).
final class PlaylistsTests: XCTestCase {
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

  /// Library → Albums → Mezzanine.
  @MainActor
  private func openMezzanine(_ app: XCUIApplication) {
    app.tabBars.buttons["Library"].tap()
    app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Albums")).firstMatch.tap()
    let mezzanine = app.buttons["Mezzanine, Massive Attack · 1998 · 3 of 5"].firstMatch
    XCTAssertTrue(mezzanine.waitForExistence(timeout: 5))
    mezzanine.tap()
  }

  /// A song's ⋯ → Add to playlist… → the playlist.
  @MainActor
  private func add(_ title: String, to playlist: String, _ app: XCUIApplication) {
    let more = app.buttons["More for \(title)"].firstMatch
    XCTAssertTrue(more.waitForExistence(timeout: 5))
    more.tap()
    app.buttons["Add to playlist…"].tap()
    let choice = app.buttons[playlist].firstMatch
    XCTAssertTrue(choice.waitForExistence(timeout: 5))
    choice.tap()
    XCTAssertTrue(app.staticTexts["Added “\(title)” to “\(playlist)”"].waitForExistence(timeout: 5), app.debugDescription)
  }

  @MainActor
  func testMakeAPlaylistAddSongsReorderThemAndDeleteIt() {
    let app = launch()
    app.tabBars.buttons["Library"].tap()
    let new = app.buttons["library.newPlaylist"]
    XCTAssertTrue(new.waitForExistence(timeout: 10))
    new.tap()
    let name = app.textFields["playlist.name"]
    XCTAssertTrue(name.waitForExistence(timeout: 5))
    name.typeText("Road trip")
    app.buttons["playlist.create"].tap()
    // A playlist made from nothing opens.
    XCTAssertTrue(app.staticTexts["This playlist is empty. Use Add to playlist… from any song’s ⋯ menu, an album, the queue or Now Playing."].waitForExistence(timeout: 5))

    openMezzanine(app)
    add("Angel", to: "Road trip", app)
    add("Risingson", to: "Road trip", app)

    app.tabBars.buttons["Library"].tap()
    app.tabBars.buttons["Library"].tap()  // back to the Library's first page
    let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Road trip")).firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 5))
    row.tap()
    let angel = app.buttons["Angel, Massive Attack, Mezzanine, 6:19"]
    let risingson = app.buttons["Risingson, Massive Attack, Mezzanine, 4:58"]
    XCTAssertTrue(risingson.waitForExistence(timeout: 5))
    XCTAssertLessThan(angel.frame.minY, risingson.frame.minY)

    app.buttons["Edit"].tap()
    // Bring the songs up from behind the tab bar: a drag that starts at the bottom edge goes to the Home Screen.
    app.swipeUp()
    let handle = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@ AND label CONTAINS %@", "Reorder", "Risingson")).firstMatch
    XCTAssertTrue(handle.waitForExistence(timeout: 5), app.debugDescription)
    let above = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@ AND label CONTAINS %@", "Reorder", "Angel")).firstMatch
    // Hold Risingson's handle, then drop it above Angel's row: the list moves it at once and sends the new order.
    handle.press(forDuration: 0.5, thenDragTo: above)
    app.buttons["Done"].tap()
    let moved = NSPredicate { _, _ in risingson.frame.minY < angel.frame.minY }
    XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: moved, object: nil)], timeout: 5), .completed)

    app.buttons["Playlist actions"].tap()
    app.buttons["Delete playlist"].tap()
    let delete = app.buttons["Delete"].firstMatch
    XCTAssertTrue(delete.waitForExistence(timeout: 5))
    delete.tap()
    XCTAssertTrue(app.buttons["library.newPlaylist"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Road trip")).firstMatch.exists)
  }

  @MainActor
  func testAHeartShowsInFavorites() {
    let app = launch()
    openMezzanine(app)
    let heart = app.buttons["Add “Angel” to favorites"]
    XCTAssertTrue(heart.waitForExistence(timeout: 5))
    heart.tap()
    XCTAssertTrue(app.buttons["Remove “Angel” from favorites"].waitForExistence(timeout: 5))
    app.tabBars.buttons["Library"].tap()
    app.tabBars.buttons["Library"].tap()
    let favorites = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Favorites")).firstMatch
    XCTAssertTrue(favorites.waitForExistence(timeout: 5))
    favorites.tap()
    XCTAssertTrue(app.buttons["Angel, Massive Attack, Mezzanine, 6:19"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["Risingson, Massive Attack, Mezzanine, 4:58"].exists)
  }
}
```

**Step 2: Run them on your own simulator**

```bash
make -C apps/ios test-app SIMULATOR="Playarr P6"
```

Expected: `PlaylistsTests` (2 tests), phase 4's `BrowseTests` and phase 2's `LaunchTests` pass: `** TEST SUCCEEDED **`. If one fails on its own, `xcrun simctl io "Playarr P6" screenshot /tmp/fail.png` and `app.debugDescription` (print it before the failing line) show what was on screen; fix the view, not the test's label, unless the label in the test is the one that's wrong.

**Commit**

```bash
git add apps/ios/PlayarrUITests/PlaylistsTests.swift
git commit -F - <<'MSG'
iOS UI tests: make a playlist, add two songs, reorder them, delete it, and heart a song into Favorites

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 24: Everything green, and a walk through on the simulator against the dev server

**Files:** none (fix anything found test-first in the task that owns it, and commit there).

**Step 1: The whole suite**

```bash
make -C apps/ios test SIMULATOR="Playarr P6"
corepack pnpm -C apps/server test
```

Expected: everything passes.

**Step 2: Against the dev server** (with the user's `.env`; the NAS can't be reached from Claude's shell, so ask the user to run the server if it needs the music): build and run the app on "Playarr P6", sign in, and check, in order:

1. Home: Your mixes shows the server's mixes with their colours; a mix opens with "Changes in …"; New mix says "Mixing…" and changes the songs; ⋯ Save as playlist opens the new playlist and toasts "Saved as “…”".
2. A heart on an album's song fills at once, shows in Home's Favorites and Library's count; with the server stopped, a heart goes back with "Couldn't update favorites: …".
3. Library → New playlist → a name → Create opens it. Add songs from an album's ⋯, Now Playing's ⋯ and the Queue's Save as playlist. The cover says "Listening to the songs to draw the cover… n of m" and refines every 4 s until pinned.
4. Tap the cover: six candidates arrive (some take seconds); Shuffle changes them; Use this changes the cover everywhere.
5. Rename and describe by tapping the name; Edit and drag a song; pull to refresh: the order held. Remove a song from its ⋯.
6. Share with everyone; sign in as another account on the same server: the playlist shows "· <owner>" on its card, "Shared by <owner>" on its page, no Edit, no cover tap, no Rename/Delete/Remove, no "Songs like these", and it isn't in that account's Add to playlist. Stop sharing: it's gone for the other account.
7. Delete playlist asks "Delete playlist?" with the web's words, then goes back.
8. Library → Your listening: the four periods and each year; the charts' busiest columns are named and a finger shows any other; Play them plays "Your top songs…" ("Playing from" opens the same period).
9. Change the device's time zone (Settings → General → Date & Time on the simulator): mixes are asked for in the new zone (the server's log shows `tz=`).

---

### Task 25: On the phone, then TestFlight

**Step 1: Upload a build**

```bash
corepack pnpm ios:beta
```

Run it in the background (15 to 45 minutes, mostly Apple processing the build). Expected: the build is processed and added to the "Household" TestFlight group, with "What to test" from the commit messages since the last build.

**Step 2: Checkpoint (user): on the iPhone, from TestFlight**

- [ ] Lock the phone while a song plays: the lock screen's like (in its ⋯ or feedback menu) hearts the song; it shows filled and the heart in Now Playing agrees; pressing again removes it.
- [ ] Hearts on rows and in Now Playing respond at once on mobile data; with Airplane Mode on, a heart goes back with the error toast.
- [ ] Make a playlist from the Queue's Save as playlist, reorder by holding a song and dragging, and by Edit; both stick after closing and reopening the app.
- [ ] The cover picker's six candidates load on mobile data; the chosen cover shows on Home, Library and the page.
- [ ] Made for you covers look like the web's on the same mix (colour and angle); a mix's "Changes in …" counts down.
- [ ] Your listening's charts read with VoiceOver; the year in review card (in December or January) opens that year.
- [ ] Switching accounts shows only the new account's favorites, playlists and mixes.

Stop here until the user confirms the checklist.

---

### Task 26 (coordinator decides): record this phase's names in the conventions

**Files:** `docs/plans/2026-11-03-ios-conventions.md` (only with the coordinator's agreement: phase plans don't edit it on their own here).

Add to the `PlayarrUI` line under "Key types": `AccountSession.favorites` (`FavoritesStore`), `.playlists` (`PlaylistsStore`), `.mixes` (`MixesStore`), `.picking` and `addToPlaylist(_:)`; `Route.listeningRange(StatsRange)`; `Polling.run(clock:interval:refresh:)` in `UI/Support/Polling.swift` (phase 9 uses it instead of its own `Settings/Admin/Support/Polling.swift`); `FakeAPI.queries(_:_:)`/`before(_:)` and `Gate` in the shared test helpers; and the demo server's `DemoState`. Commit with the subject "Conventions: phase 6's stores, route and polling loop" and the `Co-Authored-By` line.

---

## What later phases can rely on

`PlayarrAPI`: `API.Playlists.create(name:description:recordingIds:shared:)`, `API.Playlists.update(id:name:description:shared:)`.

`PlayarrPlayer`: `Player.live(backend:directory:settings:like:)` (`like: (@MainActor (Track) -> Void)?`); `NowPlayingBridge.setLiked(_:)`.

`PlayarrUI` (abridged):

```swift
extension AccountSession {   // stored in phase 4's class
  public let favorites: FavoritesStore; public let playlists: PlaylistsStore; public let mixes: MixesStore
  public var picking: PlaylistPick?
  public func addToPlaylist(_ tracks: [Track])               // the shell's sheet; [] = New playlist
  static func queueToSave(_ queue: QueueState) -> [Track]   // Queue → Save as playlist
  func refreshListening() async
}
@MainActor @Observable public final class FavoritesStore {
  public init(api: any APISending, queries: QueryCache, toasts: ToastCenter)
  public private(set) var tracks: [FavoriteTrack]?, error: String?; public var duration: Double
  public static let source: PlaySource
  public func isFavorite(_ recordingId: String) -> Bool; public func load() async
  public func toggle(_ track: Track) async; public func set(_ track: Track, favorite: Bool) async
}
@MainActor @Observable public final class PlaylistsStore {
  public init(api: any APISending, queries: QueryCache, toasts: ToastCenter, clock: any Clock<Duration> = ContinuousClock())
  public private(set) var playlists: [PlaylistSummary]?, error: String?, pollRound: Int; public var mine: [PlaylistSummary]
  public func load() async; public func poll() async
  public func create(name: String, tracks: [Track] = []) async -> PlaylistDetail?
  public func add(_ tracks: [Track], to id: Int) async -> PlaylistDetail?
  func settled(_ playlist: PlaylistDetail) async; func removed(_ id: Int) async
}
@MainActor @Observable public final class MixesStore {
  public init(api: any APISending, queries: QueryCache, clock: any Clock<Duration> = ContinuousClock(), timeZone: TimeZone = .current)
  public private(set) var mixes: [MixSummary]?, error: String?
  public func load() async; public func poll() async; static func recheck(due: [Date], now: Date) -> Duration
}
public struct PlaylistPick: Identifiable { id: UUID; tracks: [Track] }
public enum PlaylistAction { rename, playNext, addToQueue, newCover, share, stopSharing, delete; label; systemImage }
public enum PlaylistRowAction { playNext, addToQueue, addToPlaylist, goToAlbum, goToArtist, remove; label; systemImage }
// internal: PlaylistModel(id:session:clock:), CoverPickerModel(playlist:), CoverNote(_:), RecommendationsModel(playlist:),
// AddToPlaylistModel(tracks:store:), MixModel(key:session:clock:timeZone:), StatsModel(range:session:), ListeningChart,
// Polling.run(clock:interval:refresh:), CSSGradient.points(angle:width:height:), SessionReference, DemoState
extension Format { static func number(_:locale:), minutes(_:locale:), changes(at:now:locale:timeZone:) }
public enum Route { …, listeningRange(StatsRange) }            // Route(href:) reads ?range=
extension View { func addToPlaylistSheet(_ session: AccountSession) -> some View }
```

Pages: `FavoritesView(session:)`, `PlaylistsView(session:)`, `PlaylistView(id:session:)`, `MixesView(session:)`, `MixView(key:session:)`, `StatsView(range:session:)`. Marked places for later phases: Download on Favorites, a playlist and a mix (phase 7); "Show metadata" in a playlist row's menu and the request button in "Songs like these" (phase 8); "Tune your mixes" on Made for you (phase 9). Tests: `FakeAPI.queries(_:_:)`, `FakeAPI.before(_:)`, `Gate`, and the `Listening` fixtures.

## Verified while writing (2026-11-03)

- **Replayed task by task on `main` at `8e22d1d`.** The generator for this plan copied `apps/ios` from `main` and applied every task's files and edits in order. After each task it ran the command the task names (`swift test --filter …` for the suite the task adds, `swift build` for view-only tasks). Every task built and passed. Every Replace block's anchor appeared exactly once.
- **After the last task:**
  - `swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI`: 160 tests in 37 suites passed.
  - PlayarrPlayer: 157 tests in 29 suites passed, with phase 5's code on `main`.
  - PlayarrAPI: 72 tests in 13 suites passed.
  - The iOS 26 simulator build of PlayarrUI had no errors or warnings.
- **The app's UI tests ran in Xcode on a separate simulator** ("Playarr P6", iPhone 17 Pro, with this plan's code):
  - `PlaylistsTests` passed, both tests;
  - `LaunchTests` passed;
  - `BrowseTests` passed 3 of 4. `testTheQueueClearsWithUndo` fails the same way with phase 4's own `QueueView` and no phase 6 code. That's a phase 4 problem, not this plan's.
  - xcodebuild ran with `OTHER_SWIFT_FLAGS="-Xfrontend -disable-sandbox"`, because Claude's shell can't start the macro sandbox.
- **Not verified here:**
  - the dev server walkthrough (Task 24): the NAS can't be reached from Claude's shell;
  - the lock screen's like command and everything on the phone (Task 25).
