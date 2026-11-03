# Native iOS app, Phase 7: Offline Downloads Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Listening with no connection. Albums, playlists, mixes and Favorites download to the phone on the background session (they go on with the app closed, resume after a lost connection or a force-quit, and use mobile data only when allowed), with the DJ transitions between their songs. Songs kept as you listen stay within a limit (Off, 512 MB, 1, 2, 5, 10 GB; 2 GB by default), least recently played dropped first; downloads are pinned outside it. Offline, kept songs and kept transitions play from disk, songs not kept are skipped with the web's toast, and play reports wait. Library → Downloads, the Download buttons, the offline mark on songs and Settings → Playback → On this device work as on the web.

**Architecture:** One folder of song files per server and account (phase 3's `stream/`), one book-keeper. `StreamCache` (phase 3) keeps fetching songs for playback and keep-ahead, but hands its books to `DownloadStore` (new, `@MainActor @Observable`, in `PlayarrPlayer`), which owns the manifest `offline.json` (file, bytes, last used for every whole file; downloads and their transitions and levels), applies the limit, protects what's playing and fetched ahead, and fetches downloads' songs one at a time through a `DownloadTransport`: in the app, `URLSessionTransport.background`, a background `URLSession` whose job names are the files' paths, so a file lands in the right account's folder even after a relaunch. `TransitionPoller` asks `POST /api/transitions` until a pair is rendered (3 s ×5, then 10 s, give up after 10 minutes). The `Player` keeps ahead with `KeepAhead` (the web's `loadAhead`: 3 songs on Wi-Fi, 1 on mobile data, none in Low Data Mode), and offline skips to the next kept song (`OfflinePlayback`). `TrackSource` needs no change: a kept song is a whole file in the stream cache, which it already decodes from disk without the network. `PlayarrUI` gets `DownloadButton`, `OfflineMark`, `DownloadsView` and `OfflineStorageSection`; the app target gets an `AppDelegate` for `handleEventsForBackgroundURLSession`.

**Tech Stack:** Swift 6.4 (Xcode 27.2), Swift 6 language mode with strict concurrency, Foundation (`URLSession` background download tasks, `URLResourceValues.isExcludedFromBackup`, `volumeAvailableCapacityForImportantUsage`), Observation (`Observations`), Synchronization (`Mutex`), Network (`NWPathMonitor`, phase 3's), SwiftUI, UIKit (app delegate only), Swift Testing, XCUITest. No third-party packages.

**Design:** [2026-11-03-ios-app-design.md](2026-11-03-ios-app-design.md), section 4 ("Offline and downloads"). Names and layout: [2026-11-03-ios-conventions.md](2026-11-03-ios-conventions.md). Rules to port: [2026-11-03-ios-parity-inventory.md](2026-11-03-ios-parity-inventory.md), section 4 ("Offline downloads", "Prefetch of next songs", "Stream error handling") and section 2 (Playback → On this device). Web code ported: `apps/web/src/player/offline.ts`, `downloads.ts`, `loadAhead.ts`, `transitions.ts` (kept transitions offline), `AudioEngine.tsx` (`skipToKept`), `components/DownloadButton.tsx`, `OfflineMark.tsx`, `OfflineStorage.tsx`, `pages/Downloads.tsx`, `sw.ts` (what it answers from disk).

---

## Key decisions

**1. One folder of songs, one book-keeper.** On the web, songs kept as you listen and songs of downloads are one Cache Storage bucket with one manifest (`useOffline.songs`); the service worker answers `/stream/` from it. Here the same: every whole song file of an account is `stream/<fileId>.<ext>` (phase 3's names), whoever fetched it, and `offline.json` lists them with size and last use. `StreamCache` stays the fetcher for playback and keep-ahead and tells the store about each whole file and each play (`keepBooks(with:)`); its own 1 GB limit is off from then on, and the store decides what goes (`StreamCache.remove(_:)`). So a song played before is adopted by a download instead of fetched twice, a download's song plays through `TrackSource`'s existing "whole file in the cache → `FileDecoder`" path with no network, and there's one limit. Transition files, only ever kept for downloads, are in `offline/transitions/` under the server's names (content keys).

**2. `PinnedDownload`, not `Download`.** The web calls an album/playlist/mix/Favorites on the device a `Download`; phase 3 already uses `Download` for one HTTP file fetch. The collection is `PinnedDownload` (pinned: outside the limit), with the web's keys (`album:12`, `playlist:3`, `mix:discovery`, `favorites`).

**3. One background session, one song at a time.** `URLSessionTransport.background` (identifier `me.tracklistme.playarr.downloads`) is made at launch by the app delegate, so a relaunch for finished downloads reconnects to it; the delegate's completion handler runs once the session has handed over its events. A job's id (`taskDescription`) is its file's path from `Application Support/Playarr/` (`<serverId>/<accountId>/stream/12.flac`): the delegate moves the file there before returning (URLSession deletes it after), whichever account is active by then, and the store of that account adopts it when it next opens. As the web's `pump`, the store starts one song at a time in the foreground. Tasks created while the app is in the background are treated as discretionary by iOS (they may wait for power and Wi-Fi), so when the app resigns active the store hands the system up to 25 more at once; `httpMaximumConnectionsPerHost = 1` keeps them one at a time on the wire. Transitions are asked for only in the foreground (asking means polling the server).

**4. Resuming.** A background session waits for a connection by itself. A task the system stopped (the app force-quit from the switcher, or a connection that failed for good) ends with resume data, which the store keeps in `offline/resume/` and passes to the next try, after the next launch too. The store never marks a song failed for a cancel it didn't ask for.

**5. Mobile data per request.** "Allow downloads on mobile data" (off by default) sets `allowsCellularAccess` and `allowsExpensiveNetworkAccess` (personal hotspots count as mobile data) on each request, so changing it needs no new session; the song under way starts again under the new rule. Low Data Mode doesn't block a download the user asked for (it does stop keep-ahead, as data saver does on the web).

**6. Keep-ahead is phase 3's prefetch, made the web's.** Phase 3 already fetches 3 songs ahead on Wi-Fi and 1 on mobile data through `StreamCache.prefetch`. That stays the one mechanism; `KeepAhead.plan` adds the web's rules on top (the current song kept too on Wi-Fi, repeat one first, nothing with the limit Off), the 2.5 s settle before planning, and a replan when the network changes. What plays now and next is always protected from eviction and from `keepOnly` (phase 3 cancelled the cued next song's download on networks with no keep-ahead: fixed here).

**7. Offline playback.** Offline, the `Player` doesn't join a song that isn't kept, and on loading one it moves to the next kept song with the web's toast "Offline: skipped songs that aren’t on this device"; a song breaking off while offline does the same (the web's `skipToKept`). With nothing kept ahead it tries the song and fails in the web's words, as phase 3 does. `PlayReportQueue` keeps reports on disk while offline and sends them when the network comes back (`Player.networkChanged`).

**8. Transitions with downloads.** Only while transitions are DJ mix, in Auto mode, after the download's songs, one pair at a time, asked as the player will ask (no position, the file ids, the fade, whether it plays the album) so both get the same plan and file. With even volume on, the ask carries the gains the phone plays the two songs at (album gain within an album in order), as the player does: a transition must be levelled like its songs. The store records whether a kept transition is levelled, and the player only uses one that matches how it plays the pair. A download also keeps its songs' levels (`/api/levels`), so offline its songs play levelled; the web can't level offline on phones, the app applies gains itself. Pairs the player is asking about are left to the player (the server keeps one waiting render per song). Another download's copy of the pair is shared, not fetched again; files go with the last download that has them.

**9. Per server and account.** Everything is in the account's folder (`OfflineFolder.of(key)`, the same as phase 4's `AccountSession.folder(for:)`). Phase 4 makes one `Player` per account session, and with it one store; the newest store takes the background session's events, while jobs of an account switched away from carry on and land in its folder by their path, adopted when that account is active again (phase 4's `Player.shutDown()` needs nothing more). Downloads of the active account are the only ones started. Signing out asks whether to remove the account's downloads.

**10. Room.** Before a download starts, the button checks `volumeAvailableCapacityForImportantUsage` (space iOS would free for it counts), plus the songs kept as you listen (they'd make way), minus 256 MB kept free; short, it says so with the sizes. While fetching, songs kept as you listen make room least recently played first; when that isn't enough the song fails with "Not enough space on this device" and the web's toast is shown once.

**11. Not ported.** `navigator.storage.persist()` (iOS never clears Application Support; the folders are excluded from backups instead), the "needs HTTPS" texts and `workerReady()` (no service worker: `TrackSource` reads the files), the web's `generation` counter (jobs stopped on purpose are remembered, and a file that still arrives for one is dropped).

**12. Checked before writing.** All the `PlayarrPlayer` code below was compiled under Swift 6 strict concurrency for macOS 26 and the iOS 26 Simulator, on top of phase 3's code extracted from its plan (with Task 15's edits applied) and stand-ins for phase 2's models carrying the phase 2 plan's names (`Track`, `TrackLevel`, `TransitionAnswer.Ready`, `TransitionPlan`, `TransitionRequest`, `MediaURLs`, `APIClient`). Phase 3's 98 extracted tests and this phase's 63 passed together in repeated runs. `URLSessionTransport` was run end to end with download tasks through phase 3's `StubServer`. The `PlayarrUI` code compiled for macOS and the iOS Simulator and its tests passed; the app delegate and the Downloads UI test were built into a copy of the app target and the XCUITest passed on the iPhone 17 Pro simulator. Not compiled: the edits to phase 4, 5 and 6 code (Task 13 step 5, Tasks 16 and 17's edits to phase 4 files, Task 18's to phase 2's `AccountSwitcherView`). Phase 4's plan appeared while this one was being written and Tasks 16 and 17 use its names; phases 5 and 6 weren't written, so their names are assumed and the tasks say what to adapt.

---

## Conventions

- Run everything from the repo root, `/Users/bortignon/dev/playarr`.
- The player's tests: `swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer` (one suite: add `--filter DownloadStoreTests`). The UI package: `--package-path apps/ios/Packages/PlayarrUI`. `--disable-sandbox` because SwiftPM's own sandbox can't start inside Claude's shell; the Makefile passes it too. Everything: `make -C apps/ios test` (`corepack pnpm ios:test`).
- An iOS Simulator build of a package: `swift build --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --triple arm64-apple-ios26.0-simulator --sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" --scratch-path /tmp/playarr-player-ios` (same for `PlayarrUI`, scratch path `/tmp/playarr-ui-ios`).
- Swift: 2-space indentation like phases 0 and 3; one primary type per file, named after it; no force unwraps outside tests; Swift Testing in packages, XCUITest for UI tests; user-facing text in the web's words ("this device" where the web says the browser).
- Edits to existing files are given as replacements: each `old` text appears once in the file.
- Commit after every task, on `main`, only that task's files, with the message given (plain English, no prefixes, ending with a blank line and the `Co-Authored-By` line). The pre-commit hook bumps the version: never bypass it. The user pushes.

## Before you start

