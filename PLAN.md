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
GET  /api/playlists/:id/recommendations?variant=  → "songs like these" (owned + missing)
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
- [x] Manifest, icons, service worker (app shell precached, artwork CacheFirst, API NetworkFirst). Since 2026-10-29 it's our own worker (`src/sw.ts`, injectManifest) that also plays kept songs from disk (§14)
- [ ] iOS standalone quirks (background audio, safe areas, splash)
- [x] Gestures on Now Playing (drag down to close). *Swipe for next/prev still to do.*

### Phase 5: Server features
- [ ] ffmpeg transcoding with format negotiation (detect `canPlayType`, fall back for ALAC/WMA/etc. and mobile data)
- [ ] **Login + HTTPS before relying on the internet exposure** (decided 2026-10-30: exposed as is for now through the router's forward to NAS port 4000; this comes later):
  - *Login:* one password (`PLAYARR_PASSWORD`, stored hashed) and a sign-in screen. A signed, HttpOnly, Secure, SameSite=Lax session cookie, valid for months, guards `/api`, `/stream` and `/art` (the app shell and `/api/health` stay public). Login attempts are rate-limited, and the server returns 401s that the web app turns into the sign-in screen. Optionally trust the LAN (192.168.1.0/24) without a login.
  - *HTTPS:* a Caddy container in the compose stack terminates TLS and proxies to `playarr:4000`. The router forward moves from NAS:4000 to Caddy (e.g. external 443 → NAS 8443; UGOS already owns 80/443), and Playarr's own port goes back to LAN-only. With a static IP and no domain, either a Let's Encrypt certificate for the IP address (short-lived, renewed automatically by Caddy, if available by then) or a free DuckDNS name pointing at the IP with a normal certificate. HTTPS also unlocks the app install and offline songs on phones (§14).
  - *Until then:* anyone who finds the port can stream the library, edit playlists and favorites, and request albums through Lidarr (which downloads them). A quick interim option: a setting that turns requests off on the exposed instance.
- [x] SQLite (`node:sqlite`, `apps/server/data/playarr.db`): **favorites** and **playlists** (2026-10-28). *Still to do: play history, "recently played".*
- [x] **Docker image + NAS deployment** (2026-10-30, see §15): `pnpm deploy:nas` builds and runs Playarr on the NAS as its own compose stack

### Phase 6: Nice-to-haves
- [ ] Lyrics (embedded tags / `.lrc` sidecars, synced display)
- [ ] ReplayGain, crossfade, EQ (Web Audio)
- [x] **Load-ahead and offline songs** (built 2026-10-29, see §14): the next songs in the queue are kept on the device (LRU, size limit in Library), played by the service worker with byte ranges; library data persisted in IndexedDB; pages prefetched on hover/tap. *Next: "Download" pins for whole albums/playlists that never get evicted, and an offline view.*
- [x] **Discover & request** (built 2026-10-27, see §11): search beyond the library, request albums, live download progress
- [x] **Playlist recommendations** (built 2026-10-28, see §11): "Songs like these" under each playlist, with Add for songs you own and Request for songs you don't. *Next: the same for Favorites, and a "radio" built from one song.*
- [x] **Generated playlist covers** (built 2026-10-29, see §13): artwork drawn from what the songs sound like, measured from the audio. *Next: use the same audio features for smart shuffle / mood sorting, and a song "radio".*
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
4. **Remote access:** router port forwarding to NAS port 4000 on the home static IP (2026-10-30; Tailscale was set up, then dropped). Exposed without a login for now, by the user's choice; login + HTTPS are planned (Phase 5). Transcoding for mobile data is still open.
5. **Design preference:** any reference apps you like (Apple Music, Spotify, Plexamp, Feishin…)?

---

## 10. Running it

```bash
pnpm install
pnpm dev                 # server :4000 + web :5180 (also reachable on the LAN from a phone)
pnpm build && pnpm start # production: one process on :4000 serving the API and the built web app
pnpm --filter @playarr/web test   # smoke tests against the running server
pnpm deploy:nas          # build and (re)start the NAS deployment from the last commit (§15)
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

**Playlist recommendations:** ListenBrainz's labs `similar-recordings` API (no key; built from real listening sessions, keyed by MusicBrainz recording id, which every playlist entry already has). Up to 10 playlist songs are used as seeds (evenly spread; "New mix" picks a random set and shakes up the ranking). Each seed's scores are scaled to its own best match, then summed, so songs similar to several playlist songs rise. Songs already in the playlist are dropped, as are extra songs by the same lead artist ("feat." credits count as the lead: 3 per artist for owned songs, 2 for missing). Owned? Recording id in the library, then artist + title. One batch call to ListenBrainz's `metadata/recording` endpoint then adds what similar-recordings leaves out for missing songs: the lead artist's MusicBrainz id and the **release group** (= the Lidarr album), so Request goes straight to Lidarr. If that call fails, the release id is mapped through MusicBrainz, with name lookup as the last resort. Artist and album names link out: artist → library page if owned, else their discover page; album → album page if owned, else the artist's discography (where it can be requested). Covers come from Cover Art Archive through Lidarr's CDN. Results are cached for 1 h on the server and 10 min in the browser.

**Artist & album links (search, favorites, recommendations):** library songs link straight to their artist and album pages. Deezer songs only know names, so search attaches an artist id when it already has one (library, or an artist in the same search results); otherwise the link goes to `/discover/artist?name=`, which resolves the name on click (library → Lidarr search → MusicBrainz, via `GET /api/discover/artist-lookup`) and forwards. Albums not in the library open the artist's discography with `?album=`, which scrolls to and highlights that album (titles compared loosely, so "(Deluxe)" still matches). Singles and compilations aren't listed there, and the page says so.

**Lidarr setup seen:** quality profiles Any/Lossless/Standard (root default: Any), metadata profile Standard = Album/Studio/Official. Indexers: Knaben + The Pirate Bay via Prowlarr; download client: qBittorrent. Overridable via `LIDARR_ROOT_FOLDER`, `LIDARR_QUALITY_PROFILE_ID`, `LIDARR_METADATA_PROFILE_ID`.

## 13. Generated playlist covers

Each playlist gets artwork drawn from its music, not a collage of album art. Same songs → same cover.

**1. Listen (server, once per song, cached in SQLite `track_features`).** `ffmpeg` runs where the files are (over SSH on the NAS, `nice`d) and decodes up to 7 min to 11 kHz mono PCM (~5 MB, ~0.5 s per song). `analysis/dsp.ts` then measures, all in plain TypeScript:
- **tempo**: spectral-flux onset envelope → autocorrelation, with a log-normal prior around 120 BPM, refined over several beat multiples, folded into 70–180
- **pulse**: how clearly the beat stands out (the autocorrelation peak's prominence above its neighbouring dips; a slow crescendo doesn't count as a beat)
- **loudness**, **dynamics** (p95−p10 range), **brightness** (spectral centroid), **busyness** (onsets/s), **bass** (energy share < 150 Hz)
- **envelope**: 48-point loudness curve, the song's shape

Calibrated against known tempos in the library (Da Funk 111, Around the World 121, One More Time 123, Something About Us 100, Porcelain 95: all within 0.3 BPM) and beatless pieces (Jan Garbarek's *Officium* → pulse 0). Raw measurements are stored too, so scales can be recalibrated without re-decoding. `ANALYSIS=off` disables it; `FFMPEG_PATH` overrides the binary.

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
| `compose.yaml` | copied from `docker/` on each deploy |
| `.env` (mode 600) | `LIDARR_URL`, `LIDARR_API_KEY`, `MUSIC_DIR`; written by the deploy |
| `src/` | the deployed commit (`src/REVISION`), the build context |
| `config/` | favorites, playlists, song analysis (SQLite): keep and back up |
| `cache/` | artwork and covers: safe to delete |

**Container:** `playarr` (Node 24 Alpine with ffmpeg) runs as 1000:10 like the rest of the stack. Music is mounted read-only at `/data/media/music`, the same path Lidarr uses, so no path mapping is needed. It listens on port 4000.

**Deploy (`pnpm deploy:nas`, `docker/deploy.mjs`):** `git archive HEAD` goes over SSH into `src/` (only committed code: no `.env`, no local data). Then it writes `.env`, runs `sudo docker compose up -d --build` (the image is built on the NAS, natively x86_64), and waits for `/api/health`. `--with-data` copies this machine's database once (a `VACUUM INTO` snapshot, safe while the local server runs); `--force-data` replaces the NAS's.

**Updating:** commit, then `pnpm deploy:nas`. **Logs:** `sudo docker compose -f /volume1/docker/playarr/compose.yaml logs -f`. **Backup:** `config/`.

## 12. Decisions log

| Date | Decision |
|---|---|
| 2026-10-27 | Web-first React PWA with a Node/Fastify companion server, because Lidarr can't stream audio itself. |
| 2026-10-27 | The server reads audio through a pluggable `MediaSource`: `sftp` for local dev (no mounts), `local` disk when deployed next to Lidarr, `none` until configured. `/stream` only serves `trackFileId`s that Lidarr reports; the client never sends a path. |
| 2026-10-27 | Added `MEDIA_SOURCE=ssh` (exec `stat`/`tail`/`head` over SSH) because UGOS's SFTP hides non-UI shares. Config keys renamed `SFTP_*` → `SSH_*`. Paths are shell-quoted; channels close when the browser aborts. Limit: sshd `MaxSessions` (10) caps simultaneous streams per connection; fine for one user, revisit for multi-user. |
| 2026-10-27 | Discover/requests: Deezer for songs, Lidarr for artists/albums, MusicBrainz for discographies and name → id resolution. Albums are resolved to MusicBrainz ids only at request time (not per search result), which keeps search fast. |
| 2026-10-27 | Dev server must run outside Claude's sandbox: the sandbox blocks some external hosts (Cover Art Archive, Lidarr's image CDN). This Mac's internet also had intermittent connect timeouts; the code degrades gracefully (songs may be missing; covers retry once). |
| 2026-10-27 | Git repo initialized; commit each step. |
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
| 2026-10-30 | Organizing files (phase 4b): opt-in per folder source, review-then-apply. Layout Artist/Album/NN Title.ext (D-NN on multi-disc, Artist/Title.ext without an album), safe names, renames within the folder only, never overwrite, companions (covers, cue, log) follow when a folder's audio all moves, emptied folders removed, every move journaled (file_moves) and undoable per batch. The catalog follows renamed files in place, so copy ids, queues and offline songs survive. Server computes targets; the client only picks which files. |
| 2026-10-27 | Single `<audio>` element (not two swapped ones) so iOS background playback keeps working. Gapless/crossfade come later via Web Audio. |
| 2026-10-27 | Visual direction "liner notes": warm near-black, Gloock display serif, Schibsted Grotesk UI, DM Mono for specs and durations. The accent color comes from the current cover art; there's a subtle film grain. |
| 2026-10-27 | Stack versions: React 19, Vite 8, Tailwind 4, React Router 7 (pinned below v8), TanStack Query 5, Zustand 5, Motion 14, Fastify 5, zod 4, TypeScript 7. |
