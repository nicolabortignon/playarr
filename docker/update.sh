#!/bin/sh
# Update Playarr on this machine to the newest version on its channel, build it and restart it, and go back to the
# version that was running if the new one doesn't start. Lives next to compose.yaml (e.g. /volume1/docker/playarr)
# and runs there:
#
#   sudo sh update.sh                   the channel chosen in Settings → Updates (does nothing if already there)
#   sudo sh update.sh --channel stable  the newest release on GitHub; --channel edge: the newest commit on main
#   sudo sh update.sh --force           rebuild and restart even if up to date, or try again a version that didn't start
#   sudo sh update.sh --ref X           deploy branch, tag or commit X instead
#   sudo sh update.sh --quiet           print only when something changes or fails
#
# A version is installed only once its commit has passed GitHub's checks (the "Server and web" check run, from
# .github/workflows/server-web.yml); until then the running one stays. The running image is kept as playarr:previous,
# and when the new version doesn't answer /api/health with its database working within five minutes (PLAYARR_HEALTH_WAIT),
# that image comes back with its compose.yaml and source, and so does the database if the new version migrated it (the
# copy it made first, in config/backups). See docs/server/updates-and-deploy.md.
#
# Settings → Updates runs it on a schedule through the updater container (docker/updater.sh), which passes --channel,
# sets PLAYARR_UPDATER=1 (rebuild only the playarr service) and PLAYARR_HEALTH_URL, and reads the exit status:
#   0 up to date or updated; 3 the newest version is waiting for its checks; 4 its checks failed; 5 stable has no
#   release yet; 6 it didn't start and the version that was running is back (or that happened before: it isn't tried
#   again until a newer one, or --force); anything else failed. Lines starting with ✗ say what went wrong.
#
# First time on a machine that already runs Playarr:
#   cd /volume1/docker/playarr && sudo wget -qO update.sh https://raw.githubusercontent.com/nicolabortignon/playarr/main/docker/update.sh && sudo sh update.sh
#
# Keeps ./config (favorites, playlists, analysis), ./cache, ./caddy (HTTPS certificates) and .env. compose.yaml is
# replaced by the deployed commit's copy: put your own mounts in compose.override.yaml, which is never touched, and
# settings compose.yaml passes through (PUBLIC_URL, TRUST_PROXY, SERVER_NAME, COMPOSE_PROFILES, PLAYARR_DOMAIN, …)
# in .env.
set -eu

REPO="${PLAYARR_REPO:-nicolabortignon/playarr}"
# Inside the updater container 127.0.0.1 is the updater itself: it passes http://playarr:4000/api/health.
HEALTH_URL="${PLAYARR_HEALTH_URL:-http://127.0.0.1:4000/api/health}"
# How long a new version has to come up, in seconds: longer for migrations that take longer (for the updater, set it
# in compose.override.yaml).
HEALTH_WAIT="${PLAYARR_HEALTH_WAIT:-300}"
case "$HEALTH_WAIT" in "" | *[!0-9]*) HEALTH_WAIT=300 ;; esac
# The check run a commit must have passed, by name: the job in .github/workflows/server-web.yml.
CHECK="Server and web"
REF=""
CHANNEL=""
FORCE=0
QUIET=0
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1 ;;
    --quiet) QUIET=1 ;;
    --ref) shift; REF="${1:?--ref needs a value}" ;;
    --channel) shift; CHANNEL="${1:?--channel needs a value}" ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
# A channel is one of these two, never a repository, branch or commit (see the updater's notes on forks).
case "$CHANNEL" in
  "" | stable | edge) ;;
  *) printf '✗ Not a channel: %s (stable or edge)\n' "$CHANNEL" >&2; exit 2 ;;
esac
if [ -n "$REF" ] && [ -n "$CHANNEL" ]; then echo "--ref and --channel don't go together" >&2; exit 2; fi

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
NL='
'

say() { [ "$QUIET" = 1 ] || printf '%s\n' "$*"; }
step() { printf '\n▸ %s\n' "$*"; }
fail() { printf '✗ %s\n' "$*" >&2; exit 1; }
short() { printf '%s' "$1" | cut -c1-7; }

