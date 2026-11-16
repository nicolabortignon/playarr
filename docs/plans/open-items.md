# Open items

Everything known to be unfinished, one line each, with where it came from. Gathered on 2026-11-05 from the old `PLAN.md` roadmap and open questions, the finished plans (since deleted) and a read of the code while writing [the docs](../README.md). Items marked *(found)* came from that read rather than from a plan. Remove a line when it's done; new work gets its own plan in this folder. The four plans agreed on 2026-11-05 ([1 safety and release](2026-11-05-1-safety-and-release.md), [2 listening away from home](2026-11-05-2-listening-away-from-home.md), [3 robustness and scale](2026-11-05-3-robustness-and-scale.md), [4 first run and household](2026-11-05-4-first-run-and-household.md)) took over HTTPS, transcoding for mobile data, CI, the models check, ESLint and requests in the cache.

## In progress

- The TV app, plan 9: built through step 8 and seen on the emulator. Left: the [checks on the TV](2026-11-16-tv-device-checklist.md), the upload key into GitHub's secrets, the first `tv-v*` release, and Google Play's account and forms. *([2026-11-15-9-tv-client.md](2026-11-15-9-tv-client.md), Progress)*

- App Store launch: the user's decisions, the privacy and support pages, the screenshots, the CI release job, a dry run, the submission. *([2026-11-03-ios-phase11-app-store.md](2026-11-03-ios-phase11-app-store.md))*
- Checks on a real iPhone, iPad and iPhone Duo: sideways, iPad keyboard, pointer, drag, narrow windows, restoration, VoiceOver, Siri, the Duo's hinge, offline, the server settings panels. *([2026-11-05-ios-device-checklist.md](2026-11-05-ios-device-checklist.md))*
- iOS offline, in the simulator against the dev server: album download ring and Library → Downloads, a playlist download fetching its transitions, lowering the limit to 512 MB, playing offline with skipped songs, resuming after quitting from the switcher. *(ios-status, phase 7)*

## Server

- Formats browsers can't play beyond Apple Lossless and AIFF (WMA, APE, WavPack, DSD; Ogg and Opus on older Safari): plan 2's encoded stream could stand in for them at Original too (at High and Normal it already does for files bigger than the stream). *(PLAN.md browser format notes)*
- Encoded streams: Safari starts one only once it's all encoded (a few seconds a song), which an HLS playlist of the same fragments or Media Source Extensions would shorten; Chrome's and Firefox's placing of their samples isn't measured, so DJ mix plays songs' own files there; and transitions and B's remainders stay FLAC on mobile data. *(plan 2)*
- ReplayGain tags (as an alternative to Playarr's own loudness) and EQ. *(PLAN.md roadmap phase 6)*
- Lidarr: interactive release picking from inside Playarr. *(PLAN.md roadmap phase 6)*
- Live library updates through Lidarr's SignalR feed instead of the 10-minute refresh. *(PLAN.md roadmap phase 6)*
- Last.fm in the iOS app's Settings → Mixes, beside ListenBrainz (the web's has it). *(found)*
- Merge and key unmatched folder songs by fingerprint (today they keep `local:<hash>` ids for good). *(sources design, sources phase 3)*
- A loose song's menu listing the other releases it's on. *(sources design)*
- Levels for accounts limited to some sources: loudness is measured on the full library's best copy, so an account whose only copy is another file hears that song unlevelled. *(iOS phase 1 accounts plan)*
- Check on the NAS that internet visitors never look like home-network addresses (Docker's userland proxy can rewrite source addresses); it matters while a server is in setup mode. *(PLAN.md decisions log, 2026-10-30)*
- Try matching, SSH, SFTP, SMB, AcoustID and fpcalc against real hosts and a real collection; the plans only verified them with tests and fakes. *(sources phases 4, 5, 6)*

## Web

- iOS standalone PWA quirks: background audio, safe areas, splash screen. *(PLAN.md roadmap phase 4)*
- Cast and AirPlay through the Remote Playback API. *(PLAN.md roadmap phase 6)*
- Load-ahead, Cache Storage and downloads have only been tested with unit and smoke tests, never in a real browser. *(PLAN.md decisions log, 2026-10-29)*
- Phones held sideways could get the iOS app's sleeve layout for Now Playing. *(iOS sideways Now Playing spec)*
- Optional wrappers: Tauri on desktop, Capacitor on mobile. *(PLAN.md roadmap phase 6)*
- Feeling lucky's fan of covers is cut short where the button goes as the music starts (the idle player bar, the empty queue's page); keeping it would take a layer above the page. *(found)*
- On a phone, Feeling lucky asks for its songs only as a finger touches it, so with a slow server the first song's card can still come out after the others; asking when Home opens would cover it, at one request per visit. *(found)*

## iOS

- iPhone Duo App Store screenshots, required from April 2027 for apps built with the iOS 27.1 SDK. *(phase 11, "Not in this phase")*
- Accessibility Nutrition Labels on the App Store, once the device checks pass. *(phase 11, "Not in this phase")*
- Mac and CarPlay. *(iOS app design)*
- Seeking inside a DJ transition abandons the mix rather than seeking within it. *(phase 5)*
- Mix colors drawn in Display P3 rather than sRGB (optional; today's washes fit in sRGB). *(phase 6 next steps)*
- Once in five iPhone runs of `AccessibilityAuditTests`, Now Playing didn't open from the mini player within 5 seconds; it has passed every run since. *(found)*

## Tooling

