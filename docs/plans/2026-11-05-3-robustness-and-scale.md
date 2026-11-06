# Plan 3: Robustness and scale

Agreed 2026-11-05 from the reviews; third of four (after [listening away from home](2026-11-05-2-listening-away-from-home.md)).

**Goal:** Playarr holds up on a collector's library (100k tracks) and in daily use: no stalls on the server's event loop or the iPhone's main thread, nothing lost when storage fills or two tabs are open, sessions and connections that can be trusted, and enough logging to diagnose a user's problem.

**Where it stands (2026-11-06):** not started; plans 5 to 7, on the apps' design and flows, were taken first.

## 1. Big libraries — M

- Measure first: a 100k-track synthetic library (a fixture generator), timing catalog refresh, the albums list, search and memory; the existing stall monitor records event-loop stalls.
- Catalog refresh: cache prepared statements, skip writes when nothing changed (compare a hash of meta, path, size and format), skip the rebuild when no source changed (`apps/server/src/catalog/store.ts` `applySync`, `library/library.ts`). Later, the build in a worker.
- Search: normalised strings computed once in the snapshot, not per query (`library.ts` `scoreMatch`, `artistByName`).
- An ETag from the library version on `/api/albums` and `/api/artists`; paging where lists get long; iOS and web page or index the albums list.
- **Done when**, at 100k tracks, a no-change refresh takes under 1 s, search answers in under 200 ms and the albums page opens in under 2 s.

## 2. iOS: the main thread belongs to the audio — M

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

## 4. Sessions, headers and SSH — S–M

- Sessions expire after 90 days unused, with an absolute maximum; signing out clears the service worker's API cache; tokens of accounts not in use aren't kept in localStorage in the clear.
- A Content-Security-Policy, `X-Content-Type-Options: nosniff` and `frame-ancestors` on every response.
- SSH and SFTP sources remember the server's host key on first use and refuse a different one; a saved password is re-sent only to the same host and port.
- `/api/health` tells strangers only whether things are fine; the details (Lidarr address, paths) go to admins.
- Login rate limiting with a global budget beside the per-address one; old entries pruned.

## 5. Shutdown, timeouts and backpressure on the server — S

- Shutdown closes HTTP first (forcing connections closed after a timeout), then sources and the database; `bonjour` declared before the handler; crash handlers that log.
- The SSH decode stream respects backpressure and has a size cap (`media/ssh.ts`).
- Timeouts on SSH commands, a size cap on remote images, one retry with backoff for Lidarr calls.
- A per-source lock shared by refresh and organize.

## 6. Logging and diagnostics — S–M

- iOS: `os.Logger` categories (player, engine, downloads, network, auth); MetricKit for hangs; Settings → "Copy diagnostics".
- Server: 4xx/5xx logged with request id, account and route; `x-request-id` returned; an admin-only `/api/diagnostics` (versions, queue depths, stalls, last sync per source); the Docker health check on the API.

## 7. Code health — L, as we go

- The web player engine (`AudioEngine.tsx`, 2,171 lines) becomes a framework-free engine with an explicit state machine and one owner of its timers; the React component a thin adapter.
- ESLint with `react-hooks` and `jsx-a11y` (rules only, no formatter); web tests that fail on any unmocked network request.
- Server: one error type and handler, zod for every route, `store.ts` split, a boot smoke test.
- iOS CI runs the iPad tests; one toolchain uploads TestFlight builds.

## Order

1 (measure) → 2 → 3 → 4 → 5 → 6; 7 alongside.