# One update at a time (a scheduled run and a manual one, say).
LOCK="$DIR/.update.lock"
mkdir "$LOCK" 2>/dev/null || fail "Another update is running (remove $LOCK if it isn't)"
trap 'rm -rf "$LOCK" "$DIR/src.new" "$DIR/src.tar.gz" "$DIR/.env.new"' EXIT
# GitHub's answers go in the lock folder, and go with it.
WORK="$LOCK"

# Run as root, keep the files owned by whoever owns this folder (so a later non-root deploy can replace them).
OWNER=""
if [ "$(id -u)" -eq 0 ]; then OWNER="$(stat -c '%u:%g' "$DIR" 2>/dev/null || true)"; fi

# compose.yaml mounts this folder into the updater at the same path (PLAYARR_DIR, read from .env).
export PLAYARR_DIR="$DIR"
if ! grep -Fqx "PLAYARR_DIR=$DIR" "$DIR/.env" 2>/dev/null; then
  (
    umask 077
    { grep -v '^PLAYARR_DIR=' "$DIR/.env" 2>/dev/null || true; printf 'PLAYARR_DIR=%s\n' "$DIR"; } > "$DIR/.env.new"
  ) || fail "Couldn't write $DIR/.env"
  # Same owner as before (deploy.mjs rewrites .env without root).
  ENV_OWNER="$OWNER"
  if [ -f "$DIR/.env" ] && [ -n "$OWNER" ]; then ENV_OWNER="$(stat -c '%u:%g' "$DIR/.env" 2>/dev/null || printf '%s' "$OWNER")"; fi
  if [ -n "$ENV_OWNER" ]; then chown "$ENV_OWNER" "$DIR/.env.new" 2>/dev/null || true; fi
  mv "$DIR/.env.new" "$DIR/.env" || fail "Couldn't write $DIR/.env"
fi

# Settings → Updates and the updater share ./update: made here, owned like this folder, so Docker
# doesn't create it as root-only when compose mounts it.
mkdir -p "$DIR/update" || fail "Couldn't create $DIR/update"
chmod 0775 "$DIR/update" 2>/dev/null || true
if [ -n "$OWNER" ]; then chown "$OWNER" "$DIR/update" 2>/dev/null || true; fi

# The profiles compose uses, as it reads them: COMPOSE_PROFILES from the environment, else its last line in .env
# (quotes, spaces and a comment after the value dropped).
profiles() {
  if [ -n "${COMPOSE_PROFILES+set}" ]; then
    printf '%s' "$COMPOSE_PROFILES"
    return
  fi
  sed -n 's/^[[:space:]]*COMPOSE_PROFILES[[:space:]]*=//p' "$DIR/.env" 2>/dev/null | tail -n 1 | sed 's/[[:space:]]#.*//' | tr -d "\"' \r"
}

# fetch URL SECONDS: the body on stdout, with curl or wget; fails on HTTP errors, or after SECONDS.
fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --connect-timeout 10 -m "$2" "$1"
  else
    wget -q -T "$2" -O - "$1"
  fi
}

# get URL FILE ACCEPT: GitHub's API answer to URL into FILE; prints the HTTP status (000 when nothing answered).
get() {
  if command -v curl >/dev/null 2>&1; then
    curl -sSL --connect-timeout 10 -m 60 -H "$3" -o "$2" -w '%{http_code}' "$1" 2>/dev/null || true
  else
    # wget tells the status only among the headers it prints (-S, on stderr), and saves nothing on errors.
    wget -S -T 60 --header="$3" -O "$2" "$1" 2>"$2.headers" || true
    got="$(sed -n 's/^ *HTTP\/[0-9.]* \([0-9][0-9][0-9]\).*/\1/p' "$2.headers" | tail -n 1)"
    rm -f "$2.headers"
    printf '%s' "${got:-000}"
  fi
}

# Why a call to GitHub's API didn't work, for the messages below. Without signing in, GitHub allows 60 calls an hour
# from an address; a check makes one to three.
github_said() {
  case "$1" in
    000) printf 'no answer from GitHub' ;;
    403 | 429) printf "GitHub's limit of 60 requests an hour from this address is used up; try again later" ;;
    *) printf 'GitHub answered %s' "$1" ;;
  esac
}

