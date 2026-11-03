# Native iOS app: design

Date: 2026-11-03. Status: designed, not built. One plan per phase in this folder, each written when the phase starts.

## Goal

A native iPhone and iPad app that does what the web app does on a phone, nearly 1:1, and becomes the primary way to listen on Apple devices. It lives in this repository, talks to the same server, and ships through TestFlight first and the public App Store after.

The web app stays a full client on phones too: nothing about how it plays, caches or looks on mobile changes. The only change it sees is signing in (accounts, below).

## Decisions

| Topic | Decision |
|---|---|
| Approach | Native SwiftUI with its own audio engine (AVAudioEngine). Chosen over a web wrapper (Capacitor or WKWebView: App Review's minimum-functionality rule, and playback would still need a native engine) and over a hybrid with web views for the long tail (two UI paradigms to maintain). |
| Platforms | iPhone and iPad, iOS 26 and later. iPad gets the desktop web's layout: sidebar, content, queue and lyrics column. CarPlay and Mac later. |
| Distribution | TestFlight first (internal testers), then the public App Store. Paid Apple Developer Program membership, already held (individual or organization: to confirm under Membership details). |
| Accounts | Server accounts replace profiles. One server has many accounts; the app (and the web) can be signed in to several accounts and switch with one tap, no password. |
| Many servers | The app keeps a list of servers, each with its signed-in accounts. Downloads and caches are per server and account. |
| Per-account data | History, mixes, stats, ListenBrainz, favorites and playlists are per account. Playlists are private unless shared with the server; today's playlists become shared. |
| Library access | Each account sees all sources or a chosen list. Enforced on the server for the catalog, search, mixes, radio, streams, art and transitions. |
| Rights | Admin accounts change settings, sources, analysis, accounts. `can_request` per account, plus the server-wide "requests on" switch. Replaces the home-network rule, which survives only for first-run setup and owner password recovery. |
| Requests on iOS | Same in every build, gated by the server switch and the account's right. |
| Remote access | Each server reached over HTTPS on its own domain (reverse proxy). Plain HTTP only for local addresses. Servers on the home network are found by Bonjour. |
| App Review | A reviewer account on the owner's server that sees only a Creative Commons folder, with no requests and no admin rights. |
| Builds and releases | App Store Connect API key, no Apple ID signed in anywhere. Local `pnpm ios:*` scripts (xcodebuild + a small Node script for the API, no fastlane) plus GitHub Actions (repo is public, so macOS runners are free). |
| Project files | XcodeGen generates the Xcode project from `apps/ios/project.yml`; the `.xcodeproj` is not committed. |
| Swift models | Generated from `packages/shared` and `packages/mix/src/types.ts`; contract tests decode real server responses. |
| Third-party code in the app | None. |

## 1. Accounts and many servers (server)

**Accounts replace profiles.** A migration renames `profiles` to `accounts`, keeping ids, so plays, mixes and ListenBrainz links stay with their owner (`profile_id` becomes `account_id`). Each account has a username, display name, password hash (scrypt, `node:crypto`), role (`admin` or `member`), `can_request`, and library access (all sources, or a list in `account_sources`). Profile 1 ("Home") becomes the owner, an admin. Favorites and playlists get an `account_id`: existing favorites go to the owner; existing playlists stay visible to everyone by being marked shared with the server.

**First run.** While no account has a password, the server is in setup mode and a request from the home network may claim the owner account by setting its password. After that, admins create accounts and reset passwords in Settings → Accounts; a new or reset account gets a one-time setup link or code, so admins never choose anyone's password.

**Sessions.** Signing in creates a device session: a random 256-bit token (stored hashed), device name, platform, created and last-seen times. An account's sessions are listed in Settings → Accounts and can be signed out. The iOS app sends `Authorization: Bearer <token>` on every request, streams included. The web keeps a token per signed-in account on the device and sets the active one as an HttpOnly cookie, so `<audio>`, images and the service worker work unchanged; switching accounts swaps the cookie. Sign-in attempts are rate-limited.

**Rights.** `requireLocal` becomes `requireAdmin` (sources, settings, analysis, accounts, library refresh). Requests need `can_request` and requests on. `X-Playarr` stays as the cross-site guard for cookie sessions.

**Library access.** A song is visible to an account when it has a copy in a source the account may see. The filter applies in catalog queries, search, mixes, radio, recommendations, `/stream`, `/art`, `/transitions` and levelled streams, so a hidden file can't be fetched by id either. This touches every catalog query and gets its own tests.

**Server identity.** `GET /api/server` answers a stable server UUID, its name, version, the lowest app version it supports, and whether it's in setup mode. The server advertises `_playarr._tcp` over Bonjour with its UUID and version (works for native installs and host-network Docker; elsewhere the app takes a URL).

**Web.** A sign-in page and an account switcher where the profile chooser was ("Not X? Listen as Y" becomes switching between signed-in accounts, or adding one). Settings → Profiles becomes Settings → Accounts. Nothing else in the web app changes.

## 2. How the app is built

**Layout.** `apps/ios/`, outside the pnpm workspace:

```
apps/ios/
├── project.yml            # XcodeGen: app target, tests, UI tests, signing settings
├── Makefile               # bootstrap, build, test, beta, release (wrapped by pnpm ios:*)
├── Packages/
│   ├── PlayarrAPI/        # Codable models (generated), API client, servers and accounts (Keychain), Bonjour
│   ├── PlayarrPlayer/     # queue, audio engine, levels, transitions, plays, radio, sleep, Now Playing, downloads
│   └── PlayarrUI/         # every screen and component
├── Playarr/               # app entry, audio session, background modes, Info.plist, assets
├── PlayarrUITests/        # simulator UI tests, which also take the App Store screenshots
├── store/                 # App Store text, review notes, screenshot list
└── scripts/               # asc.mjs (App Store Connect API), model generation
```

Swift 6 with strict concurrency, `@Observable` state, no third-party dependencies. A new Mac needs Xcode and the App Store Connect key (section 5); `pnpm ios:bootstrap` downloads a pinned XcodeGen into `apps/ios/.tools/`.

**Models.** `pnpm ios:models` turns the shared TypeScript types into Swift Codable types (TypeScript → JSON Schema → Swift). The server's route tests save real responses as fixtures; Swift contract tests decode them, so a change on either side fails CI until the other follows.

**Screens.** 1:1 with the web on a phone: tabs Home, Search, Library, Queue; mini player; full-screen Now Playing (swipe down to close) with lyrics, sleep timer, the transition sheet and its menu. All 19 routes and every menu and dialog (Add to playlist, Show metadata, Edit mix points, cover picker, Stats for nerds). iPad: sidebar like the desktop web, with a queue and lyrics column. Keyboard shortcuts only with a hardware keyboard on iPad.

**Settings.** Playback and Appearance are per device (stored on the phone), as on the web; crossfade is offered on iPhone too, since the engine can fade. Your listening per account. Sources, Mixes, Analysis, Requests, Updates and Accounts are native and only shown to admins.

**Data.** A stale-while-revalidate cache on disk, keyed like the web's persisted queries (7 days), so the app opens instantly and browses offline; a disk image cache that asks for the right `?size=`. All per server and account.

**Accent colour** from album art with the web's algorithm (12 hue bins weighted by saturation and mid-lightness, clamped), or a fixed colour.

## 3. Audio engine

**Engine.** `AVAudioEngine` with two player nodes taking turns (decks) and a third for transition files, each through its own gain, into an EQ and a limiter. `AVAudioSession` category `.playback` with the background-audio mode: plays on the lock screen and through interruptions (calls, Siri), pauses when headphones are unplugged. Everything is scheduled on the engine's sample clock, so gapless playback, crossfades, DJ changeovers and cuts on the beat are sample-exact. None of the web's iOS workarounds (in-step rate nudging, muted starts, pre-rolled cuts, levelled WAV for want of volume) are needed.

**Streaming.** The app plays each song's own file (FLAC or MP3), downloading ahead with range requests into a disk cache and decoding progressively (AudioFileStream and AudioConverter) into PCM buffers for the deck. A seek beyond what's downloaded plays `levelled.wav?gain=0` from that point (exact to the sample, from the server) while the download catches up. As on the web: the next song is prepared 30 s before the end; three songs ahead are kept on Wi-Fi, one on mobile data; a broken stream is retried three times from the same point; the same error messages.

**Even volume.** The phone applies each song's gain from `/api/levels` itself, up as well as down, with a limiter at −1 dBFS, on streamed and downloaded songs alike. Album gain when an album plays in order.

**DJ transitions.** The same `POST /api/transitions`, asking and polling rules (after 5 s played, every 3 s then 10 s, give up 20 s before the mix point), sending the gains the phone plays each song at. The transition file is downloaded whole before it's needed, scheduled on the transition node at A's `aStart − lead` sample-aligned with A's deck, and B's own file (or `continuationUrl`) is scheduled at `plan.length`. Changeovers fall inside the identical lead and tail audio. Without a rendered file, the plan's fade or beat cut is played live by the engine.

**Ported as is.** Queue model (queue, order, position, shuffle keeping history, repeat, "Playing from", mix mode Auto, Party, No mixing), radio continuation and Start radio, sleep timer with its 20 s fade, play reports (a play at 30 s or half the song, a skip from 3 s before that; unsent reports queued on disk). Lock screen through `MPNowPlayingInfoCenter` and `MPRemoteCommandCenter` (play, pause, next, previous, seek, like to favorite). AirPlay and Bluetooth through the system route picker.

**Risk.** Progressive FLAC decoding and scheduling around seeks is the hardest part. `PlayarrPlayer` is built first, tested with synthetic signals for sample-exact joins and with a harness that plays real files from the dev server, before any screens sit on top.

## 4. Offline and downloads

As on the web: a limit for kept songs (Off, 512 MB, 1, 2, 5, 10 GB; 2 GB by default), least recently played dropped first; downloaded albums, playlists, mixes and Favorites pinned outside the limit, with the transitions between their consecutive songs (rendered in `auto` mode, same polling, give up after 10 minutes). Downloads run on a background URLSession, so they continue with the app closed; "Allow downloads on mobile data" is off by default. Files live in Application Support, excluded from iCloud backup, one folder per server and account, with a manifest of size and last play. Offline, songs not kept are skipped with the web's toast and play reports wait. Library → Downloads shows progress, size, Play, Remove and failed songs.

## 5. Signing and releasing

**App Store Connect API key.** A Team key (Admin role) does everything an Apple ID login would, with no password, two-factor prompt or expiring session.

One-time steps for the account holder:

1. developer.apple.com/account → Membership details: note the Entity Type and the Team ID.
2. App Store Connect → Users and Access → Integrations → App Store Connect API: request access if asked, create a Team key with the Admin role, download the `.p8` (only possible once).
3. Create the app record in App Store Connect (name, bundle id, SKU): the API can't create apps.
4. Put the key at `~/.appstoreconnect/private_keys/AuthKey_<id>.p8` and add `ASC_KEY_ID`, `ASC_ISSUER_ID` and `APPLE_TEAM_ID` to `.env`. A new Mac needs just these.

Automatic from then on:

- **Signing**: `xcodebuild -allowProvisioningUpdates` with the key (cloud signing) creates and renews certificates and profiles. Nothing signing-related is in the repo or the Keychain.
- **Bundle id and capabilities** registered through the API by `pnpm ios:setup`.
- **Build number** = git commit count; marketing version moves only at releases. The pre-commit version bump is unchanged.
- **`pnpm ios:beta`**: tests, archive, upload (`xcodebuild -exportArchive`, destination upload), wait for processing, add the build to the internal TestFlight group with "What to test" from the commit messages since the last build. `ITSAppUsesNonExemptEncryption = false` skips the export-compliance question.
- **`pnpm ios:release`**: create the App Store version, upload text from `apps/ios/store/` and screenshots taken by the UI tests (iPhone and iPad simulators, Creative Commons account), set review notes and the reviewer's sign-in, submit for review, release automatically once approved.
- **On a device during development**: `xcrun devicectl` installs on a connected or Wi-Fi-paired iPhone.
- **GitHub Actions**: every push runs Swift tests, contract tests and a simulator build; pushes to `main` that touch `apps/ios` also run `ios:beta`. The key lives in GitHub secrets (not exposed to forks' pull requests). Runners can lag behind the newest Xcode: the workflow pins the newest available, and the local scripts are the fallback.

What stays manual: the one-time steps, and answering App Review if they ask.

## 6. Server changes, all of them

1. Accounts, sessions, rights, per-account library access, Settings → Accounts, web sign-in and account switcher (section 1).
2. `GET /api/server` and Bonjour.
3. Bearer tokens accepted wherever a session cookie is, including `/stream`, `/art`, `/transitions` and levelled streams.

The player, analysis, planner and renderer stay as they are. Transitions requested with the phone's gains are cached separately from the web's, as any other gains are today.

## 7. Testing

- **Server**: accounts, sessions, rights, the migration from a current database, and the access filter at each place it applies.
- **Web**: existing tests updated for sign-in and switching accounts; smoke tests run signed in.
- **iOS**: contract tests (real responses decode); player tests with synthetic signals (joins, crossfades and seeks sample-exact); view models against a fake API; UI tests on the simulator against a dev server signed in as the Creative Commons account (the same tests take the screenshots).
- **On the phone**: each phase ends with a TestFlight build and a short checklist (lock-screen playback, a DJ transition, offline, switching accounts).

## Rollout

| # | Phase | Ends with |
|---|---|---|
| 0 | Apple setup and pipeline: one-time steps, XcodeGen skeleton, `ios:setup`, `ios:beta`, GitHub Actions | An empty Playarr app on the phone through TestFlight |
| 1 | Server accounts and web sign-in (section 1) | Signing in on the web; profiles are accounts; the reviewer account sees only the Creative Commons folder |
| 2 | iOS API layer and sign-in: servers, accounts, Bonjour, Keychain, models, contract tests | The app connects to a server and switches accounts |
| 3 | Audio engine | Albums play gapless and levelled, with crossfades and lock-screen controls |
| 4 | Browsing and Now Playing: Home, Search, Library, Artist, Album, Queue, lyrics, sleep timer, radio | Day-to-day listening in the app |
| 5 | DJ transitions and Stats for nerds | Mixes as on the desktop, on a locked iPhone |
| 6 | Favorites, playlists (covers, reorder, recommendations), mixes, Your listening | Parity for listening features |
| 7 | Offline downloads | Listening with no connection |
| 8 | Discover and requests, Show metadata, Edit mix points | Parity for library features |
| 9 | Admin settings: Sources (folder browser, review, organize), Mixes, Analysis, Requests, Updates, Accounts | Parity for Settings |
| 10 | iPad layout, accessibility, polish | iPad build on TestFlight |
| 11 | App Store: text, screenshots, review notes, `ios:release` | Submitted for review |

Phases 1 and 2 overlap: the app's sign-in only waits for the server's new endpoints.

The web app's feature inventory, [2026-11-03-ios-parity-inventory.md](2026-11-03-ios-parity-inventory.md) (every route, setting, endpoint and player rule, with file references), is the parity checklist each phase's plan draws from.
