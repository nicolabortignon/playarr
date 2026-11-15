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

No cable is needed: adb, which installs the app, works over the network.

1. On the TV: Settings → Android settings → Device preferences → About → **Build**, seven times, for Developer options.
2. Developer options → **USB debugging** on (on Android TV it also opens adb on the network, port 5555), and **Wireless
   debugging** or **Network debugging** where the firmware lists one.
3. With *Wireless debugging* (Android 11 and later), pair once: "Pair device with pairing code" on the TV, then
   `apps/tv/.tools/android-sdk/platform-tools/adb pair <TV address>:<port shown> <code shown>` on the Mac.
4. `pnpm tv:install` (from the repo, in a terminal: Claude's shell can't reach the home network). The TV asks to allow
   debugging from this computer once: "Always allow".

Without adb at all, the free **Downloader** app (AFTVnews) on the TV fetches an APK from an address and installs it
once "install unknown apps" is allowed for it; plan 9 §7 makes GitHub releases that address, and the app then updates
itself. Later, Google Play's internal testing track installs it like any app.

## The emulator and a demo server

For work without the TV: `make -C apps/tv emulator` boots an Android TV emulator (Android 16, 2 GB, no window) and
`make -C apps/tv demo` starts a local Playarr with a made-up library (twelve invented albums of three seconds of silence
each, with covers drawn for them: no music needed), claimed by an owner account. Its streams are made by a pinned
static ffmpeg it fetches into `apps/tv/.tools/ffmpeg` the first time. Then:

- `TV=emulator-5554 make -C apps/tv install`; on the TV, type the address `10.0.2.2:4620` (the emulator's name for the
  Mac);
- `node apps/tv/scripts/demo-server.mjs approve <code>` approves the code the TV shows, as a phone would;
- `TV=emulator-5554 make -C apps/tv screens` saves what it shows to `screenshots/tv/`.

## Modules

`api` (models generated from `packages/shared`, the client, servers and tokens), `player` (Media3: the queue as media
items, levels, play reports) and `app` (the screens and the playback service). `app` depends on `player`, and both on
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

## Playing (plan 9 §4)

- **The stream**: every song plays as the server's encoded stream, AAC at 256 kbps in fragmented MP4
  (`levelled.aac?kbps=256&gain=…`), so the TV never decodes FLAC or ALAC and the server does the levelling. The gain is
  rounded to 0.1 dB so the same song at the same level is the same URL, which the server's cache serves again.
- **Gapless needs nothing of ours**: the server writes its priming (2112 samples) and padding in `iTunSMPB`, and
  Media3's fragmented-MP4 reader trims AAC by them. `GaplessTests` checks it on a real stream (`stream1.mp4`, three
  seconds of silence from `make demo`). It needs Robolectric because Media3's extractors read `Build` fields.
- **Levels** (`JoinRules`, as on iOS and the web): an album played in order plays at the album's level, anything else
  at the song's. `POST /api/levels` is asked for the queue's songs, 50 at a time; a song it doesn't know plays as it is.
- **`PlaybackService`** is a Media3 `MediaSessionService`: it plays on after Home and with the screen off, with a
  foreground notification, and the remote's media keys and the system's Now Playing card talk to its session. It's
  exported for them (Lint's `ExportedService` is ignored there on purpose). `PlayerConnection` is the screens'
  `MediaController` to it.
- **The player** (`PlayerFactory`): ExoPlayer over the app's OkHttp (the token only on this server's media requests),
  pausing for other apps' audio and when headphones go, a network wake lock, and a 503's `Retry-After` honored up to 10
  times while the server encodes.
- **DJ mix** (Settings → Playback → Transitions; `DjMixer`, `TransitionAsker`, `Joins`, `CuttableMediaSource`): while
  a song plays, the transition into the next is asked for by the iOS app's rules. Once it's ready in time, the song is
  cut at an AAC frame boundary inside the transition's 3 s lead, without restarting it, and the transition plays as
  AAC from the sample the song stops on (`/transitions/:file/aac?start=`). The next song then goes on from the sample
  after the transition (`levelled.aac?start=`). One decoder plays all three, so both joins are exact
  (`make join-test` checks it on the emulator or the TV, sample by sample). The song's declared padding is still
  trimmed off the cut end, so the song stops that many samples before the boundary, and the transition starts there.
  Only whole songs as encoded streams, in order, are joined; Original plays as High with DJ mix. Skipping into a
  joined part plays the next song whole. No crossfade on the TV yet.
- **History** (`PlayTracker`, as iOS's): each song is reported when it stops being the current one, with the seconds
  actually heard (a seek doesn't count) and the local hour and weekday (0 = Sunday). 30 s heard, or half a shorter song,
  is a play; changed after 3 s, a skip; closing the app is neither. Reports the server didn't get go again with the next.
