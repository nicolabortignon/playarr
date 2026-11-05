# Now Playing, held sideways (iPhone landscape)

Date: 2026-11-04. A design spec, not yet an implementation plan. It sits beside [phase 10](2026-11-03-ios-phase10-ipad-polish.md), whose Task 12 gives the iPad (a regular-width window) the web's desktop Now Playing; this spec is for the phone turned on its side (a compact-height window), and proposes one tracklist both can share.

## Why

Turn the phone sideways today and Now Playing squeezes its upright column into 400 points of height: a cover the size of a stamp, the title clipped, the transport under the home indicator. Yet sideways is how a phone sits in a stand on the kitchen counter, on a desk next to the laptop, or in a car mount. That's when a music app is looked at from across the room more than touched. A wide screen is also the one place where the cover and the songs around it fit side by side, the way a record's front and back do.

## The idea: the sleeve, opened

Hold the phone sideways and Now Playing opens like a gatefold sleeve: the cover on the left, the back of the sleeve on the right. The back is a tracklist, not a column of controls. The song playing is simply the line of the tracklist that's open: big, in Gloock, with its artist, heart and format, while the songs before and after it sit around it as numbered lines. The transport is a small deck at the foot of the tracklist.

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ ◖island                                                                          │
│   ┌───────────────────────────────┐   ⌄   PLAYING FROM                  ☾  ❝  ⋯  │
│   │                               │       Mezzanine · 7 songs · 38 min left       │
│   │                               │   ─────────────────────────────────────────── │
│   │                               │    2  Risingson                        4:58   │  ← played, dim
│   │                               │   ┃                                           │  ← same album: joined
│   │          the cover            │    3  Teardrop                    ♥  FLAC     │
│   │      (square, as tall as      │       Massive Attack                    ▮▮▮   │  ← the open line
│   │       the window allows)      │   ┃                                           │
│   │                               │    4  Inertia Creeps                   5:56   │
│   │                               │   ⤳ 32-beat blend · 98 → 101 BPM              │  ← DJ mix: how the next comes in
│   │                               │    1  Unfinished Sympathy  ·  Blue Lines 5:08 │
│   └───────────────────────────────┘  ╭───────────────────────────────────────────╮│
│                                      │ 1:12 ━━━━━━━━━━●──────────────────── -3:59 ││
│                                      │      ⤨       ⏮       ( ⏸ )       ⏭      ↻  ││
│                                      ╰───────────────────────────────────────────╯│
└──────────────────────────────────────────────────────────────────────────────────┘
```

Everything else stays as upright Now Playing has it: the cover blown up and blurred as the backdrop over the whole screen, the album's accent colour for what's active, Gloock for titles, DM Mono for numbers and kickers.

## Layout

**When.** The sideways layout is for a compact-height window: an iPhone in landscape (`verticalSizeClass == .compact`). The iPad keeps phase 10's wide layout, and an iPhone upright keeps today's. One decision function, `NowPlayingLayout.choose(verticalSizeClass:horizontalSizeClass:size:)` → `.upright`, `.sideways` or `.wide`, tested like phase 10's `ShellLayout.choose`.

**Revised 2026-11-05: left thumb plays, right thumb browses.** The first version put the deck under the tracklist, which left it two lines on an iPhone 17 Pro. Held in two hands, each thumb rests on one side, so the sleeve now splits by job:

**The record (left column).** The cover with the deck under it: everything done *to the song*. The column is `NowPlayingLayout.recordWidth`: as wide as the cover can be once the deck has its 108 points of height, at least the deck's 264 points, at most 42% of the width (36% at the accessibility sizes), and never so wide that the tracklist gets less than 300 points. The cover fits the height left above the deck; it keeps upright's shadow and its press-in when paused, and its swipes (down to close, sideways for next and previous) and tap (the stage).

- **Deck:** the seek bar with both times, then shuffle, previous, play/pause (52 pt), next and repeat, on the backdrop (no glass panel: nothing scrolls under it now).

**The back (right column).** Everything right of a 28-point gutter, the full height:

1. **Header (one line, 44 pt):** close, then "PLAYING FROM" as a kicker over the source with the time left after it, quieter ("Mezzanine · 3 songs · 17 min left"), then the sleep timer, lyrics and ⋯.
2. **Tracklist or lyrics:** everything that's left, scrolling.

**The stage** fades the deck and header; the cover grows into the deck's room (the column widens to its 42%).

| Phone (points, landscape) | Window | Record column (cover ≈) | Back column | Tracklist height |
|---|---|---|---|---|
| iPhone 17 Pro | 874 × 402 | 264 (257) | ≈ 426 | ≈ 315 (the open line + 5 lines) |
| iPhone 17 Pro Max | 956 × 440 | 279 (279) | ≈ 493 | ≈ 355 |
| iPhone 17e / 16e | 844 × 390 | 264 (245) | ≈ 396 | ≈ 305 |
| iPhone SE (3rd gen) | 667 × 375 | 264 (251) | ≈ 343 | ≈ 311 |

## The tracklist

The heart of the design. It reads like the back of a sleeve and works like the queue.

- **What's in it:** the song before the one playing (dimmed, so you see what just played and can tap back to it), the song playing, then the rest of the queue in play order, all of it, loaded lazily. It's the same data as the Queue tab (`QueueState.order` from `pos − 1`), so shuffle shows the shuffled order.
- **The open line:** the song playing grows to two lines. The title is in Gloock at about 22 pt, with the artist as a button (to the artist page), the format badge and the heart. A small three-bar level meter in the accent colour moves while it plays and freezes when paused (under Reduce Motion it's a static glyph). Lines open and close with a spring as songs change. The open line is the only place the title appears; there's no second copy above the deck.
- **Numbers like a record:** when the queue is an album played in order (`PlaySource` is the album and no shuffle), the lines carry the album's track numbers (disc-track on multi-disc albums: "2-04"). Otherwise they carry their place from the song playing: 1 is next. The number column is DM Mono, and the song playing shows the level meter there.
- **Joins between lines:** this is what makes it Playarr's. Between two lines the gap says how one song becomes the next.
  - Same album, in order (`JoinRules.continues`): no gap. A hairline runs down the number column joining the two, because the songs are heard as one.
  - DJ mix: under the open line, the next transition in words ("⤳ 32-beat blend · 98 → 101 BPM · 8A → 9A"), exactly phase 5's `TransitionLine` text. A tap opens the transition sheet. In this layout the marker replaces `TransitionLine` under the transport. Pairs further down show a faint dotted joiner, since the planner only knows the next pair.
  - Crossfade: a short fade glyph with the length ("6 s") between songs that will fade, so not between songs of an album played in order.
  - Off: plain spacing.
- **Each line:** title, then the artist when it differs from the source's (a playlist or mix shows it; an album doesn't), then the album when it differs from the line above (so a mix reads "Unfinished Sympathy · Blue Lines"), the offline mark, the tempo when known (DM Mono, as the web's Up next shows it) and the duration.
- **Touch:** tap plays from that song (`Player.jump`). Long press opens the usual track menu: Play next, Add to playlist…, Go to album, Go to artist, Remove from queue. Swipe left removes from the queue, with the Queue tab's Undo toast for a mis-swipe. Reordering stays on the Queue tab, where Edit is.
- **Follow:** the tracklist keeps the open line second from the top (the previous song above it) and glides to the new one when a song changes. Scroll away and it stops following. A "Now" capsule appears at the top or bottom edge (wherever the open line went), and the list glides back on its own after 8 seconds without a touch, as the lyrics do.
- **The end:** after the last song, one quiet line in DM Mono: "The queue ends here", or "Then: more like these" with Settings → Playback → "Keep playing when the queue ends" on, or "Then from the top" with repeat all.

**Lyrics** take the tracklist's place in the sleeve column; the cover stays on the left. The lyrics button toggles between the two, and the open line's song is what the lyrics follow. Upright, lyrics replace the cover; sideways, they replace the songs, because a big cover is the point of the wide screen.

## Gestures on the cover

- **Swipe down** closes Now Playing, as upright.
- **Swipe left / right** goes to the next or previous song. The cover follows the finger with rubber-banding, and past 30% of its width it flies off and the next cover slides in.
- **Tap** toggles the stage (below).

## The stage: a phone in a stand

Sideways is the phone's ambient position, so Now Playing gets a calmer state for it.

- **When:** after 12 seconds without a touch while playing, or on a tap on the cover.
- **What changes:** the header and deck fade away and the other lines dim to 25%. The open line grows (title around 34 pt) and moves to the vertical centre of the sleeve column, with the time left beneath it in DM Mono. With lyrics showing, the current line grows instead. The backdrop slowly breathes, its blur drifting a few percent over 20 seconds (not under Reduce Motion).
- **Back:** any touch brings the controls back. Pausing from the lock screen or Control Center brings them back too, so the screen never shows a frozen stage without a play button.
- **Screen on while charging:** while Now Playing is sideways and the phone is charging, the screen doesn't sleep (`isIdleTimerDisabled`). It goes back to normal when the phone turns upright, Now Playing closes or the charger comes out. This is the docked-phone case. On battery, the screen sleeps as usual. One switch in Settings → Appearance turns it off: "Keep the screen on when sideways and charging".

## Turning the phone

- **Every screen turns** (changed 2026-11-05, at the user's request; this first said only Now Playing turns). Each page has its own sideways style: the artwork-led pages (Album, Playlist, Mix) open as a gatefold (`Gatefold`: the artwork fixed on the leading side, the page scrolling beside it), the artist's photo band is lower (240 pt), Home's greeting and Feeling lucky share one row, and lists, grids and shelves reflow. `OrientationPolicy.mask` is all but upside down on an iPhone, everything on an iPad.
- **Turn sideways to open it** (Settings → Appearance → Turn to open, off by default since the pages turn too). With a song queued and Now Playing closed, turning the phone on its side opens Now Playing straight into the sideways layout: the cover rises from the mini player and settles on the left. This needs `UIDevice` orientation notifications, since the interface itself won't turn. It does nothing while a sheet or the keyboard is up, while the phone lies flat, or with Portrait Orientation Lock on (iOS then reports portrait, which also matches what the lock promises; to confirm on a device). Turning back upright leaves Now Playing open, now upright. Swipe down closes it as usual.
- **The turn itself:** one layout, two arrangements. The cover, title, deck controls and list keep their identity across `.upright` and `.sideways` (an `AnyLayout` switch, with `matchedGeometryEffect` for the cover), so on rotation the cover glides from the top centre to the left while the tracklist slides in from the trailing edge. The upright "song" block becomes the open line. Reduce Motion (the system's or Settings → Appearance → Motion: Reduced) crossfades instead.

## Accessibility

- **VoiceOver order:** close, Playing from, sleep timer, lyrics, more, the song playing (title, artist, favourite as actions), the deck (seek, then the transport), then the tracklist lines. Each line reads "3 of 9, Teardrop, Massive Attack, 5:31, next, joined to the song before" and has actions: Play, Play next, Remove from queue. The join marker is part of the line it follows, not an element of its own. The stage never hides controls from VoiceOver: with VoiceOver running there is no stage.
- **Larger text:** up to xxxLarge the layout holds and lines grow. At the accessibility sizes the cover narrows to 36% of the width, the header's actions move into ⋯, and the deck keeps its 44-point controls. Phase 10's audit runs this screen sideways at AX5 too.
- **Increase Contrast** drops the blur backdrop to a flat dark wash in the album's hue, and joins and dimmed lines go to full secondary contrast.

## The iPad, and the web

- Phase 10 Task 12 gives the iPad Now Playing "the cover beside the song … and Up next" (four songs, as the web's desktop). Proposal: build the tracklist once (`NowPlayingTracklist`) and let Task 12 use it in place of `UpNextPreview`, with the iPad's height showing far more of it. Phase 10's plan then changes in Task 10 (no `UpNextPreview`) and Task 12 (the right column ends in the tracklist).
- The web has the same shape on desktop. A follow-up could give phones in landscape on the web the sleeve too (`(orientation: landscape) and (max-height: 500px)`), but that's out of scope here.

## Pieces

| Piece | What |
|---|---|
| `NowPlayingLayout` | `choose(…)` → `.upright` / `.sideways` / `.wide`; the cover side and column widths for a size. Pure, unit-tested. |
| `TracklistModel` | Rows from `QueueState` (previous, playing, upcoming), the numbering rule, the joins (continues / DJ / crossfade / none), the end line, the source tail ("7 songs · 38 min left"). Pure, unit-tested against the demo library's queues. |
| `NowPlayingTracklist` | The list: lines, the open line, joins, follow and the "Now" capsule, touch and menus. Shared with phase 10's iPad Now Playing. |
| `NowPlayingDeck` | Seek bar and transport, sized for the deck; reuses `SeekBar`, `PlayPauseButton`. |
| `StageModel` | When the stage starts and ends (touches, playing, VoiceOver, Reduce Motion), on an injected clock (`TestClock`). Unit-tested. |
| `OrientationPolicy` + `AppDelegate` | Which orientations, and the turn-to-open trigger. |
| `NowPlayingView` | Switches arrangement by `NowPlayingLayout`; the matched cover; the cover's swipes. |
| Settings → Appearance | "Keep the screen on when sideways and charging". |

## Testing

- **Unit:** `NowPlayingLayout.choose` and the size table above. `TracklistModel` for an album in order (track numbers, every pair joined), shuffle (place numbers, no joins), a mix (artists and albums shown), DJ mix (the marker after the open line only), crossfade (fade glyphs, none inside an album), and the end line in each mode. `StageModel` covers 12 seconds idle, touch, pause, VoiceOver on.
- **UI test** (demo library): play Mezzanine, set `XCUIDevice.shared.orientation = .landscapeLeft`. Now Playing opens by itself and the tracklist shows "Teardrop" as the open line. Tap "Inertia Creeps" and it plays. Turn upright: Now Playing is still open, upright. Close it, turn sideways with nothing queued: nothing opens.
- **Screens:** `ScreenTour` adds sideways shots: Now Playing, lyrics, the stage, and a DJ-mix queue showing a join.
- **Device:** turn-to-open with Portrait Orientation Lock on and off; the island on either side; screen-on while charging; a car mount (the phone flat then upright mid-drive shouldn't flicker the layout).

## Open questions

1. **Locking the tab pages upright** is a change from today, where they turn. It's recommended above; say if some page should keep turning.
2. **Turn-to-open** is on by default. It could instead sit behind a switch in Settings → Appearance if it surprises anyone.
3. **The stage's 12 seconds** and the screen-on-while-charging default are guesses, worth trying on the counter for a week.