# commit_of REF: the full SHA GitHub has for REF (a branch, refs/tags/X or a commit) in this repository.
commit_of() {
  got="$(get "https://api.github.com/repos/$REPO/commits/$1" "$WORK/commit" 'Accept: application/vnd.github.sha')"
  [ "$got" = 200 ] || fail "Couldn't ask GitHub for the commit of $1 in $REPO ($(github_said "$got"))"
  sha="$(cat "$WORK/commit")"
  case "$sha" in *[!0-9a-f]* | "") fail "GitHub answered something unexpected for $1" ;; esac
  [ "${#sha}" -eq 40 ] || fail "GitHub answered something unexpected for $1"
  printf '%s\n' "$sha"
}

# checks SHA: success, pending or failed, from the commit's "$CHECK" check runs on GitHub (the latest attempt of each).
# Every one must have completed with success; none yet is pending (the workflow hasn't started).
checks() {
  got="$(get "https://api.github.com/repos/$REPO/commits/$1/check-runs?check_name=$(printf '%s' "$CHECK" | sed 's/ /%20/g')" \
    "$WORK/checks" 'Accept: application/vnd.github+json')"
  [ "$got" = 200 ] || fail "Couldn't ask GitHub for the checks of $(short "$1") ($(github_said "$got"))"
  # One key a line: the JSON cut at { } and , (a string holding those makes lines that match nothing below).
  tr '{},' '\n\n\n' < "$WORK/checks" > "$WORK/checks.lines"
  statuses="$(sed -n 's/^[[:space:]]*"status":[[:space:]]*"\([a-z_]*\)"[[:space:]]*$/\1/p' "$WORK/checks.lines")"
  conclusions="$(sed -n 's/^[[:space:]]*"conclusion":[[:space:]]*"\{0,1\}\([a-z_]*\)"\{0,1\}[[:space:]]*$/\1/p' "$WORK/checks.lines")"
  runs=0
  for s in $statuses; do
    runs=$((runs + 1))
    [ "$s" = completed ] || { echo pending; return 0; }
  done
  [ "$runs" -gt 0 ] || { echo pending; return 0; }
  passed=0
  for c in $conclusions; do
    [ "$c" = success ] || { echo failed; return 0; }
    passed=$((passed + 1))
  done
  if [ "$passed" -eq "$runs" ]; then echo success; else echo failed; fi
}

# The channel chosen in Settings → Updates, when run by hand: read as the updater reads it (docker/updater.sh), and only
# ever "stable" or "edge". No settings saved yet is a new install, on stable; settings saved before there were channels
# follow main, as they did. Empty: anything else, and nothing is installed.
channel_setting() {
  file="$DIR/update/settings.json"
  if [ ! -f "$file" ] || [ -L "$file" ]; then echo stable; return 0; fi
  # Playarr writes it as one line of JSON; spaces around { } : and , are allowed, nothing cleverer.
  json="$(dd if="$file" bs=4096 count=1 2>/dev/null | tr -d '\r\n' | sed 's/[[:space:]]*\([{}:,]\)[[:space:]]*/\1/g')"
  case "$json" in
    "{"*"}") ;;
    *) return 0 ;;
  esac
  case "$json" in
    *'"channel":'*'"channel":'*) ;;
    *'"channel":"stable"'[,}]*) echo stable ;;
    *'"channel":"edge"'[,}]*) echo edge ;;
    *'"channel":'*) ;;
    *) echo edge ;;
  esac
  return 0
}

# version_of DIR: the version in DIR/package.json (scripts/bump-version.mjs keeps it on a line of its own), when it's
# one a file name can hold. It names the copies of the database that version makes before migrating.
version_of() {
  v="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$1/package.json" 2>/dev/null | head -n 1)"
  case "$v" in "" | *[!0-9A-Za-z.+-]*) v="" ;; esac
  printf '%s' "$v"
}

# copies_of VERSION: the copies of the database VERSION made before migrating it (backUp in apps/server/src/db.ts),
# one name a line.
copies_of() {
  [ -n "$1" ] || return 0
  for f in "$DIR/config/backups/playarr-$1-schema-"*.db; do
    if [ -f "$f" ]; then basename "$f"; fi
  done
  return 0
}

# healthy: Playarr answers /api/health with its database working. Not `ok`, which is false whenever Lidarr or the
# music can't be reached: an update never fails, or rolls back, because of those. A version from before the database
# field passes with any answer of its own, as all did before. The wait outlasts Lidarr's own 30 s timeout.
healthy() {
  body="$(fetch "$HEALTH_URL" 45 2>/dev/null)" || return 1
  body="$(printf '%s' "$body" | tr -d ' \t\r\n')"
  case "$body" in
    *'"database":{"ok":true'*) return 0 ;;
    *'"database":'*) return 1 ;;
    "{"*'"media":'*) return 0 ;;
  esac
  return 1
}

