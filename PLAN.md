# Playarr — Project Plan

A modern, responsive music player for the web that uses a **Lidarr** library as its source.
It should work on mobile (touch, installable PWA, lock-screen controls) and desktop (keyboard, wide multi-pane layout).

---

## 1. Key constraint: Lidarr does not stream audio

Lidarr's API (`/api/v1`) covers **library metadata**: artists, albums, tracks, track files (with filesystem paths), and artwork.
It has **no endpoint that serves audio bytes**. So Playarr needs a small **companion server** that:

1. Proxies the Lidarr API, so the API key stays server-side and the browser doesn't hit CORS.
2. Resolves `trackFileId → path` through Lidarr and **streams the file from disk**, with HTTP Range support for seeking.
3. Transcodes with ffmpeg when the browser can't play the source format, or to save bandwidth on mobile.
4. Stores Playarr-only data (favorites, playlists, play history, settings) in SQLite.

The server must be able to **read the same music files Lidarr manages**. Path mapping is configurable (Lidarr path → local path).

```
┌──────────────┐  HTTPS/HTTP   ┌─────────────────────────┐   X-Api-Key   ┌──────────┐
│  Web client  │ ────────────▶ │     Playarr server      │ ────────────▶ │  Lidarr  │
│ (React PWA)  │ ◀──────────── │  /api/*  /stream/:id    │ ◀──────────── │  :8686   │
└──────────────┘  JSON, audio  │  /art/*  (cache)        │   metadata    └──────────┘
                               │  SQLite (user data)     │
                               └───────────┬─────────────┘
                                           │ read-only
                                    ┌──────▼───────┐
                                    │ Music files  │ (same volume Lidarr uses)
                                    └──────────────┘
```

---

## 2. Environment (dev)

