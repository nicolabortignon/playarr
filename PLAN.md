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
| Library | Root folder `/data/media/music` (path inside the container). 9 artists (6 with files), 112 albums (30 with files), 412 tracks, 10.3 GB, ~31 h |
| Formats | FLAC 16/44.1 (185), MP3 320 (174), FLAC 24-bit 44.1/48/88.2 (53). All play natively in browsers, so transcoding is optional |
| Artwork | `/api/v1/mediacover/...` serves full-size images only (`cover-250.jpg` is the same file), so Playarr resizes them itself |
| NAS | UGREEN DXP2800 (UGOS, Debian 12, OpenSSH 9.2). The Docker stack is defined in `/volume1/docker/media-stack/docker-compose.yaml` |
| Music files on the host | Lidarr `/data/media/music` = host **`/volume2/data/media/music`** (from `/volume2/data:/data`). Navidrome mounts the same folder read-only |
| Music files access | ✅ `MEDIA_SOURCE=ssh` with user `Nicola` (admin group) and a password in `.env`. Notes: UGOS's custom `sftp-server` only exposes shares created in its UI (just `docker`), so SFTP can't see `/volume2/data`. `Nicola` has no home folder, so key auth isn't possible without changes on the NAS |
| Other services on host | Jellyfin 12.4 on :8096 (runs in Docker, so the host has Docker); something on :4533 (maybe Navidrome) |
| Local toolchain | Node 25.2, pnpm 10.32, Docker. **ffmpeg not installed** (`brew install ffmpeg` before the transcoding phase) |
| Ports | Playarr server **:4000**, Vite dev **:5180**. :5173 is taken by another local project (lifetool) |

---

## 3. Tech stack

**Monorepo** (pnpm workspaces)
```
playarr/
├── apps/
│   ├── web/        # React client (Vite)
│   └── server/     # Fastify API + streaming
├── packages/
│   └── shared/     # Shared TS types (Lidarr DTOs, Playarr API contracts)
├── docker/         # Dockerfile, compose example
└── PLAN.md
```

**Web client**
- React 19, TypeScript, Vite
- Tailwind CSS v4, Radix UI primitives for accessible menus, dialogs, and sliders
- TanStack Query for server state and caching; TanStack Router (or React Router) for routing
- Zustand for player and queue state, persisted to `localStorage`
- `vite-plugin-pwa` for the manifest, service worker, and installability
- Playback through a single `<HTMLAudioElement>` plus a second preloaded element for near-gapless transitions. Web Audio API added later for EQ and crossfade.
- Media Session API for lock-screen and OS media controls, artwork, and next/prev/seek
- Dynamic accent color pulled from the current album art (e.g. `fast-average-color`)

**Server**
- Node + Fastify, TypeScript
- `undici`/fetch Lidarr client with typed DTOs
- Streaming: `fs.createReadStream` with Range parsing; ffmpeg (`child_process`) for transcode to Opus/AAC/MP3
- SQLite (`better-sqlite3` + Drizzle) for user data
- In-memory library snapshot with periodic refresh. Later: subscribe to Lidarr SignalR (`/signalr/messages`) for live updates.
- Artwork proxy with disk cache and resizing (`sharp`) for thumbnails
- Serves the built web app as static files, giving one container and one port in production

**Deployment target**
- One Docker image. Run it on the Lidarr host (192.168.1.103) next to Lidarr and mount the music volume **read-only** at the same path Lidarr uses (or set a path mapping).

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

## 5. Playarr server API (draft)

```
GET  /api/health                     → Lidarr reachable? path mapping OK?
GET  /api/artists                    → list (sortable, with art URLs)
GET  /api/artists/:id                → artist + albums
GET  /api/albums?sort=&filter=       → albums with files
GET  /api/albums/:id                 → album + tracks (+ file/format info)
GET  /api/search?q=                  → artists / albums / tracks
GET  /api/recent                     → recently added albums
GET  /stream/:trackFileId            → audio (Range); ?format=opus|aac|mp3&bitrate=
GET  /art/:kind/:id?size=            → cached, resized artwork
POST /api/history                    → scrobble a play
CRUD /api/playlists, /api/favorites
```

**Security:** `/stream` only serves paths that come back from Lidarr for a known `trackFileId` *and* that resolve inside a configured music root (no path traversal). Playarr gets its own login. Never expose the Lidarr API key to the client.

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
- [ ] Decide how dev reaches the music files (see Open Questions)
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
- [ ] Preload the next track for near-gapless playback
- [x] Persist the queue and position across reloads
- [x] Keyboard shortcuts (Space, ←/→, Shift+←/→, ↑/↓, M, S, /)

