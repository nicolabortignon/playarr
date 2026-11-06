# The web app

Playarr's web app is a React single-page app, installable as a PWA, served by the Playarr server from the same origin. It lives in `apps/web`. This page covers how it's built, where state lives, how it talks to the server, how the player works, and how songs are kept on the device.

For the DJ mix pipeline (analysis, plans, rendered transitions, live mixes) see [mixing.md](mixing.md); for Made for you, [mixes.md](mixes.md). The server side of streams and artwork is in [server/streaming-and-art.md](server/streaming-and-art.md), and its routes in [server/api.md](server/api.md).

---

## 1. Stack

From `apps/web/package.json`:

- React 19, React Router 7, TypeScript 7, Vite 8;
- Tailwind CSS 4 with our own components (buttons, fields, choices, menus, dialogs, sliders; no component library), lucide icons, Motion for animation;
- TanStack Query 5 for server data, persisted to IndexedDB with `idb-keyval`;
- Zustand 5 for the player, preferences and other client state;
- `vite-plugin-pwa` in `injectManifest` mode, with Workbox 7 modules, for our own service worker;
- Vitest 5 with happy-dom and Testing Library.

`packages/shared` provides the API types and the byte-range parser; `packages/mix` provides the planner the player shares with the server. Vite defines `__BUILD_ID__` (a new value every build), `__APP_VERSION__` and `__APP_REVISION__` (see [server/updates-and-deploy.md](server/updates-and-deploy.md)).

## 2. Routes and pages

`src/routes.tsx` defines the routes; `src/main.tsx` creates the browser router and the query client provider.

- **Outside the shell**: `/sign-in`, `/redeem` (choose a password from a setup code) and `/setup` (claim a new server), with no player.
- **Inside `AppShell`**: Home, Artists, Albums, an artist, an album, Favorites, Library and Playlists load with the app. Everything else is lazy-loaded on first open: Search, Downloads, Stats, Mixes, a mix, a playlist, Queue, Requests, Discover (`/discover/artists/:mbid`, `/discover/artist`), Settings (`/settings/:panel?`) and Not found. The service worker precaches those chunks, so later opens are instant. `/settings/listening`, where Your listening used to be, opens `/stats` with the period it named (`ListeningMoved`).

Pages are in `src/pages`, shared pieces in `src/components`. Pages build their controls from the shared ones, as [design.md](design.md) describes them (Controls):

