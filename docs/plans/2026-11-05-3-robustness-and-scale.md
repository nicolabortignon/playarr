# Plan 3: Robustness and scale

Agreed 2026-11-05 from the reviews; third of four (after [listening away from home](2026-11-05-2-listening-away-from-home.md)).

**Goal:** Playarr holds up on a collector's library (100k tracks) and in daily use: no stalls on the server's event loop or the iPhone's main thread, nothing lost when storage fills or two tabs are open, sessions and connections that can be trusted, and enough logging to diagnose a user's problem.

**Where it stands (2026-11-07):** §1 done but for the build in a worker; §2 done but for the measurement on a device; §3 under way; §4 partly done (the headers, and health's details for admins only); §5 and §6 done. §7 as we go.

## 1. Big libraries — M — done 2026-11-07, but for the build in a worker

*Done on the server and the web, measured on a synthetic library of 100,000 songs (`pnpm -C apps/server bench:library`): a refresh that finds nothing new takes 73 ms for a folder and 270 ms for Lidarr, where it took 6.5 and 4.4 s; search answers in 5 to 20 ms, about 100 ms at worst (nothing found, then what's near), where it took 110 to 335; `/api/albums` and `/api/artists` come a page at a time with `offset`, and carry an ETag ([api.md](../server/api.md)); the web's Albums page opens with its first 120 albums (58 KB) rather than all of them (4.4 MB). The iOS app's Albums list reads them a page at a time too (`AlbumsModel`, 120 a page, from an older server its whole list as one page). Left: the build in a worker, as a refresh that does find a change still holds the event loop for 1.5 to 3.5 s at this size (scanning the folder, comparing every row, then building).*

- Measure first: a 100k-track synthetic library (a fixture generator), timing catalog refresh, the albums list, search and memory; the existing stall monitor records event-loop stalls.
- Catalog refresh: cache prepared statements, skip writes when nothing changed (compare a hash of meta, path, size and format), skip the rebuild when no source changed (`apps/server/src/catalog/store.ts` `applySync`, `library/library.ts`). Later, the build in a worker.
- Search: normalised strings computed once in the snapshot, not per query (`library.ts` `scoreMatch`, `artistByName`).
- An ETag from the library version on `/api/albums` and `/api/artists`; paging where lists get long; iOS and web page or index the albums list.
- **Done when**, at 100k tracks, a no-change refresh takes under 1 s, search answers in under 200 ms and the albums page opens in under 2 s.

## 2. iOS: the main thread belongs to the audio — M — done 2026-11-07 but for the measurement

*Done: the queue and the downloads' list are written off the main thread, a second after they last changed and at once when the app goes to the background (`JSONWriter`), and where it is in the song is saved on its own (`resume.json`); covers are decoded off the main thread and kept decoded (`PreparedImages`, 48 MB); the query cache keeps the 300 answers used most recently in memory; the clock ticks twice a second while paused; sideways Now Playing's "Playing from" line and the synced lyrics' line are the only parts of their pages that read the clock (`PlayingFromButton`, `LineFollower`), so the pages aren't made again 10 times a second. Cached answers bigger than 64 KB (the artists, Favorites, a long playlist) are read and decoded off the main thread (`QueryCache.kept`), smaller ones at once so a page opens with them; screens' polling (admin panels, health, MusicBrainz's status, a cover being drawn) waits while the app is in the background, playing music or not, and asks at once when it's back (`AppActivity`); the requests' watch goes on, since it tells of albums that arrived. Left: the measurement in Instruments on a device.*

- Queue and download-manifest saves move into an actor with debounced writes; the resume position is saved on its own (`Player.swift`, `JSONFile.swift`, `DownloadStore.swift`).
- Cached answers decoded off the main thread (`QueryCache.swift`, `Query.swift`).
- Narrower observation: `resumeAt` out of the observed queue; the clock separate from the queue; sideways Now Playing reads `time` only in leaf views (`NowPlayingView.swift`, `QueueView.swift`).
- Covers decoded and downsampled off main and cached decoded; an LRU limit on `QueryCache`.
- Polling stops in the background; the 10 Hz tick slows while paused.
- **Done when** a 10k-song queue shows no hitch over 50 ms in Instruments while a DJ mix plays.

## 3. Web: storage that can't lose downloads — M

- Download progress in a store that isn't saved; the player and offline stores persisted to IndexedDB (`idb-keyval` is already there) through debounced, error-catching writes; `resumeAt` in its own key; the queue compacted (`player/store.ts`, `player/offline.ts`).
- One leader tab (`navigator.locks`) runs downloads, load-ahead and play reports; other tabs follow its saved state and say "playing in another tab".
- Live mix reads only the bytes it needs from kept files (`liveMix.ts` `songBytes`).
- **Done when** a full quota or a second tab never deletes a kept song.

## 4. Sessions, headers and SSH — S–M — partly done 2026-11-07

*Done: every answer carries `X-Content-Type-Options: nosniff` and `Content-Security-Policy: frame-ancestors 'self'`, the web app's files, streams, art and transitions included (`securityHeaders.ts`); the rest of a policy waits until it can be checked in a browser, as a wrong one blanks the app. `/api/health` tells everyone whether things are fine, in the same shape as before, and only admins Lidarr's version and why Lidarr or the music can't be reached ([api.md](../server/api.md)). Sessions end after 90 days unused and a year after they began (`accounts/sessions.ts`). Failed sign-ins and codes from outside the home network share a budget of 100 in 15 minutes beside each address's own 10, and addresses with nothing recent are forgotten (`accounts/rateLimit.ts`). Left: the full policy, SSH host keys, and on the web clearing the service worker's API cache on signing out and keeping other accounts' tokens out of localStorage in the clear.*

- Sessions expire after 90 days unused, with an absolute maximum; signing out clears the service worker's API cache; tokens of accounts not in use aren't kept in localStorage in the clear.
- A Content-Security-Policy, `X-Content-Type-Options: nosniff` and `frame-ancestors` on every response.
- SSH and SFTP sources remember the server's host key on first use and refuse a different one; a saved password is re-sent only to the same host and port.
- `/api/health` tells strangers only whether things are fine; the details (Lidarr address, paths) go to admins.
- Login rate limiting with a global budget beside the per-address one; old entries pruned.

## 5. Shutdown, timeouts and backpressure on the server — S — done 2026-11-07

*Done 2026-11-07: shutdown stops Bonjour and HTTP first, cuts connections still open after 5 s, then stops the background work, the sources and the database (`index.ts`); a crash is logged before the server stops, and a promise that failed with nobody to hear it is logged. SSH commands fail when the host hasn't started them within 20 s or they go 60 s without output, or say more than 64 MB (a listing 256 MB, a decode 96 MB, as the local and rclone ones already did); encoded streams over SSH hold ffmpeg back while their reader is behind (plan 2). Remote images and Lidarr's originals stop at 20 MB. A question to Lidarr that didn't reach it, or got 502, 503 or 504, is asked once more a second later. A source's sync and the moving of its files take turns (`SourceLocks`).*

- Shutdown closes HTTP first (forcing connections closed after a timeout), then sources and the database; `bonjour` declared before the handler; crash handlers that log.
- The SSH decode stream respects backpressure and has a size cap (`media/ssh.ts`).
- Timeouts on SSH commands, a size cap on remote images, one retry with backoff for Lidarr calls.
- A per-source lock shared by refresh and organize.

## 6. Logging and diagnostics — S–M — done 2026-11-07

*Done on iOS: `Log` categories, MetricKit's hang and crash reports, and Settings → Copy diagnostics (docs/ios/README.md §6). Done on the server: every answer carries `X-Request-Id` (the client's own when it's a sane token), the `reqId` of the request's log lines; every 4xx and 5xx is logged with it, the account and the route as registered, a 5xx with its error and stack, and never the URL, body or tokens (`requestLog.ts`); the admin-only `GET /api/diagnostics` answers the version and schema, Node's version, uptime and memory, each source's last sync and error, the analysis, transition and encoding queues, the answers by status class and the stalls ([api.md](../server/api.md)); and Docker's health check asks `/api/health` for the database working (`docker/compose.yaml`, and the image).*

- iOS: `os.Logger` categories (player, engine, downloads, network, auth); MetricKit for hangs; Settings → "Copy diagnostics".
- Server: 4xx/5xx logged with request id, account and route; `x-request-id` returned; an admin-only `/api/diagnostics` (versions, queue depths, stalls, last sync per source); the Docker health check on the API.

## 7. Code health — L, as we go

*Done so far: the boot smoke test (`apps/server/src/boot.test.ts`: the server as `pnpm dev` runs it starts on empty folders, answers `/api/health` with its headers, and closes with nothing logged as an error).*

- The web player engine (`AudioEngine.tsx`, 2,171 lines) becomes a framework-free engine with an explicit state machine and one owner of its timers; the React component a thin adapter.
- ESLint with `react-hooks` and `jsx-a11y` (rules only, no formatter); web tests that fail on any unmocked network request.
- Server: one error type and handler, zod for every route, `store.ts` split, a boot smoke test.
- iOS CI runs the iPad tests; one toolchain uploads TestFlight builds.

## Order

1 (measure) → 2 → 3 → 4 → 5 → 6; 7 alongside.