### Phase 3: Discovery and polish
- [x] Search (artists, albums, tracks; ignores accents and punctuation)
- [x] Recently added, random albums, sorting. *Filtering by genre/format still to do.*
- [ ] Queue management: play next, add to queue, remove, clear ✅. *Drag to reorder still to do (`move()` exists in the store)*
- [x] Context menus (⋯ menus on tracks and albums). *Long-press still to do.*

### Phase 4: PWA and mobile
- [x] Manifest, icons, service worker (app shell precached, artwork CacheFirst, API NetworkFirst, `/stream` bypassed)
- [ ] iOS standalone quirks (background audio, safe areas, splash)
- [x] Gestures on Now Playing (drag down to close). *Swipe for next/prev still to do.*

### Phase 5: Server features
- [ ] ffmpeg transcoding with format negotiation (detect `canPlayType`, fall back for ALAC/WMA/etc. and mobile data)
- [ ] Playarr auth (single admin user to start)
- [ ] SQLite: favorites, playlists, play history, "recently played"
- [ ] Docker image + compose example for running next to Lidarr

### Phase 6: Nice-to-haves
- [ ] Lyrics (embedded tags / `.lrc` sidecars, synced display)
- [ ] ReplayGain, crossfade, EQ (Web Audio)
- [ ] Offline downloads (cache tracks in the service worker / IndexedDB)
- [x] **Discover & request** (built 2026-10-27, see §11): search beyond the library, request albums, live download progress
- [ ] Lidarr actions: show an in-library artist's missing albums, interactive release picking
- [ ] Live library updates through Lidarr SignalR
- [ ] Cast / AirPlay (Remote Playback API), Last.fm / ListenBrainz scrobbling
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
3. **Users:** one user (you) or multiple users with separate playlists and history?
4. **Remote access:** LAN-only, or reachable from outside (reverse proxy / Tailscale)? This affects auth and transcoding defaults.
5. **Design preference:** any reference apps you like (Apple Music, Spotify, Plexamp, Feishin…)?

---

## 10. Running it

```bash
pnpm install
pnpm dev                 # server :4000 + web :5180 (also reachable on the LAN from a phone)
pnpm build && pnpm start # production: one process on :4000 serving the API and the built web app
pnpm --filter @playarr/web test   # smoke tests against the running server
```

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

**Lidarr setup seen:** quality profiles Any/Lossless/Standard (root default: Any), metadata profile Standard = Album/Studio/Official. Indexers: Knaben + The Pirate Bay via Prowlarr; download client: qBittorrent. Overridable via `LIDARR_ROOT_FOLDER`, `LIDARR_QUALITY_PROFILE_ID`, `LIDARR_METADATA_PROFILE_ID`.

## 12. Decisions log

| Date | Decision |
|---|---|
| 2026-10-27 | Web-first React PWA with a Node/Fastify companion server, because Lidarr can't stream audio itself. |
| 2026-10-27 | The server reads audio through a pluggable `MediaSource`: `sftp` for local dev (no mounts), `local` disk when deployed next to Lidarr, `none` until configured. `/stream` only serves `trackFileId`s that Lidarr reports; the client never sends a path. |
| 2026-10-27 | Added `MEDIA_SOURCE=ssh` (exec `stat`/`tail`/`head` over SSH) because UGOS's SFTP hides non-UI shares. Config keys renamed `SFTP_*` → `SSH_*`. Paths are shell-quoted; channels close when the browser aborts. Limit: sshd `MaxSessions` (10) caps simultaneous streams per connection; fine for one user, revisit for multi-user. |
| 2026-10-27 | Discover/requests: Deezer for songs, Lidarr for artists/albums, MusicBrainz for discographies and name → id resolution. Albums are resolved to MusicBrainz ids only at request time (not per search result), which keeps search fast. |
| 2026-10-27 | Dev server must run outside Claude's sandbox: the sandbox blocks some external hosts (Cover Art Archive, Lidarr's image CDN). This Mac's internet also had intermittent connect timeouts; the code degrades gracefully (songs may be missing; covers retry once). |
| 2026-10-27 | Git repo initialized; commit each step. |
| 2026-10-27 | Single `<audio>` element (not two swapped ones) so iOS background playback keeps working. Gapless/crossfade come later via Web Audio. |
| 2026-10-27 | Visual direction "liner notes": warm near-black, Gloock display serif, Schibsted Grotesk UI, DM Mono for specs and durations. The accent color comes from the current cover art; there's a subtle film grain. |
| 2026-10-27 | Stack versions: React 19, Vite 8, Tailwind 4, React Router 7 (pinned below v8), TanStack Query 5, Zustand 5, Motion 14, Fastify 5, zod 4, TypeScript 7. |