# up_within: healthy, and still healthy 10 s later (not a start that falls over at once), within HEALTH_WAIT.
up_within() {
  started="$(date +%s)"
  tries=0
  while [ "$tries" -lt $((HEALTH_WAIT / 3)) ] && [ $(($(date +%s) - started)) -lt "$HEALTH_WAIT" ]; do
    if healthy && sleep 10 && healthy; then return 0; fi
    tries=$((tries + 1))
    sleep 3
  done
  return 1
}

# The source and compose.yaml of the version that was running, back in place.
put_back_files() {
  if [ -f "$DIR/compose.yaml.previous" ]; then mv -f "$DIR/compose.yaml.previous" "$DIR/compose.yaml" || true; fi
  if [ -d "$DIR/src.previous" ]; then rm -rf "$DIR/src" && mv "$DIR/src.previous" "$DIR/src" || true; fi
}

# The database as the version that was running left it, when the new one migrated it (that version would refuse it
# otherwise): the copy the new version made in this run before its migrations, the earliest when it made more than one
# (migrations that failed, and a restart). Copies it made in earlier runs are left alone: the database has moved on
# since. Not running when it's called.
put_back_database() {
  copy=""
  lowest=""
  for name in $(copies_of "$NEW_VERSION"); do
    case "$NL$COPIES_BEFORE$NL" in *"$NL$name$NL"*) continue ;; esac
    n="${name##*-schema-}"
    n="${n%.db}"
    case "$n" in "" | *[!0-9]*) continue ;; esac
    if [ -z "$lowest" ] || [ "$n" -lt "$lowest" ]; then lowest="$n" copy="$name"; fi
  done
  [ -n "$copy" ] || return 0
  db="$DIR/config/playarr.db"
  # Its write-ahead log belongs to the database being replaced: removed first, so it's never applied to the copy.
  rm -f "$db-wal" "$db-shm"
  if ! mv -f "$DIR/config/backups/$copy" "$db"; then
    printf "  Couldn't put back the database from config/backups/%s\n" "$copy"
    return 0
  fi
  # The rest of what it made in this run are its own half-migrated states.
  for name in $(copies_of "$NEW_VERSION"); do
    case "$NL$COPIES_BEFORE$NL" in *"$NL$name$NL"*) continue ;; esac
    rm -f "$DIR/config/backups/$name"
  done
  printf '  Put back the database from before Playarr %s migrated it (config/backups/%s)\n' "$NEW_VERSION" "$copy"
}

# Back to the version that was running, within this run: its image, compose.yaml and source, and its database when
# the new version migrated it. The new version is remembered in ROLLED_BACK, and not tried again until a newer one
# comes (or --force).
roll_back() {
  step "Going back to $RUNNING_LABEL"
  printf "  The new version's last lines:\n"
  $DOCKER logs --tail 20 playarr 2>&1 | sed 's/^/  | /' || true
  if $DOCKER compose stop playarr >/dev/null 2>&1 || $DOCKER stop playarr >/dev/null 2>&1; then
    put_back_database
  else
    printf "  The new version couldn't be stopped, so its database stays as it is\n"
  fi
  put_back_files
  printf '%s\n' "$SHA" > "$DIR/ROLLED_BACK"
  $DOCKER tag playarr:previous playarr:latest || fail "$LABEL didn't start, and playarr:previous couldn't be put back"
  $DOCKER compose up -d --no-build --no-deps --force-recreate playarr ||
    fail "$LABEL didn't start, and starting $RUNNING_LABEL again failed. Logs: cd $DIR && sudo docker compose logs playarr"
  if up_within; then
    $DOCKER image prune -f --filter label=com.docker.compose.project=playarr >/dev/null 2>&1 || true
    printf '✗ %s\n' "$LABEL didn't start, so Playarr went back to $RUNNING_LABEL (rolled back)" >&2
    exit 6
  fi
  fail "$LABEL didn't start, and $RUNNING_LABEL didn't come back either. Logs: cd $DIR && sudo docker compose logs playarr"
}

