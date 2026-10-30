# Auto-update from Settings Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** In the Docker setup, Settings → Updates can turn on automatic updates: Playarr then rebuilds itself from the latest commit on GitHub `main` on a schedule, and the panel shows the running and latest versions, the last result, and a Check now button.

**Architecture:** A second compose service, `updater`, is the only container with the Docker socket. It loops: reads `update/settings.json`, and when an update is due (schedule) or asked for (`update/request`), runs the existing `docker/update.sh` and writes `update/status.json` and `update/last.log`. Playarr's container mounts the same `update/` folder at `/update` and only reads and writes those files; it never talks to Docker. Only `main` of the repository named in the updater's environment can be deployed.

**Tech Stack:** POSIX sh, `docker:cli` image (docker CLI + compose plugin) with curl, jq, GNU tar; Fastify 5, zod 4, vitest 5; React 19, TanStack Query 5. pnpm via `corepack pnpm`.

## Decisions

- **Why a separate container:** rebuilding needs Docker. Giving Playarr's container the socket would give root on the host to a web app without login. The updater has no ports and accepts nothing but three files.
- **What Settings can change:** `enabled` and `intervalMinutes` (15, 60, 360 or 1440). Not the branch, commit or repository: GitHub serves commits from forks through the parent repository's API, so a free-form ref would let anyone on the LAN deploy code from a fork. Check now works even when automatic updates are off.
- **Paths:** compose resolves `./config` etc. to host paths, and the Docker daemon runs on the host, so the updater must see the deploy folder **at the same absolute path** as the host: mounted `.:${PLAYARR_DIR}`. `update.sh` records `PLAYARR_DIR=<its folder>` in `.env` (and `deploy.mjs` writes it too); compose falls back to `/volume1/docker/playarr`.
- **Not killing itself:** inside the updater, `update.sh` recreates only `playarr` (`--no-deps playarr`). After a successful update the updater recreates itself last (`up -d --build --no-deps updater`); if its image changed, compose replaces the running updater, which is fine because the status is already written.
- **Health check from the updater:** `127.0.0.1` is the updater itself there, so `update.sh` takes `PLAYARR_HEALTH_URL` (default `http://127.0.0.1:4000/api/health`; the updater sets `http://playarr:4000/api/health`).
- **Availability in the app:** Updates works when `UPDATE_DIR` is set (compose sets `/update`), the folder is writable, and the updater's heartbeat in `status.json` is recent (< 3 minutes). Otherwise the panel explains what's missing (not in Docker; the updater isn't running yet: run `update.sh` once; can't write to the folder).
- **Bootstrapping:** the first `sudo sh update.sh` after this lands builds and starts the updater. A cron job set up earlier is no longer needed (the shared lock stops overlaps; the README says to remove it).

## Conventions

- Run from `/Users/bortignon/dev/playarr`. Server tests: `corepack pnpm -C apps/server test`; web unit tests: `corepack pnpm -C apps/web exec vitest run src`; typechecks: `corepack pnpm -C apps/server typecheck`, `corepack pnpm -C apps/web exec tsc --noEmit`; build: `corepack pnpm -C apps/web exec vite build`.
- The pre-commit hook raises the version and stages package.json on every commit: expected, never bypass it.
- Commit after every task on `main`, staging only that task's files. Don't push.
- No Docker here: test shell scripts with a stub `docker` on PATH (a script that logs its arguments), a temp folder as the deploy folder, and a throwaway local HTTP server for health (as was done for `update.sh`: see its test approach in Task 1). Real GitHub is reachable for `update.sh` dry runs.

---

### Task 1: `update.sh` works from inside the updater

**Files:** `docker/update.sh`

