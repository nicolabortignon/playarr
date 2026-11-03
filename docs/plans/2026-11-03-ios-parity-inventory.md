# Web app inventory: the iOS parity checklist

Date: 2026-11-03. Gathered from the web app source (apps/web) for the native iOS app ([design](2026-11-03-ios-app-design.md)). Every route, setting, endpoint and player rule, with file references as of commit 6b9a23e. Each iOS phase plan draws its parity list from here.

**Method and caveats.** The knowledge and search tools were unavailable in this session (every `search_files` call failed with a certificate error). Everything below comes from reading files directly with Read and Glob. Absence claims are therefore unconfirmed. In particular, I could not grep for every `fetch(` call. Files not read are listed in section 11. Server-side behaviour is cited only where I read the server file. Paths are relative to the repository root.

---

## 1. Routes, pages and overlays

Route table: `apps/web/src/routes.tsx:17-43`. All routes sit under `AppShell` (`components/AppShell.tsx:32-63`). Routes marked *lazy* are code-split.

**Chrome (always mounted, `AppShell.tsx:36-59`).** Only one of these layouts mounts, chosen by `useDesktopLayout()` at 768px (`lib/useMediaQuery.ts:21`):
- Desktop: `Sidebar` (`components/Nav.tsx:42-143`) and `PlayerBar` (`components/PlayerBar.tsx:13-70`).
- Phone: `MiniPlayer` (`PlayerBar.tsx:98-137`) and `BottomNav` (`Nav.tsx:237-264`).
- Phone tabs are Home, Search, Library, Queue (`Nav.tsx:22-27`).
- Desktop sidebar links are Home, Search, Made for you, Artists, Albums, Favorites, Downloads, Queue (`Nav.tsx:10-19`). Requests appears only when requests exist (`Nav.tsx:79-97`). It also lists playlists with a "+" new-playlist button (`Nav.tsx:145-189`). Settings sits at the bottom, and the footer shows library counts, the Lidarr and Streaming status dots, a MusicBrainz queue indicator, and the app version (`Nav.tsx:191-235`).
- Always mounted: `NowPlaying` sheet, `StatsForNerds` overlay, `AddToPlaylistDialog`, `TrackMetadataDialog`, `MixPointsDialog`, `Toasts`, and `AudioEngine` (`AppShell.tsx:53-59`).

**Pages:**
- `/` **Home** (`pages/Home.tsx:20-137`). Shows a library line, "Shuffle everything" (300 random tracks, `player/actions.ts:26-29`), and "Resume" when paused. Sections, in order:
  - Who's listening chooser, shown when there are multiple profiles and none is picked (`Home.tsx:164-198`).
  - Year in review in December and January (`Home.tsx:208-230`).
  - Made for you mixes (`Home.tsx:143-156`).
  - Jump back in: recent albums, shown from 3 (`Home.tsx:233-246`).
  - Favorites: first 5 tracks (`Home.tsx:74-81`).
  - Playlists shelf.
  - Recently added albums.
  - Artists shelf, capped at 20 (`Home.tsx:249-268`).
  - Rediscover: 12 random albums, with a reshuffle button.
- `/search` **Search** (lazy, `pages/Search.tsx:12-167`). Library search with `?q=`, plus:
  - Top artist, tracks (6, with "show all"), matching playlist names, albums, artists.
  - "Try an artist" chips when empty (`Search.tsx:250-275`).
  - Discover section when Lidarr is set up: "Not in your library", with songs, albums and artists, each with request controls (`Search.tsx:170-241`).
- `/artists` **Artists** grid (`pages/Artists.tsx`).
- `/artists/:id` **Artist** (`pages/Artist.tsx:96-211`). Hero with Play and Shuffle. Album groups: Albums, Soundtracks, EPs & Singles, Live & Compilations, Loose songs (`Artist.tsx:17-34`). "Not in your library" from MusicBrainz, with Request buttons (`Artist.tsx:40-94`). Similar artists (`Artist.tsx:191`). About, with "Read more".
- `/albums` **Albums** grid, sorted by Artist, Title, Year or Recently added via `?sort=` (`pages/Albums.tsx:10-84`).
- `/albums/:id` **Album** (`pages/Album.tsx:18-176`). Header and Play/Pause/Resume, Shuffle, a ⋯ menu (Play next, Add to queue, Add to playlist, Go to artist), Download, and "Request the rest" (`Album.tsx:84-116`). Track list with disc headers and greyed-out missing tracks. Liner notes. "More by artist".
- `/favorites` **Favorites** (`pages/Favorites.tsx:10-65`). Play, Shuffle and Download, then the list with heart toggles.
- `/library` **Library hub** (`pages/Library.tsx:12-87`). Phone tab. Rows: Made for you, Your listening, Downloads (count), Favorites, Artists, Albums, Requests, Settings. Also a playlists list with "New playlist".
- `/playlists` **Playlists** grid, with "New playlist" and a hover Play (`pages/Playlists.tsx:22-75`).
- `/playlists/:id` **Playlist** (lazy, `pages/Playlist.tsx:24-213`). Actions:
  - Tap the cover to open "New cover" (`CoverPicker`).
  - Rename and describe inline (`Playlist.tsx:89-111`).
  - Play, Shuffle and Download.
  - ⋯ menu: Rename, Play next, Add to queue, New cover, Delete playlist (`Playlist.tsx:143-157`).
  - Drag to reorder, committed on drag end (`Playlist.tsx:58-61`).
  - Row ⋯ menu: Play next, Add to queue, Go to album, Go to artist, Show metadata, Remove from playlist (`Playlist.tsx:280-294`).
  - Unavailable rows are greyed out with "not in library".
  - "Songs like these" recommendations (`Playlist.tsx:180`).
  - Delete confirmation (`Playlist.tsx:184-210`).
- `/downloads` **Downloads** (lazy, `pages/Downloads.tsx:11-81`). Each download with progress and bytes. Play and Remove. Failed-song count.
- `/stats` **Your listening** (lazy, `pages/Stats.tsx:36-42`). Same content as the Settings panel (see section 2).
- `/mixes` **Made for you** (lazy, `pages/Mixes.tsx:9-43`). Grid of mixes, with a "Tune your mixes" link to `/settings/mixes`.
- `/mixes/:key` **Mix** (lazy, `pages/Mix.tsx:14-113`). Description, "changes in X" (`Mix.tsx:116-121`), Play, Shuffle, New mix (regenerate), Download, and ⋯ menu (Save as playlist, Play next, Add to queue). Save as playlist opens the new playlist.
- `/queue` **Queue** (lazy, `pages/Queue.tsx:22-107`). Now playing with `TransitionView` (see section 4). Up next with drag reorder, tap to jump, row ⋯ menu (Play next, Add to playlist, Go to album, Go to artist, Remove from queue). Clear with Undo. Save as playlist.
- `/requests` **Requests** (lazy, `pages/Requests.tsx:28-106`). Each request with live progress, a RequestButton, and remove-from-list (which does not change Lidarr).
- `/discover/artists/:mbid` **Discover artist** (lazy, `pages/DiscoverArtist.tsx:16-134`). MusicBrainz discography split into Albums and EPs & soundtracks. Shows the in-library count. `?album=` highlights one album. Similar artists. Retry on discography error.
- `/discover/artist?name=&album=` **Find artist** (lazy, `pages/FindArtist.tsx:8-40`). Resolves the name by lookup, then redirects to the artist or album.
- `/settings/:panel?` **Settings** (lazy). Nine panels; see section 2.
- `*` NotFound (lazy).

