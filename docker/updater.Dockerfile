# The updater: the only container with the Docker socket. It rebuilds Playarr from GitHub when
# Settings → Updates asks for it (docker/updater.sh). No ports, no input but files in ./update.
FROM docker:28-cli
RUN apk add --no-cache curl jq tar && (docker compose version >/dev/null 2>&1 || apk add --no-cache docker-cli-compose)
COPY docker/updater.sh /usr/local/bin/playarr-updater
CMD ["sh", "/usr/local/bin/playarr-updater"]
