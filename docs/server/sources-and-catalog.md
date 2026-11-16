# Sources and the catalog

Playarr's library is one catalog in SQLite, fed by **sources**. A source is either a Lidarr server or a folder of music: on this server, on another machine over SSH or SFTP, or on an SMB share. Every source reports what it has. The catalog merges everything into one entry per artist, album and song, and the in-memory library is built from it.

The code lives in `apps/server/src/catalog` (adapters, store, build, folder access), `apps/server/src/library/library.ts` (the in-memory library and the refresh timer) and `apps/server/src/media` (reading bytes locally, over SSH/SFTP and through rclone). Matching untagged folder music on MusicBrainz, and moving files into tidy folders, are in [matching-and-organize.md](matching-and-organize.md).

---

## 1. Tables

All in `apps/server/src/db.ts`. Metadata is stored as JSON in `meta` columns.

| table | what it holds |
|---|---|
| `sources` | kind (`lidarr` or `folder`), name, `position` (the Settings order), `enabled`, `settings` (JSON, secrets included), `state` (Lidarr's album list), `last_sync_at`, `last_error` |
| `catalog_artists`, `catalog_albums`, `catalog_tracks` | the merged catalog. Each row has a permanent id, a unique merge `key`, `meta` and `meta_rank`. Albums also keep `added_at` |
| `copies` | one row per file: source, `source_ref` (Lidarr track-file id, or path relative to the folder), track, path, size, format, `added_at` |
| `source_tracks` | which songs each source reported in its last sync, file or not (gives the missing songs) |
| `folder_files` | the folder scan's cache: relative path, size, mtime and the tags read |
| `folder_matches`, `mb_releases` | matching results and fetched MusicBrainz releases (see [matching-and-organize.md](matching-and-organize.md)) |
| `file_moves` | the organize journal |
| `app_settings` | app-wide values: `sources.seeded_from_env`, `acoustid.key`, `requests`… |

Catalog rows (artists, albums, songs) are **never deleted**. A song nobody has a file for any more simply isn't shown. Copies are deleted when their file goes.

## 2. Ids

- **Lidarr ids are reused.** When a row is first created it takes Lidarr's id if no row has it yet: artist, album and track ids from Lidarr's, copy ids from Lidarr's track-file ids (`preferredId` in `catalog/lidarr.ts`, `freeId` in `catalog/store.ts`). On an install that started with Lidarr, every id therefore matches Lidarr's, and old links, saved queues and offline songs needed no migration. Otherwise SQLite's `AUTOINCREMENT` picks a new id.
- **Merge keys** (`catalog/keys.ts`): artists and albums are `mb:<MusicBrainz id>` when known (the album's is the *release group*, so editions merge), else `name:<normalised names>`. Loose folder songs go on a per-artist album keyed `loose:<artist key>`. A song is `<album key>#<recording id>`.
- **Recording ids** are what favorites, playlists, plays, analysis and generated mixes are keyed by:
  - Lidarr: the MusicBrainz recording id, or `track:<Lidarr track id>` when it has none.
  - Folder: the file's MusicBrainz recording tag (or a match's), else the recording of the song the catalog already has under that artist and title, else `local:<hash>`: the first 16 hex characters of the SHA-1 of the normalised "artist|title" (`catalog/folder.ts`). It stays the same when files are moved or rescanned.
- **Copy ids** are the file ids in stream URLs (`/stream/<copyId>`), queues and the offline cache. A copy keeps its id while the source reports the same `source_ref`. When Organize moves a file, its copy is updated in place, so the id survives.
- **When a song is matched**, and a file's song goes from a `local:` id to a MusicBrainz recording, `CatalogStore.applySync` moves favorites, playlist items, sound analysis (`track_features`) and plays to the new id (`moveRecording` in `catalog/store.ts`). Mix maps, hand-set cue points, loudness and lyrics are not moved: the song is analysed again under its new id. Only `local:` → MusicBrainz is followed, not one MusicBrainz id to another.

## 3. Sync

`Library.refresh()` (`library/library.ts`) syncs every enabled source, **one after the other, in Settings order**. Each adapter returns everything it has (`SourceSync`), and `CatalogStore.applySync` replaces that source's part of the catalog in one transaction:

1. Upsert artists, albums and songs by key.
2. Upsert copies; delete this source's copies it no longer reported.
3. Rewrite `source_tracks`, date albums, store Lidarr's album list in `sources.state`.

Order matters: a later folder joins its untagged files to what earlier sources have just reported.

A source that fails keeps its last sync in the catalog and gets its error in `last_error`, shown in Settings. Only if every source fails does the refresh fail as a whole.

**When it runs:**
- At startup the catalog saved by the last run is served at once (`loadStored`), then all sources are synced in the background.
- Every `LIBRARY_REFRESH_MINUTES` (default 10, `config.ts`).
- Adding or editing a source syncs everything; **Rescan** syncs just that source.
- Removing or reordering sources rebuilds from the stored catalog without syncing (`reload`).
- When matches land, `rebuildSoon` (10 s debounce) re-applies each folder's *cached* scan with the new matches, without walking the folder or asking Lidarr again.

### Refreshes that find nothing new

Most refreshes find nothing new. On a collector's library (100,000 songs), writing everything again and rebuilding the library anyway kept the server busy for seconds every ten minutes, so nothing that hasn't changed is written or rebuilt:

- **Rows are compared before they're written.** `applySync` reads what the catalog holds for the source (a whole table at once from 1,000 rows, else row by row) and writes only the artists, albums and songs whose metadata, rank, album or recording differ, and the copies whose song, path, size, format or date differ. It says whether it wrote anything.
- **A sync like the last one isn't even compared.** Every sync has a digest (`SourceSync.digest`): a SHA-1 of everything in it (`syncDigest`), or for a folder of what its catalog is made from (below). The store remembers each source's last digest and the catalog's **generation** right after applying it. The generation (`CatalogStore.generation`) goes up with every write the library is built from: catalog rows, copies, reported songs, and sources added, removed, changed or moved. The same digest on a catalog still at that generation would change nothing, so only `last_sync_at` is written. This is remembered for the server's run: after a restart, each source's first sync is compared row by row.
- **A folder whose files are as they were isn't read.** `FolderSource.sync` lists the folder, then makes its digest from the listing (each file's path, size, mtime and creation time), the source's match decisions and the releases they bring (`matchGeneration`), and the catalog's generation, since untagged files join what the catalog holds by name (`scanDigest`). When the store holds that digest, no tags are read and no catalog is made: the sync comes back `unchanged`, without its rows. If anything wrote to the catalog in between, `applySync` refuses it, the last sync stays, and the next refresh reads the folder in full.
- **Matching looks at a scan once.** The matcher hears of every scan with its digest and skips one it has looked at already, unless MusicBrainz failed for some of it.
- **The library rebuilds only when the catalog moved.** `Library.refresh` compares the catalog's generation with the one its snapshot was built from. While it's the same, the snapshot stays (only its `refreshedAt` moves), the log says "Library refreshed, nothing changed", and listeners still hear of the refresh, as they retry artwork and cover colors that failed. A rebuild from the cached scans after matches that changes nothing is dropped the same way.
- **Statements are prepared once** and kept for the store's life (`sql` in `catalog/store.ts`).