DEPLOYED="$(cat "$DIR/DEPLOYED" 2>/dev/null || true)"
case "$DEPLOYED" in *[!0-9a-f]* | "") RUNNING_LABEL="the version that was running" ;; *) RUNNING_LABEL="$(short "$DEPLOYED")" ;; esac

if [ -z "$REF" ] && [ -z "$CHANNEL" ]; then
  CHANNEL="$(channel_setting)"
  if [ -z "$CHANNEL" ]; then
    printf "✗ %s\n" "Settings → Updates has a channel this script doesn't know: choose Stable or Edge there, or pass --channel" >&2
    exit 2
  fi
fi

# What to deploy: a ref given by hand, the newest release (stable) or the newest commit on main (edge).
TAG=""
if [ -n "$REF" ]; then
  case "$REF" in *..* | *[!A-Za-z0-9._/-]*) fail "Not a branch, tag or commit: $REF" ;; esac
  SHA="$(commit_of "$REF")"
elif [ "$CHANNEL" = stable ]; then
  # The tag comes from the repository's own releases, never from Settings.
  got="$(get "https://api.github.com/repos/$REPO/releases/latest" "$WORK/release" 'Accept: application/vnd.github+json')"
  if [ "$got" = 404 ]; then
    : > "$DIR/LATEST.new" && mv "$DIR/LATEST.new" "$DIR/LATEST"
    rm -f "$DIR/RELEASE"
    printf '%s\n' "There's no release of $REPO yet, so Playarr stays on $RUNNING_LABEL until there is one."
    exit 5
  fi
  [ "$got" = 200 ] || fail "Couldn't ask GitHub for the latest release of $REPO ($(github_said "$got"))"
  TAG="$(tr '{},' '\n\n\n' < "$WORK/release" | sed -n 's/^[[:space:]]*"tag_name":[[:space:]]*"\([^"\\]*\)"[[:space:]]*$/\1/p' | head -n 1)"
  # No "..": curl would fold it into another path of the API (git refuses it in tag names anyway).
  case "$TAG" in "" | -* | *..* | *[!A-Za-z0-9._/-]*) fail "GitHub answered something unexpected for the latest release of $REPO" ;; esac
  # refs/tags/: a tag, never read as a commit or a branch.
  SHA="$(commit_of "refs/tags/$TAG")"
else
  SHA="$(commit_of main)"
fi
SHORT="$(short "$SHA")"
if [ -n "$TAG" ]; then LABEL="$TAG ($SHORT)"; else LABEL="$SHORT"; fi

# The newest commit, and on stable its release, for Settings → Updates (written every time, also when up to date).
printf '%s\n' "$SHA" > "$DIR/LATEST.new" && mv "$DIR/LATEST.new" "$DIR/LATEST"
if [ -n "$TAG" ]; then printf '%s\n' "$TAG" > "$DIR/RELEASE.new" && mv "$DIR/RELEASE.new" "$DIR/RELEASE"; else rm -f "$DIR/RELEASE"; fi

if [ "$DEPLOYED" = "$SHA" ] && [ "$FORCE" = 0 ]; then
  say "Playarr is up to date ($LABEL)."
  exit 0
fi
if [ "$(cat "$DIR/ROLLED_BACK" 2>/dev/null || true)" = "$SHA" ] && [ "$FORCE" = 0 ]; then
  printf '✗ %s\n' "$LABEL didn't start when it was installed, so Playarr stays on $RUNNING_LABEL until a newer version (sudo sh update.sh --force tries it again)" >&2
  exit 6
fi

# The gate: only a commit whose checks passed. A rebuild of the one running (--force) installs nothing new.
if [ "$DEPLOYED" != "$SHA" ]; then
  VERDICT="$(checks "$SHA")"
  case "$VERDICT" in
    success) ;;
    pending)
      printf '%s\n' "$LABEL is waiting for its checks on GitHub, so Playarr stays on $RUNNING_LABEL until they pass."
      exit 3
      ;;
    *)
      printf '✗ %s\n' "$LABEL failed its checks on GitHub, so Playarr stays on $RUNNING_LABEL." >&2
      exit 4
      ;;
  esac
fi

# Docker usually needs root here; use sudo for it when we aren't root and can't reach Docker otherwise.
DOCKER=docker
if [ "$(id -u)" -ne 0 ] && ! docker info >/dev/null 2>&1; then DOCKER="sudo docker"; fi

