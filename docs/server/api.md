# Server API

Every route the Playarr server answers, grouped by what it's for, with who may call it. The routes are registered in `apps/server/src/routes/*.ts` and wired in `apps/server/src/index.ts`; the shared request and response types are in `packages/shared`. How the server fits with the rest is in [../architecture.md](../architecture.md).

## Who may call a route

| mark | meaning |
|---|---|
| **open** | anyone, signed in or not |
| **signed in** | any account with a session; in setup mode, anyone (acting as the owner) |
| **own** | any signed-in account, for its own data; in setup mode, only from the home network |
| **admin** | admins; in setup mode, only from the home network |
| **requester** | accounts allowed to request albums; in setup mode, anyone |
| **session** | a real session (none exists in setup mode) |
| **setup** | only in setup mode, and only from the home network |

"The home network" is `isLocalRequest` in `apps/server/src/net.ts`: a local socket address, no proxy headers, and the server addressed by IP or a local name. Details in [accounts-and-access.md](accounts-and-access.md). Routes that serve songs, art or data about songs answer only for what the account may hear.

---

## Routes

### Library

| method and path | purpose | who |
|---|---|---|
| `GET /api/health` | Lidarr reachable? music files readable? library stats (only when signed in), whether requests are on for the caller | open |
| `GET /api/artists`, `/api/artists/:id`, `/api/artists/:id/tracks` | artists, one artist, an artist's songs | signed in |
| `GET /api/albums?sort=&limit=`, `/api/albums/random`, `/api/albums/:id`, `/api/tracks/random` | albums (by title, artist, year or added), random albums or songs, one album | signed in |
| `GET /api/search?q=` | artists, albums, songs and playlists in the library; when nothing matches as typed, what's a letter or two away, with `near: true` | signed in |
| `GET /api/tracks/:id/metadata` | everything about a song (Show metadata); file paths only for admins | signed in |
| `GET /api/tracks/:id/lyrics` | lyrics: `.lrc`, tags or LRCLIB | signed in |
| `POST /api/files/:fileId/rematch` | match a folder file again, or ask Lidarr to refresh the artist | admin |
| `POST /api/library/refresh` | full rescan of every source | admin |
| `GET /api/musicbrainz/status` | MusicBrainz queue status and files waiting for matching | signed in |

### Audio and artwork

| method and path | purpose | who |
|---|---|---|
| `GET/HEAD /stream/:fileId` | the file as it is, with byte ranges | signed in |
| `GET/HEAD /stream/:fileId/lossless.wav` | ALAC or AIFF as a lossless WAV, for browsers that can't play them | signed in |
| `GET/HEAD /stream/:fileId/levelled.wav?gain=` | the song at its even-volume level, 16-bit 44.1 kHz WAV, gain ±20 dB | signed in |
| `GET /art/:kind/:id/:type`, `/art/copy/:id`, `/art/remote?url=` | Lidarr artwork, a folder file's picture, allowlisted remote artwork; resized WebP, cached | signed in |
| `GET /art/playlist/:id`, `/art/playlist/:id/preview` | a playlist's generated cover, a candidate cover | signed in |
| `POST /api/levels` | even-volume gains (track and album) for up to 50 songs | signed in |
| `POST /api/mix-maps`; `GET\|PUT /api/recordings/:id/cues` | mix maps for up to 50 songs; mix points set by hand | signed in |
| `POST /api/transitions`; `GET/HEAD /transitions/:file` | ask for a DJ transition A→B; the rendered file | signed in |

Details in [streaming-and-art.md](streaming-and-art.md) and [../mixing.md](../mixing.md).

### Favorites and playlists