After a change, the next scan of a folder reads it in full once more, as the catalog its untagged songs join has moved; the one after is quick again. Two sources that report the same artist, album or song with different metadata at the same rank (two folders tagged differently, say) still write it on every refresh, each in turn, the lower one winning as before: a library like that rebuilds on every refresh, as it always did. `pnpm -C apps/server bench:library` measures all this on a synthetic library of 100,000 songs (`src/testing/syntheticLibrary.ts`): there, a refresh that finds nothing new takes about 75 ms for a folder and 270 ms for Lidarr, where it took 6.5 and 4.4 s.

### The library in memory

`Library` builds its snapshot from the catalog's rows (`buildCatalog`) and keeps with it what answering needs, worked out once per snapshot rather than on every request: songs by id, recording and name, artists by name, and every name search looks at, already normalized (`normalize` in `library/search.ts`), so a search over 100,000 songs reads prepared strings (about 15 ms, where normalizing every name on every search took 120). The albums in each order the lists ask for, and the artists A to Z, are sorted the first time they're asked for and kept until the next snapshot. Each account limited to some sources gets a view built the same way, once per snapshot (`Library.view`).

### `meta_rank`: whose metadata wins

Each row remembers how trusted its metadata is. Lower wins: Lidarr 0, a MusicBrainz match 1, folder tags 2 (`FOLDER_META_RANK`, `MATCHED_META_RANK` in `catalog/folder.ts`). An upsert only replaces `meta` when its rank is the same or more trusted (`upsert` in `catalog/store.ts`). So a folder scan never overwrites Lidarr's titles. At the same rank, the most recent sync wins, which means the source lower down in Settings.

