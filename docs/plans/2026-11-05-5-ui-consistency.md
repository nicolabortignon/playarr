# Plan 5: One design language

Proposed 2026-11-05 from a review of every screen of both apps (how, below); not agreed yet. Written with [plan 6, UX](2026-11-05-6-ux-flows.md) and [plan 7, delight](2026-11-05-7-delight.md). Sections 3 and 4 change what the App Store screenshots show, so they're worth doing before those are taken (phase 11, Task 12).

**Goal:** the same thing looks, sits and reads the same everywhere, on every page and in both apps. A song row, a Play button, a page header, an empty page or a removal is designed once, written down once and built once per platform. Where iOS and the web differ, the platform is the reason (the tab bar, sheets, SF Symbols), never that the same thing was built twice.

**The rule:** a new screen uses the shared components; when none fits, the component and `docs/design.md` change together. Pages never hold raw colors, sizes or radii.

## How the screens were reviewed

- **iOS:** `pnpm ios:screens` (the `ScreenTour` UI test on the demo library): iPhone upright (23 screens), sideways (8) and iPad (13). The iPhone Duo set needs the iOS 27.2 Duo runtime, which this Mac doesn't have.
- **Web:** no tour exists yet (section 10), so one was prototyped. The repo's server ran with an empty data folder and a generated library: 20 real albums' track lists from MusicBrainz and covers from the Cover Art Archive, as silent MP3s with full tags. It was seeded with two accounts, a pending invite, five playlists and four weeks of plays. Safari then walked it on the iPhone 17 Pro and iPad Pro 13" simulators through `scripts/ios-sim`: the phone layout (50 screens) and the desktop layout at 1032 px (47).
- Two code reads, one per app, counted the variants named below. Treat the counts as lower bounds.
- Not seen: analysis was off (no ffmpeg on this Mac, silent audio), so DJ mix, even volume, Stats for nerds and mix points weren't on screen. First run (setup mode) is plan 4's.

## 1. Write the design language down — S — done 2026-11-06

*Done: [`docs/design.md`](../design.md) lists every role with its web and iOS name. The web gained `danger`, `success` and `warning`, the `type-*` roles, `rounded-cover`/`-panel`/`-dialog` and `shadow-cover`/`-cover-hero`; iOS gained `Theme/Palette.swift` (`.paper`, `.paperDim`, `.muted`, `.line`, `.danger`, `.success`, `.warning`), `TypeRole.swift` (`.typeRole(_:)`) and `Shape.swift` (`Radius`, `.coverShadow(_:)`, `Motion`). Every raw red, green and amber on both apps now uses a role, covers and thumbnails share the 4 radius, and covers use the two shadows. iOS's old `.muted` (white at 70 %) is now `.paperDim`; `.muted` is the quieter level, as on the web.*

There is no design doc. The tokens live in `apps/web/src/index.css` (`ink-*`, `paper`, `paper-dim`, `muted`, `line`, `accent`) and in iOS's `Theme/`. iOS has no ink or paper tokens: secondary text is white at 70% in cards and rows (`Muted.swift:12`), and the system `.secondary` on detail pages (`AlbumView.swift:115`, `ArtistView.swift:85`, `PlaylistView.swift:112`).

- `docs/design.md`, one page, covering:
  - color roles: surface, text, secondary text, muted, line, accent, danger, success;
  - the type scale by role: page title, section title, kicker, row title 15, row subtitle 13, meta, badge;
  - radii: covers and thumbnails 4, panels 12, dialogs 16, pills full;
  - two cover shadows;
  - icon sizes by role: menu 16, toolbar 18, icon button 20, tab 22;
  - motion: fast 150 ms, standard 250 ms, the sheet spring;
  - the icon map (section 6) and the word list (section 7).
- Each role has a web token and an iOS token of the same name. iOS gains `paper`, `paperDim`, `muted`, `danger` and `success`.
- **Done when** both apps' theme files name the same roles, and the doc lists them.