**Overlays and sheets:**
- **Now Playing** full-screen sheet (`components/NowPlaying.tsx:37-200`). Opened from the cover or the mini player.
  - Swipe down closes it when the drag passes 120px or 600px/s (`NowPlaying.tsx:85`). Escape closes it (`NowPlaying.tsx:56-67`).
  - Header: close, "Playing from" source (taps through to the source), sleep timer, lyrics toggle, and a ⋯ menu.
  - ⋯ menu items: Add to playlist, Start radio, Go to album, Go to artist, Show metadata, Edit mix points (only with DJ mix on), Open queue (`NowPlaying.tsx:128-139`).
  - Body: cover (or lyrics), title and artist, favorite, seek bar, transport, `TransitionView`, and "Up next" (desktop only, `NowPlaying.tsx:209`).
- **Lyrics** view, which replaces the cover in Now Playing (see section 5).
- **Sleep timer** menu (`components/SleepTimer.tsx:7-39`): 15, 30, 45, 60 and 90 minutes; "At the end of this song"; "Turn off the timer".
- **Transition sheet** (`components/TransitionView.tsx:120-176`). Opened from the "Next: …" line. Shows the style and reason, both songs' BPM and key, an energy picture around the mix, and the queue's mixing mode (Auto, Party, No mixing) (`TransitionView.tsx:22-26`).
- **Track ⋯ menu** (`components/TrackList.tsx:130-143`). Play next, Add to queue, Add to playlist, Start radio, Go to album (mixed lists only), Go to artist, Show metadata, and Edit mix points (DJ only, via `MixPointsDialog.tsx:114-118`).
- **Edit mix points** (`components/MixPointsDialog.tsx:125-298`). An energy strip with draggable In and Out markers. Each has "Play from" for an 8-second preview (`MixPointsDialog.tsx:38`). Reset and Save.
- **Add to playlist** (`components/AddToPlaylistDialog.tsx:11-99`). Create a new playlist, or add the songs to an existing one.
- **Show metadata** (`components/TrackMetadataDialog.tsx:13-325`). Song fields and IDs, files with path and source, tags, sound analysis. "Match again on MusicBrainz" or "Refresh in Lidarr".
- **Stats for nerds** overlay (`components/StatsForNerds.tsx:80-145`). Draggable and collapsible. Turned on in Settings → Appearance.
- **Toasts** (`components/Toasts.tsx`, not read).

---

## 2. Settings: panels and every setting

Panels are defined at `apps/web/src/pages/Settings.tsx:14-24`. The scope line under each is at lines 16-22. Settings is a tab bar with routes `/settings/<id>`.

**Per-device** means stored in localStorage, IndexedDB or Zustand persist, and never sent to the server. **Server** means it goes to the API.

