# Playarr

A modern, responsive music player for the web that uses a [Lidarr](https://lidarr.audio) library as its source. It works on desktop and on phones, where it installs as an app with lock-screen controls.

Lidarr manages a music library but can't play it: its API serves metadata, not audio. Playarr adds a small companion server that streams the files Lidarr manages, serves their artwork, and keeps favorites and playlists.

## Search and request music without going through Lidarr

Playarr is also a listener-friendly front door to Lidarr's search. Anyone using Playarr can look for music the way they think about it, by song, artist or album, and get it added without ever opening Lidarr:

- **Search for a song, not a release.** Type "bohemian rhapsody" and Playarr finds the original song, works out which album it belongs to, and offers to request that album. Lidarr itself only searches artists and albums.
- **See what you already have.** Results show which songs and albums are already in the library, so they can be played straight away.
- **Request in one tap.** Playarr adds the album to Lidarr, monitoring just that album rather than the artist's whole discography, starts the search, and shows download progress until the songs arrive in the library.
- **Discover from your playlists.** "Songs like these" under each playlist suggests similar music. Songs you own can be added to the playlist, and missing ones can be requested the same way.

This means listeners don't need a Lidarr account, the API key, or any knowledge of quality profiles and monitoring. Lidarr stays an admin tool, and Playarr is where people find and ask for music.

## How it fits together

```
┌──────────────┐               ┌─────────────────────────┐   X-Api-Key   ┌──────────┐
│  Web client  │ ────────────▶ │     Playarr server      │ ────────────▶ │  Lidarr  │
│ (React PWA)  │ ◀──────────── │  /api/*  /stream/:id    │ ◀──────────── │          │
└──────────────┘  JSON, audio  │  /art/*  (cache)        │   metadata    └──────────┘
                               │  SQLite (user data)     │
                               └───────────┬─────────────┘
                                           │ read-only
                                    ┌──────▼───────┐
                                    │ Music files  │ (the folder Lidarr manages)
                                    └──────────────┘
```

The server keeps the Lidarr API key to itself; the browser only ever talks to Playarr.

## Repository layout

A pnpm monorepo, all TypeScript:

| Package | What it is |
|---|---|
| `apps/server` | Fastify 5 server. Keeps a snapshot of the Lidarr library, refreshed every 10 minutes. Streams audio with HTTP range support, serves resized artwork, and stores favorites, playlists and song analysis in SQLite (`node:sqlite`). In production it also serves the built web app, so everything runs as one process on one port. |
| `apps/web` | React 19 app built with Vite 8, Tailwind 4, React Router 7, TanStack Query and Zustand. Installable as a PWA, with its own service worker that can play songs saved on the device. |
| `packages/shared` | Types shared by both sides, plus the byte-range parser used by the server and the service worker. |
| `docker/` | Dockerfile for a single image containing the server, the web app and ffmpeg. |

## Key design points

- **Pluggable audio source.** The server reads music from local disk (the normal case, next to Lidarr), or over SSH or SFTP from another machine, which is handy in development. `PATH_MAP` translates Lidarr's paths to the ones Playarr sees.
- **Folder sources.** Besides Lidarr, any folder on the server can be a source. Playarr reads its tags (falling back to "Artist/Album/01 Title" names), merges the songs with Lidarr's, and never modifies the files on its own. Untagged albums are matched on MusicBrainz automatically (and by their sound with an AcoustID key); doubtful matches wait for you in Settings. Optionally, Playarr can tidy a folder into Artist/Album/NN Title: it proposes the moves, you choose which to apply, and every change can be undone. A folder can also be on another machine, over SSH or SFTP, without mounting anything. Folders can be on SMB shares too (Windows, macOS, most NAS), read through rclone: it's in the Docker image; native installs need rclone on the PATH. For NFS, mount the export on the host and add it as a folder on This server (in Docker, under the folder mounted at /host).
- **The browser never sends a file path.** `/stream/:id` only serves file IDs that Lidarr reports, and refuses anything outside the configured music folders.
- **Discover and requests** combine several open sources: Deezer for finding songs by popularity, Lidarr for artists and albums, MusicBrainz for discographies and IDs, and ListenBrainz for "Songs like these" recommendations.
- **Generated playlist covers.** Each playlist gets artwork drawn from how its songs actually sound. ffmpeg decodes each song once and Playarr's own DSP code measures tempo, beat strength, loudness, brightness and more. One of six layouts is drawn as SVG and served as WebP. A cover stays fixed until you pick a new one.
- **Player built for mobile.** A single `<audio>` element keeps background playback working on iOS. Media Session integration gives lock-screen and OS media controls. The accent color follows the current album art.
- **Settings** has four panels. Sources: where the music comes from. Playback: songs kept on this device and the keyboard shortcuts. Requests: whether people can request albums, whether Lidarr searches right away, and the root folder and profiles new artists get (chosen from Lidarr's lists; `LIDARR_ROOT_FOLDER`, `LIDARR_QUALITY_PROFILE_ID` and `LIDARR_METADATA_PROFILE_ID` in `.env` apply when nothing is chosen). Appearance: the accent color (from the album art or a fixed one), motion and the audio format badges. Playback and Appearance are per device, saved in the browser; Sources and Requests apply to everyone and, until there's a login, can only be changed from the home network. Turning requests off hides every Request button and the server refuses new requests.
- **Fast and offline-friendly.** The next few songs in the queue are downloaded ahead of time and played from the device by the service worker. Library data is saved in IndexedDB, so the app opens instantly, and pages prefetch on hover or tap. These features need HTTPS or localhost.

## Running it

Copy `.env.example` to `.env`. `LIDARR_URL` and `LIDARR_API_KEY` are optional: on first start they become the Lidarr source in **Settings → Sources**, where it's managed from then on. Set `MEDIA_SOURCE` (plus `PATH_MAP` if Playarr sees the music at a different path than Lidarr).

```bash
pnpm install
pnpm dev                          # server on :4000 + web on :5180
pnpm build && pnpm start          # production: one process on :4000 serving the API and the web app
pnpm -C apps/server test          # unit tests: audio analysis, cover generation
pnpm --filter @playarr/web test   # unit tests plus smoke tests against a running server
```

### Docker

Build the image from the repository root, then mount the music folder read-only at the same path Lidarr uses, so no path mapping is needed:

```bash
docker build -f docker/Dockerfile -t playarr .
docker run -d --name playarr -p 4000:4000 \
  -e LIDARR_URL=http://lidarr:8686 -e LIDARR_API_KEY=... \
  -e PATH_MAP=/data/media/music=/data/media/music \
  -v /path/to/music:/data/media/music:ro \
  -v "$HOME/Music:/host:ro" \
  -v "$PWD/config:/config" -v "$PWD/cache:/cache" \
  playarr
```

Anything under /host can then be added in Settings → Sources → Folder.

`/config` holds favorites, playlists and song analysis: keep it and back it up. `/cache` holds artwork and covers and is safe to delete.

### Keeping a server up to date from GitHub

`docker/compose.yaml` and `docker/update.sh` run Playarr as a compose service that rebuilds itself from the latest commit on GitHub. Put both in a folder on the server (for example `/volume1/docker/playarr`) with a `.env` holding `LIDARR_URL`, `LIDARR_API_KEY` and `MUSIC_DIR`, then:

```bash
sudo sh update.sh            # build and start the latest commit on main; does nothing if it's already running
sudo sh update.sh --force    # rebuild anyway
sudo sh update.sh --ref X    # deploy a branch, tag or commit
```

It downloads the source from GitHub (no git needed), builds with `docker compose up -d --build`, and waits until Playarr answers. `config`, `cache` and `.env` are kept, and a failed build leaves the running container alone. Each update replaces `compose.yaml` with the deployed commit's copy, so put your own mounts in `compose.override.yaml` next to it (start from `docker/compose.override.example.yaml`). That's where host folders for Settings → Sources → Folder → This server go: mounting `/volume2` at `/host/volume2` makes `/volume2/data` browsable as `/host/volume2/data`. Run `update.sh --force` (or `docker compose up -d`) after changing it. `--quiet` makes it suitable for cron, for example every 15 minutes.

From a development machine with the SSH settings in `.env`, `pnpm deploy:nas` does the same over SSH; `pnpm deploy:nas --local` ships the local last commit instead, for work that isn't pushed.

## Status and roadmap

Playarr has no login yet, so don't expose it to the internet without something in front of it: anyone who can reach it can stream the library and request albums through Lidarr. Planned next:

- Login and HTTPS
- ffmpeg transcoding for formats browsers can't play, and for mobile data
- Gapless preload of the next track
- Drag to reorder the queue
- Play history and "recently played"
- Lyrics, ReplayGain, crossfade and EQ

See [PLAN.md](PLAN.md) for the full architecture, roadmap and design decisions.