Phases 2 and 3 must have landed; phases 4, 5 and 6 should have (they're planned in parallel with this one). This plan uses:

- **Phase 2** (`docs/plans/2026-11-03-ios-phase2-api-sign-in.md`): the generated models `Track` (`id`, `recordingId`, `fileId`, `albumId`, `artistId`, `size`, `format.container`, `streamUrl`, `coverUrl`), `TrackLevel`, `MixMode`, `TransitionAnswer` (`.ready(TransitionAnswer.Ready)` with `plan`, `url`, `continuationUrl`, `tail`, `lead`, `levels: TransitionAnswer.Ready.Levels?`; `.pending`, `.straight`, `.unavailable(reason:)`, `.unknown`), `TransitionPlan` (memberwise init with every field), `AutomationItem`, `AlbumDetail`, `PlaylistDetail` (`items[].track`, `cover.url`), `MixDetail` (`key`, `title`, `covers`, `tracks`); `API.Playback.transition(_:)`, `TransitionRequest`, `MediaURLs.transition(_:)`, `.request(for:)`, `AccountKey` (`serverId`, `accountId`), `ServerStore.signOut(_:)`, `AccountRecord`, and phase 2's `AccountSwitcherView`.
- **Phase 3** (`docs/plans/2026-11-03-ios-phase3-audio-engine.md`): `StreamCache`, `Download`, `TrackSource`, `PlaybackError.serverMessage`, `PlaybackSettings` (`transitions`, `crossfade`, `levelVolume`), `LevelStore` (`batchSize`, `levels`), `JoinRules.levelDb`, `QueueState`, `JSONFile`, `NetworkKind`, `PrefetchPolicy`, `NetworkMonitor`, `PlayReportQueue`, `PlayerBackend`/`APIBackend`, `Player` (with `Notice`, `play(_:startAt:source:shuffle:at:)`), `Player.live`, and its test support `StubServer`, `temporaryDirectory()`, `song(_:)`, `FakeBackend`, `Player.testing`, `eventually`, `AudioFiles`, `Signals`, `SignalSource`.
- **Phase 4** (`docs/plans/2026-11-03-ios-phase4-browse-now-playing.md`): `AccountSession` (in the environment of every page: `player`, `queries`, `router`, `toasts`; made by `AccountSession.live` with `Player.live(backend:directory:settings:)` in `AccountSession.folder(for:)`, the same folder as `OfflineFolder.of(key).root`), `QueryKey` (`name`, `parts`, `isKept`) and `QueryCache` (`cached`, `set`, `removeExpired`, `QueryDisk.removeOlder(than:)`), `Route` and `Route(href:)`, `RouteDestination`, `AppRouter.open(_:)`, `LibraryView` (its `row(_:_:_:detail:)`), `AlbumView`'s `// Phase 7: Download.` marker, `TrackRow`, `QueueView`, `NowPlayingView`, `PlaybackPanel` and `SettingsPanelView`, `Cover(path:points:label:)`, `Format.plural`, and the root view forwarding `session.player.notice` to `ToastCenter`.
- **Phase 5** (assumed; Task 0 checks): a `TransitionPlanner` in `PlayarrPlayer` that asks `POST /api/transitions` for the current pair and downloads the ready answer's files before scheduling them. If phase 5 added `transition(_:)` and `transitionRequest(_:)` to `PlayerBackend` already, Task 6 skips that part.
- **Phase 6** (assumed names, its plan wasn't written yet): the Favorites, Playlist and Mix pages (`RouteDestination`'s `.favorites`, `.playlist`, `.mix`) with their Play and Shuffle buttons.

If phase 5 or 6 named something differently, the tasks that touch their code (13, 16) say what to adapt; nothing else depends on those names.

---

### Task 0: Check the starting point

**Files:** none.

**Step 1: Phase 2 and 3's names are there**

```bash
grep -n "public static func transition" apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/Endpoints/API+Playback.swift
grep -n "public func transition(\|public func request(for" apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/MediaURLs.swift
grep -n "public enum TransitionAnswer\|public struct TransitionPlan\|public struct TrackLevel" apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/Models.generated.swift
grep -n "public actor StreamCache\|private func finished()" apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/StreamCache.swift
grep -n "private func prefetch()\|public init(" apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Player.swift
```

Expected: each grep prints its lines. If one is missing, phase 2 or 3 isn't done: stop and say so.

**Step 2: Phase 4, 5 and 6's names**

```bash
grep -n "public let player: Player\|public let queries: QueryCache\|public static func folder(for" apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/AccountSession.swift
grep -rn "// Phase 7: Download" apps/ios/Packages/PlayarrUI/Sources
grep -rn "func removeOlder(than\|public var isKept" apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Data
grep -rln "TransitionPlanner" apps/ios/Packages/PlayarrPlayer/Sources
grep -n "func transition(\|func transitionRequest(" apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PlayerBackend.swift
grep -rn "case .favorites\|case .playlist\|case .mix" apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/RouteDestination.swift
```

Note what each prints (phase 4's files may sit in other folders: `grep -rln` for the name then). The fifth grep printing two lines means phase 5 already added the backend calls: skip that part of Task 6. The last shows whether phase 6's pages replaced phase 4's placeholders (Task 16 puts the Download button on them).

**Step 3: The packages build and test**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI
```

Expected: both pass. Note the player package's test count (phase 3's 101 plus what phases 4 to 6 added): this phase adds 63.

### Task 1: The limits and the two settings

The web's limits in its words, and two per-device settings in `PlaybackSettings`: "keep up to" (2 GB by default) and "Allow downloads on mobile data" (off).

**Files:**
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/OfflineLimit.swift`
- Modify: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PlaybackSettings.swift`
- Test: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/OfflineLimitTests.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/OfflineLimitTests.swift`:

```swift
import Foundation
import Testing
@testable import PlayarrPlayer

@MainActor
struct OfflineLimitTests {
  @Test func offersTheWebsLimitsInItsWords() {
    #expect(OfflineLimit.options.map(OfflineLimit.label) == ["Off", "512 MB", "1 GB", "2 GB", "5 GB", "10 GB"])
    #expect(ByteCount.format(1_610_612_736) == "1.5 GB")
    #expect(ByteCount.format(12 * OfflineLimit.gigabyte + 300 * OfflineLimit.megabyte) == "12 GB")
    #expect(ByteCount.format(40 * OfflineLimit.megabyte) == "40 MB")
    #expect(ByteCount.format(0) == "0 MB")
  }

  @Test func keepsTwoGigabytesAndNoMobileDataUntilPicked() {
    let defaults = UserDefaults(suiteName: UUID().uuidString)!
    let settings = PlaybackSettings(defaults: defaults)
    #expect(settings.offlineLimit == 2 * OfflineLimit.gigabyte)
    #expect(!settings.cellularDownloads)
    settings.offlineLimit = 0
    settings.cellularDownloads = true
    let again = PlaybackSettings(defaults: defaults)
    #expect(again.offlineLimit == 0)
    #expect(again.cellularDownloads)
    defaults.set(Int64(123), forKey: "playback.offlineLimit")
    #expect(PlaybackSettings(defaults: defaults).offlineLimit == OfflineLimit.defaultLimit)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter OfflineLimitTests
```

Expected: the build fails with `cannot find 'OfflineLimit' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/OfflineLimit.swift`:

```swift
import Foundation

/// How much room songs kept as you listen may take on this device (Settings → Playback → On this device), as
/// `OFFLINE_LIMITS` in apps/web/src/player/offline.ts. Downloads (albums, playlists, mixes, Favorites) don't count.
public enum OfflineLimit {
  public static let megabyte: Int64 = 1 << 20
  public static let gigabyte: Int64 = 1 << 30
  /// The limits on offer; 0 turns keeping songs off.
  public static let options: [Int64] = [0, 512 * megabyte, gigabyte, 2 * gigabyte, 5 * gigabyte, 10 * gigabyte]
  public static let defaultLimit: Int64 = 2 * gigabyte

  /// "Off", "512 MB", "2 GB".
  public static func label(_ limit: Int64) -> String { limit == 0 ? "Off" : ByteCount.format(limit) }
}

/// Sizes in the web's words (`formatBytes` in apps/web/src/lib/format.ts): "640 MB", "1.5 GB", "12 GB".
public enum ByteCount {
  public static func format(_ bytes: Int64) -> String {
    let gb = Double(bytes) / Double(OfflineLimit.gigabyte)
    if gb >= 1 {
      return gb >= 10 || gb == gb.rounded() ? "\(Int(gb.rounded())) GB" : String(format: "%.1f GB", gb)
    }
    return "\(Int((Double(bytes) / Double(OfflineLimit.megabyte)).rounded())) MB"
  }
}
```

Make these replacements in `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PlaybackSettings.swift` (each `old` appears once).

1. The two settings:

   Replace:

```swift
  public var recordPlays: Bool { didSet { defaults.set(recordPlays, forKey: Key.recordPlays) } }
```

   with:

```swift
  public var recordPlays: Bool { didSet { defaults.set(recordPlays, forKey: Key.recordPlays) } }
  /// "On this device: keep up to": room for songs kept as you listen, in bytes (0 = Off). See `OfflineLimit`.
  public var offlineLimit: Int64 { didSet { defaults.set(offlineLimit, forKey: Key.offlineLimit) } }
  /// "Allow downloads on mobile data" (and personal hotspots). Off: downloads wait for Wi-Fi.
  public var cellularDownloads: Bool { didSet { defaults.set(cellularDownloads, forKey: Key.cellularDownloads) } }
```

2. Their keys:

   Replace:

```swift
    static let recordPlays = "playback.recordPlays"
```

   with:

```swift
    static let recordPlays = "playback.recordPlays"
    static let offlineLimit = "playback.offlineLimit"
    static let cellularDownloads = "playback.cellularDownloads"
```

3. Reading them back (a limit not on offer goes back to the default):

   Replace:

```swift
    recordPlays = defaults.object(forKey: Key.recordPlays) as? Bool ?? true
```

   with:

```swift
    recordPlays = defaults.object(forKey: Key.recordPlays) as? Bool ?? true
    let limit = (defaults.object(forKey: Key.offlineLimit) as? NSNumber)?.int64Value
    offlineLimit = limit.flatMap { OfflineLimit.options.contains($0) ? $0 : nil } ?? OfflineLimit.defaultLimit
    cellularDownloads = defaults.object(forKey: Key.cellularDownloads) as? Bool ?? false
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter OfflineLimitTests
```

Expected: `Test run with 2 tests` … `passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/OfflineLimit.swift \
  apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PlaybackSettings.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/OfflineLimitTests.swift
git commit -F - <<'EOF'
Offer the web's limits for songs kept on the phone, and a switch for downloads on mobile data

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

### Task 2: The manifest and its rules

What `offline.json` holds, and the rules of `offline.ts` and `downloads.ts` that need no I/O: what's pinned, what makes room (least recently used first, never what's protected), how far a download is, what to fetch next. The tests are the web's (`offline.test.ts`), ported.

**Files:**
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/KeptFile.swift`
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/KeptTransition.swift`
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PinnedDownload.swift`
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/OfflineManifest.swift`
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/OfflineRules.swift`
- Test: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/OfflineRulesTests.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/OfflineRulesTests.swift` (its `kept`, `longPlan` and `ready` helpers are used by later tests too):

```swift
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrPlayer

/// A kept song's record: `bytes` long, last used `usedAt` seconds into 2001.
func kept(_ bytes: Int64, usedAt: TimeInterval = 0, file: String = "stream/x.flac") -> KeptFile {
  KeptFile(file: file, bytes: bytes, usedAt: Date(timeIntervalSinceReferenceDate: usedAt))
}

/// A long blend starting 170 s into A, as the server plans one.
let longPlan = TransitionPlan(
  style: .long, aStart: 170, bStart: 8, length: 24, bResume: 32, switchAt: 12, bRate: [], aGain: [], bGain: [], aLowDb: [],
  bLowDb: [], aHighPassHz: [], reason: "phrase", beats: 32)

/// A ready transition answer from `from` to `to`, with B's remainder when `rest`.
func ready(_ from: Int, _ to: Int, rest: Bool = false) -> TransitionAnswer.Ready {
  TransitionAnswer.Ready(
    plan: longPlan, url: "/transitions/\(from)-\(to).flac", continuationUrl: rest ? "/transitions/\(from)-\(to).rest.flac" : nil,
    tail: 3, lead: 3)
}

struct OfflineRulesTests {
  let songs: [Int: KeptFile] = [1: kept(400, usedAt: 30), 2: kept(400, usedAt: 10), 3: kept(400, usedAt: 20)]

  @Test func dropsTheLeastRecentlyUsedUntilTheNewSongFits() {
    #expect(OfflineRules.evictions(songs, need: 100, limit: 2000) == [])
    #expect(OfflineRules.evictions(songs, need: 500, limit: 1500) == [2])
    #expect(OfflineRules.evictions(songs, need: 900, limit: 1500) == [2, 3])
  }

  @Test func neverDropsProtectedSongsAndGivesUpWhenItCannotFit() {
    #expect(OfflineRules.evictions(songs, need: 500, limit: 1500, protect: [2]) == [3])
    #expect(OfflineRules.evictions(songs, need: 1000, limit: 1500, protect: [1, 3]) == nil)
    #expect(OfflineRules.evictions([:], need: 2000, limit: 1500) == nil)
    #expect(OfflineRules.freeUp(songs, bytes: 500) == [2, 3])
    #expect(OfflineRules.freeUp(songs, bytes: 500, protect: [3]) == [2, 1])
    #expect(OfflineRules.freeUp(songs, bytes: 5000) == nil)
  }

  @Test func downloadsSongsAreOutsideTheLimit() {
    let album = PinnedDownload(key: "album:1", title: "Dummy", href: "/albums/1", tracks: [song(1), song(2)])
    #expect(OfflineRules.unpinned(songs, pins: ["album:1": album]).keys.sorted() == [3])
    var withTransition = album
    withTransition.transitions[OfflineRules.pair(1, 2, .auto)] = KeptTransition(answer: ready(1, 2, rest: true), levelled: true)
    #expect(OfflineRules.pinnedTransitionFiles(["album:1": withTransition]) == ["1-2.flac", "1-2.rest.flac"])
  }

  @Test func countsADownloadsProgressWithItsTransitions() {
    var album = PinnedDownload(key: "album:1", title: "Dummy", href: "/albums/1", tracks: [song(1), song(2), song(9)])
    album.transitions["1-2-auto"] = KeptTransition(answer: ready(1, 2), levelled: false)
    let manifest = OfflineManifest(songs: songs, transitionFiles: ["1-2.flac": kept(50)], pins: ["album:1": album])
    #expect(OfflineRules.progress(of: album, in: manifest) == DownloadProgress(done: 2, total: 3, bytes: 850))
  }

  @Test func fetchesDownloadsInTheOrderTheyWereAddedSkippingWhatFailed() {
    let pins = [
      "b": PinnedDownload(key: "b", title: "B", href: "/b", tracks: [song(8)], addedAt: Date(timeIntervalSinceReferenceDate: 2)),
      "a": PinnedDownload(key: "a", title: "A", href: "/a", tracks: [song(1), song(2)], addedAt: Date(timeIntervalSinceReferenceDate: 1)),
    ]
    #expect(OfflineRules.nextToDownload(pins, songs: [:])?.fileId == 1)
    #expect(OfflineRules.nextToDownload(pins, songs: [1: kept(1)], skip: [2])?.fileId == 8)
    #expect(OfflineRules.nextToDownload(pins, songs: [1: kept(1), 2: kept(1), 8: kept(1)]) == nil)
  }

  @Test func asksForEachPairInSongOrderOnceBothSongsAreHere() {
    let album = PinnedDownload(key: "album:1", title: "Dummy", href: "/albums/1", tracks: [song(4), song(5), song(6)])
    var m = OfflineManifest(songs: [4: kept(1), 5: kept(1)], pins: ["album:1": album])
    #expect(OfflineRules.nextTransition(m.pins, manifest: m).map { [$0.from.fileId, $0.to.fileId] } == [4, 5])
    #expect(OfflineRules.nextTransition(m.pins, manifest: m, skipped: ["4-5-auto"]) == nil)  // 6 isn't here yet
    m.songs[6] = kept(1)
    m.pins["album:1"]?.transitions["4-5-auto"] = KeptTransition(answer: ready(4, 5), levelled: false)
    m.transitionFiles["4-5.flac"] = kept(1)
    #expect(OfflineRules.nextTransition(m.pins, manifest: m).map { [$0.from.fileId, $0.to.fileId] } == [5, 6])
    // The player is asking about song 5 into another song: that pair waits.
    #expect(OfflineRules.nextTransition(m.pins, manifest: m, busy: { from, _ in from.fileId == 5 }) == nil)
  }

  @Test func namesTransitionFilesByTheServersContentKeys() {
    #expect(KeptTransition.fileName("/transitions/abc.flac") == "abc.flac")
    #expect(KeptTransition.fileName("/transitions/abc.rest.flac?v=2") == "abc.rest.flac")
    #expect(OfflineRules.pairs(of: [song(1), song(2), song(3)], mode: .auto) == ["1-2-auto", "2-3-auto"])
    #expect(OfflineRules.playsAlbum("/albums/1", song(3)))
    #expect(!OfflineRules.playsAlbum("/playlists/1", song(3)))
  }

  @Test func theManifestGoesToDiskAndBack() throws {
    var album = PinnedDownload(key: "album:1", title: "Dummy", href: "/albums/1", tracks: [song(1)], levels: ["rec-1": TrackLevel(track: -3)])
    album.transitions["1-2-auto"] = KeptTransition(answer: ready(1, 2), levelled: true)
    let manifest = OfflineManifest(songs: [1: kept(10)], transitionFiles: ["1-2.flac": kept(5)], pins: ["album:1": album])
    let file = JSONFile<OfflineManifest>(temporaryDirectory().appending(path: "offline.json"))
    file.write(manifest)
    #expect(file.read() == manifest)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter OfflineRulesTests
```

Expected: the build fails with `cannot find 'KeptFile' in scope` (and the other new types).

**Step 3: Implement**

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/KeptFile.swift`:

```swift
import Foundation

/// A file kept on this device: where it is in the account's folder, its size, and when it was last played or
/// downloaded (the least recently used make room first), as `KeptSong` in apps/web/src/player/offline.ts.
public struct KeptFile: Codable, Sendable, Equatable {
  /// Relative to the account's folder: `stream/12.flac`, `offline/transitions/ab12….flac`.
  public var file: String
  public var bytes: Int64
  public var usedAt: Date

  public init(file: String, bytes: Int64, usedAt: Date) {
    self.file = file
    self.bytes = bytes
    self.usedAt = usedAt
  }
}
```

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/KeptTransition.swift`:

```swift
import Foundation
import PlayarrAPI

/// A rendered DJ transition kept with a download, so the pair mixes offline: the server's ready answer (plan, files,
/// lead and tail) and whether it was asked at the gains even volume plays the two songs at.
public struct KeptTransition: Codable, Sendable, Equatable {
  public var answer: TransitionAnswer.Ready
  public var levelled: Bool

  public init(answer: TransitionAnswer.Ready, levelled: Bool) {
    self.answer = answer
    self.levelled = levelled
  }

  /// The server paths of its files: the transition, and B's remainder when it has one.
  public var urls: [String] { [answer.url] + (answer.continuationUrl.map { [$0] } ?? []) }

  /// Its files' names on this device, in `offline/transitions/`.
  public var fileNames: [String] { urls.map(Self.fileName) }

  /// "/transitions/ab12.flac" → "ab12.flac". The server's names are content keys (another plan, file or gain makes
  /// another name), so one name is one rendering wherever it's used.
  public static func fileName(_ url: String) -> String {
    let path = url.split(separator: "?", maxSplits: 1).first.map(String.init) ?? url
    return path.split(separator: "/").last.map(String.init) ?? path
  }
}
```

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PinnedDownload.swift`:

```swift
import Foundation
import PlayarrAPI

/// An album, playlist, mix or Favorites downloaded to this device, as `Download` in apps/web/src/player/offline.ts
/// (renamed: `Download` is phase 3's one-file fetch). Its songs stay until it's removed, and don't count towards the
/// limit for songs kept as you listen.
public struct PinnedDownload: Codable, Sendable, Equatable, Identifiable {
  /// "album:12", "playlist:3", "mix:discovery", "favorites": see `Key`.
  public var key: String
  public var title: String
  public var subtitle: String?
  /// The server path of its cover.
  public var coverUrl: String?
  /// Where it lives in the app: "/albums/12".
  public var href: String
  /// Its songs as of the last visit: what's downloaded, and what plays offline.
  public var tracks: [Track]
  public var addedAt: Date
  /// The DJ transitions between its songs, by `OfflineRules.pair`, kept so the download mixes offline too.
  public var transitions: [String: KeptTransition]
  /// Even volume for its songs, by recording id, so they play levelled without a connection.
  public var levels: [String: TrackLevel]

  public var id: String { key }

  public init(
    key: String, title: String, subtitle: String? = nil, coverUrl: String? = nil, href: String, tracks: [Track],
    addedAt: Date = Date(), transitions: [String: KeptTransition] = [:], levels: [String: TrackLevel] = [:]
  ) {
    self.key = key
    self.title = title
    self.subtitle = subtitle
    self.coverUrl = coverUrl
    self.href = href
    self.tracks = tracks
    self.addedAt = addedAt
    self.transitions = transitions
    self.levels = levels
  }

  /// The keys the web uses, so a download means the same thing on both.
  public enum Key {
    public static func album(_ id: Int) -> String { "album:\(id)" }
    public static func playlist(_ id: Int) -> String { "playlist:\(id)" }
    public static func mix(_ key: String) -> String { "mix:\(key)" }
    public static let favorites = "favorites"
  }
}
```

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/OfflineManifest.swift`:

```swift
import Foundation

/// What one server and account keeps on this device, saved as `offline.json` in its folder (the web's persisted
/// `useOffline` state, without the limit: that's a device setting, `PlaybackSettings.offlineLimit`).
public struct OfflineManifest: Codable, Sendable, Equatable {
  /// Songs' whole files in `stream/`, by file id: kept as you listen (within the limit) or for downloads.
  public var songs: [Int: KeptFile] = [:]
  /// Transition files in `offline/transitions/`, by name: only ever kept for downloads.
  public var transitionFiles: [String: KeptFile] = [:]
  /// Downloads, by key.
  public var pins: [String: PinnedDownload] = [:]

  public init(songs: [Int: KeptFile] = [:], transitionFiles: [String: KeptFile] = [:], pins: [String: PinnedDownload] = [:]) {
    self.songs = songs
    self.transitionFiles = transitionFiles
    self.pins = pins
  }
}
```

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/OfflineRules.swift`:

```swift
import Foundation
import PlayarrAPI

/// How far along a download is; its bytes count its transitions too.
public struct DownloadProgress: Sendable, Equatable {
  public var done: Int
  public var total: Int
  public var bytes: Int64
  public var isComplete: Bool { done == total }
  public init(done: Int, total: Int, bytes: Int64) {
    self.done = done
    self.total = total
    self.bytes = bytes
  }
}

/// The rules of apps/web/src/player/offline.ts and downloads.ts that need no I/O: what's pinned, what makes room,
/// what to fetch next. `DownloadStore` does the rest.
public enum OfflineRules {
  public static let noRoom = "Not enough space on this device"

  /// Downloads keep the transitions the player asks for by default: a queue's mix mode starts out Auto.
  public static let transitionMode: MixMode = .auto

  /// How a transition is known in a download: the two files and the mix mode, like the server's own pair.
  public static func pair(_ fromFileId: Int, _ toFileId: Int, _ mode: MixMode) -> String { "\(fromFileId)-\(toFileId)-\(mode.rawValue)" }

  /// The pairs a song order plays, back to back.
  public static func pairs(of tracks: [Track], mode: MixMode) -> Set<String> {
    Set(zip(tracks, tracks.dropFirst()).map { pair($0.fileId, $1.fileId, mode) })
  }

  /// The songs of every download.
  public static func pinnedSongs(_ pins: [String: PinnedDownload]) -> Set<Int> {
    Set(pins.values.flatMap { $0.tracks.map(\.fileId) })
  }

  /// The transition files of every download.
  public static func pinnedTransitionFiles(_ pins: [String: PinnedDownload]) -> Set<String> {
    Set(pins.values.flatMap { $0.transitions.values.flatMap(\.fileNames) })
  }

  public static func bytes(_ files: some Sequence<KeptFile>) -> Int64 { files.reduce(0) { $0 + $1.bytes } }

  /// Songs kept as you listen: those in no download. Only these count towards the limit and make room.
  public static func unpinned(_ songs: [Int: KeptFile], pins: [String: PinnedDownload]) -> [Int: KeptFile] {
    let pinned = pinnedSongs(pins)
    return songs.filter { !pinned.contains($0.key) }
  }

  /// Songs to drop, least recently used first, so that `need` more bytes fit within `limit`; nil when they can't fit
  /// even then (songs in `protect` are never dropped).
  public static func evictions(_ songs: [Int: KeptFile], need: Int64, limit: Int64, protect: Set<Int> = []) -> [Int]? {
    var used = bytes(songs.values)
    var out: [Int] = []
    for (id, song) in oldestFirst(songs) where !protect.contains(id) {
      if used + need <= limit { break }
      out.append(id)
      used -= song.bytes
    }
    return used + need <= limit ? out : nil
  }

  /// The least recently used songs that free `bytes`; nil if all of them together don't.
  public static func freeUp(_ songs: [Int: KeptFile], bytes wanted: Int64, protect: Set<Int> = []) -> [Int]? {
    var out: [Int] = []
    var freed: Int64 = 0
    for (id, song) in oldestFirst(songs) where !protect.contains(id) {
      if freed >= wanted { break }
      out.append(id)
      freed += song.bytes
    }
    return freed >= wanted ? out : nil
  }

  /// Whether every file of a transition is on this device.
  public static func transitionKept(_ t: KeptTransition, files: [String: KeptFile]) -> Bool {
    t.fileNames.allSatisfy { files[$0] != nil }
  }

  public static func progress(of d: PinnedDownload, in m: OfflineManifest) -> DownloadProgress {
    let done = d.tracks.filter { m.songs[$0.fileId] != nil }
    let songBytes = bytes(Set(done.map(\.fileId)).compactMap { m.songs[$0] })
    let transitionBytes = bytes(Set(d.transitions.values.flatMap(\.fileNames)).compactMap { m.transitionFiles[$0] })
    return DownloadProgress(done: done.count, total: d.tracks.count, bytes: songBytes + transitionBytes)
  }

  /// Downloads in the order they were added.
  public static func inOrder(_ pins: [String: PinnedDownload]) -> [PinnedDownload] {
    pins.values.sorted { ($0.addedAt, $0.key) < ($1.addedAt, $1.key) }
  }

  /// The next song of a download to fetch: downloads in the order they were added, songs in order. `skip`: songs
  /// that failed this session, or are on their way.
  public static func nextToDownload(_ pins: [String: PinnedDownload], songs: [Int: KeptFile], skip: Set<Int> = []) -> Track? {
    for d in inOrder(pins) {
      if let t = d.tracks.first(where: { songs[$0.fileId] == nil && !skip.contains($0.fileId) }) { return t }
    }
    return nil
  }

  /// The next transition a download is missing: downloads in the order they were added, pairs in their song order,
  /// once both songs are on the device. Pairs in `skipped` (none to be had this session) and `busy` ones (the player
  /// is asking about that song) are left for later.
  public static func nextTransition(
    _ pins: [String: PinnedDownload], manifest m: OfflineManifest, skipped: Set<String> = [],
    busy: (Track, Track) -> Bool = { _, _ in false }
  ) -> (key: String, from: Track, to: Track)? {
    for d in inOrder(pins) {
      for (from, to) in zip(d.tracks, d.tracks.dropFirst()) {
        let pair = pair(from.fileId, to.fileId, transitionMode)
        guard from.fileId != to.fileId, m.songs[from.fileId] != nil, m.songs[to.fileId] != nil, !skipped.contains(pair) else { continue }
        if let kept = d.transitions[pair], transitionKept(kept, files: m.transitionFiles) { continue }
        if busy(from, to) { continue }
        return (d.key, from, to)
      }
    }
    return nil
  }

  /// The queue plays the songs' album, as the player will ask (`playsAlbum` in apps/web/src/player/decks.ts): a
  /// download of an album (or an artist) mixes like playing it from its page.
  public static func playsAlbum(_ href: String?, _ a: Track) -> Bool {
    guard let href else { return true }
    return href == "/albums/\(a.albumId)" || href == "/artists/\(a.artistId)"
  }

  /// The fade asked for songs that can't be mixed on the beat: the crossfade setting, else 6 s (`djFadeSeconds`).
  public static func transitionFade(crossfade: Double) -> Double { crossfade > 0 ? crossfade : 6 }

  private static func oldestFirst(_ songs: [Int: KeptFile]) -> [(Int, KeptFile)] {
    songs.map { ($0.key, $0.value) }.sorted { ($0.1.usedAt, $0.0) < ($1.1.usedAt, $1.0) }
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter OfflineRulesTests
```

Expected: `Test run with 8 tests` … `passed`. If `TransitionPlan`'s generated init differs from the one in `longPlan` (phase 2 may have made `beats` an `Int`), change only `longPlan`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/KeptFile.swift \
  apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/KeptTransition.swift \
  apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PinnedDownload.swift \
  apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/OfflineManifest.swift \
  apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/OfflineRules.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/OfflineRulesTests.swift
git commit -F - <<'EOF'
Describe what the phone keeps offline, and the web's rules for making room and fetching downloads

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

### Task 3: The account's folder

`Application Support/Playarr/<serverId>/<accountId>/`: `stream/` (phase 3's), `offline/transitions/`, `offline/resume/`, `offline.json`; out of iCloud backups; job names as paths from `Application Support/Playarr/`; finding whole files on disk; the room left on the device.

**Files:**
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/OfflineFolder.swift`
- Test: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/OfflineFolderTests.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/OfflineFolderTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrPlayer

struct OfflineFolderTests {
  @Test func laysOutAnAccountsFolderAndNamesJobsByTheirPath() {
    let folder = OfflineFolder.of(AccountKey(serverId: "srv-1", accountId: 2), base: URL(filePath: "/tmp/Playarr/"))
    #expect(folder.root.path() == "/tmp/Playarr/srv-1/2/")
    #expect(folder.songPath(song(12)) == "stream/12.flac")
    #expect(folder.jobID("stream/12.flac") == "srv-1/2/stream/12.flac")
    #expect(folder.path(ofJob: "srv-1/2/stream/12.flac") == "stream/12.flac")
    #expect(folder.path(ofJob: "srv-1/3/stream/12.flac") == nil)
    #expect(OfflineFolder(root: folder.root) == folder)
  }

  @Test func keepsItsAudioOutOfBackupsAndFindsWholeFiles() throws {
    let folder = OfflineFolder(root: temporaryDirectory().appending(path: "srv/1"))
    folder.prepare()
    #expect(try folder.stream.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
    let offline = folder.root.appending(path: "offline")
    #expect(try offline.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
    try Data(count: 10).write(to: folder.stream.appending(path: "12.flac"))
    try Data(count: 5).write(to: folder.stream.appending(path: "13.mp3.part"))
    try Data(count: 5).write(to: folder.stream.appending(path: "levelled-AB.wav"))
    try Data(count: 7).write(to: folder.transitions.appending(path: "ab.flac"))
    #expect(folder.songFiles().mapValues(\.bytes) == [12: 10])
    #expect(folder.songFiles()[12]?.path == "stream/12.flac")
    #expect(folder.transitionFiles().mapValues(\.path) == ["ab.flac": "offline/transitions/ab.flac"])
    folder.removeAll()
    #expect(folder.songFiles().isEmpty)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter OfflineFolderTests
```

Expected: the build fails with `cannot find 'OfflineFolder' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/OfflineFolder.swift`:

```swift
import Foundation
import PlayarrAPI

/// Where one server and account keeps audio on this device: `Application Support/Playarr/<serverId>/<accountId>/`,
/// with songs' files in `stream/` (phase 3's stream cache: `<fileId>.<ext>`, `.part` while incomplete), transitions
/// of downloads in `offline/transitions/`, interrupted downloads' resume data in `offline/resume/`, and the manifest
/// in `offline.json`. None of it goes to iCloud backups: it can all be downloaded again.
public struct OfflineFolder: Sendable, Equatable {
  /// `Application Support/Playarr/`: every server and account's folder is inside, and background downloads are named
  /// by their path from here.
  public let base: URL
  /// `<serverId>/<accountId>`.
  public let account: String

  public init(base: URL, account: String) {
    self.base = base
    self.account = account
  }

  /// The folder of an account folder's path (its last two components are the server and account).
  public init(root: URL) {
    let server = root.deletingLastPathComponent()
    self.init(base: server.deletingLastPathComponent(), account: "\(server.lastPathComponent)/\(root.lastPathComponent)")
  }

  public static let applicationBase = URL.applicationSupportDirectory.appending(path: "Playarr", directoryHint: .isDirectory)

  /// The one place the per-account folder is worked out.
  public static func of(_ key: AccountKey, base: URL = applicationBase) -> OfflineFolder {
    OfflineFolder(base: base, account: "\(key.serverId)/\(key.accountId)")
  }

  public var root: URL { base.appending(path: account, directoryHint: .isDirectory) }
  public var stream: URL { root.appending(path: "stream", directoryHint: .isDirectory) }
  public var transitions: URL { root.appending(path: "offline/transitions", directoryHint: .isDirectory) }
  public var resume: URL { root.appending(path: "offline/resume", directoryHint: .isDirectory) }
  public var manifest: URL { root.appending(path: "offline.json") }

  /// A song's file, as the stream cache names it.
  public static func songFileName(_ track: Track) -> String { "\(track.fileId).\(track.format.container.lowercased())" }
  public func songPath(_ track: Track) -> String { "stream/\(Self.songFileName(track))" }
  public func transitionPath(_ name: String) -> String { "offline/transitions/\(name)" }
  public func url(_ path: String) -> URL { root.appending(path: path) }

  /// A background download's name: its file's path from `base`, so it lands in the right folder even when another
  /// account is active by then, or the app was relaunched.
  public func jobID(_ path: String) -> String { "\(account)/\(path)" }
  /// The path in this folder a job is for; nil for another account's.
  public func path(ofJob id: String) -> String? {
    id.hasPrefix(account + "/") ? String(id.dropFirst(account.count + 1)) : nil
  }

  /// Makes the folders, kept out of backups (a folder excluded is excluded with everything in it).
  public func prepare() {
    for url in [stream, transitions, resume] {
      try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }
    Self.excludeFromBackup(stream)
    Self.excludeFromBackup(root.appending(path: "offline", directoryHint: .isDirectory))
  }

  public static func excludeFromBackup(_ url: URL) {
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    var url = url
    try? url.setResourceValues(values)
  }

  public struct FoundFile: Sendable, Equatable {
    public var path: String
    public var bytes: Int64
    public var modified: Date
  }

  /// Songs' whole files in `stream/`, by file id (not `.part` files or a seek's levelled stream).
  public func songFiles() -> [Int: FoundFile] {
    var out: [Int: FoundFile] = [:]
    for (name, found) in files(in: stream, prefix: "stream/") {
      guard !name.hasSuffix(".part"), let dot = name.firstIndex(of: "."), let id = Int(name[..<dot]) else { continue }
      out[id] = found
    }
    return out
  }

  /// Transition files, by name.
  public func transitionFiles() -> [String: FoundFile] {
    var out: [String: FoundFile] = [:]
    for (name, found) in files(in: transitions, prefix: "offline/transitions/") where !name.hasSuffix(".part") { out[name] = found }
    return out
  }

  public func size(of path: String) -> Int64? {
    (try? url(path).resourceValues(forKeys: [.fileSizeKey]))?.fileSize.map(Int64.init)
  }

  public func remove(_ path: String) {
    try? FileManager.default.removeItem(at: url(path))
  }

  /// Everything this account keeps here: the folder goes.
  public func removeAll() {
    try? FileManager.default.removeItem(at: stream)
    try? FileManager.default.removeItem(at: root.appending(path: "offline", directoryHint: .isDirectory))
    try? FileManager.default.removeItem(at: manifest)
  }

  /// Room left on the device for what the user asked to keep (`volumeAvailableCapacityForImportantUsage`): space
  /// iOS would free for it is counted. Nil when the system won't say.
  public static func availableCapacity(at url: URL = .applicationSupportDirectory) -> Int64? {
    (try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]))?.volumeAvailableCapacityForImportantUsage
  }

  private func files(in directory: URL, prefix: String) -> [(String, FoundFile)] {
    let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey, .isRegularFileKey]
    let urls = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: keys)) ?? []
    return urls.compactMap { url in
      guard let v = try? url.resourceValues(forKeys: Set(keys)), v.isRegularFile == true else { return nil }
      let name = url.lastPathComponent
      return (name, FoundFile(path: prefix + name, bytes: Int64(v.fileSize ?? 0), modified: v.contentModificationDate ?? .distantPast))
    }
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter OfflineFolderTests
```

Expected: `Test run with 2 tests` … `passed` (`isExcludedFromBackup` is honoured on macOS too).

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/OfflineFolder.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/OfflineFolderTests.swift
git commit -F - <<'EOF'
Give each account a folder for offline audio, kept out of iCloud backups

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

### Task 4: The stream cache hands over its books

`StreamCache` reports every whole file (also those that came in before it had a ledger) and every play, stops evicting on its own once a ledger is set, and can drop files on the ledger's word and say whether a song is being fetched.

**Files:**
- Modify: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/StreamCache.swift`
- Modify: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/StreamCacheTests.swift`
- Test support: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/Recorder.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/Recorder.swift`:

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

Append to `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/StreamCacheTests.swift`:

```swift
@Suite(.serialized)
struct StreamCacheLedgerTests {
  let body = Data(repeating: 7, count: 100_000)

  @Test func tellsItsLedgerOfWholeFilesAndPlaysAndLeavesTheDroppingToIt() async throws {
    for id in 231...233 { StubServer.serve("/stream/\(id)", .init(body: body)) }
    let events = Recorder<StreamCache.Event>()
    let cache = StreamCache(directory: temporaryDirectory(), maxBytes: 150_000, retryDelay: .milliseconds(5), configuration: StubServer.configuration)
    await cache.keepBooks { events.append($0) }
    for id in 231...233 {
      try await cache.download(for: song(id), request: StubServer.request("/stream/\(id)")).waitUntilFinished()
    }
    await eventuallyAsync { events.all.count == 3 }
    // Past its own limit, nothing went: the ledger decides.
    #expect(await cache.completedFile(for: song(231)) != nil)
    let completed = events.all.compactMap { event -> Int? in
      if case .completed(let id, let file, let bytes) = event, bytes == 100_000, file.lastPathComponent == "\(id).flac" { return id }
      return nil
    }
    #expect(completed.sorted() == [231, 232, 233])
    #expect(events.all.last == .used(fileId: 231))
    await cache.remove([231, 232])
    #expect(await cache.completedFile(for: song(231)) == nil)
    #expect(await cache.completedFile(for: song(233)) != nil)
  }
}

/// Waits (up to a second) for something another task does.
func eventuallyAsync(_ condition: @Sendable () async -> Bool) async {
  for _ in 0..<1000 where !(await condition()) { try? await Task.sleep(for: .milliseconds(1)) }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter 'StreamCacheTests|StreamCacheLedgerTests'
```

Expected: the build fails with `value of type 'StreamCache' has no member 'keepBooks'`.

**Step 3: Implement**

Make these replacements in `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/StreamCache.swift` (each `old` appears once).

1. The type's comment:

   Replace:

```swift
/// (the caller's `directory`). The least recently played go first past `maxBytes`. Keeping songs for offline
/// listening is phase 7's, outside this cache.
```

   with:

```swift
/// (the caller's `directory`). The least recently played go first past `maxBytes`, until a ledger keeps the books
/// (`keepBooks(with:)`): then `DownloadStore` decides what goes, with the user's limit and downloads' songs kept.
```

2. The ledger and its events:

   Replace:

```swift
  private var waiting: [(Track, URLRequest)] = []
```

   with:

```swift
  private var waiting: [(Track, URLRequest)] = []
  private var ledger: (@Sendable (Event) -> Void)?

  /// What the cache tells whoever keeps its books (phase 7's `DownloadStore`).
  public enum Event: Sendable, Equatable {
    /// A song's whole file arrived.
    case completed(fileId: Int, file: URL, bytes: Int64)
    /// A song's whole file was opened to play.
    case used(fileId: Int)
  }
```

3. A play is reported:

   Replace:

```swift
    try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path())
    return url
```

   with:

```swift
    try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path())
    ledger?(.used(fileId: track.fileId))
    return url
```

4. A finished download says which song it was:

   Replace:

```swift
    d.onFinish { [weak self] in Task { await self?.finished() } }
```

   with:

```swift
    d.onFinish { [weak self] in Task { await self?.finished(track.fileId) } }
```

5. Keeping books, removing, and reporting whole files:

   Replace:

```swift
  private func finished() {
    evict()
    pump()
  }
```

   with:

```swift
  /// Hands the books to `ledger`: it hears of every whole file and every play, and decides what goes (`remove(_:)`).
  /// The cache's own limit is off from then on.
  public func keepBooks(with ledger: @escaping @Sendable (Event) -> Void) {
    self.ledger = ledger
    // Files that came in before there was a ledger.
    for (id, d) in downloads where d.isFinished { report(id, d) }
  }

  /// Drops these songs' files, whole or partial; not one being downloaded right now (it's being played).
  public func remove(_ fileIds: Set<Int>) {
    let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path())) ?? []
    for id in fileIds where downloads[id]?.isActive != true {
      downloads[id] = nil
      for name in names where name.hasPrefix("\(id).") {
        try? FileManager.default.removeItem(at: directory.appending(path: name))
      }
    }
  }

  /// Whether this song's file is being fetched now (for playback or ahead of it).
  public func isDownloading(_ fileId: Int) -> Bool { downloads[fileId]?.isActive == true }

  private func finished(_ fileId: Int) {
    if ledger != nil {
      if let d = downloads[fileId] { report(fileId, d) }
    } else {
      evict()
    }
    pump()
  }

  private func report(_ fileId: Int, _ d: Download) {
    let size = (try? d.file.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
    ledger?(.completed(fileId: fileId, file: d.file, bytes: Int64(size)))
  }
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter 'StreamCacheTests|StreamCacheLedgerTests'
```

Expected: `Test run with 5 tests` … `passed` (phase 3's 4 and the new one).

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/StreamCache.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/StreamCacheTests.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/Recorder.swift
git commit -F - <<'EOF'
Let the stream cache report its files and plays, and drop files when told

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

### Task 5: The background session

`DownloadTransport` is what fetches downloads' files; `URLSessionTransport` is it over URLSession download tasks, with `URLSessionTransport.background` the app's background session. What its delegate does with what arrives is in `TransportFiles`, tested on its own with fake responses and errors (no session); the transport itself is tested end to end against phase 3's `StubServer` on an ordinary session (URLProtocol stubs don't run in background sessions, and a background session needs an app).

**Files:**
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/DownloadTransport.swift`
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/TransportFiles.swift`
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/URLSessionTransport.swift`
- Test: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/TransportTests.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/TransportTests.swift`:

```swift
import Foundation
import Testing
@testable import PlayarrPlayer

struct TransportFilesTests {
  func response(_ status: Int) -> HTTPURLResponse {
    HTTPURLResponse(url: URL(string: "https://playarr.test/stream/12")!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
  }

  @Test func putsAFinishedFileAtItsPlaceBeforeURLSessionDeletesIt() throws {
    let base = temporaryDirectory()
    let location = temporaryDirectory().appending(path: "CFNetworkDownload_1.tmp")
    try Data(count: 1234).write(to: location)
    let event = TransportFiles.finish(id: "srv/1/stream/12.flac", location: location, response: response(200), base: base)
    #expect(event == .finished(id: "srv/1/stream/12.flac", bytes: 1234))
    #expect(FileManager.default.fileExists(atPath: base.appending(path: "srv/1/stream/12.flac").path()))
    #expect(!FileManager.default.fileExists(atPath: location.path()))
  }

  @Test func readsTheServersRefusal() throws {
    let location = temporaryDirectory().appending(path: "body.tmp")
    try Data(#"{"error":"Unknown track file"}"#.utf8).write(to: location)
    let event = TransportFiles.finish(id: "srv/1/stream/12.flac", location: location, response: response(404), base: temporaryDirectory())
    #expect(event == .failed(id: "srv/1/stream/12.flac", failure: .server(status: 404, message: "Unknown track file"), resumeData: nil))
  }

  @Test func keepsResumeDataOfAnInterruptedTaskAndTellsACancelApart() {
    let resume = Data([1, 2, 3])
    let lost = NSError(domain: NSURLErrorDomain, code: NSURLErrorNetworkConnectionLost, userInfo: [NSURLSessionDownloadTaskResumeData: resume])
    #expect(TransportFiles.complete(id: "j", error: lost) == .failed(id: "j", failure: .network(lost.localizedDescription), resumeData: resume))
    let quit = NSError(
      domain: NSURLErrorDomain, code: NSURLErrorCancelled,
      userInfo: [NSURLSessionDownloadTaskResumeData: resume, NSURLErrorBackgroundTaskCancelledReasonKey: NSURLErrorCancelledReasonUserForceQuitApplication])
    #expect(TransportFiles.complete(id: "j", error: quit) == .failed(id: "j", failure: .cancelled, resumeData: resume))
    #expect(TransportFiles.complete(id: "j", error: nil) == nil)
  }

  @Test func onlyPutsFilesUnderItsBase() {
    let base = URL(filePath: "/tmp/Playarr/")
    #expect(TransportFiles.destination(of: "srv/1/stream/12.flac", base: base)?.path() == "/tmp/Playarr/srv/1/stream/12.flac")
    #expect(TransportFiles.destination(of: "srv/../../etc/passwd", base: base) == nil)
    #expect(TransportFiles.destination(of: "/etc/passwd", base: base) == nil)
  }
}

@Suite(.serialized)
struct URLSessionTransportTests {
  let body = Data((0..<150_000).map { UInt8($0 % 251) })

  func transport(base: URL) -> (URLSessionTransport, Recorder<TransportEvent>) {
    let events = Recorder<TransportEvent>()
    let t = URLSessionTransport(configuration: StubServer.configuration(), base: base)
    t.setHandler { events.append($0) }
    return (t, events)
  }

  /// The event that ended the job.
  func done(_ events: Recorder<TransportEvent>) -> TransportEvent? {
    events.all.first { if case .progress = $0 { false } else { true } }
  }

  @Test func downloadsAFileToItsPlaceWithProgress() async throws {
    StubServer.serve("/stream/301", .init(body: body))
    let base = temporaryDirectory()
    let (t, events) = transport(base: base)
    t.start(TransportJob(id: "srv/1/stream/301.flac", request: StubServer.request("/stream/301")))
    await eventuallyAsync { done(events) != nil }
    #expect(done(events) == .finished(id: "srv/1/stream/301.flac", bytes: 150_000))
    #expect(try Data(contentsOf: base.appending(path: "srv/1/stream/301.flac")) == body)
    #expect(events.all.contains { if case .progress(_, let written, _) = $0 { written > 0 } else { false } })
  }

  @Test func aRefusalAndACancelEndTheJob() async throws {
    let (t, events) = transport(base: temporaryDirectory())
    t.start(TransportJob(id: "srv/1/stream/302.flac", request: StubServer.request("/stream/302")))  // no route: 404
    await eventuallyAsync { done(events) != nil }
    #expect(done(events) == .failed(id: "srv/1/stream/302.flac", failure: .server(status: 404, message: "Unknown track file"), resumeData: nil))

    StubServer.serve("/stream/303", .init(body: body, pause: .seconds(5)))
    let (slow, slowEvents) = transport(base: temporaryDirectory())
    slow.start(TransportJob(id: "srv/1/stream/303.flac", request: StubServer.request("/stream/303")))
    await eventuallyAsync { await slow.running() == ["srv/1/stream/303.flac"] }
    slow.cancel("srv/1/stream/303.flac")
    await eventuallyAsync { done(slowEvents) != nil }
    guard case .failed(_, .cancelled, _) = done(slowEvents) else { Issue.record("not cancelled: \(String(describing: done(slowEvents)))"); return }
  }

  @Test func handsOverEventsFromBeforeItHadAHandler() async throws {
    StubServer.serve("/stream/304", .init(body: body))
    let t = URLSessionTransport(configuration: StubServer.configuration(), base: temporaryDirectory())
    t.start(TransportJob(id: "srv/1/stream/304.flac", request: StubServer.request("/stream/304")))
    try await Task.sleep(for: .milliseconds(300))
    let events = Recorder<TransportEvent>()
    t.setHandler { events.append($0) }
    await eventuallyAsync { done(events) != nil }
    #expect(done(events) == .finished(id: "srv/1/stream/304.flac", bytes: 150_000))
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter 'TransportFilesTests|URLSessionTransportTests'
```

Expected: the build fails with `cannot find 'TransportFiles' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/DownloadTransport.swift` (`TransportFailure.reason` uses `OfflineRules.noRoom` from Task 2):

```swift
import Foundation

/// One file for the transport to fetch. `id` is the file's path from `Application Support/Playarr/` (see
/// `OfflineFolder.jobID`): it says where the file goes, and names the job across launches.
public struct TransportJob: Sendable, Equatable {
  public var id: String
  public var request: URLRequest
  /// From an earlier try that broke off (the connection, or the app closed from the switcher).
  public var resumeData: Data?

  public init(id: String, request: URLRequest, resumeData: Data? = nil) {
    self.id = id
    self.request = request
    self.resumeData = resumeData
  }
}

public enum TransportFailure: Error, Sendable, Equatable {
  /// The server said no: its status and `{ error }`.
  case server(status: Int, message: String?)
  /// The connection failed (the system already waited for one and retried).
  case network(String)
  /// Stopped: by us, or by the system when the app was closed from the switcher (then with resume data).
  case cancelled
  /// The file couldn't be put in place (disk full).
  case disk(String)

  /// In words, for Library → Downloads.
  public var reason: String {
    switch self {
    case .server(let status, let message): message ?? "The server answered \(status)"
    case .network(let message): message
    case .cancelled: "Stopped"
    case .disk: OfflineRules.noRoom
    }
  }
}

public enum TransportEvent: Sendable, Equatable {
  case progress(id: String, written: Int64, expected: Int64)
  /// The whole file is at its place.
  case finished(id: String, bytes: Int64)
  case failed(id: String, failure: TransportFailure, resumeData: Data?)

  public var id: String {
    switch self {
    case .progress(let id, _, _), .finished(let id, _), .failed(let id, _, _): id
    }
  }
}

/// What fetches downloads' files: a background URLSession in the app (`URLSessionTransport.background`), so they go
/// on with the app closed; a fake in tests.
public protocol DownloadTransport: AnyObject, Sendable {
  /// Where every job's events go (the active account's `DownloadStore`; the last one set wins). Events that came
  /// before there was a handler (a relaunch) are handed over when it's set.
  func setHandler(_ handler: @escaping @Sendable (TransportEvent) -> Void)
  func start(_ job: TransportJob)
  /// Stops a job; it ends with `.failed(.cancelled)`.
  func cancel(_ id: String)
  /// The jobs under way, as the system knows them (after a relaunch too).
  func running() async -> Set<String>
}
```

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/TransportFiles.swift`:

```swift
import Foundation

/// What a download task's delegate does with what arrives, apart from URLSession so it's tested on its own: put the
/// file at its place (before the delegate method returns: URLSession deletes it after), read the server's refusal,
/// keep resume data.
enum TransportFiles {
  /// A finished task's file at `location`, answered with `response`.
  static func finish(id: String, location: URL, response: URLResponse?, base: URL) -> TransportEvent {
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else {
      let body = (try? Data(contentsOf: location)) ?? Data()
      return .failed(id: id, failure: .server(status: status, message: PlaybackError.serverMessage(body)), resumeData: nil)
    }
    guard let destination = destination(of: id, base: base) else {
      return .failed(id: id, failure: .disk("No place for \(id)"), resumeData: nil)
    }
    do {
      let fm = FileManager.default
      try fm.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
      try? fm.removeItem(at: destination)
      try fm.moveItem(at: location, to: destination)
      let bytes = (try? destination.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
      return .finished(id: id, bytes: Int64(bytes))
    } catch {
      return .failed(id: id, failure: .disk(error.localizedDescription), resumeData: nil)
    }
  }

  /// A task that ended with `error` (nil: it finished, and `finish` said so).
  static func complete(id: String, error: (any Error)?) -> TransportEvent? {
    guard let error else { return nil }
    let ns = error as NSError
    let resume = ns.userInfo[NSURLSessionDownloadTaskResumeData] as? Data
    if ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled {
      return .failed(id: id, failure: .cancelled, resumeData: resume)
    }
    return .failed(id: id, failure: .network(ns.localizedDescription), resumeData: resume)
  }

  /// Where a job's file goes: its id is a path under `base` (made by the app, but it comes back from the system).
  static func destination(of id: String, base: URL) -> URL? {
    let parts = id.split(separator: "/", omittingEmptySubsequences: false)
    guard parts.count >= 2, !parts.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) else { return nil }
    return base.appending(path: id)
  }
}
```

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/URLSessionTransport.swift`:

```swift
import Foundation
import Synchronization

/// Downloads' files over URLSession download tasks. `background` is the app's one background session: its tasks go
/// on with the app suspended or closed, the system relaunches the app to hand over what finished
/// (`handleEventsForBackgroundURLSession` in the app delegate), and it waits for a connection and resumes by itself.
/// One file at a time (`httpMaximumConnectionsPerHost = 1`), never discretionary; each request says whether mobile
/// data may be used (Settings → Playback → "Allow downloads on mobile data").
public final class URLSessionTransport: NSObject, URLSessionDownloadDelegate, DownloadTransport, Sendable {
  public static let backgroundIdentifier = "me.tracklistme.playarr.downloads"

  /// The app's background session. Made at launch by the app delegate, so a relaunch reconnects to its tasks.
  public static let background = URLSessionTransport(configuration: .background(withIdentifier: backgroundIdentifier))

  private struct State {
    var session: URLSession?
    var handler: (@Sendable (TransportEvent) -> Void)?
    /// Events from before there was a handler (a relaunch), handed over when one is set.
    var early: [TransportEvent] = []
    var eventsFinished: (@Sendable () -> Void)?
  }

  private let base: URL
  private let state = Mutex(State())

  /// `base`: where jobs' paths start (`Application Support/Playarr/`).
  public init(configuration: URLSessionConfiguration, base: URL = OfflineFolder.applicationBase) {
    self.base = base
    configuration.isDiscretionary = false
    configuration.sessionSendsLaunchEvents = true
    configuration.httpMaximumConnectionsPerHost = 1
    configuration.allowsCellularAccess = true  // each request decides
    super.init()
    let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    state.withLock { $0.session = session }
  }

  public func setHandler(_ handler: @escaping @Sendable (TransportEvent) -> Void) {
    let early = state.withLock { s in
      s.handler = handler
      defer { s.early = [] }
      return s.early
    }
    for event in early { handler(event) }
  }

  public func start(_ job: TransportJob) {
    guard let session = state.withLock({ $0.session }) else { return }
    let task = job.resumeData.map { session.downloadTask(withResumeData: $0) } ?? session.downloadTask(with: job.request)
    task.taskDescription = job.id
    task.resume()
  }

  public func cancel(_ id: String) {
    guard let session = state.withLock({ $0.session }) else { return }
    Task {
      for task in await session.allTasks where task.taskDescription == id { task.cancel() }
    }
  }

  public func running() async -> Set<String> {
    guard let session = state.withLock({ $0.session }) else { return [] }
    return Set(await session.allTasks.filter { $0.state == .running || $0.state == .suspended }.compactMap(\.taskDescription))
  }

  /// The system relaunched the app for this session: `done` (its completion handler) runs once every event is in.
  public func whenEventsFinish(_ done: @escaping @Sendable () -> Void) {
    state.withLock { $0.eventsFinished = done }
  }

  private func emit(_ event: TransportEvent) {
    let handler = state.withLock { s -> (@Sendable (TransportEvent) -> Void)? in
      if s.handler == nil { s.early.append(event) }
      return s.handler
    }
    handler?(event)
  }

  // MARK: URLSessionDownloadDelegate

  public func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
    guard let id = downloadTask.taskDescription else { return }
    emit(TransportFiles.finish(id: id, location: location, response: downloadTask.response, base: base))
  }

  public func urlSession(
    _ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64,
    totalBytesExpectedToWrite: Int64
  ) {
    guard let id = downloadTask.taskDescription else { return }
    emit(.progress(id: id, written: totalBytesWritten, expected: totalBytesExpectedToWrite))
  }

  public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
    guard let id = task.taskDescription, let event = TransportFiles.complete(id: id, error: error) else { return }
    emit(event)
  }

  public func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    let done = state.withLock { s in
      defer { s.eventsFinished = nil }
      return s.eventsFinished
    }
    done?()
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter 'TransportFilesTests|URLSessionTransportTests'
```

Expected: `Test run with 7 tests` … `passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/DownloadTransport.swift \
  apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/TransportFiles.swift \
  apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/URLSessionTransport.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/TransportTests.swift
git commit -F - <<'EOF'
Fetch downloads on a background session: files land by their path, with resume data kept

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

### Task 6: Asking for a transition until it's rendered

`TransitionPoller` is `askUntilRendered` from `downloads.ts`. The player's backend gains the transition ask and an authorized request for a transition's file (skip that part if phase 5 added them with these signatures).

**Files:**
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/TransitionPoller.swift`
- Modify: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PlayerBackend.swift`
- Modify: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/FakeBackend.swift`
- Test: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/TransitionPollerTests.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/TransitionPollerTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Synchronization
import Testing
@testable import PlayarrPlayer

struct TransitionPollerTests {
  let quick = TransitionPoller.Timing(poll: .milliseconds(1), slowPoll: .milliseconds(3), fastPolls: 5, giveUp: .milliseconds(200))

  /// Answers in turn, the last one repeating.
  final class Answers: Sendable {
    let left: Mutex<[TransitionAnswer]>
    let asked = Mutex(0)
    init(_ answers: [TransitionAnswer]) { left = Mutex(answers) }
    func next() -> TransitionAnswer {
      asked.withLock { $0 += 1 }
      return left.withLock { $0.count > 1 ? $0.removeFirst() : $0[0] }
    }
  }

  @Test func pollsWhileItRendersAndKeepsTheReadyAnswer() async throws {
    let answers = Answers(Array(repeating: .pending(.init(plan: longPlan)), count: 7) + [.ready(ready(4, 5))])
    let outcome = try await TransitionPoller(timing: quick).ask { answers.next() }
    #expect(outcome == .ready(ready(4, 5)))
    #expect(answers.asked.withLock { $0 } == 8)
  }

  @Test func givesUpAfterItsTimeAndSaysWhyThereIsNone() async throws {
    let slow = Answers([.pending(.init(plan: longPlan))])
    #expect(try await TransitionPoller(timing: quick).ask { slow.next() } == .none("The transition took too long to render"))
    let none = Answers([.unavailable(.init(reason: "No mix map yet"))])
    #expect(try await TransitionPoller(timing: quick).ask { none.next() } == .none("No mix map yet"))
    let straight = Answers([.straight(.init(plan: longPlan))])
    #expect(try await TransitionPoller(timing: quick).ask { straight.next() } == .none("No transition: the songs play straight on"))
  }

  @Test func waitsThreeSecondsFiveTimesThenTen() {
    #expect(TransitionPoller.Timing.server.poll == .seconds(3))
    #expect(TransitionPoller.Timing.server.slowPoll == .seconds(10))
    #expect(TransitionPoller.Timing.server.fastPolls == 5)
    #expect(TransitionPoller.Timing.server.giveUp == .seconds(600))
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter TransitionPollerTests
```

Expected: the build fails with `cannot find 'TransitionPoller' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/TransitionPoller.swift`:

```swift
import Foundation
import PlayarrAPI

/// Asks for a pair's transition until it's rendered, as `askUntilRendered` in apps/web/src/player/downloads.ts: every
/// 3 s for 5 polls, then every 10 s (renders queue up behind the player's own), giving up after 10 minutes. Asking
/// again also puts the pair back in the server's queue, should newer asks have pushed it out.
public struct TransitionPoller: Sendable {
  public struct Timing: Sendable {
    public var poll: Duration
    public var slowPoll: Duration
    public var fastPolls: Int
    public var giveUp: Duration

    public init(poll: Duration, slowPoll: Duration, fastPolls: Int, giveUp: Duration) {
      self.poll = poll
      self.slowPoll = slowPoll
      self.fastPolls = fastPolls
      self.giveUp = giveUp
    }

    public static let server = Timing(poll: .seconds(3), slowPoll: .seconds(10), fastPolls: 5, giveUp: .seconds(10 * 60))
  }

  public enum Outcome: Sendable, Equatable {
    case ready(TransitionAnswer.Ready)
    /// Why there's none to keep (left out this session).
    case none(String)
  }

  public let timing: Timing

  public init(timing: Timing = .server) { self.timing = timing }

  /// Throws the ask's errors, and `CancellationError` when the task is cancelled.
  public func ask(_ request: @Sendable () async throws -> TransitionAnswer) async throws -> Outcome {
    let clock = ContinuousClock()
    let started = clock.now
    var polls = 0
    while true {
      let answer = try await request()
      try Task.checkCancellation()
      switch answer {
      case .ready(let ready): return .ready(ready)
      case .unavailable(let unavailable): return .none(unavailable.reason)
      case .straight: return .none("No transition: the songs play straight on")
      case .unknown(let status): return .none("Unknown answer: \(status)")
      case .pending: break
      }
      if clock.now - started >= timing.giveUp { return .none("The transition took too long to render") }
      try await Task.sleep(for: polls < timing.fastPolls ? timing.poll : timing.slowPoll)
      polls += 1
    }
  }
}
```

Make these replacements in `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PlayerBackend.swift` (each `old` appears once).

1. The protocol:

   Replace:

```swift
  func artwork(_ track: Track, size: Int) async -> Data?
}
```

   with:

```swift
  func artwork(_ track: Track, size: Int) async -> Data?
  /// POST /api/transitions.
  func transition(_ request: TransitionRequest) async throws -> TransitionAnswer
  /// A rendered transition's file (the `url` or `continuationUrl` of a ready answer), authorized.
  func transitionRequest(_ path: String) -> URLRequest
}
```

2. The real server:

   Replace:

```swift
  public func artwork(_ track: Track, size: Int) async -> Data? {
```

   with:

```swift
  public func transition(_ request: TransitionRequest) async throws -> TransitionAnswer {
    try await client.send(API.Playback.transition(request))
  }

  public func transitionRequest(_ path: String) -> URLRequest {
    media.request(for: media.transition(path) ?? media.baseURL)
  }

  public func artwork(_ track: Track, size: Int) async -> Data? {
```

In `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/FakeBackend.swift`, replace:

```swift
  func artwork(_ track: Track, size: Int) async -> Data? { nil }
```

with:

```swift
  func artwork(_ track: Track, size: Int) async -> Data? { nil }

  /// Answers for POST /api/transitions by "<from id>-<to id>", in turn (the last one repeats); unavailable otherwise.
  let transitionAnswers = Mutex<[String: [TransitionAnswer]]>([:])
  let transitionAsks = Recorder<TransitionRequest>()

  func transition(_ request: TransitionRequest) async throws -> TransitionAnswer {
    transitionAsks.append(request)
    return transitionAnswers.withLock { table in
      let key = "\(request.from)-\(request.to)"
      guard let answers = table[key], let first = answers.first else { return .unavailable(.init(reason: "No mix map yet")) }
      if answers.count > 1 { table[key] = Array(answers.dropFirst()) }
      return first
    }
  }
  func transitionRequest(_ path: String) -> URLRequest { StubServer.request(path) }
```

(If phase 5 already gave `FakeBackend` these calls, keep its versions and add only what's missing: `transitionAnswers` and `transitionAsks` are used by Task 8's tests.)

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter TransitionPollerTests
```

Expected: `Test run with 3 tests` … `passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/TransitionPoller.swift \
  apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PlayerBackend.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/FakeBackend.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/TransitionPollerTests.swift
git commit -F - <<'EOF'
Ask for a transition until it's rendered, as downloads do on the web

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

### Task 7: The download store

The manifest and its reconciliation with the disk at opening; songs kept as you listen within the limit, least recently played first, never what's protected; downloads pinned outside it, fetched one song at a time on the transport (more when the app goes to the background), adopted from the stream cache instead of fetched twice, with progress for the rings, failures in words, resume data, mobile data only when allowed, the room check; removing one, removing all; an account's downloads counted and removed without opening its store. Transitions come in Task 8: their fetching is stubbed here.

**Files:**
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/DownloadStore.swift`
- Test: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/DownloadStoreTests.swift`
- Test support: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/FakeTransport.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/FakeTransport.swift`:

```swift
import Foundation
import Synchronization
@testable import PlayarrPlayer

/// The background session, for tests: jobs wait until the test finishes or fails them. Finishing writes the file
/// where the job's id says, as the real delegate does, then tells the handler.
final class FakeTransport: DownloadTransport {
  private struct State {
    var handler: (@Sendable (TransportEvent) -> Void)?
    var running: [String: TransportJob] = [:]
    var started: [TransportJob] = []
    var cancelled: [String] = []
  }

  let base: URL
  private let state = Mutex(State())
  /// Cancelling only notes it: for a file that was already on its way when the job was stopped.
  let holdCancels = Shared(false)

  init(base: URL) { self.base = base }

  /// Every job started, in order.
  var started: [TransportJob] { state.withLock { $0.started } }
  /// The jobs under way, in the order they started.
  var runningIDs: [String] {
    state.withLock { s in
      var seen = Set<String>()
      return s.started.map(\.id).filter { s.running[$0] != nil && seen.insert($0).inserted }
    }
  }
  var cancelled: [String] { state.withLock { $0.cancelled } }

  func setHandler(_ handler: @escaping @Sendable (TransportEvent) -> Void) { state.withLock { $0.handler = handler } }

  func start(_ job: TransportJob) {
    state.withLock {
      $0.running[job.id] = job
      $0.started.append(job)
    }
  }

  func cancel(_ id: String) {
    let hold = holdCancels.value
    let wasRunning = state.withLock { s in
      s.cancelled.append(id)
      return hold ? s.running[id] != nil : s.running.removeValue(forKey: id) != nil
    }
    if wasRunning && !hold { emit(.failed(id: id, failure: .cancelled, resumeData: nil)) }
  }

  func running() async -> Set<String> { state.withLock { Set($0.running.keys) } }

  /// Pretends a job the system had from before a relaunch.
  func pretendRunning(_ id: String) { state.withLock { $0.running[id] = TransportJob(id: id, request: URLRequest(url: URL(string: "https://playarr.test")!)) } }

  func finish(_ id: String, bytes: Int = 1000) {
    let url = base.appending(path: id)
    try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? Data(count: bytes).write(to: url)
    state.withLock { _ = $0.running.removeValue(forKey: id) }
    emit(.finished(id: id, bytes: Int64(bytes)))
  }

  func fail(_ id: String, _ failure: TransportFailure, resumeData: Data? = nil) {
    state.withLock { _ = $0.running.removeValue(forKey: id) }
    emit(.failed(id: id, failure: failure, resumeData: resumeData))
  }

  func progress(_ id: String, written: Int64, expected: Int64) { emit(.progress(id: id, written: written, expected: expected)) }

  private func emit(_ event: TransportEvent) { state.withLock { $0.handler }?(event) }
}
```

`apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/DownloadStoreTests.swift` (`StoreRig` is used by Task 8's tests too):

```swift
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrPlayer

/// A store over a fresh account folder, a fake background session and the stub server.
@MainActor
final class StoreRig {
  let folder: OfflineFolder
  let transport: FakeTransport
  let backend = FakeBackend()
  let settings = PlaybackSettings(defaults: UserDefaults(suiteName: UUID().uuidString)!)
  let cache: StreamCache
  let room = Shared<Int64>(100 * OfflineLimit.gigabyte)
  let announced = Recorder<String>()
  private(set) var store: DownloadStore!

  init(folder: OfflineFolder? = nil, open: Bool = true) {
    let folder = folder ?? OfflineFolder(root: temporaryDirectory().appending(path: "srv-1/1"))
    self.folder = folder
    transport = FakeTransport(base: folder.base)
    cache = StreamCache(directory: folder.stream, retryDelay: .milliseconds(5), configuration: StubServer.configuration)
    if open { self.open() }
  }

  func open() {
    let room = self.room
    store = DownloadStore(
      folder: folder, settings: settings, cache: cache, transport: transport, backend: backend,
      capacity: { room.value }, poll: TransitionPoller.Timing(poll: .milliseconds(1), slowPoll: .milliseconds(2), fastPolls: 5, giveUp: .milliseconds(100)))
    store.announce = { [announced] text, _ in announced.append(text) }
  }

  func job(_ fileId: Int, _ ext: String = "flac") -> String { folder.jobID("stream/\(fileId).\(ext)") }

  /// Waits for the store to start the job of this song, then finishes it.
  func finish(_ fileId: Int, bytes: Int = 1000) async {
    await eventually { self.transport.runningIDs.contains(self.job(fileId)) }
    transport.finish(job(fileId), bytes: bytes)
    await eventually { self.store.isKept(fileId) }
  }

  /// A song the player streamed: the real stream cache fetches it from the stub server and tells the store, which
  /// keeps it or (`kept: false`) drops it at once to stay within the limit.
  func play(_ fileId: Int, bytes: Int = 700, kept: Bool = true) async throws {
    StubServer.serve("/stream/\(fileId)", .init(body: Data(count: bytes)))
    try await cache.download(for: song(fileId), request: StubServer.request("/stream/\(fileId)")).waitUntilFinished()
    if kept {
      await eventually { self.store.isKept(fileId) }
    } else {
      await eventuallyAsync { await self.cache.completedFile(for: song(fileId)) == nil }
    }
  }
}

func album(_ ids: [Int], key: String = "album:1") -> (key: String, title: String, href: String, tracks: [Track]) {
  (key, "Dummy", "/albums/1", ids.map { song($0) })
}

extension DownloadStore {
  func add(_ d: (key: String, title: String, href: String, tracks: [Track])) {
    add(key: d.key, title: d.title, href: d.href, tracks: d.tracks)
  }
}

@MainActor
@Suite(.serialized)
struct DownloadStoreTests {
  @Test func keepsADownloadsSongsBeyondTheLimitAndTheyNeverMakeRoom() async throws {
    let rig = StoreRig()
    rig.settings.offlineLimit = 1000
    rig.store.add(album([4, 5, 6]))
    for id in [4, 5, 6] { await rig.finish(id, bytes: 500) }
    #expect(rig.store.progress(of: "album:1") == DownloadProgress(done: 3, total: 3, bytes: 1500))
    // A song kept as you listen fits within the limit on its own.
    try await rig.play(7)
    #expect(rig.store.keptAsYouListen.count == 1)
    #expect(rig.store.downloadsBytes == 1500)
    // Turning keeping-as-you-listen off leaves downloads alone.
    rig.store.limit = 0
    #expect(rig.store.manifest.songs.keys.sorted() == [4, 5, 6])
    await eventuallyAsync { await rig.cache.completedFile(for: song(7)) == nil }
    #expect(await rig.cache.completedFile(for: song(7)) == nil)
  }

  @Test func removingADownloadLetsItsSongsGoWithinTheLimit() async throws {
    let rig = StoreRig()
    rig.settings.offlineLimit = 1200
    rig.store.add(album([4, 5, 6]))
    for id in [4, 5, 6] { await rig.finish(id, bytes: 500) }
    rig.store.remove("album:1")
    #expect(rig.store.manifest.pins.isEmpty)
    #expect(rig.store.keptAsYouListen.bytes <= 1200)
    #expect(rig.store.manifest.songs.count == 2)
    await eventually { rig.folder.songFiles().count == 2 }
    #expect(rig.folder.songFiles().keys.sorted() == rig.store.manifest.songs.keys.sorted())
  }

  @Test func theSongsPlayingAndFetchedAheadNeverMakeRoom() async throws {
    let rig = StoreRig()
    rig.settings.offlineLimit = 1000
    try await rig.play(7, bytes: 600)
    rig.store.protect([7])
    try await rig.play(8, bytes: 600, kept: false)
    #expect(rig.store.isKept(7))
    #expect(!rig.store.isKept(8))  // over the limit, and not protected
  }

  @Test func downloadsOneSongAtATimeAndHandsTheSystemMoreInTheBackground() async {
    let rig = StoreRig()
    rig.store.add(album(Array(1...30)))
    await eventually { rig.transport.runningIDs.count == 1 }
    try? await Task.sleep(for: .milliseconds(20))
    #expect(rig.transport.runningIDs == [rig.job(1)])
    rig.store.appMovedToBackground()
    await eventually { rig.transport.runningIDs.count == 25 }
    #expect(rig.transport.runningIDs.first == rig.job(1))
  }

  @Test func showsTheSongDownloadingForTheProgressRings() async {
    let rig = StoreRig()
    rig.store.add(album([4]))
    await eventually { !rig.transport.runningIDs.isEmpty }
    rig.transport.progress(rig.job(4), written: 250, expected: 1000)
    await eventually { rig.store.active != nil }
    #expect(rig.store.active?.fileId == 4)
    #expect(rig.store.active?.fraction == 0.25)
    rig.transport.finish(rig.job(4))
    await eventually { rig.store.active == nil }
  }

  @Test func removingADownloadStopsItsSongAndALateFileIsDropped() async {
    let rig = StoreRig()
    rig.store.add(album([4, 5]))
    await eventually { rig.transport.runningIDs == [rig.job(4)] }
    rig.transport.holdCancels.value = true
    rig.store.remove("album:1")
    #expect(rig.transport.cancelled == [rig.job(4)])
    rig.transport.finish(rig.job(4))  // it had finished as it was stopped
    try? await Task.sleep(for: .milliseconds(30))
    #expect(!rig.store.isKept(4))
    #expect(rig.folder.songFiles().isEmpty)
  }

  @Test func failedSongsSayWhyAndAreTriedAgainWhenTheNetworkComesBack() async {
    let rig = StoreRig()
    rig.store.add(album([4, 5]))
    await eventually { rig.transport.runningIDs == [rig.job(4)] }
    rig.transport.fail(rig.job(4), .server(status: 404, message: "Unknown track file"))
    await eventually { rig.transport.runningIDs == [rig.job(5)] }
    #expect(rig.store.failed == [4: "Unknown track file"])
    #expect(rig.store.failedCount(of: "album:1") == 1)
    await rig.finish(5)
    rig.store.networkChanged(.offline)
    rig.store.networkChanged(.wifi)
    await eventually { rig.transport.runningIDs == [rig.job(4)] }
    #expect(rig.store.failed.isEmpty)
  }

  @Test func aJobTheSystemStoppedGoesOnFromItsResumeData() async {
    let rig = StoreRig()
    rig.store.add(album([4, 5]))
    await eventually { rig.transport.runningIDs == [rig.job(4)] }
    rig.transport.fail(rig.job(4), .cancelled, resumeData: Data([9, 9]))  // the app closed from the switcher
    await eventually { rig.transport.started.count == 2 }
    #expect(rig.transport.started.last?.id == rig.job(4))
    #expect(rig.transport.started.last?.resumeData == Data([9, 9]))
    #expect(rig.store.failed.isEmpty)
  }

  @Test func usesMobileDataOnlyWhenAllowed() async {
    let rig = StoreRig()
    rig.store.add(album([4]))
    await eventually { rig.transport.runningIDs.count == 1 }
    #expect(rig.transport.started[0].request.allowsCellularAccess == false)
    #expect(rig.transport.started[0].request.allowsExpensiveNetworkAccess == false)
    rig.store.cellularDownloads = true
    await eventually { rig.transport.started.count == 2 }
    #expect(rig.transport.cancelled == [rig.job(4)])
    #expect(rig.transport.started[1].request.allowsCellularAccess)
    #expect(rig.transport.started[1].request.value(forHTTPHeaderField: "Range") == nil)
  }

  @Test func outOfRoomSaysSoOnceAndChecksBeforeStarting() async {
    let rig = StoreRig()
    rig.room.value = 100 * OfflineLimit.megabyte  // under what's kept free
    #expect(rig.store.room(for: [song(1), song(2)]) == .short(needed: 2_000_000, free: 0))
    rig.store.add(album([4, 5]))
    await eventually { rig.store.failed.count == 2 }
    #expect(rig.store.failed[4] == "Not enough space on this device")
    #expect(rig.announced.all == ["This device is out of space for downloads: remove some in Library → Downloads"])
    #expect(rig.transport.started.isEmpty)
    rig.room.value = 10 * OfflineLimit.gigabyte
    #expect(rig.store.room(for: [song(1), song(2)]) == .enough)
  }

  @Test func takesOnAWholeFileTheStreamCacheHasInsteadOfDownloadingItAgain() async throws {
    let rig = StoreRig()
    try await rig.play(4)
    rig.store.add(album([4, 5]))
    await eventually { !rig.transport.runningIDs.isEmpty }
    #expect(rig.transport.started.map(\.id) == [rig.job(5)])
    #expect(rig.store.progress(of: "album:1")?.done == 1)
  }

  @Test func reconcilesWithTheDiskWhenItOpens() throws {
    let rig = StoreRig(open: false)
    rig.folder.prepare()
    var manifest = OfflineManifest(songs: [1: kept(10, file: "stream/1.flac")])
    var d = PinnedDownload(key: "album:1", title: "Dummy", href: "/albums/1", tracks: [song(1), song(2)])
    d.transitions["1-2-auto"] = KeptTransition(answer: ready(1, 2), levelled: false)
    manifest.pins["album:1"] = d
    JSONFile<OfflineManifest>(rig.folder.manifest).write(manifest)
    try Data(count: 20).write(to: rig.folder.stream.appending(path: "2.flac"))  // the stream cache's, unknown to the manifest
    try Data(count: 5).write(to: rig.folder.transitions.appending(path: "1-2.flac"))
    try Data(count: 5).write(to: rig.folder.transitions.appending(path: "old.flac"))  // no download has it
    rig.open()
    #expect(rig.store.manifest.songs.mapValues(\.bytes) == [2: 20])  // song 1's file is gone
    #expect(Array(rig.store.manifest.transitionFiles.keys) == ["1-2.flac"])
    #expect(rig.folder.transitionFiles().keys.sorted() == ["1-2.flac"])
    #expect(rig.store.manifest.pins["album:1"] != nil)
  }

  @Test func afterARelaunchSongsTheSystemIsFetchingArentAskedForAgain() async {
    let rig = StoreRig(open: false)
    var manifest = OfflineManifest()
    manifest.pins["album:1"] = PinnedDownload(key: "album:1", title: "Dummy", href: "/albums/1", tracks: [song(4), song(5)])
    rig.folder.prepare()
    JSONFile<OfflineManifest>(rig.folder.manifest).write(manifest)
    rig.transport.pretendRunning(rig.job(4))
    rig.open()
    try? await Task.sleep(for: .milliseconds(50))
    #expect(rig.transport.started.isEmpty)
    rig.transport.finish(rig.job(4))
    await eventually { rig.transport.started.map(\.id) == [rig.job(5)] }
    #expect(rig.store.isKept(4))
  }

  @Test func leavesOtherAccountsJobsAlone() async {
    let rig = StoreRig()
    rig.transport.finish("srv-1/2/stream/9.flac")
    try? await Task.sleep(for: .milliseconds(20))
    #expect(!rig.store.isKept(9))
    #expect(FileManager.default.fileExists(atPath: rig.folder.base.appending(path: "srv-1/2/stream/9.flac").path()))
  }

  @Test func keepsEvenVolumeWithADownloadForPlayingOffline() async {
    let rig = StoreRig()
    rig.backend.levelTable.withLock { $0 = ["rec-4": TrackLevel(track: -5, album: -3)] }
    rig.store.add(album([4, 5]))
    await eventually { !rig.store.keptLevels.isEmpty }
    #expect(rig.store.keptLevels == ["rec-4": TrackLevel(track: -5, album: -3)])
    #expect(JSONFile<OfflineManifest>(rig.folder.manifest).read()?.pins["album:1"]?.levels.count == 1)
  }

  @Test func removeAllLeavesNothing() async throws {
    let rig = StoreRig()
    rig.store.add(album([4, 5]))
    await rig.finish(4)
    try await rig.play(7)
    rig.store.removeAll()
    #expect(rig.store.manifest == OfflineManifest())
    await eventually { rig.folder.songFiles().isEmpty }
    #expect(rig.folder.songFiles().isEmpty)
    #expect(JSONFile<OfflineManifest>(rig.folder.manifest).read() == OfflineManifest())
  }

  @Test func anotherAccountsDownloadsAreCountedAndRemovedWithoutOpeningIt() async {
    let rig = StoreRig()
    rig.store.add(album([4]))
    await rig.finish(4, bytes: 300)
    #expect(DownloadStore.summary(of: rig.folder) == (downloads: 1, bytes: 300) )
    await DownloadStore.removeEverything(in: rig.folder, transport: rig.transport)
    #expect(DownloadStore.summary(of: rig.folder) == (downloads: 0, bytes: 0))
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter DownloadStoreTests
```

Expected: the build fails with `cannot find 'DownloadStore' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/DownloadStore.swift`:

```swift
import Foundation
import Observation
import PlayarrAPI

/// What one server and account keeps on this device, as `useOffline`, downloads.ts and loadAhead.ts's keeping in
/// apps/web/src/player: the manifest (`offline.json`), songs kept as you listen within the limit (least recently
/// played make room), and downloads (albums, playlists, mixes, Favorites) pinned outside it, fetched one song at a time
/// on the background session, then the DJ transitions between their songs. The stream cache owns the files in
/// `stream/` and tells this store about each whole file and each play; this store decides what goes.
@MainActor @Observable
public final class DownloadStore {
  public struct Active: Sendable, Equatable {
    public var fileId: Int
    public var loaded: Int64
    public var total: Int64
    public var fraction: Double { total > 0 ? min(1, Double(loaded) / Double(total)) : 0 }
  }

  /// Whether songs fit on the device before a download starts.
  public enum Room: Sendable, Equatable {
    case enough
    case short(needed: Int64, free: Int64)
  }

  /// Songs started at once: one in the foreground, as the web; more when the app goes to the background, so the
  /// system works through them with the app closed (still one at a time on the wire, `httpMaximumConnectionsPerHost`).
  static let foregroundJobs = 1
  static let backgroundJobs = 25
  /// Room left free on the device, whatever downloads want.
  static let reserve: Int64 = 256 * OfflineLimit.megabyte

  public private(set) var manifest: OfflineManifest
  /// The song downloading for a download, for progress rings.
  public private(set) var active: Active?
  /// Songs that didn't download this session, and why: tried again when the network comes back or space is freed.
  public private(set) var failed: [Int: String] = [:]
  /// Transitions left out this session, by pair: none to be had, too slow, no room, an error.
  public private(set) var skippedPairs: [String: String] = [:]

  public let folder: OfflineFolder
  /// Shows a toast (the Player's notice).
  @ObservationIgnored public var announce: @MainActor (_ text: String, _ isError: Bool) -> Void = { _, _ in }
  @ObservationIgnored private let settings: PlaybackSettings
  @ObservationIgnored private let cache: StreamCache
  @ObservationIgnored private let transport: any DownloadTransport
  @ObservationIgnored private let backend: any PlayerBackend
  @ObservationIgnored private let saved: JSONFile<OfflineManifest>
  @ObservationIgnored private let capacity: @Sendable () -> Int64?
  @ObservationIgnored private let now: @Sendable () -> Date
  @ObservationIgnored private let poller: TransitionPoller
  /// Songs playing or fetched ahead: never dropped to make room.
  @ObservationIgnored private(set) var protectedSongs: Set<Int> = []
  /// Song jobs under way: job id → file id.
  @ObservationIgnored private var songJobs: [String: Int] = [:]
  /// Jobs stopped on purpose: their end is no interruption, and a file that still arrives is dropped.
  @ObservationIgnored private var stopping: Set<String> = []
  /// Songs the stream cache is fetching for the player right now: their download waits for that.
  @ObservationIgnored private var withCache: Set<Int> = []
  @ObservationIgnored private var transitionWork: TransitionWork?
  /// Nothing is fetched until the jobs the system still has (after a relaunch) are known.
  @ObservationIgnored private var opened = false
  @ObservationIgnored private var online = true
  @ObservationIgnored private var inBackground = false
  @ObservationIgnored private var pumping = false
  @ObservationIgnored private var pumpAgain = false
  @ObservationIgnored private var warnedFull = false
  @ObservationIgnored private var watchers: [Task<Void, Never>] = []

  private struct TransitionWork {
    let key: String
    let pair: String
    var kept: KeptTransition?
    var waiting: Set<String> = []
    var fetched: [String] = []
    var task: Task<Void, Never>?
  }

  public init(
    folder: OfflineFolder, settings: PlaybackSettings, cache: StreamCache, transport: any DownloadTransport,
    backend: any PlayerBackend, capacity: @escaping @Sendable () -> Int64? = { OfflineFolder.availableCapacity() },
    now: @escaping @Sendable () -> Date = { Date() }, poll: TransitionPoller.Timing = .server
  ) {
    self.folder = folder
    self.settings = settings
    self.cache = cache
    self.transport = transport
    self.backend = backend
    self.capacity = capacity
    self.now = now
    poller = TransitionPoller(timing: poll)
    folder.prepare()
    saved = JSONFile(folder.manifest)
    manifest = saved.read() ?? OfflineManifest()
    reconcile()
    transport.setHandler { [weak self] event in Task { @MainActor in self?.handle(event) } }
    watchers.append(
      Task { [weak self, cache] in
        await cache.keepBooks { event in Task { @MainActor in self?.handle(event) } }
        await self?.adoptRunningJobs()
      })
  }

  isolated deinit {
    for watcher in watchers { watcher.cancel() }
  }

  // MARK: Reading

  /// Downloads, the newest first (Library → Downloads).
  public var downloads: [PinnedDownload] { manifest.pins.values.sorted { ($0.addedAt, $0.key) > ($1.addedAt, $1.key) } }
  public func download(_ key: String) -> PinnedDownload? { manifest.pins[key] }
  public func progress(of key: String) -> DownloadProgress? { manifest.pins[key].map { OfflineRules.progress(of: $0, in: manifest) } }
  /// Its songs that couldn't download this session.
  public func failedCount(of key: String) -> Int { manifest.pins[key]?.tracks.filter { failed[$0.fileId] != nil }.count ?? 0 }
  /// The song's whole file is on this device (kept or downloaded): it plays with no connection.
  public func isKept(_ fileId: Int) -> Bool { manifest.songs[fileId] != nil }
  /// Songs kept as you listen: what Settings → Playback counts against the limit.
  public var keptAsYouListen: (count: Int, bytes: Int64) {
    let rest = OfflineRules.unpinned(manifest.songs, pins: manifest.pins)
    return (rest.count, OfflineRules.bytes(rest.values))
  }
  /// What downloads take, their transitions included.
  public var downloadsBytes: Int64 {
    let pinned = OfflineRules.pinnedSongs(manifest.pins)
    return OfflineRules.bytes(manifest.songs.filter { pinned.contains($0.key) }.values) + OfflineRules.bytes(manifest.transitionFiles.values)
  }
  /// Even volume for downloads' songs, for the player's level store (it can't ask the server offline).
  public var keptLevels: [String: TrackLevel] {
    manifest.pins.values.reduce(into: [:]) { all, d in all.merge(d.levels) { old, _ in old } }
  }

  /// Settings → Playback → On this device: room for songs kept as you listen. Lowering it drops the least recently
  /// played now.
  public var limit: Int64 {
    get { settings.offlineLimit }
    set {
      settings.offlineLimit = newValue
      fitLimit()
      retry()
    }
  }

  /// "Allow downloads on mobile data". The song under way starts again under the new rule.
  public var cellularDownloads: Bool {
    get { settings.cellularDownloads }
    set {
      settings.cellularDownloads = newValue
      for id in songJobs.keys { stop(id) }
      pump()
    }
  }

  /// Whether these songs fit on the device, counting songs kept as you listen as room (they'd make way).
  public func room(for tracks: [Track]) -> Room {
    var seen = Set<Int>()
    let needed = tracks.filter { $0.fileId > 0 && manifest.songs[$0.fileId] == nil && seen.insert($0.fileId).inserted }
      .reduce(Int64(0)) { $0 + Int64($1.size) }
    guard needed > 0, let free = capacity() else { return .enough }
    let freeable = keptAsYouListen.bytes
    let available = free + freeable - Self.reserve
    return needed <= available ? .enough : .short(needed: needed, free: max(0, available))
  }

  // MARK: Changing

  /// Download an album, playlist, mix or Favorites, or update the songs of one already downloaded (a playlist edited
  /// since). Transitions between songs that no longer follow each other go.
  public func add(key: String, title: String, subtitle: String? = nil, coverUrl: String? = nil, href: String, tracks: [Track]) {
    let songs = tracks.filter { $0.fileId > 0 }
    let before = manifest.pins[key]
    let pairs = OfflineRules.pairs(of: songs, mode: OfflineRules.transitionMode)
    manifest.pins[key] = PinnedDownload(
      key: key, title: title, subtitle: subtitle, coverUrl: coverUrl, href: href, tracks: songs, addedAt: before?.addedAt ?? now(),
      transitions: before?.transitions.filter { pairs.contains($0.key) } ?? [:], levels: before?.levels ?? [:])
    save()
    dropUnwantedTransitionFiles()
    // Songs come before transitions.
    if OfflineRules.nextToDownload(manifest.pins, songs: manifest.songs, skip: Set(failed.keys)) != nil { stopTransitionWork() }
    Task { await refreshLevels() }
    pump()
  }

  /// Remove a download: its songs become ordinary kept songs, which make room as usual. Its transitions are only any
  /// use to downloads, so they go unless another one has them too.
  public func remove(_ key: String) {
    guard manifest.pins.removeValue(forKey: key) != nil else { return }
    save()
    let pinned = OfflineRules.pinnedSongs(manifest.pins)
    for (id, fileId) in songJobs where !pinned.contains(fileId) { stop(id) }
    if transitionWork?.key == key { stopTransitionWork() }
    dropUnwantedTransitionFiles()
    fitLimit()
    retry()
  }

  /// Remove everything from this device, downloads included.
  public func removeAll() {
    for id in songJobs.keys { stop(id) }
    stopTransitionWork()
    let ids = Set(manifest.songs.keys).union(folder.songFiles().keys)
    manifest = OfflineManifest()
    save()
    active = nil
    failed = [:]
    skippedPairs = [:]
    for (_, found) in folder.transitionFiles() { folder.remove(found.path) }
    try? FileManager.default.removeItem(at: folder.resume)
    folder.prepare()
    Task { [cache] in await cache.remove(ids) }
  }

  /// The songs playing and fetched ahead (the player's keep-ahead plan): never dropped to make room.
  public func protect(_ fileIds: Set<Int>) {
    protectedSongs = fileIds
    fitLimit()
    pump()
  }

  public func networkChanged(_ kind: NetworkKind) {
    let wasOnline = online
    online = kind != .offline
    if online && !wasOnline {
      Task { await refreshLevels() }
      retry()
    }
  }

  /// The app is going to the background: hand the system more songs, so they download with the app closed.
  public func appMovedToBackground() {
    inBackground = true
    pump()
  }

  public func appBecameActive() {
    inBackground = false
    pump()
  }

  /// Try the songs and transitions that failed again (back online, after space was freed).
  public func retry() {
    warnedFull = false
    failed = [:]
    skippedPairs = [:]
    pump()
  }

  // MARK: Fetching

  /// Fetches what downloads are missing while there's a connection: their songs, one at a time, then the transitions
  /// between them, one pair at a time (the server renders one at a time and drops older asks once a few wait).
  public func pump() {
    guard opened else { return }
    guard !pumping else {
      pumpAgain = true
      return
    }
    pumping = true
    Task {
      await pumpSongs()
      pumping = false
    }
  }

  private func pumpSongs() async {
    withCache = []
    repeat {
      pumpAgain = false
      while online, songJobs.count < (inBackground ? Self.backgroundJobs : Self.foregroundJobs) {
        let skip = Set(songJobs.values).union(failed.keys).union(withCache)
        guard let next = OfflineRules.nextToDownload(manifest.pins, songs: manifest.songs, skip: skip) else { break }
        if adopt(next) { continue }
        if await cache.isDownloading(next.fileId) {
          withCache.insert(next.fileId)  // the player is fetching it: its whole file is recorded when it lands
          continue
        }
        guard makeRoom(for: Int64(next.size)) else {
          fail(next.fileId, OfflineRules.noRoom)
          continue
        }
        start(next)
      }
    } while pumpAgain
    if songJobs.isEmpty, withCache.isEmpty, OfflineRules.nextToDownload(manifest.pins, songs: manifest.songs, skip: Set(failed.keys)) == nil {
      keepNextTransition()
    }
  }

  /// A song's whole file the stream cache already has (played before): taken on rather than downloaded again.
  private func adopt(_ track: Track) -> Bool {
    let path = folder.songPath(track)
    guard manifest.songs[track.fileId] == nil, let bytes = folder.size(of: path), bytes > 0 else { return false }
    record(track.fileId, path: path, bytes: bytes)
    return true
  }

  private func start(_ track: Track) {
    let id = folder.jobID(folder.songPath(track))
    songJobs[id] = track.fileId
    transport.start(TransportJob(id: id, request: allowed(backend.streamRequest(track)), resumeData: resumeData(id)))
  }

  /// A request with mobile data (and personal hotspots) allowed only if the setting says so.
  private func allowed(_ request: URLRequest) -> URLRequest {
    var request = request
    request.allowsCellularAccess = settings.cellularDownloads
    request.allowsExpensiveNetworkAccess = settings.cellularDownloads
    return request
  }

  private func stop(_ id: String) {
    songJobs[id] = nil
    stopping.insert(id)
    transport.cancel(id)
  }

  /// Room on the device for `need` more bytes, dropping songs kept as you listen (least recently played first) if
  /// it's short. False when even that isn't enough.
  private func makeRoom(for need: Int64) -> Bool {
    guard let free = capacity() else { return true }
    let short = need + Self.reserve - free
    guard short > 0 else { return true }
    guard let drop = OfflineRules.freeUp(OfflineRules.unpinned(manifest.songs, pins: manifest.pins), bytes: short, protect: protectedSongs) else {
      return false
    }
    dropSongs(drop)
    return true
  }

  private func fail(_ fileId: Int, _ reason: String) {
    failed[fileId] = reason
    if reason == OfflineRules.noRoom && !warnedFull {
      warnedFull = true
      announce("This device is out of space for downloads: remove some in Library → Downloads", true)
    }
  }

  /// Songs kept as you listen beyond the limit go, least recently played first (never those of downloads, nor what's
  /// playing or fetched ahead). Off: all of them.
  private func fitLimit() {
    let rest = OfflineRules.unpinned(manifest.songs, pins: manifest.pins)
    let unprotected = rest.keys.filter { !protectedSongs.contains($0) }
    let limit = settings.offlineLimit
    dropSongs(limit > 0 ? OfflineRules.evictions(rest, need: 0, limit: limit, protect: protectedSongs) ?? unprotected : unprotected)
  }

  private func dropSongs(_ ids: [Int]) {
    guard !ids.isEmpty else { return }
    for id in ids { manifest.songs[id] = nil }
    save()
    let set = Set(ids)
    Task { [cache] in await cache.remove(set) }
  }

  private func record(_ fileId: Int, path: String, bytes: Int64) {
    manifest.songs[fileId] = KeptFile(file: path, bytes: bytes, usedAt: now())
    save()
  }

  private func touch(_ fileId: Int) {
    guard manifest.songs[fileId] != nil else { return }
    manifest.songs[fileId]?.usedAt = now()
    save()
  }

  // MARK: Events

  private func handle(_ event: StreamCache.Event) {
    switch event {
    case .completed(let fileId, let file, let bytes):
      withCache.remove(fileId)
      record(fileId, path: "stream/\(file.lastPathComponent)", bytes: bytes)
      fitLimit()
      pump()
    case .used(let fileId):
      touch(fileId)
    }
  }

  private func handle(_ event: TransportEvent) {
    guard let path = folder.path(ofJob: event.id) else { return }  // another account's: its file is in place already
    switch event {
    case .progress(let id, let written, let expected):
      guard let fileId = songJobs[id] else { return }
      let size = manifest.pins.values.lazy.flatMap(\.tracks).first { $0.fileId == fileId }?.size ?? 0
      active = Active(fileId: fileId, loaded: written, total: expected > 0 ? expected : Int64(size))

    case .finished(let id, let bytes):
      clearResumeData(id)
      let fileId = songJobs.removeValue(forKey: id)
      if active?.fileId == fileId { active = nil }
      if stopping.remove(id) != nil {
        if fileId == nil || !OfflineRules.pinnedSongs(manifest.pins).contains(fileId ?? 0) { folder.remove(path) }
      } else if path.hasPrefix("offline/transitions/") {
        transitionFileArrived(id, path: path, bytes: bytes)
      } else if let fileId = fileId ?? Self.songId(path) {
        record(fileId, path: path, bytes: bytes)
        fitLimit()
      }
      pump()

    case .failed(let id, let failure, let resume):
      if let resume { saveResumeData(resume, id) }
      let fileId = songJobs.removeValue(forKey: id)
      if active?.fileId == fileId { active = nil }
      let onPurpose = stopping.remove(id) != nil
      if path.hasPrefix("offline/transitions/") {
        if !onPurpose { transitionFileFailed(id, failure) }
      } else if let fileId, !onPurpose {
        // Cancelled without us: the system stopped it (the app closed from the switcher), picked up again from its
        // resume data.
        if failure != .cancelled { fail(fileId, failure.reason) }
      }
      pump()
    }
  }

  /// "stream/12.flac" → 12.
  static func songId(_ path: String) -> Int? {
    guard path.hasPrefix("stream/") else { return nil }
    return Int(path.dropFirst("stream/".count).prefix { $0 != "." })
  }

  /// After a relaunch: the songs the system is still fetching aren't asked for again.
  private func adoptRunningJobs() async {
    for id in await transport.running() {
      guard let path = folder.path(ofJob: id), let fileId = Self.songId(path), manifest.songs[fileId] == nil else { continue }
      songJobs[id] = fileId
    }
    opened = true
    pump()
  }

  // MARK: Transitions

  private func stopTransitionWork() {
    guard let work = transitionWork else { return }
    transitionWork = nil
    work.task?.cancel()
    for id in work.waiting { stop(id) }
    dropUnwantedTransitionFiles()
  }

  /// Transition files no download has any more go.
  private func dropUnwantedTransitionFiles() {
    let wanted = OfflineRules.pinnedTransitionFiles(manifest.pins).union(transitionWork?.kept?.fileNames ?? [])
    let unwanted = manifest.transitionFiles.filter { !wanted.contains($0.key) }
    guard !unwanted.isEmpty else { return }
    for (name, file) in unwanted {
      folder.remove(file.file)
      manifest.transitionFiles[name] = nil
    }
    save()
  }

  // MARK: Asking for transitions (Task 8)

  private func keepNextTransition() {}
  private func transitionFileArrived(_ id: String, path: String, bytes: Int64) { dropUnwantedTransitionFiles() }
  private func transitionFileFailed(_ id: String, _ failure: TransportFailure) {}

  // MARK: Levels

  /// Even volume for downloads' songs, asked once while online (50 to a request) and kept with the download.
  private func refreshLevels() async {
    let missing = Set(manifest.pins.values.flatMap { d in d.tracks.map(\.recordingId).filter { d.levels[$0] == nil } })
    guard online, !missing.isEmpty else { return }
    let ids = missing.sorted()
    var found: [String: TrackLevel] = [:]
    for start in stride(from: 0, to: ids.count, by: LevelStore.batchSize) {
      guard let batch = try? await backend.levels(Array(ids[start..<min(start + LevelStore.batchSize, ids.count)])) else { return }
      found.merge(batch) { _, new in new }
    }
    for key in manifest.pins.keys {
      guard let tracks = manifest.pins[key]?.tracks else { continue }
      for t in tracks { if let level = found[t.recordingId] { manifest.pins[key]?.levels[t.recordingId] = level } }
    }
    save()
  }

  // MARK: Disk

  /// Forget files that are gone, and take on what's on disk that the manifest doesn't know: whole songs the stream
  /// cache kept before it had a ledger, or the background session finished while another account was active.
  private func reconcile() {
    let songs = folder.songFiles()
    let transitions = folder.transitionFiles()
    manifest.songs = manifest.songs.filter { songs[$0.key] != nil }
    for (id, found) in songs where manifest.songs[id] == nil {
      manifest.songs[id] = KeptFile(file: found.path, bytes: found.bytes, usedAt: found.modified)
    }
    let wanted = OfflineRules.pinnedTransitionFiles(manifest.pins)
    manifest.transitionFiles = manifest.transitionFiles.filter { transitions[$0.key] != nil }
    for (name, found) in transitions {
      if !wanted.contains(name) {
        folder.remove(found.path)
        manifest.transitionFiles[name] = nil
      } else if manifest.transitionFiles[name] == nil {
        manifest.transitionFiles[name] = KeptFile(file: found.path, bytes: found.bytes, usedAt: found.modified)
      }
    }
    save()
    fitLimit()
  }

  private func save() { saved.write(manifest) }

  private func resumeURL(_ id: String) -> URL { folder.resume.appending(path: id.replacingOccurrences(of: "/", with: "_")) }
  private func resumeData(_ id: String) -> Data? { try? Data(contentsOf: resumeURL(id)) }
  private func saveResumeData(_ data: Data, _ id: String) { try? data.write(to: resumeURL(id)) }
  private func clearResumeData(_ id: String) { try? FileManager.default.removeItem(at: resumeURL(id)) }

  // MARK: Another account's

  /// What an account keeps on this device, without opening its store: sign-out asks before removing it.
  nonisolated public static func summary(of folder: OfflineFolder) -> (downloads: Int, bytes: Int64) {
    let manifest = JSONFile<OfflineManifest>(folder.manifest).read() ?? OfflineManifest()
    let bytes = folder.songFiles().values.reduce(Int64(0)) { $0 + $1.bytes } + folder.transitionFiles().values.reduce(Int64(0)) { $0 + $1.bytes }
    return (manifest.pins.count, bytes)
  }

  /// Removes everything an account keeps here: its jobs stop, its files go.
  nonisolated public static func removeEverything(in folder: OfflineFolder, transport: any DownloadTransport) async {
    for id in await transport.running() where folder.path(ofJob: id) != nil { transport.cancel(id) }
    folder.removeAll()
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter DownloadStoreTests
```

Expected: `Test run with 17 tests` … `passed`. Run it three times: the store reacts to events through main-actor tasks, so a test that fails now and then on an idle Mac is a race to fix. (`eventually` gives up after a second; on a Mac busy enough that the run takes several times longer than usual, rerun before suspecting the code.)

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/DownloadStore.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/DownloadStoreTests.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/FakeTransport.swift
git commit -F - <<'EOF'
Keep songs and downloads on the phone: a limit for songs kept as you listen, downloads outside it, one song at a time

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

### Task 8: Transitions with downloads

After a download's songs, the transitions between them (DJ mix only, Auto mode, asked as the player will, levelled when even volume is on), one pair at a time; shared between downloads; forgotten when the songs no longer follow each other; left to the player when it's asking about that song; fetched when DJ mix is switched on. And the lookup the player uses offline.

**Files:**
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/KeptTransitionFiles.swift`
- Modify: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/DownloadStore.swift`
- Test: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/DownloadTransitionTests.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/DownloadTransitionTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrPlayer

@MainActor
@Suite(.serialized)
struct DownloadTransitionTests {
  /// A rig on DJ mix with these answers, and the album's songs downloaded.
  func rig(_ answers: [String: [TransitionAnswer]], songs: [Int] = [4, 5, 6]) async -> StoreRig {
    let rig = StoreRig()
    rig.settings.transitions = .dj
    rig.backend.transitionAnswers.withLock { $0 = answers }
    rig.store.add(album(songs))
    for id in songs { await rig.finish(id) }
    return rig
  }

  func transitionJob(_ rig: StoreRig, _ name: String) -> String { rig.folder.jobID("offline/transitions/\(name)") }

  /// Waits for a transition file's job, then finishes it.
  func finish(_ rig: StoreRig, _ name: String) async {
    let id = transitionJob(rig, name)
    await eventually { rig.transport.runningIDs.contains(id) }
    rig.transport.finish(id, bytes: 100)
    await eventually { rig.store.manifest.transitionFiles[name] != nil }
  }

  @Test func asksForEachPairInSongOrderAsThePlayerWouldAndKeepsTheFiles() async {
    let rig = await rig(["4-5": [.pending(.init(plan: longPlan)), .ready(ready(4, 5))], "5-6": [.ready(ready(5, 6, rest: true))]])
    await finish(rig, "4-5.flac")
    await finish(rig, "5-6.flac")
    await finish(rig, "5-6.rest.flac")
    await eventually { rig.store.manifest.pins["album:1"]?.transitions.count == 2 }
    let asks = rig.backend.transitionAsks.all
    #expect(asks.map { [$0.from, $0.to] } == [[4, 5], [4, 5], [5, 6]])
    #expect(asks[0] == TransitionRequest(from: 4, to: 5, mode: .auto, fromFileId: 4, toFileId: 5, fade: 6, albumQueue: true))
    #expect(rig.store.progress(of: "album:1")?.bytes == 3300)  // three songs and three transition files
  }

  @Test func looksAKeptTransitionUpByItsPairModeAndGains() async {
    let rig = await rig(["4-5": [.ready(ready(4, 5, rest: true))]], songs: [4, 5])
    await finish(rig, "4-5.flac")
    await finish(rig, "4-5.rest.flac")
    await eventually { rig.store.manifest.pins["album:1"]?.transitions.count == 1 }
    let kept = rig.store.keptTransition(from: song(4), to: song(5), mode: .auto, online: false, levelled: false)
    #expect(kept?.file == rig.folder.transitions.appending(path: "4-5.flac"))
    #expect(kept?.continuation == rig.folder.transitions.appending(path: "4-5.rest.flac"))
    #expect(kept?.transition.answer == ready(4, 5, rest: true))
    // Made without even volume's gains: not for songs played levelled.
    #expect(rig.store.keptTransition(from: song(4), to: song(5), mode: .auto, online: false, levelled: true) == nil)
    // Offline a Party queue takes the Auto one; online it asks the server.
    #expect(rig.store.keptTransition(from: song(4), to: song(5), mode: .party, online: false, levelled: false) != nil)
    #expect(rig.store.keptTransition(from: song(4), to: song(5), mode: .party, online: true, levelled: false) == nil)
    // Its files gone: none.
    rig.folder.remove("offline/transitions/4-5.rest.flac")
    rig.store.removeAll()
    #expect(rig.store.keptTransition(from: song(4), to: song(5), mode: .auto, online: false, levelled: false) == nil)
  }

  @Test func skipsPairsWithNoTransitionToKeepAndMovesOn() async {
    let rig = await rig(["5-6": [.straight(.init(plan: longPlan))]])  // 4-5: unavailable
    await eventually { rig.store.skippedPairs.count == 2 }
    #expect(rig.store.skippedPairs == ["4-5-auto": "No mix map yet", "5-6-auto": "No transition: the songs play straight on"])
    #expect(rig.store.manifest.transitionFiles.isEmpty)
  }

  @Test func givesUpOnAPairThatTakesTooLongToRender() async {
    let rig = await rig(["4-5": [.pending(.init(plan: longPlan))], "5-6": [.ready(ready(5, 6))]], songs: [4, 5, 6])
    await finish(rig, "5-6.flac")
    #expect(rig.store.skippedPairs["4-5-auto"] == "The transition took too long to render")
  }

  @Test func sharesATransitionBetweenDownloadsAndRemovesItsFilesWithTheLastOne() async {
    let rig = await rig(["4-5": [.ready(ready(4, 5))], "5-6": [.ready(ready(5, 6, rest: true))]])
    await finish(rig, "4-5.flac")
    await finish(rig, "5-6.flac")
    await finish(rig, "5-6.rest.flac")
    rig.store.add(key: "playlist:1", title: "Two", href: "/playlists/1", tracks: [song(4), song(5)])
    await eventually { rig.store.manifest.pins["playlist:1"]?.transitions.count == 1 }
    #expect(rig.backend.transitionAsks.all.count == 2)  // not asked again
    rig.store.remove("album:1")
    #expect(rig.folder.transitionFiles().keys.sorted() == ["4-5.flac"])
    rig.store.remove("playlist:1")
    #expect(rig.folder.transitionFiles().isEmpty)
    #expect(rig.store.manifest.transitionFiles.isEmpty)
  }

  @Test func forgetsTransitionsOfPairsADownloadNoLongerHas() async {
    let rig = await rig(["4-5": [.ready(ready(4, 5))], "5-6": [.ready(ready(5, 6))]])
    await finish(rig, "4-5.flac")
    await finish(rig, "5-6.flac")
    await eventually { rig.store.manifest.pins["album:1"]?.transitions.count == 2 }
    rig.store.add(album([4, 5]))
    #expect(rig.store.manifest.pins["album:1"]?.transitions.keys.sorted() == ["4-5-auto"])
    #expect(rig.folder.transitionFiles().keys.sorted() == ["4-5.flac"])
  }

  @Test func leavesThePairThePlayerIsAskingAboutToThePlayer() async {
    let rig = StoreRig()
    rig.settings.transitions = .dj
    rig.store.playerPair = { (fromFileId: 4, toFileId: 9) }  // song 4 plays with song 9 next
    rig.backend.transitionAnswers.withLock { $0 = ["4-5": [.ready(ready(4, 5))], "5-6": [.ready(ready(5, 6))]] }
    rig.store.add(album([4, 5, 6]))
    for id in [4, 5, 6] { await rig.finish(id) }
    await finish(rig, "5-6.flac")
    #expect(rig.backend.transitionAsks.all.map { [$0.from, $0.to] } == [[5, 6]])
    rig.store.playerPair = { nil }
    rig.store.playerMoved()
    await finish(rig, "4-5.flac")
  }

  @Test func fetchesNothingUnlessTransitionsAreDJMix() async {
    let rig = StoreRig()
    rig.settings.transitions = .crossfade
    rig.store.add(album([4, 5]))
    for id in [4, 5] { await rig.finish(id) }
    try? await Task.sleep(for: .milliseconds(30))
    #expect(rig.backend.transitionAsks.all.isEmpty)
    rig.backend.transitionAnswers.withLock { $0 = ["4-5": [.ready(ready(4, 5))]] }
    rig.settings.transitions = .dj  // downloads made before fetch theirs now
    await finish(rig, "4-5.flac")
  }

  @Test func asksAtTheGainsEvenVolumePlaysTheSongsAt() async {
    let rig = StoreRig()
    rig.settings.transitions = .dj
    rig.backend.levelTable.withLock { $0 = ["rec-4": TrackLevel(track: -5, album: -3), "rec-5": TrackLevel(track: 2, album: -3)] }
    rig.backend.transitionAnswers.withLock { $0 = ["4-5": [.ready(ready(4, 5))]] }
    rig.store.add(album([4, 5]))
    await eventually { rig.store.keptLevels.count == 2 }
    for id in [4, 5] { await rig.finish(id) }
    await finish(rig, "4-5.flac")
    await eventually { rig.store.manifest.pins["album:1"]?.transitions.count == 1 }
    #expect(rig.backend.transitionAsks.all.first?.levels == .init(a: -3, b: -3))  // the album's gain: it plays in order
    #expect(rig.store.keptTransition(from: song(4), to: song(5), mode: .auto, online: false, levelled: true) != nil)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter DownloadTransitionTests
```

Expected: the build fails with `value of type 'DownloadStore' has no member 'keptTransition'` (and `playerPair`, `playerMoved`).

**Step 3: Implement**

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/KeptTransitionFiles.swift`:

```swift
import Foundation

/// A kept transition ready to play offline: its plan and lead/tail, and its files on this device.
public struct KeptTransitionFiles: Sendable, Equatable {
  public var transition: KeptTransition
  /// The transition's file.
  public var file: URL
  /// B's remainder, when the transition has one (played from `plan.bResume`, instead of B's own file).
  public var continuation: URL?

  public init(transition: KeptTransition, file: URL, continuation: URL?) {
    self.transition = transition
    self.file = file
    self.continuation = continuation
  }
}
```

Make these replacements in `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/DownloadStore.swift` (each `old` appears once).

1. The player's pair:

   Replace:

```swift
  @ObservationIgnored private let settings: PlaybackSettings
```

   with:

```swift
  /// The pair the player is asking the server about (phase 5's planner): the server keeps one waiting render per
  /// song, so a download asking about the same song into another one would push the player's out.
  @ObservationIgnored public var playerPair: @MainActor () -> (fromFileId: Int, toFileId: Int)? = { nil }

  @ObservationIgnored private let settings: PlaybackSettings
```

2. Watching the transitions setting, at the end of `init`:

   Replace:

```swift
        await self?.adoptRunningJobs()
      })
  }
```

   with:

```swift
        await self?.adoptRunningJobs()
      })
    // Switched to DJ mix: downloads made before fetch their transitions now; switched away: stop asking.
    watchers.append(
      Task { [weak self, settings] in
        for await mode in Observations({ settings.transitions }) {
          guard let self else { return }
          if mode != .dj { self.stopTransitionWork() }
          self.pump()
        }
      })
  }
```

3. The lookup for the player, at the end of "Reading":

   Replace:

```swift
  // MARK: Changing
```

   with:

```swift
  /// A transition kept with a download for this pair, its files on this device, for the player offline (the server
  /// can't be asked then). Offline a Party queue takes the Auto one: a mix beats none. `levelled`: whether the player
  /// plays the two songs at even-volume gains; a transition made at other gains would jump in level, so it's left out.
  public func keptTransition(from: Track, to: Track, mode: MixMode, online: Bool, levelled: Bool) -> KeptTransitionFiles? {
    func find(_ mode: MixMode) -> KeptTransitionFiles? {
      let pair = OfflineRules.pair(from.fileId, to.fileId, mode)
      for d in OfflineRules.inOrder(manifest.pins) {
        guard let kept = d.transitions[pair], kept.levelled == levelled, OfflineRules.transitionKept(kept, files: manifest.transitionFiles)
        else { continue }
        let files = kept.fileNames.map { folder.url(folder.transitionPath($0)) }
        return KeptTransitionFiles(transition: kept, file: files[0], continuation: files.count > 1 ? files[1] : nil)
      }
      return nil
    }
    return find(mode) ?? (!online && mode == .party ? find(.auto) : nil)
  }

  // MARK: Changing
```

4. The player moved on:

   Replace:

```swift
  /// Try the songs and transitions that failed again (back online, after space was freed).
```

   with:

```swift
  /// The player moved on to another pair: one left aside for it may be fetched now, or must wait.
  public func playerMoved() {
    if let work = transitionWork, clashesWithPlayer(work.pair) { stopTransitionWork() }
    pump()
  }

  /// Try the songs and transitions that failed again (back online, after space was freed).
```

5. Asking for transitions, in place of Task 7's stubs:

   Replace:

```swift
  // MARK: Asking for transitions (Task 8)

  private func keepNextTransition() {}
  private func transitionFileArrived(_ id: String, path: String, bytes: Int64) { dropUnwantedTransitionFiles() }
  private func transitionFileFailed(_ id: String, _ failure: TransportFailure) {}
```

   with:

```swift
  // MARK: Asking for transitions

  private func clashesWithPlayer(_ pair: String) -> Bool {
    guard let playing = playerPair() else { return false }
    let ids = pair.split(separator: "-").compactMap { Int($0) }
    return ids.count >= 2 && ids[0] == playing.fromFileId && ids[1] != playing.toFileId
  }

  /// Fetch the next transition a download is missing, while transitions are DJ mix: ask the server, ask again until
  /// it's rendered, then keep its files.
  private func keepNextTransition() {
    guard transitionWork == nil, online, !inBackground, settings.transitions == .dj else { return }
    let playing = playerPair()
    let busy: (Track, Track) -> Bool = { from, to in playing.map { $0.fromFileId == from.fileId && $0.toFileId != to.fileId } ?? false }
    guard let next = OfflineRules.nextTransition(manifest.pins, manifest: manifest, skipped: Set(skippedPairs.keys), busy: busy) else { return }
    let pair = OfflineRules.pair(next.from.fileId, next.to.fileId, OfflineRules.transitionMode)
    let request = transitionRequest(next.key, next.from, next.to)
    let levelled = request.levels != nil
    // Another download has it already, at the same gains: no need to ask.
    if let shared = manifest.pins.values.lazy.compactMap({ $0.transitions[pair] }).first(where: {
      $0.levelled == levelled && OfflineRules.transitionKept($0, files: manifest.transitionFiles)
    }) {
      manifest.pins[next.key]?.transitions[pair] = shared
      save()
      return keepNextTransition()
    }
    var work = TransitionWork(key: next.key, pair: pair)
    work.task = Task { [poller, backend] in
      let outcome: Result<TransitionPoller.Outcome, any Error>
      do {
        outcome = .success(try await poller.ask { try await backend.transition(request) })
      } catch {
        outcome = .failure(error)
      }
      self.answered(pair, outcome, levelled: levelled)
    }
    transitionWork = work
  }

  /// Asked as the player will ask for it, so both get the same plan, and the same file: no position (the server reuses
  /// this plan for the player's first ask while it's still ahead), the files, the fade, whether it plays the album, and
  /// the gains even volume plays the songs at.
  func transitionRequest(_ key: String, _ from: Track, _ to: Track) -> TransitionRequest {
    let d = manifest.pins[key]
    var levels: TransitionAnswer.Ready.Levels?
    if settings.levelVolume, let d, let a = d.levels[from.recordingId], let b = d.levels[to.recordingId],
      let at = d.tracks.firstIndex(where: { $0.fileId == from.fileId })
    {
      var queue = QueueState()
      queue.queue = d.tracks
      queue.order = Array(d.tracks.indices)
      queue.pos = at
      levels = .init(a: JoinRules.levelDb(from, a, in: queue), b: JoinRules.levelDb(to, b, in: queue))
    }
    return TransitionRequest(
      from: from.id, to: to.id, mode: OfflineRules.transitionMode, fromFileId: from.fileId, toFileId: to.fileId,
      fade: OfflineRules.transitionFade(crossfade: settings.crossfade), albumQueue: OfflineRules.playsAlbum(d?.href, from), levels: levels)
  }

  private func answered(_ pair: String, _ outcome: Result<TransitionPoller.Outcome, any Error>, levelled: Bool) {
    guard var work = transitionWork, work.pair == pair else { return }  // stopped meanwhile
    switch outcome {
    case .failure(let error):
      transitionWork = nil
      if !(error is CancellationError) { skip(pair, error.localizedDescription) }
    case .success(.none(let reason)):
      transitionWork = nil
      skip(pair, reason)
    case .success(.ready(let answer)):
      let kept = KeptTransition(answer: answer, levelled: levelled)
      let missing = zip(kept.urls, kept.fileNames).filter { manifest.transitionFiles[$0.1] == nil }
      // Room before the server says how big: uncompressed, which the FLAC files never exceed.
      guard makeRoom(for: Int64((answer.plan.length + 60) * 44_100 * 4)) else {
        transitionWork = nil
        skip(pair, OfflineRules.noRoom)
        break
      }
      work.kept = kept
      for (url, name) in missing {
        let id = folder.jobID(folder.transitionPath(name))
        work.waiting.insert(id)
        transport.start(TransportJob(id: id, request: allowed(backend.transitionRequest(url))))
      }
      transitionWork = work
      if missing.isEmpty { finishTransition() }
      return
    }
    pump()
  }

  private func transitionFileArrived(_ id: String, path: String, bytes: Int64) {
    let name = String(path.dropFirst("offline/transitions/".count))
    manifest.transitionFiles[name] = KeptFile(file: path, bytes: bytes, usedAt: now())
    save()
    guard var work = transitionWork, work.waiting.remove(id) != nil else {
      dropUnwantedTransitionFiles()  // from before a relaunch, or stopped meanwhile
      return
    }
    work.fetched.append(name)
    transitionWork = work
    if work.waiting.isEmpty { finishTransition() }
  }

  private func transitionFileFailed(_ id: String, _ failure: TransportFailure) {
    guard let work = transitionWork, work.waiting.contains(id) else { return }
    stopTransitionWork()
    skip(work.pair, failure.reason)
  }

  /// Every file of the fetched transition is here: it goes with its download, unless the download is gone or its songs
  /// no longer follow each other.
  private func finishTransition() {
    guard let work = transitionWork, let kept = work.kept else { return }
    transitionWork = nil
    if let d = manifest.pins[work.key], OfflineRules.pairs(of: d.tracks, mode: OfflineRules.transitionMode).contains(work.pair) {
      manifest.pins[work.key]?.transitions[work.pair] = kept
      save()
    }
    dropUnwantedTransitionFiles()
    pump()
  }

  private func skip(_ pair: String, _ reason: String) {
    skippedPairs[pair] = reason
  }
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter 'DownloadTransitionTests|DownloadStoreTests'
```

Expected: `Test run with 26 tests` … `passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/KeptTransitionFiles.swift \
  apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/DownloadStore.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/DownloadTransitionTests.swift
git commit -F - <<'EOF'
Keep the DJ transitions between a download's songs, at the gains the phone plays them at

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

### Task 9: Keep-ahead and offline rules

`KeepAhead` is `loadAheadPlan` and `reach`; `OfflinePlayback` is `skipToKept`'s search and `maybeAsk`'s rule for a kept transition. Both pure; the web's tests ported.

**Files:**
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/KeepAhead.swift`
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/OfflinePlayback.swift`
- Test: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/KeepAheadTests.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/KeepAheadTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrPlayer

struct KeepAheadTests {
  func at(_ pos: Int, _ repeatMode: RepeatMode = .off, order: [Int] = [0, 1, 2, 3, 4], songs: [Int] = [1, 2, 3, 4, 5]) -> QueueState {
    var q = QueueState()
    q.queue = songs.map { song($0) }
    q.order = order
    q.pos = pos
    q.repeatMode = repeatMode
    return q
  }

  func ids(_ tracks: [Track]) -> [Int] { tracks.map(\.fileId) }

  @Test func takesTheNextSongsInPlayOrderThenTheOnePlaying() {
    #expect(ids(KeepAhead.plan(at(0), ahead: 3, withCurrent: true)) == [2, 3, 4, 1])
    #expect(ids(KeepAhead.plan(at(1, order: [4, 2, 0, 1, 3]), ahead: 2, withCurrent: true)) == [1, 2, 3])
  }

  @Test func stopsAtTheEndOfTheQueueUnlessItRepeats() {
    #expect(ids(KeepAhead.plan(at(3), ahead: 3, withCurrent: true)) == [5, 4])
    #expect(ids(KeepAhead.plan(at(3, .all), ahead: 3, withCurrent: true)) == [5, 1, 2, 4])
  }

  @Test func putsTheCurrentSongFirstOnRepeatOneAndLeavesItOutOnRequest() {
    #expect(ids(KeepAhead.plan(at(0, .one), ahead: 1, withCurrent: false)) == [1, 2])
    #expect(ids(KeepAhead.plan(at(0), ahead: 1, withCurrent: false)) == [2])
  }

  @Test func listsEachFileOnceAndNothingForAnEmptyQueue() {
    #expect(ids(KeepAhead.plan(at(0, order: [0, 1, 2], songs: [7, 8, 7]), ahead: 3, withCurrent: true)) == [8, 7])
    #expect(KeepAhead.plan(QueueState(), ahead: 3, withCurrent: true).isEmpty)
  }

  @Test func looksAheadByTheNetworkAndNotAtAllWhenKeepingIsOff() {
    let gb = OfflineLimit.gigabyte
    #expect(ids(KeepAhead.plan(at(0), network: .wifi, limit: gb)) == [2, 3, 4, 1])
    #expect(ids(KeepAhead.plan(at(0), network: .cellular, limit: gb)) == [2])
    #expect(KeepAhead.plan(at(0), network: .constrained, limit: gb).isEmpty)
    #expect(KeepAhead.plan(at(0), network: .offline, limit: gb).isEmpty)
    #expect(KeepAhead.plan(at(0), network: .wifi, limit: 0).isEmpty)
  }
}

struct OfflinePlaybackTests {
  @Test func findsTheNextSongOnThisDeviceWithoutWrappingRound() {
    var q = QueueState()
    q.playTracks((1...5).map { song($0) }, startIndex: 1)
    #expect(OfflinePlayback.nextKept(in: q, isKept: { [4, 1].contains($0) }) == 3)
    #expect(OfflinePlayback.nextKept(in: q, isKept: { $0 == 1 }) == nil)
  }

  @Test func usesAKeptTransitionOfflineAlwaysAndOnlineWhileItsMixPointIsWellAhead() {
    let kept = KeptTransitionFiles(transition: KeptTransition(answer: ready(1, 2), levelled: false), file: URL(filePath: "/t.flac"), continuation: nil)
    #expect(OfflinePlayback.useKept(kept, online: false, time: 169) == kept)  // aStart is 170
    #expect(OfflinePlayback.useKept(kept, online: true, time: 100) == kept)
    #expect(OfflinePlayback.useKept(kept, online: true, time: 151) == nil)
    #expect(OfflinePlayback.useKept(nil, online: false, time: 0) == nil)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter 'KeepAheadTests|OfflinePlaybackTests'
```

Expected: the build fails with `cannot find 'KeepAhead' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/KeepAhead.swift`:

```swift
import Foundation
import PlayarrAPI

/// The songs to have on this device ahead of playback, most urgent first (`loadAheadPlan` and `reach` in
/// apps/web/src/player/loadAhead.ts): the next 3 in play order on Wi-Fi (round to the first when repeating the queue),
/// then the current one; the next 1 on mobile data; none in Low Data Mode or offline; with repeat one, the current
/// song first. Nothing when keeping songs is off. This is the one way songs are fetched ahead: the stream cache fetches
/// the plan, and the download store keeps it (and what plays now and next) from being dropped.
public enum KeepAhead {
  /// Wait for the queue to settle, so skipping through songs doesn't download each one.
  public static let settle: Duration = .milliseconds(2500)

  public static func plan(_ q: QueueState, network: NetworkKind, limit: Int64) -> [Track] {
    guard limit > 0 else { return [] }
    return plan(q, ahead: PrefetchPolicy.songsAhead(on: network), withCurrent: network == .wifi)
  }

  static func plan(_ q: QueueState, ahead: Int, withCurrent: Bool) -> [Track] {
    guard let current = q.currentTrack else { return [] }
    let upcoming = q.upcoming(ahead)
    let plan = q.repeatMode == .one ? [current] + upcoming : withCurrent ? upcoming + [current] : upcoming
    var seen = Set<Int>()
    return plan.filter { seen.insert($0.fileId).inserted }
  }
}
```

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/OfflinePlayback.swift`:

```swift
import Foundation

/// What plays without a connection (apps/web/src/player/AudioEngine.tsx `skipToKept`, transitions.ts `maybeAsk`).
public enum OfflinePlayback {
  /// The web's toast when songs are skipped.
  public static let skippedNotice = "Offline: skipped songs that aren’t on this device"
  /// A kept transition whose mix point is closer than this is passed over online, so the server plans from where the
  /// song is (`GIVE_UP_S`).
  public static let giveUpSeconds: Double = 20

  /// The play-order position of the next song on this device after the current one; nil if none (no wrapping round).
  public static func nextKept(in q: QueueState, isKept: (Int) -> Bool) -> Int? {
    guard q.pos >= 0 else { return nil }
    return (q.pos + 1..<q.order.count).first { isKept(q.queue[q.order[$0]].fileId) }
  }

  /// Whether the player plays a kept transition rather than asking the server: always offline (it can't ask); online
  /// only while its mix point is still well ahead of `time` (seconds into A).
  public static func useKept(_ kept: KeptTransitionFiles?, online: Bool, time: Double) -> KeptTransitionFiles? {
    guard let kept else { return nil }
    return !online || time < kept.transition.answer.plan.aStart - giveUpSeconds ? kept : nil
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter 'KeepAheadTests|OfflinePlaybackTests'
```

Expected: `Test run with 7 tests` … `passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/KeepAhead.swift \
  apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/OfflinePlayback.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/KeepAheadTests.swift
git commit -F - <<'EOF'
Port the web's keep-ahead plan and its offline rules

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

### Task 10: The Player keeps ahead and plays offline

The Player owns the account's `DownloadStore` (made with the stream cache), seeds even volume from downloads, keeps ahead with `KeepAhead` (settled, replanned when the network changes, what plays now and next always protected), skips to kept songs offline with the web's toast, retries play reports when back online. `TrackSource` is unchanged; a test pins down that a kept song plays with the server out of reach.

**Files:**
- Modify: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Player.swift`
- Modify: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/LevelStore.swift`
- Modify: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/FakeBackend.swift`
- Modify: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/TrackSourceTests.swift`
- Test: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/PlayerOfflineTests.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/PlayerOfflineTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrPlayer

@MainActor
@Suite(.serialized)
struct PlayerOfflineTests {
  /// An account folder where these songs' whole files are already on the device.
  func folder(keeping ids: [Int]) throws -> URL {
    let directory = temporaryDirectory().appending(path: "srv-1/1")
    let stream = directory.appending(path: "stream")
    try FileManager.default.createDirectory(at: stream, withIntermediateDirectories: true)
    for id in ids { try Data(count: 100).write(to: stream.appending(path: "\(id).flac")) }
    return directory
  }

  func offline(_ player: Player) {
    player.network = { .offline }
    player.networkChanged(.offline)
  }

  @Test func offlineSkipsToTheNextSongOnThisDeviceWithTheWebsToast() throws {
    let player = try Player.testing(directory: try folder(keeping: [3, 5]))
    offline(player)
    player.play([song(1), song(2), song(3), song(4), song(5)])
    #expect(player.queue.pos == 2)
    #expect(player.queue.playing)
    #expect(player.notice?.text == "Offline: skipped songs that aren’t on this device")
    // Song 4 isn't here: nothing is joined after song 3; it'll be skipped when song 3 ends.
    #expect(player.upcoming == nil)
    player.next()
    #expect(player.queue.pos == 4)
  }

  @Test func offlineWithNothingKeptAheadTriesTheSongAndSaysWhy() throws {
    let player = try Player.testing(directory: try folder(keeping: []))
    offline(player)
    player.play([song(1), song(2)])
    #expect(player.queue.pos == 0)
    #expect(player.notice == nil)
  }

  @Test func aSongThatBreaksOffOfflineSkipsToAKeptOne() async throws {
    struct Broken: PCMSource {
      func read(maxFrames: Int) async throws -> PCMBlock? { throw PlaybackError.unreachable }
      func close() async {}
    }
    let directory = try folder(keeping: [2])
    let player = try Player(
      backend: FakeBackend(), directory: directory, settings: PlaybackSettings(defaults: UserDefaults(suiteName: UUID().uuidString)!),
      transport: FakeTransport(base: OfflineFolder(root: directory).base),
      makeEngine: { try AudioEngine(manualRendering: true, makeSource: $0) },
      makeSource: { item, frame -> any PCMSource in
        item.track.fileId == 1 ? Broken() : SignalSource(seconds: item.track.duration, from: frame, signal: Signals.sine)
      })
    player.play([song(1), song(2)])  // online when it starts
    player.network = { .offline }  // then the connection goes
    await player.engine.settle()
    await eventually { player.queue.pos == 1 }
    #expect(player.queue.pos == 1)
    #expect(player.error == nil)
    #expect(player.notice?.text == "Offline: skipped songs that aren’t on this device")
  }

  @Test func playReportsWaitOfflineAndGoWhenTheConnectionIsBack() async throws {
    let backend = FakeBackend()
    backend.reachable.value = false
    let player = try Player.testing(backend, directory: try folder(keeping: [1, 2]))
    offline(player)
    player.play([song(1, duration: 2), song(2, duration: 2)])
    try await player.play(for: 2.6)
    try await Task.sleep(for: .milliseconds(50))
    #expect(backend.plays.withLock { $0.isEmpty })
    backend.reachable.value = true
    player.network = { .wifi }
    player.networkChanged(.wifi)
    await eventually { !backend.plays.withLock { $0.isEmpty } }
    #expect(backend.plays.withLock { $0.map(\.trackId) } == [1])
  }

  @Test func keepsAheadByTheNetworkAndAlwaysWhatPlaysNowAndNext() async throws {
    let player = try Player.testing()
    player.play((401...405).map { song($0) })
    await eventually { player.downloads.protectedSongs == [401, 402, 403, 404] }
    #expect(player.downloads.protectedSongs == [401, 402, 403, 404])
    player.network = { .cellular }
    player.networkChanged(.cellular)
    await eventually { player.downloads.protectedSongs == [401, 402] }
    player.settings.offlineLimit = 0
    player.next()
    await eventually { player.downloads.protectedSongs == [402, 403] }
    #expect(player.downloads.protectedSongs == [402, 403])
  }

  @Test func downloadsLevelsPlayOfflineLevelled() throws {
    let directory = try folder(keeping: [])
    var manifest = OfflineManifest()
    manifest.pins["album:1"] = PinnedDownload(key: "album:1", title: "Dummy", href: "/albums/1", tracks: [song(1)], levels: ["rec-1": TrackLevel(track: -4)])
    JSONFile<OfflineManifest>(directory.appending(path: "offline.json")).write(manifest)
    let player = try Player.testing(directory: directory)
    #expect(player.levels.levels["rec-1"] == TrackLevel(track: -4))
  }
}
```

In `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/TrackSourceTests.swift`, replace:

```swift
  @Test func aFormatItCannotStreamPlaysFromTheLevelledStream() async throws {
```

with:

```swift
  @Test func aKeptSongPlaysWithTheServerOutOfReach() async throws {
    StubServer.serve("/stream/110", .init(body: Data(), unreachable: true))
    let directory = temporaryDirectory()
    try Data(contentsOf: AudioFiles.flac(seconds: 2)).write(to: directory.appending(path: "110.flac"))  // downloaded earlier
    let cache = StreamCache(directory: directory, retryDelay: .milliseconds(5), configuration: StubServer.configuration)
    let (kept, _) = source(110, from: 44_100, levelled: true, cache: cache)
    let pcm = try await readAll(kept)
    #expect(pcm.frames == 44_100)
    #expect(abs(pcm.left[0] - sine(44_100, 0)) < 1e-6)
    #expect(StubServer.requests("/stream/110").isEmpty)
    #expect(StubServer.requests("/stream/110/levelled.wav").isEmpty)
  }

  @Test func aFormatItCannotStreamPlaysFromTheLevelledStream() async throws {
```

Make these replacements in `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/FakeBackend.swift` (each `old` appears once).

1. A server out of reach for play reports:

   Replace:

```swift
  func reportPlays(_ reported: [PlayReport]) async throws { plays.withLock { $0 += reported } }
```

   with:

```swift
  /// False: the server can't be reached (play reports fail and wait).
  let reachable = Shared(true)
  func reportPlays(_ reported: [PlayReport]) async throws {
    guard reachable.value else { throw URLError(.notConnectedToInternet) }
    plays.withLock { $0 += reported }
  }
```

2. Test players get a fake background session and no settling:

   Replace:

```swift
    return try Player(
      backend: backend, directory: directory, settings: settings ?? PlaybackSettings(defaults: defaults),
      makeEngine: { try AudioEngine(manualRendering: true, makeSource: $0) },
      makeSource: { item, frame in SignalSource(seconds: item.track.duration, from: frame, signal: Signals.sine) })
```

   with:

```swift
    let player = try Player(
      backend: backend, directory: directory, settings: settings ?? PlaybackSettings(defaults: defaults),
      transport: FakeTransport(base: OfflineFolder(root: directory).base),
      makeEngine: { try AudioEngine(manualRendering: true, makeSource: $0) },
      makeSource: { item, frame in SignalSource(seconds: item.track.duration, from: frame, signal: Signals.sine) })
    player.settle = .zero
    return player
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter 'PlayarrPlayerTests\.(PlayerTests|PlayerOfflineTests|TrackSourceTests)'
```

Expected: the build fails with `extra argument 'transport' in call` and `value of type 'Player' has no member 'networkChanged'`.

**Step 3: Implement**

In `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/LevelStore.swift`, replace:

```swift
  /// The gain (dB) a song plays at with even volume on: nil when off or not measured yet (it plays as it is).
```

with:

```swift
  /// Levels known without asking (kept with downloads, for playing offline); levels already known stay.
  public func remember(_ known: [String: TrackLevel]) {
    levels.merge(known) { current, _ in current }
  }

  /// The gain (dB) a song plays at with even volume on: nil when off or not measured yet (it plays as it is).
```

Make these replacements in `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Player.swift` (each `old` appears once).

1. The store, next to the levels:

   Replace:

```swift
  public let settings: PlaybackSettings
  public let levels: LevelStore
```

   with:

```swift
  public let settings: PlaybackSettings
  public let levels: LevelStore
  /// Songs and transitions kept on this device for this account: downloads, and songs kept as you listen.
  public let downloads: DownloadStore
```

2. How long the queue settles before keep-ahead:

   Replace:

```swift
  @ObservationIgnored public var network: () -> NetworkKind = { .wifi }
```

   with:

```swift
  @ObservationIgnored public var network: () -> NetworkKind = { .wifi }
  /// How long the queue must stay put before keep-ahead fetches (tests: zero).
  @ObservationIgnored public var settle: Duration = KeepAhead.settle
```

3. Keep-ahead's state:

   Replace:

```swift
  @ObservationIgnored private var ticker: Task<Void, Never>?
```

   with:

```swift
  @ObservationIgnored private var ticker: Task<Void, Never>?
  @ObservationIgnored private var keepAheadTask: Task<Void, Never>?
  @ObservationIgnored private var keptAhead: [Track] = []
  @ObservationIgnored private var lastNetwork: NetworkKind = .wifi
```

4. The transport, the folder, the store made with the stream cache, and downloads' levels:

   Replace:

```swift
  /// `directory` is this server and account's folder in Application Support: the queue, unsent plays and the stream
  /// cache live there. `makeSource` replaces the real sources (tests); `makeEngine` the real engine.
  public init(
    backend: any PlayerBackend, directory: URL, settings: PlaybackSettings = PlaybackSettings(),
    makeEngine: (@MainActor (@escaping @MainActor (EngineItem, Int64) -> any PCMSource) throws -> AudioEngine)? = nil,
    makeSource: (@MainActor (EngineItem, Int64) -> any PCMSource)? = nil
  ) throws {
    let cache = StreamCache(directory: directory.appending(path: "stream", directoryHint: .isDirectory))
    let levels = LevelStore { ids in try await backend.levels(ids) }
```

   with:

```swift
  /// `directory` is this server and account's folder in Application Support: the queue, unsent plays, the stream
  /// cache and downloads live there. `transport` fetches downloads (the app's background session; a foreground one by
  /// default). `makeSource` replaces the real sources (tests); `makeEngine` the real engine.
  public init(
    backend: any PlayerBackend, directory: URL, settings: PlaybackSettings = PlaybackSettings(),
    transport: any DownloadTransport = URLSessionTransport(configuration: .default),
    makeEngine: (@MainActor (@escaping @MainActor (EngineItem, Int64) -> any PCMSource) throws -> AudioEngine)? = nil,
    makeSource: (@MainActor (EngineItem, Int64) -> any PCMSource)? = nil
  ) throws {
    let folder = OfflineFolder(root: directory)
    let cache = StreamCache(directory: folder.stream)
    let downloads = DownloadStore(folder: folder, settings: settings, cache: cache, transport: transport, backend: backend)
    let levels = LevelStore { ids in try await backend.levels(ids) }
    levels.remember(downloads.keptLevels)
```

5. Kept:

   Replace:

```swift
    self.levels = levels
    self.cache = cache
```

   with:

```swift
    self.levels = levels
    self.downloads = downloads
    self.cache = cache
```

6. Downloads' toasts are the Player's notices:

   Replace:

```swift
    engine.onEvent = { [weak self] in self?.handle($0) }
    sync()
    Task { await reports.retry() }
  }
```

   with:

```swift
    engine.onEvent = { [weak self] in self?.handle($0) }
    downloads.announce = { [weak self] text, isError in self?.notice = Notice(text: text, isError: isError) }
    sync()
    Task { await reports.retry() }
  }
```

7. The network changed:

   Replace:

```swift
  /// The app is closing: the song so far is reported (never as a skip), the queue saved.
```

   with:

```swift
  /// The network changed (NetworkMonitor): keep-ahead plans again, downloads wait or go on, play reports waiting go out
  /// once back online, and offline the next song joined is one on this device.
  public func networkChanged(_ kind: NetworkKind) {
    let wasOffline = lastNetwork == .offline
    lastNetwork = kind
    downloads.networkChanged(kind)
    if wasOffline && kind != .offline { Task { [reports] in await reports.retry() } }
    updateUpcoming()
    prefetch()
  }

  /// The app is closing: the song so far is reported (never as a skip), the queue saved.
```

8. Offline, loading a song not kept moves on to the next kept one:

   Replace:

```swift
  private func loadCurrent(_ entry: Entry?) {
    guard let entry, let track = queue.currentTrack else {
      tracker.finish(.changed)
      engine.stop()
      loaded = nil
      upcoming = nil
      (time, duration) = (0, 0)
      return
    }
```

   with:

```swift
  private func loadCurrent(_ entry: Entry?) {
    guard let entry, let track = queue.currentTrack else {
      tracker.finish(.changed)
      engine.stop()
      loaded = nil
      upcoming = nil
      (time, duration) = (0, 0)
      return
    }
    if network() == .offline, !downloads.isKept(track.fileId), skipToKept() { return loadCurrent(currentEntry) }
```

9. Offline, a song not kept isn't joined:

   Replace:

```swift
    guard let current = loaded, !sleep.endOfSong,
      let index = queue.repeatMode == .one ? current.entry.index : queue.upNextIndex
    else {
```

   with:

```swift
    guard let current = loaded, !sleep.endOfSong,
      let index = queue.repeatMode == .one ? current.entry.index : queue.upNextIndex,
      // Offline, a song not on this device isn't joined: the current one ends, and the next kept one is found then.
      network() != .offline || downloads.isKept(queue.queue[index].fileId)
    else {
```

10. Keep-ahead in place of phase 3's prefetch, and skipping to kept songs:

   Replace:

```swift
  private func prefetch() {
    let ahead = queue.upcoming(PrefetchPolicy.songsAhead(on: network()))
    let keep = Set((ahead + [queue.currentTrack].compactMap { $0 }).map(\.fileId))
    let requests = ahead.map { ($0, backend.streamRequest($0)) }
    Task { [cache] in
      await cache.keepOnly(keep)
      await cache.prefetch(requests)
    }
  }
```

   with:

```swift
  /// What plays now and next: read by the engine, so never dropped or stopped, whatever the limit.
  private var playingSongs: [Track] { [queue.currentTrack, queue.upNext].compactMap { $0 } }

  /// Keep ahead (apps/web/src/player/loadAhead.ts): what plays now and next is protected at once; once the queue has
  /// settled, the plan for this network is too, and the stream cache fetches what of it isn't here, one at a time.
  private func prefetch() {
    downloads.protect(Set((playingSongs + keptAhead).map(\.fileId)))
    keepAheadTask?.cancel()
    keepAheadTask = Task { [weak self, settle] in
      if settle > .zero { try? await Task.sleep(for: settle) }
      guard !Task.isCancelled else { return }
      self?.keepAhead()
    }
  }

  private func keepAhead() {
    keptAhead = KeepAhead.plan(queue, network: network(), limit: settings.offlineLimit)
    let keep = Set((playingSongs + keptAhead).map(\.fileId))
    downloads.protect(keep)
    let requests = keptAhead.filter { !downloads.isKept($0.fileId) }.map { ($0, backend.streamRequest($0)) }
    Task { [cache] in
      await cache.keepOnly(keep)
      await cache.prefetch(requests)
    }
  }

  /// Offline, a song not on this device can't play: on to the next one that is, with the web's toast. False online,
  /// or when none is.
  private func skipToKept() -> Bool {
    guard network() == .offline, let p = OfflinePlayback.nextKept(in: queue, isKept: downloads.isKept) else { return false }
    let playing = queue.playing
    queue.jumpTo(p)
    queue.playing = playing
    notice = Notice(text: OfflinePlayback.skippedNotice, isError: false)
    return true
  }
```

11. A song breaking off offline moves on to a kept one:

   Replace:

```swift
    case .failed(let id, let failure):
      guard loaded?.item.id == id else { return }
      error = failure.message
```

   with:

```swift
    case .failed(let id, let failure):
      guard loaded?.item.id == id else { return }
      if skipToKept() { return sync() }
      error = failure.message
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter 'PlayarrPlayerTests\.(PlayerTests|PlayerOfflineTests|TrackSourceTests)'
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer
```

Expected: `Test run with 26 tests` … `passed` (phase 3's 13 Player and 6 TrackSource tests still pass with the store in the Player); then the whole package passes with 63 more tests than at Task 0.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Player.swift \
  apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/LevelStore.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/FakeBackend.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/TrackSourceTests.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/PlayerOfflineTests.swift
git commit -F - <<'EOF'
Keep the next songs as the web does, and play offline: kept songs only, with the web's toast

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

### Task 11: The live player: network, background session, app life

`Player.live` uses the background session, tells the player when the network changes, and tells downloads when the app goes to the background and comes back. Nothing here runs in `swift test` (UIKit's notifications, a background session); the check is building for the Mac and the simulator.

**Files:**
- Modify: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/NetworkMonitor.swift`
- Modify: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PlayerLive.swift`

**Step 1: Implement**

In `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/NetworkMonitor.swift`, replace:

```swift
  public private(set) var kind: NetworkKind = .wifi
  @ObservationIgnored private let monitor = NWPathMonitor()

  public init() {
    monitor.pathUpdateHandler = { [weak self] path in
      let kind = NetworkKind(path)
      Task { @MainActor in self?.kind = kind }
    }
```

with:

```swift
  public private(set) var kind: NetworkKind = .wifi
  /// Called on the main actor when the kind changes.
  @ObservationIgnored public var onChange: (@MainActor (NetworkKind) -> Void)?
  @ObservationIgnored private let monitor = NWPathMonitor()

  public init() {
    monitor.pathUpdateHandler = { [weak self] path in
      let kind = NetworkKind(path)
      Task { @MainActor in
        guard let self, self.kind != kind else { return }
        self.kind = kind
        self.onChange?(kind)
      }
    }
```

Make these replacements in `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PlayerLive.swift` (each `old` appears once).

1. The background session:

   Replace:

```swift
  /// The player as the app runs it: lock-screen controls and Now Playing, the audio session (iOS), the network for
  /// prefetching, its 10 Hz clock, and a last report when the app is closed.
  public static func live(backend: any PlayerBackend, directory: URL, settings: PlaybackSettings = PlaybackSettings()) throws -> Player {
    let player = try Player(backend: backend, directory: directory, settings: settings)
```

   with:

```swift
  /// The player as the app runs it: lock-screen controls and Now Playing, the audio session (iOS), the network for
  /// keeping ahead, offline playback and downloads, downloads on the app's background session, its 10 Hz clock, and a
  /// last report when the app is closed.
  public static func live(
    backend: any PlayerBackend, directory: URL, settings: PlaybackSettings = PlaybackSettings(),
    transport: any DownloadTransport = URLSessionTransport.background
  ) throws -> Player {
    let player = try Player(backend: backend, directory: directory, settings: settings, transport: transport)
```

2. Network changes:

   Replace:

```swift
    let network = NetworkMonitor()
    player.network = { network.kind }
```

   with:

```swift
    let network = NetworkMonitor()
    player.network = { network.kind }
    network.onChange = { [weak player] in player?.networkChanged($0) }
```

3. The app going to the background and back:

   Replace:

```swift
      NotificationCenter.default.addObserver(forName: UIApplication.willTerminateNotification, object: nil, queue: .main) { [weak player] _ in
        MainActor.assumeIsolated { player?.appWillTerminate() }
      }
```

   with:

```swift
      NotificationCenter.default.addObserver(forName: UIApplication.willTerminateNotification, object: nil, queue: .main) { [weak player] _ in
        MainActor.assumeIsolated { player?.appWillTerminate() }
      }
      // Going to the background (inactive comes first, while new tasks still start at once): downloads hand the
      // system more songs, so they go on with the app closed.
      NotificationCenter.default.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak player] _ in
        MainActor.assumeIsolated { player?.downloads.appMovedToBackground() }
      }
      NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak player] _ in
        MainActor.assumeIsolated { player?.downloads.appBecameActive() }
      }
```

**Step 2: Build for the Mac and the simulator**

```bash
swift build --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer
swift build --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --triple arm64-apple-ios26.0-simulator --sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" --scratch-path /tmp/playarr-player-ios
```

Expected: both `Build complete!` (the second compiles the UIKit branch).

**Step 3: Commit**

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/NetworkMonitor.swift \
  apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PlayerLive.swift
git commit -F - <<'EOF'
Run the live player's downloads on the background session, following the network and the app's life

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

### Task 12: The app delegate for background downloads

The app target makes the background session at launch (so a relaunch for finished downloads reconnects to it) and keeps the system's completion handler until the session has handed over every event. No capability is needed (conventions: background mode audio only).

**Files:**
- Create: `apps/ios/Playarr/AppDelegate.swift`
- Modify: `apps/ios/Playarr/PlayarrApp.swift`

**Step 1: Implement**

`apps/ios/Playarr/AppDelegate.swift`:

```swift
import PlayarrPlayer
import UIKit

/// The app's side of downloads on the background session: the session is made at launch, so a relaunch for finished
/// downloads reconnects to it, and the system's completion handler is called once it has handed over every event.
final class AppDelegate: NSObject, UIApplicationDelegate {
  private var finishBackgroundEvents: (() -> Void)?

  func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    _ = URLSessionTransport.background
    return true
  }

  func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String, completionHandler: @escaping () -> Void) {
    guard identifier == URLSessionTransport.backgroundIdentifier else { return completionHandler() }
    finishBackgroundEvents = completionHandler
    URLSessionTransport.background.whenEventsFinish {
      Task { @MainActor [weak self] in
        self?.finishBackgroundEvents?()
        self?.finishBackgroundEvents = nil
      }
    }
  }
}
```

In `apps/ios/Playarr/PlayarrApp.swift` (phase 4's), add the adaptor as the first line inside `struct PlayarrApp: App {`:

```swift
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
```

(`UIApplicationDelegateAdaptor` comes with SwiftUI, which the file imports.)

**Step 2: Build the app**

```bash
make -C apps/ios build
```

Expected: `** BUILD SUCCEEDED **`.

**Step 3: Commit**

```bash
git add apps/ios/Playarr/AppDelegate.swift apps/ios/Playarr/PlayarrApp.swift
git commit -F - <<'EOF'
Hand finished background downloads to the app when the system relaunches it

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

### Task 13: The player plays kept transitions (phase 5's planner)

The store gives the planner a transition file by the answer's URL (online too: the names are content keys, so a pair asked at the same gains gets the same file), and the planner tells the store which pair it's asking about. The first part is tested here; the planner edits are written against phase 5's assumed names.

**Files:**
- Modify: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/DownloadStore.swift`
- Modify: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/DownloadTransitionTests.swift`
- Modify: phase 5's planner (`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/TransitionPlanner.swift`, or wherever Task 0 found it) and the Player where it makes the planner

**Step 1: Write the failing test**

In `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/DownloadTransitionTests.swift`, replace:

```swift
    // Its files gone: none.
```

with:

```swift
    // The player asking online gets the same answer: its files play from here.
    #expect(rig.store.keptTransitionFile("/transitions/4-5.rest.flac") == rig.folder.transitions.appending(path: "4-5.rest.flac"))
    #expect(rig.store.keptTransitionFile("/transitions/9-9.flac") == nil)
    // Its files gone: none.
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter DownloadTransitionTests
```

Expected: the build fails with `value of type 'DownloadStore' has no member 'keptTransitionFile'`.

**Step 3: Implement the lookup**

In `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/DownloadStore.swift`, replace:

```swift
  // MARK: Changing
```

with:

```swift
  /// A transition file kept with a download, by the `url` (or `continuationUrl`) of the server's answer: the player
  /// plays it from here rather than downloading it again, online too (the names are content keys).
  public func keptTransitionFile(_ url: String) -> URL? {
    let name = KeptTransition.fileName(url)
    return manifest.transitionFiles[name].map { folder.url($0.file) }
  }

  // MARK: Changing
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter DownloadTransitionTests
```

Expected: `Test run with 9 tests` … `passed`.

**Step 5: The planner (phase 5's code)**

Phase 5's planner follows `transitions.ts`: for the current pair it asks after 5 s played, polls, gives up 20 s before the mix point, downloads a ready answer's file (and `continuationUrl`) whole, then schedules it. It needs the player's `downloads` (pass `player.downloads`, or a `DownloadStore` in its init, where the Player makes it). Three changes, whatever its names:

1. **Before asking** (the web's `maybeAsk`, `transitions.ts:170-180`), with `online = network() != .offline`, `time` the seconds played of A, and `levelled` true when the player plays both songs at even-volume gains (even volume on and both levels known, i.e. it would send `levels`):

```swift
    let kept = OfflinePlayback.useKept(
      downloads.keptTransition(from: pair.from, to: pair.to, mode: pair.mode, online: online, levelled: levelled),
      online: online, time: time)
    if let kept {
      // As a ready answer, with nothing to download: its files are on this device.
      return answered(.ready(kept.transition.answer))
    }
    guard online else { return }  // offline, nothing to ask
```

2. **Where it downloads a ready answer's files**, before downloading each path:

```swift
    if let local = downloads.keptTransitionFile(path) { return local }
```

3. **When its pair changes** (a new pair, or none): set `downloads.playerPair` once where the planner is made, and tell the store on each change:

```swift
    downloads.playerPair = { [weak planner] in planner?.currentPair.map { (fromFileId: $0.from.fileId, toFileId: $0.to.fileId) } }
    // … and wherever the planner's current pair is set or cleared:
    downloads.playerMoved()
```

Run phase 5's planner tests and the whole package:

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer
```

Expected: everything passes (63 more tests than at Task 0, plus any phase 5 planner test you added).

**Step 6: Commit**

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/DownloadTransitionTests.swift
git commit -F - <<'EOF'
Play transitions kept with downloads, offline and online, and leave the player's pair to the player

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

### Task 14: The words of the download screens

Every string the download screens show, worked out apart from the views and tested: the button's label, the Downloads rows, On this device, the no-room alert, the sign-out question.

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Downloads/OfflineWording.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/OfflineWordingTests.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/OfflineWordingTests.swift`:

```swift
import Foundation
import PlayarrAPI
import PlayarrPlayer
import Testing
@testable import PlayarrUI

struct OfflineWordingTests {
  let mb = OfflineLimit.megabyte

  @Test func theDownloadButtonSaysWhereItIs() {
    #expect(OfflineWording.phase(nil) == .notDownloaded)
    #expect(OfflineWording.phase(DownloadProgress(done: 3, total: 12, bytes: 0)) == .downloading(done: 3, total: 12))
    #expect(OfflineWording.phase(DownloadProgress(done: 12, total: 12, bytes: 0)) == .downloaded)
    #expect(OfflineWording.buttonLabel(.notDownloaded, title: "Mezzanine") == "Download Mezzanine")
    #expect(OfflineWording.buttonLabel(.downloading(done: 3, total: 12), title: "Mezzanine") == "Downloading, 3 of 12: remove Mezzanine from this device")
    #expect(OfflineWording.buttonLabel(.downloaded, title: "Mezzanine") == "Downloaded: remove Mezzanine from this device")
    #expect(OfflineWording.phase(DownloadProgress(done: 3, total: 12, bytes: 0)).fraction == 0.25)
    #expect(OfflineWording.noRoomMessage("Mezzanine", needed: 480 * mb, free: 120 * mb)
      == "Mezzanine needs 480 MB, and 120 MB is free. Remove some downloads in Library → Downloads.")
  }

  @Test func aDownloadsRowCountsSongsBytesAndFailures() {
    let d = PinnedDownload(key: "album:1", title: "Mezzanine", subtitle: "Massive Attack", href: "/albums/1", tracks: [])
    #expect(OfflineWording.rowDetail(d, DownloadProgress(done: 11, total: 11, bytes: 484 * mb)) == "Massive Attack · 11 songs · 484 MB")
    #expect(OfflineWording.rowDetail(d, DownloadProgress(done: 3, total: 11, bytes: 132 * mb)) == "Massive Attack · 3 of 11 songs · 132 MB")
    var mix = d
    mix.subtitle = nil
    #expect(OfflineWording.rowDetail(mix, DownloadProgress(done: 1, total: 1, bytes: 40 * mb)) == "1 song · 40 MB")
    #expect(OfflineWording.failures(2) == " · 2 couldn’t download")
    #expect(OfflineWording.failures(0) == "")
  }

  @Test func onThisDeviceCountsWhatsKeptAgainstTheLimit() {
    #expect(OfflineWording.headline(count: 12, limit: 2 * OfflineLimit.gigabyte) == "12 songs")
    #expect(OfflineWording.headline(count: 12, limit: 0) == "Off")
    #expect(OfflineWording.usage(bytes: 640 * mb, limit: 2 * OfflineLimit.gigabyte) == "640 MB of 2 GB")
    #expect(OfflineWording.usage(bytes: 640 * mb, limit: 0) == nil)
    #expect(OfflineWording.downloadsLine(count: 3, bytes: 1536 * mb)?.link == "3 downloads")
    #expect(OfflineWording.downloadsLine(count: 3, bytes: 1536 * mb)?.rest == " (1.5 GB), kept until you remove them.")
    #expect(OfflineWording.downloadsLine(count: 0, bytes: 0) == nil)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter OfflineWordingTests
```

Expected: the build fails with `cannot find 'OfflineWording' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Downloads/OfflineWording.swift` (if phase 4 already ported `plural` from `format.ts`, call it from `count` instead):

```swift
import Foundation
import PlayarrAPI
import PlayarrPlayer

/// The words of the web's download screens (DownloadButton.tsx, pages/Downloads.tsx, OfflineStorage.tsx), worked out
/// apart from the views so they're tested.
enum OfflineWording {
  /// "1 song", "12 songs" (`plural` in apps/web/src/lib/format.ts).
  static func count(_ n: Int, _ word: String) -> String { "\(n) \(n == 1 ? word : word + "s")" }

  // MARK: The Download button

  enum ButtonPhase: Equatable {
    case notDownloaded
    case downloading(done: Int, total: Int)
    case downloaded

    var fraction: Double {
      if case .downloading(let done, let total) = self, total > 0 { return Double(done) / Double(total) }
      return self == .downloaded ? 1 : 0
    }
  }

  static func phase(_ progress: DownloadProgress?) -> ButtonPhase {
    guard let progress else { return .notDownloaded }
    return progress.isComplete ? .downloaded : .downloading(done: progress.done, total: progress.total)
  }

  static func buttonLabel(_ phase: ButtonPhase, title: String) -> String {
    switch phase {
    case .notDownloaded: "Download \(title)"
    case .downloaded: "Downloaded: remove \(title) from this device"
    case .downloading(let done, let total): "Downloading, \(done) of \(total): remove \(title) from this device"
    }
  }

  static func started(_ title: String) -> String { "Downloading \(title)" }
  static func removed(_ title: String) -> String { "\(title) removed from this device" }
  static func noRoomMessage(_ title: String, needed: Int64, free: Int64) -> String {
    "\(title) needs \(ByteCount.format(needed)), and \(ByteCount.format(free)) is free. Remove some downloads in Library → Downloads."
  }

  // MARK: Library → Downloads

  static let emptyDownloads =
    "Nothing downloaded yet. Tap the download button on an album, playlist, mix or Favorites to keep it on this device and play it without a connection."

  /// "Massive Attack · 3 of 11 songs · 132 MB", without the failures.
  static func rowDetail(_ d: PinnedDownload, _ progress: DownloadProgress) -> String {
    let songs = progress.isComplete ? count(progress.total, "song") : "\(progress.done) of \(count(progress.total, "song"))"
    return (d.subtitle.map { "\($0) · " } ?? "") + "\(songs) · \(ByteCount.format(progress.bytes))"
  }

  /// " · 2 couldn’t download", or nothing.
  static func failures(_ n: Int) -> String { n > 0 ? " · \(n) couldn’t download" : "" }

  // MARK: Settings → Playback → On this device

  static let explanation =
    "As you listen, the next songs in your queue are saved here, so they start instantly and keep playing without a connection. When space runs out, the songs you played longest ago make room."

  static func headline(count: Int, limit: Int64) -> String { limit > 0 ? self.count(count, "song") : "Off" }
  static func usage(bytes: Int64, limit: Int64) -> String? { limit > 0 ? "\(ByteCount.format(bytes)) of \(ByteCount.format(limit))" : nil }
  /// "Plus 3 downloads (4.2 GB), kept until you remove them." — the link is the first part.
  static func downloadsLine(count n: Int, bytes: Int64) -> (link: String, rest: String)? {
    n > 0 ? (count(n, "download"), " (\(ByteCount.format(bytes))), kept until you remove them.") : nil
  }

  // MARK: Signing out

  static func signOutMessage(name: String, downloads: Int, bytes: Int64) -> String {
    downloads > 0
      ? "\(count(downloads, "download")) and other songs kept for \(name) take \(ByteCount.format(bytes)) on this device."
      : "Songs kept for \(name) take \(ByteCount.format(bytes)) on this device."
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter OfflineWordingTests
```

Expected: `Test run with 3 tests` … `passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Downloads/OfflineWording.swift \
  apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/OfflineWordingTests.swift
git commit -F - <<'EOF'
Word the download screens as the web does

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

### Task 15: The download views

`DownloadButton` (progress ring, remove on a second tap, the room check before starting, a changed playlist downloads what it has now), `OfflineMark` (on this device, or a ring while downloading), `DownloadsView` (each download with progress, bytes, failed songs, Play, Remove; the web's empty text), `OfflineStorageSection` (On this device: kept songs against the limit, downloads' share with a link, keep up to, mobile data, Remove all). The views take what they need from phase 4 as arguments (a cover view, how to open an href, how to play), so they build on their own.

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Downloads/ProgressRing.swift`
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Downloads/DownloadButton.swift`
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Downloads/OfflineMark.swift`
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Downloads/DownloadsView.swift`
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Downloads/OfflineStorageSection.swift`

**Step 1: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Downloads/ProgressRing.swift`:

```swift
import SwiftUI

/// A thin ring filling clockwise from the top (the web's progress circles).
struct ProgressRing: View {
  let fraction: Double
  var lineWidth: CGFloat = 2

  var body: some View {
    ZStack {
      Circle().stroke(.secondary.opacity(0.3), lineWidth: lineWidth)
      Circle()
        .trim(from: 0, to: max(0.001, min(1, fraction)))
        .stroke(.tint, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
        .rotationEffect(.degrees(-90))
        .animation(.easeOut(duration: 0.3), value: fraction)
    }
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Downloads/DownloadButton.swift`:

```swift
import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// What a page downloads: an album, playlist, mix or Favorites, with the keys the web uses (`PinnedDownload.Key`).
public struct DownloadItem: Sendable, Equatable {
  public var key: String
  public var title: String
  public var subtitle: String?
  public var coverUrl: String?
  public var href: String

  public init(key: String, title: String, subtitle: String? = nil, coverUrl: String? = nil, href: String) {
    self.key = key
    self.title = title
    self.subtitle = subtitle
    self.coverUrl = coverUrl
    self.href = href
  }
}

/// Download an album, playlist, mix or Favorites to this device, to play without a connection; shows how far along it
/// is, and removes it when tapped again (apps/web/src/components/DownloadButton.tsx). Before starting, it checks the
/// songs fit on the device.
public struct DownloadButton: View {
  let store: DownloadStore
  let item: DownloadItem
  let tracks: [Track]
  @State private var shortOfRoom: (needed: Int64, free: Int64)?

  public init(store: DownloadStore, item: DownloadItem, tracks: [Track]) {
    self.store = store
    self.item = item
    self.tracks = tracks
  }

  private var songs: [Track] { tracks.filter { $0.fileId > 0 } }
  private var phase: OfflineWording.ButtonPhase { OfflineWording.phase(store.progress(of: item.key)) }
  /// The page's songs: a playlist edited (or an album changed) since it was downloaded downloads what it has now.
  private var signature: [Int] { songs.map(\.fileId) }

  public var body: some View {
    Button(action: toggle) {
      Group {
        switch phase {
        case .notDownloaded: Image(systemName: "arrow.down.to.line")
        case .downloaded: Image(systemName: "checkmark.circle")
        case .downloading: ProgressRing(fraction: phase.fraction).frame(width: 20, height: 20)
        }
      }
      .font(.title3)
      .frame(width: 48, height: 48)
      .overlay(Circle().stroke(.secondary.opacity(0.3)))
      .foregroundStyle(phase == .notDownloaded ? AnyShapeStyle(.primary) : AnyShapeStyle(.tint))
    }
    .buttonStyle(.plain)
    .disabled(songs.isEmpty)
    .accessibilityLabel(OfflineWording.buttonLabel(phase, title: item.title))
    .accessibilityAddTraits(phase == .notDownloaded ? [] : .isSelected)
    .task(id: signature) {
      if let pinned = store.download(item.key), pinned.tracks.map(\.fileId) != signature { add() }
    }
    .alert(
      OfflineRules.noRoom, isPresented: Binding(get: { shortOfRoom != nil }, set: { if !$0 { shortOfRoom = nil } }),
      presenting: shortOfRoom
    ) { _ in
      Button("OK", role: .cancel) {}
    } message: { room in
      Text(OfflineWording.noRoomMessage(item.title, needed: room.needed, free: room.free))
    }
  }

  private func toggle() {
    if store.download(item.key) != nil {
      store.remove(item.key)
      store.announce(OfflineWording.removed(item.title), false)
      return
    }
    if case .short(let needed, let free) = store.room(for: songs) {
      shortOfRoom = (needed, free)
      return
    }
    add()
    store.announce(OfflineWording.started(item.title), false)
  }

  private func add() {
    store.add(key: item.key, title: item.title, subtitle: item.subtitle, coverUrl: item.coverUrl, href: item.href, tracks: songs)
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Downloads/OfflineMark.swift`:

```swift
import PlayarrPlayer
import SwiftUI

/// Shows that a song is on this device, or how far along its download is (apps/web/src/components/OfflineMark.tsx).
public struct OfflineMark: View {
  let store: DownloadStore
  let fileId: Int

  public init(store: DownloadStore, fileId: Int) {
    self.store = store
    self.fileId = fileId
  }

  public var body: some View {
    if let active = store.active, active.fileId == fileId {
      ProgressRing(fraction: active.fraction, lineWidth: 1.75)
        .frame(width: 14, height: 14)
        .accessibilityElement()
        .accessibilityLabel("Downloading, \(Int((active.fraction * 100).rounded()))%")
    } else if store.isKept(fileId) {
      Image(systemName: "arrow.down.circle.fill")
        .font(.caption)
        .foregroundStyle(.tint.opacity(0.8))
        .accessibilityLabel("On this device")
    }
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Downloads/DownloadsView.swift`:

```swift
import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// Library → Downloads: albums, playlists, mixes and Favorites on this device, playable without a connection
/// (apps/web/src/pages/Downloads.tsx). Each with its progress, size, Play, Remove and the songs that couldn't download.
public struct DownloadsView<Cover: View>: View {
  let store: DownloadStore
  let play: (PinnedDownload) -> Void
  let open: (String) -> Void
  let cover: (String?) -> Cover

  /// `play` plays a download's songs (from its page's source); `open` goes to its page by href; `cover` draws a cover
  /// from its server path (phase 4's artwork view).
  public init(
    store: DownloadStore, play: @escaping (PinnedDownload) -> Void, open: @escaping (String) -> Void,
    @ViewBuilder cover: @escaping (String?) -> Cover
  ) {
    self.store = store
    self.play = play
    self.open = open
    self.cover = cover
  }

  public var body: some View {
    let downloads = store.downloads
    Group {
      if downloads.isEmpty {
        ContentUnavailableView {
          Label("Nothing downloaded yet", systemImage: "arrow.down.circle")
        } description: {
          Text(OfflineWording.emptyDownloads)
        }
      } else {
        List(downloads) { d in
          row(d)
        }
        .listStyle(.plain)
      }
    }
    .navigationTitle("Downloads")
  }

  private func row(_ d: PinnedDownload) -> some View {
    let progress = store.progress(of: d.key) ?? DownloadProgress(done: 0, total: d.tracks.count, bytes: 0)
    let failed = store.failedCount(of: d.key)
    return HStack(spacing: 14) {
      Button { open(d.href) } label: {
        cover(d.coverUrl)
          .frame(width: 56, height: 56)
          .clipShape(RoundedRectangle(cornerRadius: 4))
      }
      .buttonStyle(.plain)
      .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 4) {
        Button(d.title) { open(d.href) }
          .buttonStyle(.plain)
          .lineLimit(1)
        Text("\(OfflineWording.rowDetail(d, progress))\(Text(OfflineWording.failures(failed)).foregroundStyle(.red.opacity(0.8)))")
          .font(.footnote)
          .foregroundStyle(.secondary)
          .lineLimit(1)
        if !progress.isComplete {
          ProgressView(value: Double(progress.done), total: Double(max(1, progress.total)))
            .frame(maxWidth: 192)
        }
      }
      Spacer(minLength: 0)
      Button { play(d) } label: {
        Image(systemName: "play.fill").frame(width: 40, height: 40).background(.tint, in: Circle()).foregroundStyle(.white)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Play \(d.title)")
      Button { store.remove(d.key) } label: {
        Image(systemName: "trash").frame(width: 40, height: 40)
      }
      .buttonStyle(.plain)
      .foregroundStyle(.secondary)
      .accessibilityLabel("Remove \(d.title) from this device")
    }
    .swipeActions {
      Button("Remove", role: .destructive) { store.remove(d.key) }
    }
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Downloads/OfflineStorageSection.swift` ("Remove all" asks first: on a phone it can take gigabytes of downloads with one tap; the web removes at once):

```swift
import PlayarrPlayer
import SwiftUI

/// Settings → Playback → On this device: what's kept, how much may be, a way to free the space, and whether downloads
/// may use mobile data (apps/web/src/components/OfflineStorage.tsx; the mobile-data switch is the app's own).
public struct OfflineStorageSection: View {
  @Bindable var store: DownloadStore
  let openDownloads: () -> Void
  @State private var confirmingRemoveAll = false

  public init(store: DownloadStore, openDownloads: @escaping () -> Void) {
    self.store = store
    self.openDownloads = openDownloads
  }

  public var body: some View {
    let kept = store.keptAsYouListen
    let limit = store.limit
    let downloads = store.manifest.pins.count
    Section {
      VStack(alignment: .leading, spacing: 8) {
        HStack(alignment: .firstTextBaseline) {
          Label(OfflineWording.headline(count: kept.count, limit: limit), systemImage: "internaldrive")
          Spacer()
          if let usage = OfflineWording.usage(bytes: kept.bytes, limit: limit) {
            Text(usage).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
          }
        }
        if limit > 0 {
          ProgressView(value: Double(min(kept.bytes, limit)), total: Double(limit))
            .accessibilityLabel("Space used")
        }
      }
      if let line = OfflineWording.downloadsLine(count: downloads, bytes: store.downloadsBytes) {
        Button(action: openDownloads) {
          Text("Plus \(Text(line.link).foregroundStyle(.tint))\(line.rest)")
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
        .buttonStyle(.plain)
      }
      Picker("Keep up to", selection: $store.limit) {
        ForEach(OfflineLimit.options, id: \.self) { Text(OfflineLimit.label($0)).tag($0) }
      }
      Toggle("Allow downloads on mobile data", isOn: $store.cellularDownloads)
      if kept.count > 0 || downloads > 0 {
        Button("Remove all", role: .destructive) { confirmingRemoveAll = true }
          .confirmationDialog("Remove all songs and downloads from this device?", isPresented: $confirmingRemoveAll, titleVisibility: .visible) {
            Button("Remove all", role: .destructive) { store.removeAll() }
          }
      }
    } header: {
      Text("On this device")
    } footer: {
      Text(OfflineWording.explanation + " Downloads wait for Wi-Fi unless mobile data is allowed.")
    }
  }
}
```

**Step 2: Build for the Mac and the simulator**

```bash
swift build --disable-sandbox --package-path apps/ios/Packages/PlayarrUI
swift build --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --triple arm64-apple-ios26.0-simulator --sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" --scratch-path /tmp/playarr-ui-ios
```

Expected: both `Build complete!`.

**Step 3: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Downloads
git commit -F - <<'EOF'
Add the Download button, the offline mark, Library → Downloads and On this device

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

### Task 16: On the pages

Put the views where the web has them. The pages have `@Environment(AccountSession.self) private var session` (phase 4); the store is `session.player.downloads`. The `DownloadItem` values are the web's (`Album.tsx:111-114`, `Playlist.tsx:139-142`, `Mix.tsx:88-91`, `Favorites.tsx:53`).

**Files:**
- Modify: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/Route.swift` and `RouteDestination.swift` (phase 4's; `grep -rln "enum Route\|struct RouteDestination"` if they moved)
- Modify: phase 4's `AlbumView`, `LibraryView`, `TrackRow`, `QueueView`, `NowPlayingView`, `PlaybackPanel`, `SettingsPanelView`
- Modify: phase 6's Favorites, Playlist and Mix pages

**Step 1: A route for Library → Downloads**

In phase 4's `Route`, add `case downloads` after `case listening`; in `Route.init?(href:)`, add `case ("downloads", 1): self = .downloads` before its `default`; in `RouteDestination`'s switch:

```swift
    case .downloads:
      DownloadsView(
        store: session.player.downloads,
        play: { d in session.player.play(d.tracks, source: PlaySource(label: d.title, href: d.href)) },
        open: { session.router.open(href: $0) }
      ) { path in
        Cover(path: path, points: 56)
      }
```

(If `Route` has a test that lists every web path, add `"/downloads"` there.)

**Step 2: The Library row**

In `LibraryView`, add `@Environment(AccountSession.self) private var session` and, after the Favorites row:

```swift
        let downloads = session.player.downloads.manifest.pins.count
        if downloads > 0 { row("Downloads", "arrow.down.circle", .downloads, detail: String(downloads)) }
```

(The web shows the row with its count; hidden while there's nothing, as phase 4 hides empty sections.)

**Step 3: The Download buttons**

`AlbumView`, replacing the marker in its action row:

```swift
      DownloadButton(
        store: session.player.downloads,
        item: DownloadItem(
          key: PinnedDownload.Key.album(album.id), title: album.title, subtitle: album.artistName, coverUrl: album.coverUrl,
          href: "/albums/\(album.id)"),
        tracks: album.tracks)
      // Phase 8: Request the rest.
```

Phase 6's Playlist page, after Shuffle (the songs are the playable ones, as the web's `playable`):

```swift
      DownloadButton(
        store: session.player.downloads,
        item: DownloadItem(
          key: PinnedDownload.Key.playlist(playlist.id), title: playlist.name, subtitle: "Playlist", coverUrl: playlist.cover.url,
          href: "/playlists/\(playlist.id)"),
        tracks: playlist.items.compactMap(\.track))
```

Phase 6's Mix page, after New mix:

```swift
      DownloadButton(
        store: session.player.downloads,
        item: DownloadItem(key: PinnedDownload.Key.mix(mix.key), title: mix.title, subtitle: "Mix", coverUrl: mix.covers.first, href: "/mixes/\(mix.key)"),
        tracks: mix.tracks)
```

Phase 6's Favorites page, after Shuffle (its songs as `[Track]`, whatever phase 6 calls them):

```swift
      DownloadButton(
        store: session.player.downloads,
        item: DownloadItem(key: PinnedDownload.Key.favorites, title: "Favorites", subtitle: "Your favorite songs", href: "/favorites"),
        tracks: favorites)
```

If phase 6 hasn't landed, leave a `// Phase 7: Download (see the phase 7 plan, Task 16)` comment in its placeholders instead, and do this step with phase 6.

**Step 4: The offline mark**

In `TrackRow`, before `Spacer(minLength: 8)`:

```swift
          OfflineMark(store: session.player.downloads, fileId: track.fileId)
```

and the same line after the title of `QueueView`'s rows (the current song and each upcoming `song`, with `fileId: song.fileId`) and of Now Playing's up-next list (`NowPlaying.tsx:230`, `Queue.tsx:74, 191` on the web).

**Step 5: Settings → Playback → On this device**

`PlaybackPanel` gains two properties after `settings`:

```swift
  var downloads: DownloadStore?
  var openDownloads: () -> Void = {}
```

and, as the last section of its `Form`:

```swift
      if let downloads {
        OfflineStorageSection(store: downloads, openDownloads: openDownloads)
      }
```

Where `SettingsPanelView` makes the panel, pass `downloads: session.player.downloads, openDownloads: { session.router.open(.downloads) }`. Delete the panel comment's "\"On this device\" storage comes in phase 7."

**Step 6: Build, test and look**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI
make -C apps/ios build
```

Expected: the tests pass (phase 4's page-model tests are unaffected) and `** BUILD SUCCEEDED **`. In the simulator signed in to the dev server: an album shows the download button; tapping it toasts "Downloading <title>", the ring fills song by song, the rows get the mark; Library shows "Downloads 1"; Settings → Playback ends with On this device.

**Step 7: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI
git commit -F - <<'EOF'
Put the download button on albums, playlists, mixes and Favorites, the offline mark on songs, and Library → Downloads

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

### Task 17: Downloaded pages browse offline

Phase 4's `QueryCache` keeps the web's families (`album`, `playlist`, `mixes`, `favorites`, …) for 7 days. A downloaded collection's page must stay as long as the download, and a downloaded mix's page too (the web doesn't keep `mix` pages).

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Downloads/DownloadedPages.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/DownloadedPagesTests.swift`
- Modify: phase 4's `QueryKey`/`QueryCache` (`Data/QueryCache.swift`), `AccountSession.swift`, the root view, and `QueryCacheTests.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/DownloadedPagesTests.swift`:

```swift
import PlayarrPlayer
import Testing
@testable import PlayarrUI

struct DownloadedPagesTests {
  @Test func aDownloadKeepsItsPageAndTheListLeadingToIt() {
    func keys(_ key: String) -> [[String]] { PinnedDownload(key: key, title: "", href: "", tracks: []).pageKeys }
    #expect(keys(PinnedDownload.Key.album(12)) == [["album", "12"], ["albums"]])
    #expect(keys(PinnedDownload.Key.playlist(3)) == [["playlist", "3"], ["playlists"]])
    #expect(keys(PinnedDownload.Key.mix("genre-electronic")) == [["mix", "genre-electronic"], ["mixes"]])
    #expect(keys(PinnedDownload.Key.favorites) == [["favorites"]])
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter DownloadedPagesTests
```

Expected: the build fails with `value of type 'PinnedDownload' has no member 'pageKeys'`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Downloads/DownloadedPages.swift`:

```swift
import PlayarrPlayer
import SwiftUI

extension PinnedDownload {
  /// The library pages a download needs to be browsed offline, by the web's query keys (apps/web/src/lib/queries.ts):
  /// its own page and the list that leads to it. Mix pages aren't among the web's kept families; a downloaded one is.
  public var pageKeys: [[String]] {
    let parts = key.split(separator: ":", maxSplits: 1).map(String.init)
    switch (parts.first, parts.count) {
    case ("album", 2): return [["album", parts[1]], ["albums"]]
    case ("playlist", 2): return [["playlist", parts[1]], ["playlists"]]
    case ("mix", 2): return [["mix", parts[1]], ["mixes"]]
    default: return [["favorites"]]
    }
  }
}

extension View {
  /// Keeps the pages of downloaded albums, playlists, mixes and Favorites in the query cache for as long as they're
  /// downloaded: `pin` gets every download's page keys whenever downloads change.
  public func pinningDownloadedPages(_ store: DownloadStore?, pin: @escaping (Set<[String]>) -> Void) -> some View {
    let keys = Set(store?.downloads.flatMap(\.pageKeys) ?? [])
    return onChange(of: keys, initial: true) { _, keys in pin(keys) }
  }
}
```

In phase 4's `QueryKey`, add an initializer from a key's path (after its `init(_:_:)`):

```swift
  /// A key from its name and parts as one list (`["album", "70"]`), as downloads give them.
  public init(path: [String]) {
    self.name = path.first ?? ""
    self.parts = Array(path.dropFirst())
  }
```

In phase 4's `QueryCache`:

1. A pinned set, after `private let now: () -> Date`:

```swift
  /// Pages of downloads: kept on disk however old, whatever their family, as long as the download.
  private var pinned: Set<QueryKey> = []

  public func setPinned(_ paths: Set<[String]>) {
    pinned = Set(paths.map(QueryKey.init(path:)))
  }

  private func keepsOnDisk(_ key: QueryKey) -> Bool { key.isKept || pinned.contains(key) }
```

2. In `cached(_:as:)`, `guard key.isKept, let disk, let stored` becomes `guard keepsOnDisk(key), let disk, let stored`, and `guard now().timeIntervalSince(stored.updatedAt) < Self.keepFor else {` becomes `guard pinned.contains(key) || now().timeIntervalSince(stored.updatedAt) < Self.keepFor else {`.

3. In `set(_:for:)`, `guard key.isKept, let disk else { return }` becomes `guard keepsOnDisk(key), let disk else { return }`.

4. `removeExpired()` keeps pinned files: `await disk?.removeOlder(than: now().addingTimeInterval(-Self.keepFor), keeping: Set(pinned.map(\.fileName)))`, and `QueryDisk.removeOlder(than:)` gains the parameter `keeping: Set<String> = []` and skips `file.lastPathComponent` in it.

In `AccountSession.live`, pin before the expired answers are removed: right after `let queries = QueryCache(…)`:

```swift
    queries.setPinned(Set(player.downloads.downloads.flatMap(\.pageKeys)))
```

And on phase 4's root view (where `model.session` is known), keep the pins in step as downloads come and go:

```swift
    .pinningDownloadedPages(model.session?.player.downloads) { model.session?.queries.setPinned($0) }
```

Add a test to phase 4's `QueryCacheTests` in its style (it injects `now`): an answer for `.album(70)` written, the clock moved 8 days on, `setPinned([["album", "70"]])`: `cached(.album(70))` still returns it; without the pin, nil. And `.mix("x")` (not a kept family) pinned is written to disk and read back by a new cache on the same folder.

**Step 4: Run the tests**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI
```

Expected: all pass, phase 4's QueryCache tests with the two new ones.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests
git commit -F - <<'EOF'
Keep downloaded albums', playlists', mixes' and Favorites' pages for browsing offline

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

### Task 18: Signing out offers to remove downloads

Signing out of an account that keeps something on the device asks: sign out and remove its downloads, or keep them for next time. Signing out happens first (so its player is gone), then its files.

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Downloads/KeptForAccount.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/KeptForAccountTests.swift`
- Modify: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/AccountSwitcherView.swift` (phase 2's)

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/KeptForAccountTests.swift`:

```swift
import Foundation
import PlayarrAPI
import PlayarrPlayer
import Testing
@testable import PlayarrUI

struct KeptForAccountTests {
  @Test func asksOnlyWhenTheAccountKeepsSomething() throws {
    let base = FileManager.default.temporaryDirectory.appending(path: "playarr-\(UUID().uuidString)")
    let key = AccountKey(serverId: "srv-1", accountId: 2)
    #expect(KeptForAccount.of(key, name: "Sam", base: base) == nil)
    let folder = OfflineFolder.of(key, base: base)
    folder.prepare()
    try Data(count: 3 * 1024 * 1024).write(to: folder.stream.appending(path: "12.flac"))
    let kept = try #require(KeptForAccount.of(key, name: "Sam", base: base))
    #expect(kept.message == "Songs kept for Sam take 3 MB on this device.")
    #expect(OfflineWording.signOutMessage(name: "Sam", downloads: 2, bytes: 3 * OfflineLimit.gigabyte)
      == "2 downloads and other songs kept for Sam take 3 GB on this device.")
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter KeptForAccountTests
```

Expected: the build fails with `cannot find 'KeptForAccount' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Downloads/KeptForAccount.swift`:

```swift
import Foundation
import PlayarrAPI
import PlayarrPlayer

/// What an account keeps on this device, for the question signing out asks: nil when it keeps nothing.
struct KeptForAccount: Equatable, Identifiable {
  let key: AccountKey
  let name: String
  let downloads: Int
  let bytes: Int64

  var id: AccountKey { key }
  var message: String { OfflineWording.signOutMessage(name: name, downloads: downloads, bytes: bytes) }

  static func of(_ key: AccountKey, name: String, base: URL = OfflineFolder.applicationBase) -> KeptForAccount? {
    let kept = DownloadStore.summary(of: .of(key, base: base))
    return kept.bytes > 0 ? KeptForAccount(key: key, name: name, downloads: kept.downloads, bytes: kept.bytes) : nil
  }

  /// Signs out, then removes what the account kept (in that order, so its player is gone before its files).
  func signOutRemovingDownloads(_ signOut: (AccountKey) async -> Void) async {
    await signOut(key)
    await DownloadStore.removeEverything(in: .of(key), transport: URLSessionTransport.background)
  }
}
```

In `AccountSwitcherView.swift` (phase 2's code; 4-space indentation there), add `import PlayarrPlayer` at the top, a state after `@State private var adding: AddServerFlow.Start?`:

```swift
    @State private var leaving: KeptForAccount?
```

replace both `Button("Sign out", role: .destructive) { Task { await model.store.signOut(record.key) } }` with:

```swift
Button("Sign out", role: .destructive) { signOut(record) }
```

add after the `.sheet(item: $adding) { … }` modifier:

```swift
            .confirmationDialog("Sign out of \(leaving?.name ?? "")?", isPresented: Binding(get: { leaving != nil }, set: { if !$0 { leaving = nil } }), titleVisibility: .visible, presenting: leaving) { kept in
                Button("Sign out and remove downloads", role: .destructive) {
                    Task { await kept.signOutRemovingDownloads { await model.store.signOut($0) } }
                }
                Button("Sign out, keep downloads") { Task { await model.store.signOut(kept.key) } }
                Button("Cancel", role: .cancel) {}
            } message: { kept in
                Text(kept.message)
            }
```

and a method before the last closing brace:

```swift
    private func signOut(_ record: AccountRecord) {
        if let kept = KeptForAccount.of(record.key, name: record.account.name) {
            leaving = kept
        } else {
            Task { await model.store.signOut(record.key) }
        }
    }
```

**Step 4: Run and build**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter KeptForAccountTests
make -C apps/ios build
```

Expected: `Test run with 1 test` … `passed`; `** BUILD SUCCEEDED **`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Downloads/KeptForAccount.swift \
  apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/KeptForAccountTests.swift \
  apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/AccountSwitcherView.swift
git commit -F - <<'EOF'
Ask whether to remove an account's downloads when signing out of it

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

### Task 19: A UI test for Library → Downloads

With the launch argument `-UITestsDownloads`, a Debug build opens Library → Downloads on made-up data: "Mezzanine" complete (11 songs, 484 MB), "Late Night" with 3 of 10 songs, one the "server" refuses and one downloading for ever. No server, no network (song files are sparse, so they take no room).

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Downloads/DownloadsDemo.swift`
- Modify: `apps/ios/Playarr/PlayarrApp.swift`
- Test: `apps/ios/PlayarrUITests/DownloadsUITests.swift`

**Step 1: Write the failing test**

`apps/ios/PlayarrUITests/DownloadsUITests.swift`:

```swift
import XCTest

/// Library → Downloads on made-up downloads (`DownloadsDemoView`): no server needed.
final class DownloadsUITests: XCTestCase {
  @MainActor
  func testShowsEachDownloadWithItsProgressAndFailuresAndPlaysAndRemovesThem() {
    let app = XCUIApplication()
    app.launchArguments = ["-UITestsDownloads"]
    app.launch()

    XCTAssertTrue(app.navigationBars["Downloads"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["Massive Attack · 11 songs · 484 MB"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Playlist · 3 of 10 songs · 132 MB · 1 couldn’t download"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.progressIndicators.firstMatch.exists)

    app.buttons["Play Mezzanine"].tap()
    XCTAssertTrue(app.staticTexts["Playing Mezzanine"].waitForExistence(timeout: 2))

    app.buttons["Remove Mezzanine from this device"].tap()
    let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.buttons["Play Mezzanine"])
    wait(for: [gone], timeout: 5)
    XCTAssertTrue(app.buttons["Play Late Night"].exists)
  }
}
```

**Step 2: Run it to see it fail**

```bash
make -C apps/ios project
cd apps/ios && xcodebuild -project Playarr.xcodeproj -scheme Playarr -derivedDataPath build/DerivedData \
  -IDEPackageSupportDisableManifestSandbox=YES -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  'OTHER_SWIFT_FLAGS=$(inherited) -Xfrontend -disable-sandbox' -only-testing:PlayarrUITests/DownloadsUITests test; cd ../..
```

Expected: `** TEST FAILED **`: the Downloads navigation bar never appears (the app opens on its usual root).

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Downloads/DownloadsDemo.swift`:

```swift
#if DEBUG
  import Foundation
  import PlayarrAPI
  import PlayarrPlayer
  import SwiftUI
  import Synchronization

  /// Library → Downloads with made-up downloads, for the UI tests (launch argument `-UITestsDownloads`): "Mezzanine"
  /// complete, and "Late Night" with 3 of its 10 songs here, one the server refuses and one downloading for ever. No
  /// server, no network.
  public struct DownloadsDemoView: View {
    @State private var demo = DownloadsDemo()

    public init() {}

    public var body: some View {
      NavigationStack {
        DownloadsView(store: demo.store, play: { demo.playing = $0.title }, open: { _ in }) { _ in
          Rectangle().fill(.secondary.opacity(0.3))
        }
        .safeAreaInset(edge: .bottom) {
          if let playing = demo.playing { Text("Playing \(playing)").padding() }
        }
      }
    }
  }

  @MainActor @Observable
  final class DownloadsDemo {
    static let songBytes = 44 * OfflineLimit.megabyte

    let store: DownloadStore
    var playing: String?

    init() {
      let root = FileManager.default.temporaryDirectory.appending(path: "playarr-downloads-demo/demo/1", directoryHint: .isDirectory)
      try? FileManager.default.removeItem(at: root)
      let folder = OfflineFolder(root: root)
      folder.prepare()
      let mezzanine = (1...11).map { Self.track($0, album: 1, title: "Mezzanine", artist: "Massive Attack") }
      let lateNight = (101...110).map { Self.track($0, album: 2, title: "Late Night", artist: "Various Artists") }
      for t in mezzanine + lateNight.prefix(3) { Self.sparseFile(folder.url(folder.songPath(t)), bytes: Self.songBytes) }
      var manifest = OfflineManifest()
      manifest.pins["album:1"] = PinnedDownload(
        key: "album:1", title: "Mezzanine", subtitle: "Massive Attack", href: "/albums/1", tracks: mezzanine, addedAt: Date(timeIntervalSince1970: 1))
      manifest.pins["playlist:2"] = PinnedDownload(
        key: "playlist:2", title: "Late Night", subtitle: "Playlist", href: "/playlists/2", tracks: lateNight, addedAt: Date(timeIntervalSince1970: 2))
      JSONFile<OfflineManifest>(folder.manifest).write(manifest)
      let settings = PlaybackSettings(defaults: UserDefaults(suiteName: "playarr.downloads-demo") ?? .standard)
      store = DownloadStore(
        folder: folder, settings: settings, cache: StreamCache(directory: folder.stream), transport: DemoTransport(refusing: 104),
        backend: DemoBackend(), capacity: { 64 * OfflineLimit.gigabyte })
    }

    static func track(_ id: Int, album: Int, title: String, artist: String) -> Track {
      Track(
        id: id, recordingId: "rec-\(id)", fileId: id, albumId: album, artistId: album, title: "Song \(id)", artistName: artist,
        albumTitle: title, trackNumber: id % 100, discNumber: 1, duration: 240, explicit: false,
        format: AudioFormat(codec: "FLAC", container: "flac", lossless: true), size: Int(songBytes), streamUrl: "/stream/\(id)")
    }

    /// A file that says it's `bytes` long and takes no room (APFS keeps the hole).
    static func sparseFile(_ url: URL, bytes: Int64) {
      FileManager.default.createFile(atPath: url.path(), contents: nil)
      guard let handle = try? FileHandle(forWritingTo: url) else { return }
      try? handle.truncate(atOffset: UInt64(bytes))
      try? handle.close()
    }
  }

  /// Refuses one song as the server would ("Unknown track file"); every other job runs for ever.
  final class DemoTransport: DownloadTransport {
    private let refused: Int
    private let handler = Mutex<(@Sendable (TransportEvent) -> Void)?>(nil)

    init(refusing fileId: Int) { refused = fileId }

    func setHandler(_ handler: @escaping @Sendable (TransportEvent) -> Void) { self.handler.withLock { $0 = handler } }
    func start(_ job: TransportJob) {
      guard job.id.hasSuffix("/stream/\(refused).flac") else { return }
      handler.withLock { $0 }?(.failed(id: job.id, failure: .server(status: 404, message: "Unknown track file"), resumeData: nil))
    }
    func cancel(_ id: String) {}
    func running() async -> Set<String> { [] }
  }

  /// A server that's never there: nothing in the demo asks it.
  struct DemoBackend: PlayerBackend {
    func levels(_ recordingIds: [String]) async throws -> [String: TrackLevel] { [:] }
    func reportPlays(_ plays: [PlayReport]) async throws {}
    func radio(seeds: [String], exclude: [String], count: Int) async throws -> [Track] { [] }
    func streamRequest(_ track: Track) -> URLRequest { URLRequest(url: URL(filePath: "/dev/null")) }
    func levelledRequest(_ track: Track) -> URLRequest { URLRequest(url: URL(filePath: "/dev/null")) }
    func artwork(_ track: Track, size: Int) async -> Data? { nil }
    func transition(_ request: TransitionRequest) async throws -> TransitionAnswer { .unavailable(.init(reason: "Demo")) }
    func transitionRequest(_ path: String) -> URLRequest { URLRequest(url: URL(filePath: "/dev/null")) }
  }
#endif
```

In `apps/ios/Playarr/PlayarrApp.swift` (phase 4's), the `WindowGroup` opens the demo in Debug builds when asked, next to phase 4's `-UITests` and `-UITestsDemo`:

```swift
  var body: some Scene {
    WindowGroup {
      #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-UITestsDownloads") {
          DownloadsDemoView()
        } else {
          root
        }
      #else
        root
      #endif
    }
  }

  private var root: some View {
    RootView(model: model)
      .onOpenURL { model.open($0) }
  }
```

**Step 4: Run it to see it pass**

The same `xcodebuild … -only-testing:PlayarrUITests/DownloadsUITests test` as Step 2.

Expected: `Test Case '-[PlayarrUITests.DownloadsUITests testShowsEachDownloadWithItsProgressAndFailuresAndPlaysAndRemovesThem]' passed` and `** TEST SUCCEEDED **` (about 10 s).

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Downloads/DownloadsDemo.swift \
  apps/ios/Playarr/PlayarrApp.swift apps/ios/PlayarrUITests/DownloadsUITests.swift
git commit -F - <<'EOF'
Test Library → Downloads on the simulator with made-up downloads

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

### Task 20: Everything, then the simulator, then the phone

**Files:** none (a failure is fixed test-first in the task it belongs to, and committed there).

**Step 1: Every test**

```bash
make -C apps/ios test
```

Expected: the scripts, the three packages and the UI tests pass.

**Step 2: In the simulator against the dev server**

The NAS isn't reachable from Claude's shell (macOS Local Network): ask the user to start the dev server if it needs the NAS (`corepack pnpm -C apps/server dev`). Then `make -C apps/ios build`, install and launch as phase 3's Task 21 does, sign in, and:

1. Download an album: the ring fills song by song; Library → Downloads shows "N of M songs · X MB", then "M songs".
2. Settings → Playback → DJ mix, then download a playlist: after its songs, the dev server's log shows `POST /api/transitions` for each pair in order (with `levels` while even volume is on), then `GET /transitions/<name>.flac`.
3. Settings → Playback → On this device: kept songs and the limit; lower the limit to 512 MB: songs kept as you listen go, downloads stay.
4. Offline (the simulator shares the Mac's network: turn the Mac's Wi-Fi off, or stop the dev server and the app sees the server as unreachable rather than offline): play the album from Library → Downloads: it plays; play a playlist with songs not kept: "Offline: skipped songs that aren’t on this device".
5. `xcrun simctl spawn booted log stream --predicate 'subsystem == "com.apple.nsurlsessiond"'` while downloading, then quit the app from the app switcher: the log shows the task cancelled with resume data; reopen: the download goes on (the server log shows a `Range` request).

**Step 3: On the phone**

```bash
corepack pnpm ios:device
```

The on-device checklist (each line: expected result):

- [ ] **Download an album on Wi-Fi**: the button's ring fills; songs get the offline mark one by one; Library → Downloads shows its progress and size, then the song count.
- [ ] **Lock the phone mid-download** for a few minutes: unlocking shows it went on (iOS may slow it; it doesn't stop).
- [ ] **Kill the app mid-download** (swipe it away in the switcher) and reopen: the download goes on from where it was, not from the start of the song (the server log shows `Range: bytes=…`).
- [ ] **Mobile data** (Wi-Fi off): a new download waits; "Allow downloads on mobile data" on: it starts; off again: the song under way stops and waits for Wi-Fi.
- [ ] **Airplane mode, play the album through**: every song plays, levelled (no jumps between a quiet and a loud track); with DJ mix and a downloaded playlist, the transitions play as online (lead and tail in step, no gap); the lock screen controls work.
- [ ] **Airplane mode, a queue with songs not kept**: they're skipped with "Offline: skipped songs that aren’t on this device"; nothing kept after the current song: it stops at the end.
- [ ] **Airplane mode, browse**: Library → the downloaded album, playlist, mix and Favorites open from the cache; Play plays them.
- [ ] **Play reports**: play a few songs in airplane mode, turn it off: Your listening on the web shows them.
- [ ] **Keep-ahead**: on Wi-Fi, play a queue for a minute, then airplane mode: the next 3 songs play; on mobile data: the next 1.
- [ ] **Low Data Mode** (Settings → Mobile Data → Low Data Mode): nothing is fetched ahead; a download the user starts still goes (with mobile data allowed).
- [ ] **Room**: download something larger than the free space (or fill the phone): the button says "Not enough space on this device" with the sizes; during a download that runs out: "This device is out of space for downloads: remove some in Library → Downloads", and the failed count shows on its row.
- [ ] **Remove**: Remove on a row and "Remove all" in On this device free the space (Settings → General → iPhone Storage → Playarr goes down).
- [ ] **Accounts**: switch account: its own downloads (none); switch back: they're there; sign out of an account with downloads: the question; "Sign out and remove downloads" frees the space.
- [ ] **Backups**: Settings → [name] → iCloud → Manage Storage → Backups → this iPhone: Playarr's size is small (the audio is excluded).

**Step 4: TestFlight**

If the checklist passes, ask the user whether to ship a build to TestFlight (`corepack pnpm ios:beta`, 15 to 45 minutes: run it in the background), as each phase ends with one.

### Task 21: Record this phase's names in the conventions

Skip this task if whoever coordinates the phase plans has already made these edits.

**Files:**
- Modify: `docs/plans/2026-11-03-ios-conventions.md`

**Step 1: Edit**

- Under "Key types → PlayarrPlayer", add: `DownloadStore` (`@MainActor @Observable`, the account's manifest and downloads; `Player.downloads`), `PinnedDownload` (an album/playlist/mix/Favorites on the device; `Download` stays phase 3's file fetch), `OfflineManifest`, `KeptFile`, `KeptTransition`, `KeptTransitionFiles`, `OfflineRules`, `OfflineFolder` (the one place the per-account folder is worked out: `OfflineFolder.of(key).root`), `OfflineLimit`, `ByteCount`, `DownloadTransport`/`URLSessionTransport` (`URLSessionTransport.background`, identifier `me.tracklistme.playarr.downloads`), `TransitionPoller`, `KeepAhead`, `OfflinePlayback`. `PlayerBackend` gains `transition(_:)` and `transitionRequest(_:)`.
- Under "Per-account folder": `stream/` holds every whole song file (kept as you listen and downloads' songs), `offline/transitions/`, `offline/resume/` and `offline.json`; `stream/` and `offline/` are excluded from backups. Background jobs are named by their file's path from `Application Support/Playarr/`.
- Under PlayarrUI: `DownloadButton`, `OfflineMark`, `DownloadsView`, `OfflineStorageSection`, `DownloadItem`; `QueryCache.setPinned(_:)`; the launch argument `-UITestsDownloads`.
- `PlaybackSettings` keys: `playback.offlineLimit`, `playback.cellularDownloads`.

**Step 2: Commit**

```bash
git add docs/plans/2026-11-03-ios-conventions.md
git commit -F - <<'EOF'
iOS conventions: the names phase 7 settled (downloads, the account folder's layout, the background session)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

## Risks, and how this plan meets them

- **Background session behaviour can't be unit-tested.** The delegate's logic is (`TransportFiles`), the transport runs end to end on an ordinary session, and the store is tested against a fake session that finishes, fails, cancels and resumes; the device checklist covers the system's part (relaunch, force-quit with resume data, mobile data).
- **Tasks created in the background are discretionary.** The store hands the system up to 25 songs when the app resigns active; songs beyond those wait for the next time the app is opened (a large Favorites can take a few openings to finish with the app closed). If the checklist shows long stalls, raise `backgroundJobs`.
- **Phase 5's planner names are assumed.** Task 13's three changes are described by what they do; the store's side is tested.
- **Order of main-actor events.** The store gets transport and cache events through main-actor tasks; a late progress event after a finish is ignored (it's only taken for a job still under way), and a file finishing as its job is stopped is dropped.
- **Disk full while moving a file into place** ends the job as a failure with "Not enough space on this device".

## Not in this phase

Covers of downloads kept beyond the image cache's own limits (phase 4's `ImageCache` keeps what's been shown), levels of songs kept as you listen across launches (only downloads' are kept), the iPad sidebar entry (phase 10), downloading on the Mac.