## 2. One set of buttons and controls — M — done 2026-11-06

*Done: the web as noted below; on iOS one `.pill(_:size:)` style (primary, secondary, ghost, danger; 48, 40, 32, never under 44 to tap), `.outlinedIcon`, `.choice(selected:)` and `StatusBadge` replace `Pill` and the old `.pill()`, and every action is in sentence case.*

- **Web: no shared components.** There's no `Button`, `IconButton` or `Input`. Nine button recipes are copied between files: the hero Play in `Album.tsx:89`, `Artist.tsx:159`, `Playlist.tsx:131`, `Favorites.tsx:42` and `Mix.tsx:66`; the small outline button in `Section.tsx:178`, `Mixes.tsx:16` and `AccountsPanel.tsx:17`; and seven more.
- **Web: dialogs disagree with pages.** Dialog buttons are `rounded-lg` where page buttons are `rounded-full` (`Playlist.tsx:206`, `AddToPlaylistDialog.tsx:63`).
- **Web: duplicates.** Two different `Field` components (`SignIn.tsx:34`, `SettingsControls.tsx:174`), and destructive buttons in two reds (`Playlist.tsx:217`, `AccountsPanel.tsx:212`).
- **iOS:** a `Pill` view and a `.pill()` style live side by side (`Pill.swift:8`, `:90`), and small pills are 28 pt tall (`Pill.swift:27`, `DownloadButton.swift:86`).

