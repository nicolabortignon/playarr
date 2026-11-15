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

`app` (the screens) for now; `api` (models generated from `packages/shared`, the client, Bonjour, tokens in the
Keystore) and `player` (Media3, the queue, levels, transitions, play reports) come with plan 9's steps 2 and 4.
`app` depends on `player`, and both on `api`.