| Item | Value / Status |
|---|---|
| Lidarr | `http://192.168.1.103:8686`: Lidarr 3.1.6, running in Docker (Alpine). API sends `Access-Control-Allow-Origin: *` |
| Lidarr API key | ✅ in `.env` (gitignored) |
| Library | Root folder `/data/media/music` (path inside the container). On 2026-10-27: 9 artists (6 with files), 112 albums (30 with files), 412 tracks, 10.3 GB, ~31 h |
| Formats | FLAC 16/44.1 (185), MP3 320 (174), FLAC 24-bit 44.1/48/88.2 (53). All play natively in browsers, so transcoding is optional |
| Artwork | `/api/v1/mediacover/...` serves full-size images only (`cover-250.jpg` is the same file), so Playarr resizes them itself |
| NAS | UGREEN DXP2800 (UGOS, Debian 12, OpenSSH 9.2). The Docker stack is defined in `/volume1/docker/media-stack/docker-compose.yaml` |
| Music files on the host | Lidarr `/data/media/music` = host **`/volume2/data/media/music`** (from `/volume2/data:/data`). Navidrome mounts the same folder read-only |
| Music files access | ✅ `MEDIA_SOURCE=ssh` with user `Nicola` (admin group) and a password in `.env`. Notes: UGOS's custom `sftp-server` only exposes shares created in its UI (just `docker`), so SFTP can't see `/volume2/data`. `Nicola` has no home folder, so key auth isn't possible without changes on the NAS |
| Other services on host | Jellyfin 12.4 on :8096 (runs in Docker, so the host has Docker); something on :4533 (maybe Navidrome) |
| Local toolchain | Node 25.2, pnpm 10.32 (through `corepack pnpm` in Claude's shell), Docker, Xcode (for `pnpm sim`). **ffmpeg, fpcalc and rclone not installed**: in dev, analysis runs ffmpeg on the NAS over SSH (`brew install ffmpeg` to analyse local folders) |
| Ports | Playarr server **:4000**, Vite dev **:5180**. :5173 is taken by another local project (lifetool) |

---

## 3. Tech stack (as built)

**Monorepo** (pnpm workspaces)
```
playarr/
├── apps/
│   ├── web/        # React client (Vite), PWA with its own service worker
│   └── server/     # Fastify API, streaming, analysis, transitions
├── packages/
│   ├── shared/     # Shared TS types (Playarr API contracts) and the byte-range parser
│   └── mix/        # DJ mixing, no dependencies: analysis, planner, renderer (server and browser)
├── docker/         # Dockerfile, compose stack, update.sh, the updater container, deploy.mjs
├── scripts/        # bump-version (pre-commit hook), ios-sim (pnpm sim), beat-this (model export)
├── docs/           # mixing.md and the design/implementation plans
└── PLAN.md
```

**Web client**
- React 19, TypeScript 7, Vite 8
- Tailwind CSS 4 with our own components (menus, dialogs, sliders; no Radix), lucide icons, Motion for animation
- TanStack Query for server state, persisted to IndexedDB; React Router 7 for routing
- Zustand for player, queue and per-device preferences, persisted to `localStorage`
- `vite-plugin-pwa` in injectManifest mode: our own service worker (`src/sw.ts`) precaches the shell and plays songs kept on the device
- Playback through `<audio>` elements: two that take turns for gapless songs and crossfades, and a third that plays DJ transitions. On desktop browsers they also run through a Web Audio graph for sample-exact joins and live mixes; phones and tablets stay on plain elements, which keep playing with the screen locked
- Media Session API for lock-screen and OS media controls, artwork, and next/prev/seek
- Accent color pulled from the current album art (our own code)

**Server**
- Node + Fastify 5, TypeScript, zod 4 for config and request bodies
- `fetch` Lidarr client with typed DTOs
- Pluggable media sources (local disk, SSH, SFTP, rclone for SMB) with Range streaming; ffmpeg decodes for analysis, levelled streams and transitions (no transcoding for playback yet)
- SQLite through Node's built-in `node:sqlite` for the catalog and user data
- Catalog in SQLite fed by source adapters (Lidarr, folders), refreshed every 10 minutes
- Analysis in worker threads: our own DSP, the Beat This! model (onnxruntime-web, WebAssembly), EBU R128 loudness
- Artwork proxy with a size-capped disk cache and resizing (`sharp`); generated playlist covers (SVG → WebP)
- Serves the built web app as static files, giving one container and one port in production

**Deployment target**
- One Docker image (Node 24 Alpine with ffmpeg, chromaprint and rclone). Run it on the Lidarr host (192.168.1.103) next to Lidarr and mount the music volume **read-only** at the same path Lidarr uses (or set a path mapping).

---

## 4. Lidarr API usage (v1, header `X-Api-Key`)

| Purpose | Endpoint | Notes |
|---|---|---|
| Health / version | `GET /api/v1/system/status` | Connectivity check on startup |
| Root folders | `GET /api/v1/rootfolder` | Used to auto-suggest path mappings |
| Artists | `GET /api/v1/artist`, `/artist/{id}` | Includes `statistics.trackFileCount` |
| Albums | `GET /api/v1/album?artistId=`, `/album/{id}` | Filter to albums with `statistics.trackFileCount > 0` |
| Tracks | `GET /api/v1/track?albumId=` | `hasFile`, `trackFileId`, `duration`, `trackNumber`, `mediumNumber` |
| Track files | `GET /api/v1/trackfile?albumId=`, `/trackfile/{id}` | `path`, `size`, `quality`, `mediaInfo` (codec, bitrate, sample rate), `dateAdded` |
| Artwork | `GET /api/v1/mediacover/artist/{id}/poster.jpg`, `/mediacover/album/{id}/cover.jpg` | Proxied and cached by the server |
| Recently added | `GET /api/v1/history?eventType=trackFileImported` or trackfile `dateAdded` | For the "Recently added" view |
| Missing (later) | `GET /api/v1/wanted/missing` | Optional: show or request missing albums |
| Commands (later) | `POST /api/v1/command` | e.g. `AlbumSearch`, `RefreshArtist` from inside the player |

Searching the user's own library happens over the server's snapshot. Lidarr's `/search` is for adding *new* music.

---

## 5. Playarr server API (as built, grouped; `apps/server/src/routes/`)

```
GET  /api/health                         → Lidarr reachable? media source OK? library stats
GET  /api/artists, /api/artists/:id(/tracks), /api/albums(/random), /api/albums/:id, /api/tracks/random
GET  /api/search?q=                      → artists / albums / tracks / playlists in the library
GET  /api/tracks/:id/metadata | /lyrics  → everything about a song (paths: home network only) | lyrics
POST /api/files/:fileId/rematch, /api/library/refresh
GET  /stream/:fileId                     → the file as it is (Range)
GET  /stream/:fileId/levelled.wav?gain=  → the song at its even-volume level, 16-bit 44.1 kHz WAV made as asked for (Range)
GET  /art/:kind/:id/:type, /art/copy/:id, /art/remote, /art/playlist/:id(/preview)
CRUD /api/favorites/:recordingId, /api/playlists (+ items, order, cover, recommendations)
GET  /api/discover/search, /api/discover/artists/:mbid(/similar), /api/discover/artist-lookup
CRUD /api/requests                       → request albums through Lidarr, with progress
POST /api/plays; GET /api/plays/recent-albums, /api/stats, /api/mixes(/:key), POST /api/mixes/:key/regenerate|save, /api/radio
CRUD /api/profiles
POST /api/levels, /api/mix-maps, /api/transitions; GET /transitions/:file; GET|PUT /api/recordings/:id/cues
GET  /api/analysis/progress; POST /api/analysis/:kind
     /api/settings/{sources,folders,matching,requests,mixes,listenbrainz,updates}  (changes: home network only)
```

**Security:** `/stream` only serves file ids the catalog knows *and* paths that resolve inside a configured music root (no path traversal); the client never sends a path. Every change request must carry Playarr's own header (no cross-site requests). Settings and other local-only actions need a home address, no proxy in between, and the server addressed by IP or a local name (no DNS rebinding). The Lidarr API key never reaches the client, and a saved key is only ever sent to the server it was saved for. Playarr's own login is still to come (Phase 5).

---

## 6. UX / design direction

- Dark-first theme, with light mode. Album art drives the visuals and the accent color comes from the current cover.
- **Mobile:** bottom tab bar (Home · Library · Search · Playlists), a persistent mini-player above it that expands to a full-screen Now Playing view (swipe down to close, swipe left/right for next/prev), 44px+ touch targets, safe-area insets.
- **Desktop (≥1024px):** left sidebar nav, main content, optional right queue/lyrics panel, bottom player bar. Keyboard shortcuts (Space, ←/→ seek, Shift+←/→ prev/next, `/` search). Right-click context menus.
- Views: Home (recently added, recently played, random picks), Artists grid, Albums grid, Artist page, Album page (track list, format badges like FLAC 24/96), Search, Queue, Playlists, Settings.
- Virtualized lists and grids (`@tanstack/react-virtual`) for large libraries.
- Skeleton loading states and optimistic UI. Respect `prefers-reduced-motion`.

---

## 7. Roadmap

### Phase 0: Foundations
- [x] Get the Lidarr API key and confirm connectivity (`/system/status`)
- [x] Decide how dev reaches the music files: `MEDIA_SOURCE=ssh` (§9)
- [x] Scaffold the pnpm monorepo (web, server, shared) and tsconfig. *ESLint/Prettier still to add.*
- [x] Server config via `.env`, validated with zod (`LIDARR_URL`, `LIDARR_API_KEY`, `MEDIA_SOURCE`, `PATH_MAP`, `SFTP_*`, `PORT`)
- [x] Typed Lidarr client + `/api/health` (Lidarr, media source, and library stats; probes a real file to catch a bad `PATH_MAP`)
- [x] Vite dev proxy `/api`, `/stream`, `/art` → server

### Phase 1: Library browsing
- [x] Library snapshot (artists, albums, tracks, trackfiles), refreshed every 10 min plus `POST /api/library/refresh`
- [x] Artists grid, Albums grid (sortable), Artist page (fanart hero + clearlogo, grouped discography), Album page (tinted header, discs, liner notes)
- [x] Artwork proxy: resized to WebP with sharp, disk cache in `.cache/art`, immutable caching with `?v=lastWrite`
- [x] Responsive app shell: sidebar on desktop, bottom tabs + mini player on mobile

### Phase 2: Playback core
- [x] `/stream/:id` with Range support (direct play). Verified against the NAS: all 412 files stat OK, md5 identical to the original, ~23 MB/s, aborted requests leave no remote processes
- [x] Player store: queue, play order, shuffle, repeat (off/all/one), volume, play next / add to queue
- [x] Mini-player, full Now Playing (drag down to dismiss), desktop player bar
- [x] Media Session API (metadata, artwork, action handlers, position state)
- [x] Preload the next track: gapless playback, two players taking turns (2026-11-01)
- [x] Persist the queue and position across reloads
- [x] Keyboard shortcuts (Space, ←/→, Shift+←/→, ↑/↓, M, S, /)

### Phase 3: Discovery and polish
- [x] Search (artists, albums, tracks; ignores accents and punctuation)
- [x] Recently added (by when albums first entered the library, across sources), random albums, sorting. *Filtering by genre/format still to do.*
- [x] Queue management: play next, add to queue, remove, clear (undoable), drag to reorder, "Playing from" (2026-11-01)
- [x] Context menus (⋯ menus on tracks and albums). *Long-press still to do.*

### Phase 4: PWA and mobile
- [x] Manifest, icons, service worker (app shell precached, artwork CacheFirst, API NetworkFirst). Since 2026-10-29 it's our own worker (`src/sw.ts`, injectManifest) that also plays kept songs from disk (§14)
- [ ] iOS standalone quirks (background audio, safe areas, splash)
- [x] Gestures on Now Playing (drag down to close). *Swipe for next/prev still to do.*

### Phase 5: Server features
- [ ] ffmpeg transcoding with format negotiation (detect `canPlayType`, fall back for ALAC/WMA/etc. and mobile data)
- [ ] **Login + HTTPS before relying on the internet exposure** (decided 2026-10-30: exposed as is for now through the router's forward to NAS port 4000; this comes later):
  - *Login:* one password (`PLAYARR_PASSWORD`, stored hashed) and a sign-in screen. A signed, HttpOnly, Secure, SameSite=Lax session cookie, valid for months, guards `/api`, `/stream` and `/art` (the app shell and `/api/health` stay public). Login attempts are rate-limited, and the server returns 401s that the web app turns into the sign-in screen. Optionally trust the LAN (192.168.1.0/24) without a login.
  - *HTTPS:* a Caddy container in the compose stack terminates TLS and proxies to `playarr:4000`. The router forward moves from NAS:4000 to Caddy (e.g. external 443 → NAS 8443; UGOS already owns 80/443), and Playarr's own port goes back to LAN-only. With a static IP and no domain, either a Let's Encrypt certificate for the IP address (short-lived, renewed automatically by Caddy, if available by then) or a free DuckDNS name pointing at the IP with a normal certificate. HTTPS also unlocks the app install and offline songs on phones (§14).
  - *Until then:* anyone who finds the port can stream the library, edit playlists and favorites, and request albums through Lidarr (which downloads them). A quick interim option: a setting that turns requests off on the exposed instance.
- [x] SQLite (`node:sqlite`, `apps/server/data/playarr.db`): **favorites** and **playlists** (2026-10-28), the catalog (2026-10-30), listening history per profile and Jump back in (2026-11-01)
- [x] **Docker image + NAS deployment** (2026-10-30, see §15): `pnpm deploy:nas` builds and runs Playarr on the NAS as its own compose stack

### Phase 6: Nice-to-haves
- [x] Lyrics (`.lrc` beside the song, tags, or LRCLIB; timed lines follow along, tap to seek) (2026-11-01)
- [x] Crossfade (2026-11-01) and even volume from Playarr's own EBU R128 measurement, through levelled streams so iPhones are levelled too (2026-11-02). *ReplayGain tags and EQ still to do.*
- [x] **DJ transitions** (2026-11-01/02, see §16 and [docs/mixing.md](docs/mixing.md)): beatmatched blends, quick mixes and fades rendered by the server; live mixes on desktop skips
- [x] **Made for you** (2026-11-01, see §17): listening history, 12 generated mixes, radio, listening stats and a year in review; listener profiles
- [x] Sleep timer, Settings → Analysis, Stats for nerds, Settings → Updates (automatic updates)
- [x] **Load-ahead and offline songs** (built 2026-10-29, see §14): the next songs in the queue are kept on the device (LRU, size limit in Library), played by the service worker with byte ranges; library data persisted in IndexedDB; pages prefetched on hover/tap. Downloads of albums, playlists, mixes and Favorites that are never evicted, with their DJ transitions (Library → Downloads, 2026-11-01).
- [x] **Discover & request** (built 2026-10-27, see §11): search beyond the library, request albums, live download progress
- [x] **Playlist recommendations** (built 2026-10-28, see §11): "Songs like these" under each playlist, with Add for songs you own and Request for songs you don't. Radio from any song, and when the queue runs out (2026-11-01). *Next: the same suggestions for Favorites.*
- [x] **Generated playlist covers** (built 2026-10-29, see §13): artwork drawn from what the songs sound like, measured from the audio. The same features now drive mood mixes and radio.
- [ ] Lidarr actions: interactive release picking. *Artist pages already list missing albums with Request (2026-10-31).*
- [ ] Live library updates through Lidarr SignalR
- [ ] Cast / AirPlay (Remote Playback API), Last.fm scrobbling. *ListenBrainz scrobbling done (2026-11-01).*
- [ ] Optional wrappers: Tauri (desktop), Capacitor (mobile)

---

## 8. Browser format notes

| Format | Chrome/Edge | Firefox | Safari (macOS/iOS) | Plan |
|---|---|---|---|---|
| MP3, AAC/M4A | ✅ | ✅ | ✅ | Direct |
| FLAC | ✅ | ✅ | ✅ (macOS 11+ / iOS 11+) | Direct; transcode on mobile data if enabled |
| ALAC (M4A) | ❌ | ❌ | ✅ | Transcode for non-Safari |
| Ogg Vorbis / Opus | ✅ | ✅ | ⚠️ partial (newer versions) | Check `canPlayType`, transcode otherwise |
| WMA, APE, WV, DSD | ❌ | ❌ | ❌ | Always transcode |

---

## 9. Open questions

1. **Music file access in dev:** the server needs to read the audio files. (Confirmed against Lidarr's OpenAPI spec: `/trackfile` returns only JSON metadata and `/filesystem` only lists directories. No endpoint returns file contents.) Options:
   - ✅ **Resolved 2026-10-27:** `MEDIA_SOURCE=ssh`, which runs `stat` and `tail -c +N | head -c L` over one persistent SSH connection. SFTP was the plan, but UGOS restricts it (see Environment).
   - a) SFTP: works on normal hosts (`MEDIA_SOURCE=sftp`), but not with UGOS's SFTP server.
   - b) Run the Playarr server on 192.168.1.103 (Docker, next to Lidarr) and develop the web app locally against it.
   - c) Mount the library on this Mac (sshfs, or enable an SMB share) and set a path mapping.
   - d) Copy a small sample of albums locally for dev.
