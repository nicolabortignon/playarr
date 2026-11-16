#!/bin/sh
# Playarr's updater loop (runs in the updater container; see docker/updater.Dockerfile).
# Every 30 s: heartbeat; if Settings → Updates turned automatic updates on and the interval has passed,
# or someone pressed Check now (update/request), run update.sh on the chosen channel and record the result.
#
# ./update is shared with Playarr's container, so nothing in it is trusted: settings.json is only read
# with jq (and only `enabled`, an interval from a fixed list and a channel that is exactly "stable" or
# "edge" are used), request is only checked for, and status.json and last.log are written next to it
# first and renamed in (a rename replaces whatever is there, a symlink included, instead of writing
# through it). Nothing from ./update is ever run.
set -u
DIR="${PLAYARR_DIR:?PLAYARR_DIR is not set}"
UPD="$DIR/update"
SLEEP="${UPDATER_SLEEP:-30}"
export PLAYARR_UPDATER=1 PLAYARR_HEALTH_URL="${PLAYARR_HEALTH_URL:-http://playarr:4000/api/health}"
# Work files, in the deploy folder (not writable by Playarr), renamed into ./update when complete.
STATUS_NEW="$DIR/.updater-status.json"
LOG_NEW="$DIR/.updater-last.log"

if [ ! -d "$UPD" ]; then
  mkdir -p "$UPD" && chmod 0775 "$UPD"
  # Owned like the deploy folder, so Playarr (running as that user) can write its settings.
  chown "$(stat -c '%u:%g' "$DIR" 2>/dev/null)" "$UPD" 2>/dev/null || true
fi

now() { date +%s; }
number() { case "$1" in '' | *[!0-9]*) echo 0 ;; *) echo "$1" ;; esac; }

# The last result survives a restart of this container (it's recreated after updating itself).
STATE=idle
LAST_ERROR=""
LAST_CHECK="$(number "$(jq -r '.lastCheck // 0' "$UPD/status.json" 2>/dev/null)")"
LAST_UPDATE="$(number "$(jq -r '.lastUpdate // 0' "$UPD/status.json" 2>/dev/null)")"
if [ "$(jq -r '.state // ""' "$UPD/status.json" 2>/dev/null)" = failed ]; then
  STATE=failed
  LAST_ERROR="$(jq -r '.error // ""' "$UPD/status.json" 2>/dev/null)"
fi
# What the last check found when it didn't install the newest version, and the channel it followed.
OUTCOME="$(jq -r '.outcome // ""' "$UPD/status.json" 2>/dev/null)"
case "$OUTCOME" in waiting | checksFailed | noRelease | rolledBack) ;; *) OUTCOME="" ;; esac
LAST_CHANNEL="$(jq -r '.channel // ""' "$UPD/status.json" 2>/dev/null)"
case "$LAST_CHANNEL" in stable | edge) ;; *) LAST_CHANNEL="" ;; esac

# deployedAt: when update.sh last wrote DEPLOYED, so when the running version was installed (by hand too); latestAt:
# when the newest version came out, as GitHub wrote it (update.sh's LATEST_AT; Playarr reads the date).
write_status() {
  jq -n \
    --arg state "$STATE" --arg error "$LAST_ERROR" --arg outcome "$OUTCOME" --arg channel "$LAST_CHANNEL" \
    --arg deployed "$(cat "$DIR/DEPLOYED" 2>/dev/null || true)" \
    --arg latest "$(cat "$DIR/LATEST" 2>/dev/null || true)" \
    --arg release "$(cat "$DIR/RELEASE" 2>/dev/null || true)" \
    --arg latestAt "$(head -n 1 "$DIR/LATEST_AT" 2>/dev/null | cut -c 1-40 || true)" \
    --argjson deployedAt "$(number "$(date -r "$DIR/DEPLOYED" +%s 2>/dev/null || true)")" \
    --argjson heartbeat "$(now)" --argjson lastCheck "$LAST_CHECK" --argjson lastUpdate "$LAST_UPDATE" \
    '{state: $state, heartbeat: $heartbeat, lastCheck: $lastCheck, lastUpdate: $lastUpdate,
      deployed: $deployed, latest: $latest}
      + (if $deployedAt == 0 then {} else {deployedAt: $deployedAt} end)
      + (if $latestAt == "" then {} else {latestAt: $latestAt} end)
      + (if $error == "" then {} else {error: $error} end)
      + (if $outcome == "" then {} else {outcome: $outcome} end)
      + (if $channel == "" then {} else {channel: $channel} end)
      + (if $release == "" then {} else {release: $release} end)' \
    > "$STATUS_NEW" && mv -f "$STATUS_NEW" "$UPD/status.json"
}

