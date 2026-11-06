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
- **Inside `AppShell`**: Home, Artists, Albums, an artist, an album, Favorites, Library and Playlists load with the app. Everything else is lazy-loaded on first open: Search, Downloads, Stats, Mixes, a mix, a playlist, Queue, Requests, Discover (`/discover/artists/:mbid`, `/discover/artist`), Settings (`/settings/:panel?`) and Not found. The service worker precaches those chunks, so later opens are instant.

Pages are in `src/pages`, shared pieces in `src/components`. Pages build their controls from the shared ones, as [design.md](design.md) describes them (Controls):

- `Button`: primary, secondary, ghost or danger; large (48), regular (40) or small (32); an optional leading icon, a pending state, and with `to`, a link drawn the same;
- `IconButton`: round, always named; 48 and outlined in an action row, else 44 to tap on touch screens and 36 with a mouse;
- `TextField`: the label above a 44 px field, an optional hint under it;
- `Choice`: the mono capitals pills, a radio group that scrolls sideways on a phone rather than wrapping;
- `ActionRow`: Play, Shuffle, the page's own action, Download and ⋯ on album, playlist, mix, Favorites and artist pages. While what the page started is playing (the album's songs, or a queue whose "Playing from" is the page), Play says Pause and Resume, keeping the width of its widest word. The row never wraps: CSS container queries (`row-step-*` in `index.css`) drop Shuffle's words, then the action's, as it narrows.

Controls drawn smaller than 44 px take that much to tap on touch screens through the `tap-target` utility in `index.css`.

Long grids show a screenful at a time (`lib/useIncremental.ts`: 48 items, then 48 more as the end comes within 1500 px). Covers load four at a time, on-screen ones first (`lib/imageQueue.ts`).

## 3. Layout

`components/AppShell.tsx` mounts only one layout, chosen by `useDesktopLayout()` (Tailwind's `md`, **768 px**). The hidden layout would still poll and re-render.

- **Phones** get a bottom tab bar (Home · Search · Library · Queue) with a mini player above it. Library collects Made for you, Your listening, Downloads, Favorites, Artists, Albums, Requests, Settings and playlists. Now Playing opens full screen and closes with a drag down.
- **Desktop** gets a left sidebar (Home, Search, Made for you, Artists, Albums, Favorites, Downloads, Queue, then Requests, playlists and Settings) and a player bar at the bottom.

Both share Now Playing, Stats for nerds, the Add to playlist, metadata and mix-points dialogs, toasts and the audio engine.

**Keyboard shortcuts** (`player/useKeyboardShortcuts.ts`, listed in Settings → Playback) are ignored while typing or with ⌘, Ctrl or Alt held:

- Space: play or pause;
- ←/→: seek 10 s; Shift+←/→: previous or next song;
- ↑/↓: volume;
- M: mute; S: shuffle; L: favourite the song playing;
- `/`: Search.

The Motion setting maps to Motion's `reducedMotion`, and to `data-motion` on `<html>` for CSS transitions.

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
| `useUI` (`lib/ui.ts`) | Now Playing and lyrics open, open dialogs | no |
| `useLevels`, `useTransition`, `useJoins`, `useDownloadState`, `useSleep`, `useToasts` | Even-volume levels, the transition for the current pair, join measurements, download failures this session, the sleep timer, toasts | no |

Play reports waiting to be sent are kept in `playarr.pendingPlays`.

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
- **Even volume.** With the setting on and the song's loudness measured, a deck plays the server's levelled stream, `/stream/:id/levelled.wav?gain=<dB>` (`player/levels.ts`). It's turned up as well as down, which works on iPhones too, where element volume is ignored. Within an album played in order, the album's level applies. A song kept on the device, or whose levelled stream fails, plays its own file at its own volume.
- **Formats a browser can't play** (Apple Lossless or AIFF in Chrome and Firefox) are fetched from `/stream/:id/lossless.wav` instead (`lib/playable.ts`). MP3, AAC and FLAC play natively everywhere. There's no transcoding yet, so anything else a browser can't play (Ogg or Opus on an older Safari, say) fails to play ([open items](plans/open-items.md)).
- **Media Session**: title, artist, album and cover (256 and 512 px), plus play, pause, stop, next, previous, seek back and forward, and seek-to, for lock screens and OS controls.
- **Accent and title**: the tab title follows the song. The accent colour and favicon come from the cover (`lib/color.ts`) unless Appearance fixes a colour.
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

A small ⤓ after a title marks songs on the device, and a ring shows the song downloading.

## 9. Prefetching

`lib/prefetch.ts` loads album, artist and playlist pages on intent:

- a mouse resting **80 ms** on a link;
- a pointer going down on one;
- keyboard focus.

That fetches the page's data, its header image, and for an album, its artist too. Preloaded image URLs are remembered, up to 300.

## 10. Settings panels

`pages/Settings.tsx` has nine tabs, and each says who it applies to:

| Panel | Scope |
|---|---|
| Sources | Server-wide; editable by admins (before setup, from the home network) |
| Playback | This device: transitions, crossfade, even volume, autoplay, counting plays, songs kept on the device, the shortcuts |
| Accounts | Server-wide: who signs in and what each account may hear and change |
| Your listening | Your account's stats and ListenBrainz |
| Mixes, Analysis, Requests, Updates | Server-wide ("These settings apply to everyone") |
| Appearance | This device: accent, motion, format badges |

Device settings live in `usePrefs` and `useOffline`; server-wide ones go through `/api/settings/*` (see [server/api.md](server/api.md)).

## 11. Testing

- `pnpm --filter @playarr/web test` runs Vitest (`vitest.config.ts`: happy-dom, relative URLs resolved against `PLAYARR_SERVER`, default `http://localhost:4000`, with a 20 s timeout). Unit tests sit next to their files.
- `src/smoke.test.tsx` renders every route against a **running server** and drives the player store. Without a server its tests return early and pass, so start `pnpm dev:server` first.
- `pnpm -C apps/web exec vitest run src/<file>` runs one file. `pnpm typecheck` checks the app and the service worker.
- **iOS Safari**: `pnpm sim` (`scripts/ios-sim/`) boots an iOS Simulator (default iPhone 17 Pro) and drives Safari through its Web Inspector socket, so it needs only Xcode. Commands: `boot [--show]`, `open <path>`, `click`, `fill`, `wait`, `eval`, `console [--errors]`, `shot` (to `/tmp/playarr-sim.png`), `shutdown`. It opens the NAS deployment unless `PLAYARR_URL` says otherwise. Taps are JavaScript clicks, not touches. Over plain HTTP, iOS Safari has no service worker, so offline features can't be tested there.

The native iOS app is separate: see [ios/README.md](ios/README.md).
