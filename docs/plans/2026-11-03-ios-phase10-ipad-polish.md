# Native iOS app, Phase 10: iPad, Accessibility and Polish Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Playarr on an iPad looks and works like the desktop web: a sidebar with every desktop link, Requests while there are some, your playlists with "+" and the footer (library counts, Lidarr and Streaming dots, the MusicBrainz queue, the version); the page in the middle; the queue or the lyrics in a column on the right; a player bar along the bottom; Now Playing with "Up next". Windows narrower than the web's desktop width (Slide Over, Split View, Stage Manager, an upright iPad mini) get the iPhone layout, keeping the page. A hardware keyboard has the web's shortcuts, listed in the iPad's menu bar and ⌘ overlay. Songs drag onto playlists and the queue; long-press and secondary click open the same menus as ⋯; the pointer highlights what it can click. Every screen passes Xcode's accessibility audit on iPhone and iPad, VoiceOver rows have custom actions, layouts adapt up to AX5, and Reduce Motion, Increase Contrast and Bold Text are honoured. The app gets a launch screen, dark and tinted icons, consistent haptics, error states everywhere, state restoration, and three Siri and Shortcuts actions. The phase ends with an iPad build on TestFlight.

**Architecture:** Everything lands in `PlayarrUI` on top of phase 4's shell, plus a few lines in the app target. `AppRouter` learns a second layout: a `ShellLayout` (`.tabs` or `.split`, chosen from the window's size class and width by a pure function), a `SidebarItem` and a `detail` stack of phase 4's `Route`s, and a `SideColumn` (queue or lyrics). `setLayout(_:)` carries the place across when the window changes width, through two pure mappings between "tab + stack" and "sidebar item + stack". `AdaptiveShell` reads the window's width and shows phase 4's tabs (moved into `TabShell`) or `SplitShell` (`NavigationSplitView` + `inspector` for the side column + `PlayerBar` as a bottom inset), and keeps a `RouterSnapshot` in `@SceneStorage`. The keyboard's shortcuts are SwiftUI menu commands (`PlayarrCommands`), so iPadOS lists them in its menu bar and ⌘ overlay; what each does is `KeyCommandHandler` over a `PlaybackControlling` protocol that `Player` adopts. Songs drag as `TrackDrag`, a `Transferable` with its own declared type. Accessibility pieces are small and shared: `AdaptiveStack` and `essentialLineLimit` for the accessibility text sizes, the `Muted` style for Increase Contrast, the `reducesMotion` environment value (Settings → Motion with the system's setting), `pointerHover()`, and `Haptic`. Siri and Shortcuts run `QuickPlay` through three `AudioPlaybackIntent`s in the app target.

**Tech Stack:** Swift 6 language mode with strict concurrency (Xcode 27.2, Swift 6.4, tools version 6.2), SwiftUI for iOS 26 (`NavigationSplitView`, `inspector`, `Commands`/`CommandMenu`/`keyboardShortcut`, `SceneStorage`, `searchFocused`, `draggable`/`dropDestination`, `accessibilityActions`, `hoverEffect`, `sensoryFeedback`, `@Entry`), CoreTransferable and UniformTypeIdentifiers, App Intents (`AudioPlaybackIntent`, `AppShortcutsProvider`, `AppDependencyManager`), CoreGraphics and ImageIO (the icon script), Swift Testing, XCUITest (`performAccessibilityAudit`, `typeKey`, `XCTApplicationLaunchMetric`, `XCTOSSignpostMetric`). No third-party packages.

**Design:** [2026-11-03-ios-app-design.md](2026-11-03-ios-app-design.md): Rollout phase 10; "Platforms" (iPad gets the desktop web's layout: sidebar, content, queue and lyrics column) and section 2 "Screens" (keyboard shortcuts only with a hardware keyboard on iPad). Names, layout and commands: [2026-11-03-ios-conventions.md](2026-11-03-ios-conventions.md). What to port, with file references: [2026-11-03-ios-parity-inventory.md](2026-11-03-ios-parity-inventory.md) section 1 (desktop chrome: `Sidebar`, `PlayerBar`, Now Playing's desktop "Up next"), section 8 (keyboard shortcuts) and section 9 (touch targets, hover, reduced motion). Builds on [phase 4](2026-11-03-ios-phase4-browse-now-playing.md) (the shell, router, pages and components), [phase 5](2026-11-03-ios-phase5-dj-transitions.md) (`TransitionLine`, Stats for nerds), [phase 6](2026-11-03-ios-phase6-playlists-mixes.md) (`FavoritesStore`, `PlaylistsStore`, `addToPlaylist(_:)`, `FavoriteButton`), [phase 7](2026-11-03-ios-phase7-offline.md) (`Route.downloads`, `-UITestsDownloads`), [phase 8](2026-11-03-ios-phase8-discover-requests.md) (`DiscoverContext`, `RequestsPage`, `MusicBrainzIndicator`) and [phase 9](2026-11-03-ios-phase9-admin-settings.md) (the admin panels).

---

## Where things stand (checked 2026-11-03, about 17:30 UTC)

- Phases 0 to 5 are on `main` (phase 5's transitions and Stats for nerds landed at `8e22d1d`); phase 8 was being implemented. The plans for phases 6 to 9 and 11 are committed. This plan's edits were checked against `main` at `8e22d1d` with phase 6's plan applied task by task (its own replay), which is what `main` will look like when phase 6 lands.
- Phase 4's `AppShell` is a `TabView` of four `NavigationStack`s over `AppRouter.paths: [AppTab: [Route]]`; pages are `Route` values shown by `RouteDestination`. Its `Route` was designed for an iPad split view ("the same destinations work in the iPhone's tab stacks now and in an iPad split view later"), which this plan uses as is.
- The app's Info.plist already lists all four iPad orientations and `UIApplicationSupportsMultipleScenes = NO` (one window; Split View, Slide Over and Stage Manager still resize it). `UILaunchScreen` is an empty dictionary, so the launch screen is white for a moment before the dark app. `AppIcon.appiconset` has one 1024-point image.
- Phase 11's `StoreScreenshots` test takes the iPad Pro 13" screenshots in landscape "so the sidebar, content and queue columns of phase 10 show", and finds the mini player by `otherElements["MiniPlayer"]`. Task 27 lists what it should use instead.

## Key decisions in this plan

- **The layout follows the web's breakpoint, not the device.** The web mounts the desktop chrome at 768 px (`useDesktopLayout`). `ShellLayout.choose(regularWidth:width:)` gives the sidebar layout when the window's horizontal size class is regular *and* it's at least 768 points wide. So an iPad Pro in either orientation and a two-thirds Split View get the sidebar; Slide Over, a third or half of the screen, a small Stage Manager window and an iPad mini held upright (744 points) get the iPhone's tabs. The mini player shows only with the tabs, the player bar only with the sidebar, as the web mounts one or the other.
- **One router, two shapes, the place kept.** Rather than a second router, `AppRouter` gains `layout`, `sidebar`, `detail` and `column`. `open(_:)`, `showQueue()` and the new `openSearch()` act on whichever layout is shown, so every page and action phase 4 to 9 wrote (`session.router.open(…)`, `go(…)`) works unchanged on an iPad. When a window crosses 768 points, `setLayout(_:)` maps the place across: Home, Search and Queue are both tabs and sidebar items; a page opened from Library that has a sidebar item (Artists, Albums, a playlist, Settings…) becomes that item with the rest of the stack on top, and back again. Library's own list *is* the sidebar, so the Library tab's first page maps to Home.
- **Requests becomes a `Route`.** The sidebar's Requests link needs a page in the detail stack, and the stacks are typed `[Route]`, so `Route` gains `.requests` (and `/requests` in `Route(href:)`), shown by phase 8's `RequestsPage`. This also fixes a latent problem: phase 8's Library row pushes `DiscoverDestination.requests` into a stack typed `[Route]`, which a typed `NavigationStack` path can't hold. Task 1 points that row at `Route.requests`. (Phase 8's other `DiscoverDestination` links have the same problem; see the report's convention note.)
- **The queue and lyrics column is an `inspector`.** On a regular-width window it's a trailing column beside the page; SwiftUI turns it into a sheet if the window narrows while it's open (and `setLayout(.tabs)` closes it anyway). The player bar's Queue and Lyrics buttons open and close it, as the web's bar opens its queue. Now Playing's "Open queue" opens it too on an iPad (the web navigates to `/queue`; beside the page is better on a wide screen). The sidebar's Queue link still shows the queue as a page, as the web's does.
- **Keyboard shortcuts are menu commands.** `.keyboardShortcut` on SwiftUI `Commands` become `UIKeyCommand`s in the app's main menu: iPadOS 26 shows them in its menu bar and in the overlay while ⌘ is held, and they work in every screen, Now Playing included. UIKit gives text input priority over key commands without modifiers (`wantsPriorityOverSystemBehavior` is false by default), which is the web's "ignored inside inputs": typing "s" in Search types an s. Task 22's UI test checks that on the simulator; if it ever fails, the fallback is a shell-level `onKeyPress` that checks `@FocusState`, noted there. ↑/↓ change the app's own volume (`Player.setVolume`, the bus mixer's gain under the device's volume), as the web's change the element's. Escape should close Now Playing (`.keyboardShortcut(.cancelAction)` on its close button); on the simulator neither that, a menu command nor `onKeyPress(.escape)` reached the full-screen cover, so it's a device check (Task 26), with a fallback there.
- **Context menus mirror the ⋯ menus.** The web has no right-click menus: its ⋯ menus are the source. Phase 4 already put each song's and album card's ⋯ items in a `contextMenu` (long press, and secondary click with a trackpad or mouse). This phase adds Up next's, and the same items as VoiceOver custom actions on song and queue rows (plus Add to/Remove from Favorites). The web's hover Play button on cards isn't copied: a Button inside a `NavigationLink` card fights the link for taps, and the card's secondary-click menu starts with Play.
- **Dragging songs.** A song row is `.draggable(TrackDrag)`; the sidebar's Queue link and the queue column accept drops (Add to queue, with the web's toast), and so do your own playlists in the sidebar (phase 6's add, with its toast). Playlists shared with you refuse drops: only their owner changes them. `TrackDrag` uses its own type, `me.tracklistme.playarr.tracks`, declared in Info.plist, so drops of text or files from other apps don't land in the queue. Dragging a whole album isn't in scope (its songs would need a fetch mid-drag).
- **Accessibility, measured.** Xcode's `performAccessibilityAudit()` runs on each main screen of the demo library, on the iPhone and the iPad, plus a run at AX5 for clipped text. Exceptions are listed in one enum with a reason each, and only for things the app can't change (the tab bar's labels, which iOS shows in the large content viewer instead of growing). Three of phase 4's views wrap buttons in `accessibilityElement(children: .combine)` (Queue's now-playing row, Now Playing's "Playing from", each toast with Undo and Later), against the conventions' rule; Tasks 12, 16 and 17 undo that. Phase 4's mini player buttons are 36 points; they become 44, as does every new control.
- **Increase Contrast and Bold Text.** Playarr is always dark. Secondary text in the views this phase touches uses `.muted`, a `ShapeStyle` that resolves to white at 60 %, or 85 % with Increase Contrast. The accent stays as it is: the web's algorithm clamps its lightness to 56–68 %, which on Playarr's near-black is above 7:1 for every hue. Bold Text needs no code: every font is a system text style or `.system(size:)`, which SwiftUI makes bolder itself; the device checklist checks it.
- **Reduce Motion, once.** Phase 4 already turns animations off when Settings → Appearance → Motion (or the system, on System) asks. Views that animate on their own (the playing waveform's `symbolEffect`) read a new environment value, `reducesMotion`, set once by the shell, instead of the system setting alone.
- **State restoration with `SceneStorage`.** The router's place (layout, tab and stacks, sidebar item and its stack, Now Playing open, lyrics, the side column) is a `Codable` `RouterSnapshot` kept in the scene's storage under the account's key, and put back when iOS reopens a window it closed in the background. Another account's snapshot is ignored; Now Playing only reopens with a song queued. `Route` becomes `Codable` for this (synthesized in its own file). UI tests start on Home (`AppModel.restoresPlace = false`) unless they pass `-UITestsRestore`. A force-quit from the app switcher discards scene state, as iOS intends.
- **App Intents: yes, three, no extension.** "Play my Favorites", "Shuffle everything" and "Start radio from the current song" are a music app's most-asked Siri requests, they work from the Action button, Spotlight and the Shortcuts app, and they cost three thin `AudioPlaybackIntent`s in the app target over `QuickPlay` (tested in the package) plus one line to register the app model. `AudioPlaybackIntent` runs in the app's process in the background, so no extension, App Group or extra bundle id (and no change to `ios:setup` or signing) is needed. Each intent first calls `model.syncSession()`, because a launch in the background doesn't render the root view that normally does it.
- **Spotlight indexing: no (YAGNI).** Indexing artists, albums and playlists means an index per server and account, deleting it on sign-out and account switches, keeping it in step with library changes, and routing `CSSearchableItemActionType` activities; the library's own Search is one tap away and searches the server's whole catalog. Revisit if asked.
- **Widgets and Live Activities: out.** Both need a widget extension target, an App Group to share state, and a second bundle id to register and sign; and the system already shows Now Playing (from phase 3's `MPNowPlayingInfoCenter`) on the lock screen, in Control Center and in the Dynamic Island. A Live Activity would repeat it.
- **Launch screen and icons.** `UILaunchScreen` gets the app's background colour (`LaunchBackground`, #0F0E0C, the icon's) and `UIUserInterfaceStyle` = Dark, so there's no white flash and system sheets are dark before the first view sets it. The dark and tinted icons are drawn by a small script from the same shapes as `AppIcon.png` (three rings and the orange label), so they can be redrawn. Icon Composer's layered `.icon` format (Liquid Glass) would need XcodeGen support that isn't confirmed; iOS 26 renders asset-catalog icons with its own glass treatment.
- **Performance without Instruments.** A UI test asserts the demo's Home shows within 10 s of a cold launch, a 5,000-song queue (`-UITestsLongQueue`) flicks through with far rows drawn, and a package test bounds the queue model's work for 5,000 songs. Xcode's launch and scrolling metrics run with `TEST_RUNNER_PLAYARR_PERF=1` (their baselines would live in the generated `.xcodeproj`, which isn't committed, so they report rather than gate). `QueueView` computes Up next once per redraw instead of three times. Phase 4's long lists are already lazy (`List`, `LazyVStack`, `LazyVGrid`); the sidebar is a `List`.

## Conventions

- Run everything from the repo root `/Users/bortignon/dev/playarr`. `pnpm` is `corepack pnpm` in Claude's shell.
- One package's tests: `swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI` (one suite: `--filter RouterLayoutTests`). `--disable-sandbox` because SwiftPM's sandbox can't start inside Claude's shell.
- Build the UI package for the iPhone simulator (catches iOS-only API mistakes the Mac build can't): `swift build --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --triple arm64-apple-ios26.0-simulator --sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" --scratch-path /tmp/playarr-ui-ios`.
- **Simulators of your own.** Other sessions use the shared "iPhone 17 Pro" and "iPad Pro 13-inch (M5)". Create two once and use them for every `make … SIMULATOR=` in this plan:

  ```bash
  xcrun simctl list devices available | grep -q "Playarr P10 iPad" || xcrun simctl create "Playarr P10 iPad" "iPad Pro 13-inch (M5)"
  xcrun simctl list devices available | grep -q "Playarr P10 iPhone" || xcrun simctl create "Playarr P10 iPhone" "iPhone 17 Pro"
  ```

  Then `make -C apps/ios test-app SIMULATOR="Playarr P10 iPhone"` and `make -C apps/ios test-app SIMULATOR="Playarr P10 iPad"`.
- Swift: 2-space indentation in hand-written files (phase 2's `AppModel.swift` and `RootView.swift` keep their 4); one primary type per file, named after it; no force unwraps outside tests; Swift Testing in packages; user-facing text in the web's words; `.accessibilityLabel` on the Button itself, never `.accessibilityElement(children: .ignore)` (or `.combine`) around buttons.
- Edits to earlier phases' files are given as "replace this with that". If a later phase changed the lines around them, keep what it added and apply the change to the same spot; each such place is called out.
- Commit after every task, on `main`, only that task's files, with the message given (plain English, the history's `iOS:` prefix), ending with a blank line and `Co-Authored-By: Claude <noreply@anthropic.com>`. The pre-commit hook bumps the version: never bypass it. The user pushes (a push to `main` also deploys the server to the NAS, so ask first).

## Before you start

This plan relies on these names; Task 0 checks them.

- **Phase 4** (`PlayarrUI`): `AppRouter` (`tab`, `paths`, `nowPlaying`, `lyrics`, `select(_:)`, `open(_:)`, `open(href:)`, `go(_:)`, `showQueue()`), `AppTab`, `Route` (and `Route(href:)`), `RouteDestination`, `routeDestinations(_:)`, `AppShell`, `AppModel` (`session`, `theme`, `appearance`, `toasts`, `appVersion`, `syncSession()`, `static demo()`), `AccountSession` (`key`, `api`, `player`, `queries`, `router`, `toasts`, `actions`), `TrackActions` (`playNext`, `addToQueue`, `startRadio`), `Query`, `QueryKey.health`/`.playlists`, `ToastCenter`, `Theme`, `AppearanceSettings.reduceMotion(system:)`, `Format`, `Demo` (and its internal `track(…)`), `DemoAPI`, the views `HomeView`, `SearchView`, `LibraryView`, `QueueView`, `LyricsView(trackId:session:)`, `NowPlayingView`, `MiniPlayer`, `ToastsView`, `TrackRow`, `TrackMenu`/`TrackMenuItems`, `Cover`, `Kicker`, `FormatBadge`, `FavoriteButton`, `PlayPauseButton`, `SeekBar`, `ErrorState`, `PlaceholderPage`, `SettingsView`, `PlaybackPanel`, the modifiers `minimizingTabBar()` and `miniPlayer(isShown:_:)`; tests' `demoSession(api:)`, `FakeAPI`, `FakeAPI.demoLibrary()`; the app's `-UITests`/`-UITestsDemo`.
- **Phase 3** (`PlayarrPlayer`): `Player` (`queue`, `time`, `duration`, `play`, `jump(to:)`, `next`, `previous`, `togglePlay`, `setPlaying`, `seek(to:)`, `setVolume`, `toggleMute`, `toggleShuffle`, `cycleRepeat`), `QueueState` (`queue`, `order`, `pos`, `volume`, `muted`, `shuffle`, `repeatMode`, `currentTrack`), `PlaySource`.
- **Phase 5**: `TransitionLine(player:)` under Now Playing's transport.
- **Phase 7**: `Route.downloads`, and `-UITestsDownloads`.
- **Phase 8**: `DiscoverContext` in the environment as `DiscoverContext?` (`requests: RequestsModel` with `requests: [AlbumRequest]?` and `activeCount`), `RequestsPage()`, `MusicBrainzIndicator()`, `.discoverDestinations()`, and the Library row with identifier `library-requests`.
- **Phase 6**: `AccountSession.favorites` (`FavoritesStore`: `isFavorite(_ recordingId:)`, `toggle(_:) async`), `AccountSession.playlists` (`PlaylistsStore`: `playlists`, `load()`, `add(_:to id:) async -> PlaylistDetail?`, with its toasts), `AccountSession.addToPlaylist(_:)` (`[]` opens New playlist), `PlaylistSummary.mine`, `FavoriteButton(track:size:)`, and the shell's `.addToPlaylistSheet(session)`. The shell calls them through one file, `Session/AccountSession+Shell.swift` (Task 5).

If a name differs, change it in the task that uses it, and nowhere else.

---

### Task 0: Check the starting point

**Files:** none.

**Step 1: The earlier phases' names are there**

```bash
UI=apps/ios/Packages/PlayarrUI/Sources/PlayarrUI
grep -n "public func showQueue\|public func go(_ route" $UI/Shell/AppRouter.swift
grep -n "public enum Route: Hashable, Sendable\|case downloads" $UI/Shell/Route.swift
grep -n "AdaptiveShell\|TabView(selection" $UI/Shell/AppShell.swift
grep -n "public static func demo()" $UI/AppModel.swift
grep -rn "struct TransitionLine" $UI
grep -n "public let favorites: FavoritesStore\|public let playlists: PlaylistsStore" $UI/Session/AccountSession.swift
grep -rn "public func addToPlaylist\|public func isFavorite\|public func add(_ tracks: \[Track\], to id: Int)" $UI
grep -rn "public final class DiscoverContext\|public struct RequestsPage\|public struct MusicBrainzIndicator\|func discoverDestinations" $UI
grep -rn "UITestsDownloads" apps/ios/Playarr
grep -n "public func setVolume\|public func toggleMute\|public func jump(to" apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Player.swift
```

Expected: every grep prints a line, except `AdaptiveShell` (this phase adds it; `TabView(selection` should print). If phase 6's stores are missing, phase 6 hasn't landed: stop (the heart, the rows' Favorites action, the sidebar's playlists and "+" and drops on playlists need it). If `TransitionLine` (phase 5), `case downloads` and `UITestsDownloads` (phase 7) or the phase 8 names are missing, that phase hasn't landed: stop and say so, or, if the user wants this phase first, drop the lines that use them (`TransitionLine(player: player)` in Task 12, `.downloads` in `SidebarItem`, `RequestsPage()` in Task 1, `MusicBrainzIndicator()` and the Requests link in Task 8, `.discoverDestinations()` in Task 11, `testDownloads` in Task 23).

**Step 2: Everything builds and passes now, on your own simulators**

```bash
xcrun simctl list devices available | grep -q "Playarr P10 iPad" || xcrun simctl create "Playarr P10 iPad" "iPad Pro 13-inch (M5)"
xcrun simctl list devices available | grep -q "Playarr P10 iPhone" || xcrun simctl create "Playarr P10 iPhone" "iPhone 17 Pro"
make -C apps/ios test SIMULATOR="Playarr P10 iPhone"
```

Expected: every package suite and every UI test passes. If something fails before any change, stop and report it. (Phase 6's notes record phase 4's `BrowseTests.testTheQueueClearsWithUndo` failing on `main`; if it still does, say so and carry on: Task 16 rewrites that row and Task 25 runs it again.)

---

### Task 1: Window layouts, sidebar places, and Requests as a page

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/ShellLayout.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/SideColumn.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/SidebarItem.swift`
- Modify: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/Route.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/RouteDestination.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Library/LibraryView.swift` (phase 8's Requests row)
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/ShellLayoutTests.swift`

`ShellLayout` is the web's breakpoint (`apps/web/src/lib/useMediaQuery.ts`: 768 px). `SidebarItem` is `Nav.tsx`'s `Sidebar`: `LINKS` in their order, Requests, the playlists and Settings, each with its page (a `Route`) and an identifier for UI tests. Its two `place` functions carry a place between the tabs and the sidebar.

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/ShellLayoutTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@Suite struct ShellLayoutTests {
  @Test func takesTheSidebarFromTheWebsDesktopWidth() {
    #expect(ShellLayout.choose(regularWidth: true, width: 1376) == .split)  // iPad Pro 13", landscape
    #expect(ShellLayout.choose(regularWidth: true, width: 1032) == .split)  // upright
    #expect(ShellLayout.choose(regularWidth: true, width: 768) == .split)
    #expect(ShellLayout.choose(regularWidth: true, width: 744) == .tabs)  // iPad mini upright
    #expect(ShellLayout.choose(regularWidth: true, width: 678) == .tabs)  // half the screen in Split View
    #expect(ShellLayout.choose(regularWidth: false, width: 1000) == .tabs)  // compact: Slide Over, a third
    #expect(ShellLayout.choose(regularWidth: false, width: 402) == .tabs)  // iPhone
  }

  @Test func listsTheDesktopLinksInTheWebsOrder() {
    #expect(SidebarItem.links.map(\.title) == ["Home", "Search", "Made for you", "Artists", "Albums", "Favorites", "Downloads", "Queue"])
    #expect(SidebarItem.playlist(3).identifier == "sidebar.playlist.3")
    #expect(SidebarItem.mixes.identifier == "sidebar.mixes")
  }

  @Test func knowsEachItemsPage() {
    #expect(SidebarItem.home.route == nil)
    #expect(SidebarItem.albums.route == .albums(.artist))
    #expect(SidebarItem.requests.route == .requests)
    #expect(SidebarItem(route: .playlist(3)) == .playlist(3))
    #expect(SidebarItem(route: .artists) == .artists)
    #expect(SidebarItem(route: .albums(.added)) == nil)
    #expect(SidebarItem(route: .album(70)) == nil)
  }

  @Test func readsTheRequestsPath() {
    #expect(Route(href: "/requests") == .requests)
  }

  @Test func carriesAPhonesPlaceToTheSidebar() {
    #expect(SidebarItem.place(tab: .home, path: [.album(70)]) == (.home, [.album(70)]))
    #expect(SidebarItem.place(tab: .library, path: [.artists, .artist(7)]) == (.artists, [.artist(7)]))
    #expect(SidebarItem.place(tab: .library, path: [.playlist(3)]) == (.playlist(3), []))
    #expect(SidebarItem.place(tab: .library, path: []) == (.home, []))
    #expect(SidebarItem.place(tab: .library, path: [.listening]) == (.home, [.listening]))
  }

  @Test func carriesTheSidebarsPlaceToAPhone() {
    #expect(SidebarItem.queue.place(detail: []) == (.queue, []))
    #expect(SidebarItem.artists.place(detail: [.artist(7)]) == (.library, [.artists, .artist(7)]))
    #expect(SidebarItem.requests.place(detail: []) == (.library, [.requests]))
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter ShellLayoutTests
```

Expected: the build fails with `cannot find 'ShellLayout' in scope` (and `type 'Route' has no member 'requests'`).

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/ShellLayout.swift`:

```swift
import CoreGraphics

/// Which chrome a window gets: the phone's tabs, or the desktop web's sidebar, page and player bar
/// (apps/web/src/components/AppShell.tsx mounts one or the other at Tailwind's `md`, 768 px).
public enum ShellLayout: String, Hashable, Sendable, Codable {
  case tabs, split

  /// The web's desktop breakpoint. An iPad window narrower than this (Slide Over, a third or half of the screen in
  /// Split View, a small Stage Manager window, an iPad mini held upright) gets the phone's tabs.
  public static let splitMinWidth: CGFloat = 768

  /// `regularWidth` is the window's horizontal size class being regular (always false on an iPhone).
  public static func choose(regularWidth: Bool, width: CGFloat) -> ShellLayout {
    regularWidth && width >= splitMinWidth ? .split : .tabs
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/SideColumn.swift`:

```swift
/// The column on the right of the iPad layout: the queue or the lyrics of the song playing.
public enum SideColumn: String, Hashable, Sendable, Codable, CaseIterable {
  case queue, lyrics

  public var title: String {
    switch self {
    case .queue: "Queue"
    case .lyrics: "Lyrics"
    }
  }

  public var systemImage: String {
    switch self {
    case .queue: "list.bullet"
    case .lyrics: "quote.bubble"
    }
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/SidebarItem.swift`:

```swift
import PlayarrAPI

/// A place in the iPad sidebar (apps/web/src/components/Nav.tsx `Sidebar`): the desktop links, Requests while
/// there are some, the playlists and Settings.
public enum SidebarItem: Hashable, Sendable, Codable {
  case home, search, mixes, artists, albums, favorites, downloads, queue, requests, playlists
  case playlist(Int)
  case settings

  /// The desktop links, in the web's order (`LINKS`).
  public static let links: [SidebarItem] = [.home, .search, .mixes, .artists, .albums, .favorites, .downloads, .queue]

  public var title: String {
    switch self {
    case .home: "Home"
    case .search: "Search"
    case .mixes: "Made for you"
    case .artists: "Artists"
    case .albums: "Albums"
    case .favorites: "Favorites"
    case .downloads: "Downloads"
    case .queue: "Queue"
    case .requests: "Requests"
    case .playlists: "Playlists"
    case .playlist: "Playlist"
    case .settings: "Settings"
    }
  }

  public var systemImage: String {
    switch self {
    case .home: "house"
    case .search: "magnifyingglass"
    case .mixes: "sparkles"
    case .artists: "music.mic"
    case .albums: "square.stack"
    case .favorites: "heart"
    case .downloads: "arrow.down.circle"
    case .queue: "list.bullet"
    case .requests: "arrow.down.to.line"
    case .playlists, .playlist: "music.note.list"
    case .settings: "gearshape"
    }
  }

  /// What UI tests find it by: "sidebar.home", "sidebar.playlist.3".
  public var identifier: String {
    switch self {
    case .playlist(let id): "sidebar.playlist.\(id)"
    default: "sidebar.\(String(describing: self))"
    }
  }

  /// The page it opens; nil for Home, Search and Queue, which are the tabs' own first pages.
  public var route: Route? {
    switch self {
    case .home, .search, .queue: nil
    case .mixes: .mixes
    case .artists: .artists
    case .albums: .albums(.artist)
    case .favorites: .favorites
    case .downloads: .downloads
    case .requests: .requests
    case .playlists: .playlists
    case .playlist(let id): .playlist(id)
    case .settings: .settings
    }
  }

  /// The item whose first page is `route`, if any.
  public init?(route: Route) {
    guard let item = Self.withPages.first(where: { $0.route == route }) else {
      if case .playlist(let id) = route { self = .playlist(id); return }
      return nil
    }
    self = item
  }

  private static let withPages: [SidebarItem] = [.mixes, .artists, .albums, .favorites, .downloads, .requests, .playlists, .settings]

  /// Where a phone's place lands in the sidebar when the window widens: Home, Search and Queue are items; a page
  /// opened from Library that has an item (Artists, a playlist…) becomes that item, the rest of the stack on top.
  public static func place(tab: AppTab, path: [Route]) -> (item: SidebarItem, detail: [Route]) {
    switch tab {
    case .home: (.home, path)
    case .search: (.search, path)
    case .queue: (.queue, path)
    case .library:
      if let first = path.first, let item = SidebarItem(route: first) {
        (item, Array(path.dropFirst()))
      } else {
        // Library's own list is the sidebar itself.
        (.home, path)
      }
    }
  }

  /// Where this item's place lands on a phone when the window narrows: its tab, or Library with its page first.
  public func place(detail: [Route]) -> (tab: AppTab, path: [Route]) {
    switch self {
    case .home: (.home, detail)
    case .search: (.search, detail)
    case .queue: (.queue, detail)
    default: (.library, (route.map { [$0] } ?? []) + detail)
    }
  }
}
```

`Route` becomes `Codable` (Task 3 keeps it in the scene's storage; the conformance is synthesized, which Swift only does in the type's own file) and gains Requests. If phase 7's `case downloads` sits after `case listening`, put `case requests` after it; the order doesn't matter.

In `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/Route.swift`, replace:

```swift
public enum Route: Hashable, Sendable {
```

with:

```swift
public enum Route: Hashable, Sendable, Codable {
```

Then, in the same file, replace:

```swift
  case listening
```

with:

```swift
  case listening
  case requests
```

Then, in the same file, replace:

```swift
    default: return nil
```

with:

```swift
    case ("requests", 1): self = .requests
    default: return nil
```

In `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/RouteDestination.swift`, replace:

```swift
    case .settings: SettingsView(session: session)
```

with:

```swift
    case .requests: RequestsPage()
    case .settings: SettingsView(session: session)
```

If phase 8's Library row (identifier `library-requests`) pushes `DiscoverDestination.requests`, make it push the route instead, since the Library tab's stack holds only `Route`s. In `Pages/Library/LibraryView.swift`, replace:

```swift
  NavigationLink(value: DiscoverDestination.requests) {
```

with:

```swift
  NavigationLink(value: Route.requests) {
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter ShellLayoutTests
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter RouterTests
```

Expected: `ShellLayoutTests` (6 tests) and phase 4's `RouterTests` pass.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/ShellLayout.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/SideColumn.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/SidebarItem.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/Route.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/RouteDestination.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Library/LibraryView.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/ShellLayoutTests.swift
git commit -F - <<'MSG'
iOS: the iPad's layouts at the web's desktop width, the sidebar's places, and Requests as a page

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

(Leave `LibraryView.swift` out of `git add` if Step 3 didn't change it.)

---

### Task 2: The router learns the iPad layout

**Files:**
- Modify: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/AppRouter.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/RouterLayoutTests.swift`

The sidebar's method is `select(sidebar:)`, not an overload of `select(_:)`: `.home`, `.search` and `.queue` are both `AppTab` and `SidebarItem` cases, and `router.select(.home)` in phase 4's tests would stop compiling.

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/RouterLayoutTests.swift`:

```swift
import Foundation
import Testing
@testable import PlayarrUI

@MainActor @Suite struct RouterLayoutTests {
  @Test func opensPagesInTheDetailColumn() {
    let router = AppRouter()
    router.setLayout(.split)
    router.select(sidebar: .albums)
    router.open(.album(70))
    #expect(router.detail == [.album(70)])
    #expect(router.paths.isEmpty)
    router.select(sidebar: .albums)
    #expect(router.detail.isEmpty)
  }

  @Test func opensTheQueueBesideThePageOnAnIPad() {
    let router = AppRouter()
    router.setLayout(.split)
    router.nowPlaying = true
    router.showQueue()
    #expect(router.column == .queue)
    #expect(!router.nowPlaying)
    #expect(router.sidebar == .home)
  }

  @Test func goesToSearchFromTheKeyboard() {
    let router = AppRouter()
    router.open(.album(70))
    router.openSearch()
    #expect(router.tab == .search)
    #expect(router.focusSearch)
    router.focusSearch = false
    router.setLayout(.split)
    router.select(sidebar: .artists)
    router.openSearch()
    #expect(router.sidebar == .search)
    #expect(router.focusSearch)
  }

  @Test func keepsThePageWhenTheWindowChangesWidth() {
    let router = AppRouter()
    router.select(.library)
    router.open(.artists)
    router.open(.artist(7))
    router.setLayout(.split)
    #expect(router.sidebar == .artists)
    #expect(router.detail == [.artist(7)])
    router.open(.album(70))
    router.column = .lyrics
    router.setLayout(.tabs)
    #expect(router.tab == .library)
    #expect(router.paths[.library] == [.artists, .artist(7), .album(70)])
    #expect(router.column == nil)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter RouterLayoutTests
```

Expected: the build fails with `value of type 'AppRouter' has no member 'setLayout'`.

**Step 3: Implement**

Keep anything later phases added to the router (phase 6 may have added the Add to playlist dialog's songs).

In `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/AppRouter.swift`, replace:

```swift
  public var lyrics = false
```

with:

```swift
  public var lyrics = false
  /// The window's layout (`AdaptiveShell` keeps it in step); `setLayout(_:)` carries the place across.
  public internal(set) var layout: ShellLayout = .tabs
  /// The iPad layout's sidebar item, and the stack of pages in its detail column.
  public var sidebar: SidebarItem = .home
  public var detail: [Route] = []
  /// The column on the right of the iPad layout; nil while closed.
  public var column: SideColumn?
  /// Search's field should take the cursor when it next shows ("/" on a keyboard); Search sets it back.
  public var focusSearch = false
```

Then, in the same file, replace:

```swift
  /// Opens a page on top of the current tab.
  public func open(_ route: Route) {
    paths[tab, default: []].append(route)
  }
```

with:

```swift
  /// Picks a sidebar item, on its first page (picking the one shown goes back to it too).
  public func select(sidebar item: SidebarItem) {
    sidebar = item
    detail = []
  }

  /// Opens a page on top of the current tab, or of the detail column.
  public func open(_ route: Route) {
    switch layout {
    case .tabs: paths[tab, default: []].append(route)
    case .split: detail.append(route)
    }
  }
```

Then, in the same file, replace:

```swift
  /// Now Playing → Open queue.
  public func showQueue() {
    nowPlaying = false
    tab = .queue
    paths[.queue] = []
  }
```

with:

```swift
  /// Now Playing → Open queue: the Queue tab on a phone, the queue column on an iPad.
  public func showQueue() {
    nowPlaying = false
    switch layout {
    case .tabs:
      tab = .queue
      paths[.queue] = []
    case .split:
      column = .queue
    }
  }

  /// "/" on a keyboard: Search, with the cursor in its field.
  public func openSearch() {
    nowPlaying = false
    switch layout {
    case .tabs:
      tab = .search
      paths[.search] = []
    case .split:
      select(sidebar: .search)
    }
    focusSearch = true
  }

  /// The window became wide enough for the sidebar, or too narrow for it: the same page stays on screen.
  public func setLayout(_ new: ShellLayout) {
    guard new != layout else { return }
    switch new {
    case .split:
      (sidebar, detail) = SidebarItem.place(tab: tab, path: paths[tab] ?? [])
    case .tabs:
      let (tab, path) = sidebar.place(detail: detail)
      self.tab = tab
      paths[tab] = path
      column = nil
    }
    layout = new
  }
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter "RouterLayoutTests|RouterTests"
```

Expected: `RouterLayoutTests` (4 tests) and phase 4's `RouterTests` (4) pass.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/AppRouter.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/RouterLayoutTests.swift
git commit -F - <<'MSG'
iOS: the router opens pages in the iPad's detail column and keeps the page when a window changes width

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 3: Where the app was, kept for the scene

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/RouterSnapshot.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/RouterSnapshotTests.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/RouterSnapshotTests.swift`:

```swift
import Foundation
import Testing
@testable import PlayarrUI

@MainActor @Suite struct RouterSnapshotTests {
  @Test func bringsTheAppBackWhereItWas() throws {
    let router = AppRouter()
    router.setLayout(.split)
    router.select(sidebar: .playlist(3))
    router.open(.album(70))
    router.column = .lyrics
    router.nowPlaying = true
    let data = try #require(router.snapshot(account: "demo-server/1").data)

    let again = AppRouter()
    again.restore(try #require(RouterSnapshot(data: data)), account: "demo-server/1", hasSong: true)
    #expect(again.layout == .split)
    #expect(again.sidebar == .playlist(3))
    #expect(again.detail == [.album(70)])
    #expect(again.column == .lyrics)
    #expect(again.nowPlaying)
  }

  @Test func keepsPhoneStacksAndSettingsPanels() throws {
    let router = AppRouter()
    router.select(.library)
    router.open(.settings)
    router.open(.settingsPanel(.appearance))
    let snapshot = try #require(RouterSnapshot(data: router.snapshot(account: "a").data))
    #expect(snapshot.paths[.library] == [.settings, .settingsPanel(.appearance)])
  }

  @Test func leavesAnotherAccountsPlaceAlone() throws {
    let router = AppRouter()
    router.open(.album(70))
    let snapshot = router.snapshot(account: "demo-server/1")
    let other = AppRouter()
    other.restore(snapshot, account: "demo-server/2", hasSong: true)
    #expect(other.paths.isEmpty)
  }

  @Test func opensNowPlayingOnlyWithASong() {
    let router = AppRouter()
    router.nowPlaying = true
    let other = AppRouter()
    other.restore(router.snapshot(account: "a"), account: "a", hasSong: false)
    #expect(!other.nowPlaying)
  }

  @Test func ignoresWhatItCantRead() {
    #expect(RouterSnapshot(data: Data("{}".utf8)) == nil)
    #expect(RouterSnapshot(data: nil) == nil)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter RouterSnapshotTests
```

Expected: the build fails with `cannot find 'RouterSnapshot' in scope`.

**Step 3: Implement**

`AppTab` and `SettingsPanel` are `String` enums, so `Codable` comes from their raw values and can be declared here.

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/RouterSnapshot.swift`:

```swift
import Foundation

/// Where the app was, kept in the scene's storage so iOS can bring the window back as it was after it closed the
/// app in the background: the tab or sidebar item, their pages, Now Playing and the side column. Only for the
/// account that was signed in.
public struct RouterSnapshot: Codable, Equatable, Sendable {
  public var account: String
  public var layout: ShellLayout
  public var tab: AppTab
  public var paths: [AppTab: [Route]]
  public var sidebar: SidebarItem
  public var detail: [Route]
  public var nowPlaying: Bool
  public var lyrics: Bool
  public var column: SideColumn?

  public var data: Data? { try? JSONEncoder().encode(self) }

  public init?(data: Data?) {
    guard let data, let snapshot = try? JSONDecoder().decode(RouterSnapshot.self, from: data) else { return nil }
    self = snapshot
  }

  @MainActor init(account: String, router: AppRouter) {
    self.account = account
    layout = router.layout
    tab = router.tab
    paths = router.paths
    sidebar = router.sidebar
    detail = router.detail
    nowPlaying = router.nowPlaying
    lyrics = router.lyrics
    column = router.column
  }
}

extension AppRouter {
  public func snapshot(account: String) -> RouterSnapshot {
    RouterSnapshot(account: account, router: self)
  }

  /// Puts the app back where `snapshot` was, if it was this account's. Now Playing opens again only with a song.
  public func restore(_ snapshot: RouterSnapshot, account: String, hasSong: Bool) {
    guard snapshot.account == account else { return }
    layout = snapshot.layout
    tab = snapshot.tab
    paths = snapshot.paths
    sidebar = snapshot.sidebar
    detail = snapshot.detail
    nowPlaying = snapshot.nowPlaying && hasSong
    lyrics = snapshot.lyrics
    column = snapshot.column
  }
}

extension AppTab: Codable {}
extension SettingsPanel: Codable {}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter RouterSnapshotTests
```

Expected: 5 tests pass.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/RouterSnapshot.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/RouterSnapshotTests.swift
git commit -F - <<'MSG'
iOS: a snapshot of where the app is, for the scene to bring back

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 4: Small shared pieces: text sizes, contrast, motion, the pointer, haptics

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Accessibility/AdaptiveStack.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Accessibility/Muted.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Accessibility/EnvironmentValues+ReducesMotion.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Accessibility/View+Pointer.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/Haptic.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/AccessibilityStyleTests.swift`

`hoverEffect` doesn't exist on the Mac, where `swift test` builds the package, so `pointerHover()` and `pointerLift()` keep it behind `#if os(iOS)` like phase 4's `Platform.swift`. `Haptic` names phase 4's `sensoryFeedback` choices once; Task 17 points phase 4's views at it.

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/AccessibilityStyleTests.swift`:

```swift
import SwiftUI
import Testing
@testable import PlayarrUI

@Suite struct AccessibilityStyleTests {
  @Test func stacksRowsAtTheAccessibilitySizes() {
    #expect(!AdaptiveStack<EmptyView>.stacks(at: .xxxLarge))
    #expect(AdaptiveStack<EmptyView>.stacks(at: .accessibility1))
    #expect(AdaptiveStack<EmptyView>.stacks(at: .accessibility5))
  }

  @Test func brightensSecondaryTextWithMoreContrast() {
    #expect(Muted.opacity(.standard) == 0.6)
    #expect(Muted.opacity(.increased) == 0.85)
  }

  @Test func tapsTheSameForTheSameKindOfThing() {
    #expect(Haptic.toast(isError: true) == .error)
    #expect(Haptic.toast(isError: false) == .success)
    #expect(Haptic.toggle == .selection)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter AccessibilityStyleTests
```

Expected: the build fails with `cannot find 'AdaptiveStack' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Accessibility/AdaptiveStack.swift`:

```swift
import SwiftUI

/// A row that turns into a column at the accessibility text sizes (AX1 to AX5), so titles wrap instead of being
/// cut short beside a time, a button or a slider.
struct AdaptiveStack<Content: View>: View {
  var spacing: CGFloat?
  @ViewBuilder var content: () -> Content
  @Environment(\.dynamicTypeSize) private var size

  nonisolated static func stacks(at size: DynamicTypeSize) -> Bool { size.isAccessibilitySize }

  var body: some View {
    let layout = Self.stacks(at: size)
      ? AnyLayout(VStackLayout(alignment: .leading, spacing: spacing))
      : AnyLayout(HStackLayout(spacing: spacing))
    layout(content)
  }
}

extension View {
  /// One line (or `lines`) at the usual sizes; at the accessibility sizes as many as it takes.
  func essentialLineLimit(_ lines: Int = 1) -> some View {
    modifier(EssentialLineLimit(lines: lines))
  }
}

private struct EssentialLineLimit: ViewModifier {
  let lines: Int
  @Environment(\.dynamicTypeSize) private var size

  func body(content: Content) -> some View {
    content.lineLimit(size.isAccessibilitySize ? nil : lines)
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Accessibility/Muted.swift`:

```swift
import SwiftUI

/// Secondary text (artists, times, counts) that gets brighter with Increase Contrast. Playarr is always dark, so
/// it's white at 60 %, or 85 % with more contrast (the system's `.secondary` doesn't move as far).
public struct Muted: ShapeStyle {
  public static func opacity(_ contrast: ColorSchemeContrast) -> Double {
    contrast == .increased ? 0.85 : 0.6
  }

  public func resolve(in environment: EnvironmentValues) -> Color {
    Color.white.opacity(Self.opacity(environment.colorSchemeContrast))
  }
}

extension ShapeStyle where Self == Muted {
  public static var muted: Muted { Muted() }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Accessibility/EnvironmentValues+ReducesMotion.swift`:

```swift
import SwiftUI

extension EnvironmentValues {
  /// Settings → Appearance → Motion, with the system's Reduce Motion when it's System: views that animate on their
  /// own (the playing waveform, springs) check this instead of the system setting alone. Set once by the shell.
  @Entry public var reducesMotion = false
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Accessibility/View+Pointer.swift`:

```swift
import SwiftUI

extension View {
  /// The iPad pointer's highlight on something that can be clicked (cards, rows, bar buttons). Nothing on the Mac,
  /// where `swift test` builds this package.
  func pointerHover() -> some View {
    #if os(iOS)
      hoverEffect(.highlight)
    #else
      self
    #endif
  }

  /// The pointer lifts a card (album and playlist covers), as the web's covers grow under the mouse.
  func pointerLift() -> some View {
    #if os(iOS)
      hoverEffect(.lift)
    #else
      self
    #endif
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/Haptic.swift`:

```swift
import SwiftUI

/// The app's taps, in one place, so the same kind of thing feels the same everywhere (the system turns them off
/// with Settings → Sounds & Haptics → System Haptics).
enum Haptic {
  /// Play or pause.
  static let playPause = SensoryFeedback.impact(weight: .medium)
  /// Something switched on or off: shuffle, repeat, lyrics, the side column, a favorite.
  static let toggle = SensoryFeedback.selection
  /// A song moved in the queue.
  static let reorder = SensoryFeedback.impact(weight: .light)
  /// Songs dropped on a playlist or the queue.
  static let dropped = SensoryFeedback.success

  static func toast(isError: Bool) -> SensoryFeedback {
    isError ? .error : .success
  }
}
```

**Step 4: Run it to see it pass, and build for the simulator**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter AccessibilityStyleTests
swift build --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --triple arm64-apple-ios26.0-simulator --sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" --scratch-path /tmp/playarr-ui-ios
```

Expected: 3 tests pass; the simulator build has no errors or warnings.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Accessibility apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/Haptic.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/AccessibilityStyleTests.swift
git commit -F - <<'MSG'
iOS: rows that stack at the largest text sizes, brighter secondary text with Increase Contrast, the pointer's highlight and the app's haptics in one place

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 5: Phase 6's favorites and playlists, as the shell calls them

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Session/AccountSession+Shell.swift`

The keyboard's L, the song rows' Favorites action, the sidebar's "+" and drops on playlists call these four methods; only their bodies know phase 6's stores, so a rename there is one edit here.

**Step 1: Write the file**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Session/AccountSession+Shell.swift`:

```swift
import PlayarrAPI

/// Phase 6's favorites and playlists as the shell calls them, in one place: the keyboard's L, the rows' VoiceOver
/// actions, the sidebar's "+" and dropping songs on a playlist.
extension AccountSession {
  public func isFavorite(_ track: Track) -> Bool {
    favorites.isFavorite(track.recordingId)
  }

  public func toggleFavorite(_ track: Track) {
    Task { await favorites.toggle(track) }
  }

  /// Songs dropped on one of your playlists (the toast is phase 6's: Added “Angel” to “Late night”).
  public func add(_ tracks: [Track], to playlist: PlaylistSummary) {
    Task { _ = await playlists.add(tracks, to: playlist.id) }
  }

  /// The sidebar's "+": phase 6's Add to playlist sheet with no songs, which makes a new playlist (the web's
  /// `openPlaylistPicker([])`).
  public func newPlaylist() {
    addToPlaylist([])
  }
}
```

**Step 2: Build and run the package's tests**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI 2>&1 | tail -1
```

Expected: every suite passes.

**Step 3: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Session/AccountSession+Shell.swift
git commit -F - <<'MSG'
iOS: favorites, adding to a playlist and a new playlist, as the iPad's shortcuts, drops and VoiceOver actions call them

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 6: The sidebar's foot

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Sidebar/SidebarFooter.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/SidebarFooterTests.swift`

`Nav.tsx` 191-235: the library's tracks, albums, runtime and size; a dot for Lidarr (only with a Lidarr source) and Streaming, grey until the server answers, green when it works, red with "offline" when the server says it doesn't; the version and commit (here the build). The MusicBrainz queue is phase 8's `MusicBrainzIndicator`.

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/SidebarFooterTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@Suite struct SidebarFooterTests {
  @Test func countsTheLibrary() {
    let footer = SidebarFooter(health: Demo.health, failed: false)
    #expect(footer.stats.map(\.label) == ["Tracks", "Albums", "Runtime", "Size"])
    #expect(footer.stats.map(\.value) == ["8", "3", "45 min", "0.2 GB"])
  }

  @Test func saysWhetherStreamingAndLidarrAnswer() {
    var health = Demo.health
    health.lidarr = HealthStatus.Lidarr(ok: false, error: "Connection refused")
    let footer = SidebarFooter(health: health, failed: false)
    #expect(footer.statuses == [
      .init(label: "Lidarr", state: .down, detail: "Connection refused", saysOffline: true),
      .init(label: "Streaming", state: .ok, detail: "local", saysOffline: false),
    ])
    health.lidarr = HealthStatus.Lidarr(ok: true, version: "2.9.6")
    #expect(SidebarFooter(health: health, failed: false).statuses.first?.detail == "v2.9.6")
  }

  @Test func showsGreyDotsUntilTheServerAnswers() {
    let waiting = SidebarFooter(health: nil, failed: false)
    #expect(waiting.stats.isEmpty)
    #expect(waiting.statuses == [.init(label: "Streaming", state: .unknown, detail: nil, saysOffline: false)])
    let unreachable = SidebarFooter(health: nil, failed: true)
    #expect(unreachable.statuses == [.init(label: "Streaming", state: .down, detail: nil, saysOffline: false)])
  }

  @Test func writesTheVersionAsTheWebDoes() {
    #expect(SidebarFooter.version(AppVersion(marketing: "1.0.0", build: "812")) == "v1.0.0 · 812")
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter SidebarFooterTests
```

Expected: the build fails with `cannot find 'SidebarFooter' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Sidebar/SidebarFooter.swift`:

```swift
import Foundation
import PlayarrAPI

/// The foot of the sidebar (apps/web/src/components/Nav.tsx 191-235): the library's counts, then whether Lidarr
/// and streaming answer. The MusicBrainz queue (phase 8's `MusicBrainzIndicator`) and the version follow it.
public struct SidebarFooter: Equatable, Sendable {
  public struct Stat: Equatable, Sendable {
    public let label: String
    public let value: String
  }

  public struct Status: Equatable, Sendable {
    public enum State: Equatable, Sendable { case unknown, ok, down }
    public let label: String
    public let state: State
    /// The version or source when it answers, the error when it doesn't.
    public let detail: String?
    /// "offline" beside the name: it's down and the server said so (not just unreachable).
    public let saysOffline: Bool
  }

  public let stats: [Stat]
  public let statuses: [Status]

  /// `failed`: asking the server for its health failed.
  public init(health: HealthStatus?, failed: Bool) {
    if let library = health?.library {
      stats = [
        Stat(label: "Tracks", value: String(library.tracks)),
        Stat(label: "Albums", value: String(library.albums)),
        Stat(label: "Runtime", value: Format.duration(library.durationSeconds)),
        Stat(label: "Size", value: String(format: "%.1f GB", Double(library.sizeBytes) / 1e9)),
      ]
    } else {
      stats = []
    }
    func state(_ ok: Bool?) -> Status.State {
      if health == nil && !failed { return .unknown }
      return ok == true && !failed ? .ok : .down
    }
    var statuses: [Status] = []
    if let lidarr = health?.lidarr {
      let s = state(lidarr.ok)
      statuses.append(Status(label: "Lidarr", state: s, detail: lidarr.ok ? lidarr.version.map { "v\($0)" } : lidarr.error, saysOffline: s == .down))
    }
    let media = health?.media
    let s = state(media?.ok)
    statuses.append(Status(label: "Streaming", state: s, detail: media?.ok == true ? media?.source.rawValue : media?.error, saysOffline: s == .down && health != nil))
    self.statuses = statuses
  }

  /// "v1.0.0 · 812": the version and the build, as the web shows its version and commit.
  public static func version(_ version: AppVersion) -> String {
    "v\(version.marketing) · \(version.build)"
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter SidebarFooterTests
```

Expected: 4 tests pass.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Sidebar/SidebarFooter.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/SidebarFooterTests.swift
git commit -F - <<'MSG'
iOS: the sidebar's foot: the library in numbers, whether Lidarr and streaming answer, and the version

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 7: Dragging songs

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Drag/TrackDrag.swift`
- Modify: `apps/ios/Config/Info.plist`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/TrackDragTests.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/TrackDragTests.swift`:

```swift
import Foundation
import UniformTypeIdentifiers
import PlayarrAPI
import Testing
@testable import PlayarrUI

@Suite struct TrackDragTests {
  @Test func carriesTheSongs() throws {
    let drag = TrackDrag(tracks: Array(Demo.mezzanineTracks.prefix(2)))
    let back = try JSONDecoder().decode(TrackDrag.self, from: JSONEncoder().encode(drag))
    #expect(back == drag)
    #expect(TrackDrag.tracks([drag, TrackDrag(tracks: Array(Demo.dummyTracks.prefix(2)))]).map(\.title) == ["Angel", "Risingson", "Mysterons", "Sour Times"])
    #expect(UTType.playarrTracks.identifier == "me.tracklistme.playarr.tracks")
  }

  @Test func dropsOnlyOnYourOwnPlaylists() {
    var shared = Demo.playlist
    #expect(TrackDrag.accepts(shared))
    shared.mine = false
    #expect(!TrackDrag.accepts(shared))
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter TrackDragTests
```

Expected: the build fails with `cannot find 'TrackDrag' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Drag/TrackDrag.swift`:

```swift
import CoreTransferable
import PlayarrAPI
import UniformTypeIdentifiers

extension UTType {
  /// Songs dragged inside Playarr. Declared in Config/Info.plist (`UTExportedTypeDeclarations`).
  public static let playarrTracks = UTType(exportedAs: "me.tracklistme.playarr.tracks")
}

/// Songs being dragged (a song row, on iPad): dropped on one of your playlists in the sidebar, or on the queue.
public struct TrackDrag: Codable, Transferable, Sendable, Equatable {
  public var tracks: [Track]

  public init(tracks: [Track]) {
    self.tracks = tracks
  }

  public static var transferRepresentation: some TransferRepresentation {
    CodableRepresentation(contentType: .playarrTracks)
  }

  /// The songs of everything dropped at once, in order.
  public static func tracks(_ drops: [TrackDrag]) -> [Track] {
    drops.flatMap(\.tracks)
  }

  /// Only your own playlists take songs: a playlist shared with you is changed by its owner.
  public static func accepts(_ playlist: PlaylistSummary) -> Bool {
    playlist.mine
  }
}
```

Declare the type in the app's Info.plist (`UTType(exportedAs:)` expects it there; without it iOS logs a warning and drops may not match). `plutil` edits the file in place and keeps its XML:

```bash
plutil -replace UTExportedTypeDeclarations -json '[{"UTTypeIdentifier":"me.tracklistme.playarr.tracks","UTTypeDescription":"Playarr songs","UTTypeConformsTo":["public.data"]}]' apps/ios/Config/Info.plist
plutil -lint apps/ios/Config/Info.plist
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter TrackDragTests
```

Expected: 2 tests pass; `plutil` says `OK`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Drag/TrackDrag.swift apps/ios/Config/Info.plist apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/TrackDragTests.swift
git commit -F - <<'MSG'
iOS: songs can be dragged, as their own type, onto your playlists and the queue

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 8: The sidebar

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Sidebar/Sidebar.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Sidebar/SidebarFooterView.swift`

The web's `Sidebar`: the links (a `List` with selection, so the system draws the selected row and VoiceOver says "selected"), Requests with a badge of the requests on their way, then the playlists from phase 6's `PlaylistsStore` (so one made from "+", Library or Add to playlist appears at once) under a "Playlists" header that opens the Playlists page and a "+" that makes a new one ("No playlists yet." while there are none), Settings, and the foot. Health is asked again every 30 s while the sidebar shows (the query only asks when its answer is older than that), so the dots follow the server as the web's do. Songs dropped on Queue or on one of your playlists land there, with a success tap. Each row's `Label` is made one element (`.accessibilityElement(children: .combine)`) before its identifier: on a bare `Label` the identifier lands on the icon, and UI tests tapping `sidebar.albums` would find an image with no action.

**Step 1: Write the views**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Sidebar/SidebarFooterView.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// The sidebar's foot: the library in four numbers, the status dots, the MusicBrainz queue and the version.
struct SidebarFooterView: View {
  let footer: SidebarFooter
  let version: AppVersion

  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      if !footer.stats.isEmpty {
        let columns = Array(repeating: GridItem(.flexible(), alignment: .leading), count: typeSize.isAccessibilitySize ? 1 : 2)
        LazyVGrid(columns: columns, alignment: .leading, spacing: 8) {
          ForEach(footer.stats, id: \.label) { stat in
            VStack(alignment: .leading, spacing: 2) {
              Text(stat.label.uppercased()).font(.caption2.monospaced()).tracking(1.5).foregroundStyle(.muted)
              Text(stat.value).font(.caption.monospaced())
            }
            .accessibilityElement(children: .combine)
          }
        }
      }
      ForEach(footer.statuses, id: \.label) { status in
        HStack(spacing: 8) {
          Circle().fill(color(status.state)).frame(width: 6, height: 6).accessibilityHidden(true)
          Text(status.label)
          if status.saysOffline { Text("offline").foregroundStyle(.red.opacity(0.8)) }
        }
        .font(.caption.monospaced())
        .foregroundStyle(.muted)
        .accessibilityElement(children: .combine)
        .accessibilityValue(spoken(status))
      }
      MusicBrainzIndicator()
      Text(SidebarFooter.version(version)).font(.caption2.monospaced()).foregroundStyle(.muted)
        .accessibilityLabel("Playarr \(version.label)")
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("sidebar.footer")
  }

  private func color(_ state: SidebarFooter.Status.State) -> Color {
    switch state {
    case .unknown: .gray
    case .ok: .green
    case .down: .red
    }
  }

  /// "Working, local" / "Not working, Connection refused".
  private func spoken(_ status: SidebarFooter.Status) -> String {
    let state = switch status.state {
    case .unknown: "Checking"
    case .ok: "Working"
    case .down: "Not working"
    }
    return [state, status.detail].compactMap(\.self).joined(separator: ", ")
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Sidebar/Sidebar.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// The iPad sidebar (apps/web/src/components/Nav.tsx `Sidebar`): the desktop links, Requests while there are some
/// (with how many are on their way), your playlists with "+" for a new one, Settings, and the foot. Songs dragged
/// onto one of your playlists are added to it; onto Queue, to the queue.
struct Sidebar: View {
  let session: AccountSession
  @State private var health: Query<HealthStatus>
  @State private var dropped = 0
  @Environment(AppModel.self) private var app
  @Environment(DiscoverContext.self) private var discover: DiscoverContext?

  init(session: AccountSession) {
    self.session = session
    let api = session.api
    _health = State(initialValue: Query(.health, cache: session.queries, staleAfter: 30) { try await api.send(API.Server.health()) })
  }

  var body: some View {
    let router = session.router
    List(selection: Binding<SidebarItem?>(get: { router.sidebar }, set: { if let item = $0 { router.select(sidebar: item) } })) {
      Section {
        ForEach(SidebarItem.links, id: \.self) { item in
          if item == .queue {
            link(item).dropDestination(for: TrackDrag.self) { drops, _ in
              session.actions.addToQueue(TrackDrag.tracks(drops))
              dropped += 1
              return true
            }
          } else {
            link(item)
          }
        }
        if let requests = discover?.requests, (requests.requests?.count ?? 0) > 0 {
          link(.requests).badge(requests.activeCount)
        }
      }
      Section {
        if let list = session.playlists.playlists {
          ForEach(list) { playlist in
            playlistRow(playlist)
          }
          if list.isEmpty {
            Text("No playlists yet.").font(.callout).foregroundStyle(.muted)
          }
        }
      } header: {
        HStack {
          Button("Playlists") { router.select(sidebar: .playlists) }
            .buttonStyle(.plain)
            .accessibilityIdentifier(SidebarItem.playlists.identifier)
          Spacer()
          Button { session.newPlaylist() } label: {
            Image(systemName: "plus").frame(width: 44, height: 44).contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .pointerHover()
          .accessibilityLabel("New playlist")
          .accessibilityIdentifier("sidebar.newPlaylist")
        }
      }
      Section {
        link(.settings)
      } footer: {
        SidebarFooterView(footer: SidebarFooter(health: health.value, failed: health.error != nil), version: app.appVersion)
          .padding(.top, 8)
      }
    }
    .listStyle(.sidebar)
    .navigationTitle("Playarr")
    .sensoryFeedback(Haptic.dropped, trigger: dropped)
    .task {
      // The foot's dots follow the server as the web's do (health is asked again once it's 30 s old).
      while !Task.isCancelled {
        await health.load()
        try? await Task.sleep(for: .seconds(30))
      }
    }
    .task { await session.playlists.load() }
    .refreshable {
      await health.refresh()
      await session.playlists.load()
    }
  }

  private func link(_ item: SidebarItem) -> some View {
    Label(item.title, systemImage: item.systemImage)
      // One element per row (its icon and name), so UI tests find the row itself by its identifier.
      .accessibilityElement(children: .combine)
      .tag(item)
      .accessibilityIdentifier(item.identifier)
  }

  private func playlistRow(_ playlist: PlaylistSummary) -> some View {
    Label(playlist.name, systemImage: SidebarItem.playlist(playlist.id).systemImage)
      .essentialLineLimit()
      .accessibilityElement(children: .combine)
      .tag(SidebarItem.playlist(playlist.id))
      .accessibilityIdentifier(SidebarItem.playlist(playlist.id).identifier)
      .dropDestination(for: TrackDrag.self) { drops, _ in
        guard TrackDrag.accepts(playlist) else { return false }
        session.add(TrackDrag.tracks(drops), to: playlist)
        dropped += 1
        return true
      }
  }
}
```

**Step 2: Build for the Mac and the iPhone simulator**

```bash
swift build --disable-sandbox --package-path apps/ios/Packages/PlayarrUI
swift build --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --triple arm64-apple-ios26.0-simulator --sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" --scratch-path /tmp/playarr-ui-ios
```

Expected: both build with no errors or warnings. (Nothing shows the sidebar until Task 11.)

**Step 3: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Sidebar/Sidebar.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Sidebar/SidebarFooterView.swift
git commit -F - <<'MSG'
iOS: the iPad sidebar: the desktop links, Requests, your playlists with a new one, Settings and the foot

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 9: The player bar

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/PlayerBar/VolumeDisplay.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/PlayerBar/VolumeControl.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/PlayerBar/PlayerBarTransport.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/PlayerBar/PlayerBar.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/VolumeDisplayTests.swift`

`PlayerBar.tsx`'s `PlayerBar`: left, the cover (opens Now Playing, labelled "Open now playing" like the mini player, so tests find either), the song and the heart. The web's title and artist are two small links; here they're one button at least 44 points tall that goes to the album, says "Title, Artist", and offers "Go to artist" both as a VoiceOver action and in its long-press menu (two one-line links side by side failed the audit's hit-area check); middle, the transport and the seek bar; right, the format badge, the queue and lyrics column buttons and the volume. "Nothing playing" while the queue is empty. At the accessibility sizes the three parts stack (`AdaptiveStack`) and the badge hides. Every button is at least 44 points.

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/VolumeDisplayTests.swift`:

```swift
import Testing
@testable import PlayarrUI

@Suite struct VolumeDisplayTests {
  @Test func showsTheSpeakerAsTheWebDoes() {
    #expect(VolumeDisplay(volume: 0.8, muted: false).systemImage == "speaker.wave.2.fill")
    #expect(VolumeDisplay(volume: 0.3, muted: false).systemImage == "speaker.wave.1.fill")
    #expect(VolumeDisplay(volume: 0, muted: false).systemImage == "speaker.slash.fill")
    #expect(VolumeDisplay(volume: 0.8, muted: true).systemImage == "speaker.slash.fill")
  }

  @Test func readsTheLevel() {
    #expect(VolumeDisplay(volume: 0.4, muted: false).valueText == "40%")
    #expect(VolumeDisplay(volume: 0.4, muted: true).valueText == "0%")
    #expect(VolumeDisplay(volume: 0.4, muted: true).muteLabel == "Unmute")
    #expect(VolumeDisplay(volume: 0.4, muted: false).muteLabel == "Mute")
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter VolumeDisplayTests
```

Expected: the build fails with `cannot find 'VolumeDisplay' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/PlayerBar/VolumeDisplay.swift`:

```swift
/// How the player bar shows the app's own volume (apps/web/src/components/PlayerBar.tsx `Volume`): what the speaker
/// icon is, what the mute button says and what VoiceOver reads for the slider. It's the app's volume, under the
/// device's: Even volume and the limiter work before it.
public struct VolumeDisplay: Equatable, Sendable {
  public let volume: Double
  public let muted: Bool

  public init(volume: Double, muted: Bool) {
    self.volume = volume
    self.muted = muted
  }

  /// What the slider shows: nothing while muted.
  public var shown: Double { muted ? 0 : volume }

  public var systemImage: String {
    if muted || volume == 0 { return "speaker.slash.fill" }
    return volume < 0.5 ? "speaker.wave.1.fill" : "speaker.wave.2.fill"
  }

  public var muteLabel: String { muted ? "Unmute" : "Mute" }

  /// "40%".
  public var valueText: String { "\(Int((shown * 100).rounded()))%" }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/PlayerBar/VolumeControl.swift`:

```swift
import PlayarrPlayer
import SwiftUI

/// The player bar's volume: mute and a slider for the app's own volume (↑/↓ on a keyboard move it too).
struct VolumeControl: View {
  let player: Player

  var body: some View {
    let display = VolumeDisplay(volume: player.queue.volume, muted: player.queue.muted)
    HStack(spacing: 4) {
      Button { player.toggleMute() } label: {
        Image(systemName: display.systemImage).frame(width: 44, height: 44).contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .foregroundStyle(.muted)
      .pointerHover()
      .accessibilityLabel(display.muteLabel)
      .accessibilityIdentifier("playerBar.mute")
      Slider(value: Binding(get: { display.shown }, set: { player.setVolume($0) }), in: 0...1, step: 0.05)
        .frame(width: 100)
        .accessibilityLabel("Volume")
        .accessibilityValue(display.valueText)
        .accessibilityIdentifier("playerBar.volume")
    }
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/PlayerBar/PlayerBarTransport.swift`:

```swift
import PlayarrPlayer
import SwiftUI

/// Shuffle, previous, play or pause, next and repeat, small enough for the bar (Now Playing has the big ones).
struct PlayerBarTransport: View {
  let player: Player
  @Environment(Theme.self) private var theme

  var body: some View {
    let q = player.queue
    HStack(spacing: 12) {
      button("shuffle", label: "Shuffle", on: q.shuffle) { player.toggleShuffle() }
        .accessibilityAddTraits(q.shuffle ? .isSelected : [])
        .sensoryFeedback(Haptic.toggle, trigger: q.shuffle)
      button("backward.fill", label: "Previous") { player.previous() }
      PlayPauseButton(player: player, size: 44)
      button("forward.fill", label: "Next") { player.next() }
      button(q.repeatMode == .one ? "repeat.1" : "repeat", label: "Repeat: \(q.repeatMode.rawValue)", on: q.repeatMode != .off) { player.cycleRepeat() }
        .sensoryFeedback(Haptic.toggle, trigger: q.repeatMode)
    }
  }

  private func button(_ image: String, label: String, on: Bool? = nil, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Image(systemName: image).frame(width: 44, height: 44).contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .foregroundStyle(on == true ? AnyShapeStyle(theme.accent.color) : on == false ? AnyShapeStyle(.muted) : AnyShapeStyle(.primary))
    .pointerHover()
    .accessibilityLabel(label)
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/PlayerBar/PlayerBar.swift`:

```swift
import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// The bar along the bottom of the iPad layout (apps/web/src/components/PlayerBar.tsx `PlayerBar`): the song (its
/// cover opens Now Playing, its title the album, its artist the artist) and the heart; the transport and the seek
/// bar; the format, the queue and lyrics columns, and the volume. At the accessibility text sizes the three parts
/// stack.
struct PlayerBar: View {
  let session: AccountSession
  @Environment(Theme.self) private var theme
  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    let player = session.player
    AdaptiveStack(spacing: 16) {
      song(player.queue.currentTrack)
        .frame(maxWidth: typeSize.isAccessibilitySize ? nil : .infinity, alignment: .leading)
      VStack(spacing: 0) {
        PlayerBarTransport(player: player)
        SeekBar(player: player)
      }
      .frame(maxWidth: 640)
      .disabled(player.queue.currentTrack == nil)
      controls(player)
        .frame(maxWidth: typeSize.isAccessibilitySize ? nil : .infinity, alignment: .trailing)
    }
    .padding(.horizontal, 20)
    .padding(.vertical, 8)
    .background(.bar)
    .overlay(alignment: .top) {
      // The accent's glow along the top edge, tinted by the cover playing.
      LinearGradient(colors: [.clear, theme.accent.color.opacity(0.5), .clear], startPoint: .leading, endPoint: .trailing)
        .frame(height: 1)
        .accessibilityHidden(true)
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("playerBar")
  }

  @ViewBuilder
  private func song(_ track: Track?) -> some View {
    if let track {
      HStack(spacing: 14) {
        Button { session.router.nowPlaying = true } label: {
          Cover(path: track.coverUrl, points: 56, label: track.albumTitle, corner: 3).frame(width: 56, height: 56)
        }
        .buttonStyle(.plain)
        .pointerLift()
        .accessibilityLabel("Open now playing")
        .accessibilityValue("\(track.title), \(track.artistName)")
        // One target, 44 points high, for the title and artist: the album, or the artist from its menu.
        Button { session.router.open(.album(track.albumId)) } label: {
          VStack(alignment: .leading, spacing: 2) {
            Text(track.title).font(.subheadline).essentialLineLimit()
            Text(track.artistName).font(.caption).foregroundStyle(.muted).essentialLineLimit()
          }
          .frame(minHeight: 44, alignment: .leading)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .pointerHover()
        .accessibilityLabel("\(track.title), \(track.artistName)")
        .accessibilityHint("Opens the album")
        .accessibilityAction(named: "Go to artist") { session.router.open(.artist(track.artistId)) }
        .contextMenu {
          Button("Go to album", systemImage: "square.stack") { session.router.open(.album(track.albumId)) }
          Button("Go to artist", systemImage: "music.mic") { session.router.open(.artist(track.artistId)) }
        }
        FavoriteButton(track: track)
      }
    } else {
      Kicker(text: "Nothing playing")
    }
  }

  private func controls(_ player: Player) -> some View {
    HStack(spacing: 4) {
      if let format = player.queue.currentTrack?.format, !typeSize.isAccessibilitySize {
        FormatBadge(format: format).padding(.trailing, 8)
      }
      ForEach(SideColumn.allCases, id: \.self) { column in
        columnButton(column)
      }
      VolumeControl(player: player)
    }
  }

  private func columnButton(_ column: SideColumn) -> some View {
    let router = session.router
    let open = router.column == column
    return Button { router.column = open ? nil : column } label: {
      Image(systemName: column.systemImage).frame(width: 44, height: 44).contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .foregroundStyle(open ? AnyShapeStyle(theme.accent.color) : AnyShapeStyle(.muted))
    .pointerHover()
    .accessibilityLabel(column.title)
    .accessibilityAddTraits(open ? .isSelected : [])
    .accessibilityIdentifier("playerBar.\(column.rawValue)")
    .sensoryFeedback(Haptic.toggle, trigger: open)
  }
}
```

**Step 4: Run it to see it pass, and build for the simulator**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter VolumeDisplayTests
swift build --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --triple arm64-apple-ios26.0-simulator --sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" --scratch-path /tmp/playarr-ui-ios
```

Expected: 2 tests pass; the simulator build is clean.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/PlayerBar apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/VolumeDisplayTests.swift
git commit -F - <<'MSG'
iOS: the iPad's player bar: the song, the transport and seek bar, the queue and lyrics column, and the volume

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 10: Up next in Now Playing, and the side column

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/NowPlaying/UpNextPreview.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/SideColumnView.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/UpNextPreviewTests.swift`

`NowPlaying.tsx`'s `UpNext` (desktop only): `order.slice(pos + 1, pos + 5)`, so no wrapping round with repeat all; a tap plays from that song (`jumpTo(pos + 1 + i)`); "Queue" opens the queue. The side column switches between phase 4's `QueueView` and `LyricsView` with a segmented control at its top.

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/UpNextPreviewTests.swift`:

```swift
import PlayarrPlayer
import Testing
@testable import PlayarrUI

@MainActor @Suite struct UpNextPreviewTests {
  @Test func listsTheNextFourSongs() {
    let player = demoSession().player
    player.play(Demo.mezzanineTracks + Demo.protectionTracks + Demo.dummyTracks)
    let entries = UpNextPreview.entries(player.queue)
    #expect(entries.map(\.track.title) == ["Risingson", "Inertia Creeps", "Protection", "Karmacoma"])
    #expect(entries.map(\.orderPos) == [1, 2, 3, 4])
    player.jump(to: 6)
    #expect(UpNextPreview.entries(player.queue).map(\.track.title) == ["Glory Box"])
    #expect(UpNextPreview.entries(QueueState()).isEmpty)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter UpNextPreviewTests
```

Expected: the build fails with `cannot find 'UpNextPreview' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/NowPlaying/UpNextPreview.swift`:

```swift
import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// Now Playing's "Up next" on an iPad (apps/web/src/components/NowPlaying.tsx `UpNext`, desktop only): the next four
/// songs, tap one to play from it, and Queue to see the rest.
struct UpNextPreview: View {
  static let count = 4

  let session: AccountSession

  /// The next songs in play order, with their place in it (what `jump(to:)` takes).
  static func entries(_ queue: QueueState) -> [(orderPos: Int, track: Track)] {
    guard queue.pos >= 0 else { return [] }
    return queue.order.indices.dropFirst(queue.pos + 1).prefix(count).map { ($0, queue.queue[queue.order[$0]]) }
  }

  var body: some View {
    let entries = Self.entries(session.player.queue)
    if !entries.isEmpty {
      VStack(alignment: .leading, spacing: 4) {
        HStack {
          Kicker(text: "Up next").accessibilityAddTraits(.isHeader)
          Spacer()
          Button { session.router.showQueue() } label: { Kicker(text: "Queue").frame(minHeight: 44) }
            .buttonStyle(.plain)
            .accessibilityLabel("Open queue")
        }
        ForEach(entries, id: \.orderPos) { entry in
          row(entry.track, at: entry.orderPos)
        }
      }
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("nowPlaying.upNext")
    }
  }

  private func row(_ track: Track, at orderPos: Int) -> some View {
    Button { session.player.jump(to: orderPos) } label: {
      HStack(spacing: 12) {
        Cover(path: track.coverUrl, points: 36, label: track.albumTitle, corner: 3).frame(width: 36, height: 36)
        VStack(alignment: .leading, spacing: 0) {
          Text(track.title).font(.subheadline).essentialLineLimit()
          Text(track.artistName).font(.caption).foregroundStyle(.muted).essentialLineLimit()
        }
        Spacer(minLength: 8)
        Text(Format.time(track.duration)).font(.caption.monospacedDigit()).foregroundStyle(.muted)
      }
      .frame(minHeight: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .pointerHover()
    .accessibilityLabel("\(track.title), \(track.artistName), \(Format.time(track.duration))")
    .accessibilityHint("Plays from this song")
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/SideColumnView.swift`:

```swift
import SwiftUI

/// The column on the right of the iPad layout: the queue (songs can be dropped on it) or the lyrics of the song
/// playing, switched at its top.
struct SideColumnView: View {
  let session: AccountSession
  @State private var dropped = 0

  var body: some View {
    let router = session.router
    VStack(spacing: 0) {
      Picker("Show", selection: Binding(get: { router.column ?? .queue }, set: { router.column = $0 })) {
        ForEach(SideColumn.allCases, id: \.self) { Text($0.title).tag($0) }
      }
      .pickerStyle(.segmented)
      .padding(12)
      switch router.column ?? .queue {
      case .queue:
        NavigationStack { QueueView(session: session) }
          .dropDestination(for: TrackDrag.self) { drops, _ in
            session.actions.addToQueue(TrackDrag.tracks(drops))
            dropped += 1
            return true
          }
      case .lyrics:
        if let track = session.player.queue.currentTrack {
          LyricsView(trackId: track.id, session: session).id(track.id)
        } else {
          ContentUnavailableView("Nothing playing", systemImage: "quote.bubble")
        }
      }
    }
    .sensoryFeedback(Haptic.dropped, trigger: dropped)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("sideColumn")
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter UpNextPreviewTests
```

Expected: 1 test passes.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/NowPlaying/UpNextPreview.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/SideColumnView.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/UpNextPreviewTests.swift
git commit -F - <<'MSG'
iOS: Now Playing's Up next for the iPad, and the column beside the page with the queue or the lyrics

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 11: The iPad layout in the app, switching with the window

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/TabShell.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/SplitShell.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/AdaptiveShell.swift`
- Modify: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/AppShell.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/AppModel.swift`

Phase 4's `TabView` moves from `AppShell` into `TabShell` unchanged, except that each stack gets `shellDestinations(_:)`: phase 4's `routeDestinations` plus phase 8's `.discoverDestinations()`, so the tabs and the detail column can show the same pages. If phase 8 (or another phase) added modifiers inside the `TabView` block, carry them into `TabShell` (those on each stack's root go into `shellDestinations` instead, so the iPad's stack gets them too). `AppShell` keeps everything else (Now Playing, toasts, Stats for nerds, the accounts sheet, the environment, phase 8's `.discoverRoot`), so both layouts share it. `AdaptiveShell` measures the window, puts the router in step before the first frame (`onAppear`) and on every change, and keeps the router's snapshot in `@SceneStorage`. `SplitShell` puts the side column in an `.inspector` on the `NavigationSplitView` itself: on the detail column's `NavigationStack` the inspector didn't appear. `AppModel.restoresPlace` lets UI tests start on Home; `demo(api:)` lets them use a server that can't be reached (Task 18).

**Step 1: Write the views**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/TabShell.swift`:

```swift
import SwiftUI

/// The phone layout (phase 4's tabs, moved here from AppShell): Home, Search, Library and Queue, each a stack of
/// pages, with the mini player above the tab bar. iPad windows narrower than the web's desktop width get it too.
struct TabShell: View {
  let session: AccountSession

  var body: some View {
    let router = session.router
    TabView(selection: Binding(get: { router.tab }, set: { router.select($0) })) {
      ForEach(AppTab.allCases, id: \.self) { tab in
        Tab(tab.title, systemImage: tab.systemImage, value: tab, role: tab == .search ? .search : nil) {
          NavigationStack(path: Binding(get: { router.paths[tab] ?? [] }, set: { router.paths[tab] = $0 })) {
            root(tab).shellDestinations(session)
          }
        }
      }
    }
    .minimizingTabBar()
    .miniPlayer(isShown: session.player.queue.currentTrack != nil) { MiniPlayer(session: session) }
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

extension View {
  /// Every page a stack can show: phase 4's routes, and what later phases push (phase 8's Discover pages).
  func shellDestinations(_ session: AccountSession) -> some View {
    routeDestinations(session).discoverDestinations()
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/SplitShell.swift`:

```swift
import SwiftUI

/// The iPad layout (apps/web/src/components/AppShell.tsx on a desktop): the sidebar, the page with its stack, the
/// queue or lyrics in a column on the right when asked for, and the player bar along the bottom.
struct SplitShell: View {
  let session: AccountSession
  @State private var columns = NavigationSplitViewVisibility.all

  var body: some View {
    let router = session.router
    NavigationSplitView(columnVisibility: $columns) {
      Sidebar(session: session)
        .navigationSplitViewColumnWidth(min: 220, ideal: 260, max: 320)
    } detail: {
      NavigationStack(path: Binding(get: { router.detail }, set: { router.detail = $0 })) {
        root(router.sidebar)
          .shellDestinations(session)
      }
      .id(router.sidebar)
    }
    .inspector(isPresented: Binding(get: { router.column != nil }, set: { if !$0 { router.column = nil } })) {
      SideColumnView(session: session)
        .inspectorColumnWidth(min: 300, ideal: 340, max: 440)
    }
    .safeAreaInset(edge: .bottom, spacing: 0) {
      PlayerBar(session: session)
    }
  }

  @ViewBuilder private func root(_ item: SidebarItem) -> some View {
    switch item {
    case .home: HomeView(session: session)
    case .search: SearchView(session: session)
    case .queue: QueueView(session: session)
    default:
      if let route = item.route { RouteDestination(route: route, session: session) }
    }
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/AdaptiveShell.swift`:

```swift
import SwiftUI

/// The tabs or the iPad layout, whichever the window's width calls for (`ShellLayout`), switching as it's resized
/// (Split View, Slide Over, Stage Manager, turning an iPad mini) without losing the page. It also keeps where the
/// app is in the scene's storage, so a window iOS closed in the background opens where it was.
struct AdaptiveShell: View {
  let session: AccountSession
  @SceneStorage("router") private var saved: Data?
  @State private var restored = false
  @Environment(AppModel.self) private var app
  #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
  #endif

  var body: some View {
    let router = session.router
    GeometryReader { proxy in
      let wanted = ShellLayout.choose(regularWidth: regularWidth, width: proxy.size.width)
      Group {
        switch router.layout {
        case .tabs: TabShell(session: session)
        case .split: SplitShell(session: session)
        }
      }
      .onAppear {
        restore()
        router.setLayout(wanted)
      }
      .onChange(of: wanted) { _, layout in router.setLayout(layout) }
    }
    .onChange(of: router.snapshot(account: account)) { _, snapshot in saved = snapshot.data }
  }

  private var regularWidth: Bool {
    #if os(iOS)
      sizeClass == .regular
    #else
      true
    #endif
  }

  private var account: String { "\(session.key.serverId)/\(session.key.accountId)" }

  private func restore() {
    guard !restored, app.restoresPlace else { return }
    restored = true
    if let snapshot = RouterSnapshot(data: saved) {
      session.router.restore(snapshot, account: account, hasSong: session.player.queue.currentTrack != nil)
    }
  }
}
```

**Step 2: Put it in the shell**

In `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/AppShell.swift`, replace:

```swift
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
```

with:

```swift
    // The phone's tabs, or the iPad's sidebar and player bar, as wide as the window is.
    AdaptiveShell(session: session)
```

Then, in the same file, replace:

```swift


  @ViewBuilder private func root(_ tab: AppTab) -> some View {
    switch tab {
    case .home: HomeView(session: session)
    case .search: SearchView(session: session)
    case .library: LibraryView(session: session)
    case .queue: QueueView(session: session)
    }
  }
```

with:

```swift

```

Then, in the same file, replace:

```swift
      NowPlayingView(session: session).environment(session).environment(model.theme).environment(model.appearance)
```

with:

```swift
      NowPlayingView(session: session).environment(session).environment(model.theme).environment(model.appearance)
        .environment(\.reducesMotion, model.appearance.reduceMotion(system: systemReduceMotion))
```

Then, in the same file, replace:

```swift
    .tint(model.theme.accent.color)
```

with:

```swift
    .environment(\.reducesMotion, model.appearance.reduceMotion(system: systemReduceMotion))
    .tint(model.theme.accent.color)
```

In `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/AppModel.swift`, replace:

```swift
    public var showingAccounts = false
```

with:

```swift
    public var showingAccounts = false
    /// The window comes back where it was after iOS closed the app in the background. UI tests turn it off (each
    /// test starts on Home) unless they launch with `-UITestsRestore`.
    public var restoresPlace = true
```

Then, in the same file, replace:

```swift
    public static func demo() -> AppModel {
```

with:

```swift
    public static func demo(api: any APISending = DemoAPI()) -> AppModel {
```

Then, in the same file, replace:

```swift
            makeSession: { record, model in try AccountSession.demo(record, model: model) })
```

with:

```swift
            makeSession: { record, model in try AccountSession.demo(record, model: model, api: api) })
```

**Step 3: Build everything and run every test**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI 2>&1 | tail -1
make -C apps/ios build SIMULATOR="Playarr P10 iPad"
```

Expected: every package suite passes; `** BUILD SUCCEEDED **`.

**Step 4: Look at it on the iPad simulator**

```bash
xcrun simctl boot "Playarr P10 iPad" 2>/dev/null || true
open -a Simulator
xcrun simctl install "Playarr P10 iPad" apps/ios/build/DerivedData/Build/Products/Debug-iphonesimulator/Playarr.app
xcrun simctl launch "Playarr P10 iPad" me.tracklistme.playarr -UITests -UITestsDemo
```

Check: the sidebar (Home … Queue, Late night under Playlists, Settings, the foot with TRACKS 8, ALBUMS 3, the Streaming dot green, the version), the player bar saying "Nothing playing"; Albums → Mezzanine → Play shows the song in the bar; the bar's queue button opens the column on the right. Turn the simulator (⌘←): the layout stays. Stop with `xcrun simctl terminate "Playarr P10 iPad" me.tracklistme.playarr`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/TabShell.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/SplitShell.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/AdaptiveShell.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/AppShell.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/AppModel.swift
git commit -F - <<'MSG'
iOS: the iPad layout: sidebar, page, queue or lyrics column and player bar, the phone's tabs in narrow windows, and the place kept for the scene

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 12: Now Playing on the iPad

**Files:**
- Modify: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/NowPlaying/NowPlayingView.swift`

In the iPad layout, Now Playing is the web's desktop one: the cover (or lyrics) beside the song, its controls, the transition line and Up next. Its close button carries `.keyboardShortcut(.cancelAction)` for Escape (checked on a device in Task 26: the simulator didn't deliver Escape to the full-screen cover). "Playing from" stops wrapping its button in a combined element (the conventions' rule): the button says "Playing from Mezzanine" itself. The lyrics button taps like other toggles, and the title (two lines at most at the usual sizes) wraps as far as it needs at the accessibility sizes. Phase 5's `TransitionLine` stays under the transport in both layouts: the replacement below includes it once in each.

**Step 1: Edit**

In `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/NowPlaying/NowPlayingView.swift`, replace:

```swift
  @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
```

with:

```swift
  @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
  @Environment(\.dynamicTypeSize) private var typeSize
```

Then, in the same file, replace:

```swift
          if router.lyrics {
            LyricsView(trackId: track.id, session: session).id(track.id)
          } else {
            cover(track, playing: player.queue.playing)
              .gesture(closeGesture)
          }
          song(track)
          SeekBar(player: player)
          Transport(player: player)
          TransitionLine(player: player)
          Spacer(minLength: 0)
```

with:

```swift
          if router.layout == .split && !typeSize.isAccessibilitySize {
            // The web's desktop Now Playing: the cover (or lyrics) beside the song, its controls and Up next.
            HStack(spacing: 64) {
              artwork(track)
              VStack(spacing: 24) {
                song(track)
                SeekBar(player: player)
                Transport(player: player)
                TransitionLine(player: player)
                UpNextPreview(session: session)
              }
              .frame(maxWidth: 480)
            }
          } else {
            artwork(track)
            song(track)
            SeekBar(player: player)
            Transport(player: player)
            TransitionLine(player: player)
          }
          Spacer(minLength: 0)
```

Then, in the same file, replace:

```swift
  /// The cover itself, blown up and blurred.
```

with:

```swift
  /// The cover, or the lyrics in its place.
  @ViewBuilder
  private func artwork(_ track: Track) -> some View {
    if session.router.lyrics {
      LyricsView(trackId: track.id, session: session).id(track.id)
    } else {
      cover(track, playing: session.player.queue.playing)
        .gesture(closeGesture)
    }
  }

  /// The cover itself, blown up and blurred.
```

Then, in the same file, replace:

```swift
        .accessibilityLabel("Close now playing")
```

with:

```swift
        .accessibilityLabel("Close now playing")
        .keyboardShortcut(.cancelAction)
```

Then, in the same file, replace:

```swift
        Kicker(text: "Playing from")
        Button(model.playingFrom ?? "") { if let route = model.playingFromRoute { session.router.go(route) } }
          .font(.footnote).lineLimit(1)
      }
      .accessibilityElement(children: .combine)
```

with:

```swift
        Kicker(text: "Playing from").accessibilityHidden(true)
        Button(model.playingFrom ?? "") { if let route = model.playingFromRoute { session.router.go(route) } }
          .font(.footnote).essentialLineLimit()
          .accessibilityLabel("Playing from \(model.playingFrom ?? "")")
      }
```

Then, in the same file, replace:

```swift
        .accessibilityAddTraits(session.router.lyrics ? .isSelected : [])
```

with:

```swift
        .accessibilityAddTraits(session.router.lyrics ? .isSelected : [])
        .sensoryFeedback(Haptic.toggle, trigger: session.router.lyrics)
```

Then, in the same file, replace:

```swift
Text(track.title).font(.title.weight(.semibold)).lineLimit(2)
```

with:

```swift
Text(track.title).font(.title.weight(.semibold)).essentialLineLimit(2)
```

**Step 2: Build, test, look**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI 2>&1 | tail -1
make -C apps/ios build SIMULATOR="Playarr P10 iPad"
```

Expected: tests pass, the build succeeds. On the iPad simulator (as in Task 11, Step 4), play Mezzanine and open Now Playing: the cover on the left, Up next with Risingson, Inertia Creeps on the right; tap Inertia Creeps and it plays; the close button closes it.

**Step 3: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/NowPlaying/NowPlayingView.swift
git commit -F - <<'MSG'
iOS: Now Playing on the iPad: the cover beside the song with Up next

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 13: What the keyboard's shortcuts do

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Keyboard/KeyCommand.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Keyboard/PlaybackControlling.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Keyboard/KeyCommandHandler.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/KeyCommandTests.swift`

`apps/web/src/player/useKeyboardShortcuts.ts`: Space play or pause; ←/→ 10 s back or ahead, within the song; Shift+←/→ previous or next song (previous restarts the song past 3 s, as the player's own `previous()`); ↑/↓ the volume by 5 %; M mute; S shuffle; L the song playing in or out of Favorites; / Search. The protocol lets the tests drive a fake player and check exactly what was asked; one test drives the real session too.

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/KeyCommandTests.swift`:

```swift
import PlayarrAPI
import SwiftUI
import Testing
@testable import PlayarrUI

/// The keyboard's player, writing down what it was asked.
@MainActor
final class FakeControls: PlaybackControlling {
  var song: Track?
  var time: Double = 0
  var duration: Double = 0
  var masterVolume: Double = 1
  var asked: [String] = []

  func togglePlay() { asked.append("togglePlay") }
  func seek(to seconds: Double) { asked.append("seek \(seconds)") }
  func next() { asked.append("next") }
  func previous() { asked.append("previous") }
  func setVolume(_ volume: Double) { masterVolume = volume; asked.append("volume \(volume)") }
  func toggleMute() { asked.append("mute") }
  func toggleShuffle() { asked.append("shuffle") }
}

@MainActor @Suite struct KeyCommandTests {
  func handler(_ controls: FakeControls, favorites: @escaping @MainActor (Track) -> Void = { _ in }, search: @escaping @MainActor () -> Void = {}) -> KeyCommandHandler {
    KeyCommandHandler(controls: controls, toggleFavorite: favorites, openSearch: search)
  }

  @Test func usesTheWebsKeys() {
    #expect(KeyCommand.playPause.key == .space)
    #expect(KeyCommand.next.key == .rightArrow && KeyCommand.next.modifiers == .shift)
    #expect(KeyCommand.seekForward.key == .rightArrow && KeyCommand.seekForward.modifiers == [])
    #expect(KeyCommand.search.key == "/")
    #expect(Set(KeyCommand.allCases.map { "\($0.key.character)\($0.modifiers.rawValue)" }).count == KeyCommand.allCases.count)
  }

  @Test func seeksTenSecondsWithinTheSong() {
    let controls = FakeControls()
    controls.song = Demo.mezzanineTracks[0]
    controls.duration = 379
    controls.time = 375
    let keys = handler(controls)
    keys.perform(.seekForward)
    controls.time = 4
    keys.perform(.seekBack)
    controls.time = 100
    keys.perform(.seekBack)
    #expect(controls.asked == ["seek 379.0", "seek 0.0", "seek 90.0"])
  }

  @Test func changesSongsAndPlaysOrPauses() {
    let controls = FakeControls()
    controls.song = Demo.mezzanineTracks[0]
    let keys = handler(controls)
    keys.perform(.playPause)
    keys.perform(.next)
    keys.perform(.previous)
    #expect(controls.asked == ["togglePlay", "next", "previous"])
  }

  @Test func movesTheVolumeInSteps() {
    let controls = FakeControls()
    controls.masterVolume = 0.97
    let keys = handler(controls)
    keys.perform(.volumeUp)
    keys.perform(.volumeDown)
    keys.perform(.volumeDown)
    #expect(controls.masterVolume == 0.9)
    controls.masterVolume = 0.02
    keys.perform(.volumeDown)
    #expect(controls.masterVolume == 0)
  }

  @Test func needsASongToPlayOrFavorite() {
    let controls = FakeControls()
    var favorited: [String] = []
    let keys = handler(controls, favorites: { favorited.append($0.title) })
    for command in [KeyCommand.playPause, .seekForward, .next, .favorite] { keys.perform(command) }
    keys.perform(.mute)
    keys.perform(.shuffle)
    #expect(controls.asked == ["mute", "shuffle"])
    controls.song = Demo.mezzanineTracks[0]
    keys.perform(.favorite)
    #expect(favorited == ["Angel"])
  }

  @Test func goesToSearch() {
    var searched = 0
    handler(FakeControls(), search: { searched += 1 }).perform(.search)
    #expect(searched == 1)
  }

  @Test func drivesTheSessionsPlayerAndRouter() {
    let session = demoSession()
    session.player.play(Demo.mezzanineTracks)
    let keys = KeyCommandHandler(session: session)
    keys.perform(.playPause)
    #expect(!session.player.queue.playing)
    keys.perform(.shuffle)
    #expect(session.player.queue.shuffle)
    keys.perform(.search)
    #expect(session.router.tab == .search)
  }

  @Test func readsTheShortcutsOut() {
    #expect(KeyboardShortcutsSection.spoken([["Shift", "←"], ["Shift", "→"]]) == "Shift + ← or Shift + →")
    #expect(KeyboardShortcutsSection.rows.count == 8)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter KeyCommandTests
```

Expected: the build fails with `cannot find type 'PlaybackControlling' in scope`. (`KeyboardShortcutsSection` in the last test comes in Task 14; until then, comment out `readsTheShortcutsOut` or write Task 14's file first.)

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Keyboard/KeyCommand.swift`:

```swift
import SwiftUI

/// The web's keyboard shortcuts (apps/web/src/player/useKeyboardShortcuts.ts), as menu commands: with a hardware
/// keyboard they work anywhere in the app except while typing, and show when ⌘ is held and in the iPad's menu bar.
public enum KeyCommand: String, CaseIterable, Sendable {
  case playPause, seekBack, seekForward, previous, next, volumeUp, volumeDown, mute, shuffle, favorite, search

  /// The playback menu's commands, in the web's order; Search has a menu of its own.
  public static let playback: [KeyCommand] = [.playPause, .seekBack, .seekForward, .previous, .next, .volumeUp, .volumeDown, .mute, .shuffle, .favorite]

  /// The menu item, in the words of the web's list (apps/web/src/components/PlaybackPanel.tsx `SHORTCUTS`).
  public var title: String {
    switch self {
    case .playPause: "Play or pause"
    case .seekBack: "Back 10 seconds"
    case .seekForward: "Ahead 10 seconds"
    case .previous: "Previous song"
    case .next: "Next song"
    case .volumeUp: "Volume up"
    case .volumeDown: "Volume down"
    case .mute: "Mute or unmute"
    case .shuffle: "Shuffle on or off"
    case .favorite: "Add the song playing to Favorites, or remove it"
    case .search: "Search"
    }
  }

  public var key: KeyEquivalent {
    switch self {
    case .playPause: .space
    case .seekBack, .previous: .leftArrow
    case .seekForward, .next: .rightArrow
    case .volumeUp: .upArrow
    case .volumeDown: .downArrow
    case .mute: "m"
    case .shuffle: "s"
    case .favorite: "l"
    case .search: "/"
    }
  }

  public var modifiers: EventModifiers {
    self == .previous || self == .next ? .shift : []
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Keyboard/PlaybackControlling.swift`:

```swift
import PlayarrAPI
import PlayarrPlayer

/// What the keyboard drives: the player, or a fake in tests.
@MainActor
public protocol PlaybackControlling: AnyObject {
  /// The song playing or paused, if any.
  var song: Track? { get }
  var time: Double { get }
  var duration: Double { get }
  /// The app's own volume, 0 to 1.
  var masterVolume: Double { get }
  func togglePlay()
  func seek(to seconds: Double)
  func next()
  func previous()
  func setVolume(_ volume: Double)
  func toggleMute()
  func toggleShuffle()
}

extension Player: PlaybackControlling {
  public var song: Track? { queue.currentTrack }
  public var masterVolume: Double { queue.volume }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Keyboard/KeyCommandHandler.swift`:

```swift
import PlayarrAPI

/// What each shortcut does, as the web's: ←/→ 10 s within the song, Shift for the previous or next song, ↑/↓ the
/// volume by 5 %, L the song playing in or out of Favorites, / to Search. Without a song only the volume, mute,
/// shuffle and Search do anything.
@MainActor
public struct KeyCommandHandler {
  public static let seekStep: Double = 10
  public static let volumeStep: Double = 0.05

  let controls: any PlaybackControlling
  let toggleFavorite: @MainActor (Track) -> Void
  let openSearch: @MainActor () -> Void

  public init(controls: any PlaybackControlling, toggleFavorite: @escaping @MainActor (Track) -> Void, openSearch: @escaping @MainActor () -> Void) {
    self.controls = controls
    self.toggleFavorite = toggleFavorite
    self.openSearch = openSearch
  }

  public init(session: AccountSession) {
    self.init(controls: session.player, toggleFavorite: { session.toggleFavorite($0) }, openSearch: { session.router.openSearch() })
  }

  public func perform(_ command: KeyCommand) {
    switch command {
    case .volumeUp: setVolume(controls.masterVolume + Self.volumeStep)
    case .volumeDown: setVolume(controls.masterVolume - Self.volumeStep)
    case .mute: controls.toggleMute()
    case .shuffle: controls.toggleShuffle()
    case .search: openSearch()
    case .playPause, .seekBack, .seekForward, .previous, .next, .favorite:
      guard let song = controls.song else { return }
      switch command {
      case .playPause: controls.togglePlay()
      case .seekBack: controls.seek(to: max(0, controls.time - Self.seekStep))
      case .seekForward: controls.seek(to: min(controls.duration, controls.time + Self.seekStep))
      case .previous: controls.previous()
      case .next: controls.next()
      default: toggleFavorite(song)
      }
    }
  }

  /// In steps of 1 %, between silent and full.
  private func setVolume(_ volume: Double) {
    controls.setVolume(min(1, max(0, (volume * 100).rounded() / 100)))
  }
}
```

**Step 4: Run it to see it pass**

Write Task 14's `KeyboardShortcutsSection.swift` first if you didn't comment out its test.

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter KeyCommandTests
```

Expected: 8 tests pass.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Keyboard/KeyCommand.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Keyboard/PlaybackControlling.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Keyboard/KeyCommandHandler.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/KeyCommandTests.swift
git commit -F - <<'MSG'
iOS: the web's keyboard shortcuts and what each one does to the player

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

(If you wrote `KeyboardShortcutsSection.swift` in this task, it goes in Task 14's commit.)

---

### Task 14: Shortcuts in the menu bar and the ⌘ overlay, "/" into Search, and the list in Settings

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Keyboard/PlayarrCommands.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/KeyboardShortcutsSection.swift`
- Modify: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Search/SearchView.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/PlaybackPanel.swift`, `apps/ios/Playarr/PlayarrApp.swift`

Two menus: "Playback" with the ten playback shortcuts, and "Go" with Search. Settings → Playback lists them on an iPad, in the web's words (`PlaybackPanel.tsx` `SHORTCUTS`), with the keys read as "Shift + ← or Shift + →" by VoiceOver. The app gets the commands here; Task 20 adds the Shortcuts actions' dependency and the UI tests' launch arguments to `PlayarrApp.swift`.

**Step 1: Write the views**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Keyboard/PlayarrCommands.swift`:

```swift
import SwiftUI

/// The keyboard shortcuts as menu commands (the app's `WindowGroup` gets `.commands { PlayarrCommands(model:) }`):
/// they show in the iPad's menu bar and in the list that appears while ⌘ is held. Text fields keep the keys they
/// use (typing "s" in Search types an s), because UIKit gives text input priority over key commands.
public struct PlayarrCommands: Commands {
  let model: AppModel

  public init(model: AppModel) {
    self.model = model
  }

  public var body: some Commands {
    CommandMenu("Playback") {
      ForEach(KeyCommand.playback, id: \.self) { command in
        button(command)
      }
    }
    CommandMenu("Go") {
      button(.search)
    }
  }

  private func button(_ command: KeyCommand) -> some View {
    Button(command.title) { perform(command) }
      .keyboardShortcut(command.key, modifiers: command.modifiers)
  }

  private func perform(_ command: KeyCommand) {
    guard let session = model.session else { return }
    KeyCommandHandler(session: session).perform(command)
  }
}
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/KeyboardShortcutsSection.swift`:

```swift
import SwiftUI

/// Settings → Playback → Keyboard shortcuts (apps/web/src/components/PlaybackPanel.tsx `SHORTCUTS`), shown on an
/// iPad, where a keyboard can be attached.
struct KeyboardShortcutsSection: View {
  /// The web's list: keys (combinations, each of keys) and what they do.
  static let rows: [(keys: [[String]], action: String)] = [
    ([["Space"]], "Play or pause"),
    ([["←"], ["→"]], "Back or ahead 10 seconds"),
    ([["Shift", "←"], ["Shift", "→"]], "Previous or next song"),
    ([["↑"], ["↓"]], "Volume up or down"),
    ([["M"]], "Mute or unmute"),
    ([["S"]], "Shuffle on or off"),
    ([["L"]], "Add the song playing to Favorites, or remove it"),
    ([["/"]], "Search"),
  ]

  /// "Shift + ← or Shift + →", as VoiceOver reads the keys.
  static func spoken(_ keys: [[String]]) -> String {
    keys.map { $0.joined(separator: " + ") }.joined(separator: " or ")
  }

  var body: some View {
    Section {
      ForEach(Self.rows, id: \.action) { row in
        LabeledContent {
          Text(Self.spoken(row.keys)).font(.callout.monospaced())
        } label: {
          Text(row.action)
        }
        .accessibilityElement(children: .combine)
      }
    } header: {
      Text("Keyboard shortcuts")
    } footer: {
      Text("They work anywhere in Playarr, except while you’re typing.")
    }
  }
}
```

**Step 2: Search takes the cursor, and Playback lists the keys**

If phase 7 added "On this device" at the end of the Playback form, put the keyboard section after it.

In `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Search/SearchView.swift`, replace:

```swift
  @Environment(AccountSession.self) private var session
```

with:

```swift
  @Environment(AccountSession.self) private var session
  @FocusState private var searchFocused: Bool
```

Then, in the same file, replace:

```swift
    .searchable(text: $model.text, prompt: "Artists, albums, tracks")
```

with:

```swift
    .searchable(text: $model.text, prompt: "Artists, albums, tracks")
    .searchFocused($searchFocused)
    .task(id: session.router.focusSearch) {
      // "/" on a keyboard: the cursor goes to the field.
      if session.router.focusSearch {
        session.router.focusSearch = false
        searchFocused = true
      }
    }
```

In `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/PlaybackPanel.swift`, replace:

```swift
    }
    .navigationTitle("Playback")
```

with:

```swift
      #if os(iOS)
        if UIDevice.current.userInterfaceIdiom == .pad { KeyboardShortcutsSection() }
      #endif
    }
    .navigationTitle("Playback")
```

Then, in the same file, replace:

```swift
import SwiftUI
```

with:

```swift
import SwiftUI
#if canImport(UIKit)
  import UIKit
#endif
```

**Step 3: The app's menu**

In `apps/ios/Playarr/PlayarrApp.swift`, replace:

```swift
        .onOpenURL { model.open($0) }
    }
```

with:

```swift
        .onOpenURL { model.open($0) }
    }
    .commands { PlayarrCommands(model: model) }
```

(Keep whatever phases 7 to 9 added to `PlayarrApp`, such as phase 7's app delegate adaptor.)

**Step 4: Build, test, and press the keys**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter KeyCommandTests
make -C apps/ios build SIMULATOR="Playarr P10 iPad"
```

Expected: 8 tests pass; the build succeeds. On the iPad simulator (Task 11, Step 4), with I/O → Keyboard → Send Keyboard Input to Device on: play Mezzanine, then Space pauses, Shift+→ goes to Risingson, S lights the bar's shuffle, / opens Search with the cursor in the field, and typing "s" there types an s. Hold ⌘: the overlay lists Playback and Go.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Keyboard/PlayarrCommands.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/KeyboardShortcutsSection.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Search/SearchView.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/PlaybackPanel.swift apps/ios/Playarr/PlayarrApp.swift
git commit -F - <<'MSG'
iOS: the keyboard shortcuts in the iPad's menu bar and the ⌘ overlay, "/" into Search, and their list in Settings → Playback

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 15: Song rows: drag, VoiceOver actions, the pointer, large text, contrast, motion

**Files:**
- Modify: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/TrackRow.swift`

The row's button gets the ⋯ menu's items as VoiceOver custom actions (swipe up or down on the row, "Actions available"), plus Add to Favorites or Remove from Favorites; it can be dragged (`TrackDrag`); the pointer highlights it. Its title and subtitle wrap at the accessibility sizes, where the number, the title and the time stack; secondary text is `.muted`; the playing waveform stops with Reduce Motion. If phase 6 or 7 added a heart or an offline mark to the row, keep them where they are.

**Step 1: Edit**

In `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/TrackRow.swift`, replace:

```swift
  @Environment(Theme.self) private var theme
```

with:

```swift
  @Environment(Theme.self) private var theme
  @Environment(\.reducesMotion) private var reducesMotion
```

Then, in the same file, replace:

```swift
        HStack(spacing: 12) {
          leading(current: current, playing: playing)
```

with:

```swift
        AdaptiveStack(spacing: 12) {
          leading(current: current, playing: playing)
```

Then, in the same file, replace:

```swift
      .accessibilityHint(current ? "Plays or pauses the song" : "Plays the song")
```

with:

```swift
      .accessibilityHint(current ? "Plays or pauses the song" : "Plays the song")
      .accessibilityActions {
        TrackMenuItems(track: track, showsAlbum: style == .mixed)
        Button(session.isFavorite(track) ? "Remove from Favorites" : "Add to Favorites") { session.toggleFavorite(track) }
      }
      .draggable(TrackDrag(tracks: [track])) {
        Label(track.title, systemImage: "music.note").padding(10).background(.regularMaterial, in: Capsule())
      }
      .pointerHover()
```

In `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/TrackRow.swift`, replace every `.lineLimit(1)` with `.essentialLineLimit()`.

In `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/TrackRow.swift`, replace every `.foregroundStyle(.secondary)` with `.foregroundStyle(.muted)`.

In `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/TrackRow.swift`, replace every `isActive: playing)` with `isActive: playing && !reducesMotion)`.

**Step 2: Build and test**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI 2>&1 | tail -1
swift build --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --triple arm64-apple-ios26.0-simulator --sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" --scratch-path /tmp/playarr-ui-ios
```

Expected: every suite passes; the simulator build is clean.

**Step 3: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/TrackRow.swift
git commit -F - <<'MSG'
iOS: song rows can be dragged, have VoiceOver actions and the pointer's highlight, and wrap at the largest text sizes

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 16: The queue: its menu on long press, VoiceOver actions, its rule-breaking row, and 5,000 songs

**Files:**
- Modify: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Queue/QueueView.swift`
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Demo/Demo+LongQueue.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/LongQueueTests.swift`

The now-playing row loses its `accessibilityElement(children: .combine)` (it merged the artist · album button into a label VoiceOver couldn't activate); the title says "Now playing: Angel" and the button stays a button. Up next's rows get the ⋯ items on long press and secondary click, and as VoiceOver actions, from one `@ViewBuilder`. `upcoming` is worked out once per redraw. Phase 5's `TransitionLine` under the now-playing row and phase 6's Save as playlist in the toolbar are in `body`, which the edits below only touch at `upcoming`; the replacement of the row functions starts at `private func nowPlaying` and runs to the end of the file.

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/LongQueueTests.swift`:

```swift
import Foundation
import Testing
@testable import PlayarrUI

@MainActor @Suite struct LongQueueTests {
  @Test func listsAQueueOf5000SongsQuickly() {
    let session = demoSession()
    session.player.play(Demo.manyTracks(5000))
    let model = QueueModel(session: session)
    let took = ContinuousClock().measure {
      for _ in 0..<20 {
        _ = model.upcoming
        _ = model.header
      }
    }
    #expect(model.upcoming.count == 4999)
    #expect(model.header == "Up next · 4999 tracks · 333 hr 16 min")
    #expect(took < .seconds(1), "20 redraws' worth took \(took)")
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter LongQueueTests
```

Expected: the build fails with `type 'Demo' has no member 'manyTracks'`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Demo/Demo+LongQueue.swift`:

```swift
import PlayarrAPI

extension Demo {
  /// `count` four-minute songs ("Song 1", "Song 2", …) for the long-queue checks (`-UITestsLongQueue`).
  public static func manyTracks(_ count: Int) -> [Track] {
    (0..<count).map { n in
      track(20_000 + n, "Song \(n + 1)", album: 70, albumTitle: "Mezzanine", artist: artist, number: n + 1, duration: 240)
    }
  }
}
```

In `Pages/Queue/QueueView.swift`:

Replace:

```swift
  @State private var reordered = 0
```

with:

```swift
  @State private var reordered = 0
  @Environment(\.reducesMotion) private var reducesMotion
```

Replace:

```swift
    let model = QueueModel(session: session)
```

with:

```swift
    let model = QueueModel(session: session)
    // Worked out once per change: a queue can hold thousands of songs.
    let upcoming = model.upcoming
```

Replace `if model.upcoming.isEmpty {` with `if upcoming.isEmpty {`.

Replace `ForEach(Array(model.upcoming.enumerated())` with `ForEach(Array(upcoming.enumerated())`.

Replace `if !model.upcoming.isEmpty { Button("Clear")` with `if !upcoming.isEmpty { Button("Clear")`.

Replace `.sensoryFeedback(.impact(weight: .light), trigger: reordered)` with `.sensoryFeedback(Haptic.reorder, trigger: reordered)`.

Replace `Text("The queue ends after this track.").foregroundStyle(.secondary)` with `Text("The queue ends after this track.").foregroundStyle(.muted)`.

Then replace everything from `  private func nowPlaying(_ track: Track) -> some View {` to the end of the file with:

```swift
  private func nowPlaying(_ track: Track) -> some View {
    HStack(spacing: 14) {
      Cover(path: track.coverUrl, points: 72, label: track.albumTitle).frame(width: 72, height: 72)
      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 8) {
          Image(systemName: "waveform")
            .symbolEffect(.variableColor.iterative, isActive: session.player.queue.playing && !reducesMotion)
            .accessibilityHidden(true)
          Text(track.title).font(.headline).essentialLineLimit()
            .accessibilityLabel("Now playing: \(track.title)")
        }
        .foregroundStyle(theme.accent.color)
        Button("\(track.artistName) · \(track.albumTitle)") { session.router.open(.album(track.albumId)) }
          .font(.subheadline).foregroundStyle(.muted).essentialLineLimit().buttonStyle(.plain)
          .accessibilityHint("Opens the album")
        FormatBadge(format: track.format)
      }
    }
  }

  private func upNextRow(_ song: QueueModel.Upcoming, offset: Int, model: QueueModel) -> some View {
    let track = song.track
    return HStack(spacing: 12) {
      Button { model.play(offset) } label: {
        AdaptiveStack(spacing: 12) {
          Cover(path: track.coverUrl, points: 44, label: track.albumTitle).frame(width: 44, height: 44)
          VStack(alignment: .leading, spacing: 2) {
            Text(track.title).essentialLineLimit()
            Text(track.artistName).font(.footnote).foregroundStyle(.muted).essentialLineLimit()
          }
          Spacer(minLength: 8)
          Text(Format.time(track.duration)).font(.footnote.monospacedDigit()).foregroundStyle(.muted)
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .pointerHover()
      .accessibilityLabel("\(track.title), \(track.artistName), \(Format.time(track.duration))")
      .accessibilityHint("Plays from this song")
      .accessibilityActions { upNextItems(song, offset: offset, model: model) }
      Menu {
        upNextItems(song, offset: offset, model: model)
      } label: {
        Image(systemName: "ellipsis").frame(width: 44, height: 44).contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .foregroundStyle(.muted)
      .pointerHover()
      .accessibilityLabel("More for \(track.title)")
    }
    .contextMenu { upNextItems(song, offset: offset, model: model) }
  }

  /// A song in Up next: its ⋯ menu, its long-press (or secondary-click) menu and its VoiceOver actions.
  @ViewBuilder
  private func upNextItems(_ song: QueueModel.Upcoming, offset: Int, model: QueueModel) -> some View {
    let track = song.track
    if offset > 0 { Button("Play next", systemImage: "text.line.first.and.arrowtriangle.forward") { model.playNext(song) } }
    Button("Go to album", systemImage: "square.stack") { session.router.open(.album(track.albumId)) }
    Button("Go to artist", systemImage: "music.mic") { session.router.open(.artist(track.artistId)) }
    Button("Remove from queue", systemImage: "xmark", role: .destructive) { model.remove([offset]) }
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter "LongQueueTests|QueueModelTests"
```

Expected: `LongQueueTests` (1) and phase 4's `QueueModelTests` (5) pass. (On this Mac the 20 redraws took about 50 ms in a debug build.)

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Queue/QueueView.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Demo/Demo+LongQueue.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/LongQueueTests.swift
git commit -F - <<'MSG'
iOS: the queue's menu on long press and as VoiceOver actions, a now-playing row VoiceOver can use, and Up next worked out once

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 17: The rest of the accessibility pass, and the haptics

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/ArtworkText.swift`
- Modify: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/NowPlaying/MiniPlayer.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/ToastsView.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/NowPlaying/Transport.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/SectionHeader.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/Cover.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/AlbumCard.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/ArtistCard.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/MixCard.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/PlaylistCard.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/TrackMenu.swift`

What the audit found in phase 4's views on the simulator while this plan was written, and what fixes it:

- The mini player's play and next buttons are 36 points: 44.
- Each toast was one combined element holding its Undo and Later buttons (against the conventions' rule): the message and the buttons are separate again; the announcement still reads the message.
- Now Playing's shuffle, previous, next and repeat are their icon's size (28 points for previous): at least 44.
- Home's "See all" is a 13-point kicker: at least 44 high.
- Words drawn on covers (a stand-in cover's initials, a mix cover's "MADE FOR YOU" and title) are sized to the picture with `.system(size:)`, so the audit reports them as text that doesn't follow Dynamic Type, and their contrast against the grooves as failing, even though VoiceOver never reads them (`accessibilityHidden` doesn't keep them out of the audit). `ArtworkText` draws them into a `Canvas`, like the rest of the artwork, so they're part of the picture and the card's own label is what's read.
- Card titles and subtitles have one line at every size: they wrap at the accessibility sizes (`essentialLineLimit`).
- Kickers, card subtitles and the ⋯ button use `.muted`. Cards and the ⋯ button get the pointer's highlight.
- Phase 4's `sensoryFeedback` calls use `Haptic`'s names.

If phase 6 added a heart to the mini player, or phases 7 and 8 changed the cards (an offline mark, a request button), keep their additions.

**Step 1: Write `ArtworkText`**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/ArtworkText.swift`:

```swift
import SwiftUI

/// Words that are part of a picture (a mix's cover, a stand-in cover's initials), drawn into it like the rest of
/// the artwork: they scale with the picture, not with the text size, and VoiceOver and the accessibility audit read
/// the card's own label instead. Lines are stacked from the bottom (or centred).
struct ArtworkText: View {
  let lines: [Text]
  var spacing: CGFloat = 2
  var centred = false

  var body: some View {
    Canvas { context, size in
      let resolved = lines.map { context.resolve($0) }
      let sizes = resolved.map { $0.measure(in: size) }
      let total = sizes.reduce(0) { $0 + $1.height } + spacing * CGFloat(max(0, sizes.count - 1))
      var y = centred ? (size.height - total) / 2 : size.height - total
      for (line, measured) in zip(resolved, sizes) {
        let x = centred ? (size.width - measured.width) / 2 : 0
        context.draw(line, in: CGRect(x: x, y: y, width: centred ? measured.width : size.width, height: measured.height))
        y += measured.height + spacing
      }
    }
    .accessibilityHidden(true)
  }
}
```

**Step 2: Edit**

In `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/NowPlaying/MiniPlayer.swift`, replace:

```swift
PlayPauseButton(player: player, size: 36, filled: false)
```

with:

```swift
PlayPauseButton(player: player, size: 44, filled: false)
```

Then, in the same file, replace:

```swift
Image(systemName: "forward.fill").frame(width: 36, height: 36)
```

with:

```swift
Image(systemName: "forward.fill").frame(width: 44, height: 44).contentShape(Rectangle())
```

In `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/ToastsView.swift`, replace:

```swift
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isStaticText)
        .sensoryFeedback(toast.tone == .error ? .error : .success, trigger: toast.id)
```

with:

```swift
        .sensoryFeedback(Haptic.toast(isError: toast.tone == .error), trigger: toast.id)
```

In `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/NowPlaying/Transport.swift`, replace:

```swift
.sensoryFeedback(.selection, trigger: q.shuffle)
```

with:

```swift
.sensoryFeedback(Haptic.toggle, trigger: q.shuffle)
```

Then, in the same file, replace:

```swift
.sensoryFeedback(.selection, trigger: q.repeatMode)
```

with:

```swift
.sensoryFeedback(Haptic.toggle, trigger: q.repeatMode)
```

Then, in the same file, replace:

```swift
.sensoryFeedback(.impact(weight: .medium), trigger: playing)
```

with:

```swift
.sensoryFeedback(Haptic.playPause, trigger: playing)
```

In `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/NowPlaying/Transport.swift`, replace every `.font(.title3) }` with `.font(.title3).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle()) }`.

In `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/NowPlaying/Transport.swift`, replace every `.font(.title) }` with `.font(.title).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle()) }`.

In `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/SectionHeader.swift`, replace:

```swift
NavigationLink(value: seeAll) { Kicker(text: "See all") }
```

with:

```swift
NavigationLink(value: seeAll) { Kicker(text: "See all").frame(minHeight: 44).contentShape(Rectangle()) }
```

Then, in the same file, replace:

```swift
      .tracking(2)
      .foregroundStyle(.secondary)
```

with:

```swift
      .tracking(2)
      .foregroundStyle(.muted)
```

In `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/AlbumCard.swift`, replace:

```swift
    .buttonStyle(.plain)
```

with:

```swift
    .buttonStyle(.plain)
    .pointerHover()
```

In `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/ArtistCard.swift`, replace:

```swift
    .buttonStyle(.plain)
```

with:

```swift
    .buttonStyle(.plain)
    .pointerHover()
```

In `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/MixCard.swift`, replace:

```swift
    .buttonStyle(.plain)
```

with:

```swift
    .buttonStyle(.plain)
    .pointerHover()
```

In `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/PlaylistCard.swift`, replace:

```swift
    .buttonStyle(.plain)
```

with:

```swift
    .buttonStyle(.plain)
    .pointerHover()
```

In `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/TrackMenu.swift`, replace:

```swift
    .buttonStyle(.plain)
    .foregroundStyle(.secondary)
```

with:

```swift
    .buttonStyle(.plain)
    .foregroundStyle(.muted)
    .pointerHover()
```

In `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/Cover.swift`, replace:

```swift
          .overlay {
            Text(initials).font(.system(size: max(8, side * 0.14), weight: .semibold, design: .serif)).foregroundStyle(.black)
          }
```

with:

```swift
          .overlay {
            ArtworkText(lines: [Text(initials).font(.system(size: max(8, side * 0.14), weight: .semibold, design: .serif)).foregroundStyle(.black)], centred: true)
          }
```

In `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/MixCard.swift`, replace:

```swift
      VStack(alignment: .leading, spacing: 2) {
        Text("MADE FOR YOU").font(.system(size: width * 0.046, design: .monospaced)).tracking(2).foregroundStyle(.white.opacity(0.75))
        Text(mix.title).font(.system(size: width * 0.125, weight: .semibold, design: .serif)).foregroundStyle(.white).lineLimit(2)
      }
      .padding(width * 0.07)
```

with:

```swift
      ArtworkText(lines: [
        Text("MADE FOR YOU").font(.system(size: width * 0.046, design: .monospaced)).tracking(2).foregroundStyle(.white.opacity(0.75)),
        Text(mix.title).font(.system(size: width * 0.125, weight: .semibold, design: .serif)).foregroundStyle(.white),
      ])
      .padding(width * 0.07)
```

Then, in the same file, replace:

```swift
Text(mix.subtitle).font(.subheadline).lineLimit(1)
```

with:

```swift
Text(mix.subtitle).font(.subheadline).essentialLineLimit()
```

In `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/AlbumCard.swift`, replace:

```swift
Text(album.title).font(.subheadline).lineLimit(1).foregroundStyle
```

with:

```swift
Text(album.title).font(.subheadline).essentialLineLimit().foregroundStyle
```

Then, in the same file, replace:

```swift
Text(subtitle).font(.caption).lineLimit(1).foregroundStyle(.secondary)
```

with:

```swift
Text(subtitle).font(.caption).essentialLineLimit().foregroundStyle(.muted)
```

**Step 3: Build and test**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI 2>&1 | tail -1
swift build --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --triple arm64-apple-ios26.0-simulator --sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" --scratch-path /tmp/playarr-ui-ios
```

Expected: every suite passes; the simulator build is clean.

**Step 4: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/ArtworkText.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/NowPlaying/MiniPlayer.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Shell/ToastsView.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/NowPlaying/Transport.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/SectionHeader.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/Cover.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/AlbumCard.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/ArtistCard.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/MixCard.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/PlaylistCard.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Components/TrackMenu.swift
git commit -F - <<'MSG'
iOS: 44-point buttons, toasts VoiceOver can act on, words on covers drawn as part of the picture, cards that wrap at large sizes, and the haptics by name

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 18: Error states everywhere, and pull to refresh

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Demo/OfflineAPI.swift`
- Modify: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Home/HomeModel.swift`, `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Home/HomeView.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/HomeModelTests.swift` (add a suite)

Every screen was checked for what it shows while loading, when empty, and when the server can't be reached with nothing kept. One was missing: Home showed "Loading library" for ever. The rest already have theirs:

| Screen | Empty | Can't load (nothing kept) | Pull to refresh |
|---|---|---|---|
| Home | sections hide | **this task**: "Something skipped." + Try again | yes (phase 4) |
| Search | "Try an artist", "Nothing in your library matches…" (phase 4, 8) | the search's error (phase 4) | n/a (typing searches again) |
| Library (phone) | rows always there; playlists section hides | rows still open their pages | yes (phase 4) |
| Artists, Albums, Artist, Album | n/a | `ErrorState` (phase 4) | yes (phase 4) |
| Queue, queue column | "Nothing queued" / "The queue ends after this track." (phase 4) | n/a (on the device) | n/a |
| Lyrics, lyrics column | "No lyrics found", "Instrumental" (phase 4); "Nothing playing" (Task 10) | "Lyrics are unavailable right now" (phase 4) | n/a |
| Sidebar | "No playlists yet." (Task 8) | the foot's dots turn red, links still work | yes (Task 8) |
| Player bar | "Nothing playing" (Task 9) | n/a | n/a |
| Favorites, Playlists, a playlist, Made for you, a mix, Your listening | phase 6's ("Nothing hearted yet." …) | phase 6's | phase 6's |
| Downloads | phase 7's | n/a (on the device) | n/a |
| Requests, Discover pages | phase 8's | phase 8's (Retry) | phase 8's |
| Settings panels (admin) | phase 9's | `admin.error` (phase 9) | phase 9's |

Check the phase 6 rows when it lands: `grep -n "refreshable\|ErrorState\|ContentUnavailableView" apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/*/*.swift`; a page that loads from the server and has neither gets them here, as Home does below.

`OfflineAPI` is what the `-UITestsOffline` launch argument gives the demo (Task 20's edit to `PlayarrApp.swift`), so Task 23's UI test can walk the pages with nothing reachable.

**Step 1: Write the failing test**

Add to the end of `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/HomeModelTests.swift`:

```swift

@MainActor @Suite struct HomeFailureTests {
  @Test func saysSoWhenNothingCanBeLoaded() async {
    let model = HomeModel(session: demoSession(api: FakeAPI()))
    await model.load()
    #expect(model.failure != nil)
  }

  @Test func showsTheLibraryWhenItLoads() async {
    let model = HomeModel(session: demoSession())
    await model.load()
    #expect(model.failure == nil)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter HomeFailureTests
```

Expected: the build fails with `value of type 'HomeModel' has no member 'failure'`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Demo/OfflineAPI.swift`:

```swift
import PlayarrAPI

/// A server that can't be reached: every call fails as the real client does offline. With nothing kept, every
/// page shows its error state (`-UITestsOffline`).
public struct OfflineAPI: APISending {
  public init() {}

  public func send<T: Decodable & Sendable>(_ endpoint: Endpoint<T>) async throws -> T {
    throw APIError.offline
  }
}
```

In `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Home/HomeModel.swift`, replace:

```swift
  /// Pull to refresh.
```

with:

```swift
  /// Nothing to show and the server can't be reached (nothing kept either): Home says so, with Try again.
  var failure: String? {
    guard health.value == nil, recent.value == nil, artists.value == nil else { return nil }
    return health.error ?? recent.error ?? artists.error
  }

  /// Pull to refresh.
```

In `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Home/HomeView.swift`, replace:

```swift
    .refreshable { await model.refresh() }
```

with:

```swift
    .refreshable { await model.refresh() }
    .overlay {
      if let failure = model.failure {
        ErrorState(message: failure) { await model.refresh() }.background(.background)
      }
    }
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter "HomeFailureTests|HomeModelTests"
```

Expected: `HomeFailureTests` (2) and phase 4's `HomeModelTests` pass.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Demo/OfflineAPI.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Home/HomeModel.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Pages/Home/HomeView.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/HomeModelTests.swift
git commit -F - <<'MSG'
iOS: Home says when the server can't be reached instead of loading for ever, and a demo server that can't be reached for the UI tests

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 19: The launch screen, a dark app from the first frame, and the dark and tinted icons

**Files:**
- Create: `apps/ios/scripts/make-icons.swift`, `apps/ios/Playarr/Assets.xcassets/AppIcon.appiconset/AppIcon-Dark.png`, `apps/ios/Playarr/Assets.xcassets/AppIcon.appiconset/AppIcon-Tinted.png`, `apps/ios/Playarr/Assets.xcassets/LaunchBackground.colorset/Contents.json`
- Modify: `apps/ios/Playarr/Assets.xcassets/AppIcon.appiconset/Contents.json`, `apps/ios/Config/Info.plist`

**Step 1: The icon script**

`apps/ios/scripts/make-icons.swift`:

```swift
// Draws the app icon's dark and tinted variants (iOS 18 and later let people pick them on the Home Screen) from the
// same shapes as AppIcon.png: three thin rings and the orange label with its hole, on a 1024-point square.
//   swift scripts/make-icons.swift Playarr/Assets.xcassets/AppIcon.appiconset
// Writes AppIcon-Dark.png (no background: the system puts its own dark one behind it) and AppIcon-Tinted.png
// (grey levels on black: the system colours it with the tint people choose).
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let size = 1024
let centre = CGPoint(x: 512, y: 512)
// From AppIcon.png: rings at radii 336, 272 and 208, 4 points wide; the label 128 across its radius, its hole 20.
let rings: [(radius: CGFloat, gray: CGFloat)] = [(336, 0.18), (272, 0.145), (208, 0.13)]

struct Variant {
  let file: String
  let background: CGColor?
  let ringBoost: CGFloat
  let label: CGColor
  let hole: CGColor?
}

let orange = CGColor(srgbRed: 1, green: 122 / 255, blue: 26 / 255, alpha: 1)
let variants = [
  Variant(file: "AppIcon-Dark.png", background: nil, ringBoost: 1.6, label: orange, hole: nil),
  Variant(file: "AppIcon-Tinted.png", background: CGColor(gray: 0, alpha: 1), ringBoost: 2.2, label: CGColor(gray: 1, alpha: 1), hole: CGColor(gray: 0, alpha: 1)),
]

guard CommandLine.arguments.count == 2 else {
  FileHandle.standardError.write(Data("usage: swift make-icons.swift <AppIcon.appiconset folder>\n".utf8))
  exit(1)
}
let folder = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)

for variant in variants {
  let space = CGColorSpace(name: CGColorSpace.sRGB)!
  let alpha = variant.background == nil ? CGImageAlphaInfo.premultipliedLast : CGImageAlphaInfo.noneSkipLast
  guard let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: alpha.rawValue) else { exit(1) }
  if let background = variant.background {
    context.setFillColor(background)
    context.fill(CGRect(x: 0, y: 0, width: size, height: size))
  }
  context.setLineWidth(4)
  for ring in rings {
    context.setStrokeColor(CGColor(gray: min(1, ring.gray * variant.ringBoost), alpha: 1))
    context.strokeEllipse(in: CGRect(x: centre.x - ring.radius, y: centre.y - ring.radius, width: ring.radius * 2, height: ring.radius * 2))
  }
  context.setFillColor(variant.label)
  context.fillEllipse(in: CGRect(x: centre.x - 128, y: centre.y - 128, width: 256, height: 256))
  let hole = CGRect(x: centre.x - 20, y: centre.y - 20, width: 40, height: 40)
  if let colour = variant.hole {
    context.setFillColor(colour)
    context.fillEllipse(in: hole)
  } else {
    context.setBlendMode(.clear)
    context.fillEllipse(in: hole)
    context.setBlendMode(.normal)
  }
  guard let image = context.makeImage(),
    let destination = CGImageDestinationCreateWithURL(folder.appending(path: variant.file) as CFURL, UTType.png.identifier as CFString, 1, nil)
  else { exit(1) }
  CGImageDestinationAddImage(destination, image, nil)
  guard CGImageDestinationFinalize(destination) else { exit(1) }
  print("wrote \(variant.file)")
}
```

```bash
swift apps/ios/scripts/make-icons.swift apps/ios/Playarr/Assets.xcassets/AppIcon.appiconset
sips -g pixelWidth -g pixelHeight -g hasAlpha apps/ios/Playarr/Assets.xcassets/AppIcon.appiconset/AppIcon-*.png
```

Expected: `wrote AppIcon-Dark.png`, `wrote AppIcon-Tinted.png`; both 1024 × 1024; the dark one `hasAlpha: yes` (the system draws its own dark background behind it), the tinted one `hasAlpha: no`. Open them (`open apps/ios/Playarr/Assets.xcassets/AppIcon.appiconset/AppIcon-*.png`): the same rings and label as `AppIcon.png`, the tinted one in greys on black.

**Step 2: The asset catalog**

`apps/ios/Playarr/Assets.xcassets/AppIcon.appiconset/Contents.json` (replace):

```json
{
  "images" : [
    {
      "filename" : "AppIcon.png",
      "idiom" : "universal",
      "platform" : "ios",
      "size" : "1024x1024"
    },
    {
      "appearances" : [
        {
          "appearance" : "luminosity",
          "value" : "dark"
        }
      ],
      "filename" : "AppIcon-Dark.png",
      "idiom" : "universal",
      "platform" : "ios",
      "size" : "1024x1024"
    },
    {
      "appearances" : [
        {
          "appearance" : "luminosity",
          "value" : "tinted"
        }
      ],
      "filename" : "AppIcon-Tinted.png",
      "idiom" : "universal",
      "platform" : "ios",
      "size" : "1024x1024"
    }
  ],
  "info" : {
    "author" : "xcode",
    "version" : 1
  }
}
```

`apps/ios/Playarr/Assets.xcassets/LaunchBackground.colorset/Contents.json` (the icon's background, #0F0E0C):

```json
{
  "colors" : [
    {
      "color" : {
        "color-space" : "srgb",
        "components" : {
          "alpha" : "1.000",
          "blue" : "0x0C",
          "green" : "0x0E",
          "red" : "0x0F"
        }
      },
      "idiom" : "universal"
    }
  ],
  "info" : {
    "author" : "xcode",
    "version" : 1
  }
}
```

**Step 3: Info.plist**

```bash
plutil -replace UILaunchScreen -json '{"UIColorName":"LaunchBackground"}' apps/ios/Config/Info.plist
plutil -replace UIUserInterfaceStyle -string Dark apps/ios/Config/Info.plist
plutil -lint apps/ios/Config/Info.plist
git diff --stat apps/ios/Config/Info.plist
```

Expected: `OK`, and only those keys changed (plutil keeps the file's XML and tabs).

**Step 4: Check the catalog compiles and the app builds**

```bash
xcrun actool apps/ios/Playarr/Assets.xcassets --compile /tmp/playarr-actool --platform iphonesimulator --minimum-deployment-target 26.0 --app-icon AppIcon --output-partial-info-plist /tmp/playarr-actool/partial.plist --target-device iphone --target-device ipad 2>&1 | grep -iE "warning|error" || echo "no warnings"
make -C apps/ios build SIMULATOR="Playarr P10 iPhone"
```

(Make `/tmp/playarr-actool` first: `mkdir -p /tmp/playarr-actool`.) Expected: `no warnings`; `** BUILD SUCCEEDED **`. On the simulator, the launch is dark; long-press the Home Screen → Edit → Customize → Dark and Tinted show the new icons.

**Step 5: Commit**

```bash
git add apps/ios/scripts/make-icons.swift apps/ios/Playarr/Assets.xcassets/AppIcon.appiconset apps/ios/Playarr/Assets.xcassets/LaunchBackground.colorset apps/ios/Config/Info.plist
git commit -F - <<'MSG'
iOS: a dark launch screen and app from the first frame, and dark and tinted icons drawn from the same shapes

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 20: Siri and Shortcuts: Play my Favorites, Shuffle everything, Start radio

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Actions/QuickPlay.swift`, `apps/ios/Playarr/Intents/PlaybackIntents.swift`, `apps/ios/Playarr/Intents/PlayarrShortcuts.swift`
- Modify: `apps/ios/Playarr/PlayarrApp.swift`
- Test: `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/QuickPlayTests.swift`

`QuickPlay` does what the buttons do (the Favorites page's Play: in order, from "Favorites"; Home's Shuffle everything: 300 random songs shuffled, from "Your whole library"; Start radio on the song playing) and says why it can't in words Siri reads out. The intents are `AudioPlaybackIntent`s in the app target (Xcode extracts App Intents metadata from the app target; a Swift package would need its own `AppIntentsPackage`). XcodeGen picks up `Playarr/Intents/` with the rest of the `Playarr` sources.

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/QuickPlayTests.swift`:

```swift
import Foundation
import PlayarrAPI
import PlayarrPlayer
import Testing
@testable import PlayarrUI

@MainActor @Suite struct QuickPlayTests {
  @Test func playsTheFavoritesInOrder() async throws {
    let api = FakeAPI()
    let favorites = Demo.mezzanineTracks.map {
      FavoriteTrack(
        id: $0.id, recordingId: $0.recordingId, fileId: $0.fileId, albumId: $0.albumId, artistId: $0.artistId, title: $0.title,
        artistName: $0.artistName, albumTitle: $0.albumTitle, trackNumber: $0.trackNumber, discNumber: $0.discNumber,
        duration: $0.duration, explicit: false, format: $0.format, size: $0.size, streamUrl: $0.streamUrl, coverUrl: $0.coverUrl,
        favoritedAt: "2026-11-01T12:00:00.000Z")
    }
    api.on(.get, "/api/favorites", favorites)
    let session = demoSession(api: api)
    try await QuickPlay(session: session).playFavorites()
    #expect(session.player.queue.queue.map(\.title) == ["Angel", "Risingson", "Inertia Creeps"])
    #expect(session.player.queue.source == PlaySource(label: "Favorites", href: "/favorites"))
  }

  @Test func saysWhyItCant() async {
    let api = FakeAPI()
    api.on(.get, "/api/favorites", [FavoriteTrack]())
    await #expect(throws: QuickPlay.Failure.noFavorites) { try await QuickPlay(session: demoSession(api: api)).playFavorites() }
    await #expect(throws: QuickPlay.Failure.signedOut) { try await QuickPlay(session: nil).shuffleEverything() }
    await #expect(throws: QuickPlay.Failure.nothingPlaying) { try await QuickPlay(session: demoSession(api: api)).startRadio() }
    api.fail(.get, "/api/tracks/random", status: 500, "Lidarr is down")
    await #expect(throws: QuickPlay.Failure.server("Lidarr is down")) { try await QuickPlay(session: demoSession(api: api)).shuffleEverything() }
  }

  @Test func shufflesEverythingAndStartsARadio() async throws {
    let api = FakeAPI()
    api.on(.get, "/api/tracks/random", Demo.dummyTracks)
    api.on(.post, "/api/radio", Demo.protectionTracks)
    let session = demoSession(api: api)
    try await QuickPlay(session: session).shuffleEverything()
    #expect(session.player.queue.source == PlaySource(label: "Your whole library", href: "/albums"))
    let playing = try #require(session.player.queue.currentTrack)
    try await QuickPlay(session: session).startRadio()
    #expect(session.player.queue.source?.label == "\(playing.title) radio")
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter QuickPlayTests
```

Expected: the build fails with `cannot find 'QuickPlay' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Actions/QuickPlay.swift`:

```swift
import Foundation
import PlayarrAPI
import PlayarrPlayer

/// What the Shortcuts actions and Siri do ("Play my Favorites", "Shuffle everything", "Start radio from the current
/// song"): the same as the buttons in the app, on the signed-in account. The App Intents in the app target call
/// these and say the error's text when one fails.
@MainActor
public struct QuickPlay {
  public enum Failure: Error, Equatable, LocalizedError {
    case signedOut
    case noFavorites
    case nothingPlaying
    case server(String)

    public var errorDescription: String? {
      switch self {
      case .signedOut: "Open Playarr and sign in first."
      case .noFavorites: "Nothing hearted yet."
      case .nothingPlaying: "Nothing playing."
      case .server(let message): message
      }
    }
  }

  let session: AccountSession?

  public init(session: AccountSession?) {
    self.session = session
  }

  /// Favorites, in order, as the Favorites page's Play.
  public func playFavorites() async throws(Failure) {
    let session = try signedIn()
    let favorites = try await ask(session) { try await $0.send(API.Favorites.list()) }
    guard !favorites.isEmpty else { throw .noFavorites }
    session.player.play(favorites.map(\.track), source: PlaySource(label: "Favorites", href: "/favorites"))
  }

  /// 300 songs from the whole library, shuffled, as Home's Shuffle everything.
  public func shuffleEverything() async throws(Failure) {
    let session = try signedIn()
    let tracks = try await ask(session) { try await $0.send(API.Library.randomTracks(limit: 300)) }
    session.player.play(tracks, source: PlaySource(label: "Your whole library", href: "/albums"), shuffle: true)
  }

  /// The song playing, then songs like it ("<title> radio").
  public func startRadio() async throws(Failure) {
    let session = try signedIn()
    guard let track = session.player.queue.currentTrack else { throw .nothingPlaying }
    await session.actions.startRadio(track)
  }

  private func signedIn() throws(Failure) -> AccountSession {
    guard let session else { throw .signedOut }
    return session
  }

  private func ask<T: Sendable>(_ session: AccountSession, _ call: @Sendable (any APISending) async throws -> T) async throws(Failure) -> T {
    do {
      return try await call(session.api)
    } catch {
      throw .server(error.localizedDescription)
    }
  }
}
```

`apps/ios/Playarr/Intents/PlaybackIntents.swift`:

```swift
import AppIntents
import PlayarrUI

/// "Play my Favorites": the Favorites page's Play, from Siri, Shortcuts, Spotlight or the Action button. An audio
/// playback intent, so it plays without bringing the app to the front.
struct PlayFavoritesIntent: AudioPlaybackIntent {
  static let title: LocalizedStringResource = "Play my Favorites"
  static let description = IntentDescription("Plays your Favorites in order.")

  @Dependency private var model: AppModel

  @MainActor
  func perform() async throws -> some IntentResult {
    model.syncSession()
    try await QuickPlay(session: model.session).playFavorites()
    return .result()
  }
}

/// "Shuffle everything": Home's button, 300 songs from the whole library, shuffled.
struct ShuffleEverythingIntent: AudioPlaybackIntent {
  static let title: LocalizedStringResource = "Shuffle everything"
  static let description = IntentDescription("Plays 300 songs from your whole library, shuffled.")

  @Dependency private var model: AppModel

  @MainActor
  func perform() async throws -> some IntentResult {
    model.syncSession()
    try await QuickPlay(session: model.session).shuffleEverything()
    return .result()
  }
}

/// "Start radio from the current song": the song playing, then songs like it.
struct StartRadioIntent: AudioPlaybackIntent {
  static let title: LocalizedStringResource = "Start radio from the current song"
  static let description = IntentDescription("Plays songs like the one playing.")

  @Dependency private var model: AppModel

  @MainActor
  func perform() async throws -> some IntentResult {
    model.syncSession()
    try await QuickPlay(session: model.session).startRadio()
    return .result()
  }
}
```

`apps/ios/Playarr/Intents/PlayarrShortcuts.swift`:

```swift
import AppIntents

/// The phrases Siri knows without setting anything up, and the actions the Shortcuts app shows for Playarr.
struct PlayarrShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: PlayFavoritesIntent(),
      phrases: ["Play my favorites in \(.applicationName)", "Play my \(.applicationName) favorites"],
      shortTitle: "Play my Favorites", systemImageName: "heart")
    AppShortcut(
      intent: ShuffleEverythingIntent(),
      phrases: ["Shuffle everything in \(.applicationName)", "Shuffle my \(.applicationName) library"],
      shortTitle: "Shuffle everything", systemImageName: "shuffle")
    AppShortcut(
      intent: StartRadioIntent(),
      phrases: ["Start radio from this song in \(.applicationName)", "Start a \(.applicationName) radio"],
      shortTitle: "Start radio", systemImageName: "dot.radiowaves.left.and.right")
  }
}
```

In `apps/ios/Playarr/PlayarrApp.swift` (with Task 14's `.commands` line already there), register the model for the intents, and add Task 18's and Task 21's launch arguments:

In `apps/ios/Playarr/PlayarrApp.swift`, replace:

```swift
  @State private var model = PlayarrApp.makeModel()
```

with:

```swift
  @State private var model: AppModel

  init() {
    let model = PlayarrApp.makeModel()
    _model = State(initialValue: model)
    // The Shortcuts actions and Siri find the app's model through this (`@Dependency`), even when they start it.
    AppDependencyManager.shared.add(dependency: model)
  }
```

Then, in the same file, replace:

```swift
    if arguments.contains("-UITestsDemo") { return .demo() }
```

with:

```swift
    if arguments.contains("-UITestsDemo") {
      // -UITestsOffline: a server that can't be reached. -UITestsLongQueue: 5,000 songs queued, paused.
      let model = AppModel.demo(api: arguments.contains("-UITestsOffline") ? OfflineAPI() : DemoAPI())
      model.restoresPlace = arguments.contains("-UITestsRestore")
      if arguments.contains("-UITestsLongQueue"), let player = model.session?.player {
        player.play(Demo.manyTracks(5000))
        player.setPlaying(false)
      }
      return model
    }
```

Then, in the same file, replace:

```swift
import Foundation
```

with:

```swift
import AppIntents
import Foundation
```

**Step 4: Run it to see it pass, and build the app**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter QuickPlayTests
make -C apps/ios build SIMULATOR="Playarr P10 iPhone"
```

Expected: 3 tests pass; `** BUILD SUCCEEDED **` (the log shows `ExtractAppIntentsMetadata` for Playarr). On the simulator, the Shortcuts app → Playarr lists the three actions; run "Shuffle everything" while signed in to the demo (launch with `-UITests -UITestsDemo` first, as in Task 11) and the mini player shows a song.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Actions/QuickPlay.swift apps/ios/Playarr/Intents apps/ios/Playarr/PlayarrApp.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/QuickPlayTests.swift
git commit -F - <<'MSG'
iOS: Siri and Shortcuts can play your Favorites, shuffle everything and start a radio from the song playing

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 21: UI test support, and the phone's tests on an iPad

**Files:**
- Create: `apps/ios/PlayarrUITests/UITestSupport.swift`
- Modify: `apps/ios/PlayarrUITests/BrowseTests.swift`, `apps/ios/PlayarrUITests/PlaylistsTests.swift` (phase 6), and every other UI test class written before this phase that goes through the tab bar

A full-screen iPad shows the sidebar, so the phone's flows (which tap `app.tabBars.buttons[…]`) skip themselves there; `IPadLayoutTests` covers the iPad. XCTest calls `setUpWithError` and the tests on the main thread, which `MainActor.assumeIsolated` states for Swift 6 (an `async` `setUp` sending `self` to the main actor doesn't compile in the UI test target's strict mode).

**Step 1: Write the support file**

`apps/ios/PlayarrUITests/UITestSupport.swift`:

```swift
import XCTest

extension XCUIApplication {
  /// The app signed in to the demo library, playing silence (phase 4's `-UITestsDemo`), plus `extra` arguments.
  static func demo(_ extra: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-UITests", "-UITestsDemo"] + extra
    return app
  }

  /// Anything with this accessibility identifier (sidebar rows are cells, buttons or other elements, depending on
  /// the iOS version).
  func element(_ identifier: String) -> XCUIElement {
    descendants(matching: .any).matching(identifier: identifier).firstMatch
  }

  /// A button whose label starts with `prefix`: Library's rows read "Albums, 3".
  func button(startingWith prefix: String) -> XCUIElement {
    buttons.matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
  }
}

extension XCTestCase {
  /// XCTest calls `setUp` and the tests on the main thread.
  var isPad: Bool { MainActor.assumeIsolated { UIDevice.current.userInterfaceIdiom == .pad } }

  /// The phone's flows go through the tab bar; a full-screen iPad shows the sidebar instead (IPadLayoutTests).
  /// Call it first in a phone test class's `setUpWithError()`.
  func skipOnIPad() throws {
    try XCTSkipIf(isPad, "Phone layout; IPadLayoutTests covers the iPad")
  }
}
```

**Step 2: The phone's tests skip on an iPad**

In `apps/ios/PlayarrUITests/BrowseTests.swift`, replace:

```swift
    XCTAssertTrue(app.buttons["Mezzanine"].exists)  // Playing from
```

with:

```swift
    XCTAssertTrue(app.buttons["Playing from Mezzanine"].exists)
```

Then, in the same file, replace:

```swift
  override func setUp() {
    continueAfterFailure = false
  }
```

with:

```swift
  override func setUpWithError() throws {
    try skipOnIPad()
    continueAfterFailure = false
  }
```

In `apps/ios/PlayarrUITests/PlaylistsTests.swift`, replace:

```swift
  override func setUp() {
    continueAfterFailure = false
  }
```

with:

```swift
  override func setUpWithError() throws {
    try skipOnIPad()
    continueAfterFailure = false
  }
```

Then find the other classes that use the tab bar (phases 7 to 9 may have added some) and give each the same first line in its set-up (`try skipOnIPad()`, in `override func setUpWithError() throws`):

```bash
grep -ln "tabBars" apps/ios/PlayarrUITests/*.swift
```

(Phase 7's Downloads test opens its page by launch argument, phase 9's account test goes Library → Settings, phase 8's request test goes through Search: whichever use `tabBars` get the line.)

**Step 3: Run the phone's tests on both simulators**

```bash
make -C apps/ios test-app SIMULATOR="Playarr P10 iPhone"
make -C apps/ios test-app SIMULATOR="Playarr P10 iPad"
```

Expected: on the iPhone, everything passes (this phase's own UI tests come in Tasks 22 to 24); on the iPad, the phone's classes report "skipped".

**Step 4: Commit**

```bash
git add apps/ios/PlayarrUITests
git commit -F - <<'MSG'
iOS UI tests: shared helpers, and the phone's flows skip on a full-screen iPad

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 22: UI tests on the iPad: the sidebar, the player bar, the column, Up next, the keyboard, dragging, coming back

**Files:**
- Test: `apps/ios/PlayarrUITests/IPadLayoutTests.swift`

**Step 1: Write the tests**

`apps/ios/PlayarrUITests/IPadLayoutTests.swift`:

```swift
import XCTest

/// The iPad layout on a full-screen iPad, against the demo library: the sidebar, pages in the detail column, the
/// player bar, the queue and lyrics column, Now Playing with Up next, the keyboard, dragging songs and coming back
/// where it was.
final class IPadLayoutTests: XCTestCase {
  override func setUpWithError() throws {
    try XCTSkipUnless(isPad, "iPad only")
    continueAfterFailure = false
    MainActor.assumeIsolated { XCUIDevice.shared.orientation = .landscapeLeft }
  }

  @MainActor
  private func playMezzanine(_ app: XCUIApplication) {
    app.element("sidebar.albums").tap()
    app.buttons["Mezzanine, Massive Attack · 1998 · 3 of 5"].firstMatch.tap()
    XCTAssertTrue(app.buttons["Play Mezzanine"].waitForExistence(timeout: 5))
    app.buttons["Play Mezzanine"].tap()
    XCTAssertTrue(app.buttons["Pause Mezzanine"].waitForExistence(timeout: 5))
  }

  @MainActor
  func testSidebarPlayerBarAndTheQueueAndLyricsColumn() {
    let app = XCUIApplication.demo()
    app.launch()
    XCTAssertTrue(app.element("sidebar.home").waitForExistence(timeout: 10))
    XCTAssertFalse(app.tabBars.firstMatch.exists)
    for item in ["home", "search", "mixes", "artists", "albums", "favorites", "downloads", "queue", "settings", "newPlaylist", "footer"] {
      XCTAssertTrue(app.element("sidebar.\(item)").exists, "sidebar.\(item)")
    }
    XCTAssertTrue(app.element("sidebar.playlist.1").exists)  // the demo's "Late night"
    XCTAssertTrue(app.staticTexts["TRACKS"].exists)
    XCTAssertTrue(app.element("playerBar").exists)
    XCTAssertTrue(app.staticTexts["NOTHING PLAYING"].exists)

    playMezzanine(app)
    let open = app.buttons["Open now playing"]
    XCTAssertEqual(open.value as? String, "Angel, Massive Attack")

    app.element("playerBar.queue").tap()
    XCTAssertTrue(app.element("sideColumn").waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["Risingson, Massive Attack, 4:58"].waitForExistence(timeout: 5))
    app.element("playerBar.lyrics").tap()
    XCTAssertTrue(app.buttons["You are my angel"].waitForExistence(timeout: 5))
    app.element("playerBar.lyrics").tap()
    XCTAssertTrue(app.element("sideColumn").waitForNonExistence(timeout: 5))

    // The song's title goes to its album.
    app.element("sidebar.home").tap()
    app.buttons["Angel, Massive Attack"].tap()
    XCTAssertTrue(app.staticTexts["LINER NOTES"].waitForExistence(timeout: 5))
  }

  @MainActor
  func testNowPlayingShowsUpNext() {
    let app = XCUIApplication.demo()
    app.launch()
    playMezzanine(app)
    app.buttons["Open now playing"].tap()
    XCTAssertTrue(app.element("nowPlaying.upNext").waitForExistence(timeout: 5))
    app.buttons["Inertia Creeps, Massive Attack, 5:56"].tap()
    XCTAssertTrue(app.staticTexts["Inertia Creeps"].waitForExistence(timeout: 5))
    app.buttons["Close now playing"].tap()
    XCTAssertTrue(app.buttons["Close now playing"].waitForNonExistence(timeout: 5))
  }

  @MainActor
  func testTheWebsKeyboardShortcuts() {
    let app = XCUIApplication.demo()
    app.launch()
    playMezzanine(app)
    let bar = app.element("playerBar")

    app.typeKey(" ", modifierFlags: [])
    XCTAssertTrue(bar.buttons["Play"].waitForExistence(timeout: 5))
    // Paused, so only the key moves the time: 10 s ahead.
    let seek = bar.sliders["Seek"]
    let before = seek.value as? String
    app.typeKey(XCUIKeyboardKey.rightArrow.rawValue, modifierFlags: [])
    XCTAssertNotEqual(seek.value as? String, before)
    app.typeKey("s", modifierFlags: [])
    XCTAssertTrue(bar.buttons["Shuffle"].isSelected)
    app.typeKey("m", modifierFlags: [])
    XCTAssertTrue(bar.buttons["Unmute"].waitForExistence(timeout: 5))
    app.typeKey("m", modifierFlags: [])
    XCTAssertTrue(bar.buttons["Mute"].waitForExistence(timeout: 5))
    // ↓ is the app's own volume, 5 % down (changing the volume unmutes, as on the web).
    app.typeKey(XCUIKeyboardKey.downArrow.rawValue, modifierFlags: [])
    XCTAssertEqual(app.element("playerBar.volume").value as? String, "95%")

    // "/" goes to Search with the cursor in the field; letters typed there are text, not shortcuts.
    app.typeKey("/", modifierFlags: [])
    let field = app.searchFields.firstMatch
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    app.typeKey("s", modifierFlags: [])
    XCTAssertEqual((field.value as? String)?.lowercased(), "s")  // the field capitalizes the first letter
    XCTAssertTrue(bar.buttons["Shuffle"].isSelected)
  }

  @MainActor
  func testDraggingASongOntoTheQueue() {
    let app = XCUIApplication.demo()
    app.launch()
    playMezzanine(app)
    // A List doesn't report a tap on the row already selected: go through another item to Albums' first page.
    app.element("sidebar.home").tap()
    app.element("sidebar.albums").tap()
    app.buttons["Dummy, Portishead · 1994"].firstMatch.tap()
    let song = app.buttons["2. Sour Times, 4:14"]
    XCTAssertTrue(song.waitForExistence(timeout: 5))
    song.press(forDuration: 0.6, thenDragTo: app.element("sidebar.queue"), withVelocity: .slow, thenHoldForDuration: 0.5)
    XCTAssertTrue(app.staticTexts["Added 1 track to queue"].waitForExistence(timeout: 5))
  }

  @MainActor
  func testComesBackWhereItWas() {
    let app = XCUIApplication.demo(["-UITestsRestore"])
    app.launch()
    app.element("sidebar.artists").tap()
    app.buttons["Portishead, 1 album · 3 tracks"].firstMatch.tap()
    XCTAssertTrue(app.staticTexts["Portishead"].waitForExistence(timeout: 5))
    // iOS keeps a scene's state when it goes to the background, and gives it back when it closed the app there.
    XCUIDevice.shared.press(.home)
    sleep(2)
    app.terminate()
    app.launch()
    XCTAssertTrue(app.staticTexts["Portishead"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.element("sidebar.artists").isSelected)
  }
}
```

**Step 2: Run them on the iPad**

```bash
make -C apps/ios test-app SIMULATOR="Playarr P10 iPad"
```

Expected: the five `IPadLayoutTests` pass (they skip on the iPhone). What to do when one doesn't:

- `typeKey` needs the simulator to take hardware keyboard events; if the keyboard test fails at its first key, check Simulator → I/O → Keyboard → "Connect Hardware Keyboard" is on for that simulator (`defaults read com.apple.iphonesimulator ConnectHardwareKeyboard` should not be 0).
- If typing "s" into Search toggles shuffle (text input not winning over a key command without modifiers), the menu commands need a guard: give `PlayarrCommands` the key window's first responder check, or move the letter shortcuts (M, S, L, /) to a shell-level `onKeyPress` that returns `.ignored` while `@FocusState` says Search's field is focused. Keep Space and the arrows as commands.
- The drag starts with a 0.6 s press (shorter is a tap, much longer opens the row's context menu first). If the context menu wins on this iOS version, raise `thenHoldForDuration` rather than the press.
- `testComesBackWhereItWas` relies on iOS keeping a scene's state when the app is in the background and XCTest then terminates it. If the scene comes back on Home, check `AppModel.restoresPlace` is true for `-UITestsRestore`.

**Step 3: Commit**

```bash
git add apps/ios/PlayarrUITests/IPadLayoutTests.swift
git commit -F - <<'MSG'
iOS UI tests on the iPad: sidebar, player bar, queue and lyrics column, Up next, the keyboard's shortcuts, dragging a song and coming back where it was

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 23: Accessibility audits on every main screen, and the error states

**Files:**
- Test: `apps/ios/PlayarrUITests/AccessibilityAuditTests.swift`, `apps/ios/PlayarrUITests/ErrorStateTests.swift`

`performAccessibilityAudit(for:)` checks contrast, element detection, hit regions, descriptions, Dynamic Type, clipped text, traits, actions and parent-child relations on what's on screen. The handler prints each issue it doesn't ignore (`AUDIT [screen] what {detail} | type label id frame`), so a failing run says which element to fix; `AuditExceptions` holds the few that aren't the app's (each with its reason). The AX5 run passes `-UIPreferredContentSizeCategoryName UICTContentSizeCategoryAccessibilityXXXL` and checks only Dynamic Type and clipped text.

**Step 1: Write the tests**

`apps/ios/PlayarrUITests/AccessibilityAuditTests.swift`:

```swift
import XCTest

/// Xcode's accessibility audit (labels, contrast, hit regions, Dynamic Type, clipped text, traits) on each main
/// screen of the demo library, on the iPhone and on the iPad, and at the largest text size.
final class AccessibilityAuditTests: XCTestCase {
  override func setUpWithError() throws {
    // Every screen's issues are worth seeing in one run.
    continueAfterFailure = true
  }

  @MainActor
  private func audit(_ app: XCUIApplication, _ screen: String, _ types: XCUIAccessibilityAuditType = .all) throws {
    try XCTContext.runActivity(named: "Audit: \(screen)") { _ in
      try app.performAccessibilityAudit(for: types) { issue in
        let ignored = AuditExceptions.ignores(issue, in: app)
        if !ignored {
          let e = issue.element
          print("AUDIT [\(screen)] \(issue.compactDescription) {\(issue.detailedDescription)} | type=\(e.map { String($0.elementType.rawValue) } ?? "-") label=\(e?.label ?? "-") id=\(e?.identifier ?? "-") frame=\(e?.frame ?? .zero)")
        }
        return ignored
      }
    }
  }

  @MainActor
  private func playMezzanine(_ app: XCUIApplication) {
    app.buttons["Play Mezzanine"].tap()
    XCTAssertTrue(app.buttons["Pause Mezzanine"].waitForExistence(timeout: 5))
  }

  @MainActor
  func testPhoneScreens() throws {
    try skipOnIPad()
    let app = XCUIApplication.demo()
    app.launch()
    XCTAssertTrue(app.staticTexts["8 tracks across 3 albums, 45 min of music waiting in your library."].waitForExistence(timeout: 10))
    try audit(app, "Home")

    app.tabBars.buttons["Library"].tap()
    try audit(app, "Library")
    app.button(startingWith: "Albums").tap()
    try audit(app, "Albums")
    app.buttons["Mezzanine, Massive Attack · 1998 · 3 of 5"].firstMatch.tap()
    XCTAssertTrue(app.staticTexts["LINER NOTES"].waitForExistence(timeout: 5))
    try audit(app, "Album")
    playMezzanine(app)

    app.tabBars.buttons["Library"].tap()
    app.button(startingWith: "Artists").tap()
    app.buttons["Massive Attack, 2 albums · 5 tracks"].firstMatch.tap()
    try audit(app, "Artist")

    app.tabBars.buttons["Queue"].tap()
    XCTAssertTrue(app.buttons["Risingson, Massive Attack, 4:58"].waitForExistence(timeout: 5))
    try audit(app, "Queue")

    app.buttons["Open now playing"].tap()
    XCTAssertTrue(app.buttons["Close now playing"].waitForExistence(timeout: 5))
    try audit(app, "Now Playing")
    app.buttons["Lyrics"].tap()
    XCTAssertTrue(app.buttons["You are my angel"].waitForExistence(timeout: 5))
    try audit(app, "Lyrics")
    app.buttons["Close now playing"].tap()

    app.tabBars.buttons["Library"].tap()
    app.buttons["Settings"].tap()
    try audit(app, "Settings")
    app.buttons["Playback"].tap()
    try audit(app, "Settings → Playback")
    app.navigationBars.buttons.firstMatch.tap()
    app.buttons["Appearance"].tap()
    try audit(app, "Settings → Appearance")

    // Last: the search tab turns the tab bar into its search field.
    app.tabBars.buttons["Search"].tap()
    try audit(app, "Search")
  }

  @MainActor
  func testIPadScreens() throws {
    try XCTSkipUnless(isPad, "iPad only")
    XCUIDevice.shared.orientation = .landscapeLeft
    let app = XCUIApplication.demo()
    app.launch()
    XCTAssertTrue(app.element("sidebar.home").waitForExistence(timeout: 10))
    try audit(app, "Home with the sidebar and player bar")
    app.element("sidebar.albums").tap()
    try audit(app, "Albums")
    app.buttons["Mezzanine, Massive Attack · 1998 · 3 of 5"].firstMatch.tap()
    XCTAssertTrue(app.staticTexts["LINER NOTES"].waitForExistence(timeout: 5))
    playMezzanine(app)
    try audit(app, "Album, playing")
    app.element("playerBar.queue").tap()
    XCTAssertTrue(app.element("sideColumn").waitForExistence(timeout: 5))
    try audit(app, "Queue column")
    app.element("playerBar.lyrics").tap()
    try audit(app, "Lyrics column")
    app.buttons["Open now playing"].tap()
    XCTAssertTrue(app.element("nowPlaying.upNext").waitForExistence(timeout: 5))
    try audit(app, "Now Playing with Up next")
    app.buttons["Close now playing"].tap()
    app.element("sidebar.settings").tap()
    try audit(app, "Settings")
  }

  /// The largest accessibility text size (AX5): nothing essential is cut short, everything grows.
  @MainActor
  func testTheLargestTextSize() throws {
    let app = XCUIApplication.demo(["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
    app.launch()
    let types: XCUIAccessibilityAuditType = [.dynamicType, .textClipped]
    if isPad {
      XCUIDevice.shared.orientation = .landscapeLeft
      XCTAssertTrue(app.element("sidebar.albums").waitForExistence(timeout: 10))
      app.element("sidebar.albums").tap()
    } else {
      XCTAssertTrue(app.tabBars.buttons["Library"].waitForExistence(timeout: 10))
      try audit(app, "Home at AX5", types)
      app.tabBars.buttons["Library"].tap()
      app.button(startingWith: "Albums").tap()
    }
    app.buttons["Mezzanine, Massive Attack · 1998 · 3 of 5"].firstMatch.tap()
    XCTAssertTrue(app.staticTexts["LINER NOTES"].waitForExistence(timeout: 5))
    playMezzanine(app)
    try audit(app, "Album at AX5", types)
    app.buttons["Open now playing"].tap()
    XCTAssertTrue(app.buttons["Close now playing"].waitForExistence(timeout: 5))
    try audit(app, "Now Playing at AX5", types)
  }

  /// Library → Downloads with phase 7's made-up downloads.
  @MainActor
  func testDownloads() throws {
    let app = XCUIApplication()
    app.launchArguments = ["-UITestsDownloads"]
    app.launch()
    XCTAssertTrue(app.staticTexts["Mezzanine"].waitForExistence(timeout: 10))
    try audit(app, "Downloads")
  }
}

/// Issues the audit reports that aren't the app's to fix. Each says what, where and why; add one only after
/// trying to fix the view (Task 25), never to get a run green.
enum AuditExceptions {
  @MainActor
  static func ignores(_ issue: XCUIAccessibilityAuditIssue, in app: XCUIApplication) -> Bool {
    // The tab bar's own labels don't grow with Dynamic Type: iOS shows them in the large content viewer instead
    // (press and hold a tab at the accessibility sizes).
    if issue.auditType == .dynamicType, let label = issue.element?.label, app.tabBars.buttons[label].exists {
      return true
    }
    // The audit reads colours from a screenshot: text scrolled under the tab bar's or the player bar's glass is
    // blurred into it. The same text passes once it's scrolled into view.
    if issue.auditType == .contrast, let frame = issue.element?.frame {
      for bar in [app.tabBars.firstMatch, app.descendants(matching: .any).matching(identifier: "playerBar").firstMatch] where bar.exists {
        if frame.maxY > bar.frame.minY { return true }
      }
    }
    // The system's search field truncates its own placeholder in the iOS 26 tab bar.
    if issue.auditType == .textClipped, issue.element?.elementType == .searchField {
      return true
    }
    return false
  }
}
```

`apps/ios/PlayarrUITests/ErrorStateTests.swift`:

```swift
import XCTest

/// With the server unreachable and nothing kept (`-UITestsOffline`), each page says so and offers Try again
/// instead of a blank page or a spinner that never ends.
final class ErrorStateTests: XCTestCase {
  override func setUpWithError() throws {
    try skipOnIPad()
    continueAfterFailure = false
  }

  @MainActor
  func testPagesSayTheServerCantBeReached() {
    let app = XCUIApplication.demo(["-UITestsOffline"])
    app.launch()
    XCTAssertTrue(app.staticTexts["Something skipped."].waitForExistence(timeout: 10))  // Home
    XCTAssertTrue(app.buttons["Try again"].exists)

    app.tabBars.buttons["Library"].tap()
    app.button(startingWith: "Albums").tap()
    XCTAssertTrue(app.staticTexts["Something skipped."].waitForExistence(timeout: 10))
    app.navigationBars.buttons.firstMatch.tap()
    app.button(startingWith: "Artists").tap()
    XCTAssertTrue(app.staticTexts["Something skipped."].waitForExistence(timeout: 10))

    app.tabBars.buttons["Queue"].tap()
    XCTAssertTrue(app.staticTexts["Nothing queued"].waitForExistence(timeout: 5))
  }
}
```

**Step 2: Run them, then fix what they find (Task 25)**

```bash
make -C apps/ios test-app SIMULATOR="Playarr P10 iPhone" 2>&1 | tee /tmp/playarr-audit-iphone.log | grep -E "^AUDIT|Test Case .*(failed|passed)"
```

Expected: `ErrorStateTests` passes. The audits list what's left to fix: Task 25 works through them. Commit the tests now; they're green at the end of Task 25.

**Step 3: Commit**

```bash
git add apps/ios/PlayarrUITests/AccessibilityAuditTests.swift apps/ios/PlayarrUITests/ErrorStateTests.swift
git commit -F - <<'MSG'
iOS UI tests: Xcode's accessibility audit on every main screen on iPhone and iPad and at the largest text size, and the pages' error states

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 24: Performance checks without Instruments

**Files:**
- Test: `apps/ios/PlayarrUITests/PerformanceTests.swift`

**Step 1: Write the tests**

`apps/ios/PlayarrUITests/PerformanceTests.swift`:

```swift
import XCTest

/// Checks that need no Instruments: the app opens quickly, and a queue of 5,000 songs scrolls.
final class PerformanceTests: XCTestCase {
  /// The demo library's Home shows within 10 s of launching (cold, on a simulator that has been busy with UI tests,
  /// it took about 6 s): a launch that blocks on work, such as reading a whole cache on the main thread, shows up here.
  @MainActor
  func testOpensQuickly() {
    let app = XCUIApplication.demo()
    let started = Date()
    app.launch()
    XCTAssertTrue(app.staticTexts["8 tracks across 3 albums, 45 min of music waiting in your library."].waitForExistence(timeout: 15))
    let seconds = Date().timeIntervalSince(started)
    XCTAssertLessThan(seconds, 10, "Home took \(seconds) s to show")
  }

  /// Xcode's launch metric, five launches, for the result bundle. Slow, so only with
  /// `TEST_RUNNER_PLAYARR_PERF=1 make -C apps/ios test-app`.
  @MainActor
  func testLaunchMetric() throws {
    try XCTSkipUnless(ProcessInfo.processInfo.environment["PLAYARR_PERF"] == "1", "Set TEST_RUNNER_PLAYARR_PERF=1")
    measure(metrics: [XCTApplicationLaunchMetric()]) {
      XCUIApplication.demo().launch()
    }
  }

  /// 5,000 songs in Up next (`-UITestsLongQueue`): the list builds its rows as they come on screen, so flicking
  /// through it keeps up, and rows far down appear.
  @MainActor
  func testAQueueOf5000SongsScrolls() throws {
    let app = XCUIApplication.demo(["-UITestsLongQueue"])
    app.launch()
    if isPad {
      XCTAssertTrue(app.element("sidebar.queue").waitForExistence(timeout: 10))
      app.element("sidebar.queue").tap()
    } else {
      XCTAssertTrue(app.tabBars.buttons["Queue"].waitForExistence(timeout: 10))
      app.tabBars.buttons["Queue"].tap()
    }
    let second = app.buttons["Song 2, Massive Attack, 4:00"]
    XCTAssertTrue(second.waitForExistence(timeout: 10))
    let list = app.collectionViews.firstMatch
    // No stopwatch here: XCTest spends almost 3 s per swipe checking for interruptions, whatever the app does.
    // Hitches are what the scrolling metric below measures.
    for _ in 0..<15 { list.swipeUp(velocity: .fast) }
    XCTAssertFalse(second.exists && second.isHittable)
    // The rows on screen now are far down the queue: the list built them as they came.
    let rows = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Song '")).allElementsBoundByIndex
    let shown = rows.filter(\.isHittable).compactMap { Int($0.label.dropFirst(5).prefix(while: \.isNumber)) }
    XCTAssertGreaterThan(shown.max() ?? 0, 50, "rows further down were drawn")

    if ProcessInfo.processInfo.environment["PLAYARR_PERF"] == "1" {
      let options = XCTMeasureOptions()
      options.invocationOptions = [.manuallyStop]
      measure(metrics: [XCTOSSignpostMetric.scrollingAndDecelerationMetric], options: options) {
        list.swipeUp(velocity: .fast)
        stopMeasuring()
        list.swipeDown(velocity: .fast)
      }
    }
  }
}
```

**Step 2: Run them**

```bash
make -C apps/ios test-app SIMULATOR="Playarr P10 iPhone" 2>&1 | grep -E "PerformanceTests|took"
TEST_RUNNER_PLAYARR_PERF=1 make -C apps/ios test-app SIMULATOR="Playarr P10 iPhone" 2>&1 | grep -E "measured|PerformanceTests"
```

Expected: `testOpensQuickly` and `testAQueueOf5000SongsScrolls` pass; the second run also prints Xcode's launch and scrolling measurements (`measured [Duration (AppLaunch), s] average: …`, `measured [Scroll Deceleration Hitch Time Ratio]…`). While this plan was written, the demo's Home showed 6.1 s after a launch on a simulator that had been running UI tests for a while, which is why the ceiling is 10 s: it catches a launch that blocks on work, not small drifts. Note the measured numbers in the commit message's body so a later run has something to compare with.

**Step 3: Commit**

```bash
git add apps/ios/PlayarrUITests/PerformanceTests.swift
git commit -F - <<'MSG'
iOS UI tests: the app opens quickly and a queue of 5,000 songs scrolls

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 25: Everything on both simulators, and the audits green

**Files:** whichever views the audits point at (commit each fix with its view).

**Step 1: Run the whole suite on both simulators**

```bash
make -C apps/ios test SIMULATOR="Playarr P10 iPhone" 2>&1 | tee /tmp/playarr-iphone.log | grep -E "^AUDIT|Test Case .*failed|\*\* TEST"
make -C apps/ios test-app SIMULATOR="Playarr P10 iPad" 2>&1 | tee /tmp/playarr-ipad.log | grep -E "^AUDIT|Test Case .*failed|\*\* TEST"
```

If a run stops with "me.tracklistme.playarr crashed" and the crash report (`ls -t ~/Library/Logs/DiagnosticReports/Playarr-*`) shows `AURemoteIO::Cleanup` / `_ReportRPCTimeout` under `AVAudioEngine.mainMixerNode`, the simulator's audio service hung (it happened once while this plan was written, after many launches): `xcrun simctl shutdown "Playarr P10 iPhone"` and run again.

**Step 2: Fix what the audits report**

What the iPhone audit reported on phase 4's screens while this plan was written, after Tasks 15 to 17's fixes, and what to do with each:

| Screen | Issue | Fix |
|---|---|---|
| Home, Album, Artist, Lyrics, Now Playing | Kickers ("MADE FOR YOU", "HEARD LATELY", "ALBUM · 1998", "PLAYING FROM", "LYRICS FROM") and section titles ("Jump back in") "Dynamic Type partially unsupported" | Not the letter spacing (removing `.tracking` didn't change it). Look at what holds them: a fixed-height container or `.fixedSize` somewhere up the tree, or a `HStack(alignment: .lastTextBaseline)` that can't grow. Try `SectionHeader` without its `alignment:`, then a kicker alone in a `VStack`; keep what makes the issue go. |
| Albums, Artist | Card subtitles ("Massive Attack · 1998 · 3 of 5") "may be clipped at larger sizes" | The audit measures the current layout, so it doesn't see `essentialLineLimit` lifting the limit at AX sizes for the subtitle (it did for titles). Try `.lineLimit(1...)`/`.lineLimit(2)` with `.fixedSize(horizontal: false, vertical: true)`, or let subtitles wrap at every size. |
| Artist | Hero's Play and Shuffle "clipped"; "Shuffle", "2 albums · 5 tracks", "TRIP HOP", "Similar artists in your library" contrast | The hero's text sits on the artist's photo with a gradient: give it a solid scrim behind the text, or `.background(.ultraThinMaterial)` on the buttons; let the buttons' labels wrap (`essentialLineLimit`). |
| Queue | "Massive Attack · Mezzanine" button too small, clipped | Give it `.frame(minHeight: 44, alignment: .leading)` and `essentialLineLimit()` (QueueView `nowPlaying`). |
| Now Playing, Lyrics | "Close now playing" hit area 18 × 11 (the icon, not its 44-point frame); "Playing from Mezzanine" 65 × 16 | The `.frame(width: 44, height: 44)` is on the image inside the label, and `.buttonStyle(.plain)` on the row makes only the glyph hittable: add `.contentShape(Rectangle())` after the frame (close, lyrics, ⋯), and `.frame(minHeight: 44)` with `.contentShape` on Playing from's button. |
| Lyrics | "LRCLIB" credit link 53 × 13; lyric lines and the credit "contrast failed" | Credit link: `.frame(minHeight: 44)`. Lines not yet sung are dimmed on purpose (the web's look); the audit reads them over the blurred cover. Raise the dimmed lines' opacity to what passes 4.5:1 over Playarr's dark (about 0.6 white) rather than adding an exception. |
| Library | the "Playlists" section header "partially unsupported"; three issues with no element | The header is the system's `Section("Playlists")`; if it persists, add an `AuditExceptions` entry for `List` section headers (system text) with that reason. For issues with no element, run the audit on that screen alone and read `detailedDescription`; they often come from a `Menu` label or an image without a label. |
| Search | the search field's placeholder clipped | System field: already an exception. |

What the iPad audit added (the same screens with the sidebar, the player bar and the column; the Now Playing, Queue row and LRCLIB issues above showed again):

| Where | Issue | Fix |
|---|---|---|
| Sidebar, on every screen | Rows ("Home", "Albums", "Queue", "Downloads", "Settings", a playlist's name) "contrast failed" and "may be clipped"; the "Playlists" header button "partially unsupported" | Give the rows' labels `essentialLineLimit()` and the list an opaque background (`.scrollContentBackground(.hidden)` with `.background(.background)`), so contrast is measured on Playarr's dark rather than the translucent sidebar over the page; audit again. If only the system-drawn selected row remains, add an `AuditExceptions` entry for cells whose identifier starts with `sidebar.`, with that reason. |
| Sidebar's foot | Its labels and numbers ("TRACKS", "8", "45 min", "Streaming", the version) "partially unsupported"; "SIZE" "contrast nearly passed" | Same cause as the kickers above (all are `.caption2.monospaced()`/`.caption.monospaced()` text styles, so the monospaced variant is the first thing to try without); for contrast, the foot's labels at `.muted` on `caption2` are at the edge: use `.secondary`-strength (0.7) for them, or `.caption` |
| Home's player bar while nothing plays | "NOTHING PLAYING" kicker "partially unsupported" | As the kickers. |
| Album, Queue and Lyrics columns | The column's queue rows: "Exchange", "Teardrop", "5:30" contrast failed | Up next's rows inside the inspector sit on its glass: give `SideColumnView` `.background(.background)` like the sidebar. |

Then the AX5 run and the Downloads run report their own; fix them the same way. Add to `AuditExceptions` only what the app can't change, each with a comment saying what and why, never to make a run pass.

**Step 3: Green on both**

Expected at the end: `** TEST SUCCEEDED **` on both simulators, with the iPad classes skipped on the iPhone and the phone classes skipped on the iPad.

**Step 4: Commit each fix with its view**, for example:

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/NowPlaying/NowPlayingView.swift
git commit -F - <<'MSG'
iOS: Now Playing's header buttons are 44 points to tap, not their icon's size

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 26: On a device, then TestFlight

The user may not have an iPad that can be cabled to this Mac (the team has no registered devices; see phase 0). If there's none, do the checklist on the "Playarr P10 iPad" simulator (with the Mac's keyboard sent to it, and a trackpad for the pointer: I/O → Input → Send Pointer to Device), then let TestFlight carry the build to whatever iPad the user has.

**Step 1: The checklist (each line: what to do, what should happen)**

- [ ] **Sidebar**: every desktop link opens its page; Requests appears only with requests (and its count of those on their way); a new playlist from "+" appears in the list; the foot's numbers match the web's sidebar; turn off the server's media and the Streaming dot turns red with "offline".
- [ ] **Player bar**: the title opens the album, the artist the artist, the cover Now Playing; the volume slider and mute change the app's level (the device's buttons still work on top).
- [ ] **Column**: the bar's queue and lyrics buttons open and switch the column; songs dragged onto it are queued; "Open queue" in Now Playing opens it.
- [ ] **Now Playing** in landscape and upright: cover beside the song, Up next lists four songs, tapping one plays it; Escape closes it (with a hardware keyboard). If it doesn't, add `.onKeyPress(.escape) { router.nowPlaying = false; return .handled }` with `.focusable()`, `.focusEffectDisabled()` and a `@FocusState` set on appear to `NowPlayingView`'s top view, and check again: on the simulator that didn't receive it either, so only a device can say which works.
- [ ] **Narrow windows**: Split View at a third, a half and two thirds; Slide Over; a small Stage Manager window: below 768 points the phone's tabs and mini player, with the same page open; back to full screen, the sidebar with that page selected.
- [ ] **Keyboard** (Magic Keyboard or Bluetooth): Space, ←/→, Shift+←/→, ↑/↓, M, S, L, / as on the web; holding ⌘ lists them; the menu bar (swipe down from the top) shows Playback and Go; typing in Search types.
- [ ] **Pointer**: cards, rows and bar buttons highlight under it; a secondary click on a song or an album opens its menu.
- [ ] **Drag**: a song onto one of your playlists in the sidebar ("Added “…” to “…”"), onto a shared playlist (refused), onto Queue ("Added 1 track to queue").
- [ ] **VoiceOver**: rotor → Headings jumps between sections; a song row says its title, artist and time, "Playing" or "Paused", and Actions offers Play next, Add to queue, Start radio, Go to album/artist, Add to Favorites; Up next's rows offer Play next and Remove from queue; toasts are read out and their Undo can be activated; the sidebar says which item is selected.
- [ ] **Larger Text** at the largest accessibility size: rows stack and wrap; the player bar stacks; nothing essential is cut short; Now Playing is in one column.
- [ ] **Bold Text**, **Increase Contrast** (secondary text brighter), **Reduce Motion** with Motion → System (the waveform stops, the cover doesn't spring), and Motion → Full with Reduce Motion on (animations back).
- [ ] **Haptics** (iPhone): play/pause, shuffle, repeat, lyrics and column toggles, reordering the queue, dropping songs and toasts all tap; System Haptics off silences them.
- [ ] **Launch**: no white flash; the icon's dark and tinted versions on the Home Screen.
- [ ] **Restoration**: open an artist's album in the sidebar and Now Playing, go Home, open other apps until Playarr is closed in the background (or `xcrun simctl terminate` after going Home on the simulator): it comes back there. A force-quit from the switcher opens on Home, as iOS intends.
- [ ] **Siri and Shortcuts**: "Play my favorites in Playarr", "Shuffle everything in Playarr", "Start radio from this song in Playarr"; the three in the Shortcuts app and on the Action button (iPhone 15 Pro and later); with nothing playing, Start radio says "Nothing playing."
- [ ] **iPhone unchanged**: tabs, mini player, Now Playing and the queue as after phase 4.

**Step 2: TestFlight**

If the checklist passes, ask the user whether to ship a build to TestFlight: `corepack pnpm ios:beta` (15 to 45 minutes; run it in the background), or push to `main`, which uploads through GitHub Actions. A push to `main` also deploys the server to the user's NAS, so only push when the user says so. "What to Test" comes from the commit messages since the last build, so it will list this phase's iPad, keyboard and accessibility work.

---

### Task 27: Record this phase's names in the conventions, and tell phase 11

Skip the conventions part if whoever coordinates the phase plans has already made these edits.

**Files:**
- Modify: `docs/plans/2026-11-03-ios-conventions.md`

**Step 1: Edit**

- Under "Key types → PlayarrUI": `ShellLayout` (`.tabs`/`.split`, `choose(regularWidth:width:)`, 768 points), `SidebarItem`, `SideColumn`, `AppRouter.layout`/`sidebar`/`detail`/`column`/`focusSearch`, `select(sidebar:)`, `openSearch()`, `setLayout(_:)`, `RouterSnapshot` (in `@SceneStorage("router")`), `AdaptiveShell`/`TabShell`/`SplitShell`, `PlayerBar`, `shellDestinations(_:)` (what every stack can show: later phases add their destinations there, not per tab), `Route.requests` and `Route: Codable`, `KeyCommand`/`KeyCommandHandler`/`PlaybackControlling`/`PlayarrCommands`, `TrackDrag` (type `me.tracklistme.playarr.tracks`), `QuickPlay`, `AdaptiveStack`, `essentialLineLimit()`, `.muted`, `reducesMotion`, `pointerHover()`, `Haptic`, `ArtworkText`, `AccountSession+Shell.swift` (favorites and playlists as the shell calls them).
- Under UI tests: `-UITestsOffline`, `-UITestsLongQueue`, `-UITestsRestore`; `skipOnIPad()` for tab-bar flows; accessibility identifiers `sidebar.<item>`, `sidebar.playlist.<id>`, `sidebar.newPlaylist`, `sidebar.footer`, `playerBar`, `playerBar.queue`, `playerBar.lyrics`, `playerBar.mute`, `playerBar.volume`, `sideColumn`, `nowPlaying.upNext`; run UI tests on simulators of your own.
- Under "Swift conventions → Accessibility": words drawn on artwork go through `ArtworkText`; new controls are at least 44 points (`.contentShape` after the frame); secondary text is `.muted`.

**Step 2: Phase 11's screenshot test**

Phase 11's `StoreScreenshots` (its Task 10) taps "Library" and looks for `otherElements["MiniPlayer"]`. On the iPad there's no Library item (the sidebar *is* the library) and no mini player: tap `app.descendants(matching: .any)["sidebar.albums"]` on an iPad, and find the bar by `app.descendants(matching: .any)["playerBar"]` (the phone's mini player is `miniPlayer`, lower case, since phase 4). "Open now playing" is the label of both the mini player and the bar's cover, so `app.buttons["Open now playing"].tap()` opens Now Playing on either. Tell the coordinator, or make the change in phase 11's plan if it's yours to change.

**Step 3: Commit**

```bash
git add docs/plans/2026-11-03-ios-conventions.md
git commit -F - <<'MSG'
iOS conventions: the names phase 10 settled (the iPad layout, keyboard, drag, accessibility pieces, UI test arguments and identifiers)

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

## What later phases can rely on

```swift
// PlayarrUI
public enum ShellLayout: String, Codable { case tabs, split; static let splitMinWidth: CGFloat; static func choose(regularWidth: Bool, width: CGFloat) -> ShellLayout }
public enum SidebarItem: Hashable, Codable { home, search, mixes, artists, albums, favorites, downloads, queue, requests, playlists, playlist(Int), settings
  static let links; var title; var systemImage; var identifier; var route: Route?; init?(route: Route)
  static func place(tab: AppTab, path: [Route]) -> (item: SidebarItem, detail: [Route]); func place(detail: [Route]) -> (tab: AppTab, path: [Route]) }
public enum SideColumn: String, Codable, CaseIterable { case queue, lyrics }
extension Route { case requests }                              // and Route: Codable
extension AppRouter {                                          // stored in AppRouter
  public internal(set) var layout: ShellLayout; public var sidebar: SidebarItem; public var detail: [Route]; public var column: SideColumn?; public var focusSearch: Bool
  public func select(sidebar: SidebarItem); public func openSearch(); public func setLayout(_: ShellLayout)
  public func snapshot(account: String) -> RouterSnapshot; public func restore(_: RouterSnapshot, account: String, hasSong: Bool)
}
public struct RouterSnapshot: Codable, Equatable { account, layout, tab, paths, sidebar, detail, nowPlaying, lyrics, column; var data: Data?; init?(data: Data?) }
extension AppModel { public var restoresPlace: Bool; public static func demo(api: any APISending = DemoAPI()) -> AppModel }
public enum KeyCommand: String, CaseIterable { playPause, seekBack, seekForward, previous, next, volumeUp, volumeDown, mute, shuffle, favorite, search; title; key; modifiers }
@MainActor public protocol PlaybackControlling: AnyObject { song; time; duration; masterVolume; togglePlay(); seek(to:); next(); previous(); setVolume(_:); toggleMute(); toggleShuffle() }   // Player conforms
@MainActor public struct KeyCommandHandler { init(controls:toggleFavorite:openSearch:); init(session:); func perform(_: KeyCommand) }
public struct PlayarrCommands: Commands { public init(model: AppModel) }
public struct TrackDrag: Codable, Transferable, Equatable { var tracks: [Track]; static func tracks(_:) -> [Track]; static func accepts(_: PlaylistSummary) -> Bool }   // UTType.playarrTracks
@MainActor public struct QuickPlay { init(session: AccountSession?); playFavorites() async throws(Failure); shuffleEverything() async throws(Failure); startRadio() async throws(Failure) }
public struct SidebarFooter: Equatable { stats; statuses; init(health: HealthStatus?, failed: Bool); static func version(_: AppVersion) -> String }
public struct VolumeDisplay: Equatable { volume; muted; shown; systemImage; muteLabel; valueText }
public struct Muted: ShapeStyle { static func opacity(_: ColorSchemeContrast) -> Double }   // .muted
extension EnvironmentValues { public var reducesMotion: Bool }
extension AccountSession { isFavorite(_:), toggleFavorite(_:), add(_:to:), newPlaylist() }   // phase 6's calls, in one file
public struct OfflineAPI: APISending; extension Demo { public static func manyTracks(_ count: Int) -> [Track] }
// Internal: AdaptiveShell, TabShell, SplitShell, Sidebar, SidebarFooterView, PlayerBar, PlayerBarTransport, VolumeControl,
// SideColumnView, UpNextPreview, KeyboardShortcutsSection, AdaptiveStack, essentialLineLimit(), pointerHover(), pointerLift(),
// Haptic, ArtworkText, shellDestinations(_:).
```

App target: `PlayFavoritesIntent`, `ShuffleEverythingIntent`, `StartRadioIntent`, `PlayarrShortcuts`; `AppDependencyManager` holds the `AppModel`. Launch arguments: `-UITestsOffline`, `-UITestsLongQueue`, `-UITestsRestore` (with `-UITests -UITestsDemo`).

## Verified while writing

- **Against the code this phase will meet.** The checked tree was `apps/ios` from `main` at `8e22d1d` (phases 0 to 5 as implemented) with phase 6's plan applied task by task (phase 6's own replay), plus stand-ins for what phases 7 and 8 add (`Route.downloads`, `DiscoverContext`/`RequestsModel`, `RequestsPage`, `MusicBrainzIndicator`, `discoverDestinations()`, with their plans' names). This plan's new files and every "replace this with that" were applied to it by script; every anchor matched exactly once, and rebuilding the tree from scratch the same way gave the same files.
- **Package.** `swift test --disable-sandbox` on `PlayarrUI`: 201 tests in 49 suites passed (phases 4 to 6's and this plan's 41), with no warnings; the package built for `arm64-apple-ios26.0-simulator` with no errors or warnings. An earlier pass against phase 4 alone (`2232f2a`) passed three runs in a row.
- **App and UI tests, on simulators of their own (iOS 26.1 runtime).** `make build` succeeded for the iPhone and iPad with the intents (their metadata extracted), the icons (`actool` compiled the dark and tinted appearances with no warnings), the launch colour and the plist changes (`plutil -lint` OK). On "Playarr P10 iPad": all five `IPadLayoutTests` passed (sidebar, player bar and column; Up next; the keyboard's Space, →, S, M, ↓ and "/" with typing in Search; dragging a song onto the sidebar's Queue; coming back where it was). On "Playarr P10 iPhone": `LaunchTests`, phase 4's `BrowseTests` (all four, including `testTheQueueClearsWithUndo`) and phase 6's `PlaylistsTests` (with Task 21's skip and Task 12's "Playing from Mezzanine" label), `ErrorStateTests`, `testOpensQuickly` and `testAQueueOf5000SongsScrolls` passed; on the iPad the scroll test passed through the sidebar's Queue and the phone's classes skipped. The phone's and the iPad's audits ran end to end (against phase 4's screens); what they reported is Task 25's tables, after Task 17's fixes removed the cover, mix-cover and card-title issues. `testOpensQuickly` measured 6.1 s on a busy simulator, hence the 10 s ceiling.
- **Found by the simulator and fixed in this plan:** identifiers on a sidebar `Label` landed on its icon (Task 8 makes each row one element); the inspector on the detail column's stack never appeared (Task 11 puts it on the split view); two one-line links in the player bar failed the hit-area check (Task 9's single song button); changing the volume unmutes, as on the web (Task 22's test follows); Search capitalizes its first letter; XCTest's interruption check makes a swipe take about 3 s, so the scroll test counts rows rather than seconds.
- **The icon script** ran: 1024 × 1024, dark with alpha, tinted opaque; looked at.
- **Not verified:** Escape closing Now Playing (the simulator didn't deliver it to the full-screen cover; Task 26), the menu bar and ⌘ overlay's look on iPadOS 26 (the commands work from the keyboard), the AX5 and Downloads audits, the Xcode metrics behind `TEST_RUNNER_PLAYARR_PERF=1`, anything against phase 7, 8 or 9's real code, VoiceOver by ear, a real iPad, and Siri's phrases.

## Not in this phase

Spotlight indexing and widgets or Live Activities (decided against above); dragging whole albums; a second window (`UIApplicationSupportsMultipleScenes` stays off); Icon Composer's layered icon; Mac (Designed for iPad or Catalyst); CarPlay; App Store text, screenshots and submission (phase 11).
