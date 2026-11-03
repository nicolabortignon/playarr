# Playarr

A modern, responsive music player for the web that uses a [Lidarr](https://lidarr.audio) library as its source. It works on desktop and on phones, where it installs as an app with lock-screen controls.

Lidarr manages a music library but can't play it: its API serves metadata, not audio. Playarr adds a small companion server that streams the files Lidarr manages, serves their artwork, and keeps favorites and playlists.

## Search and request music without going through Lidarr

Playarr is also a listener-friendly front door to Lidarr's search. Anyone using Playarr can look for music the way they think about it, by song, artist or album, and get it added without ever opening Lidarr:

- **Search for a song, not a release.** Type "bohemian rhapsody" and Playarr finds the original song, works out which album it belongs to, and offers to request that album. Lidarr itself only searches artists and albums.
- **See what you already have.** Results show which songs and albums are already in the library, so they can be played straight away.
- **Request in one tap.** Playarr adds the album to Lidarr, monitoring just that album rather than the artist's whole discography, starts the search, and shows download progress until the songs arrive in the library.
- **Discover from your playlists.** "Songs like these" under each playlist suggests similar music. Songs you own can be added to the playlist, and missing ones can be requested the same way.

This means listeners don't need a Lidarr account, the API key, or any knowledge of quality profiles and monitoring. Lidarr stays an admin tool, and Playarr is where people find and ask for music.

## How it fits together

```
┌──────────────┐               ┌─────────────────────────┐   X-Api-Key   ┌──────────┐
│  Web client  │ ────────────▶ │     Playarr server      │ ────────────▶ │  Lidarr  │
│ (React PWA)  │ ◀──────────── │  /api/*  /stream/:id    │ ◀──────────── │          │
└──────────────┘  JSON, audio  │  /art/*  (cache)        │   metadata    └──────────┘
                               │  SQLite (user data)     │
                               └───────────┬─────────────┘
                                           │ read-only
                                    ┌──────▼───────┐
                                    │ Music files  │ (the folder Lidarr manages)
                                    └──────────────┘
```

The server keeps the Lidarr API key to itself; the browser only ever talks to Playarr.

## Repository layout

A pnpm monorepo, all TypeScript, plus the native iOS app in Swift:

| Package | What it is |
|---|---|
| `apps/server` | Fastify 5 server. Keeps a snapshot of the Lidarr library, refreshed every 10 minutes. Streams audio with HTTP range support, serves resized artwork, and stores favorites, playlists and song analysis in SQLite (`node:sqlite`). In production it also serves the built web app, so everything runs as one process on one port. |
| `apps/web` | React 19 app built with Vite 8, Tailwind 4, React Router 7, TanStack Query and Zustand. Installable as a PWA, with its own service worker that can play songs saved on the device. |
| `apps/ios` | The native iPhone and iPad app in SwiftUI, being built in phases ([design](docs/plans/2026-11-03-ios-app-design.md)). Outside the pnpm workspace: XcodeGen generates the Xcode project from `project.yml`, a Makefile has every entry point, and two Node scripts talk to App Store Connect. |
| `packages/shared` | Types shared by both sides, plus the byte-range parser used by the server and the service worker. |
| `packages/mix` | DJ transitions, with no dependencies: finding beats, bars, key and mix points in a song, planning how two songs join, and rendering the mix. Used by the server and the web app alike. |
| `docker/` | Dockerfile for a single image containing the server, the web app, ffmpeg, fpcalc and rclone; the compose stack, `update.sh` and the updater container that keep a server up to date. |
| `scripts/` | The version bump run on every commit, `pnpm sim` (iOS Simulator) and the Beat This! model export. |
| `docs/` | [mixing.md](docs/mixing.md) (how DJ mix works) and the design and implementation plans. |

## Key design points

- **Pluggable audio source.** The server reads music from local disk (the normal case, next to Lidarr), or over SSH or SFTP from another machine, which is handy in development. `PATH_MAP` translates Lidarr's paths to the ones Playarr sees.
- **Folder sources.** Besides Lidarr, any folder on the server can be a source. Playarr reads its tags (falling back to "Artist/Album/01 Title" names), merges the songs with Lidarr's, and never modifies the files on its own. Untagged albums are matched on MusicBrainz automatically (and by their sound with an AcoustID key); doubtful matches wait for you in Settings. A folder no album fits as a whole, such as a "00s Hits" compilation, is matched song by song: each song joins the album it first came out on (by its artist, title and length), as just that song. Optionally, Playarr can tidy a folder into Artist/Album/NN Title: it proposes the moves, you choose which to apply, and every change can be undone. A folder can also be on another machine, over SSH or SFTP, without mounting anything. Folders can be on SMB shares too (Windows, macOS, most NAS), read through rclone: it's in the Docker image; native installs need rclone on the PATH. For NFS, mount the export on the host and add it as a folder on This server (in Docker, under the folder mounted at /host).
- **The browser never sends a file path.** `/stream/:id` only serves file IDs the catalog knows (from Lidarr or a folder source), and refuses anything outside the configured music folders.
- **Discover and requests** combine several open sources: Deezer for finding songs by popularity, Lidarr for artists and albums, MusicBrainz for discographies and IDs, and ListenBrainz for "Songs like these" recommendations.
- **Generated playlist covers.** Each playlist gets artwork drawn from how its songs actually sound. ffmpeg decodes each song once and Playarr's own DSP code measures tempo, beat strength, loudness, brightness and more. One of six layouts is drawn as SVG and served as WebP. A cover stays fixed until you pick a new one.
- **Player built for mobile.** Two `<audio>` elements take turns: the next song is loaded ahead and starts as the current one ends, with no gap, or fading in (crossfade, never within an album played in order). Even volume plays every song at −14 LUFS from the loudness Playarr measures (album by album when an album plays in order): the server streams each song at its level, turning quiet songs up as well as loud ones down, so it works on iPhones too, and DJ transitions are mixed at the same levels. When the queue ends, similar songs from the library keep playing (radio). There's a sleep timer, synced lyrics (from an `.lrc` file beside the song, its tags, or [LRCLIB](https://lrclib.net)), lock-screen controls through Media Session, and an accent color that follows the album art. Phones that fix the volume in hardware (iPhone, iPad) get gapless playback but no fades; DJ transitions still play there, each file taking over from the last in step (started muted, then unmuted as the other pauses).
- **DJ transitions.** With Settings → Playback → Transitions set to DJ mix (instead of Off or Crossfade), songs flow into each other the way a DJ would mix them. Each pair gets what suits it: a long blend on the beat, crossfading over the intro and outro, when tempo and key match (a short one when only the keys clash); a quick mix when they don't; a plain fade, as long as the fade length picked in Settings, when there's no beat to mix on; or straight on with no gap (always for an album played from its page). The silence at a song's end and the next one's start is left out, except within an album. Now Playing shows the next transition and sets mixing for the current queue: Auto, Party (longer blends, more often) or No mixing. When a transition isn't ready in time, songs still change on the beat; on a computer, pressing Next mixes into the next song on the next bar. The server mixes each transition ahead of time, so it works on a locked iPhone too, and the phone still shows two songs, never a third. On a computer, each change between files is lined up on the sound itself; phones and tablets keep to plain `<audio>` elements, which play on with the screen locked. Downloads keep their transitions for offline listening. Mixes and radio put songs that blend well next to each other. Beats and bars are found by [Beat This!](https://github.com/CPJKU/beat_this) (a small neural beat tracker, run on the server in WebAssembly), so a kick isn't mistaken for an off-beat hi-hat; the tempo is then measured to 0.01 BPM from the song's onsets. A blend needs both beats steady where the songs play together, judged phrase by phrase: a song whose beat wanders in a breakdown is still blended in its outro (later in the outro, or over fewer beats, if its first phrases drift), and only gets a quick mix when no stretch holds. Intros and outros are the phrases with a beat but not yet (or no longer) the song's main groove: a lighter kick, no bass line yet, or quieter; a song's fading or kick-less ending is left out of that, and drift where there's no kick to flam with doesn't count. Settings → Analysis says how many songs are analysed and can have them all analysed (again). When the beat or the mix points are found in the wrong place, Edit mix points in the song menu moves them. This needs `ANALYSIS=on` and ffmpeg; songs not yet analyzed play the usual way. Mixed transitions are kept to a size (`TRANSITIONS_CACHE_MB`, 1 GB by default). [docs/mixing.md](docs/mixing.md) explains the whole algorithm, from analysis to playback.
- **Analysis.** Settings → Analysis shows how far each analysis has got over the library, with buttons for the songs each has left and to reanalyse the entire collection, and one to reanalyse everything: *beat analysis* (tempo, beat grid, bars, key, intro and outro: for DJ mix, and the one tempo everything else goes by), *sound analysis* (energy and texture, for mood mixes, radio and playlist covers), *loudness analysis* (EBU R128 loudness and peak, a second or two a song, for even volume) and *tag lookup* (genres and years from ListenBrainz, for genre and decade mixes). A switch there analyses the whole library in the background, at low priority; otherwise songs are analysed as they come up to play. Songs are levelled to −14 LUFS: loud ones down, quiet ones up as far as their peak allows.
- **Made for you.** Listening history (per account, kept on the server) feeds twelve kinds of generated mixes on Home, from Discovery Weekly to Vibes of the hour, plus Jump back in and listening stats: top artists, songs and albums, when you listen, and a year in review. Plays can be sent to ListenBrainz. Each person signs in with their own account; favorites and playlists are theirs, and a playlist can be shared with everyone on the server.
- **Settings.** Accounts: who signs in (admins add accounts and hand out a one-time setup code; nobody chooses another person's password), what each may hear (every source or only some) and whether they may request albums, and the devices each is signed in on. Mixes is covered above. Sources: where the music comes from. Playback: even volume, transitions (Off, Crossfade or DJ mix) and their fade length, radio, whether this device counts towards the listening history, songs kept on this device and the keyboard shortcuts. Requests: whether people can request albums, whether Lidarr searches right away, and the root folder and profiles new artists get (chosen from Lidarr's lists; `LIDARR_ROOT_FOLDER`, `LIDARR_QUALITY_PROFILE_ID` and `LIDARR_METADATA_PROFILE_ID` in `.env` apply when nothing is chosen). Appearance: the accent color (from the album art or a fixed one), motion, the audio format badges and Stats for nerds: an overlay with everything known about the song playing (tempo, key and beat grid as it plays, intro, outro and drop, measured loudness and the gain applied, the stream and its buffer, the next transition), which can be dragged, collapsed to one line or closed. Playback and Appearance are per device, saved in the browser; Sources, Requests, Analysis and Updates apply to everyone and are changed by admins (before the owner has set a password, from the home network). Turning requests off hides every Request button and the server refuses new requests.
- **Fast and offline-friendly.** The next few songs in the queue are downloaded ahead of time and played from the device by the service worker. Albums, playlists, mixes and Favorites can be downloaded to keep for offline listening (Library → Downloads). Library data is saved in IndexedDB, so the app opens instantly, and pages prefetch on hover or tap. These features need HTTPS or localhost.

## Running it

Copy `.env.example` to `.env`. `LIDARR_URL` and `LIDARR_API_KEY` are optional: on first start they become the Lidarr source in **Settings → Sources**, where it's managed from then on. Set `MEDIA_SOURCE` (plus `PATH_MAP` if Playarr sees the music at a different path than Lidarr).

```bash
pnpm install
pnpm dev                          # server on :4000 + web on :5180
pnpm build && pnpm start          # production: one process on :4000 serving the API and the web app
pnpm -C apps/server test          # unit tests: catalog and sources, analysis, transitions, covers, routes
pnpm -C packages/mix test         # unit tests: beats, key and mix points, planning and mixing transitions
pnpm --filter @playarr/web test   # unit tests plus smoke tests against a running server
```

### On an iPhone simulator

With Xcode installed, `pnpm sim` drives Playarr in Safari on an iOS Simulator, by default the NAS deployment (`PLAYARR_URL` picks another server):

```bash
pnpm sim boot --show              # start an iPhone 17 Pro simulator and show its window
pnpm sim open /albums/123         # load a page and wait for it
pnpm sim click 'text=Shuffle'     # tap a button or link by what it says (or by CSS selector)
pnpm sim fill input 'daft punk'   # type into a field
pnpm sim eval 'document.title'    # run JavaScript in the page
pnpm sim console --errors         # the page's warnings and errors
pnpm sim shot                     # screenshot to /tmp/playarr-sim.png
```

It talks to the simulator's Web Inspector directly, so it needs no WebDriver setup. Taps are JavaScript clicks, not real touches.

### iOS app

The native app in `apps/ios` needs Xcode 26 or later; nothing else is installed system-wide.

```bash
pnpm ios:bootstrap   # download the pinned XcodeGen into apps/ios/.tools and generate Playarr.xcodeproj
pnpm ios:build       # build for the iPhone 17 Pro simulator
pnpm ios:test        # the scripts' tests, the Swift package tests, then the UI tests on the simulator
pnpm ios:beta        # test, archive, upload, and hand the build to the "Household" TestFlight group
pnpm ios:device      # optional: build and install on an iPhone cabled to this Mac (Developer Mode on)
```

The Xcode project is generated, not committed: every `make` target regenerates it, so new files are picked up. Open `apps/ios/Playarr.xcodeproj` to work in Xcode.

Signing and uploads go through an App Store Connect API key, with no Apple ID signed in. Put the key at `~/.appstoreconnect/private_keys/AuthKey_<id>.p8`, and `ASC_KEY_ID`, `ASC_ISSUER_ID`, `APPLE_TEAM_ID` and `IOS_BUNDLE_ID` in `.env`. `pnpm ios:setup` registers the bundle id and creates the TestFlight group (`TESTERS="a@example.com"` adds App Store Connect users to it); it's safe to run again. `node --env-file=.env apps/ios/scripts/asc.mjs check` tells what's set up.

Phones get the app through TestFlight, which needs no registered device: `pnpm ios:beta` archives unsigned, the export signs the app with Apple's cloud-managed distribution certificate through the key (no certificate in the keychain), and `altool` uploads it. `pnpm ios:device` is only for a phone that can be cabled to the Mac; it registers that phone with Apple. The build number is the commit count; the version is `MARKETING_VERSION` in `apps/ios/Config/Base.xcconfig`, changed only for App Store releases.

GitHub Actions (`.github/workflows/ios.yml`, on `macos-26`) runs the tests for every push and pull request that changes `apps/ios`, and uploads a TestFlight build for each such push to main, with the key in the repository's secrets (`ASC_KEY_ID`, `ASC_ISSUER_ID`, `APPLE_TEAM_ID`, `ASC_KEY_P8_BASE64`).

### Docker

Build the image from the repository root, then mount the music folder read-only at the same path Lidarr uses, so no path mapping is needed:

```bash
docker build -f docker/Dockerfile -t playarr .
docker run -d --name playarr -p 4000:4000 \
  -e LIDARR_URL=http://lidarr:8686 -e LIDARR_API_KEY=... \
  -e PATH_MAP=/data/media/music=/data/media/music \
  -v /path/to/music:/data/media/music:ro \
  -v "$HOME/Music:/host:ro" \
  -v "$PWD/config:/config" -v "$PWD/cache:/cache" \
  playarr
```

Anything under /host can then be added in Settings → Sources → Folder.

`/config` holds accounts, favorites, playlists, listening history and song analysis: keep it and back it up. `/cache` holds artwork, covers and mixed transitions and is safe to delete.

With `docker/compose.yaml`, `PUBLIC_URL`, `TRUST_PROXY` and `SERVER_NAME` (see `.env.example`) go in the `.env` next to it, like `LIDARR_URL`; left out, they stay unset. Bonjour (so the iOS app finds the server on the home network) needs host networking; with the port mapping above, add the server by its address instead.

Forgot the owner's password? On the server host, `docker exec playarr node server/dist/cli.js reset-password <username>` (natively, `node dist/cli.js reset-password <username>` in `apps/server`; in development, `pnpm -C apps/server reset-password <username>`) signs that account out everywhere and prints a one-time setup code and link, on `PUBLIC_URL` or else `http://localhost:<PORT>`, to choose a new password with.

### Keeping a server up to date from GitHub

`docker/compose.yaml` and `docker/update.sh` run Playarr as a compose service that rebuilds itself from the latest commit on GitHub. Put both in a folder on the server (for example `/volume1/docker/playarr`) with a `.env` holding `LIDARR_URL`, `LIDARR_API_KEY` and `MUSIC_DIR` (and, behind a reverse proxy, `PUBLIC_URL` and `TRUST_PROXY`), then:

```bash
sudo sh update.sh            # build and start the latest commit on main; does nothing if it's already running
sudo sh update.sh --force    # rebuild anyway
sudo sh update.sh --ref X    # deploy a branch, tag or commit
```

It downloads the source from GitHub (no git needed), builds with `docker compose up -d --build`, and waits until Playarr answers. `config`, `cache` and `.env` are kept, and a failed build leaves the running container alone. Each update replaces `compose.yaml` with the deployed commit's copy, so put your own mounts in `compose.override.yaml` next to it (start from `docker/compose.override.example.yaml`). That's where host folders for Settings → Sources → Folder → This server go: mounting `/volume2` at `/host/volume2` makes `/volume2/data` browsable as `/host/volume2/data`. Run `update.sh --force` (or `docker compose up -d`) after changing it.

Automatic updates are turned on in **Settings → Updates**, which also shows the running and latest versions, the last result and its log, and has a Check now button. The work is done by the `updater` service in `compose.yaml`: a small container that is the only one with the Docker socket (Playarr's own container only gets the `update` folder, through which it passes the settings and Check now requests). After upgrading to a version that has it, run `sudo sh update.sh` once to start the updater; after that, remove any cron job you set up for `update.sh` (it's no longer needed, and a shared lock keeps the two from overlapping anyway). Only `main` of the configured repository (`PLAYARR_REPO`, default `nicolabortignon/playarr`) can be deployed this way: Settings can choose whether and how often, never the branch, commit or repository.

From a development machine with the SSH settings in `.env`, `pnpm deploy:nas` does the same over SSH; `pnpm deploy:nas --local` ships the local last commit instead, for work that isn't pushed. It writes `LIDARR_URL`, `LIDARR_API_KEY`, `MUSIC_DIR` and `PLAYARR_DIR` into the NAS's `.env` and keeps its other lines (`PUBLIC_URL`, `TRUST_PROXY`, …).

## Status and roadmap

Playarr asks everyone to sign in once its owner has set a password (open Playarr on the home network, by its IP or local name: Settings → Accounts → Set up the owner's account). Until then it works as before, open to anyone who can reach it, so claim it before exposing it. Reach it from outside over HTTPS through a reverse proxy; the session cookie is marked Secure when the proxy says the visit is HTTPS. Planned next:

- The native iOS app (docs/plans/2026-11-03-ios-app-design.md)
- ffmpeg transcoding for formats browsers can't play, and for mobile data (even volume's levelled streams are uncompressed WAV for now)
- ReplayGain tags (levelling uses Playarr's own loudness measurement for now) and EQ

See [PLAN.md](PLAN.md) for the full architecture, roadmap and design decisions.