### Merging duplicates

There's no same-file detection. Copies that land on the same song key are one song, whichever sources they come from. The song plays its **best copy** (`compareCopies` in `catalog/build.ts`): lossless first, then bit depth, sample rate and bitrate, then the higher source in Settings. Only copies on enabled sources count. The other copies still stream, so a saved queue pointing at one keeps working.

**When a copy can't be read**, another copy of the song stands in for it under the same address, best first (see [streaming-and-art.md](streaming-and-art.md#when-a-copy-cant-be-read)).

**A source that doesn't answer** (`SourceHealth` in `catalog/health.ts`) is found when one of its files can't be read or its sync fails. The server then asks the source itself (`FileResolver.probe`):
- a folder: its connection, then its folder there with something in it, since an unmounted disk leaves an empty folder behind;
- Lidarr: each of `PATH_MAP`'s folders through `MEDIA_SOURCE`.

A file that's gone with its source still there is the file's problem, not the source's. While a source is offline:
- it keeps its copies in the catalog;
- each song plays a copy on a source that answers where it has one, and the library and every account's view are rebuilt from the rows they have (`Library.setOffline`);
- songs it alone has stay listed, and their copies are still tried when asked for;
- an album's embedded cover still comes from its first song's usual best copy, so the album's cover doesn't change.

Offline sources are asked again every minute, and are back as soon as they answer or one of their files is read. The log says when a source goes and comes back.

Untagged folder files join existing rows **by name** through a name index (`CatalogStore.nameIndex`): artist by normalised name, album by artist and title, song by album and title. MusicBrainz-keyed rows are preferred. A file with no album tag or album folder goes on the album the library already has that song on (studio album first), else under its artist's "Loose songs".

### Missing songs

Songs a source reported without a file (`source_tracks`), on albums that do have playable songs, are listed greyed out on the album page:
- Lidarr reports every song of each album it has at least one file of.
- A folder reports the full track list of each release a match chose.

`totalTrackCount` gives the "3 of 12" on partial albums. An album nobody knows the length of is flagged `mayBeIncomplete` when it has a single song or gaps in its track numbers (`looksIncomplete` in `catalog/build.ts`).

### When albums were added

Lidarr copies are dated by when Lidarr imported the file. Folder copies are dated by when Playarr first found the file, kept on later scans. The exception is the library's very first music, which keeps the files' own times (birth time where the filesystem has one, else mtime), so a collection set up on day one keeps its order. An album is dated by its earliest copy, then moves forward whenever a source gets a song of it that source didn't have. A replaced or moved file never makes an album look new (`applySync`, `upsertCopy`).

## 4. Lidarr sources

