# Plan 1: Safety and release

Agreed 2026-11-05 from the iOS, server, web and product reviews. First of four plans, in this order: safety and release, [listening away from home](2026-11-05-2-listening-away-from-home.md), [robustness and scale](2026-11-05-3-robustness-and-scale.md), [first run and household](2026-11-05-4-first-run-and-household.md).

**Goal:** nothing a push does can blank the app, stop the music, lose data or leak a credential, and every release can be undone. This comes before the App Store launch (phase 11): strangers' servers will update from the same pipeline.

Already done: the last password can no longer be reset or removed, which reopened the server in setup mode to anyone (`accounts.ts` `keepAPassword`, 2026-11-05).

## 1. The web app survives a deploy and a page error — S

After a deploy, a tab on the old build that opens a lazy page asks for a chunk that's gone; the server answers any GET it doesn't know with `index.html` (`apps/server/src/index.ts` not-found handler), the import fails, and with no error element the router's error screen replaces `AppShell`, unmounting `<AudioEngine/>`: the app goes blank and the music stops. Any render error does the same.

- `errorElement` on the routes inside `AppShell` (`apps/web/src/routes.tsx`), so a page's error shows in the page and the player bar and audio carry on.
- A root `errorElement` and a `vite:preloadError` listener that reload once when a chunk fails to load (a sessionStorage flag stops a loop).
- The server answers unknown `/assets/*` (and other files with an extension) with 404, not `index.html`.
- **Done when** a test removes a chunk mid-session and the page reloads into the new build while a song plays on, and a thrown render error leaves the player bar working.

## 2. A gate before the NAS, a snapshot before migrations, a way back — M

Nothing runs the server or web tests before the updater builds `main` (`.github/workflows/` has only `ios.yml`); migrations run at startup with no copy of the database (`apps/server/src/db.ts`); `docker/update.sh` replaces the container and prunes the old image, so there's nothing to go back to; the health check passes any body starting with `{`.

- `.github/workflows/server-web.yml`: typecheck and tests for `packages/*`, `apps/server` and `apps/web` on every push and pull request.
- The updater deploys only commits whose checks passed on GitHub (or tags, see the next point).
- Stable and edge: tagged releases are the default channel; following `main` becomes an opt-in setting (Settings → Updates). Owners from the App Store get stable.
- Before running migrations, `VACUUM INTO /config/backups/playarr-<version>-<sha>.db`, keeping the last 5.
- `update.sh` tags the running image `playarr:previous` before replacing it and restores it when the new one fails a real health check (`/api/health` with the database answering, not just any JSON).
- The server refuses to start on a database newer than it knows (`user_version` above its migrations), rather than running against it.
- **Done when** a red commit never reaches the NAS, a failed start rolls back within one update cycle, and a backup exists for every migration run.

## 3. iOS never sends the token to an address it hasn't verified — M

When the public address fails (including on certificate errors, which captive portals cause), `APIClient` retries at the stored home address, `http://192.168…`, and attaches the Bearer token, on whatever network the phone is on (`PlayarrAPI/APIClient.swift` `load` and `couldntConnect`; `ImageCache.swift` falls back on any error; `MediaURLs.swift` attaches the token for the local origin). The home address can also come from any device advertising `_playarr._tcp` with the server's public id.

- Certificate errors no longer count as "couldn't connect".
- The home address is tried only on Wi-Fi or wired networks (`NWPathMonitor`).
- Before the token goes to the home address, the server proves it holds it: a new `GET /api/auth/proof?nonce=` answers HMAC(sha256(token), nonce) (the server stores sha256 of tokens); the app checks it once per network change and caches the answer.
- **Done when** a test with a fake server at the home address that can't answer the proof never receives the token, and the real home server still works off the public address.

## 4. App Store blockers — S

- `PrivacyInfo.xcprivacy` in the app target: UserDefaults (CA92.1), file timestamps (C617.1 / DDA9.1), disk space (E174.1); no tracking, no data collected. Check App Store Connect for ITMS-91053 warnings on past uploads.
- An account whose session can't open (Keychain token missing after a restore, engine setup failing) shows a reason and a way out instead of a spinner for ever: a missing token signs the account out; an engine failure offers Retry (`RootView.swift`, `AppModel.swift`; today the error toast goes to a `ToastsView` that isn't on screen).
- The UI-test launch arguments and `PLAYARR_UITEST_TOKEN` sign-in only in Debug builds (`apps/ios/Playarr/PlayarrApp.swift`, `PlayarrUI/AppModel+UITests.swift`).

## 5. The API can't break shipped apps unnoticed — S

A push changes the server within 15 minutes; App Store copies of the app lag by weeks. The conventions doc promised `ios-contracts.yml`; it was never written, and `make models-check` runs nowhere.

- `.github/workflows/ios-contracts.yml` on changes to `packages/**`, `apps/server/**` or `apps/ios/**`: `gen-models.mjs --check`, re-record the contract fixtures, run `ContractTests`.
- A written rule for when to raise `minAppVersion`, in `docs/ios/release.md`.

## 6. Requests are user data — S

Album requests live in `CACHE_DIR/requests.json`, the folder the compose file calls safe to delete; two saves at once share one `.tmp` name; a parse error on load silently empties the list (`apps/server/src/discover/requests.ts`).

- A `requests` table in SQLite with the account that asked (a migration imports the JSON once). Who asked is used by plan 4 (approval, "it's ready").

## Order

1 (smallest, felt daily) → 6 → 2 → 4 → 5 → 3.
