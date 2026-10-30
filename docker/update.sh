#!/bin/sh
# Update Playarr on this machine to the latest commit on GitHub, build it and restart it.
# Lives next to compose.yaml (e.g. /volume1/docker/playarr) and runs there:
#
#   sudo sh update.sh            update to the latest commit on main (does nothing if already there)
#   sudo sh update.sh --force    rebuild and restart even if already up to date
#   sudo sh update.sh --ref X    deploy branch, tag or commit X instead of main
#   sudo sh update.sh --quiet    print only when something changes or fails (for cron)
#
# First time on a machine that already runs Playarr:
#   cd /volume1/docker/playarr && sudo wget -qO update.sh https://raw.githubusercontent.com/nicolabortignon/playarr/main/docker/update.sh && sudo sh update.sh
#
# Keeps ./config (favorites, playlists, analysis), ./cache and .env. compose.yaml is replaced by the
# deployed commit's copy: put your own mounts and settings in compose.override.yaml, which is never touched.
# If the build fails, the running container is left as it was.
set -eu

REPO="${PLAYARR_REPO:-nicolabortignon/playarr}"
REF=main
FORCE=0
QUIET=0
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1 ;;
    --quiet) QUIET=1 ;;
    --ref) shift; REF="${1:?--ref needs a value}" ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

say() { [ "$QUIET" = 1 ] || printf '%s\n' "$*"; }
step() { printf '\n▸ %s\n' "$*"; }
fail() { printf '✗ %s\n' "$*" >&2; exit 1; }

# One update at a time (a scheduled run and a manual one, say).
LOCK="$DIR/.update.lock"
mkdir "$LOCK" 2>/dev/null || fail "Another update is running (remove $LOCK if it isn't)"
trap 'rm -rf "$LOCK" "$DIR/src.new" "$DIR/src.tar.gz"' EXIT

# fetch URL [header]: the body on stdout, with curl or wget.
fetch() {
  if command -v curl >/dev/null 2>&1; then
    if [ -n "${2:-}" ]; then curl -fsSL -H "$2" "$1"; else curl -fsSL "$1"; fi
  else
    if [ -n "${2:-}" ]; then wget -q -O - --header="$2" "$1"; else wget -q -O - "$1"; fi
  fi
}

case "$REF" in *[!A-Za-z0-9._/-]*) fail "Not a branch, tag or commit: $REF" ;; esac
SHA="$(fetch "https://api.github.com/repos/$REPO/commits/$REF" 'Accept: application/vnd.github.sha')" ||
  fail "Couldn't ask GitHub for the latest commit of $REPO ($REF)"
case "$SHA" in
  *[!0-9a-f]* | "") fail "GitHub answered something unexpected for $REF" ;;
esac
[ "${#SHA}" -eq 40 ] || fail "GitHub answered something unexpected for $REF"
SHORT="$(printf '%s' "$SHA" | cut -c1-7)"

DEPLOYED="$(cat "$DIR/DEPLOYED" 2>/dev/null || true)"
if [ "$DEPLOYED" = "$SHA" ] && [ "$FORCE" = 0 ]; then
  say "Playarr is up to date ($SHORT)."
  exit 0
fi

# Docker usually needs root here; use sudo for it when we aren't root and can't reach Docker otherwise.
DOCKER=docker
if [ "$(id -u)" -ne 0 ] && ! docker info >/dev/null 2>&1; then DOCKER="sudo docker"; fi

step "Downloading $REPO $SHORT"
fetch "https://codeload.github.com/$REPO/tar.gz/$SHA" > "$DIR/src.tar.gz" || fail "Download failed"
rm -rf "$DIR/src.new" && mkdir "$DIR/src.new"
tar -xzf "$DIR/src.tar.gz" -C "$DIR/src.new" --strip-components=1 || fail "The download isn't a valid archive"
[ -f "$DIR/src.new/docker/Dockerfile" ] && [ -f "$DIR/src.new/docker/compose.yaml" ] || fail "That commit has no docker/Dockerfile and docker/compose.yaml"
printf '%s\n' "$SHA" > "$DIR/src.new/REVISION"
rm -rf "$DIR/src" && mv "$DIR/src.new" "$DIR/src"
cp "$DIR/src/docker/compose.yaml" "$DIR/compose.yaml"
# The deployed commit's own copy of this script, for next time (older commits don't have one).
if [ -f "$DIR/src/docker/update.sh" ]; then cp "$DIR/src/docker/update.sh" "$DIR/update.sh.new" && mv "$DIR/update.sh.new" "$DIR/update.sh"; fi
mkdir -p "$DIR/config" "$DIR/cache"
# Run as root, keep the files owned by whoever owns this folder (so a later non-root deploy can replace them).
if [ "$(id -u)" -eq 0 ]; then
  OWNER="$(stat -c '%u:%g' "$DIR" 2>/dev/null || true)"
  [ -n "$OWNER" ] && chown -R "$OWNER" "$DIR/src" "$DIR/compose.yaml" "$DIR/update.sh" 2>/dev/null || true
fi

step "Building and restarting (the first build takes a few minutes)"
# No -f: compose picks up compose.yaml and, if present, compose.override.yaml.
$DOCKER compose up -d --build --remove-orphans || fail "Build or start failed; the previous container is still running"
$DOCKER image prune -f --filter label=com.docker.compose.project=playarr >/dev/null 2>&1 || true

step "Checking"
i=0
while [ $i -lt 40 ]; do
  HEALTH="$(fetch http://127.0.0.1:4000/api/health 2>/dev/null || true)"
  case "$HEALTH" in
    "{"*)
      printf '%s\n' "$SHA" > "$DIR/DEPLOYED"
      printf '  Playarr %s is up on port 4000\n' "$SHORT"
      exit 0
      ;;
  esac
  i=$((i + 1))
  sleep 3
done
fail "Playarr didn't come up. Logs: cd $DIR && sudo docker compose logs playarr"