2. ~~Lidarr API key~~ ✅ done (in the root `.env`).
3. ~~Users~~ ✅ **Resolved 2026-11-01:** listener profiles, picked per device, each with its own history, mixes, stats and ListenBrainz account; favorites and playlists stay shared (per-profile ones are on the roadmap). No login per profile.
4. **Remote access:** router port forwarding to NAS port 4000 on the home static IP (2026-10-30; Tailscale was set up, then dropped). Exposed without a login for now, by the user's choice; login + HTTPS are planned (Phase 5). Transcoding for mobile data is still open.
5. **Design preference:** any reference apps you like (Apple Music, Spotify, Plexamp, Feishin…)?

---

## 10. Running it

```bash
pnpm install
pnpm dev                 # server :4000 + web :5180 (also reachable on the LAN from a phone)
pnpm build && pnpm start # production: one process on :4000 serving the API and the built web app
pnpm -C apps/server test          # server unit tests
pnpm -C packages/mix test         # mixing: analysis, planner, renderer
pnpm --filter @playarr/web test   # web unit tests plus smoke tests against the running server
pnpm typecheck                    # every package
pnpm deploy:nas          # build and (re)start the NAS deployment from the last commit (§15)
```

Every commit raises the patch version in `package.json` (`.githooks/pre-commit`, enabled by `pnpm install`); the sidebar shows the version and commit.

