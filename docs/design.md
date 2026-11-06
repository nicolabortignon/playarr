# Design language

How Playarr looks, on the web and on iOS: every role once, with one name in both apps. A page never holds a raw color, size or radius. When nothing here fits, this page and the shared components change together ([plan 5](plans/2026-11-05-5-ui-consistency.md)).

The tokens live in `apps/web/src/index.css` (`@theme` and the `type-*` utilities) and in iOS's `PlayarrUI/Theme/` (`Palette.swift`, `TypeRole.swift`, `Shape.swift`, `Typography.swift`).

Where the apps differ, the platform is the reason: the tab bar, sheets, SF Symbols, and the system's menus and lists. iOS pages share the screen with system menus, sheets, lists and alerts, so iOS text takes the system's white, and danger, success and warning its red, green and yellow. The web's canvas is all Playarr's, so it uses warm ink and paper.

## Color

| Role | Web | iOS | For |
|---|---|---|---|
| Surface | `bg-ink-900`; raised: `ink-850`, `ink-800`; deepest: `ink-950` | the system's dark background, and system materials for bars and sheets | pages, panels, menus, the player bar |
| Text | `text-paper` (#ece6dc) | `.paper` (the system's label white) | titles, row titles, paragraphs |
| Secondary text | `text-paper-dim` (#b8b0a3) | `.paperDim` (white 70 %, 85 % with Increase Contrast) | the artist under a title, descriptions |
| Muted | `text-muted` (#857d71) | `.muted` (white 50 %, 65 % with Increase Contrast) | kickers, times, counts, hints |
| Line | `border-line` (paper at 8 %) | `.line` (white at 8 %) | hairlines, panel borders, unselected choices |
| Accent | `accent`, with `accent-ink` on it (from the cover playing, lifted to a relative luminance of at least 0.2 so ink on it and it on the page read at 4.5:1) | `theme.accent` (the same) | the one primary action on a screen, the playing song, links |
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

- iOS sizes grow with Dynamic Type; spaced capitals close up at the accessibility sizes.
- Big numbers (Stats' headline and tiles) are set in Gloock: monospaced or tabular figures give the comma a full cell ("1 , 792").

## Shape

- **Radii:** covers and thumbnails 4 (`rounded-cover`, `Radius.cover`); panels and cards 12 (`rounded-panel`, `Radius.panel`); dialogs and sheets 16 (`rounded-dialog`, `Radius.dialog`); pills and round buttons are full (`rounded-full`, `Capsule`/`Circle`).
- **Cover shadows:** a cover on a shelf or in a grid (`shadow-cover`, `.coverShadow(.shelf)`); a page's own cover and Now Playing's (`shadow-cover-hero`, `.coverShadow(.hero)`).
- **Glow:** a large primary button (Play, Feeling lucky) glows with the accent (web `shadow-glow`; iOS's large primary pill draws the same).

## Headers

- **Page header**, for tabs and library lists (web `PageHeader`, iOS `.pageHeader(_:count:)`): the page's name as a large title, the page's controls (sort, filter, Edit) on the right. The count is in `type-meta` `muted`: beside the title on the web, under it as the navigation subtitle on iOS, where the system's large title (in Gloock) has no room beside it. On iPad, pages opened from the sidebar show their title inline in the bar, as iPadOS chooses; pushed pages show it large.
- **Detail header**, for everything you can play (web and iOS `DetailHeader`): cover · kicker saying what it is · title · one meta line, its parts joined by dots · the action row. On a phone the cover is at most 256 wide (64 % of the screen), above the words, so Play shows on the first screen, down to the iPhone SE. At iPad width the cover (240, or a 192 circle) sits beside the words, aligned to their foot, with the action row under them.
  - An album's meta line: the artist (linked, with their photo) · year · N songs · length, then the format badge. Missing songs show in the list, not here. Where it doesn't fit on one line, the artist goes on a line of its own and the rest under it; it never wraps around the badge.
  - A playlist's meta line: songs · length · sharing ("Shared with everyone", "Shared by Sam"). Its description comes after the action row.
  - An artist: the kicker is "Artist", the meta line their counts ("2 albums · 5 songs"), and their genres go in About's kicker. An artist with a photo of their own gets a band (taller where it would otherwise go under the bar); one without gets a small circle with their best album cover (or a vinyl monogram), not an empty band.
  - Release kinds are named "Album", "EP", "Live album", "Live EP", "Compilation", "DJ mix", "Mixtape", "Loose songs" and "Release" (`releaseKind`). Cards on an artist's own page say only the kind and year ("EP · 2019"), without a badge.
- **A title appears once per screen.** A playlist's or mix's own cover drops its name on its page; cards keep it. On iOS the bar shows a detail page's name only once the page's own title has scrolled under it.
- **Under the iPhone Duo's column** (and any side inset): backgrounds (the album's wash, an artist's photo, a blurred cover) run under it; rows, words and buttons keep clear of it; sideways strips (shelves, Stats' ranges) scroll under it and stop clear of it.
- **Home greets** the account by name, with its avatar.
- **Names never lose to numbers:** a name and its numbers share a line only when both fit; otherwise the numbers go under the name, on up to two lines (web and iOS `NameAndNumbers`). Stats' big numbers are in the display face.

## Rows, menus and toasts

- **A song row:** [drag handle] · number or cover · title (`type-body`) over subtitle (`type-small`) · time (`type-meta`) · ♥ · ⋯. Every row in a list is the same height (52 with a number, 60 on touch or with a cover); missing songs are grayed in their place. The song playing has an accent title and the equalizer. With a mouse, ♥ and ⋯ show on hover or focus; on touch they always show. On a phone, the queue and Your listening drop the ♥ and put the numbers under the title.
- **Accessible names:** a row's own button is "Play {title}" (or "Pause {title}" for the song playing); its ⋯ is "More for {title}".
- **One song menu**, in every list: Play next · Add to queue · Add to playlist… · Start radio · Go to album · Go to artist · Show metadata, then after a line the place's own actions: Move up, Move down, then Remove last. Albums and playlists have one menu each too; a card's menu starts with Play and Shuffle.
- **How a menu opens:** ⋯, a right-click, a half-second press on touch, or the menu key. With a mouse, links keep the browser's own menu. Escape closes only the menu.
- **Toasts:** what happened, naming the song in curly quotes ("“Teardrop” plays next", "3 songs play next"), with Undo where it can be taken back. A toast with Undo stays 6 seconds, longer while it's hovered or focused. At most three show at once, and a repeat replaces the one before it.
- **Add to playlist** ticks the playlists that already hold all the songs (a dash for some), and adds to several at once.
- **Cards:** one width on every shelf (web `SHELF_CARD`). An artist is a circle with the name below: their photo, else their best album cover, else a vinyl monogram.
- **The "on this device" mark** is for songs the listener downloaded (with an album, a playlist, a mix or Favorites). Songs only loaded ahead as you listen get no mark: the mark means you can count on it being there.

### Taking things back

- **Taking something out of a list** happens at once, with Undo in the toast: "Removed “Teardrop” from “Late night”", "Removed “X” from the queue", "Removed “X” from Requests", "Removed “X” from this device", "Stopped sharing “X”".
- **When the server can't undo it** (a request forgotten can't be asked for again once the album has arrived), the item hides at once and the removal waits until the Undo has gone.
- **Losing something for good asks first**, in a dialog: the question names what goes ("Delete “Late night”?", "Remove 312 songs from this device?", "Remove Sam?"), the words under it say what goes and what stays, Cancel has the focus, and the button is the danger verb ("Delete", "Remove", "Sign out").

## Empty, loading and error

- **Empty:** an icon in a ring, one line in the display face in the app's voice ("No hearts yet.", "Not in your crates."), a quieter line only where the first can't say it all, and the one action that fills the page as a large primary button. Where nothing else fills it, that's Feeling lucky.
- **Loading:** skeletons shaped like what they stand for, in the real grid or rows, as many as fill the first screen; never a spinner on its own for a page.
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
  | Made for you | Your mixes are on their way. | They appear as you listen, and as Playarr learns your library. | |
  | Stats | No spins in this period yet. | A song counts once it's heard for 30 seconds. | |
  | Search, nothing at all | Not in your crates. | Nothing in your library matches “{query}”. | What's out there (beyond the library), or Clear search |
  | Search, near matches | Nothing called “{query}”. Close: | | |
  | A page that failed | The needle skipped. | The reason. | Try again · Back home |
  | A link to nowhere (404) | Side C. This groove is empty. | | Back home |

  The sidebar's empty playlist list stays plain ("No playlists yet."), and a part of a page that failed says what happened, not a line in the voice: clarity first.
- **What isn't possible here** says why and who can change it, never a button that leads nowhere. Requests without Lidarr: an admin reads "Requests need a Lidarr source." with Add Lidarr; everyone else "Requests aren’t set up on this server." and that an admin can add one. Requests turned off, or an account that can't request, read the same way.

## Controls

- **Buttons are actions**, always capsules, labeled in sentence case in Schibsted Grotesk medium, with an optional leading icon. Web: `Button`, `IconButton`. iOS: `.buttonStyle(.pill(_:size:))`.
  - **Primary:** filled with the accent, `accent-ink` label. The one main action on a screen: Play, Feeling lucky, Try again, Save.
  - **Secondary:** a 1 px outline of paper at 15 % (35 % and a paper-at-5 % fill on hover or press), paper label. Shuffle, New mix, Back home, Cancel.
  - **Ghost:** no outline, `paper-dim` label, a paper-at-5 % fill on hover or press. Lesser actions inside a panel.
  - **Danger:** filled with `danger`, `ink-950` label. Delete, Remove account.
- **Sizes:** large 48 (a page's action row, Feeling lucky, an empty page's action), regular 40 (dialogs, panels, error states), small 32 (inside a card or a row, such as Request). Icons are 20, 18 and 16. Whatever the visual size, the tap target is at least 44 (on the web on touch screens, through the `tap-target` utility; on iOS always).
- **States:** disabled at 40 % opacity. Pending says its verb with an ellipsis ("Requesting…"), and is disabled meanwhile.
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

- **Sizes by role:** in a menu 16 (web `size-4`), in a toolbar 18 (`size-4.5`), an icon button 20 (`size-5`), a tab 22 (`size-5.5`). iOS uses the same points, growing with Dynamic Type.
- **One stroke:** lucide's 2 on the web; SF Symbols' regular weight on iOS.
- **One glyph per concept** on each platform (plan 5 §6 completes the map):

| Concept | Web (lucide) | iOS (SF Symbols) |
|---|---|---|
| Play next | `ListStart` | `text.line.first.and.arrowtriangle.forward` |
| Add to queue | `ListEnd` | `text.append` |
| Add to playlist | `ListPlus` | `music.note.list` |
| Start radio | `Radio` | `dot.radiowaves.left.and.right` |
| Go to album | `Disc3` | `square.stack` |
| Go to artist | `Mic2` | `music.mic` |
| Show metadata | `Info` | `info.circle` |
| Move up, down | `ArrowUp`, `ArrowDown` | `arrow.up`, `arrow.down` |
| Remove (from a list) | `X` | `xmark` |
| Delete (for good) | `Trash2` | `trash` |

## Motion

- **Fast, 150 ms:** a press, a hover, a color changing (Tailwind's default; `Motion.fast`).
- **Standard, 250 ms:** things that move or change size: menus, toasts, rows (`duration-250`, `Motion.standard`).
- **Sheets and dialogs** spring in: web Now Playing at damping 34, stiffness 320, mass 0.9, and dialogs at damping 32, stiffness 380; iOS sheets use the system's spring.
- **Slow on purpose:** covers fade in over 500 to 700 ms, and the accent follows a new cover over 0.8 s.
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
- **Accent means action:** text in the accent can be tapped.
