# Running, deploying and updating Playarr

This covers how Playarr runs on a development machine, how it's packaged as a Docker image, how it's deployed to the NAS, and how it keeps itself up to date from GitHub. The files live in `docker/` (image, compose stack, deploy and update scripts), `apps/server/src/config.ts` (environment), `apps/server/src/update` (Settings → Updates) and `scripts/` plus `.githooks/` (versioning).

For how the server is put together, see [../architecture.md](../architecture.md); for its routes, [api.md](api.md).

---

## 1. Running it locally

From the repository root (Node 25, pnpm 10 through corepack):

| Command | What it does |
|---|---|
| `pnpm install` | Installs everything, and points git at `.githooks` (the `prepare` script) |
| `pnpm dev` | Server on **:4000** (`tsx watch`) and the Vite dev server on **:5180**, side by side. Vite listens on the LAN too, so a phone can open it |
| `pnpm dev:server`, `pnpm dev:web` | One of the two |
| `pnpm build` | Builds the web app (typecheck, then `vite build`), then the server (`tsup`) |
| `pnpm start` | Production mode: one process on :4000 serving the API and `apps/web/dist` |
| `pnpm typecheck` | `tsc --noEmit` in every package (the web app also checks the service worker's own tsconfig) |
| `pnpm -C apps/server test` | Server unit tests (vitest) |
| `pnpm -C packages/mix test` | Mixing: analysis, planner, renderer |
| `pnpm --filter @playarr/web test` | Web unit tests, plus smoke tests against a running server (see [../web.md](../web.md)) |

The server reads the root `.env` (`--env-file-if-exists=../../.env`). Vite proxies `/api`, `/stream`, `/art` and `/transitions` to `PLAYARR_SERVER` (default `http://localhost:4000`). Port 5180 is fixed (`strictPort`).

There's no ESLint or Prettier setup. Don't run Prettier over the code: with no config, it rewrites whole files.

On this Mac, ffmpeg, fpcalc and rclone aren't installed by default. With `MEDIA_SOURCE=ssh`, analysis runs ffmpeg on the NAS over SSH; to analyse local folders, `brew install ffmpeg`.

## 2. Configuration

Configuration comes from environment variables, validated with zod in `apps/server/src/config.ts`. Empty values count as unset. `.env.example` lists them with comments; copy it to `.env` (gitignored, never committed). The important ones:

| Variable | Default | What |
|---|---|---|
| `PORT`, `HOST` | `4000`, `0.0.0.0` | Where the server listens |
| `DATA_DIR` | `data` | The SQLite database: accounts, favorites, playlists, history, analysis. Keep and back up |
| `CACHE_DIR` | `.cache` | Artwork, covers, rendered transitions. Safe to delete |
| `ART_CACHE_MB`, `TRANSITIONS_CACHE_MB` | `2048`, `1024` | Cache caps, least recently used trimmed first |
| `WEB_DIST` | `../../web/dist` from the server build | The built web app to serve |
| `LIDARR_URL`, `LIDARR_API_KEY` | unset | Seed the Lidarr source once; Settings → Sources owns it afterwards (see [sources-and-catalog.md](sources-and-catalog.md)) |
| `MEDIA_SOURCE`, `PATH_MAP` | `none`, empty | How Lidarr's files are read (`local`, `ssh`, `sftp`), and `lidarrPrefix=playarrPrefix` pairs |
| `SSH_HOST`, `SSH_PORT`, `SSH_USER`, `SSH_PASSWORD`, `SSH_PRIVATE_KEY_PATH` | | For `MEDIA_SOURCE=ssh/sftp`, and for `pnpm deploy:nas` |
| `FOLDER_ROOTS` | `/` | Where folder sources may live; the image sets `/host` |
| `ANALYSIS`, `FFMPEG_PATH`, `FPCALC_PATH`, `RCLONE_PATH` | `on`, tool names | Analysis on/off and the external tools |
| `LIBRARY_REFRESH_MINUTES` | `10` | Catalog sync interval |
| `LIDARR_ROOT_FOLDER`, `LIDARR_QUALITY_PROFILE_ID`, `LIDARR_METADATA_PROFILE_ID` | unset | Fallbacks for Settings → Requests |
| `MUSICBRAINZ_CONTACT` | `self-hosted` | The contact MusicBrainz asks clients to send |
| `PUBLIC_URL`, `TRUST_PROXY` | unset | The address clients use, and which reverse proxy to believe (addresses or CIDRs, `loopback`, or `true`; not a hop count) |
| `LOCAL_HOSTNAMES` | empty | Extra host names that count as the home network (read in `net.ts`); see [accounts-and-access.md](accounts-and-access.md) |
| `SERVER_NAME`, `BONJOUR` | machine name, `on` | What apps call the server, and whether it's advertised as `_playarr._tcp` |
| `UPDATE_DIR` | unset | The folder shared with the updater (compose sets `/update`) |

`LOG_LEVEL` and `LOG_REQUESTS=1` (read straight from the environment) control logging. The `NAS_*` variables are used only by `deploy.mjs` (section 4); the `REVIEW_*` and `SCREENSHOT_*` ones only by the iOS release scripts (see [../ios/README.md](../ios/README.md)).

## 3. The Docker image

`docker/Dockerfile` builds from the repository root in two stages.

- **Build stage**: `node:24-alpine` with python3, make and g++ (for ssh2's optional native helpers) and pnpm 10.32.1. It installs dependencies from the lockfile first, so editing the source doesn't reinstall them. It then runs `pnpm build`, makes a production-only copy of the server with `pnpm deploy --prod`, and copies in the built server, its `assets/` and the web app. It finishes with `chmod -R a+rX` over the output (see the UGOS note in section 4).
- **Runtime stage**: `node:24-alpine` plus `ffmpeg` (analysis, levelled streams, transitions), `chromaprint` (`fpcalc`, for fingerprints) and `rclone` (SMB folder sources). The server is at `/app/server` and the web app at `/app/web`.
- **Environment**: `NODE_ENV=production`, `UV_THREADPOOL_SIZE=16` (so file reads and streams don't queue behind image resizing), `HOST=0.0.0.0`, `PORT=4000`, `WEB_DIST=/app/web`, `DATA_DIR=/config`, `CACHE_DIR=/cache`, `FOLDER_ROOTS=/host`, `MEDIA_SOURCE=local`.
- **Port** 4000, with a `HEALTHCHECK` fetching `/` every 30 s.

The image doesn't set a user: compose does.

## 4. The compose stack and the NAS

`docker/compose.yaml` (project name `playarr`) has two services.

**`playarr`** is built from `./src` with `docker/Dockerfile`. It runs as `${PUID:-1000}:${PGID:-10}`, like the other containers on the NAS, so files in `config/` and `cache/` belong to the NAS user. It listens on port `4000:4000`. Its mounts:

- `${MUSIC_DIR}` → `/data/media/music`, read-only: the same path Lidarr uses, with `PATH_MAP=/data/media/music=/data/media/music`, so Lidarr's paths work unchanged;
- `./config` → `/config` and `./cache` → `/cache`;
- `./update` → `/update`, with `UPDATE_DIR=/update`.

From `.env` it passes `LIDARR_URL`, `LIDARR_API_KEY`, `TZ` (default `Europe/London`), and `PUBLIC_URL`, `TRUST_PROXY` and `SERVER_NAME` (empty means unset).

**`updater`** is described in section 5.

`compose.yaml` is replaced on every update, so local mounts go in `compose.override.yaml` next to it, which compose merges in and no script touches. `docker/compose.override.example.yaml` shows the pattern: host folders mounted read-only under `/host` with their names kept (`/volume2` → `/host/volume2`), and read-write for a folder Playarr should organise. Bonjour needs host networking; with the port mapping, iOS adds the server by address.

### The NAS

The NAS is a UGREEN DXP2800 running UGOS (Debian 12). Lidarr runs in its own compose stack there, with the music at host `/volume2/data/media/music`, mounted at `/data/media/music`. Playarr has its own stack in `/volume1/docker/playarr`, separate from the media stack, so deploys never touch Lidarr. Docker needs sudo there.

| Path | What |
|---|---|
| `compose.yaml`, `update.sh` | Copied from the deployed commit on each deploy |
| `compose.override.yaml` | Your own mounts; never overwritten |
| `.env` (mode 600) | `LIDARR_URL`, `LIDARR_API_KEY`, `MUSIC_DIR`, `PLAYARR_DIR` (written by the deploy) plus any lines of your own |
| `src/` | The deployed source (`src/REVISION` holds its commit): the build context |
| `DEPLOYED`, `LATEST` | The commit running, and the newest on GitHub `main` at the last check |
| `config/` | The database: keep and back up |
| `cache/` | Artwork, covers, transitions: safe to delete |
| `update/` | Shared between Playarr and the updater (section 5) |

**UGOS permissions.** Inherited ACLs on `/volume1/docker` leave unpacked files at mode 770 and new files readable by everyone. So the image makes its build output world-readable (the app runs as uid 1000, not root), and the deploy `chmod 600`s `.env` as well as setting a umask, which on its own isn't enough.

Logs: `sudo docker compose -f /volume1/docker/playarr/compose.yaml logs -f`. Backup: `config/`.

### `pnpm deploy:nas` (`docker/deploy.mjs`)

Run from a development machine. It reads the SSH settings from `.env`, plus `NAS_DIR` (default `/volume1/docker/playarr`), `NAS_MUSIC_DIR` (default `/volume2/data/media/music`), `NAS_LIDARR_URL` (default `LIDARR_URL`) and `NAS_SUDO_PASSWORD` (default `SSH_PASSWORD`). It never prints secrets.

- **Default**: copies `docker/update.sh` to the NAS and runs it with sudo, so the NAS downloads and builds the latest commit on GitHub `main`. It warns if this checkout's HEAD differs from GitHub's `main`: push first.
- **`--local`**: streams `git archive HEAD` into `src/` instead, so only committed code goes (no `.env`, no local data), copies `compose.yaml` and `update.sh` from it, removes `DEPLOYED` (so the next update rebuilds GitHub's commit), and runs `docker compose up -d --build --remove-orphans`. Use it for work that isn't pushed.
- Either way it rewrites the four managed `.env` lines and keeps the NAS's other lines, then waits for `/api/health` and reports Lidarr, music access and the track count.
- **`--with-data`**: also copies this machine's database, as a `VACUUM INTO` snapshot (consistent even while the local server runs), only if the NAS has none. **`--force-data`** replaces the NAS's, stopping Playarr first.

The image is always built on the NAS itself (x86_64): there's no registry and no cross-building.

## 5. Updates

### `update.sh`

`docker/update.sh` lives in the deploy folder and does one update. It asks GitHub's API for the commit at the ref (`main` unless `--ref X`) of `PLAYARR_REPO` (default `nicolabortignon/playarr`) and writes it to `LATEST`. If that's already `DEPLOYED` (and there's no `--force`), it stops. Otherwise it:

1. downloads the tarball from codeload (no git needed);
2. swaps it into `src/` and writes `REVISION`;
3. copies over `compose.yaml` and the commit's own `update.sh`;
4. runs `docker compose up -d --build --remove-orphans`;
5. polls the health URL for up to two minutes (40 × 3 s);
6. writes `DEPLOYED` only once Playarr answers.

A failed build leaves the running container alone. Further details:

- A lock directory (`.update.lock`) allows one run at a time.
- It records `PLAYARR_DIR=<its folder>` in `.env`.
- It creates `update/` (mode 0775, owned like the folder) before compose would create it as root.
- When run as root, it keeps files owned by the folder's owner.
- `--quiet` prints only changes and failures, and failures start with `✗`.

The first `sudo sh update.sh` on a machine also builds and starts the updater.

### The updater container

`docker/updater.Dockerfile` is `docker:28-cli` plus curl, jq, tar and the compose plugin. It runs `docker/updater.sh`. It's the **only container with the Docker socket**, and it has no ports. Giving the socket to Playarr would hand root on the host to a web app; the updater instead accepts nothing but a few files.

It mounts the deploy folder at the **same absolute path** as on the host (`.:${PLAYARR_DIR}`). Compose resolves `./config` and similar paths to host paths, and the Docker daemon runs on the host, so the paths must match.

Every 30 s, `updater.sh`:

1. writes a heartbeat to `status.json`;
2. reads `settings.json`;
3. runs `update.sh --quiet` when a Check now is waiting (`update/request`), or when automatic updates are on and the interval has passed.

Inside the updater, `update.sh` rebuilds only `playarr` (`--no-deps`, since `PLAYARR_UPDATER=1`) and checks health at `http://playarr:4000/api/health`. While it runs, the heartbeat goes on every 3 s. When an update succeeds, a one-off container from the updater image (`playarr-updater-refresh`) recreates the updater. It can't recreate itself, because compose stops the old container before starting the new one, which would cut the command off halfway. The last state, error, `lastCheck` and `lastUpdate` survive a restart.

Only `main` of `PLAYARR_REPO` can be deployed this way: the updater passes no `--ref`. GitHub serves fork commits through the parent repository's API, so a free-form ref from Settings would let anyone who can reach Settings deploy a fork.

### The `update/` folder protocol

Nothing in `update/` is trusted by the updater, and nothing in it is ever run.

| File | Written by | Read by | Notes |
|---|---|---|---|
| `settings.json` | Playarr | updater | `{enabled, intervalMinutes}`. jq reads only `enabled == true` and an interval of 15, 60, 360 or 1440 (anything else counts as 60). It must be a regular file, not a symlink |
| `request` | Playarr | updater | Its existence asks for a check (the content is a timestamp); the updater deletes it |
| `status.json` | updater | Playarr | `state` (`idle`, `checking`, `failed`), `heartbeat`, `lastCheck`, `lastUpdate` (Unix seconds), `deployed`, `latest`, and `error` when failed |
| `last.log` | updater | Playarr | The last run's output only |

Both sides write to a temporary file and rename it into place. The updater writes its temporary files in the deploy folder, which Playarr can't write to, so a rename replaces any symlink planted in `update/` rather than writing through it.

### Settings → Updates

`apps/server/src/update/bridge.ts` (`UpdateBridge`) is all Playarr knows about updates: it never talks to Docker. `info()` returns the settings (defaults: off, 60 minutes), the parsed status (SHAs and numbers validated, the error capped at 500 characters), whether a request is waiting, and the last 60 lines of `last.log` (from at most its last 64 KB). Updates are `available` only when all three hold:

- `UPDATE_DIR` is set. Otherwise: "Automatic updates need the Docker setup".
- The folder is writable.
- The heartbeat is under 180 s old. Otherwise the panel says to run `update.sh` once.

The routes in `apps/server/src/routes/settings.ts` are `GET /api/settings/updates`, `PUT /api/settings/updates` (`enabled`, `intervalMinutes`) and `POST /api/settings/updates/check`. All are admin-only; before the server is set up, they work from the home network only. A missing or unwritable folder answers 409, and bad values 400.

The panel (`apps/web/src/components/UpdatesPanel.tsx`) shows:

- the running version and commit, the latest on GitHub, and whether an update is available;
- an on/off switch and an interval;
- Check now;
- the last result, with the log.

It polls every 5 s while a check is waiting or running, and every minute otherwise. When `deployed` changes under an open page, it offers a Reload.

## 6. Versioning

Every commit raises the patch version in the root `package.json`. `.githooks/pre-commit` runs `scripts/bump-version.mjs`, which changes only the `"version"` line, in both the staged copy and the working tree, and leaves other edits alone. It's skipped during rebases, merges, cherry-picks and reverts, and with `PLAYARR_NO_BUMP=1`. `pnpm install` enables the hook (`git config core.hooksPath .githooks`).

The version is compiled into the server (`tsup` defines `__APP_VERSION__`; `src/version.ts` reads `package.json` when run from source) and the web app (`__APP_VERSION__`). The web app also gets `__APP_REVISION__`, from `REVISION` in downloaded source or else `git rev-parse`. The iOS app has its own build number and version (see [../ios/README.md](../ios/README.md)).

## 7. Releasing

There's no separate release step:

1. Commit on `main`; the hook raises the version.
2. Push to GitHub.
3. The NAS picks the commit up at its next scheduled check. It's set to every 15 minutes in Settings → Updates; the default is hourly. Check now, `pnpm deploy:nas` or `sudo sh update.sh` on the NAS do it at once.

Watch the result in Settings → Updates or the compose logs. The only CI is `.github/workflows/ios.yml`, which tests the iOS app and uploads TestFlight builds; the server and web tests run locally.

See also [../decisions.md](../decisions.md) for why things are this way.