| method and path | purpose | who |
|---|---|---|
| `GET /api/favorites`; `PUT\|DELETE /api/favorites/:recordingId` | the account's favorites | signed in |
| `GET\|POST /api/playlists`; `GET\|PATCH\|DELETE /api/playlists/:id` | the account's playlists and those shared with everyone; only the owner changes one | signed in |
| `POST /api/playlists/:id/items`, `DELETE /api/playlists/:id/items/:itemId`, `PUT /api/playlists/:id/order` | add, remove and reorder songs | signed in |
| `POST /api/playlists/holding` | `{ recordingIds }` → `{ holding: { [playlistId]: n } }`: how many of those songs each of the account's own playlists already holds, for Add to playlist's ticks | signed in |
| `PUT /api/playlists/:id/cover` | choose the generated cover's layout and variant ([playlist-covers.md](playlist-covers.md)) | signed in |
| `GET /api/playlists/:id/recommendations` | "Songs like these" | signed in |

### Discover and requests

| method and path | purpose | who |
|---|---|---|
| `GET /api/discover/search?q=`, `/api/discover/artists/:mbid`, `/api/discover/artists/:mbid/similar`, `/api/discover/artist-lookup?name=` | search beyond the library (Lidarr's metadata search and Deezer), an artist's page, similar artists, find an artist on MusicBrainz by name | signed in |
| `GET /api/requests` | albums requested through Lidarr, with progress (the whole server's) | signed in |
| `POST /api/requests`, `DELETE /api/requests/:mbid` | request an album, drop a request | requester |

Details in [discover-and-requests.md](discover-and-requests.md).

### Listening and Made for you

| method and path | purpose | who |
|---|---|---|
| `POST /api/plays` | songs heard on a device (accepted but not kept when history is off) | signed in |
| `GET /api/plays/recent-albums`, `/api/stats?range=` | Jump back in; listening stats and year in review | signed in |
| `GET /api/mixes`, `/api/mixes/:key`; `POST /api/mixes/:key/regenerate\|save` | the account's mixes; make one again, save it as a playlist | signed in |
| `POST /api/radio`, `/api/lucky` | songs like these seeds; a Feeling Lucky set | signed in |

Details in [../mixes.md](../mixes.md).

### Server and accounts

| method and path | purpose | who |
|---|---|---|
| `GET /api/server` | server id, name, version, oldest app version, setup mode, public URL; the owner's username in setup mode | open |
| `POST /api/auth/setup` | claim the server: the owner's username and password | setup |
| `POST /api/auth/sign-in`, `/api/auth/redeem` | sign in; choose a password with a setup code (both rate-limited per address) | open |
| `POST /api/auth/switch` | make a token this browser's session cookie (authenticates by the token) | open |
| `GET /api/auth/me`, `POST /api/auth/sign-out` | who's signed in; sign this device out | session |
| `GET\|POST /api/accounts`, `DELETE /api/accounts/:id`, `POST /api/accounts/:id/reset` | list, create (with a setup code), remove, reset a password; create and reset refused in setup mode | admin |
| `PATCH /api/accounts/:id` | change an account; members may change their own name only | admin, or own name |
| `GET /api/accounts/:id/sessions`, `DELETE /api/accounts/:id/sessions/:sessionId` | an account's devices; sign one out | admin, or own account |

### Settings and analysis

| method and path | purpose | who |
|---|---|---|
| `GET /api/settings/sources` | the sources; connection settings only for admins | signed in |
| `POST /api/settings/sources`, `PATCH\|DELETE /api/settings/sources/:id`, `PUT /api/settings/sources/order`, `POST /api/settings/sources/test` | add, change, remove, reorder and test sources | admin |
| `POST /api/settings/sources/:id/rescan\|rematch`, `GET\|POST /api/settings/sources/:id/review`, `GET\|POST /api/settings/sources/:id/organize`, `POST …/organize/undo` | rescan, rematch, review matches, organize files and undo ([matching-and-organize.md](matching-and-organize.md)) | admin |
| `GET /api/settings/folders`, `POST /api/settings/folders/browse`, `GET /api/settings/folders/access` | browse folders on the server or over SSH, SFTP or SMB; whether SMB is available | admin |
| `GET\|PUT /api/settings/matching`, `/api/settings/requests` | matching settings (the AcoustID key); where requests go in Lidarr | admin |
| `GET\|PUT /api/settings/updates`, `POST /api/settings/updates/check` | automatic updates ([updates-and-deploy.md](updates-and-deploy.md)) | admin |
| `GET /api/settings/mixes`; `PUT /api/settings/mixes` | Settings → Mixes with the caller's history; changing how mixes are made | own; admin |
| `DELETE /api/settings/mixes/history` | forget the account's listening history | own |
| `GET\|PUT\|DELETE /api/settings/listenbrainz`, `POST /api/settings/listenbrainz/earlier` | the account's ListenBrainz link; send earlier plays | own |
| `GET /api/analysis/progress` | each analysis's progress over the library | signed in |
| `POST /api/analysis/:kind` | queue beat, sound, loudness or tag analysis (or all) for the library | admin |

Anything else that isn't under `/api/`, `/stream/`, `/art/` or `/transitions/` is the web app (`index.html` for unknown GETs), served to anyone.

---

## Security in short

- **Sign-in.** Once any account has a password, every `/api`, `/stream`, `/art` and `/transitions` request needs a session, except finding the server, its health and signing in (the **open** routes above). The app sends a Bearer token, the web an HttpOnly cookie; tokens and setup codes are stored as SHA-256, passwords as scrypt. Failed sign-ins and codes are limited to 10 per 15 minutes per client address (the visitor's, behind a proxy trusted with `TRUST_PROXY`).
- **No cross-site changes.** Every `/api/` request other than GET, HEAD or OPTIONS must carry `X-Playarr: 1` unless it has a Bearer token (`isFromApp` in `net.ts`).
- **Rights.** Admins change settings; each account has its own history, ListenBrainz link, favorites and playlists. Before setup, admin actions and claiming the server need the home network: a local address, no proxy in between, and the server addressed by IP or a local name (`LOCAL_HOSTNAMES` for others), against DNS rebinding.
- **Library access.** Each account hears every source or a chosen list, enforced through a per-account view of the catalog in the catalog and search, streams, art, transitions, levels, mix maps, lyrics, metadata, favorites, playlists, mixes, radio and stats. Discover and the request list are the whole server's.
- **Files.** `/stream` serves only file ids the account's catalog knows, never a path from the client. Folder files must lie in their source's folder; Lidarr files, after `PATH_MAP`, in one of its target folders (unchecked when `PATH_MAP` is empty). `/transitions/:file` serves only names the transition service makes.
- **Secrets.** The Lidarr API key and saved SSH or SMB passwords never reach the client, and a saved key or password is only sent back to the server it was saved for. `/art/remote` fetches only from an allowlist of `https` hosts, on every redirect.
- **Recovery.** A forgotten owner password is reset on the server host (`reset-password`), never over the network. The last password on the server can't be reset or removed.
- **Not yet.** Playarr itself speaks plain HTTP; HTTPS needs a reverse proxy in front of it.

---

## Lidarr endpoints Playarr uses

All through `LidarrClient` (`apps/server/src/lidarr/client.ts`), with the `X-Api-Key` header, server-side only.

| purpose | endpoint |
|---|---|
| health, version | `GET /api/v1/system/status` |
| root folders, profiles (Settings → Requests) | `GET /api/v1/rootfolder`, `/qualityprofile`, `/metadataprofile` |
| the library | `GET /api/v1/artist`, `/album`, `/album?albumIds=…`, `/track?artistId=`, `/trackfile?artistId=` |
| one file with its tags (Show metadata, rematch) | `GET /api/v1/trackfile/{id}` |
| artwork | `GET /api/v1/mediacover/{artist\|album}/{id}/{file}` |
| Discover and requests | `GET /api/v1/search?term=`, `/album/lookup?term=lidarr:{mbid}`, `/artist/lookup?term=lidarr:{mbid}`; `POST /api/v1/album`; `PUT /api/v1/album/monitor`; `GET /api/v1/queue` |
| commands | `POST /api/v1/command` (`AlbumSearch` after a request, `RefreshArtist` on rematch); `GET /api/v1/command/{id}` |

Lidarr serves no audio: Playarr reads the files itself ([sources-and-catalog.md](sources-and-catalog.md)).