- `Button`: primary, secondary, ghost or danger; large (48), regular (40) or small (32); an optional leading icon, a pending state, and with `to`, a link drawn the same;
- `IconButton`: round, always named; 48 and outlined in an action row, else 44 to tap on touch screens and 36 with a mouse;
- `TextField`: the label above a 44 px field, an optional hint under it;
- `Choice`: the mono capitals pills, a radio group that scrolls sideways on a phone rather than wrapping;
- `ActionRow`: Play, Shuffle, the page's own action, Download and ⋯ on album, playlist, mix, Favorites and artist pages. While what the page started is playing (the album's songs, or a queue whose "Playing from" is the page), Play says Pause and Resume, keeping the width of its widest word. The row never wraps: CSS container queries (`row-step-*` in `index.css`) drop Shuffle's words, then the action's, as it narrows. It isn't a scroll container, which would clip Play's glow;
- `PageHeader`: the header of a tab or library list (Albums, Artists, Playlists, Made for you, Downloads, Queue, Library, Requests, Settings, Your listening): the title with its count beside it, the page's own controls on the right (they go under the title when there's no room), an optional kicker above and a sentence under it;
- `DetailHeader`: the header of everything you can play (an album, a playlist, a mix, Favorites, an artist, a MusicBrainz artist), in one order: cover, kicker, title, one meta line (`joinMeta` puts the dots between its parts), then the action row. On a phone the cover sits above the text at `min(64vw, 256px)`, so Play shows on the first screen; an artist's picture is a smaller circle. A playlist's or mix's cover leaves its name off there (`titled={false}`), since the title is beside it. `DetailHeaderSkeleton` has its shape while the page loads;
- `FormatBadge`: a format in a few words (`formatBadge`, `lib/format.ts`): the codec alone when it's ordinary (lossy at 256 kbps or more, lossless at CD quality: "MP3", "FLAC"), else with what sets it apart ("MP3 · 128 kbps", "FLAC · 24/96"), Hi-Res in the accent; its title has everything (`formatDetails`). In the player bar, Now Playing, the queue and on albums;
- `NameAndNumbers`: a name and the numbers about it (Stats' rankings, the queue's rows on a phone, Downloads) on one line when both fit, else the numbers go under the name, which is only cut short once they have a line of their own;
- `AccountMenu`: the account's initial in a circle of the accent, beside Home's greeting, opening Account, Your listening and Settings. Home greets by the time of day and name ("Morning, Alex.", "Late night, Alex."): Morning from 5, Afternoon from noon, Evening from 17, Late night from 22, the hours Vibes of the hour changes mood at, its daytime split at noon (`partOfDay`, `pages/Home.tsx`);
- `NavRow`: a row that opens a page, in a list of places to go (Library's, Settings' on a phone): the page's glyph in a tile, its name, a number about it, a chevron;
- `placeLink` and `PlaceLabel` (`components/Nav.tsx`): a place in a column of places, the sidebar's and Settings' beside its panel, with the page you're on lit (a paper wash and the accent's bar at its edge);
- `SongRow` (`components/SongRow.tsx`): a song in every list (an album, a playlist, the queue, Now Playing's Up next, Favorites, mixes, search, Your listening's top songs). Its number on its album's page, else its cover; title in `type-body`, the artist and album (linked) in `type-small`; then the time (`type-meta`, after the tempo when it's measured), ♥ and ⋯, in that order. The song playing has the accent and an equalizer; pressing it pauses or resumes. `compact` is Now Playing's denser Up next, `numbers` another number in the time's place (Your listening's plays), `stackOnPhones` the phone layout of the queue and Your listening (no ♥, the length or that number under the title), `narrow` that layout at any width (the queue in the column beside the page: two lines, the length kept beside the artist, whose name gives way first). It's built on `ListRow`, the one row (also Downloads, songs beyond the library, a playlist's suggestions): the title is the row's own button or link, stretched over the row by its `::after`, so the row presses as one while the handle, links, ♥ and ⋯ sit above it as buttons of their own. Every row of a list is one height (60 with a thumbnail; 52 with a number, 60 on touch screens), a missing song's included. Dragged by its handle, a row lifts (a shadow, 3 % larger, over the rows it passes) and the rows it passes part for it at the standard 250 ms;
- `Menu`: ⋯ and its popover, with lines (`DIVIDER`) between groups. Its `label` is required and names what it's for, the title in curly quotes: "More for “Teardrop”", "More for Sam" (never "More actions"). A row or a card opens the same menu on a right-click, a long press (500 ms, on touch screens) or the keyboard's menu key (`lib/contextMenu.ts`); a long press doesn't also play or open, and a link inside a row keeps the browser's own menu for a mouse. Opened from the keyboard (Enter or Space on ⋯, the menu key), its first item takes the focus and shows its ring; from a pointer, the menu itself takes it, so no item looks chosen. A click counts as the keyboard's only when Enter or Space went down on ⋯ just before (`detail` 0 alone isn't enough: scripted clicks have it too). A card mounts its `ContextMenu` only once asked;
- `Dialog` (`components/Dialog.tsx`): a bottom sheet on a phone, a card from `sm` up, regular (448), `wide` (768, for grids and tables) or `wider` (896, two columns). Its body has one padding in every dialog (20, as its header), so what goes in it brings none of its own; a list whose rows light up pulls them out by their own padding. `footer` keeps the dialog's buttons (or a closing note) in view under a body that scrolls. It focuses its first field or button as it opens, skipping Close, and gives the focus back as it closes. `ConfirmDialog` asks before losing something for good;
- **Escape closes only what's on top** (`lib/overlays.ts`): every menu, dialog and Now Playing joins one stack while it's open (`useOverlay`), and one listener closes the newest: a menu, then the dialog it's in, then Now Playing under them. A field that takes Escape for itself (calling `preventDefault`) keeps it, and so does a key pressed while composing text;
- `components/menus.ts`: the menus, one list each. `useSongMenu`: Play next · Add to queue · Add to playlist… · Start radio · Go to album (not on the album's own page) · Go to artist · Show metadata · Edit mix points (DJ mix on), then after a line the place's own actions (Move up, Move down, Remove from playlist or queue; Open queue in Now Playing, where the song playing has no Play next or Add to queue). `upNextMenu`: Up next's Play next moves the song up rather than queueing it again. `useAlbumMenu` and `usePlaylistMenu`: Play next · Add to queue · Add to playlist… (an album's Go to artist; a playlist's owner's Rename, New cover…, Share, Delete after a line), the same on the page's ⋯ and on its card, which puts Play and Shuffle first;
- `Cover`: waits its turn to load (below), and fills its space meanwhile with the album's own color (`coverColor`, read by the server from the cover and sent with every album and song), so a loading cover is the album's color rather than gray; gray without one (an older server, Discover's covers), and a record label with the initials where there's no picture at all;
- `LuckyButton`: Feeling lucky. While it picks, the sparkles twinkle and covers flick past where its words were, each tipping forward like a record in a crate (albums already loaded, `coversAtHand`; else, once it has answered, a few of the songs it found, `flickCovers`), three at least, landing on the first song's as the music starts. Its words stay its name, faded;
- `AlbumCard`, `ArtistCard` (`components/Cards.tsx`): one width on every shelf (`SHELF_CARD`, `components/Section.tsx`), the grid's columns elsewhere (`GRID`, `pages/Albums.tsx`). On an artist's own page (`onArtistPage`) an album card says its kind and year ("Album · 1998", "EP · 2019") rather than the artist's name, as Discover's cards there do. An artist is a circle with the name below it (`ArtistTile`, also for artists beyond the library): their photo, else their best album cover (the server's pick), else a vinyl monogram (`ArtistAvatar`).

Controls drawn smaller than 44 px take that much to tap on touch screens through the `tap-target` utility in `index.css`.

**Add to playlist** (`components/AddToPlaylistDialog.tsx`) lists the account's own playlists with a tick on those that already hold the songs, a dash on those holding some (`POST /api/playlists/holding`), and adds to every playlist chosen at once. **Play next and Add to queue** confirm with a toast naming the song ("“Teardrop” plays next", "3 songs play next", "Added “Teardrop” to the queue"); its Undo takes them back out of the queue. An Undo toast goes after 6 s, but not while it's pointed at or focused (`toastWithUndo`, `lib/toast.ts`).

**Taking things back.** Taking something out of a list happens at once, with an Undo toast: Remove from queue (Undo puts the song back before the one that followed it), Remove from playlist (the song goes back after the one before it; the server adds it again and moves it, so a song no longer in the library, which can't be added, has no Undo), Stop sharing, removing a download (Undo puts it back as it was; songs that made room meanwhile download again), removing a recent search or clearing them, and removing a request. A request's removal waits for its Undo to pass before the server forgets it (`toastWithUndo`'s `done`), as asking Lidarr again couldn't bring back an album that has arrived. Losing something for good asks first in a `ConfirmDialog` (`components/Dialog.tsx`) that names what goes, with Cancel focused and a danger button: deleting a playlist, removing an account or a source, signing a device out, a new setup code (the old one, and the password, stop working), a new invite link for someone whose link this device doesn't have (the one they have stops working), clearing the listening history, and Remove all on this device ("Remove 312 songs from this device?").

**Empty, loading and error** (`components/States.tsx`), one way each:

- `EmptyState`: a list with nothing in it: an icon, one line in the app's voice from The lines in [design.md](design.md) ("No hearts yet."), sometimes a quieter second line, and the action that fills the page as a large primary button (a link, a button, or `'lucky'` for Feeling lucky), with a second one beside it, outlined, where there is one. Jump back in (`useJumpBackIn`, `components/JumpBackIn.tsx`) plays the album heard last from the start: beside Feeling lucky on the queue ("The deck’s empty."), and Favorites' own action ("No hearts yet."), which is Feeling lucky until something has been heard. On Albums and Artists (Settings → Sources for an admin), an artist without albums, Playlists, Favorites, Downloads (and why it can't download over plain HTTP), Queue, Requests (what's possible on this server: Lidarr missing or requests off, for an admin with where to change it), Made for you, Search's "Not in your crates." (below), Your listening and an empty playlist;
- `CardSkeleton` (`CardSkeletons` for a grid's first screen) and `SongRowsSkeleton`: placeholders the size of the real card or row, its text lines included, in the same grid or list, so nothing moves when the page arrives; detail pages add rows under `DetailHeaderSkeleton`;
- `ErrorState`: a page that couldn't load: "The needle skipped.", what went wrong, Try again and Back home;
- `InlineError`: part of a page, a panel or a dialog that couldn't load or save: a danger icon, what happened and why, and Try again when there's a retry ("Trying again…").

**Search** (`pages/Search.tsx`) never ends at nothing:

- Empty, it offers this account's recent searches on this device (`lib/recentSearches.ts`), newest first: each a tap to search again, with × to take it off the list, and Clear for all of them, both at once with Undo. Then artists to try. A search counts once one of its results is opened or played, once it's been left alone for 2.5 s, or with Enter; never a single letter. The same words count once, whatever their capitals, accents or spaces, and a search that only carries on from the newest takes its place (it was typed on the way). Eight are kept.
- The library's results come first. When `/api/search` answers `near: true` (nothing matched as typed), a line says these are close, not exact: "Nothing called “mezanine”. These come close:".
- Beyond the library, in a section of its own headed "Not in your library", whenever there's something there or on its way: Lidarr's search where there's Lidarr, else MusicBrainz's, with Deezer for songs (`/api/discover/search`, asked 450 ms after typing stops). Request shows only where requesting is possible (`RequestButton`), and nothing takes its place otherwise. Plan 6 §7's "Ask {owner}" waits on requests that remember who asked.
- Nothing in the library: "Not in your crates.", and what's out there under it. Nothing anywhere either: what to try (the spelling, fewer words), New search (back to the recent searches, the field ready to type in) and artists to try.

**Your listening** (`pages/Stats.tsx`): the headline minutes count up as the report opens (`CountUp`: the real number holds its place, and is what a screen reader reads, while the count runs over it); a longest streak that's the one going on, and more than a day, is flagged "New record" (`isNewRecord`, from the server's `currentStreak`, absent from older servers); and a year in review rises into place like a sleeve pulled out of a crate.

Long grids show a screenful at a time (`lib/useIncremental.ts`: 48 items, then 48 more as the end comes within 1500 px). Covers load four at a time, on-screen ones first (`lib/imageQueue.ts`).

## 3. Layout

`components/AppShell.tsx` mounts only one layout, chosen by `useDesktopLayout()` (Tailwind's `md`, **768 px**). The hidden layout would still poll and re-render.

- **Phones** get a bottom tab bar (Home · Search · Library · Queue) with a mini player above it. Library collects Made for you, Your listening, Downloads, Favorites, Artists, Albums, Requests, Settings and playlists. Now Playing opens full screen and closes with a drag down.
- **Desktop** gets a left sidebar (Home, Search, Made for you, Artists, Albums, Favorites, Downloads, Queue, then Requests, playlists and Settings) and a player bar at the bottom. With nothing playing (a device that hasn't played anything yet: the queue is kept), the bar offers the album heard last, on any device (`useRecentAlbums`), with Resume to play it from the start, and Feeling lucky; with no history, Feeling lucky alone.

Both share Now Playing, Stats for nerds, the keyboard shortcuts, the Add to playlist, metadata and mix-points dialogs, toasts and the audio engine.

**The queue and lyrics column** (`components/SideColumn.tsx`). From 1280 px (`useColumnLayout`), the bar's Queue and Lyrics, and Now Playing's Queue, open a 340 px column beside the page, as on the iPad app, with a switch at its top between the two; pressed again, they close it. Its queue is headed "Up next" with its counts beside it in `type-meta` (under it when they don't fit), and its rows take two lines (`SongRow`'s `narrow`). The page makes room for it, and its grids and headers follow the page's width rather than the window's: AppShell makes the page area a `page` container, and pages use `page-lg:`, `page-xl:` and `page-2xl:` (`index.css`), which are lg, xl and 2xl exactly while nothing is beside the page. Narrower, Queue opens the Queue page (kept for phones and narrow windows) and Lyrics opens Now Playing on the words.

**Now Playing** (`components/NowPlaying.tsx`) treats its cover as an object: paused, it settles back (86 %, as on iOS, with a softer shadow) and playing lifts it again; with a mouse it tilts up to 2° towards the pointer, catching a faint sheen (never on touch); its backdrop, the cover blown up and blurred, drifts through the cover's colors (`animate-drift`, 40 s each way). Under the seek bar, an analyzed song's energy per phrase (`SongEnergy`, `components/EnergyStrip.tsx`, from its mix map): what's played in the accent, what's ahead fainter, lit up to where a drag would land. It's drawn inside the slider, so pressing or dragging on it seeks there, and keeps its room for a song not analyzed, so the transport never moves from one song to the next. When the sleep timer stops the music (its time up, or the song it waited for ended: `fellAsleep`, `player/sleep.ts`), Now Playing dims to a moon and "Sleep well" for four seconds, then stays dark until a touch, a key or the music playing again; said to Now Playing opened long after, it isn't (with Now Playing closed, a toast says the music stopped).

**Now Playing in iPhone Safari** reaches under the status bar and the toolbar. Safari 26 paints its translucent bars in the color of the topmost fixed element at each edge (fixed elements themselves stop at the bars): while Now Playing is open, that's its sheet's ink-950, into which its art fades at both ends. The film grain over the page (`body::after`) sits at z-index 35, under the player bars, the tab bar, Now Playing and dialogs: with no color of its own, on top it would let the page show through the bars.

**Keyboard shortcuts** (`player/useKeyboardShortcuts.ts`; the list is `SHORTCUT_SIDES`, `components/Shortcuts.tsx`) are ignored while typing or with ⌘, Ctrl or Alt held. Settings → Playback lists them only where there's a keyboard (`useHasKeyboard`, `lib/keyboard.ts`): a mouse or trackpad (`any-pointer: fine`), or a key pressed outside a field, which the device remembers; a phone or a tablet without one never shows them. `?` shows them over any page, set out as the back of a sleeve lists its songs (Side A · Playing, Side B · Getting around), the two sides beside each other from 1024 px and one above the other narrower, until Escape; Settings → Playback lists them by side too. A key held with another is written once for both ("Shift + ← or →"), and every action fits its line beside its dotted leader. They are:

- Space: play or pause;
- ←/→: seek 10 s; Shift+←/→: previous or next song;
- ↑/↓: volume;
- M: mute; S: shuffle; L: add the song playing to Favorites, or take it out;
- `/`: Search; `?`: the shortcuts.

In a list, Tab reaches each song as a button: Enter or Space plays it, the menu key (or Shift+F10) opens its menu, and its ♥, ⋯ and drag handle are buttons of their own. On a playlist's or the queue's handle, ↑ and ↓ move the song, as dragging does (and Move up and Move down in its menu). The mini player is an "Open now playing" button beside its ♥, Play and Next. A playlist's owner renames it from the pencil beside its title, or from ⋯ → Rename.

The Motion setting maps to Motion's `reducedMotion`, and to `data-motion` on `<html>` for CSS transitions. What moves in JavaScript, or loops in CSS, asks `useReduceMotion()` (`lib/motion.ts`: the setting, or the system's while it says System) and doesn't start at all under Reduce Motion, as collapsing a loop's duration would make it flicker: Now Playing's drift and tilt, Feeling lucky's covers, the count-up and the year in review's sleeve.

## 4. State

**Server data** goes through TanStack Query (`lib/queries.ts`, `lib/queryClient.ts`). Defaults: 5 minutes stale, no refetch on focus, one retry. The kept queries (`artists`, `artist`, `albums`, `album`, `favorites`, `playlists`, `playlist`, `mixes`, except the random album shelf) are persisted to IndexedDB under `playarr.queries`. The persisted copy:

- is written at most every 10 s, and only when kept data changed;
- lasts 7 days;
- is discarded on every new build (the `__BUILD_ID__` buster), so old shapes are never misread.

The app opens with the last data on screen and refreshes it in the background. Polled status (health, the MusicBrainz queue, requests, updates) isn't persisted.

**Zustand stores**, and what persists to `localStorage`:

| Store | Holds | Persisted as |
|---|---|---|
| `usePlayer` (`player/store.ts`) | The queue, play order, position, shuffle, repeat, volume, mute, resume point, "Playing from" source, mix mode | `playarr.player` (not `playing`) |
| `useClock` (`player/store.ts`) | The playhead and duration, and `seek` | no |
| `usePrefs` (`lib/prefs.ts`) | Settings → Playback and Appearance: accent, motion, format badges, count plays, autoplay, transitions (off / crossfade / DJ mix), crossfade length, even volume, Stats for nerds | `playarr.prefs` (unknown values cleaned on load) |
| `useOffline` (`player/offline.ts`) | Songs kept on the device, downloads, the size limit, the download in progress | `playarr.offline` (not the progress) |
| `useAccounts` (`lib/accounts.ts`) | Accounts signed in on this device, with their session tokens | `playarr.accounts` (written by hand) |
| `useUI` (`lib/ui.ts`) | Now Playing and lyrics open, the column beside the page, the shortcuts, open dialogs | no |
| `useRecentSearches` (`lib/recentSearches.ts`) | Recent searches, by account | `playarr.recentSearches` |
| `useKeyboardSeen` (`lib/keyboard.ts`) | Whether a key was pressed outside a field | `playarr.keyboard` |
| `useLevels`, `useTransition`, `useJoins`, `useDownloadState`, `useSleep`, `useToasts` | Even-volume levels, the transition for the current pair, join measurements, download failures this session, the sleep timer (and when it last stopped the music, for Now Playing's goodnight), toasts | no |

Play reports waiting to be sent are kept in `playarr.pendingPlays`. Invite links made on this device are kept in `playarr.invites` until they expire (`lib/invites.ts`), to copy again: the server keeps only a hash of each setup code, so it can't hand one out twice.

**Per-device preferences** are the `usePrefs` values. An admin can lock Playback or Appearance for an account (`useLocked`, from `/api/auth/me`). The panel then shows read-only.

## 5. API client, sign-in and accounts

`lib/api.ts` is a thin `fetch` wrapper with one function per route. Every request sends `X-Playarr: 1`, since the server only accepts changes carrying it. Errors become `ApiError(message, status)`. A 401 from anything but `/api/auth/*` sends the page to `/sign-in?next=…`.

Sign-in, redeeming a setup code and claiming the server each return a session token. `lib/accounts.ts` keeps every account signed in on this device in `localStorage`. To listen as one, `switchTo()` posts its token to `/api/auth/switch`, which sets the session cookie. It then deletes the service worker's `playarr-api` cache and resets the query cache, so nothing of the last account stays on screen or offline. A token the server no longer accepts is forgotten. When the page isn't on the server's `PUBLIC_URL`, `lib/publicAddress.ts` sends you there to sign in again, because cookies are per origin.

Accounts, roles and sessions on the server: [server/accounts-and-access.md](server/accounts-and-access.md).

## 6. The player

`player/AudioEngine.tsx` owns the audio. It renders **three `<audio>` elements**:

- **two decks take turns**: one plays while the other loads the next song, 30 s before the end;
- **the third plays DJ transitions** rendered by the server, between A and B.

Plain elements keep playing on a locked iPhone, which is why the player uses them rather than Web Audio alone.

- **Gapless and crossfade.** The next deck starts 30 ms early to cover its start-up time. With Crossfade, songs overlap by the chosen length (3, 6, 9 or 12 s), capped at a third of either song. Songs of an album played in order never fade (`player/decks.ts`). Devices that fix the volume in hardware (iPhone, iPad: `canSetVolume()`) get gapless playback but no fades. Settings shows Crossfade as unavailable there; DJ mix still works, as its transitions are mixed on the server.
- **Web Audio on desktop only.** `isDesktop()` requires a fine pointer, no phone or tablet user agent, and no touch Mac (an iPad asking for desktop pages). Only there are the elements routed through a Web Audio graph (`player/joinGraph.ts`). That lines up joins between files on the sound itself and lets skips be mixed live (`player/liveMix.ts`). Elsewhere, files take over in step by their reported times. iOS suspends Web Audio when the screen locks, which would silence the players.
- **DJ transitions**: `player/transitions.ts` asks the server for the current pair once a song has played 5 s, and the engine plays A, the transition, then B. All of it is in [mixing.md](mixing.md).
- **Even volume.** With the setting on and the song's loudness measured, a deck plays the server's leveled stream, `/stream/:id/levelled.wav?gain=<dB>` (`player/levels.ts`). It's turned up as well as down, which works on iPhones too, where element volume is ignored. Within an album played in order, the album's level applies. A song kept on the device, or whose leveled stream fails, plays its own file at its own volume.
- **Formats a browser can't play** (Apple Lossless or AIFF in Chrome and Firefox) are fetched from `/stream/:id/lossless.wav` instead (`lib/playable.ts`). MP3, AAC and FLAC play natively everywhere. There's no transcoding yet, so anything else a browser can't play (Ogg or Opus on an older Safari, say) fails to play ([open items](plans/open-items.md)).
- **Media Session**: title, artist, album and cover (256 and 512 px), plus play, pause, stop, next, previous, seek back and forward, and seek-to, for lock screens and OS controls.
- **Accent and title**: the tab title follows the song. The accent color and favicon follow the song's `coverAccent` (the accent the server read from its cover, picked as `accentOf` picks it) at once, before the cover has loaded, and the cover read here where the server hasn't sent one (an older server, a cover not read yet: `usePlayerAccent`, `lib/accent.ts`); a cover the server read and found no color in keeps Playarr's orange. An album page's wash takes its accent the same way (`useCoverAccent`). Appearance can fix a color instead.
- **The end of a song** (`player/endOfSong.ts`): from ten seconds before a song gives way, the mini player's and the player bar's subtitle says what comes next ("Next: Teardrop"). With DJ mix blending the two on the beat, it says "Mixing into Teardrop on the next bar" through the last bar before the blend (four beats at the song's tempo, else two seconds), then "Mixing into Teardrop" until the next song takes over. The ten seconds count to the plan's mix point with DJ mix, else to the song's end less Crossfade's overlap; nothing follows a song the sleep timer stops after.
- **Play reports** (`player/playTracker.ts`). A song counts as a play after 30 s heard, or half of a shorter song; seeks don't count. A song left after 3 s counts as a skip. Reports go to `/api/plays` with `keepalive`, one request at a time. Unsent ones wait in `localStorage` (at most 300). "Count what this device plays" turns them off.
- Also here: autoplay radio when the queue ends (`player/radio.ts`), the sleep timer (`player/sleep.ts`), and up to three retries of a stream that breaks off.

## 7. Service worker and offline

`src/sw.ts` is built by `vite-plugin-pwa` in `injectManifest` mode. It:

- **precaches** the app shell (js, css, html, svg, png, woff2);
- **skips waiting and claims clients**, so a new version takes over at once;
- falls back to `index.html` for navigation, except `/api`, `/stream`, `/art` and `/transitions`;
- serves `/art/*` **cache-first** (`playarr-art`: 1500 entries, 60 days);
- serves `/api/*` **network-first** with a 4 s timeout (`playarr-api`: 200 entries), so pages open offline with the last answers.

**Audio.** For `/stream/*` and `/transitions/*`, the worker looks in `playarr-audio`. A kept file is answered whole, or as the one byte range `<audio>` asks for, sliced from the stored blob by `lib/rangeResponse.ts` with the same `parseRange` the server uses (`@playarr/shared`). That includes 416 for unsatisfiable ranges. Anything not kept goes to the network untouched. **The worker never stores audio**: the page decides what's kept and how much.

`lib/appUpdate.ts` handles new versions. It reloads into a new one by itself if the app was opened under 15 s ago, or is in the background, and nothing is playing; otherwise it shows a Reload toast. It also checks for new versions every 30 minutes and whenever the app returns to the foreground.

**Needs a secure context.** Service workers and Cache Storage only exist on HTTPS or localhost. Over plain `http://192.168.x.x` none of this runs, and songs just stream. Settings → Playback and Downloads explain why. The Vite dev server has no service worker, so to try offline features, use `pnpm -C apps/web build && pnpm -C apps/web preview` (:4173, proxied to the server).

## 8. Load-ahead and downloads

**Load-ahead** (`player/loadAhead.ts`) keeps the songs about to play on the device. It plans the **next 3** in play order (wrapping with repeat-all), then the current song, which is worth keeping for seeks, replays and offline; with repeat-one the current song comes first. Further rules:

- It waits **2.5 s** for the queue to settle, so skipping through tracks downloads nothing.
- It downloads one song at a time, and aborts one that drops out of the plan.
- **Offline, data saver or 2G**: nothing. **Cellular**: one song ahead, not the current one.
- It only runs while a service worker controls the page.
- It also preloads the next cover at the player's sizes, plus Now Playing's sizes when that's open.

**Keeping a song** (`player/offline.ts`) fetches the whole file (a 200, not a range) and writes it to `playarr-audio`. The index (URL, bytes, last used) is in `useOffline`. Space for songs kept this way:

- the default limit is **2 GB**, with choices of Off, 512 MB, 1, 2, 5 or 10 GB in Settings → Playback;
- it's capped at half the browser's quota;
- the least recently played songs go first, and songs in the current plan are never dropped;
- it asks for persistent storage once.

**Downloads** (`player/downloads.ts`, the Download buttons, the Downloads page) pin an album, playlist, mix or Favorites to the device. Their songs:

- download in the order the downloads were added, one song at a time, whenever the device is online;
- don't count towards the limit and never make room for others;
- may fill the browser's quota up to 90%, dropping load-ahead songs first. When that's not enough, a toast says the device is full.

With DJ mix on, the transitions between a download's songs are fetched too, once both songs are kept. While the server renders one, the app asks again every 3 s, then every 10 s after five asks, and gives up after 10 minutes. The songs then mix offline.

When a download's last song arrives, its ring closes into the tick and a toast says so: "“Mezzanine” is on this device" (`justDownloaded`, `useDownloads`); downloading something whose songs are all on the device already says it at once, in place of "Downloading “Mezzanine”".

A small ⤓ after a title marks the songs of a download (`OfflineMark`, `useIsDownloaded`), and a ring shows one downloading. Songs only loaded ahead get no mark: the mark means the song will be there offline.

## 9. Prefetching

`lib/prefetch.ts` loads album, artist and playlist pages on intent:

- a mouse resting **80 ms** on a link;
- a pointer going down on one;
- keyboard focus.

That fetches the page's data, its header image, and for an album, its artist too. Preloaded image URLs are remembered, up to 300.

## 10. Settings panels

`pages/Settings.tsx` puts the panels in groups, named and ordered as the iOS app's (`useSettingsGroups`): **This device** (Playback, Appearance), then for an admin **Server** (Sources, Accounts, Made for you, Analysis, Requests, Updates). A member gets **Your account** (Accounts and Made for you: their name and devices, their mixes and ListenBrainz) before **Server** (Sources, Analysis, Requests, Updates), which they can read but not change.

- **Where the page is at least `page-lg` wide** (784 px: a 1024 px window, or 1364 while the queue column is open; `usePageLg`, `lib/useMediaQuery.ts`, as the layout changes rather than only its styles), a column of the same groups sits beside the open panel, under the "Settings" header (`SettingsColumn`): each group's name as a kicker, each panel's glyph and name as the sidebar draws its places (`placeLink`, `PlaceLabel`), the open one lit and marked `aria-current="page"`, and for a member "Only an admin can change these." under the server's. The column is 192 wide and stays in view as the panel scrolls; every panel is in it at any width, so nothing scrolls sideways. The panel's scope is the line above it, and `/settings` opens Playback.
- **Narrower** (a phone, a window under 1024 px), `/settings` is that list (`NavRow`s, each group's scope under it, the app's version at the foot). A row opens its panel under its own name, with Settings above it to go back: back in history when it came from the list, else to the list.

Each panel says who it applies to:

| Panel | Scope |
|---|---|
| Playback | This device: transitions, crossfade, even volume, autoplay, counting plays, songs kept on the device, the shortcuts (where there's a keyboard) |
| Appearance | This device: accent, motion, format badges |
| Sources | Server-wide; editable by admins (before setup, from the home network) |
| Accounts | Server-wide: who signs in and what each account may hear and change |
| Made for you, Analysis, Requests, Updates | Server-wide ("These settings apply to everyone"); Made for you also has ListenBrainz |

Your listening isn't a setting: it's at `/stats`, in Library and the account menu.

**Sources** are a stack of cards, the same on a phone: the name, where it is (the whole path, broken anywhere rather than cut short), its songs and albums and how complete they are, how it's doing (syncing, matching, its last sync, an error) and how its songs were matched. What can be done with one is in its ⋯, in words ("More for “Music”"): Sync now, Match again and Organize files (a folder's), Edit, then Move up and Move down (the order sources win in, as dragging the handle does), then Remove. **Accounts** name their actions too (⋯: Edit, Devices, New setup code, then Remove); someone invited who hasn't set up yet is "Invited · not set up yet", with Copy invite link (the link this device made, else a new one after asking) and New code beside them.

Device settings live in `usePrefs` and `useOffline`; server-wide ones go through `/api/settings/*` (see [server/api.md](server/api.md)).

## 11. Testing

- `pnpm --filter @playarr/web test` runs Vitest (`vitest.config.ts`: happy-dom, relative URLs resolved against `PLAYARR_SERVER`, default `http://localhost:4000`, with a 20 s timeout). Unit tests sit next to their files.
- `src/smoke.test.tsx` renders every route against a **running server** and drives the player store. Without a server its tests return early and pass, so start `pnpm dev:server` first.
- `pnpm -C apps/web exec vitest run src/<file>` runs one file. `pnpm typecheck` checks the app and the service worker, then runs the design check on the web (`scripts/check-design.mjs --app web`; [design.md](design.md)): a hex color, a color function (`rgb()`, `oklch()`…), one of Tailwind's own colors (`text-sky-400`, `bg-white/10`; black only in a shadow) or an arbitrary text size (`text-[13px]`) anywhere in `src` (tests aside) fails it, naming the file, the line and what it found. Colors come from `index.css`'s tokens and sizes from its `type-*` roles; where a raw value is the point (the accent choices, the favicon's canvas, a mix cover's own hues, Stats for nerds' data colors, the wordmark), the check's `ALLOW` list names the file and why. `node scripts/check-design.mjs --report` lists every finding of both apps without failing; iOS's are only counted until its own sweep.
- **iOS Safari**: `pnpm sim` (`scripts/ios-sim/`) boots an iOS Simulator (default iPhone 17 Pro) and drives Safari through its Web Inspector socket, so it needs only Xcode. Commands: `boot [--show]`, `open <path>`, `click`, `fill`, `wait`, `eval`, `console [--errors]`, `shot` (to `/tmp/playarr-sim.png`), `shutdown`. It opens the NAS deployment unless `PLAYARR_URL` says otherwise. Taps are JavaScript clicks, not touches. Over plain HTTP, iOS Safari has no service worker, so offline features can't be tested there.

## 12. Screens

`pnpm web:screens` screenshots every page, the web's `pnpm ios:screens`. It builds the app and starts the repo's server on a free port, with an empty data folder and a generated library: 20 real albums' track lists from MusicBrainz and covers from the Cover Art Archive, as silent MP3s with full tags. It claims and seeds the server (two accounts, an invite, five playlists, four weeks of plays), then walks the steps in `scripts/web-screens/steps.json` in Safari on two simulators of its own:

- "Playarr Web iPhone", an iPhone 17 Pro: the phone layout, into `screenshots/web/phone/`;
- "Playarr Web iPad", an iPad Pro 13-inch upright: the desktop layout at 1032 px, into `screenshots/web/tablet/`.

Each run replaces the screens (`screenshots/` is gitignored). A full run takes about 6 minutes.

- `pnpm web:screens tablet` (or `SCREENS=tablet`) takes one device. `--shots album,queue` takes only those shots, where `album` also takes `album-2`, `album-playing`…, and walks only the pages they need. `--no-build` serves the last build.
- It needs Xcode's simulators; it makes the two when they're missing, on the newest iOS. The first run needs musicbrainz.org and coverartarchive.org. The library is kept in `.cache/web-screens/`, with the build and the server's log.
- New states that need a moment to reach have shots of their own: `queue-empty` before anything plays, `stats-empty` (a year without plays), `mini-player-next` and `player-bar-next` (the last ten seconds of a song, reached with the seek bar's keys). The library is silent and not analyzed, so `now-playing-energy` makes up the songs' energy (an `eval` that answers `/api/mix-maps` for them) to show the strip under the seek bar; the other shots show what the server sends.
- Widths over 1032 px: the tablet's `player-idle` and `queue-column` shots widen Safari's layout to 1440 px through the viewport tag (an `eval` step), and the iPad draws it scaled down; the next `go` puts it back. A desktop browser would do better, but headless Chrome can't start inside Claude's sandbox.

The native iOS app is separate: see [ios/README.md](ios/README.md).
