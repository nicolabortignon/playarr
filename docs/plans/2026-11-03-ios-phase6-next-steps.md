# iOS Phase 6 (Favorites, Playlists, Mixes, Your listening): Next steps

Status as of 2026-11-03. The plan is [2026-11-03-ios-phase6-playlists-mixes.md](2026-11-03-ios-phase6-playlists-mixes.md).

## Where things stand

- **Plan: written and checked.** Its 27 tasks (0 to 26) were replayed in order on `main` at `8e22d1d`, and each task's own tests passed.
- **Test results after the last task:**
  - PlayarrUI: 160 tests passed.
  - PlayarrPlayer: 157 passed.
  - PlayarrAPI: 72 passed.
  - The iOS 26 simulator build was clean.
  - XCUITest `PlaylistsTests`, 2 of 2: passed on the separate "Playarr P6" simulator.
- **Code: none of it is in the repo yet.** The plan file and this note are the only files written. Nothing is committed, and nothing in `apps/` changed. The checked Swift sources are in scratch folders outside the repo:
  - `/tmp/p6/Packages`
  - `/tmp/p6app/PlayarrUITests`
  - the replayed tree, `/tmp/p6replay`

  These are disposable. The plan holds every file in full, so it's all you need.

## Next steps

1. **Commit the plan**, after a read-through, with this note if wanted:
   `git add docs/plans/2026-11-03-ios-phase6-playlists-mixes.md docs/plans/2026-11-03-ios-phase6-next-steps.md`
2. **Wait for phase 5 to land.** Phase 4 is done, so phase 6 can start once phase 5's work (Stats for nerds, transitions) is committed and `main` is clean. Phase 6's anchors don't overlap phase 5's.
3. **Carry out the plan** with superpowers:executing-plans, Tasks 0 to 23 in order, one commit each on `main`. Task 0 re-checks the names the plan depends on; if one has changed, fix it only in the task that uses it.
4. **Task 24: walk through it against the dev server.** The NAS can't be reached from Claude's shell, so the user runs the server.
5. **Task 25: TestFlight and the on-device checklist** (lock-screen like, reorder, covers on mobile data, account switching). This one is the user's.
6. **Task 26: conventions, for the coordinator to decide.** Record in `2026-11-03-ios-conventions.md`:
   - `AccountSession.favorites`, `.playlists`, `.mixes`, `.picking` and `addToPlaylist(_:)`
   - `Route.listeningRange`
   - `Polling` in `UI/Support/` (phase 9 should reuse it rather than add its own)
   - `FakeAPI.queries` / `before` and `Gate`
   - `DemoState`
   - `Player.live(like:)` and `NowPlayingBridge.setLiked`

## Known issues, not caused by phase 6

- Phase 4's XCUITest `BrowseTests.testTheQueueClearsWithUndo` fails on `main`, even with phase 4's own `QueueView`. It needs a separate fix.

## Left for later phases

- Download buttons on Favorites, playlists and mixes: phase 7.
- "Show metadata" in a playlist row's menu, and the request button in "Songs like these": phase 8.
- "Tune your mixes" on Made for you: phase 9.
- Possibly drawing OKLCH mix colours in Display P3 rather than clipped sRGB. Optional; the mix washes are within sRGB today.
