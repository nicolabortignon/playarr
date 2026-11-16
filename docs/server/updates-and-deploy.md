# Running, deploying and updating Playarr

This covers how Playarr runs on a development machine, how it's packaged as a Docker image, how it's deployed to the NAS, and how it keeps itself up to date from GitHub. The files live in `docker/` (image, compose stack with its optional Caddy, deploy and update scripts), `apps/server/src/config.ts` (environment), `apps/server/src/update` (Settings → Updates) and `scripts/` plus `.githooks/` (versioning). Getting a public HTTPS address, with Caddy or Tailscale, is its own page: [https.md](https.md).

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
| `DATA_DIR` | `data` | The SQLite database: accounts, favorites, playlists, history, analysis. Keep and back up. Copies made before migrations go in `backups/` inside it (see below) |
| `CACHE_DIR` | `.cache` | Artwork, covers, rendered transitions. Safe to delete |
| `ART_CACHE_MB`, `TRANSITIONS_CACHE_MB` | `2048`, `1024` | Cache caps, least recently used trimmed first |
| `ENCODES_MAX`, `ENCODES_PER_ACCOUNT`, `ENCODE_CACHE_MB` | `8`, `4`, `128` | Songs encoded at once for High and Normal streams, in all and for one account, and the memory they're held in, finished or not (see [streaming-and-art.md](streaming-and-art.md#2-encoded-streams-streamfileidaac)) |
| `WEB_DIST` | `../../web/dist` from the server build | The built web app to serve |
| `LIDARR_URL`, `LIDARR_API_KEY` | unset | Seed the Lidarr source once; Settings → Sources owns it afterwards (see [sources-and-catalog.md](sources-and-catalog.md)) |
| `MEDIA_SOURCE`, `PATH_MAP` | `none`, empty | How Lidarr's files are read (`local`, `ssh`, `sftp`), and `lidarrPrefix=playarrPrefix` pairs |
| `SSH_HOST`, `SSH_PORT`, `SSH_USER`, `SSH_PASSWORD`, `SSH_PRIVATE_KEY_PATH` | | For `MEDIA_SOURCE=ssh/sftp`, and for `pnpm deploy:nas` |
| `FOLDER_ROOTS` | `/` | Where folder sources may live; the image sets `/host` |
| `ANALYSIS`, `FFMPEG_PATH`, `FPCALC_PATH`, `RCLONE_PATH` | `on`, tool names | Analysis on/off and the external tools |
| `LIBRARY_REFRESH_MINUTES` | `10` | Catalog sync interval |
| `LIDARR_ROOT_FOLDER`, `LIDARR_QUALITY_PROFILE_ID`, `LIDARR_METADATA_PROFILE_ID` | unset | Fallbacks for Settings → Requests |
| `MUSICBRAINZ_CONTACT` | `self-hosted` | The contact MusicBrainz asks clients to send |
| `PUBLIC_URL`, `TRUST_PROXY` | unset | The address clients use, and which reverse proxy to believe (addresses or CIDRs, `loopback`, the proxies' names such as `playarr-caddy`, or `true`; not a hop count). Settings → Away from home checks the address ([https.md](https.md)) |
| `PLAYARR_DOMAIN` | unset | The domain the https profile's Caddy serves Playarr at; makes `PUBLIC_URL` `https://<domain>` and `TRUST_PROXY` `playarr-caddy` unless they're set |
| `LOCAL_HOSTNAMES` | empty | Extra host names that count as the home network (read in `net.ts`); see [accounts-and-access.md](accounts-and-access.md) |
| `SERVER_NAME`, `BONJOUR` | machine name, `on` | What apps call the server, and whether it's advertised as `_playarr._tcp` |
| `UPDATE_DIR` | unset | The folder shared with the updater (compose sets `/update`) |

`LOG_LEVEL` and `LOG_REQUESTS=1` (read straight from the environment) control logging. Every 4xx and 5xx answer is logged either way, with its request id, the account and the route ([api.md](api.md#security-in-short)); `LOG_REQUESTS=1` adds Fastify's own lines for every request, URLs and all. The `NAS_*` variables are used only by `deploy.mjs` (section 4); the `REVIEW_*` and `SCREENSHOT_*` ones only by the iOS release scripts (see [../ios/README.md](../ios/README.md)).

### The database across versions

Migrations run when the server starts (`openDatabase` in `apps/server/src/db.ts`), each once, tracked with SQLite's `user_version`. Before a start that migrates an existing database, the server copies it with `VACUUM INTO` (consistent even with the database open) to `<DATA_DIR>/backups/playarr-<version>-schema-<n>.db`: the version that's about to migrate it (every commit raises the version, so it names the commit) and the schema it was at. The copy is made as `<name>.part` and renamed once complete, so one cut short never passes for a whole one. The newest five copies stay. When the copy can't be made (a full disk), the server doesn't start, rather than migrate without one.

A database a newer version has used (its `user_version` beyond this version's migrations) is refused: the server stops, saying which schema it found and where the copies are, instead of running against tables it doesn't know. An update that doesn't start puts back its own copy by itself (section 5). To go back to an older version by hand, stop the server and put back the copy made before that version's successor migrated: `cp config/backups/playarr-<version>-schema-<n>.db config/playarr.db`, removing `playarr.db-wal` and `playarr.db-shm` beside it.

## 3. The Docker image

`docker/Dockerfile` builds from the repository root in two stages.

- **Build stage**: `node:24-alpine` with python3, make and g++ (for ssh2's optional native helpers) and pnpm 10.32.1. It installs dependencies from the lockfile first, so editing the source doesn't reinstall them. It then runs `pnpm build`, makes a production-only copy of the server with `pnpm deploy --prod`, and copies in the built server, its `assets/` and the web app. It finishes with `chmod -R a+rX` over the output (see the UGOS note in section 4).
- **Runtime stage**: `node:24-alpine` plus `ffmpeg` (analysis, levelled streams, transitions), `chromaprint` (`fpcalc`, for fingerprints) and `rclone` (SMB folder sources). The server is at `/app/server` and the web app at `/app/web`.
- **Environment**: `NODE_ENV=production`, `UV_THREADPOOL_SIZE=16` (so file reads and streams don't queue behind image resizing), `HOST=0.0.0.0`, `PORT=4000`, `WEB_DIST=/app/web`, `DATA_DIR=/config`, `CACHE_DIR=/cache`, `FOLDER_ROOTS=/host`, `MEDIA_SOURCE=local`.
- **Port** 4000, with a `HEALTHCHECK` on `/api/health`, the same as compose.yaml's (section 4).

The image doesn't set a user: compose does.

## 4. The compose stack and the NAS

`docker/compose.yaml` (project name `playarr`) has two services, and a third, `playarr-caddy`, under the profile `https`.

**`playarr`** is built from `./src` with `docker/Dockerfile`. It runs as `${PUID:-1000}:${PGID:-10}`, like the other containers on the NAS, so files in `config/` and `cache/` belong to the NAS user. It listens on port `4000:4000`. Its mounts:

- `${MUSIC_DIR}` → `/data/media/music`, read-only: the same path Lidarr uses, with `PATH_MAP=/data/media/music=/data/media/music`, so Lidarr's paths work unchanged;
- `./config` → `/config` and `./cache` → `/cache`;
- `./update` → `/update`, with `UPDATE_DIR=/update`.

From `.env` it passes `LIDARR_URL`, `LIDARR_API_KEY`, `TZ` (default `Europe/London`), and `PUBLIC_URL`, `TRUST_PROXY`, `PLAYARR_DOMAIN` and `SERVER_NAME` (empty means unset).

Its health check, which `docker ps` and the NAS's container list show, asks `/api/health` every 30 s with the image's `wget` and passes while the answer has `"database":{"ok":true`: not `ok`, which is false whenever Lidarr or the music can't be reached. Each check gets 45 s, longer than Lidarr's own 30 s timeout, which the health route waits on. Three failures in a row make the container unhealthy, and failures in the first five minutes don't count, so a start that migrates the database has time to. Docker only reports it: nothing restarts the container for it, and `update.sh` makes its own check (section 5).

**`updater`** is described in section 5.

**`playarr-caddy`** (`caddy:2`; named like its container so that a `caddy` service of an owner's own in `compose.override.yaml` isn't merged into it) exists only with `COMPOSE_PROFILES=https` in `.env`: HTTPS at the owner's domain, `PLAYARR_DOMAIN`. It publishes ports 80 and 443, gets and renews the certificate from Let's Encrypt by itself, and proxies to `playarr:4000` over the project's network (`docker/Caddyfile`, mounted from `src/docker/`: Caddy reads the deployed commit's copy when it starts). Its certificates are in `caddy/data`. Without the profile nothing about it exists, not even a network. Setting it up, and why Playarr believes it by name rather than by a pinned address: [https.md](https.md).

`compose.yaml` is replaced on every update, so local mounts go in `compose.override.yaml` next to it, which compose merges in and no script touches. `docker/compose.override.example.yaml` shows the pattern: host folders mounted read-only under `/host` with their names kept (`/volume2` → `/host/volume2`), and read-write for a folder Playarr should organise. Bonjour needs host networking; with the port mapping, iOS adds the server by address.

### The NAS

The NAS is a UGREEN DXP2800 running UGOS (Debian 12). Lidarr runs in its own compose stack there, with the music at host `/volume2/data/media/music`, mounted at `/data/media/music`. Playarr has its own stack in `/volume1/docker/playarr`, separate from the media stack, so deploys never touch Lidarr. Docker needs sudo there.

| Path | What |
|---|---|
| `compose.yaml`, `update.sh` | Copied from the deployed commit on each deploy |
| `compose.override.yaml` | Your own mounts; never overwritten |
| `.env` (mode 600) | `LIDARR_URL`, `LIDARR_API_KEY`, `MUSIC_DIR`, `PLAYARR_DIR` (written by the deploy) plus any lines of your own (`PUBLIC_URL`, `COMPOSE_PROFILES`, `PLAYARR_DOMAIN`, …) |
| `src/` | The deployed source (`src/REVISION` holds its commit): the build context |
| `DEPLOYED`, `LATEST` | The commit running, and the newest on its channel at the last check (empty on stable without a release) |
| `RELEASE` | On stable, the newest release's tag at the last check |
| `ROLLED_BACK` | A commit that didn't start and was rolled back: not tried again until a newer one (or `--force`) |
| `src.previous/`, `compose.yaml.previous` | While an update runs, what was running, put back if the new version doesn't start |
| `config/` | The database: keep and back up. `config/backups/` holds the copies made before migrations |
| `cache/` | Artwork, covers, transitions: safe to delete |
| `caddy/` | With the https profile: Caddy's certificates and their keys. Keep |
| `update/` | Shared between Playarr and the updater (section 5) |

**UGOS permissions.** Inherited ACLs on `/volume1/docker` leave unpacked files at mode 770 and new files readable by everyone. So the image makes its build output world-readable (the app runs as uid 1000, not root), and the deploy `chmod 600`s `.env` as well as setting a umask, which on its own isn't enough.

Logs: `sudo docker compose -f /volume1/docker/playarr/compose.yaml logs -f`. Backup: `config/`.

### `pnpm deploy:nas` (`docker/deploy.mjs`)

Run from a development machine. It reads the SSH settings from `.env`, plus `NAS_DIR` (default `/volume1/docker/playarr`), `NAS_MUSIC_DIR` (default `/volume2/data/media/music`), `NAS_LIDARR_URL` (default `LIDARR_URL`) and `NAS_SUDO_PASSWORD` (default `SSH_PASSWORD`). It never prints secrets.

- **Default**: copies `docker/update.sh` to the NAS and runs it with sudo, so the NAS updates itself on its channel (`main`, on a NAS set up before there were channels) once the commit's checks have passed on GitHub: right after a push, it says it's waiting for them. It warns if this checkout's HEAD differs from GitHub's `main`: push first.
- **`--local`**: streams `git archive HEAD` into `src/` instead, so only committed code goes (no `.env`, no local data), copies `compose.yaml` and `update.sh` from it, removes `DEPLOYED` (so the next update rebuilds GitHub's commit), and runs `docker compose up -d --build --remove-orphans`. Use it for work that isn't pushed.
- Either way it rewrites the four managed `.env` lines and keeps the NAS's other lines, then waits for `/api/health` and reports Lidarr, music access and the track count.
- **`--with-data`**: also copies this machine's database, as a `VACUUM INTO` snapshot (consistent even while the local server runs), only if the NAS has none. **`--force-data`** replaces the NAS's, stopping Playarr first.

The image is always built on the NAS itself (x86_64): there's no registry and no cross-building.

## 5. Updates

### Channels

- **Stable** installs the newest release of `PLAYARR_REPO` (default `nicolabortignon/playarr`): the tag GitHub's releases API calls latest (pre-releases and drafts don't count), resolved to its commit as `refs/tags/<tag>`. The TV app's releases (`tv-v*`, [tv/release.md](../tv/release.md)) are never marked latest, and a `tv-v*` tag is never taken for one of the server's, should GitHub answer one while the server has none. Until the repository has a release, a stable install stays where it is and says so; that isn't a failure.
- **Edge** installs the newest commit on `main`.

A new install starts on stable. One whose Settings → Updates were saved before there were channels (a `settings.json` without `channel`) stays on edge, as it was: the owner's NAS deploys every push that way. Switching from edge to stable installs the newest release at the next check, even when it's older than what's running; if that release can't use the database a newer version migrated, it refuses to start, and the update goes back (below).

### `update.sh`

`docker/update.sh` lives in the deploy folder and does one update. It takes the channel from `--channel stable|edge`, or else from `update/settings.json` by the updater's rule (below), read with nothing but `dd`, `tr`, `sed` and `case`; `--ref X` deploys a branch, tag or commit by hand instead. It asks GitHub's API for the channel's newest commit (one call for edge, two for stable) and writes it to `LATEST`, and on stable the release's tag to `RELEASE`. If that's already `DEPLOYED` (and there's no `--force`), it stops. A commit in `ROLLED_BACK` isn't tried again (until `--force`). Otherwise:

1. **The gate.** It asks GitHub for the commit's check runs named "Server and web" (`/commits/<sha>/check-runs?check_name=…`, the job in `.github/workflows/server-web.yml`), one more call. Every run must have completed with success. None yet, or one still running: it stays and says the commit is waiting for its checks, and asks again next time. One failed (or was canceled or skipped): it stays and says which commit failed. A rebuild of the commit running (`--force`) skips the gate.
2. It downloads the tarball from codeload (no git needed) and swaps it into `src/`, keeping the old one as `src.previous/`, and writes `REVISION`.
3. It copies over `compose.yaml` (keeping the old one as `compose.yaml.previous`) and the commit's own `update.sh`. The new `update.sh` stays even if the version doesn't start, so a fix to the script is never held back by the copy it replaces.
4. It tags the running container's image `playarr:previous` (compose names the image `playarr:latest`, so there's a name to put back), and notes the database copies the new version already has in `config/backups`.
5. It runs `docker compose up -d --build --remove-orphans`, which starts Caddy too while `COMPOSE_PROFILES=https`.
6. It waits for a real health check: `/api/health` answering `"database":{"ok":true}`, and again 10 s later, within five minutes (`PLAYARR_HEALTH_WAIT` seconds; for the updater, set it in `compose.override.yaml` when migrations take longer). Not `ok`, which is false whenever Lidarr or the music can't be reached: an outage of those never fails or rolls back an update. Each request gets up to 45 s, longer than Lidarr's own 30 s timeout, which the health route waits on. A version from before the `database` field passes with any answer of its own, as all did before.
7. Up: it writes `DEPLOYED`, removes `ROLLED_BACK` and the kept files, and prunes old images (`playarr:previous` stays until the next update, for going back by hand).

A failed build leaves the running container alone, and puts the old `src/` and `compose.yaml` back. When the new version doesn't come up (or its container couldn't start after the old one was removed), it goes back within the same run:

- it prints the new container's last 20 log lines and stops it;
- if the new version made a copy of the database in this run, it migrated: the previous version would refuse the database, so `update.sh` removes `playarr.db-wal` and `playarr.db-shm` and moves that copy (the earliest schema, if it made more than one) over `config/playarr.db`. Copies it made in earlier runs are left alone, since the database has moved on since; with no copy from this run, the database stays as it is;
- it puts back `compose.yaml` and `src/`, tags `playarr:previous` as `playarr:latest`, runs `docker compose up -d --no-build --no-deps --force-recreate playarr`, waits for the same health check, and records the commit in `ROLLED_BACK`.

Its exit status tells the updater what happened: 0 up to date or updated; 3 waiting for checks; 4 checks failed; 5 no release yet; 6 rolled back (now, or earlier: `ROLLED_BACK`); anything else failed. Lines starting with `✗` say what went wrong. Further details:

- A lock directory (`.update.lock`) allows one run at a time; GitHub's answers go inside it.
- It records `PLAYARR_DIR=<its folder>` in `.env`.
- It creates `update/` (mode 0775, owned like the folder) before compose would create it as root.
- When run as root, it keeps files owned by the folder's owner.
- `--quiet` prints only changes, waits and failures.
- With no curl it uses wget, reading GitHub's status from the headers `wget -S` prints. It needs no jq.

Without signing in, GitHub allows 60 API calls an hour from an address. A check makes one when up to date on edge (two on stable), and at most three when there's something to install. When the limit is used up, the check fails saying so, and the next one tries again.

The first `sudo sh update.sh` on a machine also builds and starts the updater.

### The updater container

`docker/updater.Dockerfile` is `docker:28-cli` plus curl, jq, tar and the compose plugin. It runs `docker/updater.sh`. It's the **only container with the Docker socket**, and it has no ports. Giving the socket to Playarr would hand root on the host to a web app; the updater instead accepts nothing but a few files.

It mounts the deploy folder at the **same absolute path** as on the host (`.:${PLAYARR_DIR}`). Compose resolves `./config` and similar paths to host paths, and the Docker daemon runs on the host, so the paths must match.

Every 30 s, `updater.sh`:

1. writes a heartbeat to `status.json`;
2. reads `settings.json`;
3. runs `update.sh --quiet --channel <channel>` when a Check now is waiting (`update/request`), or when automatic updates are on and the interval has passed.

The channel is `stable` when there's no `settings.json` yet, `edge` when it has no `channel`, and the `channel` it has when that's exactly `stable` or `edge`. Anything else (another value, another type, a file jq can't read) installs nothing: the check fails with "Settings → Updates has a channel this updater doesn't know: choose Stable or Edge again".

From `update.sh`'s exit status it records `state` and `outcome`: waiting for checks (`waiting`) and no release yet (`noRelease`) are `idle`, not failures; checks failed (`checksFailed`) and rolled back (`rolledBack`) are `failed`, with the `✗` line as the error, as for any other failure.

Inside the updater, `update.sh` rebuilds only `playarr` (`--no-deps`, since `PLAYARR_UPDATER=1`), plus `playarr-caddy` while the https profile is on, and checks health at `http://playarr:4000/api/health`. It names `playarr-caddy` only then, reading `COMPOSE_PROFILES` as compose does (the environment, else `.env`): compose starts a service named on its command line whatever the profiles say. While it runs, the heartbeat goes on every 3 s. When an update succeeds, a one-off container from the updater image (`playarr-updater-refresh`) recreates the updater. It can't recreate itself, because compose stops the old container before starting the new one, which would cut the command off halfway. A rollback leaves the updater as it is. The last state, error, outcome, channel, `lastCheck` and `lastUpdate` survive a restart.

Only `PLAYARR_REPO`'s releases or its `main` can be deployed this way: the updater passes a channel, never a `--ref`. GitHub serves fork commits through the parent repository's API, so a free-form ref from Settings would let anyone who can reach Settings deploy a fork. A release's tag comes from the repository's own releases API, never from Settings, and is resolved as `refs/tags/<tag>`, so it's never read as a commit.

### Going from the `update.sh` before channels

The NAS runs the `update.sh` of the version it has deployed, which copies the new commit's over itself, so the new script first runs with what the old one left: `DEPLOYED`, `LATEST`, a `status.json` without `outcome` or `channel`, a `settings.json` without `channel`, an image never tagged `playarr:previous`, and maybe no `config/backups`. It reads that as edge, tags the running image before its first update, goes back without a database copy when there's none from its run, and the updater keeps the old status. The old script deploys the commit that brings all this without a gate (it has none); every update after that is gated. `apps/server/src/update/scripts.test.ts` runs exactly that: the old script, frozen in `fixtures/update-before-channels.sh`, installs the new one, then the new updater updates from what it left, and goes back from there.

### The scripts' tests

`apps/server/src/update/scripts.test.ts` runs `update.sh` and `updater.sh` for real, with every POSIX shell it finds (`sh`, `dash`, and `busybox sh` with busybox's own tools, as in the updater's Alpine image), in a temporary deploy folder. curl, wget, docker, tar and sleep are stubs that log their calls and answer from files; jq is the real one. They run with the server's tests, so CI (which installs busybox) checks the scripts before any NAS runs them.

### The `update/` folder protocol

Nothing in `update/` is trusted by the updater, and nothing in it is ever run.

| File | Written by | Read by | Notes |
|---|---|---|---|
| `settings.json` | Playarr | updater | `{enabled, intervalMinutes, channel}`. jq reads only `enabled == true`, an interval of 15, 60, 360 or 1440 (anything else counts as 60) and a `channel` of exactly `stable` or `edge` (see above). It must be a regular file, not a symlink |
| `request` | Playarr | updater | Its existence asks for a check (the content is a timestamp); the updater deletes it |
| `status.json` | updater | Playarr | `state` (`idle`, `checking`, `failed`), `heartbeat`, `lastCheck`, `lastUpdate` (Unix seconds), `deployed`, `latest`, `error` when failed, and from the last check `outcome` (`waiting`, `checksFailed`, `noRelease`, `rolledBack`), `channel` and, on stable, `release`. `deployed`, `latest` and `release` come from `update.sh`'s files in the deploy folder, never from the old status |
| `last.log` | updater | Playarr | The last run's output only |

Both sides write to a temporary file and rename it into place. The updater writes its temporary files in the deploy folder, which Playarr can't write to, so a rename replaces any symlink planted in `update/` rather than writing through it.

### Settings → Updates

`apps/server/src/update/bridge.ts` (`UpdateBridge`) is all Playarr knows about updates: it never talks to Docker. `info()` returns the settings (defaults: off, 60 minutes, and the channel by the updater's rule; a value the updater would refuse reads as edge until it's chosen again), the parsed status (SHAs, numbers, the outcome, channel and tag validated, the error capped at 500 characters), whether a request is waiting, and the last 60 lines of `last.log` (from at most its last 64 KB). Saving writes the channel too, so settings saved once never fall back to the rule. Updates are `available` only when all three hold:

- `UPDATE_DIR` is set. Otherwise: "Automatic updates need the Docker setup".
- The folder is writable.
- The heartbeat is under 180 s old. Otherwise the panel says to run `update.sh` once.

The routes in `apps/server/src/routes/settings.ts` are `GET /api/settings/updates`, `PUT /api/settings/updates` (`enabled`, `intervalMinutes`, `channel`: `stable` or `edge`, never a repository, branch or commit) and `POST /api/settings/updates/check`. All are admin-only; before the server is set up, they work from the home network only. A missing or unwritable folder answers 409, and bad values 400.

The panel (`apps/web/src/components/UpdatesPanel.tsx`, and `UpdatesPanel.swift` in the iOS app) shows:

- the running version and commit, and the newest on the last check's channel: "Latest on main: 9f8e7d6" or "Latest release: v0.7.0 · 9f8e7d6", then "Up to date", "A newer version is available", or why it isn't installed ("Waiting for its checks", "Its checks failed", "It didn’t start"); "Latest release: none yet" on stable without one;
- the channel, Stable or Edge, with what it installs;
- an on/off switch and an interval;
- Check now;
- the last result, with the log: "Updated to v0.7.0", "Already up to date", "v0.7.0 is waiting for its checks on GitHub", "No release yet: Playarr stays on this version until the first one", or a failure in `update.sh`'s words, such as "9f8e7d6 failed its checks on GitHub, so Playarr stays on 1a2b3c4." or "9f8e7d6 didn't start, so Playarr went back to 1a2b3c4 (rolled back)".

It polls every 5 s while a check is waiting or running, and every minute otherwise. When `deployed` changes under an open page, it offers a Reload. The iOS panel shows the channel only for servers that have one.

## 6. Versioning

Every commit raises the patch version in the root `package.json`. `.githooks/pre-commit` runs `scripts/bump-version.mjs`, which changes only the `"version"` line, in both the staged copy and the working tree, and leaves other edits alone. It's skipped during rebases, merges, cherry-picks and reverts, and with `PLAYARR_NO_BUMP=1`. `pnpm install` enables the hook (`git config core.hooksPath .githooks`).

The version is compiled into the server (`tsup` defines `__APP_VERSION__`; `src/version.ts` reads `package.json` when run from source) and the web app (`__APP_VERSION__`). The web app also gets `__APP_REVISION__`, from `REVISION` in downloaded source or else `git rev-parse`. The iOS app has its own build number and version (see [../ios/README.md](../ios/README.md)).

## 7. Releasing

For edge installs (the owner's NAS among them) there's no separate release step:

1. Commit on `main`; the hook raises the version.
2. Push to GitHub. CI runs the "Server and web" check on the commit.
3. The NAS picks the commit up at its first scheduled check after the check has passed. It's set to every 15 minutes in Settings → Updates; the default is hourly. Check now, `pnpm deploy:nas` or `sudo sh update.sh` on the NAS do it at once (once the check has passed).

Stable installs follow GitHub releases: publish one on a commit whose check has passed, its tag named after the version (`gh release create v0.6.600 --target <commit> --generate-notes`), and each picks it up at its next check. Pre-releases and drafts don't count.

Watch the result in Settings → Updates or the compose logs. CI is three workflows: `.github/workflows/server-web.yml` typechecks and tests the shared packages, the server and the web app on every push and pull request, on the Docker image's Node (the web's smoke tests need a server, so they're skipped there), and its job's check run, "Server and web", is what the updater waits for; `.github/workflows/contracts.yml` checks the iOS and TV apps' models against the server's answers; `.github/workflows/ios.yml` tests the iOS app and uploads TestFlight builds.

See also [../decisions.md](../decisions.md) for why things are this way.
