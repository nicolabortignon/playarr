# Design language

How Playarr looks, on the web and on iOS: every role once, with one name in both apps. A page never holds a raw color, size or radius. When nothing here fits, this page and the shared components change together ([plan 5](plans/2026-11-05-5-ui-consistency.md)).

`scripts/check-design.mjs` keeps it so: the web's `pnpm typecheck` fails on a raw color or an arbitrary text size outside `index.css`, naming the file and line, except where its allow-list says why (the accent choices, a canvas, a cover's pixels, data colors). iOS's `make build` and `make test` run it first and fail the same way on a `Color(red:)`, a `.system(size:)` or a literal `cornerRadius:` outside `PlayarrUI/Theme/`, except where the allow-list says why (an energy chart's bars).

The tokens live in `apps/web/src/index.css` (`@theme` and the `type-*` utilities) and in iOS's `PlayarrUI/Theme/` (`Palette.swift`, `TypeRole.swift`, `Shape.swift`, `Typography.swift`, `IconRole.swift`).

Where the apps differ, the platform is the reason: the tab bar, sheets, SF Symbols, and the system's menus and lists. iOS pages share the screen with system menus, sheets, lists and alerts, so iOS text takes the system's white, and danger, success and warning its red, green and yellow. The web's canvas is all Playarr's, so it uses warm ink and paper.

## Color