The changes:
- **Web:** `Button` (primary, secondary, ghost, danger; 48 and 40 px), `IconButton` (44 px to tap on phones, 36 with a mouse), `TextField`, and `Choice` (the mono pills).
- **iOS:** one `.pill` style with the same variants, never under 44 pt to tap.
- **Choices vs actions:** the mono uppercase pills are choices: Albums' sort, Stats' ranges, Transitions, Keep up to, Motion. Actions are sentence-case buttons on both apps. The web already does this ("Play", "Shuffle"); iOS writes actions in mono capitals ("PLAY", "SHUFFLE", "DOWNLOAD", "FEELING LUCKY").
- **No wrapping on phones:** choices that wrap on a phone scroll sideways in one row instead (today Stats' ranges take two rows, and Keep up to puts "10 GB" alone on a second row).
- **The focus ring:** `index.css:103-107` sets `border-radius: 4px` on every `:focus-visible` outside any layer. That beats Tailwind's layered `rounded-full`, so a round button focused from the keyboard becomes a rounded square. Move the rule into `@layer base`, or drop the radius so the element keeps its own.
- **Done when** no page builds a button from classes, and a grep finds no `red-[0-9]`/`emerald-[0-9]` outside `index.css`.
- *Web done 2026-11-06: `Button`, `IconButton`, `TextField` and `Choice` (components/), used by every page, panel and dialog; dialog buttons are capsules; Request buttons say what they do in sentence case, and non-tappable states are badges. Player controls, sliders, menu items, tiles and inline text actions keep their own markup.*

## 3. One action row for everything you can play — S — done 2026-11-06

*Done: both apps' album, playlist, mix, Favorites and artist pages share one row (web `ActionRow`, iOS `ActionRow`): Play as wide as Resume, Shuffle, the page's own action, Download as an outlined icon with a ring and a green tick, ⋯; it narrows instead of wrapping. Feeling lucky is a primary large button on both.*

Play, Shuffle, Download and ⋯ come in five layouts today:

- **iOS album:** Play and Shuffle are 56 pt circles (`AlbumView.swift:127-139`), with Download as a small pill above the title. Every other iOS page uses pills (`PlayShuffleButtons.swift`).
- **iOS Favorites, playlist and mix:** a filled Download sits beside a filled Play, so there are two primary buttons. The mix's row wraps: Play, Shuffle, New mix, then Download and ⋯ on a second line.
- **Web:** the album has Play, Shuffle, ⋯, Download; the playlist has Play, Shuffle, Download, ⋯.
- **Web, while playing:** Play turns into a wider "Pause" and pushes the row along. On a phone, Download drops to a second line while the album plays. (iOS's `PlayShuffleButtons` already keeps a minimum width.)
- **Feeling lucky:** a 48 px sentence-case button on the web (`Home.tsx:268`), a 32 pt mono capitals pill on iOS (`HomeView.swift:80`).

The standard:
- One row, in one order, on the album, playlist, mix, Favorites and artist pages of both apps:
  1. **Play**: primary, one width for Play, Pause and Resume.
  2. **Shuffle**: secondary.
  3. The page's own action, when it has one (New mix): secondary.
  4. **Download**: an icon button whose ring fills as songs arrive and ends in a tick.
  5. **⋯**.
- Feeling lucky uses the primary style, at the same size on both apps.
- **Done when** the tours show the same row on those five pages on each platform, and playing an album moves nothing.
- *Web done 2026-11-06: `ActionRow` on the album, playlist, mix, Favorites and artist pages; Play is as wide as Resume; the row narrows in three steps by container queries (index.css, `row-step-*`) and never wraps.*

## 4. One page header — S–M

- **iOS, sibling pages:** Albums has an inline title with its count and a sort button. Artists, right beside it in Library, has a large title and no sort. Queue (a tab) has no title, while Library (a tab) has a large one.
- **iOS, repeated names:** mix and playlist pages show their name three times on one screen: in the navigation bar, as the page title, and on the cover.
- **Web, titles:** five h1 recipes:
  - `PageTitle`, `Albums.tsx:34`;
  - the album, playlist and mix headers;
  - the artist hero, `Artist.tsx:151`;
  - Discover and Find artist;
  - sign-in.

  Home has no title at all.
- **Web, kickers:** four colors (`text-paper-dim/70`, `/80`, `text-muted`, accent) and two trackings.
- **Home, greeting:** iOS greets ("Hi, Demo.") with the account avatar beside it; the web shows the wordmark over a gray line. Both should greet by name; plan 7 §4 adds the time of day.
- **The standard, both apps:**
  - Tabs and library lists get a large title with its count, and their actions (sort, filter) on the right.
  - Detail pages get, in order: cover, kicker, title, one meta line, then the action row (section 3).
  - The navigation bar shows the title only once the large one has scrolled away.
  - Kickers use one color (`muted`) and one tracking.
- **Done when** Albums, Artists, Playlists, Favorites, Downloads, Queue and Library share one header per platform, and no screen shows the same title twice.
- *Web done 2026-11-06: `PageHeader` on every tab and list page, `DetailHeader` (cover · kicker · title · one meta line · action row) on album, playlist, mix, Favorites, artist and discover artist; a playlist's or mix's own cover drops its name; every kicker is `type-kicker text-muted` (`paper-dim` over art); Home greets the account by name with its avatar.*

## 5. Rows and cards — M

- **Song rows:**
  - The web has at least five recipes: `TrackList.tsx:84`, `Playlist.tsx:260`, `Queue.tsx:175`, `NowPlaying.tsx:224` and `Downloads.tsx:28`.
  - The same text changes size by place: title and subtitle are 15/13 in lists, 14/12 in the player bar, `text-sm`/`text-xs` in Up next, and the title is `text-lg` in the queue.
  - Trailing items are ♥ · time · ⋯ on the web and time · ♥ · ⋯ on iOS.
  - The web queue shows no duration; iOS's does. The web mini player has a heart; iOS's doesn't.
  - On the iOS album page, rows for songs you have are taller than rows for missing ones (the heart and ⋯ are 44 pt), so the list's rhythm stutters.
- **Thumbnails** have a 3 px radius (`TrackList.tsx:93`, `Queue.tsx:187`) where covers have 4.
- **Cards:**
  - The same album card has four shelf widths: `Home.tsx:75`, `Album.tsx:134`, `Search.tsx:145`, `Search.tsx:233`.
  - Rediscover and Artists build their own grids (`Home.tsx:116`, `Artists.tsx:17`) instead of using `GRID` (`Albums.tsx:17`).
- **Artists without a photo** look different in five places:
  - Web Artists page and Home: the name over an album cover, which is hard to read on busy art (Massive Attack on Mezzanine, Arctic Monkeys on AM, Radiohead on In Rainbows).
  - Web Stats and Search: the album cover in a circle.
  - iOS Artists, Search and the album page's artist line: a gray silhouette.
  - iOS similar artists: a vinyl record with the initial.

  Pick one treatment for everywhere: the artist's best album cover, in a circle, with the name **below** it as on album cards. Keep the vinyl monogram for an artist with no cover at all.
- **Done when** one song row and one card per platform cover every list and shelf, the trailing order is the same on both apps, and every row in a list is the same height.
- *Web done 2026-11-06: `SongRow`/`ListRow` (components/SongRow.tsx) in every list, Now Playing's Up next and Downloads, trailing time · ♥ · ⋯ as on iOS, one height per list; one shelf card width (`SHELF_CARD`); artists are circles with the name below everywhere (photo, else best album cover, else vinyl monogram); the player bar's text is 15/13.*

## 6. Icons — S

- **One icon per concept:**
  - Requests and Downloads share a download icon on both apps: the web uses `Download` for Requests (`Nav.tsx:104`, `Library.tsx:28`) and for the Request pills (`Discover.tsx:83`); iOS's Library uses `arrow.down.circle` for both.
  - Storage uses a third icon (`HardDriveDownload`, `OfflineStorage.tsx:31`).
- **One size and stroke per role:**
  - Sizes: an icon-only close is 20, the request remove 16; the sidebar is 18, Settings' nav 17, the tabs 22.
  - Strokes: 2, 1.75, 2.25 and 1.5 are all in use (`Nav.tsx:104`, `:172`, `FavoriteButton.tsx:47`, `Favorites.tsx:28`).
- **One map:** the design doc maps each concept to its web glyph (lucide) and its iOS glyph (SF Symbols), so the difference is deliberate. Today previous and next are ⏮ ⏭ on the web and ⏪ ⏩ on iOS, and an artist is a microphone on iOS and books on the web.
- **Done when** the map exists and both apps follow it.

## 7. One vocabulary — S

- **Songs, not tracks.** "songs" for every count and heading. Today:
  - Search has both "Tracks" and "Songs" headings (`Search.tsx:106`, `:210`) and "Show all N tracks";
  - albums say "3 tracks · 17 min";
  - both apps' search fields say "Artists, albums, tracks", and clearing the queue says "Cleared N tracks".
- **Favorites** is the noun ("Favorites", "Add to Favorites"). "Songs you love" and "hearted" can stay as flavor in kickers.
- **Mixes are "Made for you"** in the nav, "Your mixes" on Home and "Mixes" in Settings. Choose one name for the feature.
- **Verbs:**
  - Pending verbs end with an ellipsis: "Requesting…", "Looking up…" (`Discover.tsx:55`, `:103`).
  - Retry is always "Try again" (today also "Retry", "Search again" and "Reload").
  - Taking something out of a list is "Remove"; destroying it is "Delete".
- **Spelling: American**, decided 2026-11-06. The interface mixes them today: "Favorites" and "Accent color" beside "analysed", "levelled" and "colour" (in the cover descriptions). Sweep both apps and the server's texts (mix descriptions, cover explanations) to American: analyzed, leveled, color, organize, favorite.
- **Badges say what they mean:** "MP3 8" becomes "MP3 · 8 kbps", and the bitrate hides when it's ordinary.
- **Color means action:** "Signed in as Demo" at the top of iOS Settings is accent-colored like a button but does nothing.
- **Done when** the word list is in `docs/design.md`, and a sweep of both apps and the server's texts matches it.

## 8. Empty, loading and error: one way each — S–M

- **Empty:**
  - The web has three layouts and three voices: a display heading with a heart (`Favorites.tsx:27-33`), a plain paragraph (`Downloads.tsx:23`) and small inline text (`Nav.tsx:219`).
  - Albums, Artists and an artist's albums say nothing at all when empty (`Albums.tsx:74-77`, `Artists.tsx:17-21`).
  - iOS has four forms: `ContentUnavailableView` (Downloads, Queue), custom stacks (Favorites, Search) and plain text (Mixes, an empty playlist).
- **Loading:**
  - Skeleton counts vary from page to page (12, 8, 6, 5).
  - The web playlist's skeleton has different top padding from the page it stands for (`Playlist.tsx:44`), so the page jumps when it loads.
  - iOS's playlist is a bare spinner (`PlaylistView.swift:30`), and Library has no loading state.
- **Errors:**
  - The web's `ErrorState` offers Try again and Back home (`Section.tsx:161-185`); iOS's only Try again (`ErrorState.swift:14`).
  - Elsewhere errors are red text in five shades, toasts or a bare link.
- **The standard, both apps:**
  - one `EmptyState`: an icon, one line in the app's voice (plan 7 §4) and the action that fills the page;
  - skeletons shaped and spaced like the page they stand for;
  - one `ErrorState`: what happened, Try again, Back home.
- **Done when** every list page has all three states, checked in the tours.

## 9. Overlays behave alike — S

- **Escape:** web Now Playing is its own modal with its own Escape handling (`NowPlaying.tsx:56-75`), while `Dialog.tsx:39` closes on any Escape. A dialog opened over Now Playing may therefore close both.
- **Dialog padding:** dialog bodies are padded three ways (`AddToPlaylistDialog.tsx:49`, `Playlist.tsx:198`, `TrackMetadataDialog.tsx:51`).
- **Menu focus:** menus move focus to their first item when they open (`Menu.tsx:50`). After a tap on a phone, that draws the focus ring around "Play next" (it's in the screenshots). Move focus only when the menu was opened from the keyboard.
- **⋯ labels:** every ⋯ on the web is named "More actions" (`Menu.tsx:15`), so a screen reader hears the same name on every row. iOS says "More for {title}"; the web should too.
- **iOS sheets:** one detent rule (medium and large for pickers), and Cancel or close always in the same corner.
- **Done when** one overlay stack decides what Escape closes, and the ⋯ labels match.

## 10. A web screen tour, and a check that keeps things consistent — S

- **`pnpm web:screens`:** the web's `ios:screens`, built from the prototype used for this review:
  - It starts the repo's server on a free port with an empty data folder and the generated library, cached in a gitignored folder.
  - It claims the server and seeds the accounts, playlists and plays.
  - It walks every page on the iPhone and iPad simulators through `scripts/ios-sim`, with one Web Inspector connection for the whole walk (a new one per command times out on a busy simulator) and Safari's first-run tip turned off.
  - Screens land in `screenshots/web/` (gitignored, like `screenshots/` today).
  - Desktop widths over 1032 px need a desktop browser. Headless Chrome is the obvious tool, but it can't start inside Claude's sandbox.
- **A cheap check** in `pnpm typecheck`, or CI:
  - Web: no hex, `rgb(`, `red-`/`emerald-` or `text-[Npx]` outside `index.css` and a short allow-list.
  - iOS: no `Color(red:`, `.system(size:` or literal `cornerRadius` outside `Theme/`.
- **Done when** each tour runs from one command, and the check fails a page that adds a raw color.
- *Tour done 2026-11-06: `pnpm web:screens` (scripts/web-screens/, docs/web.md §12): 51 phone and 44 tablet screens in about 6 minutes. The check is `scripts/check-design.mjs`, report-only until the sweeps land.*

## Order

1 → 10 → 3 → 2 → 4 → 5 → 7 → 8 → 6 → 9. Each step updates `docs/design.md` and both apps in the same change, with before and after screens from the tours.
