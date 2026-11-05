# Architecture

Playarr is a self-hosted music player. One server holds the catalog and serves the audio; a web app and a native iOS app play it. This page is the big picture; each part has its own doc ([index](README.md)).

## The key constraint: Lidarr doesn't stream

Lidarr's API (`/api/v1`) covers library metadata: artists, albums, tracks, track files with their paths, and artwork. It has no endpoint that serves audio bytes. So Playarr has its own server, which:

1. talks to Lidarr, so the API key stays on the server and browsers never meet CORS;
2. reads the music files itself (on its own disk, over SSH or SFTP, or from an SMB share) and streams them with byte ranges;
3. keeps its own catalog, built from Lidarr and from plain folders, so Lidarr is optional;
4. analyses the audio (loudness, sound, beats) for even volume, playlist covers, mixes and DJ transitions;
5. stores everything Playarr-only (accounts, favorites, playlists, history, settings) in SQLite.

```
┌──────────────┐               ┌──────────────────────────────┐   X-Api-Key   ┌──────────┐
│   Web app    │ ─────────────▶│        Playarr server        │──────────────▶│  Lidarr  │ (optional)
│ (React PWA)  │◀───────────── │ /api  /stream  /art          │◀──────────────│          │
└──────────────┘ cookie session│ /transitions                 │   metadata    └──────────┘
┌──────────────┐               │ SQLite: catalog + user data  │
│   iOS app    │ ─────────────▶│ worker threads: analysis,    │──▶ MusicBrainz, AcoustID, ListenBrainz,
│  (SwiftUI)   │◀───────────── │ transitions                  │    Deezer, LRCLIB, Cover Art Archive
└──────────────┘ Bearer token  └──────────────┬───────────────┘
                                              │ read (local disk, SSH, SFTP, SMB via rclone)
                                       ┌──────▼───────┐
                                       │ Music files  │
                                       └──────────────┘
```

## The monorepo

pnpm workspaces (`pnpm-workspace.yaml`: `apps/*`, `packages/*`), except the iOS app, which sits outside the workspace.

| Path | What |
|---|---|
| `apps/server` | Fastify 5 API, streaming, analysis, transitions, accounts. TypeScript, zod for config and request bodies, `node:sqlite`. |
| `apps/web` | React 19 PWA (Vite, Tailwind 4, TanStack Query, Zustand, React Router 7) with its own service worker. |
| `apps/ios` | SwiftUI app for iPhone and iPad: XcodeGen spec, Makefile, three Swift packages, App Store Connect scripts. |
| `packages/shared` | The API contracts as TypeScript types, the byte-range parser (`range.ts`) used by the server and the service worker, and which lossless formats need a WAV fallback (`playable.ts`). The iOS models are generated from it. |
| `packages/mix` | DJ mixing with no dependencies: analysis, the planner, the renderer, blend ordering. Runs on the server and in the browser. |
| `docker/` | Dockerfile, compose stack, the updater container, `update.sh`, `deploy.mjs`. |
| `scripts/` | `bump-version.mjs` (pre-commit hook), `ios-sim/` (`pnpm sim`, iOS Safari in the Simulator), `beat-this/` (exporting the beat model). |
| `docs/` | These docs. |

## The server

`apps/server/src/index.ts` wires everything together. In outline:

- **Catalog.** Sources (Lidarr, folders) are synced one after the other into SQLite tables, then served from memory by `Library` (`library/library.ts`), refreshed every `LIBRARY_REFRESH_MINUTES` (10 by default). Untagged folder music is identified in the background against MusicBrainz and AcoustID. See [server/sources-and-catalog.md](server/sources-and-catalog.md) and [server/matching-and-organize.md](server/matching-and-organize.md).
- **Files.** `FileResolver` (`catalog/files.ts`) turns a copy id into a readable file: Lidarr's files through `MEDIA_SOURCE` and `PATH_MAP`, folder sources through their own filesystem. The client never sends a path.
- **Streaming.** `/stream/:fileId` serves files with byte ranges; `levelled.wav` serves a song at its even-volume level; `lossless.wav` serves Apple Lossless and AIFF to browsers that can't play them. See [server/streaming-and-art.md](server/streaming-and-art.md).
- **Analysis.** One DSP worker thread and a beat-model thread (Beat This! in onnxruntime-web), fed by ffmpeg decodes that run where the files are. Loudness, sound features, mix maps and tags. Off with `ANALYSIS=off`.
- **Transitions.** Planned by `packages/mix`, rendered to cached FLAC files ahead of time. See [mixing.md](mixing.md).
- **Mixes and listening.** Play reports, the Made for you mixes, radio, stats and ListenBrainz scrobbling. See [mixes.md](mixes.md).
- **Discover and requests.** Search beyond the library and request albums through Lidarr. See [server/discover-and-requests.md](server/discover-and-requests.md).
- **Accounts.** Every request passes `authHook` (`accounts/auth.ts`), which finds the account from a Bearer token or the session cookie. Each account sees a view of the catalog built from the sources it may hear. See [server/accounts-and-access.md](server/accounts-and-access.md).
- **Web app.** In production the server also serves the built web app (`WEB_DIST`, else `apps/web/dist`), so one process and one port (4000) do everything.
- **Bonjour.** The server advertises `_playarr._tcp` so the iOS app finds it on the home network (`BONJOUR=off` to stop).

The full route list is in [server/api.md](server/api.md).

## The clients

Both clients speak the same HTTP API and play the same files; neither talks to Lidarr or the internet services directly.

- **Web** ([web.md](web.md)). Signs in with an HttpOnly cookie, so `<audio>`, images and the service worker need nothing special. Two `<audio>` elements take turns for gapless playback and crossfades and a third plays DJ transitions; desktop browsers add a Web Audio graph for sample-exact joins and live mixes. The service worker keeps songs for load-ahead and offline listening (HTTPS or localhost only).
- **iOS** ([ios/README.md](ios/README.md)). Signs in with a Bearer token per account, keeps a list of servers, and plays through its own AVAudioEngine, which schedules everything on one sample clock. Downloads run on a background URLSession.

Shared rules keep them in step: the planner in `packages/mix` is deterministic, so a transition the server renders is the one either client expects; play reports, levels and transition requests use the same endpoints; and the iOS models are generated from `packages/shared`.

## Deployment

One Docker image (Node 24 Alpine with ffmpeg, chromaprint and rclone), usually run on the same host as Lidarr with the music mounted read-only at the path Lidarr uses. A second container, the updater, is the only one with the Docker socket and pulls new versions of `main` on a timer (Settings → Updates). User data lives in `DATA_DIR` (back it up); caches in `CACHE_DIR` (safe to delete). See [server/updates-and-deploy.md](server/updates-and-deploy.md).

The owner's own install runs on a UGREEN NAS; pushing to GitHub `main` is the release, and the NAS updates itself.
