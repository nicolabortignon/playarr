# Open items

Everything known to be unfinished, one line each, with where it came from. Gathered on 2026-11-05 from the old `PLAN.md` roadmap and open questions, the finished plans (since deleted) and a read of the code while writing [the docs](../README.md). Items marked *(found)* came from that read rather than from a plan. Remove a line when it's done; new work gets its own plan in this folder. The four plans agreed on 2026-11-05 ([1 safety and release](2026-11-05-1-safety-and-release.md), [2 listening away from home](2026-11-05-2-listening-away-from-home.md), [3 robustness and scale](2026-11-05-3-robustness-and-scale.md), [4 first run and household](2026-11-05-4-first-run-and-household.md)) took over HTTPS, transcoding for mobile data, CI, the models check, ESLint and requests in the cache.

## In progress

- App Store launch: the user's decisions, the privacy and support pages, the screenshots, the CI release job, a dry run, the submission. *([2026-11-03-ios-phase11-app-store.md](2026-11-03-ios-phase11-app-store.md))*
- Checks on a real iPhone, iPad and iPhone Duo: sideways, iPad keyboard, pointer, drag, narrow windows, restoration, VoiceOver, Siri, the Duo's hinge, offline, the server settings panels. *([2026-11-05-ios-device-checklist.md](2026-11-05-ios-device-checklist.md))*
- iOS offline, in the simulator against the dev server: album download ring and Library → Downloads, a playlist download fetching its transitions, lowering the limit to 512 MB, playing offline with skipped songs, resuming after quitting from the switcher. *(ios-status, phase 7)*
- A TestFlight build once the device checklist passes. *(ios-status)*

## Server

- Formats browsers can't play beyond Apple Lossless and AIFF (WMA, APE, WavPack, DSD; Ogg and Opus on older Safari): a stream they can, once plan 2's transcoding exists. *(PLAN.md browser format notes)*
- ReplayGain tags (as an alternative to Playarr's own loudness) and EQ. *(PLAN.md roadmap phase 6)*
- Lidarr: interactive release picking from inside Playarr. *(PLAN.md roadmap phase 6)*
- Live library updates through Lidarr's SignalR feed instead of the 10-minute refresh. *(PLAN.md roadmap phase 6)*
- Last.fm scrobbling (ListenBrainz is done). *(PLAN.md roadmap phase 6)*
- "Songs like these" recommendations for Favorites, as playlists have. *(PLAN.md roadmap phase 6)*
- When a song's best copy fails to play, fall back to the next best copy (today `/stream` answers 502/503). *(sources design)*
- Skip copies on an offline or unreachable source (today they stay in the catalog and fail to play). *(sources design)*
- Merge and key unmatched folder songs by fingerprint (today they keep `local:<hash>` ids for good). *(sources design, sources phase 3)*
- A loose song's menu listing the other releases it's on. *(sources design)*
- Discover's "in your library" links come from the whole library, so an account limited to some sources can get a link that 404s. *(iOS phase 1 accounts plan)*
- Levels for accounts limited to some sources: loudness is measured on the full library's best copy, so an account whose only copy is another file hears that song unlevelled. *(iOS phase 1 accounts plan)*
- Check on the NAS that internet visitors never look like home-network addresses (Docker's userland proxy can rewrite source addresses); it matters while a server is in setup mode. *(PLAN.md decisions log, 2026-10-30)*
- Try matching, SSH, SFTP, SMB, AcoustID and fpcalc against real hosts and a real collection; the plans only verified them with tests and fakes. *(sources phases 4, 5, 6)*

## Web

- Filter albums by genre or format. *(PLAN.md roadmap phase 3)*
- Long-press menus on touch screens, and right-click menus on desktop. *(PLAN.md roadmap phase 3, UX direction)*
- Swipe left and right on Now Playing for next and previous (dragging down to close is done). *(PLAN.md roadmap phase 4)*
- iOS standalone PWA quirks: background audio, safe areas, splash screen. *(PLAN.md roadmap phase 4)*
- Cast and AirPlay through the Remote Playback API. *(PLAN.md roadmap phase 6)*
- Load-ahead, Cache Storage and downloads have only been tested with unit and smoke tests, never in a real browser. *(PLAN.md decisions log, 2026-10-29)*
- Phones held sideways could get the iOS app's sleeve layout for Now Playing. *(iOS sideways Now Playing spec)*
- Optional wrappers: Tauri on desktop, Capacitor on mobile. *(PLAN.md roadmap phase 6)*

## iOS

- iPhone Duo App Store screenshots, required from April 2027 for apps built with the iOS 27.1 SDK. *(phase 11, "Not in this phase")*
- Accessibility Nutrition Labels on the App Store, once the device checks pass. *(phase 11, "Not in this phase")*
- Mac and CarPlay. *(iOS app design)*
- Covers of downloaded albums kept beyond the image cache, so they always show offline. *(phase 7, "Not in this phase")*
- Levels of songs kept as you listen, kept across launches (only downloads' are). *(phase 7, "Not in this phase")*
- Seeking inside a DJ transition abandons the mix rather than seeking within it. *(phase 5)*
- Sideways Now Playing, parts of the spec not built: the tracklist on the iPad and Duo (they still show four songs of Up next), the stage centring the open line with the time left, the header's actions moving into ⋯ at accessibility sizes, Increase Contrast flattening the backdrop, VoiceOver actions on tracklist lines, Undo after swiping a line away. *(sideways Now Playing spec)*
- `ScreenTour` shots of the stage, lyrics sideways and a DJ-mix join. *(sideways Now Playing spec)*
- Bold Text: the bundled fonts don't follow it (nothing reads `legibilityWeight`), though phase 10 assumed system fonts would. *(phase 10, found)*
- Mix colours drawn in Display P3 rather than sRGB (optional; today's washes fit in sRGB). *(phase 6 next steps)*

## Tooling

- `.env.example` doesn't list `ASC_KEY_ID`, `ASC_ISSUER_ID`, `APPLE_TEAM_ID` and `IOS_BUNDLE_ID`, which the iOS release scripts need. *(found)*
- The web smoke tests pass silently when no server is running (`apps/web/src/smoke.test.tsx` returns early). *(found)*

## Found while writing the docs

- Hand-set cue points stay on the old id when a folder song is matched to MusicBrainz (`moveRecording` in `apps/server/src/catalog/store.ts` moves favorites, playlist items, sound analysis and plays only), though a comment in `db.ts` says they survive. *(found)*
- A deleted copy's id can be handed to a new Lidarr copy with the same track-file id (`freeId` in `catalog/store.ts`), which could point a song kept offline at another file. *(found)*
- On iOS, levels a download learns while the app runs reach the player only at the next launch or sign-in (`levels.remember(downloads.keptLevels)` runs once in `Player.init`). *(found)*
- An iPhone Pro Max held sideways may be regular width (956 points), which would give it the iPad's sidebar and wide Now Playing instead of the sleeve (`ShellLayout.choose`); untested, worth a look on the simulator. *(found)*