To see a change on an iPhone, use the iOS Simulator (needs Xcode): `pnpm sim boot`, then `pnpm sim open /albums/123`, `pnpm sim click 'text=Shuffle'`, `pnpm sim shot`, `pnpm sim console --errors`. `pnpm sim help` lists every command.

## 11. Discover & requests (how song → album works)

| Need | Source | Why |
|---|---|---|
| Songs ("bohemian rhapsody") | **Deezer** public search API (no key) | Ranked by popularity: finds Queen, not one of hundreds of covers. MusicBrainz has no popularity, and Lidarr has no track search |
| Artists & albums | **Lidarr** `/api/v1/search` | Results already carry MusicBrainz ids and are ready to add |
| Artist discography | **MusicBrainz** release-group browse | Complete; filtered to albums, EPs and soundtracks |
| Song → album id | Deezer gives *artist + album title* → MusicBrainz release-group search (prefers the studio album) → Lidarr `album/lookup?term=lidarr:<mbid>`; Lidarr name search is the fallback | Every Lidarr album *is* a MusicBrainz release group (`foreignAlbumId`) |
| Already own it? | Match artist + album title (edition suffixes stripped) against the library snapshot | Instant; "Mezzanine (Deluxe)" = "Mezzanine" |

**Request flow:** `POST /api/requests` → `POST /api/v1/album` (new artist added with `monitor: none`, so only the requested album is wanted) or `PUT /album/monitor` if Lidarr already knows it → `AlbumSearch` command → status from command + `/queue` + album stats → library refresh when files land. Albums added this way are `AddType.Manual`, which Lidarr never deletes on refresh, so singles and soundtracks outside the metadata profile are safe. Requests persist in `apps/server/.cache/requests.json`.

**Ranking tweaks:** title/artist match on top of popularity, versions (remix/live/edit) pushed down, and when the query names an artist, that artist's top tracks are checked too ("teardrop massive attack" → *Mezzanine*). Remote artwork goes through `/art/remote` (allowlisted hosts, checked on every redirect); release-group covers use Lidarr's image CDN.

**Playlist recommendations:** ListenBrainz's labs `similar-recordings` API (no key; built from real listening sessions, keyed by MusicBrainz recording id, which every playlist entry already has). Up to 10 playlist songs are used as seeds (evenly spread; "New mix" picks a random set and shakes up the ranking). Each seed's scores are scaled to its own best match, then summed, so songs similar to several playlist songs rise. Songs already in the playlist are dropped, as are extra songs by the same lead artist ("feat." credits count as the lead: 3 per artist for owned songs, 2 for missing). Owned? Recording id in the library, then artist + title. One batch call to ListenBrainz's `metadata/recording` endpoint then adds what similar-recordings leaves out for missing songs: the lead artist's MusicBrainz id and the **release group** (= the Lidarr album), so Request goes straight to Lidarr. If that call fails, the release id is mapped through MusicBrainz, with name lookup as the last resort. Artist and album names link out: artist → library page if owned, else their discover page; album → album page if owned, else the artist's discography (where it can be requested). Covers come from Cover Art Archive through Lidarr's CDN. Results are cached for 1 h on the server and 10 min in the browser.

**Artist & album links (search, favorites, recommendations):** library songs link straight to their artist and album pages. Deezer songs only know names, so search attaches an artist id when it already has one (library, or an artist in the same search results); otherwise the link goes to `/discover/artist?name=`, which resolves the name on click (library → Lidarr search → MusicBrainz, via `GET /api/discover/artist-lookup`) and forwards. Albums not in the library open the artist's discography with `?album=`, which scrolls to and highlights that album (titles compared loosely, so "(Deluxe)" still matches). Singles and compilations aren't listed there, and the page says so.

**Lidarr setup seen:** quality profiles Any/Lossless/Standard (root default: Any), metadata profile Standard = Album/Studio/Official. Indexers: Knaben + The Pirate Bay via Prowlarr; download client: qBittorrent. Overridable in Settings → Requests, and via `LIDARR_ROOT_FOLDER`, `LIDARR_QUALITY_PROFILE_ID`, `LIDARR_METADATA_PROFILE_ID` when nothing is chosen there.

## 13. Generated playlist covers

Each playlist gets artwork drawn from its music, not a collage of album art. Same songs → same cover.