step "Downloading $REPO $LABEL"
fetch "https://codeload.github.com/$REPO/tar.gz/$SHA" 900 > "$DIR/src.tar.gz" || fail "Download failed"
rm -rf "$DIR/src.new" && mkdir "$DIR/src.new"
tar -xzf "$DIR/src.tar.gz" -C "$DIR/src.new" --strip-components=1 || fail "The download isn't a valid archive"
[ -f "$DIR/src.new/docker/Dockerfile" ] && [ -f "$DIR/src.new/docker/compose.yaml" ] || fail "That commit has no docker/Dockerfile and docker/compose.yaml"
printf '%s\n' "$SHA" > "$DIR/src.new/REVISION"
NEW_VERSION="$(version_of "$DIR/src.new")"
# What's running stays until the new version is up: its source and compose.yaml here, its image as playarr:previous.
rm -rf "$DIR/src.previous" "$DIR/compose.yaml.previous"
if [ -d "$DIR/src" ]; then mv "$DIR/src" "$DIR/src.previous"; fi
mv "$DIR/src.new" "$DIR/src"
if [ -f "$DIR/compose.yaml" ]; then cp -p "$DIR/compose.yaml" "$DIR/compose.yaml.previous"; fi
cp "$DIR/src/docker/compose.yaml" "$DIR/compose.yaml"
# The deployed commit's own copy of this script, for next time (older commits don't have one). Kept even when the
# version doesn't start, so a fix to this script can't be held back by the copy it replaces.
if [ -f "$DIR/src/docker/update.sh" ]; then cp "$DIR/src/docker/update.sh" "$DIR/update.sh.new" && mv "$DIR/update.sh.new" "$DIR/update.sh"; fi
mkdir -p "$DIR/config" "$DIR/cache"
if [ -n "$OWNER" ]; then chown -R "$OWNER" "$DIR/src" "$DIR/compose.yaml" "$DIR/update.sh" 2>/dev/null || true; fi

# The running container's image (none on a first install: then there's nothing to go back to), and the copies of the
# database the new version has already made, which aren't this run's.
PREVIOUS="$($DOCKER container inspect --format '{{.Image}}' playarr 2>/dev/null || true)"
if [ -n "$PREVIOUS" ] && ! $DOCKER tag "$PREVIOUS" playarr:previous >/dev/null 2>&1; then PREVIOUS=""; fi
COPIES_BEFORE="$(copies_of "$NEW_VERSION")"

step "Building and restarting (the first build takes a few minutes)"
# No -f: compose picks up compose.yaml and, if present, compose.override.yaml. Profiles come from .env too:
# COMPOSE_PROFILES=https adds Caddy (HTTPS at your own domain).
if [ "${PLAYARR_UPDATER:-}" = 1 ]; then
  # From the updater: rebuild Playarr only, and bring Caddy up to date when its profile is on; the updater refreshes
  # itself afterwards. Caddy is named only then: compose starts a service named here whatever the profiles say.
  SERVICES=playarr
  case ",$(profiles)," in *,https,*) SERVICES="playarr playarr-caddy" ;; esac
  UP="up -d --build --no-deps --remove-orphans $SERVICES"
else
  # Also builds and starts the updater (Settings → Updates), and Caddy when its profile is on.
  UP="up -d --build --remove-orphans"
fi
# shellcheck disable=SC2086 # $UP is words
if ! $DOCKER compose $UP; then
  # A build that fails leaves the running container alone; a start that fails may not have.
  if [ -n "$PREVIOUS" ] && [ "$($DOCKER container inspect --format '{{.Image}} {{.State.Running}}' playarr 2>/dev/null || true)" = "$PREVIOUS true" ]; then
    put_back_files
    fail "Build or start failed; the previous container is still running"
  fi
  [ -n "$PREVIOUS" ] || fail "Build or start failed"
  roll_back
fi

step "Checking"
if up_within; then
  printf '%s\n' "$SHA" > "$DIR/DEPLOYED"
  rm -rf "$DIR/src.previous" "$DIR/compose.yaml.previous" "$DIR/ROLLED_BACK"
  $DOCKER image prune -f --filter label=com.docker.compose.project=playarr >/dev/null 2>&1 || true
  printf '  Playarr %s is up on port 4000\n' "$LABEL"
  exit 0
fi
[ -n "$PREVIOUS" ] || fail "Playarr didn't come up. Logs: cd $DIR && sudo docker compose logs playarr"
roll_back
