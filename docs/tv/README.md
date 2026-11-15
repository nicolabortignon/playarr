# Playarr on the TV

The Android TV app (plan 9, [plans/2026-11-15-9-tv-client.md](../plans/2026-11-15-9-tv-client.md)): Kotlin, Jetpack
Compose for TV and Media3, in `apps/tv`. It's a Gradle project outside the pnpm workspace, as `apps/ios` is an Xcode
one. Package id `me.tracklistme.playarr.tv`; the version code is the commit count, as the iOS build number.

## Tools

Nothing comes from Homebrew. `pnpm tv:bootstrap` (`make -C apps/tv bootstrap`) downloads into `apps/tv/.tools/`:

- Temurin JDK 21, checked against its SHA-256;
- Android's command-line tools, checked against their SHA-1, then through `sdkmanager` the platform tools (adb),
  the Android 37 platform and build tools 37.

Gradle comes through the checked-in wrapper (9.9.1, its distribution pinned by SHA-256). Behind an HTTP proxy
(`HTTPS_PROXY` set), the Makefile hands it to Java and `sdkmanager`, which don't read the variable themselves.

| | |
|---|---|
| `pnpm tv:build` | a debug APK |
| `pnpm tv:test` | unit tests and Android Lint |
| `pnpm tv:install` | build, install and start it on the TV over adb (`TV_ADDRESS`, the owner's TV by default) |
| `pnpm tv:logs`, `tv:meminfo` | the app's log, and its memory (`dumpsys meminfo`) |
| `pnpm tv:device-info` | the TV's Android version, RAM, heap limit and low-RAM flag |
| `pnpm tv:screens` | a screenshot of the TV, in `screenshots/tv/` |

## The TV and adb

On the TV, once: Settings → Android settings → Device preferences → About → Build, seven times; then Developer options
→ USB debugging (and network debugging where the firmware lists it). The first `pnpm tv:install` makes the TV ask
whether to trust this Mac: tick "Always allow".

## Modules

`api` (models generated from `packages/shared`, the client, servers and tokens) and `app` (the screens); `player`
(Media3, the queue, levels, transitions, play reports) comes with plan 9's step 4. `app` depends on `player`, and both on
`api`.

## Talking to the server (plan 9 §2)

The `api` module is the iOS app's PlayarrAPI in Kotlin, for what the TV calls (admin settings stay on the phone and
the web):

- **Models** are generated from `packages/shared` and `packages/mix` by `apps/tv/scripts/gen-models.mjs`
  (`make -C apps/tv models`; `models-check` in CI), from the same JSON Schema as the Swift ones
  (`scripts/api-schema.mjs`), into `Models.generated.kt`: `@Serializable` data classes; a string union is a value
  class over the string with its known values as constants, so a value added on the server still decodes; a tagged
  union is a sealed interface with `Unknown` for a tag this version doesn't know. A property that's optional and
  nullable reads either way but is left out when null (Kotlin can't tell the two apart; the TV sends no patch that
  needs a null).
- **`ApiJson`** reads leniently (unknown keys skipped, a missing nullable property null) and writes optional properties
  only when set, a required nullable one as null.
- **`ApiClient`** (OkHttp): `X-Playarr: 1` and `Authorization: Bearer` on every request, `ApiError` for 401 (the
  session's over), the server's `{ error }` with a 503's `Retry-After`, offline, and answers it can't read. With a
  `HomeAddress` it falls back to the server's home address once that's proven, as iOS does.
- **`HomeAddress`**: the home-address proof (`GET /api/auth/proof`), checked against the server's worked example.
- **`ServerAddress`**: plain HTTP only for home addresses. **`MediaUrls`**: streams (`levelled.aac` at a gain by
  default), transitions and art, the token only in a header and only for this server.
- **Contract tests** (`make -C apps/tv contracts`) decode every answer the server's route tests record, the same files
  as the iOS app's (`apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/Fixtures`). `.github/workflows/contracts.yml`
  records them afresh and runs both apps' tests.