| Role | Web | iOS | For |
|---|---|---|---|
| Surface | `bg-ink-900`; raised: `ink-850`, `ink-800`; deepest: `ink-950` | the system's dark background, and system materials for bars and sheets; Playarr's own deepest, `.ink950`, for the iPad's sidebar and side column | pages, panels, menus, the player bar |
| Text | `text-paper` (#ece6dc) | `.paper` (the system's label white) | titles, row titles, paragraphs |
| Secondary text | `text-paper-dim` (#b8b0a3) | `.paperDim` (white 70 %, 85 % with Increase Contrast) | the artist under a title, descriptions |
| Muted | `text-muted` (#857d71) | `.muted` (white 50 %, 65 % with Increase Contrast) | kickers, times, counts, hints |
| Line | `border-line` (paper at 8 %) | `.line` (white at 8 %) | hairlines, panel borders, unselected choices |
| Accent | `accent`, with `accent-ink` on it (from the cover playing, lifted to a relative luminance of at least 0.2 so ink on it and it on the page read at 4.5:1) | `theme.accent` (the same); as text in the system's lists and forms (Settings and the sheets it opens), whose rows are lighter than the page, `theme.listAccent`, lifted further until it reads 4.5:1 on a sheet's row (Playarr's orange already does) | the one primary action on a screen, the playing song, links |
| Danger | `danger` (#f87171), with `ink-950` on it | `.danger` (system red) | errors, Delete |
| Success | `success` (#34d399) | `.success` (system green) | downloaded, saved, connected |
| Warning | `warning` (#fcd34d) | `.warning` (system yellow) | worth a look before going on |

- Over art (a tinted header, a blurred cover), secondary text is `paper-dim`/`.paperDim`, never `muted`.
- Color is never the only signal: an error also says so in words, and a done state has a tick.
- In system lists and forms (iOS Settings and sheets), iOS keeps the system's `.secondary`.

## Type

| Role | Web | iOS | Spec |
|---|---|---|---|
| Page title | `type-page-title` | `.typeRole(.pageTitle)` | Gloock. Web: 40 px on a phone up to 72 px. iOS: the large title, 34 pt |
| Section title | `type-section-title` | `.typeRole(.sectionTitle)` | Gloock. Web: 24 to 28 px. iOS: 22 pt |
| Kicker | `type-kicker` | `.typeRole(.kicker)` | DM Mono 11, capitals, 0.2 em apart, `muted` (`paper-dim` over art) |
| Body | `type-body` | `.typeRole(.body)` | Schibsted Grotesk 15: row titles, paragraphs |
| Small | `type-small` | `.typeRole(.small)` | 13: row subtitles, secondary lines |
| Meta | `type-meta` | `.typeRole(.meta)` | DM Mono 12, figures of one width: times, counts |
| Badge | `type-badge` | `.typeRole(.badge)` | DM Mono 10, capitals, 0.08 em apart |
| Tab | `type-tab` | (the system's) | Schibsted Grotesk 10, 0.025 em apart: the phone tab bar's labels |

- iOS sizes grow with Dynamic Type; spaced capitals close up at the accessibility sizes.
- Big numbers (Stats' headline and tiles) are set in Gloock: monospaced or tabular figures give the comma a full cell ("1 , 792").

## Shape

- **Radii:** covers and thumbnails 4 (`rounded-cover`, `Radius.cover`); a place's icon tile and the accent swatches 6 (`rounded-md`, `Radius.tile`); panels and cards 12 (`rounded-panel`, `Radius.panel`); dialogs and sheets 16 (`rounded-dialog`, `Radius.dialog`); pills and round buttons are full (`rounded-full`, `Capsule`/`Circle`).
- **Cover shadows:** a cover on a shelf or in a grid (`shadow-cover`, `.coverShadow(.shelf)`); a page's own cover and Now Playing's (`shadow-cover-hero`, `.coverShadow(.hero)`).
- **Glow:** a large primary button (Play, Feeling lucky) glows with the accent (web `shadow-glow`; iOS's large primary pill draws the same).

## Headers

- **Page header**, for tabs and library lists (web `PageHeader`, iOS `.pageHeader(_:count:)`): the page's name as a large title, the page's controls (sort, filter, Edit) on the right. The count is in `type-meta` `muted`: beside the title on the web, under it as the navigation subtitle on iOS, where the system's large title (in Gloock) has no room beside it. On iPad, pages opened from the sidebar show their title inline in the bar, as iPadOS chooses; pushed pages show it large.
- **Detail header**, for everything you can play (web and iOS `DetailHeader`): cover · kicker saying what it is · title · one meta line, its parts joined by dots · the action row. On a phone the cover is at most 256 wide (64 % of the screen), above the words, so Play shows on the first screen, down to the iPhone SE. At iPad width the cover (240, or a 192 circle) sits beside the words, aligned to their foot, with the action row under them.
  - An album's meta line: the artist (linked, with their photo) · year · N songs · length, then the format badge. Missing songs show in the list, not here. Where it doesn't fit on one line, the artist goes on a line of its own and the rest under it; it never wraps around the badge.
  - A playlist's meta line: songs · length · sharing ("Shared with everyone", "Shared by Sam"). Its description comes after the action row.
  - An artist: the kicker is "Artist", the meta line their counts ("2 albums · 5 songs"), and their genres go in About's kicker. An artist with a photo of their own gets a band (taller where it would otherwise go under the bar); one without gets a small circle with their best album cover (or a vinyl monogram), not an empty band.
  - Release kinds are named "Album", "EP", "Live album", "Live EP", "Compilation", "DJ mix", "Mixtape", "Loose songs" and "Release" (`releaseKind`). Cards on an artist's own page, in the library or beyond it, say the kind and year ("Album · 1998", "EP · 2019"), and how much of an album you have when it's only part ("8 of 12"), without the artist's name or a badge. A card's second line is `type-small` everywhere, its figures tabular.
- **A title appears once per screen.** A playlist's or mix's own cover drops its name on its page; cards keep it. On iOS the bar shows a detail page's name only once the page's own title has scrolled under it.
- **Sheets on iOS:** pickers open at medium and large heights; close is on the leading side and confirm on the trailing side, each with an icon.
- **Sheets on the iPhone Duo:** on the cover screen a full-height sheet's bar buttons move into the side column, and buttons with words only are dropped. Every bar button in a sheet has an icon (the system's close and confirm roles, or a symbol), so Cancel, Done and Use this are always there.
- **Under the iPhone Duo's column** (and any side inset): backgrounds (the album's wash, an artist's photo, a blurred cover) run under it; rows, words and buttons keep clear of it; sideways strips (shelves, Stats' ranges) scroll under it and stop clear of it.
- **Home greets** the account by name, with its avatar.
- **Names never lose to numbers:** a name and its numbers share a line only when both fit; otherwise the numbers go under the name, on up to two lines (web and iOS `NameAndNumbers`). Stats' big numbers are in the display face.
- **A line of phrases joined by "·"** ("/music · 8 songs · 3 albums") wraps only between them, never inside one (web: each phrase `whitespace-nowrap` or a chip; iOS `Format.wrapsAtDots`).

## Rows, menus and toasts

- **A song row:** [drag handle] · number or cover · title (`type-body`) over subtitle (`type-small`) · time (`type-meta`) · ♥ · ⋯. Every row in a list is the same height (52 with a number, 60 on touch or with a cover; iOS 60 points, 52 in Up next, without list insets); missing songs are grayed in their place. The song playing has an accent title and the equalizer. With a mouse, ♥ and ⋯ show on hover or focus; on touch they always show. On a phone, the queue and Your listening drop the ♥ and put the numbers under the title.
- **Accessible names:** on the web a row's own button is "Play {title}" (or "Pause {title}" for the song playing). Every ⋯ is named for what it's about, never "More actions": "More for “Teardrop”" with curly quotes for a song, an album, a playlist, a mix or a source; without for a person or a place ("More for Sam", "More for Favorites"). On iOS VoiceOver reads the row as one element: its content as the label ("2. Sour Times, 4:14"), what a tap does as the hint ("Plays the song"), and the menu's actions as its own, in the menu's order, the heart last; Move up and Move down are among them where songs can be reordered.
- **One song menu**, in every list: Play next · Add to queue · Add to playlist… · Start radio · Go to album · Go to artist · Show metadata, then after a line the place's own actions: Move up, Move down, then Remove last. Albums and playlists have one menu each too; a card's menu starts with Play and Shuffle.
- **How a menu opens:** ⋯, a right-click, a half-second press on touch, or the menu key. With a mouse, links keep the browser's own menu. Its first item takes the focus only when it was opened from the keyboard (after a tap, no ring around Play next).
- **Escape closes only what's on top:** a menu, then the dialog it's in, then Now Playing, one at a time. A field that uses Escape itself (renaming a playlist) keeps it.
- **Dialogs:** one body padding (20), their buttons in a footer that stays in view while the body scrolls, three widths (448, wide 768, wider 896), the first field focused as they open, and a bottom sheet on a phone.
- **Toasts:** what happened, naming the song in curly quotes ("“Teardrop” plays next", "3 songs play next"), with Undo where it can be taken back. A toast stays 3.5 seconds, an error 7, one with Undo 6, longer while it's hovered or focused (on iOS, while VoiceOver or the pointer is on it). At most three show at once, and a repeat replaces the one before it. On iOS VoiceOver can dismiss one (an action, and the escape gesture), and "Later" is only on toasts that don't go by themselves.
- **Add to playlist** ticks the playlists that already hold all the songs (a dash for some), and adds to several at once. On iOS the tick (green) or dash (gray) sits on the playlist's cover, and Add is in the sheet's bar.
- **Cards:** one width on every shelf (web `SHELF_CARD`, 42 % of a phone's width; iOS `ShelfCard.width`, 160 points). An artist is a circle with the name below: their photo, else their best album cover, else a vinyl monogram.
- **A place to go** (Library's rows, Settings on a phone) is one row: the place's icon on a tile, its name, a chevron (web `NavRow`).
- **A ⋯ menu says its actions in words**, each with its icon: a source's Sync now · Match again · Organize files · Edit · Move up · Move down, then Remove; an account's the same way. Never a row of icon-only buttons for things that change the server.
- **The "on this device" mark** is for songs the listener downloaded (with an album, a playlist, a mix or Favorites). Songs only loaded ahead as you listen get no mark: the mark means you can count on it being there.

### Taking things back

- **Taking something out of a list** happens at once, with Undo in the toast: "Removed “Teardrop” from “Late night”", "Removed “X” from the queue", "Removed “X” from Requests", "Removed “X” from this device", "Stopped sharing “X”".
- **Un-hearting** takes a song out of Favorites: on the Favorites page, where it leaves the list in view, it says so with Undo ("Removed “Teardrop” from Favorites"). Hearted again, with Undo or the heart, a song goes back where it was in Favorites, not to the top: the time it was first favorited goes with it.
- **When the server can't undo it** (a request forgotten can't be asked for again once the album has arrived), the item hides at once and the removal waits until the Undo has gone.
- **Losing something for good asks first**: the question names what goes ("Delete “Late night”?", "Remove 312 songs from this device?", "Remove Sam?"), the words under it say what goes and what stays, and the button is the danger verb ("Delete", "Remove", "Sign out"). On the web it's a dialog with Cancel focused; on iOS 26 a popover from the control that asked (a tap beside it cancels).

## Empty, loading and error

- **Empty:** an icon in a ring, one line in the display face in the app's voice ("No hearts yet.", "Not in your crates."), a quieter line only where the first can't say it all, and the one action that fills the page as a large primary button, with at most one more beside it, outlined (the queue's Jump back in). Where nothing else fills it, that's Feeling lucky. Under a detail header (a playlist with no songs yet) the header takes its smaller cover, so the empty line is on the first screen, down to the iPhone SE.
- **Loading:** skeletons shaped like what they stand for, in the real grid or rows, as many as fill the first screen; never a spinner on its own for a page. iOS Settings' panels, which are system forms, keep the system's spinner.
- **Error:** a whole page that couldn't load says so in the voice (the table below) with the reason, Try again and Back home. A part of a page (a panel, a section, a dialog) says what happened and why in its place, with a small Try again.
- **The lines**, the same on both apps (plan 7 §4). The voice is a record shop's: warm, brief, about the music. A second line only where the first can't say it all; the action is what fills the page.

  | Where | The line | Under it | The action |
  |---|---|---|---|
  | Queue | The deck's empty. | | Feeling lucky · Jump back in |
  | Favorites | No hearts yet. | Heart a song and it lands here. | Jump back in |
  | Downloads | Nothing in the record bag yet. | Download an album, a playlist or a mix, and it plays here with or without a connection. | Browse albums |
  | Downloads, a browser without HTTPS | Downloads need a secure connection. | Browsers only keep music on a device over HTTPS. | |
  | Playlists | Make a playlist for a mood, a trip or a friend. | | New playlist |
  | A playlist of your own | This playlist is waiting for its first song. | Choose Add to playlist… in any song's ⋯ menu. | |
  | Someone else's playlist | Nothing in this playlist yet. | | |
  | Albums | Your crates are empty. | Admin: Add Lidarr or a folder of music, and it shows up here. Member: Music shows up here once an admin adds some. | Admin: Add music |
  | Artists | Nobody on the roster yet. | (as Albums) | (as Albums) |
  | An artist | Nothing by {artist} here yet. | | |
  | Made for you | Your mixes are on their way. | They appear as you listen, and as Playarr learns your library. | Feeling lucky |
  | Stats | No spins in this period yet. | A song counts once it's heard for 30 seconds. | Feeling lucky |
  | Search, nothing in the library | Not in your crates. | Nothing in your library matches “{query}”. Here's what's out there: | (what's beyond the library) |
  | Search, nothing anywhere | Not in your crates. | Nothing in your library or beyond it matches “{query}”. Check the spelling, try fewer words, or pick an artist you have. | New search · artists to try |
  | Search, near matches | Nothing called “{query}”. These come close: | | |
  | Requests, none yet | Ask for an album you don’t have. | Search for it and press Request: it lands in your library once Lidarr finds it. | Search |
  | Requests without Lidarr | Admin: Requests need a Lidarr source. Member: Requests aren’t set up on this server. | Admin: Add one, and you can ask Lidarr for albums you don’t have, right from Search. Member: They need a Lidarr source, which an admin can add. | Admin: Add Lidarr |
  | Requests turned off | Admin: Requests are turned off. Member: Requests are turned off on this server. | Admin: Nobody can ask Lidarr for albums until they’re on again. Member: An admin can turn them on. | Admin: Turn them on |
  | An account that can't request | Your account can’t request albums. | Admin: Allow it for yourself in Settings → Accounts. Member: An admin can allow it. | |
  | A page that failed | The needle skipped. | The reason. | Try again · Back home |
  | A link to nowhere (404) | Side C. This groove is empty. | | Back home |

  Jump back in plays the album heard last; where nothing has been heard yet, Feeling lucky takes its place. The sidebar's empty playlist list stays plain ("No playlists yet."), and a part of a page that failed says what happened, not a line in the voice: clarity first.
- **What isn't possible here** says why and who can change it, never a button that leads nowhere. Requests without Lidarr: an admin reads "Requests need a Lidarr source." with Add Lidarr; everyone else "Requests aren’t set up on this server." and that an admin can add one. Requests turned off, or an account that can't request, read the same way.

## Controls

- **Buttons are actions**, always capsules, labeled in sentence case in Schibsted Grotesk medium, with an optional leading icon. Web: `Button`, `IconButton`. iOS: `.buttonStyle(.pill(_:size:))`.
  - **Primary:** filled with the accent, `accent-ink` label. The one main action on a screen: Play, Feeling lucky, Try again, Save.
  - **Secondary:** a 1 px outline of paper at 15 % (35 % and a paper-at-5 % fill on hover or press), paper label. Shuffle, New mix, Back home, Cancel.
  - **Ghost:** no outline, `paper-dim` label, a paper-at-5 % fill on hover or press. Lesser actions inside a panel.
  - **Danger:** filled with `danger`, `ink-950` label. Delete, Remove account.
- **Sizes:** large 48 (a page's action row, Feeling lucky, an empty page's action), regular 40 (dialogs, panels, error states), small 32 (inside a card or a row, such as Request). Icons are 20, 18 and 16. Whatever the visual size, the tap target is at least 44 (on the web on touch screens, through the `tap-target` utility; on iOS always).
- **States:** disabled at 40 % opacity. Pending says its verb with an ellipsis ("Requesting…"), and is disabled meanwhile. On iOS a field's Save in the bar shows only once there's something new to save, and Return saves too: a grayed-out Save there doesn't read (2.3:1).
- **In a bar,** Edit is in the text color, like the bar's other words (the accent over a page's colors doesn't always read). On the iPad's sidebar the page you're on has its name in the text color over the highlight and its icon in the accent.
- **Icon buttons** are round and always have an accessible name: 48 in an action row (outlined); otherwise 44 to tap on touch and 36 with a mouse on the web, 44 on iOS (plain).
- **Choices** are the mono capitals pills (Albums' sort, Stats' ranges, Transitions, Keep up to, Motion). Web: `Choice`. Selected is filled with paper and an ink label; the rest are outlined with `line` and a `muted` label. A row of choices never wraps on a phone; it scrolls sideways. iOS Settings keeps the system's pickers for these, as its forms do (iOS: `.choice(selected:)` on pages, such as Stats' ranges).
- **Statuses** that do nothing when tapped (Searching, Importing, 42 %, a format) are badges (`type-badge`), not buttons.
- **Text fields:** web `TextField`. The label sits above, the field is 44 tall, radius 12, `ink-850` with a `line` border, and the accent ring when focused.

### The action row

Album, playlist, mix, Favorites and artist pages, on both apps, in this order:

1. **Play:** primary, large. As wide as its widest label (Play, Pause, Resume), so playing or pausing moves nothing.
2. **Shuffle:** secondary, large.
3. **The page's own action**, when it has one (New mix; Request the rest of a partial album): secondary, large.
4. **Download:** an outlined icon button whose ring fills as songs arrive and ends in a tick in `success`. Not on artist pages.
5. **⋯:** an outlined icon button.

The row never wraps, and doesn't scroll (that would clip Play's glow). When it doesn't fit, Shuffle and then the page's action drop their words and become icon buttons, keeping their names; last, the gaps close up and Play drops its icon, but keeps its word. At its narrowest the row is 330 wide. Only at iOS's accessibility text sizes, where even that doesn't fit, does it scroll sideways, unclipped.

## Icons

- **Sizes by role.** A control sizes its own icon (`Button`'s `icon`, a `Menu` item's), so a page hands it the glyph alone. iOS sets symbols by text style, so they grow with Dynamic Type; the system's menus, lists and bars size their own. A glyph inside something of a fixed size (a play button's circle, a badge, a cover) takes its role's size on iOS too (`Font.icon(_:)`, `IconRole`), so it doesn't outgrow its shape.

  | Role | Size | Web | For |
  |---|---|---|---|
  | Badge | 12 | `size-3` | inside a badge: a status's spinner, "Not found on MusicBrainz" |
  | Small text | 14 | `size-3.5` | beside a line of `type-small` or `type-meta`: an inline error, "Disc 1", a link's ↗, the on-this-device mark |
  | Menu | 16 | `size-4` | menu items, small buttons (32), a place row's chevron, the play glyph on a row's cover |
  | Toolbar | 18 | `size-4.5` | regular buttons (40), a row's ♥, ⋯ and handle, the sidebar's and Settings' places, the player bar |
  | Icon button | 20 | `size-5` | round icon buttons, large buttons (48) and the action row, Now Playing's top bar, a place's tile |
  | Tab | 22 | `size-5.5` | the phone's tab bar |
  | State | 24 | `size-6` | an empty or error state's ring, the search field, Now Playing's ♥ |
  | Transport | 28, 32 | `size-7`, `size-8` | Now Playing's previous and next; play and pause in its 72 circle |

- **One stroke:** lucide's own 2 on the web (no page sets `strokeWidth`); SF Symbols' regular weight on iOS. Play, pause, previous and next are filled (`fill-current`, as iOS's `.fill` symbols), and the heart fills for a favorite.
- **One glyph per concept**, wherever an app shows it, and the same picture in both apps unless the note says why. The web uses lucide's current names, not its old aliases (`House`, not `Home`; `MicVocal`, not `Mic2`; `Ellipsis`, `LoaderCircle`, `CircleAlert`, `Trash`, `RotateCcwClock`). "iOS to align" marks a difference that isn't on purpose.

  | Places | Web (lucide) | iOS (SF Symbols) | Note |
  |---|---|---|---|
  | Home | `House` | `house` | |
  | Search | `Search` | `magnifyingglass` | |
  | Library (the phone's tab) | `LibraryBig` | `books.vertical` | |
  | Queue | `List` | `list.bullet` | |
  | Made for you | `Sparkles` | `sparkles` | |
  | Artists | `MicVocal` | `music.mic` | |
  | Albums | `Disc3` | `square.stack` | iOS: Music's own picture for albums |
  | Favorites | `Heart` | `heart` | |
  | Downloads | `ArrowDownToLine` | `arrow.down.to.line` | |
  | Requests | `Binoculars` | `binoculars` | |
  | Playlists, a playlist | `ListMusic` | `music.note.list` | |
  | Your listening | `ChartColumn` | `chart.bar` | |
  | Settings | `Settings` | `gearshape` | |
  | Your account | the avatar, else `UserRound` | `person.crop.circle` | |

  | Playing | Web | iOS | Note |
  |---|---|---|---|
  | Play, pause | `Play`, `Pause` | `play.fill`, `pause.fill` | |
  | Previous, next | `SkipBack`, `SkipForward` | `backward.fill`, `forward.fill` | iOS: Music's, without the bar |
  | Shuffle | `Shuffle` | `shuffle` | |
  | Repeat, repeat one | `Repeat`, `Repeat1` | `repeat`, `repeat.1` | |
  | Lyrics | `Quote` | `quote.bubble` | |
  | Queue, Open queue | `List` | `list.bullet` | |
  | Open Now Playing | `Maximize2` | (a tap on the mini player) | |
  | Close Now Playing | `ChevronDown` | `chevron.down` | |
  | Volume | `Volume1`, `Volume2`, `VolumeX` | `speaker.wave.1.fill`, `speaker.wave.2.fill`, `speaker.slash.fill` | |
  | AirPlay, output | none | the system's AirPlay button (`AVRoutePickerView`), in the row under Now Playing's transport on a phone | browsers offer no picker |
  | Sleep timer | `Moon` | `moon` | |
  | Turn off the timer | `AlarmClockOff` | `alarm.slash` (iOS 27; `moon.zzz` on iOS 26, which has no alarm-off symbol) | |
  | Loading | `LoaderCircle`, spinning | the system's spinner (the Requests pill's too) | |
  | The song playing | the equalizer (`Equalizer`) | `waveform`, moving | each app's own animation |
  | Feeling lucky | `Twinkle` (Playarr's three stars) | `Twinkle` (the same drawing) | |
  | Jump back in | `Undo2` | `arrow.uturn.backward` | |
  | New record (Stats) | `Flag` | `flag` | |
  | Sleep well | `Moon` | `moon` | |
  | Edit mix points | `AudioWaveform` | `waveform` | |
  | A transition | `Blend` | `circle.dotted.and.circle` | the nearest SF Symbol to Blend's overlapping circles |

  | Songs and lists | Web | iOS | Note |
  |---|---|---|---|
  | ⋯ ("More for “Teardrop”") | `Ellipsis` | `ellipsis` | |
  | Play next | `ListStart` | `text.line.first.and.arrowtriangle.forward` | |
  | Add to queue | `ListEnd` | `text.append` | |
  | Add to playlist…, Save as playlist | `ListPlus` | `text.badge.plus` | a playlist itself stays `music.note.list` |
  | Start radio | `Radio` | `dot.radiowaves.left.and.right` | |
  | Go to album | `Disc3` | `square.stack` | as Albums |
  | Go to artist | `MicVocal` | `music.mic` | |
  | Show metadata | `Info` | `info.circle` | |
  | Favorite | `Heart`, filled when it is | `heart`, `heart.fill`; `heart.slash` for Remove from Favorites in the menu | iOS: the menu has it for VoiceOver |
  | Move up, down | `ArrowUp`, `ArrowDown` | `arrow.up`, `arrow.down` | |
  | Drag to reorder | `GripVertical` | the system's reorder control | |
  | Remove (from a list) | `X` | `xmark` | |
  | Delete (for good), remove an account or a source | `Trash` | `trash` | |
  | Rename, Edit | `Pencil` | `pencil` | |
  | New cover… | `Palette` | `paintpalette` | |
  | Share with everyone | `Users` | `person.2` | |
  | Stop sharing | `Lock` | `lock` | |
  | A disc's heading | `Disc3` | `opticaldisc` | |
  | Reshuffle, Other suggestions, a cover's Shuffle | `Dices` | `dice` | |

  | Downloads, requests and search | Web | iOS | Note |
  |---|---|---|---|
  | Download | `ArrowDownToLine` | `arrow.down.to.line` | |
  | Downloading | a ring filling in the accent | the ring, with `arrow.down` in it | |
  | Downloaded | `CircleCheck` in `success` | `checkmark` in `success`, in the ring | |
  | On this device (a song) | `CircleArrowDown` in the accent | `arrow.down.circle.fill` in the accent | iOS: filled reads better at caption size |
  | Space on this device | `HardDrive` | `internaldrive` | |
  | Request | `Binoculars` | `binoculars`, in the button's own color (black on Request's accent) | |
  | Search again later | `Clock` | `clock` | |
  | A request that failed | `TriangleAlert` | `exclamationmark.triangle` | |
  | In your library, Open in your library | `Check`, `ArrowRight` | `checkmark`, `arrow.right` | |
  | A recent search | `RotateCcwClock` | none yet | |
  | Nothing found | `SearchX` | none yet | |

  | Settings and admin | Web | iOS | Note |
  |---|---|---|---|
  | Playback, Appearance | `AudioLines`, `Palette` | none | iOS: the system's list, without icons |
  | Sources, Accounts | `FolderOpen`, `Users` | none | |
  | Made for you, Analysis | `Sparkles`, `AudioWaveform` | none | |
  | Requests, Updates | `Binoculars`, `CircleArrowUp` | none | |
  | Tune your mixes | `SlidersHorizontal` | `slider.horizontal.3` | |
  | Lidarr, a folder, a remote folder | `Server`, `Folder`, `Network` | `server.rack`, `folder`, `network` | |
  | Sync now | `RefreshCw` | `arrow.triangle.2.circlepath` | |
  | Match again | `ScanSearch` | `text.magnifyingglass` | |
  | Organize files | `FolderTree` | `folder.badge.gearshape` | SF Symbols has no folder tree |
  | Edit (a source) | `Pencil` | `pencil` | |
  | Fix the names | `PencilLine` | `pencil.line` | |
  | Add account | `UserPlus` | `person.badge.plus` | |
  | New setup code | `KeyRound` | `key` | |
  | Devices | `Smartphone` | (a section) | |
  | Sign out | `LogOut` | `rectangle.portrait.and.arrow.right` | |
  | Copy | `Copy` | `doc.on.doc` | |
  | Open on MusicBrainz | `ExternalLink` | `arrow.up.right.square` | |
  | Add music (an empty library) | `FolderPlus` | none | |

  | Everywhere | Web | iOS | Note |
  |---|---|---|---|
  | New (playlist, source) | `Plus` | `plus` | |
  | Try again, Reload, Check for updates | `RotateCw` | `arrow.clockwise` | |
  | Do it again (New mix, Sync now, ask Lidarr again) | `RefreshCw` | `arrow.triangle.2.circlepath` | |
  | A recent search | `RotateCcwClock` | `clock.arrow.circlepath` | |
  | Undo | `Undo2` | `arrow.uturn.backward` | iOS also has it for Jump back in |
  | Error, warning | `CircleAlert`, `TriangleAlert` | `exclamationmark.circle`, `exclamationmark.triangle` | |
  | Done, chosen | `Check` | `checkmark` | |
  | Close | `X` | `xmark` (the system's close) | |
  | Back, opens a page | `ChevronLeft`, `ChevronRight` | the system's | |
  | Expand, collapse | `Plus`, `Minus` | `plus`, `minus` | |
  | Back home | none | `house` | |

## Patterns

- **Recent searches** (on the empty search page, above what to try): the last eight, newest first, kept per account on the device, each with the history icon, searching again on a tap, and × to remove it; Clear removes them all. Both say so with Undo ("Removed “daft punk” from recent searches", "Cleared recent searches"). A search counts once a result is opened or played, Enter is pressed, or the words sit still for 2.5 s; never one letter, and words that only extend the newest search replace it.
- **Beyond the library**, under the library's results whenever there's anything: "Not in your library" with a kicker naming where it's from ("Lidarr · MusicBrainz · Deezer"), and Request only where requesting is possible.
- **Settings:** This device · Your account · Server (members see Your account before Server, with "Only an admin can change these."; a server panel opens read-only for them, saying "Only an admin can change these settings.", and Analysis "Analyses can be started by an admin."). Where the page has room (web: the page at least `page-lg`, a 1024 px window), a column of the groups sits beside the open panel, under the Settings title: the groups' names as kickers, each panel's icon and name, the open one lit as the sidebar lights the page you're on, the version at its foot. Every panel is always in view: never a strip that scrolls sideways. The panel's scope is the line above it. Narrower (a phone, a narrow window), the same groups are a list, a line under each saying what it's for and the version at the foot; each panel has a back link to Settings.
- **Keyboard shortcuts** show only where there's a keyboard (a fine pointer, or a key pressed outside a field). On the web `?` opens them over any page as a record sleeve: Side A · Playing and Side B · Getting around, numbered A1…, dotted leaders to the keys in `type-badge` keycaps, the two sides side by side from 1024 px, a shared modifier written once ("Shift + ← or →"). iPadOS has its own ⌘ overlay, so iOS lists them there instead.
- **The idle player bar** (desktop and tablet, nothing playing): the album heard last under the kicker "Heard last", Resume as the primary button and Feeling lucky beside it; with no history, "Nothing playing" and Feeling lucky.
- **The iPad's player bar** steps aside while the screen's keyboard is up, as the phone's tab bar and mini player do; a long press on its song opens the one song menu for the song playing.
- **Beside Feeling lucky on Home:** where a mini player shows (a phone with a song queued), what comes next ("Up next" over the next song's title, beside its cover), opening the queue, never a second play and pause; nothing when nothing comes next. Without a mini player (iPad, desktop), the listening button.
- **Now Playing on a phone:** under the transport, one row of Lyrics · AirPlay · Up next, as Apple Music has them; Lyrics and Up next each take the cover's place, one at a time, lit while they do.
- **The side column** (web from 1280 px, the iPad at regular width): Queue and Lyrics beside any page, 340 wide on `ink-950`, the queue headed "Up next" with its counts in `type-meta` and its rows on two lines (the length beside the artist, whose name gives way first). A page lays itself out by its own width, not the window's (web `page-lg`, `page-xl`, `page-2xl`), so it narrows when the column opens.
- **Fixed layers on the web:** iPhone Safari paints its translucent bars in the color of the topmost fixed element at each edge, so that element has a solid background (the tab bar, Now Playing), and anything without a color of its own (the film grain) stays below them (z-index under 40).

## Moments

The small delights of [plan 7](plans/2026-11-05-7-delight.md): quiet, on-theme, gone if you don't look for them. Under Reduce Motion the ones that move don't start at all (shortening a loop would only make it flicker); what they say still shows.

- **A cover's own color while it loads:** every cover's space takes the album's `coverColor` from the server instead of gray, and the accent its `coverAccent` at once (orange when the server found none to give; read from the image only when the server hasn't read it).
- **Home greets by the time of day:** "Morning, Alex." (5 to 12), "Afternoon" (12 to 17), "Evening" (17 to 22), "Late night" (22 to 5), the parts of the day Vibes of the hour uses.
- **The end of a song:** from ten seconds before the next song takes over, the player's second line says "Next: Teardrop"; with DJ mix about to blend them, "Mixing into Teardrop on the next bar" during the last bar, then "Mixing into Teardrop" while it does. Not when the sleep timer stops after this song.
- **Feeling lucky** deals covers from behind the button while it picks: up to four already loaded fan open clockwise, 70 ms apart, like a hand of cards, and the first song's is dealt last, on top. Once it's been seen a moment, the others turn on under it and the stack slips back down behind the button: about a second and a half in all. Nothing shows below the button's top edge, so they come out from behind it even when it's outlined. The songs are asked for, and the covers loaded, as soon as a press looks likely (the pointer comes over the button, a finger touches it, or it takes the focus), so the first song's goes out in the same rhythm as the rest and the music starts at once; when they're not back yet, the fan waits up to 300 ms for them before dealing. The music never waits for it.
- **A finished download:** the ring closes into its tick, then a toast: "“Mezzanine” is on this device" (on iOS, "this iPhone" or "this iPad").
- **The sleep timer's end:** Now Playing shows a moon and "Sleep well" for 4 seconds, then rests dark until it's touched; with Now Playing closed, a toast says it instead.
- **Stats:** the headline counts up over 1.4 seconds (the real number is what's read aloud); a streak still going that equals the longest gets a "New record" pill with a flag; the year in review slides up like a sleeve.
- **Now Playing's cover:** paused, it settles back (smaller, its shadow softer) and lifts again on Play; with a mouse it tilts up to 2° toward the pointer, catching a faint sheen; behind it, the backdrop drifts through the cover's colors, 40 seconds each way.
- **The energy strip** sits under Now Playing's seek bar for an analyzed song: phrases played in the accent, the rest fainter, lit to where a drag would land, and it seeks where it's pressed. Its 20 points stay reserved for songs without one, so the controls never jump.
- **Covers move from where they came from:** an album's cover grows from the card pressed into its page, and shrinks back into it going back; the player's cover grows into Now Playing's, and back as it closes. Only the cover moves; the rest of the page changes at once underneath (web: the View Transitions API, where the browser has it; iOS: the zoom navigation transition).
- **Play and Pause are one shape:** the triangle splits into the two bars, and back, over 200 ms, from wherever it is when pressed again.
- **The accent changes on the beat:** it glides to the new song's color over one beat of that song (0.3 to 1.2 s; 0.8 s when its tempo isn't known).
- **The bars keep time:** the equalizer shows the bass, the middle and the treble of what's heard, each landing on the song's beat (the treble on half-beats), and settles when the music stops. Where the app can't hear the music (phones, without Web Audio) or the song has no steady beat, they loop as before.
- **Now Playing breathes:** a glow of the accent behind the cover swells on each bar's downbeat, a little deeper in busier phrases: a quarter of the accent at most, never a flash, and only while playing.
- **A DJ blend you can see:** while two songs blend, the player's cover shows both, the one leaving behind at the top left and the one arriving in front at the bottom right, each as present as its song is in the mix; Now Playing says "Mixing into Teardrop" for the whole blend.
- **Reordering:** the song dragged lifts (a shadow, 3 % larger) and the others part over 250 ms.

## Motion

- **Fast, 150 ms:** a press, a hover, a color changing (Tailwind's default; `Motion.fast`).
- **Standard, 250 ms:** things that move or change size: menus, toasts, rows (`duration-250`, `Motion.standard`).
- **Sheets and dialogs** spring in: web Now Playing at damping 34, stiffness 320, mass 0.9, and dialogs at damping 32, stiffness 380; iOS sheets use the system's spring.
- **Slow on purpose:** covers fade in over 500 to 700 ms, and the accent glides to a new song's color over one beat of it (0.3 to 1.2 s; 0.8 s without a tempo).
- **Covers growing** (Moments): 360 ms into an album page and 420 ms into Now Playing, easing (0.2, 0, 0, 1), Now Playing's sheet fading in around the cover over 320 ms.
- **Reduce Motion:** the system setting, or Settings → Appearance → Motion, collapses every duration to nothing.

## Words

- **Songs, not tracks**, in every count and heading: "3 songs · 17 min", "Show all 12 songs", "Cleared 12 songs from the queue". "Track" stays only where it's the tag's own name (the track number in Track details, ReplayGain's "track gain").
- **Search** fields say "Search music".
- **Favorites** is the noun: "Favorites", "Add “X” to Favorites", "Remove “X” from Favorites". "Songs you love" can stay as flavor in a kicker.
- **Made for you** is the place for mixes (the nav, Home's shelf, Settings); one of them is a **mix** ("New mix"), and "mix" means nothing else (a playlist's other suggestions are "Other suggestions").
- **Pending verbs** end with an ellipsis: "Saving…", "Adding…", "Deleting…", "Trying again…". Statuses aren't pending verbs and have none: a request is "Searching", "Importing".
- **Retry** is always "Try again". "Reload" is only for loading a new version of the app.
- **Remove** takes something out of a list (the queue, a playlist, Requests, this device, Favorites); **Delete** destroys it (a playlist). Removing an account is "Remove", and its dialog says the history goes with it.
- **Actions** are sentence case ("Play", "Shuffle", "Feeling lucky"). Mono capitals are for choices (Albums' sort, Stats' ranges) and kickers.
- **Spelling:** American (decided 2026-11-06): color, favorite, gray, analyzed, leveled, organize, neighbors.
- **Badges** say only what's worth saying: "MP3", "FLAC", and the details when they're out of the ordinary ("MP3 · 128 kbps", "FLAC · 24/96"). Ordinary is 256 kbps or more, or CD quality (16-bit at 44.1 or 48 kHz). The full details are in the badge's title.
- **Search** says when results aren't exact: "Nothing called “mezanine”. These come close:". With nothing in the library, "Not in your crates." and "Here's what's out there:"; with nothing anywhere, what to try (the spelling, fewer words) and New search.
- **Invites:** an account not set up yet is "Invited · not set up yet", with Copy invite link and New code. A link can only be copied on the device that made it (the server keeps only its fingerprint); elsewhere it's "New invite link for Sam?" with "Make a new link", which stops the old one working.
- **Accent means action:** text in the accent can be tapped.