`LidarrSource` (`catalog/lidarr.ts`) reads Lidarr's artists, albums, tracks and track files, four artists at a time, for artists with at least one file. When MusicBrainz has no length for a song, it asks Lidarr for the file's length once and remembers it from sync to sync, until the file is imported again (the adapter lasts while the source's settings do). Lidarr's files are read through `MEDIA_SOURCE` and `PATH_MAP` (see [streaming-and-art.md](streaming-and-art.md)).

- **At most one Lidarr.** The whole server shares one `LidarrClient`, which `SourceManager.active()` points at the first enabled Lidarr source, or leaves unconfigured. A second Lidarr source is refused (409).
- **Optional.** Without one, Lidarr calls fail fast with 503, and requests and Discover are hidden (`routes/api.ts`).
- **Asked twice at most.** A question (a GET) that didn't reach Lidarr, or got 502, 503 or 504 (restarting, or a proxy in front of it), is asked once more a second later; one that ran out of time isn't, nor a change (`lidarr/client.ts`).
- **Seeded from `.env` once.** `LIDARR_URL` and `LIDARR_API_KEY` become a Lidarr source on first start (`seedFromEnv`, flag `sources.seeded_from_env`). After that Settings owns them. A removed source isn't recreated, and the `.env` values are only logged as ignored.

## 5. Folder sources

`FolderSource` (`catalog/folderSource.ts`) walks the folder for audio files (`flac mp3 m4a m4b aac ogg oga opus wav aif aiff`). It skips hidden files and folders and doesn't follow symlinks. Tags are read with music-metadata only for files whose size or mtime changed since `folder_files` last saw them, and not at all when the folder is as the catalog holds it (§3). Unreadable files are skipped. If the folder itself is missing, the sync fails, so the last scan stays rather than every song vanishing.

`folderSync` (`catalog/folder.ts`) turns the files into catalog rows:
- **Tags first**, then folder and file names: `Artist/Album/01 Title.flac`. Years and `[FLAC]`-style notes are trimmed from album folder names.
- **A song on a various-artists compilation** that no match has placed is filed under its own artist, as a loose song, until it's matched.
- **A matched file** behaves like a MusicBrainz-tagged one: the match's overlay is laid over its tags (see [matching-and-organize.md](matching-and-organize.md)).

### Access: local, SSH, SFTP, SMB

Every folder operation goes through a `FolderFs` (`catalog/folderFs.ts`). `FolderAccess` (`catalog/folderAccess.ts`) creates one per source and keeps it until the source's settings change.

| access | listing | tags and streaming | analysis | fingerprints | files read at once |
|---|---|---|---|---|---|
| `local` (This server) | `readdir` walk | local files | ffmpeg here | fpcalc here, if installed | 8 |
| `ssh` | GNU `find -printf` over one connection | byte ranges (`tail \| head`) | ffmpeg on the host | fpcalc on the host | 3 (sshd allows ~10 channels) |
| `sftp` | SFTP `readdir` | SFTP reads | none | none | 6 |
| `smb` | `rclone lsjson` | `rclone serve http` on 127.0.0.1 | ffmpeg here, reading the loopback URL | fpcalc here, same | 4 |

- **Remote tags** are read from byte ranges in chunks of at least 64 KB (`readTagsFrom` in `catalog/tags.ts`).
- **SSH** authenticates with the key file (a path on the Playarr server), else the password, else ssh-agent (`media/ssh.ts`). A host without GNU `find` gets "use SFTP instead". A sync that can't reach the host or log in says so (`SshConnectError`), not "Folder not found". A command the host hasn't started within 20 s, or that goes 60 s without a word, is stopped and fails, and so is one whose answer passes 64 MB (a listing may hold 256 MB; a decode, 96 MB, as this server's own ffmpeg may): a host gone bad fails the sync rather than holding it for good.
- **Host keys.** SSH and SFTP trust a host's key on first use (`hostVerifier` in `media/ssh.ts`). The first time Playarr connects, the key's SHA-256 fingerprint in OpenSSH's form (`SHA256:…`) and its type go into the source's settings as `hostKey`: when an admin adds or saves the source (`verify`), or, for a source saved before keys were checked, on its next connection (`FolderAccess`). After that, a host showing another key is refused during the key exchange, before any password or key is sent, and the sync error names both fingerprints and how to trust the new key. Connections ask for the trusted key's type first, so a host that has added a key of another type still shows the trusted one. `MEDIA_SOURCE=ssh` or `sftp` (Lidarr's files, set in `.env`) keeps to the first key it sees until Playarr restarts.
- **Trusting a new key** is saving the source in Settings → Sources: `verify` records the key the host shows then. A saved password never goes to a host whose key changed: the save answers 400 until the password is typed again, so a save made for another reason (a new name) can't hand it to an impostor. With a key file there's nothing to type again. Browsing never trusts a new key. The edit form shows the trusted key as `ssh-keygen -l` prints it (`SHA256:… (ED25519)`), to compare with the machine's own.
- **SMB** goes through rclone, not a Node client: the Node SMB clients don't speak signed SMB 3. Connection settings reach rclone only through `RCLONE_SMB_*` environment variables, the password obscured the way rclone expects (`media/rclone.ts`). Paths are `/<share>/<folder>`, and browsing `/` lists the server's shares. Each share gets one `rclone serve http` (`media/rcloneServe.ts`) on a free loopback port with random credentials, read-only, its directory cache 10 s, started on first read. A full listing may take up to 30 minutes, other rclone calls 2. Without rclone (`RCLONE_PATH`), SMB is off and adding one answers 400. **NFS:** mount it on the host and use This server.

### FOLDER_ROOTS

`FOLDER_ROOTS` (`config.ts`, comma-separated absolute paths, default `/`) limits which local folders a source may use and Settings may browse (`checkFolder`, `listFolders` in `catalog/paths.ts`). The Docker image sets `/host`. Host folders are mounted under it, read-only, through `compose.override.yaml` (see `docker/compose.override.example.yaml`). A root that isn't mounted shows as empty with a hint. Remote folders aren't limited by it: there, the account's own permissions are the limit. Streaming re-checks that every folder file is inside its source's folder (`FileResolver` in `catalog/files.ts`).

## 6. Settings → Sources

Routes are in `routes/settings.ts`, and the logic is in `SourceManager` (`catalog/sources.ts`). The web panel is `apps/web/src/components/SourcesPanel.tsx`, and the iOS app has the same panel under its admin settings. Members see the list without connection settings. Changing it needs an admin, or the home network before the server is set up (`requireAdmin`; see [accounts-and-access.md](accounts-and-access.md)). Endpoints are listed in [api.md](api.md).

- **List:** sources in priority order, dragged to reorder. Each row shows its status (syncing, matching with albums left and an estimate, error, off) and its counts. For Lidarr these are complete, incomplete and unidentified albums. For folders they're songs on complete and incomplete albums, songs unidentified, and matched, not matched and left as tagged.
- **Add:** Lidarr takes a URL and API key, with Test. A folder is on This server (a folder browser inside `FOLDER_ROOTS`), over SSH or SFTP (host, port 22, user, password or key file, path), or on an SMB share (host, port 445, user, or `guest` with no password, domain, then a share and folder). A remote folder is connected to and checked before it's saved (`verify`), and an SSH or SFTP host's key recorded: errors come back as 400.
- **Row actions:** Rescan; for folders, Match again and Organize files; Edit, with a "Use this source" switch to disable it; Remove.
- **Disabling** a source keeps its rows but leaves its copies out of the library.
- **Removing** a source deletes its copies, reported songs, scan cache, match decisions and move journal. Catalog rows stay, and favorites and playlists keep greyed-out entries.
- **Accounts** can be limited to some sources. Each set of sources gets its own view of the catalog, built from those copies alone (`Library.view`).

### Per-source settings and secrets

`sources.settings` holds, per kind:
- Lidarr: `url`, `apiKey`.
- Local folder: `path`.
- SSH and SFTP: `access`, `host`, `port`, `user`, `path`, `password?`, `privateKeyPath?`, `hostKey?` (`type` and `fingerprint`, see Host keys above; kept while the host and port stay the same).
- SMB: `access`, `host`, `port`, `user`, `path`, `password?`, `domain?`.

`apiKey` and `password` are secrets (`SECRET_FIELDS`). They're stored as plain text in the database and never sent to a browser or app: the API returns the other fields, plus a `secrets` list naming which are saved. Leaving a secret empty on edit keeps the saved one, but only for the same server:
- A saved Lidarr key is only reused for the same origin. A new address needs its key.
- A saved password is only reused for the same host, port and user, in saves, checks before saving and browsing (`fromSaved` in `catalog/sources.ts`). For another one, the request answers 400, "Enter the password again for the new address" (or "…for the new user"), before connecting anywhere. Settings that log in without a password (a key file, SMB's `guest`) drop the saved one instead.

The AcoustID key lives in `app_settings` and is only reported as set or not.
