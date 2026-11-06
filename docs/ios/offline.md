# Offline and downloads on iOS

The app plays without a connection. Albums, playlists, mixes and Favorites can be downloaded, and the DJ transitions between their songs come with them. Songs are also kept as you listen, within a limit. Offline, the player plays what's on the device, skips what isn't, and holds play reports until the network is back.

The rules are the web's (`apps/web/src/player/offline.ts`, `downloads.ts`, `loadAhead.ts`). Downloads mean the same thing on both: they use the same keys. The code is in `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer` (the store and rules) and `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Downloads` (the screens). How songs are decoded and played is in [audio-engine.md](audio-engine.md). The web's side is in [web.md](../web.md).

---

## 1. What's on disk

Each server and account has one folder, `Application Support/Playarr/<serverId>/<accountId>/`. `OfflineFolder` (`OfflineFolder.swift`) works out its layout; `AccountSession.folder(for:)` builds the same path.

| Path | What |
|---|---|
| `stream/<fileId>.<ext>` | Every whole song file, whoever fetched it: kept as you listen, downloaded, or fetched ahead. `.part` while incomplete. |
| `stream/transition-<name>` | Transition files the player fetched while playing (not downloads'). |
| `offline/transitions/<name>` | Downloads' transition files and MP3 continuations, under the server's names (content keys). |
| `offline/resume/` | Resume data of interrupted background downloads. |
| `offline.json` | The manifest (`OfflineManifest`): every kept song file with its size and last use, downloads' transition files, and the downloads themselves. |
| `queries/` | The query cache's answers (§8). |
| `pending-plays.json`, `queue.json` | Play reports waiting to go, and the saved queue. |

`OfflineFolder.prepare()` marks `stream/` and `offline/` `isExcludedFromBackup`: none of it goes to iCloud backups, since it can all be downloaded again. iOS never clears Application Support on its own. Covers are the exception: they live in `Caches/Playarr/<serverId>/<accountId>/images/` (`AccountSession.imageFolder`), which the system may empty.

## 2. One book-keeper

`DownloadStore` (`DownloadStore.swift`, `@MainActor @Observable`, `Player.downloads`) owns the manifest. `StreamCache` still fetches songs for playback and keep-ahead. It hands its books over with `keepBooks(with:)`: it tells the store about each whole file (`.completed`) and each play (`.used`), and the store decides what goes (`StreamCache.remove`). A song played before is therefore adopted by a download instead of fetched twice. A downloaded song plays through `TrackSource`'s existing "whole file in the cache" path, with no network.

At launch, `reconcile()` forgets files that are gone. It also takes on whole songs on disk that the manifest doesn't know, such as ones another account's background job finished, and deletes transition files no download wants. The pure rules (pairs, eviction, what to fetch next, progress) are in `OfflineRules.swift`.

## 3. Songs kept as you listen: the limit

Settings → Playback → On this device → "Keep up to" (`PlaybackSettings.offlineLimit`, key `playback.offlineLimit`) offers Off, 512 MB, 1, 2, 5 or 10 GB. The default is 2 GB (`OfflineLimit.swift`).

- Only songs in no download count towards the limit (`OfflineRules.unpinned`). **Downloads are never evicted.** They stay until removed.
- Past the limit, the least recently played go first (`OfflineRules.evictions`). Lowering the limit drops them at once. Off drops them all.
- What plays now and next, and the keep-ahead plan, are protected (`DownloadStore.protect`): never dropped, whatever the limit.
- Removing a download turns its songs into ordinary kept songs, which then make room as usual.

## 4. Keep-ahead

`KeepAhead.plan` (`KeepAhead.swift`, with `PrefetchPolicy` in `NetworkMonitor.swift`) works by network:

| Network | Kept ahead |
|---|---|
| Wi-Fi | the next 3 songs in play order, then the current one |
| Mobile data (or a hotspot) | the next 1 |
| Low Data Mode (`NWPath.isConstrained`) | none |
| Offline, or limit Off | none |

With repeat one, the current song comes first. The Player protects what plays now and next at once. It plans after the queue has been still for 2.5 s (`KeepAhead.settle`), so skipping through songs downloads nothing, and plans again whenever the network changes. The stream cache fetches the songs not already kept, one at a time (`StreamCache.prefetch`). `keepOnly` stops downloads of songs that left the plan.

## 5. Downloads

A download is a `PinnedDownload` (`PinnedDownload.swift`; `Download` is the one-file HTTP fetch). It has the web's keys (`album:12`, `playlist:3`, `mix:discovery`, `favorites`) and stores:

- its title, cover and `href`;
- its tracks as of the last visit;
- the transitions between them;
- its songs' levels.

**The button.** `DownloadButton` sits in the action row of the Album, Playlist, Mix and Favorites pages: an outlined circle whose ring fills as the songs arrive, ending in a tick. When the page's songs change (a playlist edited since), the download is updated to match, and transitions between songs that no longer follow each other go.

**Room.** Before starting, `room(for:)` adds up the songs not yet on the device (`Track.size`). They have to fit in the free space (`volumeAvailableCapacityForImportantUsage`) plus the songs kept as you listen (they'd make way), minus 256 MB kept free (`DownloadStore.reserve`). If they don't, an alert gives both sizes.

**Fetching.** Songs are fetched one at a time on the background session, downloads in the order they were added and songs in order:

- A song the stream cache already has is adopted.
- A song the player is fetching right now is left to the player.
- When the app resigns active, the store hands the system up to 25 songs at once (`backgroundJobs`), so they go on with the app closed. `httpMaximumConnectionsPerHost = 1` keeps them one at a time on the wire.
- Back in the foreground, it starts one at a time again.

**The background session** is `URLSessionTransport.background` (identifier `me.tracklistme.playarr.downloads`, never discretionary). `AppDelegate` (`apps/ios/Playarr/AppDelegate.swift`) creates it at launch and calls the system's completion handler once a relaunch's events are in. A job's name (`taskDescription`) is its file's path from `Application Support/Playarr/`. `TransportFiles.finish` moves the file there before the delegate returns, whichever account is active by then. After a relaunch, the jobs the system still runs are adopted, not asked for again (`adoptRunningJobs`). Nothing is fetched until they're known.

**Resuming.** A task that ends with resume data has it saved in `offline/resume/`. That happens when the app is closed from the switcher, or a connection fails for good. The next try, after a relaunch too, continues from it. URLSession sends the server a `Range` request. A cancel the store didn't ask for is never counted as a failure.

**Mobile data.** "Allow downloads on mobile data" (`playback.cellularDownloads`) is off by default. It sets `allowsCellularAccess` and `allowsExpensiveNetworkAccess` on each request, so hotspots count as mobile data. When it's off, downloads wait for Wi-Fi. Changing it restarts the song under way under the new rule. Low Data Mode doesn't block a download you asked for; it only stops keep-ahead.

**Failures and space.** If the device is short of room, songs kept as you listen make way first, least recently played first. If that isn't enough, the song fails with "Not enough space on this device" (`OfflineRules.noRoom`). A toast says so once, until songs are tried again: "This device is out of space for downloads: remove some in Library → Downloads". Failed songs are listed per download ("2 couldn't download"). They're tried again when the network comes back, the limit changes or a download is removed.

## 6. DJ transitions with downloads

While Transitions is DJ mix, once every download's songs are on the device, the store fetches the transitions between them (`keepNextTransition`). It works in the foreground only, one pair at a time, in Auto mode (`OfflineRules.transitionMode`).

- **Asking.** It asks as the player will, so both get the same plan and file (`transitionRequest`): no position, the two file ids, the fade (the crossfade setting, else 6 s) and whether the queue plays the album. With even volume on, it adds the gains the phone plays the two songs at, the album's gain within an album in order. `TransitionPoller` asks again until the pair is rendered: every 3 s for 5 polls, then every 10 s, giving up after 10 minutes.
- **Files.** The transition file and its MP3 continuation, if any, are fetched on the background session into `offline/transitions/`. The store first makes room for `(length + 60) × 44 100 × 4` bytes.
- **Sharing.** A pair another download already has, at the same levelling, is shared. A file goes with the last download that has it.
- **Left out.** Pairs with none to be had, too slow, out of room or failed are left out for this run (`skippedPairs`).
- **The player's pair.** The server keeps one waiting render per song, so a pair the player is asking about is left to the player (`playerPair`). The planner's `onPairChange` hook calls `DownloadStore.playerMoved()`. If the work in progress now clashes with the player's pair, it stops and is picked up later.
- **Switching modes.** Leaving DJ mix stops the work. Switching to it fetches transitions for downloads made earlier.

**Playing them.** `TransitionPlanner.kept` is set where the Player is made (`Player.init`). Before asking the server, the planner looks for a kept transition for the pair (`DownloadStore.keptTransition`):

- It's used always when offline. Online, it's used only while the mix point is more than 20 s ahead; after that, the server plans from where the song is.
- Its levelling has to match how the player plays the pair (`levelled`).
- Offline, a Party queue takes the Auto transition: a mix beats none.

The coordinator's download closure plays a kept file from `offline/transitions/`, online too. An MP3's continuation plays from there through `TrackSource.Origin.kept`.

## 7. Playing offline

"Kept" means the song's whole file is on the device (`DownloadStore.isKept`), downloaded or kept as you listen.

- **Starting a song.** Offline, if the song isn't kept, the Player jumps to the next kept song in play order (no wrapping round, `OfflinePlayback.nextKept`) with the web's toast: "Offline: skipped songs that aren't on this device". With none kept ahead, it tries the song and fails in the web's words.
- **The next song.** A song that isn't kept isn't joined as the next one. The current song ends, and the next kept one is found then.
- **A song that fails offline** skips to the next kept one in the same way.
- **Levels.** Downloads keep their songs' levels (asked once while online, 50 to a request, again after reconnecting), so their songs play levelled offline. The Player reads them into `LevelStore` when it's made (`levels.remember(downloads.keptLevels)`).

## 8. Pages offline

The query cache (`PlayarrUI/Data/QueryCache.swift`, in `queries/`) keeps the library families on disk for 7 days (`QueryKey.keptNames`: artists, artist, albums, album, favorites, playlists, playlist, mixes). A download's pages are pinned on top (`PinnedDownload.pageKeys`, applied by `pinningDownloadedPages` in `RootView` and when the session opens). Pinned pages stay on disk however old they are, and `removeExpired` leaves them alone:

| Download | Pages kept |
|---|---|
| album | `["album", id]` and `["albums", "artist"]`, the list Library → Albums opens with |
| playlist | `["playlist", id]` and `["playlists"]` |
| mix | `["mix", key]` and `["mixes"]`; the mix page reads `QueryKey.mix` |
| Favorites | `["favorites"]` |

## 9. Play reports

`PlayReportQueue` keeps reports that couldn't be sent in `pending-plays.json`, at most 300. They're sent at launch and when the network comes back (`Player.networkChanged`).

## 10. Accounts and signing out

- **One store per account.** Each account session has its own `Player` and, with it, its own `DownloadStore`. Only the active account's downloads are started. The background session is shared, and the newest store takes its events.
- **Switching away.** Jobs of an account switched away from carry on. Their files land in that account's folder by their path, and the store adopts them when that account is active again. `Player.shutDown()` doesn't stop downloads.
- **Signing out.** If the account keeps anything on the device, the account switcher asks first (`KeptForAccount`, `AccountSwitcherView`), saying how many downloads and how much space. The choices are "Sign out and remove downloads", "Sign out, keep downloads" and Cancel. Kept files stay in the folder and are taken on again if the account signs back in.
- **Removing.** Removing signs out first, then cancels the account's running jobs and deletes `stream/`, `offline/` and `offline.json` (`DownloadStore.removeEverything`).

## 11. The screens

- **Settings → Playback → On this device** (`OfflineStorageSection`) shows:
  - how many songs are kept as you listen, and their size against the limit;
  - "Plus N downloads (size), kept until you remove them.", which opens Library → Downloads;
  - the "Keep up to" picker and the "Allow downloads on mobile data" switch;
  - "Remove all", with a confirmation.

  An admin's Playback lock doesn't reach this section.
- **Library → Downloads** (`DownloadsView`): its row appears while there are downloads. It lists them newest first, each with its cover, progress, size, failures, Play and Remove (or swipe).
- **The offline mark** (`OfflineMark`) shows a song is on the device, or a ring while it downloads. It's on song rows (`SongRow`, the queue's included), the song playing at the top of the queue, and the sideways Now Playing tracklist.
