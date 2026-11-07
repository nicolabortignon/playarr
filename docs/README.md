# Playarr docs

How Playarr works today, part by part. The code is the final word; these pages say what it does, where it lives and why. For what Playarr is and how to run it, see the [README](../README.md).

## Overview

- [architecture.md](architecture.md): the big picture: server, web, iOS, shared packages, how they talk, and how it's deployed.
- [decisions.md](decisions.md): the decisions log, dated, with the reason behind each.
- [design.md](design.md): the design language: colors, type, shapes, icons, motion and words, by role, with each app's name for them.

## Server (`apps/server`)

- [server/sources-and-catalog.md](server/sources-and-catalog.md): Lidarr and folder sources (local, SSH, SFTP, SMB), how the catalog is built and synced, and ids.
- [server/matching-and-organize.md](server/matching-and-organize.md): identifying folder music on MusicBrainz and AcoustID, the review list, and organizing files.
- [server/accounts-and-access.md](server/accounts-and-access.md): accounts, sessions, setup mode, rights and per-account library access.
- [server/streaming-and-art.md](server/streaming-and-art.md): byte-range streams, levelled and lossless WAV, transition files, artwork and lyrics.
- [server/discover-and-requests.md](server/discover-and-requests.md): searching beyond the library, requesting albums through Lidarr, and playlist recommendations.
- [server/playlist-covers.md](server/playlist-covers.md): playlist covers drawn from how the songs sound.
- [server/updates-and-deploy.md](server/updates-and-deploy.md): the Docker image, configuration, the NAS deployment, automatic updates and the release flow.
- [server/api.md](server/api.md): every route, grouped, with who may call it.

## Listening and mixing

- [mixes.md](mixes.md): play reports, Made for you mixes, radio, stats and ListenBrainz.
- [mixing.md](mixing.md): DJ transitions from analysis to playback, with every threshold.

## Web app (`apps/web`)

- [web.md](web.md): structure, state, the player, the service worker, load-ahead and downloads.

## iOS app (`apps/ios`)

- [ios/README.md](ios/README.md): architecture: targets and packages, talking to servers, the shell on iPhone, iPad and iPhone Duo, demo mode, building and testing.
- [ios/conventions.md](ios/conventions.md): names, commands, layout and commit style; read this before changing the app.
- [ios/audio-engine.md](ios/audio-engine.md): the AVAudioEngine player, streaming, even volume, DJ transitions and the lock screen.
- [ios/offline.md](ios/offline.md): downloads, keep-ahead and playing offline.
- [ios/layouts.md](ios/layouts.md): portrait, sideways, iPad and iPhone Duo layouts, and accessibility.
- [ios/release.md](ios/release.md): TestFlight and App Store tooling.

## Plans (work not finished)

- [plans/2026-11-05-1-safety-and-release.md](plans/2026-11-05-1-safety-and-release.md): nothing a push does can blank the app, lose data or leak a credential; every release can be undone. *1 and 6 done; 2 to 5 left.*
- [plans/2026-11-05-2-listening-away-from-home.md](plans/2026-11-05-2-listening-away-from-home.md): transcoding and quality settings, HTTPS an owner can set up, AirPlay, riding out dead spots. *Not started.*
- [plans/2026-11-05-3-robustness-and-scale.md](plans/2026-11-05-3-robustness-and-scale.md): 100k-track libraries, the main thread, storage, sessions, logging, code health. *Not started.*
- [plans/2026-11-05-4-first-run-and-household.md](plans/2026-11-05-4-first-run-and-household.md): the welcome screen, invites that open the app, requests that belong to someone, shared playlists. *Not started.*
- [plans/2026-11-05-5-ui-consistency.md](plans/2026-11-05-5-ui-consistency.md): one design language across pages and both apps: a design doc, one set of buttons, one action row, one page header, rows and cards, icons, words, empty and error states, and a web screen tour. *Done on both apps.*
- [plans/2026-11-05-6-ux-flows.md](plans/2026-11-05-6-ux-flows.md): touch at desktop width, Undo for removals, one song menu, pages that lead with Play, a player that's never dead, Settings on a phone, search without dead ends, keyboard and VoiceOver. *Done on both apps; a few smaller things left.*
- [plans/2026-11-05-7-delight.md](plans/2026-11-05-7-delight.md): things that move from where they came from, an app that keeps time with the music, covers as objects, one voice, small rituals, scrubbing you can see, haptics. *Sections 1 to 6 done on the web; iOS to do, after plans 5 and 6; the bigger ideas wait until they're asked for.*
- [plans/2026-11-07-8-mood-mixes.md](plans/2026-11-07-8-mood-mixes.md): what defines Energy boost, Chill, Deep focus and Wind down, and the algorithm that matches songs to them from the measured sound, tags, lyrics and shape. *Built on the server; to tune on a real library.*
- [plans/open-items.md](plans/open-items.md): everything else still open, one line each, with where it came from.
- [plans/2026-11-03-ios-phase11-app-store.md](plans/2026-11-03-ios-phase11-app-store.md): the App Store launch, in progress.
- [plans/2026-11-05-ios-device-checklist.md](plans/2026-11-05-ios-device-checklist.md): what still has to be checked on a real iPhone or iPad.
