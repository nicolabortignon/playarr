# syntax=docker/dockerfile:1
# Playarr: the server and the built web app in one image. Build from the repository root:
#   docker build -f docker/Dockerfile -t playarr .

FROM node:24-alpine AS build
# A toolchain for ssh2's optional native helpers (used by MEDIA_SOURCE=ssh/sftp only).
RUN apk add --no-cache python3 make g++ && npm install -g pnpm@10.32.1
WORKDIR /src
# Dependencies first, so source edits don't reinstall them.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build \
 && pnpm --filter @playarr/server deploy --prod --legacy /out/server \
 && rm -rf /out/server/dist && cp -r apps/server/dist /out/server/dist \
 && cp -r apps/web/dist /out/web \
 && chmod -R a+rX /out
# (Readable by any user whatever the source's permissions: the NAS's ACLs leave files 770, and the
# app runs as the NAS user, not root.)

FROM node:24-alpine
# ffmpeg measures each song (tempo, energy…) for the generated playlist covers.
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY --from=build /out/server ./server
COPY --from=build /out/web ./web
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000 \
    WEB_DIST=/app/web \
    DATA_DIR=/config \
    CACHE_DIR=/cache \
    MEDIA_SOURCE=local
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -q -O /dev/null http://127.0.0.1:4000/ || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server/dist/index.js"]