**1. Listen (server, once per song, cached in SQLite `track_features`; Settings → Analysis calls it *sound analysis*).** `ffmpeg` runs where the files are (over SSH on the NAS, `nice`d) and decodes up to 7 min of mono PCM, shared with beat analysis. `analysis/dsp.ts` then measures, all in plain TypeScript, in a worker thread:
- **tempo** and **pulse** (how clearly the beat stands out): since 2026-11-02 these come from beat analysis (the song's mix map, §16), the one tempo DJ mix plays by. The original onset-autocorrelation tempo is gone; values stored before stay in the database but aren't read. Until a song has its beat analysis, covers draw it with a neutral stand-in tempo
- **loudness**, **dynamics** (p95−p10 range), **brightness** (spectral centroid), **busyness** (onsets/s), **bass** (energy share < 150 Hz)
- **envelope**: 48-point loudness curve, the song's shape

The original tempo was calibrated against known tempos in the library (Da Funk 111, Around the World 121, One More Time 123, Something About Us 100, Porcelain 95: all within 0.3 BPM) and beatless pieces (Jan Garbarek's *Officium* → pulse 0). Raw measurements are stored too, so scales can be recalibrated without re-decoding. `ANALYSIS=off` disables it; `FFMPEG_PATH` overrides the binary.

**2. Read.** ListenBrainz metadata (batched, `track_meta`): crowd tags (recording ×1, release group ×0.6, artist ×0.4) plus first-release year; Lidarr artist genres as a fallback. Tags map to 13 style families (`analysis/styles.ts`), each with a hue and a paper-vs-night bias; families under 12% of a song's tags are noise and dropped. Mood words nudge warmth and calm.

**3. DNA** (`cover/dna.ts`): typical tempo and its spread, mean pulse/intensity/brightness/bass, organic-ness, style mix, **diversity** (entropy of each song's *main* style + spread of sound; averaging every tag made focused playlists look eclectic), era. Seeded from the sorted recording ids.

**4. Draw** (`cover/layouts.ts`, SVG, then WebP via sharp at snapped sizes; versioned URL `?v=<hash of DNA + RENDER_VERSION>`). The layout follows the character:
| Layout | Chosen for | Each song is… |
|---|---|---|
| **Currents** (flow field, the default hero) | most playlists; legato, organic music | ribbons through a field that is laminar for a steady beat and swirls in free time; louder songs run wider, legato songs longer. Two-pass packing (long ribbons, then thinner fillers); finishes: solid, *beats* (each ribbon cut into its song's beats), hollow *tubes* |
| **Colonies** (multi-species Physarum) | eclectic mixes | a member of its style's species; species follow their own trails and avoid others' (harder the more eclectic), speed from tempo, vein tightness from beat. ~2.5 s on CPU, yields to the event loop, cached on disk |
| **Ridges** (after *Unknown Pleasures*) | driving, bright (rock, metal, dance) | a band of lines tracing its loudness, rippling with tempo and busyness |
| **Grooves** (a record) | heavy steady low end, the vinyl era | a band of grooves as wide as the song is long, wobbling with its loudness |
| **Blocks** (Bauhaus) | eclectic mixes, mid-century jazz | a tile sized by length; the shape comes from how it sounds (rings = steady beat, stripes = busy, disc = calm, half-circle = dynamic, dots = crisp, wave = its loudness) |
| **Horizon** | calm, beatless (ambient, choral, folk) | a hill whose ridge is its loudness; slower music → bigger sun, cut into stripes if there's a beat |

Palette: the playlist *chooses* one of chromotome's 162 curated palettes (Kjetil Golid et al., MIT), each also offered inverted (darkest ink as night) since most are light. Score: paper vs night (from calm, brightness, the styles' feel), hue match to the style hues, vividness vs energy, enough colors for the diversity. Styles get the palette color nearest their hue; older eras fade and warm slightly; print grain via feTurbulence. Rendering is server-side so every browser shows the same pixels; renders are cached in memory and in `.cache/covers/`. Bump `RENDER_VERSION` when the artwork changes (URLs are immutable-cached).

Researched on GitHub before adding Currents/Colonies: flow fields with collision packing (as popularized by Tyler Hobbs' *Fidenza*; reimplemented, not copied), fogleman/physarum and Sage Jenson's Physarum, kgolid/chromotome, thi.ng/umbrella. Rejected: diffusion/VQGAN models (need a GPU or an external service, generic look, not deterministic), CPPNs (psychedelic gradients clash with the sleeve aesthetic), reaction-diffusion and differential growth (slow on CPU, weakly tied to the music).

**Lifecycle (like Apple Music's chosen artwork, not its live mosaic):** a playlist's cover is drawn once all its songs have been heard, then **pinned**: `playlists.cover_snapshot` stores the DNA, layout and variant it was drawn from, so adding/removing songs (or better analysis) never changes it. **New cover** (click the cover, the ⋯ menu, or the link under the stats) opens a picker with one candidate per layout from the *current* songs (`/art/playlist/:id/preview?layout&variant`); Shuffle re-rolls the variants, "Use this" pins the choice (`PUT /api/playlists/:id/cover`). When >30% of the songs differ from the snapshot (Jaccard distance), the page suggests a new cover.

**Title:** set top-left (Apple's placement) as vector outlines in the app's faces (Gloock title, DM Mono "PLAYLIST" label) via opentype.js, so it renders identically on any server; auto-sized and wrapped to ≤ 3 lines; on a panel of the palette background (none over a Horizon sky); emoji/CJK fall back to SVG text. It's a separate live layer: renaming changes the image URL but never redraws the art. Thumbnails under 120 px ask for `title=0` (lists show the name next to them).

**UI:** covers everywhere playlists appear (crossfading between versions); playlists poll while songs are still being analyzed; the playlist page explains the cover ("Each line is a song…") with the facts behind it (BPM, styles, era, energy).

**How Apple Music does it (for comparison):** default artwork is a live 2×2 mosaic of the first four songs' album art; since iOS 17.1 the user can swipe through 8 preset designs (geometric shapes and gradients, colors from the first song's artwork, title top-left) and pick one; iOS 18 adds an on-device image generator from a text prompt. Playarr borrows the user-picks-and-it-stays model and the title placement; its art is drawn from how every song sounds rather than one song's colors.

## 14. Client-side caching and load-ahead

**Audio.** `player/loadAhead.ts` plans which songs to have ready: the next 3 in play order (wrapping with repeat-all; on repeat-one the current song comes first), then the one playing (worth keeping for seeks, replays and offline). It waits 2.5 s for the queue to settle, so skipping through tracks doesn't download each one, and downloads one song at a time. A download that drops out of the plan is aborted. Data saver/2G: nothing; cellular: one song, not the current one. `player/offline.ts` fetches the whole file (200, not ranges) and writes it to Cache Storage (`playarr-audio`), with an index in localStorage (bytes, last used). Space: default 2 GB, capped at half the browser quota, least recently played dropped first; songs in the current plan are never dropped. It asks for persistent storage once.

**Playback.** The service worker answers `/stream/:id` from `playarr-audio` when the song is kept: the whole file, or the one byte range `<audio>` asks for, sliced from the stored blob by the same `parseRange` the server uses (`@playarr/shared`). Workbox's range helper was dropped: it answered 416 to ranges ending past the file instead of clamping. Songs that aren't kept go straight to the network; the worker never stores audio itself. Load-ahead only runs while a service worker controls the page. The Vite dev server has none, so try it with `pnpm -C apps/web build && pnpm -C apps/web preview` (:4173, proxied to the server).

**Data.** TanStack Query's cache is persisted to IndexedDB (`idb-keyval`): health, artists, albums, album/artist/playlist details and favorites (not search, discover, requests or the random shelf). It's dropped after 7 days or on any new build (`__BUILD_ID__` buster), so old shapes are never misread. The app opens with the last data on screen and refreshes in the background.

**Prefetch.** A mouse resting 80 ms on an album/artist/playlist link, a pointer going down on one, or keyboard focus loads the page's data (an album also loads its artist) and its header image. The next song's cover is preloaded at the player's sizes.

**UI.** A small ⤓ after the title marks songs on the device (track lists, queue, Now Playing). The song downloading shows a progress ring. Library → "On this device" shows songs/space, the limit (Off · 512 MB … 10 GB) and Remove all.

**Requires a secure context.** Cache Storage and service workers only exist on HTTPS or localhost. Over plain `http://192.168.x.x` (a phone on the LAN) none of this runs: songs stream as before, and Library explains why. Ties into the remote-access question (§9): a reverse proxy with a certificate would enable it on phones.

## 15. Deploying to the NAS (standalone)

**Layout on the NAS** (`/volume1/docker/playarr`, owned by Nicola):

| Path | What |
|---|---|
| `compose.yaml`, `update.sh` | copied from the deployed commit on each deploy |
| `compose.override.yaml` | your own mounts (e.g. host folders under `/host`); never overwritten |
| `.env` (mode 600) | `LIDARR_URL`, `LIDARR_API_KEY`, `MUSIC_DIR`, `PLAYARR_DIR`; written by the deploy |
| `src/` | the deployed commit (`src/REVISION`), the build context |
| `config/` | favorites, playlists, history, song analysis (SQLite): keep and back up |
| `cache/` | artwork, covers and rendered transitions: safe to delete |
| `update/` | shared with the updater container: settings, Check now requests, status and the last log |

**Containers:** `playarr` (Node 24 Alpine with ffmpeg, chromaprint and rclone) runs as 1000:10 like the rest of the stack. Music is mounted read-only at `/data/media/music`, the same path Lidarr uses, so no path mapping is needed. It listens on port 4000. `updater` is the only container with the Docker socket (Settings → Updates, decisions log 2026-10-30).

**Deploy (`pnpm deploy:nas`, `docker/deploy.mjs`):** by default it copies `docker/update.sh` over SSH and runs it: the NAS downloads the latest commit on GitHub `main` and builds it (it warns when this checkout differs from GitHub's: push first). `--local` instead sends `git archive HEAD` into `src/` (only committed code: no `.env`, no local data) and runs `sudo docker compose up -d --build`. Either way it writes `.env` and waits for `/api/health`; the image is built on the NAS, natively x86_64. `--with-data` copies this machine's database once (a `VACUUM INTO` snapshot, safe while the local server runs); `--force-data` replaces the NAS's.

**UGOS gotcha:** inherited ACLs on `/volume1/docker` make unpacked files 770 and new files readable by everyone. The image runs `chmod -R a+rX` on its build output (the app runs as uid 1000, not root), and the deploy `chmod 600`s `.env` (umask alone isn't enough).

**Updating:** automatically from Settings → Updates, or push and run `pnpm deploy:nas` (or `sudo sh update.sh` on the NAS). **Logs:** `sudo docker compose -f /volume1/docker/playarr/compose.yaml logs -f`. **Backup:** `config/`.

## 16. DJ transitions

Settings → Playback → Transitions: Off, Crossfade or DJ mix. With DJ mix, songs flow into each other the way a DJ would mix them: long beatmatched blends, quick mixes, fades or straight on, decided per pair. The whole pipeline (analysis, planner, renderer, playback, with every threshold) is in **[docs/mixing.md](docs/mixing.md)**; design and plan: `docs/plans/2026-11-01-beatmatching-design.md` and `2026-11-01-beatmatching.md`. In short:

- **Analysis** (server, once per song, *beat analysis* in Settings → Analysis): a *mix map* with tempo to 0.01 BPM, beat grid, bars and phrases (Beat This! plus our onset comb), key, intro and outro, phrase-by-phrase drift. `packages/mix/src/analysis`.
- **Planning** (`packages/mix/src/plan.ts`): pure and deterministic, so server and browser agree. The queue's mix mode (Auto, Party, No mixing) is set in Now Playing.
- **Rendering** (server, `apps/server/src/transitions`): each upcoming transition into a cached FLAC file (`TRANSITIONS_CACHE_MB`), with 2 s of A before and 3 s of B after, so the player can change files where both hold the same sound. At the even-volume levels the songs play at (§17).
- **Playback** (`apps/web/src/player`): A, then the transition file, then B, each file taking over in step. The lock screen, seek bar and history only ever see the two songs. Desktop browsers line joins up on the sound through Web Audio and mix skips live; phones and tablets stay on plain `<audio>` elements, which keep playing with the screen locked. Downloads keep their transitions for offline listening.

## 17. Listening, profiles, mixes and even volume

- **Listening history** (`POST /api/plays`): a song counts as played after 30 s or half a short song, skipped after 3–30 s. Reports wait on the device until sent, and are stored once. A device can stay out of the history (Settings → Playback).
- **Profiles**: each listener picks a profile per device (Home asks once; Settings → Profiles). History, mixes, stats and the ListenBrainz account follow the profile; favorites and playlists are shared.
- **Made for you** (design: `docs/plans/2026-11-01-mixes.md`): a taste model from the history feeds 12 generated mixes (Vibes of the hour, Discovery Weekly, On repeat, Blast from the past, Deep cuts, Fresh arrivals, decades, genres, Energy boost, Wind down, Deep focus, On this day), remade per hour, day or week in the household's time zone, in the background. Songs are ordered to blend (`packages/mix/src/blend.ts`). Settings → Mixes tunes them. Plus radio (when the queue runs out, or from any song), Jump back in, and listening stats with a year in review.
- **ListenBrainz**: plays are sent to the profile's ListenBrainz account (token in Settings → Mixes); its tags give genres and years (*tag lookup*), and its similar-recordings data drives recommendations and similar artists.
- **Even volume** (Settings → Playback → Even out the volume): *loudness analysis* measures each song's EBU R128 loudness and peak (one decode in stereo at 44.1 kHz; matches ffmpeg's ebur128 to 0.05 LU), stored per file in `track_loudness`. `/api/levels` gives the gain to −14 LUFS: loud songs down (at most −20 dB), quiet ones up (at most +12 dB, with the peak kept under −1 dBFS), album gain when an album plays in order. The player then plays `/stream/:id/levelled.wav?gain=`: the song decoded with the gain applied, as a WAV whose length is known in advance, so any byte range decodes from its exact sample. This levels iPhones too, which ignore an element's volume. Songs kept on the device, or not measured yet, play their own file, turned down by the element's volume where it can be set. DJ transitions are rendered at the gains the songs are playing at (B's MP3 remainder too), and the player asks again when a level is learned; with the setting off, no gains are sent. Note: the levelled stream is uncompressed (~1.4 Mbit/s), which matters on mobile data until there's transcoding.

## 12. Decisions log

| Date | Decision |
|---|---|
| 2026-10-27 | Web-first React PWA with a Node/Fastify companion server, because Lidarr can't stream audio itself. |
| 2026-10-27 | The server reads audio through a pluggable `MediaSource`: `sftp` for local dev (no mounts), `local` disk when deployed next to Lidarr, `none` until configured. `/stream` only serves `trackFileId`s that Lidarr reports; the client never sends a path. |
| 2026-10-27 | Added `MEDIA_SOURCE=ssh` (exec `stat`/`tail`/`head` over SSH) because UGOS's SFTP hides non-UI shares. Config keys renamed `SFTP_*` → `SSH_*`. Paths are shell-quoted; channels close when the browser aborts. Limit: sshd `MaxSessions` (10) caps simultaneous streams per connection; fine for one user, revisit for multi-user. |
| 2026-10-27 | Discover/requests: Deezer for songs, Lidarr for artists/albums, MusicBrainz for discographies and name → id resolution. Albums are resolved to MusicBrainz ids only at request time (not per search result), which keeps search fast. |
| 2026-10-27 | Dev server must run outside Claude's sandbox: the sandbox blocks some external hosts (Cover Art Archive, Lidarr's image CDN). This Mac's internet also had intermittent connect timeouts; the code degrades gracefully (songs may be missing; covers retry once). |
| 2026-10-27 | Git repo initialized; commit each step. |
| 2026-10-27 | Single `<audio>` element (not two swapped ones) so iOS background playback keeps working. Gapless/crossfade come later via Web Audio. *Superseded 2026-11-01: two elements taking turns, which iOS keeps playing in the background too; Web Audio only on desktop (2026-11-02).* |
| 2026-10-27 | Visual direction "liner notes": warm near-black, Gloock display serif, Schibsted Grotesk UI, DM Mono for specs and durations. The accent color comes from the current cover art; there's a subtle film grain. |
| 2026-10-27 | Stack versions: React 19, Vite 8, Tailwind 4, React Router 7 (pinned below v8), TanStack Query 5, Zustand 5, Motion 14, Fastify 5, zod 4, TypeScript 7. |
| 2026-10-28 | Playlists: entries keyed by recording id plus a title/artist/album snapshot, so songs that leave the library stay visible (greyed out) instead of vanishing; duplicates allowed; order kept as integer positions rewritten on reorder. Mobile tab bar became Home · Search · Library · Queue, with Library collecting playlists, favorites, artists, albums and requests. |
| 2026-10-28 | Favicon is redrawn in the accent color of the playing track (canvas → PNG, since Safari ignores SVG favicons). |
| 2026-10-28 | Favorites are keyed by MusicBrainz **recording id** (Lidarr `foreignRecordingId`), not Lidarr track id, so they survive re-imports and quality upgrades. Stored server-side in SQLite so every device shares them. Uses Node's built-in `node:sqlite` (no native dependency); `--disable-warning=ExperimentalWarning` in the scripts. User data lives in `DATA_DIR` (default `apps/server/data`), separate from the deletable `.cache`. |
| 2026-10-28 | Recommendations come from ListenBrainz (open data, no key, MusicBrainz ids end to end) rather than Last.fm (needs an API key; matches by name) or Deezer radio (popularity-driven, weaker for niche music). The labs API only takes one seed per call, so we make up to 10 calls in parallel (about 0.5 s total). |
| 2026-10-29 | Covers are pinned once drawn and changed only from the picker (user's call, after comparing with Apple Music); redrawing on every change undermined recognizability. Titles are part of the cover except on < 120 px thumbnails. |
| 2026-10-29 | Production build fix: tsup stripped the `node:` prefix (`node:sqlite` → `sqlite`), so `pnpm start` crashed since favorites landed; `removeNodeProtocol: false`. Dev (tsx) was unaffected, which hid it. |
| 2026-10-29 | Covers v2: curated palettes (chromotome) instead of computed ones; new Currents (flow field) and Colonies (Physarum) layouts. AI image models ruled out: no GPU on the NAS, external services would receive listening data, and results aren't deterministic. |
| 2026-10-29 | Playlist covers are generated from **measured audio** (ffmpeg on the NAS + our own DSP), not metadata: Deezer's BPM is often 0, AcousticBrainz is gone, and analysis covers every song including obscure ones. Only ~5 MB of low-rate mono PCM per song crosses the network, once. Tests: `pnpm -C apps/server test` (DSP on synthetic click tracks/tones/noise; cover determinism and layout choice). |
| 2026-10-29 | Client-side caching: the page downloads whole songs into Cache Storage and the service worker serves byte ranges from them (rather than the worker caching what `<audio>` streams, which is only ever partial 206 responses). The page owns the budget/LRU, so the worker stays dumb. Needs HTTPS/localhost; plain-HTTP LAN access gets no offline features. Verified with unit tests (planner, LRU, downloader with fake Cache API, range slicing) and smoke tests; not yet exercised in a real browser from this machine (browser automation unavailable). |
| 2026-10-30 | Remote access through router port forwarding (static IP → NAS:4000) instead of Tailscale, exposed without a login for now (user's call, with the risks spelled out); login + HTTPS via Caddy are on the roadmap. |
| 2026-10-30 | NAS deployment: its own compose stack in `/volume1/docker/playarr`, not added to `media-stack`, so deploys never touch Lidarr and friends. Built on the NAS from `git archive` (no registry, no cross-building from an arm64 Mac). Lidarr reached through the NAS's LAN address. Docker needs sudo for Nicola; the deploy uses it rather than adding Nicola to the `docker` group. |
| 2026-10-30 | Catalog moved to SQLite (`sources`, `catalog_artists/albums/tracks`, `copies`), fed by source adapters; Lidarr is the first (design: `docs/plans/2026-10-30-sources-design.md`). New rows take the Lidarr id when it's free, so existing links, saved queues and offline songs keep their ids with no migration. The JSON snapshot `.cache/library.json` is no longer used (safe to delete). |
| 2026-10-30 | Settings → Sources (phase 2): sources live in the database. `.env`'s `LIDARR_URL`/`LIDARR_API_KEY` seed the Lidarr source once, then Settings owns them (a removed source isn't recreated). Lidarr is optional: without it, requests and Discover are hidden and `/api/requests` answers 409. One Lidarr at most (the server shares one client). Settings changes are only accepted from loopback/private addresses, judged by the socket address, until there's a login; check on the NAS that internet visitors don't appear private (Docker's userland proxy can rewrite source addresses). |
| 2026-10-30 | Folder sources (phase 3): tags read with music-metadata, cached per file by size + mtime (`folder_files`); untagged files fall back to "Artist/Album/NN Title" and join existing artists/albums/songs by name (MusicBrainz-keyed rows preferred). Catalog rows keep the most trusted metadata (`meta_rank`: Lidarr 0, folder 2). No same-file detection: duplicate copies merge into one song and the tie goes to source order. Untagged songs get `local:<hash>` ids until fingerprints (phase 4). Missing songs come from Lidarr's track lists (`source_tracks`); folder albums get full track lists after matching. Sources sync one after the other in Settings order. Folder sources are limited to `FOLDER_ROOTS` (Docker: `/host`). |
| 2026-10-30 | Matching (phase 4): a match is an overlay on a file's tags (`folder_matches`), so matched and tagged files share one mapping. MusicBrainz release search → align files to tracks (0.6 title + 0.3 duration + 0.1 position; ≥0.85 auto, ≥0.5 review) → else Chromaprint/AcoustID (≥0.8, studio album preferred) → else unmatched. Matched releases bring full track lists (missing songs). manual/ignored decisions stick; files are re-matched when they change. When a song's id goes from `local:` to a MusicBrainz recording, favorites, playlist items and analysis follow it. AcoustID key in Settings; fpcalc from Alpine's chromaprint in the image. Matching shares MusicBrainz's 1 req/s queue with Discover. |
| 2026-10-30 | Remote folder sources (phase 5): a folder source can be on another machine over SSH (GNU find listings, stat/cat/tail over one connection, ffmpeg and fpcalc run remotely) or SFTP (readdir/stat/readFile; no analysis or fingerprints). Folder code goes through a FolderFs per source (FolderAccess caches one per source until its settings change). Remote tags come from byte ranges (music-metadata + @tokenizer/range, ≥64 KB chunks; SSH reads 3 files at a time because sshd allows ~10 channels). Remote folders are verified on save; the password is a write-only secret; FOLDER_ROOTS applies to local folders only; organizing stays local-only. |
| 2026-10-30 | Network shares (phase 6): SMB folder sources through rclone, not a Node client (node-smb2/@awo00/smb2 negotiate only SMB 2.0.2/2.1 with no signing, which Windows 11 24H2 and Server 2025 require). rclone lsjson lists/stats/browses; one rclone serve http per share on 127.0.0.1 (free port, random credentials) serves ranges for streaming and tags; ffmpeg/fpcalc read that URL here. Connection settings go only through RCLONE_SMB_* environment variables with the password obscured. Paths are /share/folder; browsing / lists shares. rclone is optional (SMB disabled without it). NFS: mount on the host, use This server. |
| 2026-10-30 | Organizing files (phase 4b): opt-in per folder source, review-then-apply. Layout Artist/Album/NN Title.ext (D-NN on multi-disc, Artist/Title.ext without an album), safe names, renames within the folder only, never overwrite, companions (covers, cue, log) follow when a folder's audio all moves, emptied folders removed, every move journaled (file_moves) and undoable per batch. The catalog follows renamed files in place, so copy ids, queues and offline songs survive. Server computes targets; the client only picks which files. |
| 2026-10-30 | Settings panels: Playback (offline songs moved from Library, keyboard shortcuts) and Appearance (accent from art or fixed, motion, format badges) are per device (persisted in the browser); Requests (allow, search right away, root folder and profiles from Lidarr's lists) is server-wide in app_settings, .env values as fallback, editable from the local network only; turning requests off hides Request buttons and the server refuses new ones. |
| 2026-10-30 | Automatic updates from Settings → Updates (plan: `docs/plans/2026-10-30-auto-update.md`). A second compose service, `updater` (`docker:cli` + compose, curl, jq, tar), is the only container with the Docker socket: giving it to Playarr would hand root on the host to a web app without login. It has no ports and only reads `update/settings.json` (with jq; only `enabled` and an interval of 15/60/360/1440 minutes are used) and checks for `update/request`; it writes `status.json` (with a heartbeat) and `last.log` by rename. Playarr mounts only `./update` and never talks to Docker; the panel works when `UPDATE_DIR` is set, the folder is writable and the heartbeat is under 3 minutes old. Settings can't choose the branch, commit or repository (GitHub serves fork commits through the parent's API, so a free-form ref would let anyone on the LAN deploy a fork): only `main` of `PLAYARR_REPO`. The updater sees the deploy folder at its host path (`.:${PLAYARR_DIR}`, recorded in `.env` by update.sh and deploy.mjs) so compose's relative paths stay right; inside it update.sh recreates only `playarr` and checks health at `http://playarr:4000`, then a one-off container from the updater image recreates the updater (compose stops the old container before starting the new, which would cut off a self-recreate halfway). The first `sudo sh update.sh` starts the updater; cron jobs for update.sh are no longer needed. Not verified: the updater image and compose on the NAS, a real update cycle. |
| 2026-10-31 | Speed on phones and the NAS: long grids render as you scroll, covers load a few at a time (on-screen first), rarely used pages load on first open; on the server, matches rebuild from the last scan, analysis and fingerprinting run at low priority, and a larger I/O threadpool (`UV_THREADPOOL_SIZE=16`) keeps streams from queueing behind image work. |
| 2026-11-01 | Song measurement moved to worker threads, one song at a time: on the NAS it blocked the main thread for seconds per song, and whole-library analysis would have frozen streams and pages. |
| 2026-11-01 | Security hardening before a login exists: local-only actions need a home address, no proxy in between, and the server addressed by IP or a local name (`LOCAL_HOSTNAMES` for others), against DNS rebinding; every change request carries Playarr's own header (no cross-site requests); a saved Lidarr API key is only sent to the server it was saved for. |
| 2026-11-01 | Listening history and **Made for you** (`docs/plans/2026-11-01-mixes.md`): 12 mixes made on the server in the background on a timer, in one household time zone, stored by recording id so matching doesn't empty them. **Profiles** per device rather than accounts: history, mixes, stats and ListenBrainz follow the profile; favorites and playlists stay shared for now. Plays go to ListenBrainz (open data, the same ids end to end) rather than Last.fm. |
| 2026-11-01 | Gapless playback and crossfade with two `<audio>` elements taking turns (replacing the single element): iOS keeps them playing in the background. Phones that fix the volume in hardware get gapless playback but no fades. |
| 2026-11-01 | **DJ transitions** rendered by the server, not mixed live in the browser (design: `docs/plans/2026-11-01-beatmatching-design.md`): a locked iPhone can't run Web Audio or start a file at an exact moment, so each transition is a file played between A and B, and the phone still shows two songs. A pure, deterministic planner in `packages/mix` shared by server and browser; desktop browsers also mix skips live. |
| 2026-11-02 | DJ mix analysis: beats and bars from Beat This! (small, MIT) in onnxruntime-web on the server, not our onset comb alone. The comb confused kicks with off-beats and found bars right ~half the time; the model fixes phase, octave and bars, the comb keeps 0.01 BPM precision. WebAssembly, not onnxruntime-node, so the Alpine image stays (≈15 s a song on the N100, ~1.3 GB while running, in a worker that stops when idle). |
| 2026-11-02 | Testing on iPhone through the iOS Simulator: `pnpm sim` (`scripts/ios-sim/`) boots a simulator, opens pages in its Safari, taps and types, reads the console and takes screenshots. It talks to the simulator's Web Inspector socket directly (the protocol Mac Safari's Develop menu uses), so it needs nothing but Xcode: no `safaridriver --enable` (admin), no Appium. Taps are JavaScript clicks, not touches. First finding: over `http://192.168.1.103:4000` iOS Safari has no service worker at all, confirming that offline songs on phones need HTTPS (Phase 5). |
| 2026-11-02 | **Even volume through levelled streams**: the server serves each song as a WAV at its level (`/stream/:id/levelled.wav?gain=`), turned up as well as down, because iPhones ignore an element's volume. Loudness is our own EBU R128 measurement (−14 LUFS target), not ReplayGain tags, so every song gets one. DJ transitions are rendered at the same levels, so the volume never jumps at a join; with even volume off, none are applied. Cost: uncompressed audio over the network until there's transcoding. |
| 2026-11-02 | One tempo for everything: beat analysis's (the mix map), so covers, mixes and DJ mix never disagree; sound analysis no longer measures its own. Settings → Analysis shows four analyses that don't overlap (beat, sound, loudness, tags), each with one button. |
| 2026-11-02 | Joins between files are lined up on the sound itself on desktop (cross-correlation through a Web Audio graph, delay nodes, audio-clock waits), since an element's reported time isn't the sample heard. Web Audio is kept to desktop browsers (no iPhone, iPad or Android; a fine pointer): iOS suspends it when the screen locks, which silenced the players. There, files take over in step by their reported times. |