# A value from Settings → Updates (empty when missing, damaged or not a regular file).
setting() {
  [ -f "$UPD/settings.json" ] && [ ! -L "$UPD/settings.json" ] || return 0
  jq -r "$1" "$UPD/settings.json" 2>/dev/null || true
}

# The channel to update from: "stable" or "edge", nothing else. No settings saved yet is a new install, on stable;
# settings saved before there were channels follow main, as they did. Empty for anything else (a value this updater
# doesn't know, or settings it can't read), and then nothing is installed.
channel() {
  if [ ! -f "$UPD/settings.json" ] || [ -L "$UPD/settings.json" ]; then
    echo stable
    return 0
  fi
  jq -r 'if type != "object" then ""
    elif (has("channel") | not) then "edge"
    elif .channel == "stable" or .channel == "edge" then .channel
    else "" end' "$UPD/settings.json" 2>/dev/null || true
}

while :; do
  write_status
  ENABLED="$(setting '.enabled == true')"
  INTERVAL="$(setting '.intervalMinutes // 60')"
  case "$INTERVAL" in 15 | 60 | 360 | 1440) ;; *) INTERVAL=60 ;; esac
  DUE=0
  [ -e "$UPD/request" ] && DUE=1
  [ "$ENABLED" = true ] && [ $(($(now) - LAST_CHECK)) -ge $((INTERVAL * 60)) ] && DUE=1
  if [ "$DUE" = 1 ]; then
    rm -f "$UPD/request"
    CHANNEL="$(channel)"
    BEFORE="$(cat "$DIR/DEPLOYED" 2>/dev/null || true)"
    STATE=checking
    LAST_ERROR=""
    OUTCOME=""
    write_status
    if [ -z "$CHANNEL" ]; then
      printf '%s\n' "✗ Settings → Updates has a channel this updater doesn't know: choose Stable or Edge again" > "$LOG_NEW"
      CODE=2
    else
      LAST_CHANNEL="$CHANNEL"
      # Only PLAYARR_REPO's releases or its main: update.sh gets a channel, never a ref (GitHub serves a fork's
      # commits through the parent repository's API). Heartbeats go on while it builds.
      sh "$DIR/update.sh" --quiet --channel "$CHANNEL" > "$LOG_NEW" 2>&1 &
      PID=$!
      while kill -0 "$PID" 2>/dev/null; do
        sleep 3
        write_status
      done
      wait "$PID"
      CODE=$?
    fi
    # update.sh's exit status (see its header): waiting for checks and no release yet aren't failures.
    case "$CODE" in
      0) STATE=idle ;;
      3) STATE=idle OUTCOME=waiting ;;
      4) STATE=failed OUTCOME=checksFailed ;;
      5) STATE=idle OUTCOME=noRelease ;;
      6) STATE=failed OUTCOME=rolledBack ;;
      *) STATE=failed ;;
    esac
    if [ "$STATE" = failed ]; then
      LAST_ERROR="$(grep '✗' "$LOG_NEW" | tail -n 1 | sed 's/^✗ //')"
      [ -n "$LAST_ERROR" ] || LAST_ERROR="Update failed; see the log"
    fi
    LAST_CHECK="$(now)"
    AFTER="$(cat "$DIR/DEPLOYED" 2>/dev/null || true)"
    [ "$AFTER" != "$BEFORE" ] && [ "$STATE" = idle ] && LAST_UPDATE="$LAST_CHECK"
    write_status
    # Last: refresh this container, in case the new commit changed it. Not from here (compose stops
    # the old container before starting the new one, which would stop this very command halfway):
    # a one-off container from the same image does it and removes itself.
    if [ "$AFTER" != "$BEFORE" ] && [ "$STATE" = idle ]; then
      docker run -d --rm --name playarr-updater-refresh \
        -v /var/run/docker.sock:/var/run/docker.sock -v "$DIR:$DIR" -w "$DIR" \
        playarr-updater:latest docker compose up -d --build --no-deps updater >> "$LOG_NEW" 2>&1 || true
    fi
    mv -f "$LOG_NEW" "$UPD/last.log"
  fi
  [ "${UPDATER_ONCE:-0}" = 1 ] && exit 0
  sleep "$SLEEP"
done
