# How the iOS app lays itself out

One app, several shapes: an iPhone upright, an iPhone on its side, an iPad window of any width, and the iPhone Duo folded, open or propped up. This page covers what each shape shows, the numbers that pick one, and where the code lives. Everything is in `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI` unless a path says otherwise; the UI tests are in `apps/ios/PlayarrUITests`.

Two pure functions choose almost everything, and both are unit-tested:

- `ShellLayout.choose(regularWidth:width:)` (`Shell/ShellLayout.swift`): the phone's tabs or the iPad's sidebar.
- `NowPlayingLayout.choose(split:compactHeight:accessibilitySize:fold:wider:)` (`NowPlaying/Sideways/NowPlayingLayout.swift`): how Now Playing is arranged.

---

## 1. The shell: tabs or sidebar

`AppShell` (`Shell/AppShell.swift`) is the signed-in app. It holds `AdaptiveShell`, presents Now Playing over everything as a full-screen cover, and shows toasts.

`AdaptiveShell` (`Shell/AdaptiveShell.swift`) reads the window's width and horizontal size class and asks `ShellLayout.choose`:

- **Split** (the sidebar) when the size class is regular *and* the window is at least 768 points wide (`splitMinWidth`, the web's desktop breakpoint).
- **Tabs** otherwise: every iPhone upright, and on an iPad Slide Over, a third or half of the screen in Split View, a small Stage Manager window, or an iPad mini upright (744 points).

It switches live as the window is resized. `AppRouter.setLayout(_:)` carries the place across: Home, Search and Queue exist in both; a page opened from Library that has a sidebar item becomes that item with the rest of the stack on top, and back again. The side column closes when the window drops to tabs.

## 2. iPhone, upright

`TabShell` (`Shell/TabShell.swift`): Home, Search, Library and Queue, each a `NavigationStack` of `Route`s. Search has the system's search role, so held sideways iOS folds the other tabs into one button beside the field. The tab bar shrinks while scrolling down (`minimizingTabBar()` in `Components/Platform.swift`). Each tab's root has the account button at the top right (`Shell/AccountMenu.swift`).

**Page headers.** Tabs and library lists (Library, Albums, Artists, Playlists, Made for you, Downloads, Requests, Your listening, the Queue) use the system's large title, set in Gloock by `Typography.register()`, with how many the page holds as its subtitle in DM Mono and the page's controls (sort, filter, Edit) in the bar on the right: `pageHeader(_:count:)` in `Components/Platform.swift`. The subtitle is a blank line until the count is known, since one that arrives after the page has opened folds the large title into the bar. The bar shows the title once the large one has scrolled away.

**Detail headers.** Everything you can play (album, playlist, mix, Favorites, artist, an artist's discography) starts with `DetailHeader` (`Components/DetailHeader.swift`): the cover, a kicker saying what it is ("Live album", "Playlist", "Made for you"), the title, one meta line and the action row. On a phone the cover sits above the words, 64% of the width and at most 256 points (an artist's circle 40% and 160, `DetailCover.side`), so Play shows on the first screen down to an iPhone SE; at regular width it sits beside them, 240 points (192 for a circle), the words lined up with its foot. Descriptions come after the action row. The page names itself in the bar only once its own title has scrolled under the bar (`titleInBar(_:)` on the page, `scrollsUnderBar()` on the title, `Components/TitleInBar.swift`), so no screen shows a name twice; a playlist's or mix's cover leaves its name off on its own page. An artist with a photo of their own gets the photo as a band behind the header; one without (the server answers an album's cover, `ArtistDetail.photo` in `Pages/Artist/ArtistDetail+Photo.swift`) gets the compact header, their picture in a circle.

**Names and numbers** (`Components/NameAndNumbers.swift`): a name and the numbers about it share a line when both fit, else the numbers go under the name; the name is only cut short once they have. Stats' top artists and songs, the queue's rows and Downloads' rows use it. On a phone the queue's rows leave the heart to their menu.

**The mini player** (`NowPlaying/MiniPlayer.swift`) sits in the tab bar's bottom accessory (`tabViewBottomAccessory`), only while something is queued. The round cover is ringed by how far into the song it is; tap it to open Now Playing. Play/pause and next are 44-point targets.

**Now Playing, upright** (`NowPlaying/NowPlayingView.swift`) is one column over a backdrop of the cover blown up, blurred and darkened:

1. The header: close on the left, "Playing from" in the middle, the sleep timer, lyrics and ⋯ on the right. The two sides are one width, so the source stays centred.
2. The cover, or the lyrics in its place (`LyricsView`). The cover shrinks to 86% when paused.
3. The song: title in Gloock, the artist (a button to their page), the format badge and the heart. At the accessibility sizes the badge drops under the artist so the name wraps.
4. The seek bar, the transport and, with DJ mixing on, the next transition in words (`TransitionLine`).

Swipe down closes it past 120 points or faster than 600 points a second (`NowPlayingModel.closeDistance`, `closeVelocity`). Escape closes it too (section 7).

## 3. iPhone, sideways: the pages

Every screen turns. `OrientationPolicy.mask` (`Shell/OrientationPolicy.swift`) is all but upside down on an iPhone and everything on an iPad; the app delegate (`apps/ios/Playarr/AppDelegate.swift`) answers with it.

A page counts as sideways when the vertical size class is compact (`GatefoldRule.applies`, `Components/Gatefold.swift`). Each has its own style:

- **Albums, playlists and mixes open as a gatefold** (`Gatefold`): the artwork fixed on the leading side, the page scrolling beside it. The artwork's side is the height less 32 points, at most 40% of the width. Used by `Pages/Album/AlbumView.swift`, `Pages/Playlists/PlaylistView.swift` and `Pages/Mixes/MixView.swift`.
- **The artist's photo band** is 240 points tall instead of 380 (`Pages/Artist/ArtistView.swift`), so the albums start on the first screen.
- **Home's greeting** shares one row with Feeling lucky and Resume (`Pages/Home/HomeView.swift`), so the shelves start on the first screen.
- Lists, grids and shelves reflow on their own.

## 4. iPhone, sideways: Now Playing, the sleeve opened

Held sideways, Now Playing opens like a gatefold record sleeve. It splits by thumb: the left thumb plays, the right thumb browses. `NowPlayingLayout.choose` returns `.sideways` when the window's height is compact and it isn't the iPad layout. `NowPlayingView.sleeve` draws it.

### The record (left column)

The cover, with the deck under it: everything you do to the song.

- **The deck** (`Sideways/NowPlayingDeck.swift`): the seek bar with both times, then shuffle, previous, play/pause (52 points), next and repeat. It sits straight on the backdrop, with no glass panel. It needs 264 × 108 points (`deckWidth`, `deckHeight`).
- **The column's width** is `NowPlayingLayout.recordWidth`: as wide as the cover can be once the deck has its height (less a 16-point margin), at least the deck's 264 points, at most 42% of the width (36% at the accessibility sizes), and never so wide that the tracklist gets less than 300 points. On an iPhone 17 Pro that's 264 points.
- **The cover** keeps the upright cover's shadow and its shrink when paused. Swipe down to close. Swipe sideways for the next or previous song: the cover follows the finger at 60% and springs back, and past 30% of the column's width the song changes. Tap for the stage.

### The back (right column)

Everything right of a 28-point gutter, at the full height:

1. **One header line** (44 points): close, then "PLAYING FROM" as a kicker over the source with the time left after it, quieter ("Mezzanine · 3 songs · 17 min left"), then the sleep timer, lyrics and ⋯.
2. **The tracklist or the lyrics**, scrolling, in all the room that's left. The lyrics button swaps one for the other; the cover stays put. (Upright, lyrics replace the cover; sideways, they replace the songs, because the big cover is the point of the wide screen.)

### The tracklist

`Tracklist` (`Sideways/Tracklist.swift`) is the pure model; `NowPlayingTracklist` (`Sideways/NowPlayingTracklist.swift`) draws it. It reads like the back of a sleeve and works like the queue.

- **What's in it:** the song before the one playing (at half opacity, tap to go back to it), the song playing, then the rest of the queue in play order (`QueueState.order` from `pos − 1`), so shuffle shows the shuffled order. Lines are built on demand, so 5,000 songs cost only the lines on screen.
- **The open line** is the song playing: its title in Gloock at 22 points in the accent colour, the artist as a button, the format badge and the heart, with a waveform in the number column that animates while playing (static under reduced motion). It's the only place the title appears.
- **Numbers:** an album played in order from its page (not shuffled) carries the record's numbers, disc-track on multi-disc albums ("2-04"). Songs radio adds after it, and every other queue, are numbered by place from the song playing: 1 is next.
- **Each line:** the title; the artist when the source isn't one album or artist; the album when it differs from the line above (so a mix reads "Massive Attack · Blue Lines"); the offline mark; the length, after the tempo on a regular-width window (`SongLength`).
- **Joins** between lines say how one song becomes the next (`Tracklist.Join`):
  - same album, in order (`JoinRules.continues`): a hairline down the number column;
  - DJ mix: under the open line, the next transition in words (`TransitionLine`, which opens the transition sheet); pairs further down get a faint dotted joiner, since only the next pair is planned;
  - crossfade: a fade glyph with the seconds ("6 s"), never inside an album;
  - off: plain spacing.
- **Touch:** tap a line to play from it (`Player.jump(to:)`). Long-press for Play next, Add to playlist…, Go to album, Go to artist, Remove from queue. Swipe left to remove an upcoming song. Reordering stays on the Queue tab.
- **Follow:** the list keeps the open line second from the top and glides to the new one as songs change. Scroll it yourself and it stops following; a "Now" capsule appears at the top, and the list goes back by itself after 8 seconds untouched (`returnAfter`).
- **The end:** one quiet line after the last song: "Then from the top" with repeat all, "Then: more like these" with autoplay on, else "The queue ends here".

### The stage

Sideways is how a phone sits in a stand, so Now Playing gets a calmer state.

- **When:** after 12 seconds untouched while playing (`NowPlayingView.stageAfter`), or on a tap on the cover.
- **What changes:** the header and deck fade; the record's column is recomputed with no deck, so the cover grows into its room (up to 42% of the width); the other tracklist lines and the end line dim to 25%; the open line's title grows to 34 points.
- **Back:** any touch, pausing (from anywhere, including the lock screen), or VoiceOver turning on. With VoiceOver running there is no stage. The fade takes 0.6 s, or is instant with reduced motion.

### Turning, and the settings

- **Turn to open** (Settings → Appearance → Held sideways → "Turn to open Now Playing", iPhone only, off by default). With it on, a song queued and nothing presented, turning the phone on its side opens Now Playing straight into the sleeve. It listens to `UIDevice.orientationDidChangeNotification` in `AppShell`, and ignores the phone lying flat. Turning back upright leaves Now Playing open, upright.
- **Portrait Orientation Lock:** nothing turns, so pages and Now Playing stay upright. Whether turn-to-open also stays quiet under the lock rests on what iOS reports and is on the device checklist.
- **Screen on while charging** (Settings → Appearance → Held sideways → "Keep the screen on while charging", on by default). While Now Playing is sideways and the phone is charging or full, `ScreenAwake` (`Shell/OrientationPolicy.swift`) sets `isIdleTimerDisabled`. It's cleared when the phone turns upright, the charger comes out, or Now Playing closes. Settings live in `Theme/AppearanceSettings.swift`, the panel in `Settings/AppearancePanel.swift`.
- **The turn itself** swaps one arrangement for the other; there's no shared-geometry animation between upright and sideways.

## 5. The iPad

**Sidebar and split view** (`Shell/SplitShell.swift`): a `NavigationSplitView` with `Sidebar` (`Sidebar/Sidebar.swift`) on the left (220–320 points), the page and its stack in the middle, and the queue or lyrics in an `inspector` column on the right (300–440 points, `Shell/SideColumnView.swift`). The player bar (`PlayerBar/PlayerBar.swift`) runs along the bottom as a safe-area inset; at the accessibility sizes it becomes a card over the page. The sidebar is one scrolling list (the desktop links, Requests while there are some, your playlists with "+"), with Settings kept at the foot above the player bar. Once the links scroll away, a bar at the top keeps the one you're on.

**Titles.** A page opened from the sidebar has its title, and its count, in the bar: iPadOS shows the first page of the detail column's stack with an inline title whatever it asks for, and keeps large titles for the pages pushed after it ("Your listening" from Settings). Detail headers put the cover beside the words (section 2).

**Narrow windows** get the phone's tabs and mini player with the same page open (section 1). The mini player shows only with the tabs, the player bar only with the sidebar.

**Now Playing, wide:** the cover (or lyrics) beside a column of at most 480 points with the song, seek bar, transport, transition line and Up next (`NowPlaying/UpNextPreview.swift`, the next four songs). At the accessibility text sizes the iPad falls back to the upright column. The iPad doesn't use the sleeve's tracklist.

**Keyboard shortcuts** are menu commands (`Keyboard/PlayarrCommands.swift`, attached in `apps/ios/Playarr/PlayarrApp.swift`), so they show in the iPad's menu bar and while ⌘ is held, and work in every screen. As on the web (`Keyboard/KeyCommand.swift`, `KeyCommandHandler.swift`): Space plays or pauses, ←/→ move 10 s, Shift+←/→ change song, ↑/↓ change the volume by 5% (also while the sidebar has focus), M mutes, S shuffles, L hearts the song, / opens Search. Text fields keep their keys. Escape closes Now Playing through both `.keyboardShortcut(.cancelAction)` and `onKeyPress(.escape)`. Settings → Playback lists the shortcuts on an iPad (`Settings/KeyboardShortcutsSection.swift`).

**Pointer:** `pointerHover()` (`Accessibility/View+Pointer.swift`) highlights cards, rows and bar buttons without lifting them. A secondary click opens the same context menu as a long press.

**Drag and drop** (`Drag/TrackDrag.swift`): song rows are `.draggable` as `TrackDrag`, its own type (`me.tracklistme.playarr.tracks`, declared in `Config/Info.plist`), so other apps' text and files don't land. Drop on the sidebar's Queue link or the queue column to add to the queue; drop on one of your own playlists to add to it. Shared playlists refuse drops.

**Scene restoration:** `AdaptiveShell` keeps a `RouterSnapshot` (`Shell/RouterSnapshot.swift`) in `@SceneStorage("router")`: the layout, tab and stacks, sidebar item and its stack, Now Playing, lyrics and the side column. When iOS reopens a window it closed in the background, the app comes back there. Another account's snapshot is ignored, and Now Playing only reopens with a song queued. A force-quit starts on Home, as iOS intends. The app has one window (`UIApplicationSupportsMultipleScenes` is off); Split View, Slide Over and Stage Manager still resize it.

## 6. The iPhone Duo

A folding iPhone. Two pieces of code handle it: `UnderTheRail` for the cover screen, and `Fold` for the hinge.

**Folded (the cover screen).** iOS puts the status bar, the bar buttons and the tabs in a column on the right (the tabs on the system's rail). The mini player floats at the foot of the page. iOS keeps pages clear of that column; `UnderTheRail` (`Shell/UnderTheRail.swift`) lets their backgrounds (an album's wash, an artist's photo, Now Playing's blurred cover) run under it, as a phone's run under its tab bar, while rows, words and buttons keep clear of it: the column covers most of the screen's height. It ignores the column's safe area and gives its width back as safe-area padding, so scroll views inset what they scroll and what ignores the safe area still reaches under the column. It recognizes the cover screen as an upright window with a trailing safe-area inset, which an ordinary iPhone only has when turned (`UnderTheRail.railWidth`). It's applied to each tab's root, each pushed page (`Shell/RouteDestination.swift`) and Now Playing. There, Now Playing sits in a `NavigationStack` purely for its bar: the sleep timer, lyrics and ⋯ go into the bar, so they stand in the column under the time, and the top row keeps only close and "Playing from".

**The hinge.** `Fold` (`NowPlaying/Fold.swift`) is `.none`, `.flat` or `.half`, from `onHingeChange` (iOS 27.1, built only with the Swift 6.4 SDK). It stays `.none` on every other device. UI tests force it with `-UITestsFold flat|half`, since the simulator can't open the hinge. Together with whether the window is wider than tall, it picks Now Playing's layout first, before the iPad's or the sideways rules:

- **Open, crease down the middle** (flat or half-open, wider than tall): `.pages`. The cover is centred on the left page; the header, song, seek bar, transport, transition line and Up next are on the right. A margin either side keeps the crease between them, not through the words.
- **Propped up like a laptop** (half-open, taller than wide, the crease across): `.desk`. The header and cover (or lyrics) are on the standing half; the song, controls and Up next are on the half lying flat, under the thumbs.
- **Open flat but upright, or shut:** the usual layouts.

**Hinge changes while playing** only re-lay Now Playing; the player isn't touched, so the music carries on.

## 7. Accessibility

- **VoiceOver:** page and section titles carry the header trait, so the rotor's Headings jump between sections. Song rows (`Components/TrackRow.swift`) and Up next's rows (`Pages/Queue/QueueView.swift`) offer their menu as custom actions. Sleeve lines read their number, title, artist, length, "played" or "next", and "joined to the song before". There are no custom rotors.
- **Text sizes:** `AdaptiveStack` turns rows into columns at AX1–AX5, and `essentialLineLimit()` lets essential text wrap there (`Accessibility/AdaptiveStack.swift`). The iPad's Now Playing goes to one column; the sleeve keeps its shape with a 36% record column.
- **Increase Contrast:** secondary text uses `.paperDim` (`Theme/Palette.swift`), white at 70%, or 85% with more contrast; quieter text uses `.muted`, white at 50%, or 65%.
- **Bold Text:** no code of its own; the bundled fonts are left to the system.
- **Reduce Motion:** Settings → Appearance → Motion (System, Reduced or Full) together with the system setting becomes the `reducesMotion` environment value, set once by `AppShell`, which also drops animations app-wide.
- **Audits:** `AccessibilityAuditTests` runs Xcode's `performAccessibilityAudit()` over each main screen on the iPhone and the iPad, at AX5 (upright), and on Downloads. Exceptions live in one enum, `AuditExceptions`, each with its reason; contrast is re-measured from the element's pixels where the audit misreads it.

## 8. Haptics, buttons and icons

**Haptics** come from one table, `Haptic` (`Components/Haptic.swift`): medium impact for play/pause; selection for shuffle, repeat, the lyrics toggle and the side column; light impact for reordering the queue; success for songs dropped; success or error with a toast. The heart, Feeling lucky and the action row's Play have their own. System Haptics off silences them all.

**Buttons** follow [the design language](../design.md#controls), in `Components/`:

- **Actions** are `.buttonStyle(.pill(_:size:))` (`PillButtonStyle.swift`): a capsule with its words in sentence case in Schibsted Grotesk medium (regular at the accessibility sizes), an optional leading icon. Variants: `.primary` (the accent, the one main action: Play, Feeling lucky, Try again, Save), `.secondary` (outlined: Shuffle, New mix, Cancel), `.ghost` and `.danger`. Sizes: `.large` 48 points, `.regular` 40, `.small` 32 (its words a size down); every one takes at least 44 points to tap. Disabled at 40 %; pending, the verb with an ellipsis ("Requesting…"). A large primary (Play, Feeling lucky) glows with the accent, as the web's `shadow-glow`.
- **Icon buttons** in an action row are `.buttonStyle(.outlinedIcon)` (`OutlinedIconButtonStyle.swift`), a 48-point outlined circle; `OutlinedIcon` draws the same for a menu's label or a status.
- **Choices** (Stats' ranges) are `.buttonStyle(.choice(selected:))` (`ChoiceButtonStyle.swift`): DM Mono capitals, the chosen one filled. A row of them scrolls sideways rather than wrapping. Settings keeps the system's segmented pickers and menus.
- **Statuses** that do nothing when tapped (Searching, Importing, 42%, and Requesting… in a card) are a `StatusBadge`, in badge capitals, as tall as a small pill and taking its room, so a card doesn't move as Request turns into Searching.
- **The action row** (`ActionRow.swift`) on the album, playlist, mix, Favorites and artist pages: Play, Shuffle, the page's own action (New mix, Request the rest), Download (`DownloadButton`, its ring filling as the songs arrive) and ⋯. Play is as wide as its widest word, and says Pause or Resume while the queue is the page's own (`PlayState`). The row never wraps: short of room, Shuffle and then the page's action become icons, then the gaps close up and Play drops its icon but keeps its word (`ActionRowCompaction`); at the largest text sizes it scrolls sideways.

**Fonts** (`Theme/Typography.swift`): Schibsted Grotesk for text, Gloock for titles, DM Mono for labels and numbers, all bundled and growing with Dynamic Type.

**Icons:** `apps/ios/Playarr/Assets.xcassets/AppIcon.appiconset` has the light, dark and tinted 1024-point icons. `apps/ios/scripts/make-icons.swift` draws the dark and tinted ones from the same shapes as `AppIcon.png`. The launch screen is the icon's dark (`LaunchBackground`) and the app is dark from the first frame (`UIUserInterfaceStyle` = Dark).

## Tests and screenshots

- Unit: `NowPlayingLayoutTests`, `TracklistTests` (`Packages/PlayarrUI/Tests/PlayarrUITests/TracklistTests.swift`), `ShellLayoutTests`, `RouterSnapshotTests`, `KeyCommandTests`, `TrackDragTests`, `AccessibilityStyleTests`, `ActionRowTests`, `HeadersTests` (meta lines, cover sizes, the Duo's column).
- UI: `SidewaysNowPlayingTests` (pages turn, the sleeve, a tap plays, back upright, turn to open), `IPadLayoutTests` (sidebar, column, Up next, keyboard, drag, restoration; Escape only on a device with `TEST_RUNNER_PLAYARR_DEVICE_CHECKS=1`).
- `pnpm ios:screens` runs `ScreenTour` on an iPhone 17 Pro, an iPad Pro 13" and the iPhone Duo (`apps/ios/Makefile`), upright and sideways, with the Duo's folds forced; `SCREENS=se` runs it on an iPhone SE, the smallest screen, to see that Play still shows on the first screen.

What the simulator can't check (the hinge, Portrait Orientation Lock, charging, Bold Text, haptics, the pointer) is listed in [the device checklist](../plans/2026-11-05-ios-device-checklist.md).