1. `HEALTH_URL="${PLAYARR_HEALTH_URL:-http://127.0.0.1:4000/api/health}"`; the health loop fetches it; the success line stays.
2. Record the folder for compose: after `cd "$DIR"`, ensure `.env` has `PLAYARR_DIR=$DIR` (create `.env` if missing; replace an existing `PLAYARR_DIR=` line; keep every other line and the file's permissions: write to `.env.new` with `umask 077`, then `mv`). Also `export PLAYARR_DIR="$DIR"`.
3. Create `$DIR/update` before compose runs (so Docker doesn't create it as root-only), owned like the folder (reuse the `OWNER` chown when root), mode 0775.
4. Write `$DIR/LATEST` with the SHA GitHub returned, every run (also when up to date), so the updater can show it.
5. Inside the updater (`PLAYARR_UPDATER=1`): `$DOCKER compose up -d --build --no-deps --remove-orphans playarr`; otherwise as today (`up -d --build --remove-orphans`, which also builds and starts the updater).
6. Dry-run as before with a stub docker and a local health server: check the `.env` edit (other lines kept, `PLAYARR_DIR` added once, replaced on a second run with a different folder), `LATEST`, the `update/` folder, and that `PLAYARR_UPDATER=1` makes the stub see `--no-deps ... playarr`.

Commit: `update.sh: health URL, PLAYARR_DIR in .env, update folder, updater mode`

---

### Task 2: The updater

**Files:** create `docker/updater.sh`, `docker/updater.Dockerfile`; modify `docker/compose.yaml`, `docker/deploy.mjs`

`docker/updater.Dockerfile`:

```dockerfile
# The updater: the only container with the Docker socket. It rebuilds Playarr from GitHub when
# Settings → Updates asks for it (docker/updater.sh). No ports, no input but files in ./update.
FROM docker:28-cli
RUN apk add --no-cache curl jq tar && (docker compose version >/dev/null 2>&1 || apk add --no-cache docker-cli-compose)
COPY docker/updater.sh /usr/local/bin/playarr-updater
CMD ["sh", "/usr/local/bin/playarr-updater"]
```

`docker/updater.sh` (POSIX sh, `set -u`, never exits on a failed update):

```sh
#!/bin/sh
# Playarr's updater loop (runs in the updater container; see docker/updater.Dockerfile).
# Every 30 s: heartbeat; if Settings → Updates turned automatic updates on and the interval has passed,
# or someone pressed Check now (update/request), run update.sh and record the result.
set -u
DIR="${PLAYARR_DIR:?PLAYARR_DIR is not set}"
UPD="$DIR/update"
export PLAYARR_UPDATER=1 PLAYARR_HEALTH_URL="${PLAYARR_HEALTH_URL:-http://playarr:4000/api/health}"
mkdir -p "$UPD"

STATE=idle; LAST_CHECK=0; LAST_UPDATE=0; LAST_ERROR=""
now() { date +%s; }

write_status() {
  jq -n \
    --arg state "$STATE" --arg error "$LAST_ERROR" \
    --arg deployed "$(cat "$DIR/DEPLOYED" 2>/dev/null || true)" \
    --arg latest "$(cat "$DIR/LATEST" 2>/dev/null || true)" \
    --argjson heartbeat "$(now)" --argjson lastCheck "$LAST_CHECK" --argjson lastUpdate "$LAST_UPDATE" \
    '{state:$state, heartbeat:$heartbeat, lastCheck:$lastCheck, lastUpdate:$lastUpdate,
      deployed:$deployed, latest:$latest, error:($error | select(. != ""))}' > "$UPD/status.json.new" &&
    mv "$UPD/status.json.new" "$UPD/status.json"
}

setting() { jq -r "$1" "$UPD/settings.json" 2>/dev/null || true; }

while :; do
  write_status
  ENABLED="$(setting '.enabled // false')"
  INTERVAL="$(setting '.intervalMinutes // 60')"
  case "$INTERVAL" in 15 | 60 | 360 | 1440) ;; *) INTERVAL=60 ;; esac
  DUE=0
  [ -e "$UPD/request" ] && DUE=1
  [ "$ENABLED" = true ] && [ $(( $(now) - LAST_CHECK )) -ge $(( INTERVAL * 60 )) ] && DUE=1
  if [ "$DUE" = 1 ]; then
    rm -f "$UPD/request"
    BEFORE="$(cat "$DIR/DEPLOYED" 2>/dev/null || true)"
    STATE=checking; LAST_ERROR=""; write_status
    if sh "$DIR/update.sh" --quiet > "$UPD/last.log" 2>&1; then
      STATE=idle
    else
      STATE=failed
      LAST_ERROR="$(grep '✗' "$UPD/last.log" | tail -1 | sed 's/^✗ //')"
      [ -n "$LAST_ERROR" ] || LAST_ERROR="Update failed; see the log"
    fi
    LAST_CHECK="$(now)"
    AFTER="$(cat "$DIR/DEPLOYED" 2>/dev/null || true)"
    [ "$AFTER" != "$BEFORE" ] && [ "$STATE" = idle ] && LAST_UPDATE="$LAST_CHECK"
    write_status
    # Last: refresh this container if its image changed (compose replaces it; the status is written).
    if [ "$AFTER" != "$BEFORE" ] && [ "$STATE" = idle ]; then
      (cd "$DIR" && docker compose up -d --build --no-deps updater) >> "$UPD/last.log" 2>&1 || true
    fi
  fi
  sleep 30
done
```

Note: `LAST_CHECK` starts at 0, so with automatic updates on, the first check happens right after the updater starts. Keep `last.log` to the last run only (it's overwritten).

`docker/compose.yaml`: in `playarr`, add `UPDATE_DIR: /update` to `environment` and `- ./update:/update # Settings → Updates talks to the updater through this folder` to `volumes`. Add the service:

```yaml
  # Settings → Updates: rebuilds Playarr from GitHub main when asked (docker/updater.sh).
  # The only container with the Docker socket; it has no ports.
  updater:
    build:
      context: ./src
      dockerfile: docker/updater.Dockerfile
    image: playarr-updater:latest
    container_name: playarr-updater
    init: true
    environment:
      PLAYARR_DIR: ${PLAYARR_DIR:-/volume1/docker/playarr}
      PLAYARR_REPO: ${PLAYARR_REPO:-nicolabortignon/playarr}
      TZ: ${TZ:-Europe/London}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      # The deploy folder at the same path as on the host, so compose's relative paths stay right.
      - .:${PLAYARR_DIR:-/volume1/docker/playarr}
    restart: unless-stopped
```

`deploy.mjs`: add `PLAYARR_DIR=${DIR}` to the `.env` lines it writes.

Test `updater.sh` with a stub `docker`, a temp folder as `PLAYARR_DIR` holding a stub `update.sh` (one that succeeds and writes a DEPLOYED, one that fails with a `✗` line), and a short loop (add `UPDATER_SLEEP` env, default 30, and `UPDATER_ONCE=1` to run a single iteration, for testing). Check: heartbeat-only when off; `request` triggers a run and is removed; schedule triggers when on; failure records `state: failed` and the error; a changed DEPLOYED sets `lastUpdate` and calls `docker compose up -d --build --no-deps updater`. `sh -n` both scripts.

Commit: `Updater container: rebuilds Playarr from GitHub when Settings asks`

---

### Task 3: Server: the update bridge

**Files:** `packages/shared/src/index.ts`, `apps/server/src/config.ts`, create `apps/server/src/update/bridge.ts` (+ `bridge.test.ts`), `apps/server/src/routes/settings.ts` (+ test), `apps/server/src/index.ts`

Shared:

```ts
export type UpdateInterval = 15 | 60 | 360 | 1440;

export interface UpdateSettings {
  enabled: boolean;
  intervalMinutes: UpdateInterval;
}

export interface UpdateInfo extends UpdateSettings {
  /** Updates can be managed here (Docker setup with the updater running). */
  available: boolean;
  /** Why not, when not. */
  reason?: string;
  status?: {
    state: 'idle' | 'checking' | 'failed';
    /** Unix seconds. 0: never. */
    lastCheck: number;
    lastUpdate: number;
    /** Commit running (full SHA), and the newest on GitHub main, when known. */
    deployed?: string;
    latest?: string;
    error?: string;
  };
  /** A Check now is waiting for the updater. */
  requested: boolean;
  /** The last run's output (update.sh), last 60 lines. */
  log?: string;
}
```

`config.ts`: `UPDATE_DIR: z.string().optional()` (the Docker image's compose sets `/update`).

`UpdateBridge(dir: string | undefined, now = () => Date.now())`:
- `info(): Promise<UpdateInfo>`: reads `settings.json` (defaults `{ enabled: false, intervalMinutes: 60 }`), `status.json`, `request`, `last.log` (tail 60 lines). `available` is false with a `reason` when: no dir (`Automatic updates need the Docker setup (docker/compose.yaml)`); dir not writable (`Playarr can't write to its update folder`); no status or heartbeat older than 180 s (`The updater isn't running. Run update.sh on the server once to start it.`). Settings and status are still returned when present.
- `save(patch: Partial<UpdateSettings>)`: validate, merge, write `settings.json` atomically (`.new` + rename). Throws when no dir.
- `requestCheck()`: writes `request` (an ISO timestamp). Throws when no dir.
- Never reads anything else from the folder; parse errors count as missing.

Tests with a temp dir and a fixed `now`: defaults; no dir; stale/fresh heartbeat; save merges and rejects a bad interval; requestCheck creates the file and `requested` turns true; log tail; a corrupt status.json is treated as missing.

Routes (all local-network only, like the other settings routes): `GET /api/settings/updates` → `info()`; `PUT /api/settings/updates` (zod: `enabled?: boolean`, `intervalMinutes?: 15|60|360|1440`) → `save` then `info()`; `POST /api/settings/updates/check` → `requestCheck` then `info()`; errors from a missing dir → 409 with the reason. Tests: away → 403; bad interval → 400; happy paths with a temp dir.

Wire in `index.ts`: `new UpdateBridge(config.UPDATE_DIR)` → routes.

Commit: `Server: Settings → Updates talks to the updater through files`

---

### Task 4: Web: the Updates tab

**Files:** `apps/web/src/lib/api.ts`, `apps/web/src/lib/queries.ts`, create `apps/web/src/components/UpdatesPanel.tsx`, `apps/web/src/pages/Settings.tsx`

- Queries: `useUpdates()` (refetch every 5 s while `status.state === 'checking'` or `requested`, else every 60 s), `useSaveUpdates()`, `useCheckForUpdates()`.
- A fifth tab, **Updates**, after Appearance, with the "These settings apply to everyone." line.
- Panel (reuse `components/SettingsControls.tsx`):
  1. *Version*: this build's `v{__APP_VERSION__}` and commit; "Latest on GitHub: abc1234" when known, and either "Up to date" or "A newer version is available".
  2. When `!available`: the reason as a sentence, and (for the "not running" case) the command `sudo sh update.sh` in a code block. Nothing else.
  3. *Automatic updates*: a switch, "Update Playarr from GitHub automatically"; under it a pill group "Check every 15 minutes / hour / 6 hours / day" (disabled while off).
  4. *Check now* button (secondary): disabled while a check is requested or running; shows "Checking…" then the result.
  5. *Last check*: relative time, outcome ("Updated to abc1234", "Already up to date", or the error in red), and a disclosure "Show log" with the log in a monospace block.
  - One sentence of explanation at the top: "Playarr downloads the latest version from GitHub, rebuilds itself and restarts. The music keeps playing from your device's cache, and a failed update leaves the running version alone."
- After an update the page itself is served by the new build: when `status.deployed` changes from what was loaded, show a toast "Playarr was updated. Reload to use the new version." with a Reload action (once).

Commit: `Web: Settings → Updates`

---

### Task 5: Docs

**Files:** `README.md`, `PLAN.md`

- README, in "Keeping a server up to date from GitHub": automatic updates are turned on in Settings → Updates; the `updater` service does the work and is the only container with the Docker socket; run `sudo sh update.sh` once after upgrading to this version to start it; remove any cron job set up for `update.sh`; only `main` of the configured repository can be deployed.
- PLAN.md decisions log row summarising the Decisions above.

Commit: `Docs: automatic updates from Settings`

---

## Not verified by this plan

- The updater image and compose on the NAS (socket permissions, `docker:28-cli` having the compose plugin, the same-path mount, self-recreation).
- A real update cycle end to end.