| Panel (id) | Scope | Setting | Storage / endpoint | Source |
|---|---|---|---|---|
| Sources (`sources`) | Server | Source list (Lidarr or folder), reorder by drag, add, edit, remove, rescan, "Match again", review, organize. Remove confirms with `window.confirm` (`SourcesPanel.tsx:121-125`). | `GET/POST /api/settings/sources`, `PATCH/DELETE /api/settings/sources/:id`, `PUT /api/settings/sources/order`, `POST …/test`, `POST …/:id/rescan`, `POST …/:id/rematch`, `GET/POST …/:id/review`, `GET/POST …/:id/organize`, `POST …/organize/undo` | `SourcesPanel.tsx:37-102`, `LidarrForm` 372-461, `FolderForm` 474-700, `FolderBrowser` 702-777 |
| Sources | Server | Identifying songs: AcoustID key | `GET/PUT /api/settings/matching` | `SourcesPanel.tsx:218-275` |
| Playback (`playback`) | **Per-device** | Keep playing when the queue ends (autoplay) | Zustand `usePrefs.autoplay` (`lib/prefs.ts`) | `PlaybackPanel.tsx:49-63` |
| Playback | Per-device | Count what this device plays | `usePrefs.recordPlays` (gates `POST /api/plays`) | `PlaybackPanel.tsx:57-62` |
| Playback | Per-device | Even out the volume | `usePrefs.levelVolume` | `PlaybackPanel.tsx:74-79` |
| Playback | Per-device | Transitions: Off, Crossfade, DJ mix. Crossfade is disabled on devices where volume can't be set, such as iPhone (`PlaybackPanel.tsx:41-44`). | `usePrefs.transitions` | `PlaybackPanel.tsx:80-106` |
| Playback | Per-device | Crossfade length (3, 6, 9, 12 s) or DJ fade length | `usePrefs.crossfade` (`CROSSFADES` 0,3,6,9,12 at `prefs.ts:14`) | `PlaybackPanel.tsx:83-104` |
| Playback | Per-device | On this device: keep up to N (Off, 512 MB, 1, 2, 5, 10 GB; default 2 GB). "Remove all". | `useOffline.limit` (`player/offline.ts:13-14, 74-80`) | `components/OfflineStorage.tsx:10-93` |
| Playback | Per-device | Keyboard shortcuts (info only) | none | `PlaybackPanel.tsx:9-18, 109-130` |
| Profiles (`profiles`) | Server (who listens here is per-device) | List profiles; pick who listens on this device (radio); add, rename, remove | `GET/POST /api/profiles`, `PATCH/DELETE /api/profiles/:id`; pick is `usePrefs.profileId` | `ProfilesPanel.tsx:24-147`, `queries.ts:786-790` |
| Your listening (`listening`) | Server | Period: 4 weeks, 6 months, 12 months, all time, or a calendar year | `GET /api/stats?range=` | `pages/Stats.tsx:45-75` |
| Mixes (`mixes`) | Server (everyone) | Enable each of 12 mix kinds (`MixesPanel.tsx:13-26`) | `PUT /api/settings/mixes {enabled:{kind:bool}}` | `MixesPanel.tsx:66-187` |
| Mixes | Server | Time zone ("Use this device's" button) | `PUT /api/settings/mixes {timeZone}` | `MixesPanel.tsx:43-63` |
| Mixes | Server | Songs per mix: 25, 50, 75, 100 | `length` | `MixesPanel.tsx:28, 109` |
| Mixes | Server | Discovery Weekly: Familiar (0), Balanced (0.5), Adventurous (1) | `adventurous` | `MixesPanel.tsx:29-33, 110` |
| Mixes | Server | Blast from the past: 30, 90, 180, 365 days | `blastDays` | `MixesPanel.tsx:34-39, 112-116` |
| Mixes | Server | Genre mixes and decade mixes: 0–4 each | `genreMixes`, `decadeMixes` | `MixesPanel.tsx:40, 117-118` |
| Mixes | Server | Remember what's played (listening history) | `recordHistory` | `MixesPanel.tsx:126-132` |
| Mixes | Server | Clear history (confirm) | `DELETE /api/settings/mixes/history` | `MixesPanel.tsx:138-184` |
| Mixes | Server | ListenBrainz: connect with token, send plays on or off, send earlier plays, disconnect | `GET/PUT/DELETE /api/settings/listenbrainz`, `POST …/earlier` | `ListenBrainzSection.tsx:13-95` |
| Analysis (`analysis`) | Server | Analyse every song in the library (`analyzeLibrary`) | `PUT /api/settings/mixes` | `AnalysisPanel.tsx:203-227` |
| Analysis | Server | Run beats, sound, loudness or tags (each "Analyse the N left", plus "Reanalyse…" with a confirm); "Reanalyse everything" | `GET /api/analysis/progress` (polled), `POST /api/analysis/{beats\|sound\|loudness\|tags\|all} {again}` | `AnalysisPanel.tsx:66-165, 168-185, 238-321` |
| Requests (`requests`) | Server | Let people request albums (`enabled`); search on add (`searchOnAdd`); root folder, quality profile, metadata profile (or Lidarr's default) | `GET/PUT /api/settings/requests` | `RequestsPanel.tsx:14-124` |
| Appearance (`appearance`) | **Per-device** | Accent color: From album art, or fixed Orange, Rose, Violet, Sky, Green, Yellow (`lib/prefs.ts:7`) | `usePrefs.accent` | `AppearancePanel.tsx:6-35` |
| Appearance | Per-device | Motion: System, Reduced, Full | `usePrefs.motion` (sets `data-motion` and MotionConfig, `AppShell.tsx:19-30`) | `AppearancePanel.tsx:37-39` |
| Appearance | Per-device | Show audio format badges | `usePrefs.formatBadges` | `AppearancePanel.tsx:41-48` |
| Appearance | Per-device | Stats for nerds overlay | `usePrefs.statsForNerds` | `AppearancePanel.tsx:50-57` |
| Updates (`updates`) | Server (everyone; Docker only) | Automatic updates on or off; interval 15 min, hour, 6 h, day; check now; show last log | `GET/PUT /api/settings/updates`, `POST …/updates/check` | `UpdatesPanel.tsx:10-102` |

Per-device stores and where they live:
- `playarr.prefs`: `usePrefs` (`lib/prefs.ts:58`).
- `playarr.player`: the queue, order, position, shuffle, repeat, volume, muted, resume position, source, and mix mode (`player/store.ts:246-259`).
- `playarr.offline`: kept songs, downloads, and the limit (`player/offline.ts:76`).
- `playarr.pendingPlays`: unsent play reports, in localStorage (`player/playTracker.ts:9`).
- `playarr.queries`: the React Query cache in IndexedDB, 7-day retention. Only the keys in `KEPT` are persisted (`lib/queryClient.ts:12-15, 50-64`). Those keys are `artists`, `artist`, `albums`, `album`, `favorites`, `playlists`, `playlist`, `mixes`.

---

## 3. Server endpoints called by the web client

### 3a. The request wrapper and headers

`apps/web/src/lib/api.ts`:
- Every JSON call goes through `request()` (`api.ts:118-135`). Relative paths, same origin.
- **Anti-CSRF / "Playarr only" header:** `X-Playarr: 1` (`api.ts:121-124`). The comment says the server only accepts changes from Playarr's own pages. Server enforcement is not verified here.
- **Profile header:** `X-Playarr-Profile: <profileId>`, sent when `usePrefs.profileId` is set (`api.ts:126-127`). It is sent on every `request()` call, including GETs. It is not sent on `<audio>`, `<img>`, or service-worker fetches.
- `Accept: application/json`. `Content-Type: application/json` only when there is a body (`api.ts:125`).
- `keepalive: true` only for `POST /api/plays` (`api.ts:225-226`).
- Error handling: a non-2xx response is read as `{error?: string}` and thrown as `ApiError(message, status)` (`api.ts:109-116, 130-133`). A 204 returns `undefined`. Callers treat 403 as "outside the home network" (`queries.ts:375-381`, and similar).
- Time zone: `GET /api/mixes`, `/api/mixes/:key`, `POST /api/mixes/:key/regenerate` and `/save` add `?tz=<IANA zone>` (`api.ts:265-270`).

### 3b. Endpoints by feature

**Health and status**
- `GET /api/health`: Lidarr, media, library counts, `requests` flag (`api.ts:140`).
- `GET /api/musicbrainz/status`: queue size and ETA (`api.ts:141`).

**Library browse**
- `GET /api/artists`, `GET /api/artists/:id`, `GET /api/artists/:id/tracks` (`api.ts:142-144`).
- `GET /api/albums?sort=title|artist|year|added&limit=`, `GET /api/albums/random?limit=`, `GET /api/albums/:id` (`api.ts:145-148`).
- `GET /api/tracks/random?limit=` (`api.ts:149`).
- `GET /api/search?q=` (`api.ts:150-151`).
- `GET /api/plays/recent-albums` (`api.ts:232`).
- `GET /api/tracks/:id/metadata` (`api.ts:204`).
- `POST /api/files/:fileId/rematch` (`api.ts:205`).
- `GET /api/tracks/:id/lyrics` returns `{lyrics}` (`api.ts:233`).

**Discover and requests (Lidarr and MusicBrainz)**
- `GET /api/discover/search?q=` (`api.ts:152-153`).
- `GET /api/discover/artists/:mbid` and `…/:mbid/similar` (`api.ts:154-156`).
- `GET /api/discover/artist-lookup?name=` (`api.ts:157-158`).
- `GET /api/requests`, `POST /api/requests` (body: an `AlbumRef`), `DELETE /api/requests/:mbid` (`api.ts:159-162`).

**Favorites**
- `GET /api/favorites`, `PUT /api/favorites/:recordingId`, `DELETE /api/favorites/:recordingId` (`api.ts:163-167`). Optimistic toggle in `queries.ts:213-233`.

**Playlists**
- `GET /api/playlists`, `POST /api/playlists {name, description?, recordingIds?}` (`api.ts:168-170`).
- `GET /api/playlists/:id`, `PATCH /api/playlists/:id`, `DELETE /api/playlists/:id` (`api.ts:169-174`).
- `POST /api/playlists/:id/items {recordingIds}`, `DELETE /api/playlists/:id/items/:itemId` (`api.ts:175-178`).
- `PUT /api/playlists/:id/order {itemIds}` (`api.ts:179-180`).
- `PUT /api/playlists/:id/cover {layout, variant}` (`api.ts:181-182`).
- `GET /art/playlist/:id/preview?layout=&variant=`: a generated image, used by the cover picker (`api.ts:184`).
- `GET /api/playlists/:id/recommendations?variant=` (`api.ts:185-186`).

**Sources, folders and matching (Settings)**
- `GET /api/settings/sources` (`api.ts:187`).
- `POST /api/settings/sources`, `PATCH /api/settings/sources/:id`, `DELETE /api/settings/sources/:id` (`api.ts:188-192`).
- `PUT /api/settings/sources/order {ids}` (`api.ts:193-194`).
- `POST /api/settings/sources/test {id?, url?, apiKey?}` (`api.ts:195-196`).
- `POST /api/settings/sources/:id/rescan` and `…/rematch` (`api.ts:197, 208`).
- `POST /api/settings/folders/browse` (`api.ts:199-200`). `GET /api/settings/folders/access` (`api.ts:201-202`).
- `GET /api/settings/sources/:id/review`, `POST` with a `ReviewAction` (`api.ts:203, 206-207`).
- `GET /api/settings/sources/:id/organize`, `POST …/organize {moves}`, `POST …/organize/undo {batchId}` (`api.ts:209-213`).
- `GET/PUT /api/settings/matching {acoustidKey}` (`api.ts:214-216`).

**Settings: requests, updates, mixes, ListenBrainz, analysis**
- `GET/PUT /api/settings/requests` (`api.ts:217-219`).
- `GET/PUT /api/settings/updates`, `POST /api/settings/updates/check` (`api.ts:220-223`).
- `GET/PUT /api/settings/mixes`, `DELETE /api/settings/mixes/history` (`api.ts:271-273, 279`).
- `GET/PUT/DELETE /api/settings/listenbrainz`, `POST …/listenbrainz/earlier` (`api.ts:274-278`).
- `GET /api/analysis/progress`, `POST /api/analysis/{kind} {again}` (`api.ts:250-256`).

**Playback**
- `POST /api/plays {plays: PlayReport[]}` → `{recorded}` (`api.ts:225-226`). Called from `player/playTracker.ts:81-100`.
- `POST /api/levels {ids}` (≤50) → `Record<recordingId, TrackLevel>` (`api.ts:234`). Called from `player/levels.ts:26-40`.
- `POST /api/transitions {from, to, mode, position?, fromFileId?, toFileId?, fade?, albumQueue?, levels?}` → `TransitionAnswer` (`api.ts:242-249`).
- `POST /api/radio {seeds, exclude, count=25}` → `Track[]` (`api.ts:263-264`).
- `POST /api/mix-maps {ids}` (≤50) → `Record<recordingId, MixMap & {cues?}>` (`api.ts:258-259`).
- `PUT /api/recordings/:recordingId/cues {mixIn, mixOut}` (`api.ts:261-262`). Null clears a point.

**Profiles and stats**
- `GET/POST /api/profiles`, `PATCH/DELETE /api/profiles/:id` (`api.ts:227-230`).
- `GET /api/stats?range=` (`api.ts:231`).

**Made for you**
- `GET /api/mixes?tz=`, `GET /api/mixes/:key?tz=`, `POST /api/mixes/:key/regenerate?tz=`, `POST /api/mixes/:key/save?tz=` (`api.ts:265-270`).

**Media URLs (not `fetch`, used as `src`)**
- `GET/HEAD /stream/:fileId`, with `Range`. Server route at `apps/server/src/routes/stream.ts:49-82`. `Track.streamUrl` is used verbatim.
- `GET /stream/:fileId/levelled.wav?gain=<dB>`: a levelled WAV made on request (`stream.ts:86-89`; URL built at `player/levels.ts:62`).
- `GET/HEAD /transitions/:file`, with `Range` (`apps/server/src/routes/transitions.ts:63-88`). The name comes from the `url` in the transition answer.
- `GET /art/...`: covers, with `?size=N` added by `sized()` (`api.ts:291-296`). `&retry=1` after a failure (`components/Cover.tsx:31`). Playlist covers add `&title=0` under 120px (`components/PlaylistCover.tsx:15`).

**Raw `fetch` calls outside `api.ts`:**
- `player/offline.ts:185`: `fetch(track.streamUrl, {signal})` downloads a song for offline. No custom header.
- `player/AudioEngine.tsx:2158`: `fetch(audio.src, {headers:{Range:'bytes=0-1'}})` diagnoses a playback error.
- `player/liveMix.ts` imports `api` and fetches song audio. Its header comment says it fetches and decodes both songs (`liveMix.ts:9-11`). I did not read the fetch line itself.

### 3c. Service worker routing (`apps/web/src/sw.ts`)

- Navigation fallback to `/index.html`, denylist `/api/`, `/stream/`, `/art/`, `/transitions/` (`sw.ts:19`).
- `/art/` is CacheFirst in `playarr-art`, up to 1500 entries and 60 days (`sw.ts:21-27`).
- `/api/` is NetworkFirst in `playarr-api`, with a 4 s network timeout and 200 entries (`sw.ts:29-32`).
- `/stream/` and `/transitions/` answer from `playarr-audio` if the song is kept, with byte-range support. Otherwise they go to the network (`sw.ts:40-46`). Bucket names are in `lib/cacheNames.ts:2-5`.

---

## 4. Player responsibilities (`apps/web/src/player/`)

**Queue model (`player/store.ts`)**
- `queue: Track[]` in the order added. `order: number[]` is play order, as indices into `queue`. `pos` is the position in `order`, or -1 (`store.ts:14-35`).
- Also: `playing`, `shuffle`, `repeat: 'off'|'all'|'one'`, `volume` (0–1), `muted`, `restartToken`, `resumeAt`, `startAt`, `source: {label, href}` (for "Playing from"), and `mixMode: 'auto'|'party'|'off'` (`store.ts:6-35`).
- Persisted: `source`, `mixMode`, `queue`, `order`, `pos`, `shuffle`, `repeat`, `volume`, `muted`, `resumeAt` (`store.ts:245-259`). `playing` and `restartToken` are not persisted.
- Actions (`store.ts:38-60`):
  - `playTracks(tracks, startIndex, {shuffle, source, at})` (`store.ts:124-144`). Resets `mixMode` to `auto`.
  - `playNext`, `addToQueue`, `jumpTo`, `removeAt`, `move`, `setUpcoming`, `clearUpcoming`.
  - `next(auto)`: a press of Next is first offered to `takeNextPresses` (`store.ts:196-205`).
  - `prev(currentTime)`: restarts the song if past 3 s, else goes back (`store.ts:211-217`).
  - `toggleShuffle` keeps history and shuffles only what is upcoming (`store.ts:222-235`).
  - `cycleRepeat`: off → all → one → off (`store.ts:237-238`).
  - `setVolume` clamps to 0–1 and un-mutes (`store.ts:240`).
- Shuffle and "Play means in order": `actions.ts:14-18` makes Play always in order, and only Shuffle shuffles.
- Clock store `useClock`: `time`, `duration`, `buffered`, `loading`, `error`, `seekRequest` (`store.ts:284-302`). Not persisted.
- Helpers: `currentTrack`, `nextByPress` (`store.ts:269-281`).

**Audio engine (`player/AudioEngine.tsx`, 2171 lines)**
- Three `<audio>` elements: `a`, `b` (two decks) and `bridge` for DJ transitions (`AudioEngine.tsx:208-211, 2104-2110`). Playback is one element at a time, and the standby element preloads the next song.
- Gapless by default. Constants: `PRELOAD_S = 30` (preload the next song 30 s before the end, `:40`), `LEAD_MS = 30` (start the next song 30 ms early, `:42`), `OVERLAP_MS = 15` (`:44`).
- Crossfade (`transitions` = crossfade): `fadeSeconds` = min(crossfade, a.duration/3, b.duration/3), zero within an album played in order (`decks.ts:28-32`). Helper `crossfadeSeconds` at `lib/prefs.ts:126-127`.
- Volume curve: element volume is `volume²` times sleep gain times fade curve, where the fade curve is an equal-power sine (`decks.ts:55`, `AudioEngine.tsx:427`).
- Muted start: not found in the files I read.

**DJ transitions**
- Who asks, and when (`player/transitions.ts`):
  - It asks only after the current song has played 5 s (`MIN_PLAYED_S = 5`, `:14`), and waits 2 s before the first ask (`:16`).
  - Each ask is `api.transition(...)` (`transitions.ts:197`). It sends the song IDs, `mode`, `position` (frozen at the first ask), the file IDs, `fade`, `albumQueue`, and `levels` when even volume is on (`api.ts:242-249`).
  - It polls every 3 s for the first 5 polls, then every 10 s (`:18-21`).
  - Errors retry after 3 s, then 10 s (`:23`). "Unavailable" is asked once more after 60 s (`:25`).
  - It gives up 20 s before the mix point (`GIVE_UP_S = 20`, `:27`). Then the songs play the usual way.
  - Offline, it uses a kept transition if one exists (`transitions.ts:170-173`, `player/offline.ts:130-138`).
- Answer types (`lib/api.ts:59-78`): `ready` carries `plan`, `url`, optional `continuationUrl`, `tail`, `lead`, and `levels`. `pending` carries `plan` and `render` progress. `straight` carries `plan`. `unavailable` carries `reason`.
- Plan shape (`packages/mix/src/types.ts:91-122`): `style` (straight, long, quick, fade), `aStart`, `bStart`, `length`, `bResume`, `switchAt`, `bRate[]`, `aGain[]`, `bGain[]`, `aLowDb[]`, `bLowDb[]`, `aHighPassHz[]`, `reason`, `beats`. Automation points are `{at, value}` (`types.ts:89`).
- How the file is loaded:
  - `prepareBridge` (`AudioEngine.tsx:678-711`) sets `bridge.src = r.url`, which is a `/transitions/…` URL.
  - B's remainder, when there is a `continuationUrl`, loads into the standby element at offset `plan.bResume` (`loadRemainder`, `AudioEngine.tsx:308-315`). Otherwise B is cued at `plan.bResume` from its own file.
- The 3-second lead and tail:
  - The server defines `TRANSITION_TAIL_SECONDS = 3` (B alone after the transition) and `TRANSITION_LEAD_SECONDS = 3` (A alone before it) at `apps/server/src/transitions/transitions.ts:38` and `:45`.
  - The lead is "less for a transition starting sooner into A" (`transitions.ts:43`).
  - The client reads `lead` from the answer. The transition file starts at `aStart − lead`. Bridge time is `bridge.currentTime − lead` (`AudioEngine.tsx:279-281`).
  - The client reads `tail`. A tail of at least `MIN_TAIL_S = 1` s means B's own file starts in the tail, in step (`AudioEngine.tsx:106, 277`).
- Changeover timing (`AudioEngine.tsx`):
  - `approachBridge` (`:762-775`): starts the transition at `aStart − lead`, minus LEAD_MS.
  - `startBridgeInStep` (`:807-834`): the bridge starts silenced, then `inStep` locks it to A. A start watch of 1500 ms (`:104`) cancels a transition that doesn't start.
  - `approachSwitch` and `switchToB` (`:1080-1105`): the store moves to B at `switchAt`, and B is shown from then.
  - `approachLanding` and `land` (`:1108-1185`): B's own file takes over at `plan.length`. Lead is 0 when landing in the tail, else LEAD_MS.
  - `STALL_MS = 4000` (`:46`): a stuck transition is abandoned.
  - Stream retries: `STREAM_RETRIES = 3`, on the same song (`:110, 2048-2057`).
- Phones (no volume control): `startBridge` needs HAVE_METADATA, not HAVE_FUTURE_DATA (`AudioEngine.tsx:787-791`). Cuts are pre-rolled (`CUT_PRE_ROLL_S = 0.5`, `:108, 563-566`).
- Rendering: the server renders in the background, and the cache answers `pending` until ready (`transitions.ts:26-29`).

**Even volume (`player/levels.ts`)**
- `loadLevels` calls `POST /api/levels` for songs not known or asked within 15 s (`levels.ts:9, 26-40`). Results go into `useLevels` (Zustand, not persisted).
- `TrackLevel` (`packages/shared/src/index.ts:781-789`): `track` gain (dB), optional `album` gain, `lufs`, `peak`.
- Gain selection (`decks.ts:38-44`): within an album played in order, the album gain applies; otherwise the track gain.
- Levelled stream: `streamGain` returns a gain only if levelling is on, the song is not kept offline, and `streamUrl` starts with `/stream/` (`levels.ts:55-59`). The URL is `${streamUrl}/levelled.wav?gain=${db}` (`levels.ts:62`). Works on iPhone too (`AudioEngine.tsx:292`).
- Fallback: `levelledStreamFailed` switches a song to its own file (`levels.ts:42-48`, `AudioEngine.tsx:2020-2033`).
- Own-file level on devices that can set volume: `levelGain`, down only (`decks.ts:50-52`).

**Live mix (desktop only)**
- A press of Next can be mixed live with Web Audio when no server transition is ready (`AudioEngine.tsx:1307-1355`, `player/liveMix.ts`). Gated by `canLiveMix()`, which requires `isDesktop()` and a settable volume (`liveMix.ts:62-70`). Phones never take it.
- Web Audio graph and join measurement (`player/joinGraph.ts`): desktop only. Never used on phones, because an element routed through Web Audio goes silent when a phone screen locks (`AudioEngine.tsx:455-458`).

**Radio continuation (`player/radio.ts`)**
- Autoplay (`useAutoplay`, `radio.ts:28-48`): when the last song of the queue starts, repeat is off, and autoplay is on, it asks `POST /api/radio` with `seeds` = the last 5 played recordingIds and `exclude` = the queue's recordingIds. The result is appended with `addToQueue` if the listener is still on that last song.
- Start radio (`radio.ts:12-22`): `POST /api/radio` with seeds `[recordingId]`, then plays `[track, ...more]` with source `"<title> radio"`.

**Sleep timer (`player/sleep.ts`)**
- Stores `endsAt` (epoch ms) or `endOfSong` (`sleep.ts:9-26`). The music fades over the last 20 s (`SLEEP_FADE_MS = 20000`, `:7`). At zero it pauses and shows a toast "Sleep timer: music stopped" (`sleep.ts:43-57`).
- "End of song": at the end of the song, `next(true)` then pause (`AudioEngine.tsx:2001-2007`). Also prevents a transition from being prepared (`transitions.ts:251-252`).

**Media Session (`AudioEngine.tsx:1870-1920`)**
- Metadata: title, artist, album, and artwork at 256 and 512 px, from `coverUrl` with `?size=` (`:1876-1887`).
- Action handlers: play, pause, stop, nexttrack (`next()`), previoustrack (`prev(currentTime)`), seekbackward and seekforward (default 10 s), and seekto (`:1899-1908`).
- `playbackState` follows `playing`. Position state comes from `updatePositionState` (`:2139-2146`).

**Scrobbling and play reporting (`player/playTracker.ts`)**
- A song counts as played when heard for at least 30 s or half its length, whichever is shorter (`PLAY_SECONDS = 30`, `:6`; rule at `:56`).
- A song counts as skipped when it changes before it counts as played, after at least 3 s heard (`SKIP_FROM_SECONDS = 3`, `:8`; rule at `:57`).
- Reports go out when a song stops being current: reason `ended`, `changed`, or `closed` (`playTracker.ts:51-71`). The close on `pagehide` is at `AudioEngine.tsx:1855-1860`.
- Heard time counts only steps between 0 and 2 s, so seeks don't count (`playTracker.ts:41`).
- Sent as `POST /api/plays {plays}` with keepalive. Unsent reports stay in localStorage (max 300) and are retried (`playTracker.ts:74-120`). Only when `recordPlays` is on (`playTracker.ts:122-125`).
- The ListenBrainz forwarding rule ("half its length, or four minutes") is stated in the UI (`ListenBrainzSection.tsx:32-33`). The forwarding itself is server-side and was not read.

**Prefetch of next songs (`player/loadAhead.ts`, `player/AudioEngine.tsx:504-515`)**
- The standby element gets the next song's file (`AudioEngine.tsx:504-515`), along with its mix maps (DJ mix) and its level.
- Offline keep-ahead: up to 3 upcoming songs plus the current one (`AHEAD = 3`, `loadAhead.ts:10`). Settles 2.5 s before replanning (`:12`). Nothing ahead on data saver, 2G, or offline. One song on cellular (`loadAhead.ts:46-51`).
- Cover prefetch: the next song's cover at 44, 56 and 96 px. Also 300 and 560 px when Now Playing is open (`loadAhead.ts:14-15, 88-92`).
- Page prefetch on hover (80 ms), pointer-down, or focus (`lib/prefetch.ts:7, 23-70`). Covers album, artist and playlist pages.

**Offline downloads (`player/offline.ts`, `player/downloads.ts`, `sw.ts`)**
- Kept songs (`keepSong`, `offline.ts:175-224`): `fetch(track.streamUrl)`, then stored in Cache Storage bucket `playarr-audio` under the stream URL. Metadata in `useOffline.songs`: URL, bytes, last-used time. Eviction is least-recently-used (`offline.ts:153-166`).
- Downloads (`addDownload`, `offline.ts:255-265`): albums, playlists, mixes and Favorites. Their songs are pinned and do not count toward the limit. Downloads also keep the transitions between consecutive songs (`keepTransition`, `offline.ts:286-326`).
- Transition files are cached under a negative hash of their URL (`transitionFileId`, `offline.ts:103-115`).
- The worker (`downloads.ts`) fetches songs one at a time (`pump`, `downloads.ts:165-197`), then transitions in `auto` mode (`TRANSITION_MODE`, `downloads.ts:25`). It asks until ready, polling every 3 s for 5 polls then every 10 s, and gives up after 10 minutes (`downloads.ts:27-32, 128-140`).
- Storage persistence: `navigator.storage.persist()` is requested once (`offline.ts:392-398`). Room is checked with `navigator.storage.estimate()` (`offline.ts:365-390`).
- Kept songs play from disk only through the service worker, and only when `workerReady()` (`offline.ts:26-27`). The service worker never stores audio itself (`sw.ts:34-39`).
- Reconcile on load: `reconcileOffline` drops entries the browser cleared (`offline.ts:336-345`).

**Stream error handling (`AudioEngine.tsx:2015-2041, 2048-2057, 2114-2170`)**
- Levelled stream failed: fall back to the song's own file from the same time.
- Offline and the song is not kept: skip to the next kept song, with a toast (`skipToKept`, `AudioEngine.tsx:2114-2126`).
- Otherwise, retry the stream up to 3 times from the same position (`retryStream`).
- After retries, `reportError` fetches the file with `Range: bytes=0-1` to explain the failure, then shows one of: the server's error message; "kept breaking off"; "couldn't be decoded"; "format not supported"; or "Cannot reach the Playarr server" (`AudioEngine.tsx:2153-2170`).
- Autoplay refused: `play()` on `NotAllowedError` sets `playing` to false (`AudioEngine.tsx:2128-2137`).

---

## 5. Lyrics, accent, playlist covers, Stats for nerds

**Synced lyrics** (`components/LyricsView.tsx`)
- Data: `GET /api/tracks/:id/lyrics` returns `{lyrics: Lyrics | null}` (`api.ts:233`). Cached once per song, with `staleTime: Infinity` and `retry: 1` (`lib/queries.ts:489-490`).
- `Lyrics` type (`packages/shared/src/index.ts:809-818`): `synced?: {at, text}[]`, `plain?`, `instrumental?`, `source: 'file' | 'lrclib'`.
- Rendering: the line playing is the last line whose `at` is ≤ time + 0.15 s, found by binary search (`LyricsView.tsx:8-20`).
- Auto-scroll follows the current line, but pauses for 4 s after the user scrolls by hand (`LyricsView.tsx:57-62, 64`).
- Tap a line to seek there (`LyricsView.tsx:77`).
- States: loading skeleton, "Lyrics are unavailable right now", "No lyrics found", "Instrumental", plain text, or synced (`LyricsView.tsx:27-46`).
- Credit: "Lyrics from LRCLIB" (links to lrclib.net) or "Lyrics from the file" (`LyricsView.tsx:94-109`).

**Accent color from album art** (`lib/color.ts`, `player/AudioEngine.tsx:1923-1944`)
- Setting `accent`: `'album'` (default), or one of the fixed colors.
- For `'album'`, the cover is loaded at 96 px and drawn to a 32×32 canvas (`color.ts:10-27`). Pixels are bucketed into 12 hue bins, weighted by saturation and mid-lightness, and near-black or near-white pixels are dropped (`color.ts:30-41`).
- The winning hue is clamped to saturation 0.45–0.9 and lightness 0.56–0.68 (`color.ts:47-50`). Output is an `hsl(...)` string.
- Result sets CSS variable `--accent` on `<html>` and the favicon (`AudioEngine.tsx:1923-1944`). Default is `#ff7a1a` (`AudioEngine.tsx:38`).
- Album pages use the same extraction for a header tint (`lib/color.ts:74-85`, `pages/Album.tsx:41-48`).

**Playlist cover generation: server-side**
- The cover is generated on the server from what the playlist's songs sound like. `PlaylistCoverInfo` (`packages/shared/src/index.ts:263-285`) carries `url` (versioned), `layout`, `variant`, `frozen`, `stale`, `tempo`, `energy`, `styles`, `era`, `analyzed`, `total`, and `pending`.
- Layouts: `ridges`, `grooves`, `blocks`, `horizon`, `currents`, `colonies` (`index.ts:260`). The picker offers six (`components/CoverPicker.tsx:9-16`).
- Preview: `/art/playlist/:id/preview?layout&variant` (`api.ts:184`). Save: `PUT /api/playlists/:id/cover` (`api.ts:181-182`).
- While `cover.pending` is true, playlist queries poll every 4 s (`queries.ts:245-261`).
- The client only displays the image and a short description (`pages/Playlist.tsx:309-340`).

**Mix covers: client-side.** `components/Mixes.tsx:12-41` draws up to four album covers under a tinted gradient from the mix's `hue` (an OKLCH hue from the server), with the title on top.

**Stats for nerds** (`components/StatsForNerds.tsx:198-309`). Draggable, collapsible overlay. Header shows BPM, key, bar.beat, and LUFS. Groups:
- **Song:** title, track and file IDs, recording ID, source name and path.
- **Playback:** position and total, loading, playing or paused; buffer ahead; stream type (live mix, DJ transition made on the server, the rest after a transition, levelled WAV at a dB gain, own file, or own file kept on device); element state (readyState, volume, rate); element URL; format; transitions mode; the last "mix in" and "mix out" changeover reports.
- **Rhythm:** tempo (BPM and ms per beat), beat confidence, steady or wandering, holds or drifts where mixed, beat model or onsets, bar confidence and first beat, the current bar, beat and phrase, and phrase drift.
- **Key:** Camelot code with name and confidence.
- **Structure:** section (intro, main, past the drop, outro, silence), audible range, intro and outro with cold start or cold end, first drop, mix points if set by hand, a phrase energy strip with intro and outro markers, and the mix map version.
- **Loudness:** measured LUFS and peak, track and album gains, what is applied (in the stream, by volume, or none), and the level heard at.
- **Sound:** energy, dynamics, brightness, busyness, bass, genres.
- **Next:** next song, and the transition status (planning, being made with a percentage, ready, straight on, unavailable, gave up), style, mix point, length, next takes over at, and the next song's rate.

---

## 6. Discover, search and requests

**Local search** (`pages/Search.tsx`): `GET /api/search?q=` runs on any non-empty query (`lib/queries.ts:101-107`). Playlist names are matched client-side, accent-insensitively (`Search.tsx:244`).

**Discover (Lidarr, MusicBrainz, Deezer)** (`components/Discover.tsx`):
- `GET /api/discover/search?q=` runs when the query is at least 2 characters. It is debounced 450 ms in `DiscoverSection` (`Search.tsx:170-172`). Cached 60 s, no retry (`queries.ts:109-117`).
- Shown only when Lidarr is set up (`useHasLidarr`, `queries.ts:364-367`).
- Results exclude albums already available, and artists already in the library (`Search.tsx:174-175`).

**Discover artist**: `GET /api/discover/artists/:mbid` (`queries.ts:119-125`). Similar artists come from `GET /api/discover/artists/:mbid/similar`, cached an hour (`queries.ts:127-135`). Name lookup: `GET /api/discover/artist-lookup?name=` (`queries.ts:137-143`).

**Request button** (`components/Discover.tsx:17-145`). One control for every state. Labels in order:
- Request (`none`).
- "N/M" or "N here" with a Request (`partial`).
- Requesting, then Looking up after 2 s (`request.isPending`, slow flag at `Discover.tsx:32`).
- Searching (`searching`).
- A percentage (`downloading`).
- Importing (`importing`).
- Search again (`waiting`).
- Retry (`failed`).
- In library (`available`).
- Hidden when requests are off in Settings or there is no Lidarr (`Discover.tsx:47`).

`AvailabilityState` values: `available`, `partial`, `searching`, `downloading`, `importing`, `waiting`, `failed`, `none` (`packages/shared/src/index.ts:161-169`).

**Request flow:**
- `POST /api/requests` with an `AlbumRef` (`queries.ts:183-200`). It toasts "Lidarr is searching for it" or "Lidarr will search on its schedule", then invalidates requests and discover.
- `DELETE /api/requests/:mbid` removes an item from the list, without changing Lidarr (`pages/Requests.tsx:60-66`).

**Progress polling** (`queries.ts:145-155`): `GET /api/requests` is polled every 10 s while any request is searching, downloading or importing. Otherwise it is polled every 60 s. Stale after 5 s.

**Completion** (`queries.ts:157-178`): `useWatchRequests` runs once in AppShell. When a request turns `available`, it invalidates albums, artists, artist, health, search, discover, discover-artist and recommendations, then toasts "“Title” is ready to play".

**MusicBrainz queue**: `GET /api/musicbrainz/status`, polled every 1.5 s while lookups are queued, else every 15 s (`queries.ts:36-43`). Shown in the sidebar footer (`Nav.tsx:221-232`).

**Requests panel and page**: `pages/Requests.tsx`. The request row shows its message, "Ready to play", or the state, plus "requested <time>". A download bar appears while downloading (`Requests.tsx:60-106`).

---

## 7. Profiles

- The chosen profile is `usePrefs.profileId` (per device, in `playarr.prefs`). `null` until picked (`lib/prefs.ts:40-41, 80`).
- Sent as the `X-Playarr-Profile: <id>` header on every `request()` call when set (`api.ts:126-127`).
- Also sent in the body of each play report, as `PlayReport.profile` (`player/playTracker.ts:68`; `packages/shared/src/index.ts:709-710`).
- Not sent on `<audio>`, `<img>`, or service-worker fetches (`/stream`, `/art`, `/transitions`, `/levelled.wav`). Those are plain GETs with no custom headers.
- The effective profile is `usePrefs.profileId` matched against the list, falling back to the first profile (`components/ProfilesPanel.tsx:17-21`).
- Switching: `switchProfile(id)` sets the pref and resets `mixes`, `mix`, `stats`, `recent-albums`, `mix-settings`, `listenbrainz` so no one else's data stays on screen (`lib/queries.ts:783-790`).
- Home shows a one-time chooser when there are several profiles and none is picked (`pages/Home.tsx:164-198`). Afterwards it shows "Not X? Listen as Y" links.
- Profile names are unique per device choice only. Each profile has its own mixes, stats, history and ListenBrainz account. Favorites and playlists are shared (`ProfilesPanel.tsx:42-44`).
- The server's interpretation of a missing profile header is not verified here.

---

## 8. Keyboard shortcuts (desktop only)

Global listener: `player/useKeyboardShortcuts.ts:8-75`. Ignored inside inputs and when Cmd, Ctrl or Alt is held.

| Key | Action | Source line |
|---|---|---|
| Space | Play or pause (not when a button, link or slider has focus) | `:25-29` |
| ← / → | Seek back or ahead 10 s | `:30-39` |
| Shift+← / Shift+→ | Previous or next song | `:32, 37` |
| ↑ / ↓ | Volume ±5% (not on a slider) | `:40-48` |
| M | Mute or unmute | `:50-53` |
| S | Shuffle on or off | `:54-57` |
| L | Favorite or unfavorite the song playing | `:58-65` |
| / | Go to Search | `:66-69` |

Other keyboard handling in the UI:
- Escape closes Now Playing (`NowPlaying.tsx:56-67`).
- Mix point markers: arrows move one bar (Shift: one phrase, or 10 s without a beat), PageUp and PageDown move a phrase, Home and End jump to the ends (`MixPointsDialog.tsx:416-432`).
- Menus: Up, Down, Home, End move between items (`Menu.tsx:67-75`).
- Settings lists this set at `PlaybackPanel.tsx:9-18`.

---

## 9. iOS-specific handling already in the web code

- **Install and icons:** `index.html:7-10` sets `apple-mobile-web-app-capable`, `black-translucent` status bar, and `apple-touch-icon` at `/icons/apple-touch-icon.png`. The manifest (`vite.config.ts:37-51`) sets `display: standalone` and icons.
- **Safe areas:**
  - AppShell main bottom padding includes `env(safe-area-inset-bottom)` for the tab bar and mini player (`AppShell.tsx:42`).
  - BottomNav (`Nav.tsx:241`).
  - MiniPlayer position (`PlayerBar.tsx:108`).
  - Now Playing top and bottom padding (`NowPlaying.tsx:103`).
  - Sticky Search header top padding (`Search.tsx:35`).
  - Stats overlay top offset (`StatsForNerds.tsx:124`).
- **Viewport:** `min-h-dvh` (`AppShell.tsx:42`) and `dvh` heights (`StatsForNerds.tsx:215`, `OrganizeDialog.tsx:114`).
- **No volume control on iPhone and iPad:** `canSetVolume()` probes whether `audio.volume` sticks (`player/decks.ts:57-66`). Where it doesn't:
  - No fades: `handOff` uses seconds 0 (`AudioEngine.tsx:615`). Overlaps stop the old file (`AudioEngine.tsx:866`).
  - Crossfade is disabled in Settings (`PlaybackPanel.tsx:41-44`).
  - No level-by-volume. Levelling uses the levelled WAV streams instead (`AudioEngine.tsx:292`, `levels.ts:55-59`).
  - Cuts are pre-rolled by 0.5 s (`AudioEngine.tsx:563-566`).
  - In-step transition start needs only HAVE_METADATA (`AudioEngine.tsx:787-791`).
- **Desktop-only detection:** `isDesktop()` (`decks.ts:74-80`) excludes iPhone, iPad, iPod, Android and "Mobile" user agents. It also excludes iPadOS "Macintosh" with multi-touch, and requires `pointer: fine`. Web Audio graph and live mix only run on desktop (`AudioEngine.tsx:460-462`).
- **First-tap readiness:** the first pointer or key press anywhere plays a silent clip in each element, so later songs can start on their own, such as with the screen off (`AudioEngine.tsx:1571-1598`). The silent clip is a generated 0.1 s WAV blob (`decks.ts:84-105`).
- **Playback rate nudging:** during in-step changeovers the follower's `playbackRate` is set to `1 + gap/0.1`, clamped to 0.5–2 (`AudioEngine.tsx:1054`).
- **Autoplay refusal:** a `NotAllowedError` from `play()` leaves the player paused (`AudioEngine.tsx:2128-2137`).
- **Touch targets:** `max-md:size-11` on menu and favorite buttons (`Menu.tsx:90`, `FavoriteButton.tsx:20`, `SleepTimer.tsx:29`).
- **Hover-free on touch:** `pointer-coarse:opacity-100 pointer-coarse:transition-none` on covers (`Cover.tsx:87`). Play buttons on cards are hidden on phones (`Cards.tsx:61`).
- **Layout split:** one layout mounts at a time, at 768px (`AppShell.tsx:37-38`, `useMediaQuery.ts:21`).
- **Update reload policy:** reloads the app only if it was just opened or is hidden and not playing (`lib/appUpdate.ts:14-33`).
- **Offline rules:** no keep-ahead on data saver or 2G, one song on cellular (`loadAhead.ts:46-51`). Kept songs need a secure context (`offline.ts:24`). Storage persistence is requested (`offline.ts:394-398`).
- **Play reports** use `keepalive` (`api.ts:225-226`). Sent on `pagehide` (`AudioEngine.tsx:1855-1860`).
- **Reduced motion:** `MotionConfig` follows the Motion setting (`AppShell.tsx:19-30`).
- **Lock screen:** Media Session (section 4).
- **Layout breakpoints:** `md` is 768px in Tailwind. Phone is below.

Not found in the files I read: a muted start for the audio elements, and any other iPhone-specific audio workaround.

---

## 10. Shared types (`packages/shared/src/index.ts` and `range.ts`) and mix types

Shared types are in `packages/shared/src/index.ts`. Line ranges below are in that file. Mix types are in `packages/mix/src/types.ts`.

**Core library**
- `AudioFormat` (3–11): `codec`, `container`, `bits?`, `sampleRate?`, `bitrate?`, `channels?`, `lossless`. Used inside `Track`, `Album.format`, and `TrackCopyMetadata.format`.
- `Artist` (13–26): `GET /api/artists`, `GET /api/artists/:id`, search results, stats top artists.
- `Album` (28–52): `GET /api/albums`, `…/random`, search, `ArtistDetail.albums`, recent albums, stats.
- `Track` (54–72): `recordingId`, `fileId`, `streamUrl`, `coverUrl?`, `format`, `size`, `duration`, `explicit`, plus IDs. Used by album and artist track lists, random, search, favorites, mixes, radio, and playlist items.
- `ArtistDetail` (74–76), `AlbumDetail` (78–84) with `tracks` and `missingTracks`, `MissingTrack` (87–93): `GET /api/artists/:id`, `GET /api/albums/:id`.
- `SearchResults` (95–99): `GET /api/search`.
- `LibraryStats` (101–108) and `HealthStatus` (110–118): `GET /api/health`.
- `AlbumSort` (120): `title`, `artist`, `year`, `added`.
- `FavoriteTrack` (122–124): `GET /api/favorites`.

**Requests and Lidarr settings**
- `RequestSettings` (128–136), `RequestSettingsPatch` (139–145), `RequestSettingsInfo` (148–157): `GET/PUT /api/settings/requests`.

**Discover and requests**
- `AvailabilityState` (161–169) and `Availability` (171–181): embedded in `DiscoverAlbum`, `DiscoverTrack`, `AlbumRequest`, `RecommendedTrack`.
- `DiscoverAlbum` (183–193), `DiscoverArtist` (195–203): `GET /api/discover/search`, `…/artists/:mbid`, `…/:mbid/similar`.
- `AlbumRef` (206–213): body of `POST /api/requests`, and of `POST /api/requests` for rest-of-album requests.
- `DiscoverTrack` (215–228), `ArtistMatch` (231–234): `GET /api/discover/artist-lookup`.
- `DiscoverResults` (236–240): `GET /api/discover/search`.
- `DiscoverArtistDetail` (242–247): `GET /api/discover/artists/:mbid`.
- `AlbumRequest` (249–256): `GET /api/requests`.

**Playlists and recommendations**
- `CoverLayout` (260) and `PlaylistCoverInfo` (263–285): embedded in `PlaylistSummary`.
- `PlaylistSummary` (287–295): `GET /api/playlists`.
- `PlaylistItem` (297–306) and `PlaylistDetail` (308–310): `GET /api/playlists/:id` and every playlist mutation.
- `RecommendedTrack` (314–330) and `Recommendations` (332–338): `GET /api/playlists/:id/recommendations`.

**Sources, folders and matching**
- `SourceKind` (344), `FolderAccessKind` (346), `SourceInfo` (348–381), `SourcesResponse` (383–387): `GET /api/settings/sources`.
- `SourceInput` (389–406): create and update source bodies.
- `SourceTestResult` (408–412): `POST /api/settings/sources/test`.
- `FolderListing` (415–425), `FolderBrowseRequest` (546–559), `FolderAccessOptions` (562–565): folder browse and access.
- `ReviewFile` (429–435), `ReviewCandidate` (437–470), `ReviewGroup` (472–480), `ReviewAction` (482–490): the review endpoints.
- `MatchingSettings` (492–497): `GET/PUT /api/settings/matching`.
- `MusicBrainzStatus` (500–509): `GET /api/musicbrainz/status`.
- `OrganizeMove` (513–521), `OrganizeSkip` (523–527), `OrganizePlan` (529–537), `OrganizeResult` (539–543): organize endpoints.

**Updates**
- `UpdateInterval` (568), `UpdateSettings` (571–574), `UpdateInfo` (576–595): `GET/PUT /api/settings/updates`.

**Song metadata**
- `FileTags` (600–615), `TrackCopyMetadata` (618–641), `RematchResult` (644–656): `POST /api/files/:fileId/rematch`.
- `TrackMetadata` (659–693): `GET /api/tracks/:id/metadata`.

**Made for you and listening**
- `PlayReport` (698–712): body of `POST /api/plays`.
- `MixKind` (714–726): 12 kinds (vibes, discovery, repeat, blast, deepcuts, fresh, decade, genre, energy, winddown, focus, onthisday).
- `MixSummary` (728–746): `GET /api/mixes`, and the `MixCard` on Home.
- `MixDetail` (748–750): `GET /api/mixes/:key`, regenerate, and save (which returns `PlaylistDetail`).
- `MixSettings` (752–769) and `MixSettingsInfo` (771–775): `GET/PUT /api/settings/mixes`.
- `TrackLevel` (781–789): `POST /api/levels`.
- `ListenBrainzInfo` (792–807): `GET/PUT/DELETE /api/settings/listenbrainz`.
- `Lyrics` (810–818): `GET /api/tracks/:id/lyrics`.
- `StatsRange` (821) and `ListeningStats` (824–852): `GET /api/stats`.
- `Profile` (855–858): `GET/POST/PATCH/DELETE /api/profiles`.

**Mix package** (`packages/mix/src/types.ts`)
- `MixMap` (8–76): `POST /api/mix-maps` values. `MIX_MAP_VERSION = 8` (`types.ts:2`). The web polls until stored maps reach this version (`queries.ts:499-515`).
- `CuePoints` (79–82): `mixIn?`, `mixOut?`. Used by `PUT /api/recordings/:id/cues` and inside mix maps.
- `TransitionStyle` (84): `straight`, `long`, `quick`, `fade`.
- `MixMode` (86): `auto`, `party`, `off`.
- `Automation` (89): `{at, value}[]`.
- `TransitionPlan` (91–122): see section 4.

**Web-client-only types** (`apps/web/src/lib/api.ts`)
- `TransitionAnswer` (59–78): `POST /api/transitions`.
- `AnalysisKind` (81): `beats`, `sound`, `loudness`, `tags`.
- `AnalysisProgress` (84–107): `GET /api/analysis/progress`.

**Other shared exports:** `packages/shared/src/range.ts` exports `ByteRange` and `parseRange`, used by the server and service worker for byte ranges. Not an API type.

---

## 11. Gaps and what would confirm them

- **Search unavailable:** all `search_files` calls failed in this session. Absence claims (for example "no other `fetch(` calls") are unconfirmed. Running a repo-wide search for `fetch(`, `X-Playarr`, and `/api/` in `apps/web/src` would settle this.
- **Files not read:** `pages/NotFound.tsx`; `components/Dialog.tsx`, `Section.tsx`, `Toasts.tsx`, `SlowLookup.tsx`, `Equalizer.tsx`, `Tempo.tsx`, `EnergyStrip.tsx`, `ColumnChart.tsx`, `SettingsControls.tsx`, `Slider.tsx`, `FormatBadge.tsx`, `OfflineMark.tsx`, `InlineLink.tsx`; `lib/toast.ts`, `favicon.ts`, `format.ts`, `useIncremental.ts`, `useDelayedFlag.ts`, `useDebounced.ts`, `rangeResponse.ts`, `cn.ts`; `player/mixSequence.ts`, `joinGraph.ts` (past line 80), `liveMix.ts` (past line 70), `liveMix.worker.ts`.
- **Server routes not mapped:** only the server files that define the stream, levels, and transitions routes were read. The other endpoints' exact response shapes come from the shared types, not from the server code.
- **Unverified server behaviour:** that `X-Playarr` is enforced, what happens without `X-Playarr-Profile`, and what the server does with `tz`.
- **Background, not separately verified:** `player/AudioEngine.tsx` is 2171 lines. I read all of it, but the helper modules it calls into (`mixSequence.ts`, `joinGraph.ts`, `liveMix.ts`) were read only partly.
