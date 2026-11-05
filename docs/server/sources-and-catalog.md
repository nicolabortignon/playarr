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

### `meta_rank`: whose metadata wins

Each row remembers how trusted its metadata is. Lower wins: Lidarr 0, a MusicBrainz match 1, folder tags 2 (`FOLDER_META_RANK`, `MATCHED_META_RANK` in `catalog/folder.ts`). An upsert only replaces `meta` when its rank is the same or more trusted (`upsert` in `catalog/store.ts`). So a folder scan never overwrites Lidarr's titles. At the same rank, the most recent sync wins, which means the source lower down in Settings.

### Merging duplicates

There's no same-file detection. Copies that land on the same song key are one song, whichever sources they come from. The song plays its **best copy** (`compareCopies` in `catalog/build.ts`): lossless first, then bit depth, sample rate and bitrate, then the higher source in Settings. Only copies on enabled sources count. The other copies still stream, so a saved queue pointing at one keeps working. If the best copy fails to play, nothing falls back to another copy. A source whose folder or host is offline keeps its copies in the catalog, and their songs fail to play until it's back.

Untagged folder files join existing rows **by name** through a name index (`CatalogStore.nameIndex`): artist by normalised name, album by artist and title, song by album and title. MusicBrainz-keyed rows are preferred. A file with no album tag or album folder goes on the album the library already has that song on (studio album first), else under its artist's "Loose songs".

### Missing songs

Songs a source reported without a file (`source_tracks`), on albums that do have playable songs, are listed greyed out on the album page:
- Lidarr reports every song of each album it has at least one file of.
- A folder reports the full track list of each release a match chose.

`totalTrackCount` gives the "3 of 12" on partial albums. An album nobody knows the length of is flagged `mayBeIncomplete` when it has a single song or gaps in its track numbers (`looksIncomplete` in `catalog/build.ts`).

### When albums were added

Lidarr copies are dated by when Lidarr imported the file. Folder copies are dated by when Playarr first found the file, kept on later scans. The exception is the library's very first music, which keeps the files' own times (birth time where the filesystem has one, else mtime), so a collection set up on day one keeps its order. An album is dated by its earliest copy, then moves forward whenever a source gets a song of it that source didn't have. A replaced or moved file never makes an album look new (`applySync`, `upsertCopy`).

## 4. Lidarr sources

`LidarrSource` (`catalog/lidarr.ts`) reads Lidarr's artists, albums, tracks and track files, four artists at a time, for artists with at least one file. When MusicBrainz has no length for a song, it asks Lidarr for the file's length once and remembers it. Lidarr's files are read through `MEDIA_SOURCE` and `PATH_MAP` (see [streaming-and-art.md](streaming-and-art.md)).

- **At most one Lidarr.** The whole server shares one `LidarrClient`, which `SourceManager.active()` points at the first enabled Lidarr source, or leaves unconfigured. A second Lidarr source is refused (409).
- **Optional.** Without one, Lidarr calls fail fast with 503, and requests and Discover are hidden (`routes/api.ts`).
- **Seeded from `.env` once.** `LIDARR_URL` and `LIDARR_API_KEY` become a Lidarr source on first start (`seedFromEnv`, flag `sources.seeded_from_env`). After that Settings owns them. A removed source isn't recreated, and the `.env` values are only logged as ignored.

## 5. Folder sources

`FolderSource` (`catalog/folderSource.ts`) walks the folder for audio files (`flac mp3 m4a m4b aac ogg oga opus wav aif aiff`). It skips hidden files and folders and doesn't follow symlinks. Tags are read with music-metadata only for files whose size or mtime changed since `folder_files` last saw them. Unreadable files are skipped. If the folder itself is missing, the sync fails, so the last scan stays rather than every song vanishing.

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
- **SSH** authenticates with the key file (a path on the Playarr server), else the password, else ssh-agent (`media/ssh.ts`). A host without GNU `find` gets "use SFTP instead".
- **SMB** goes through rclone, not a Node client: the Node SMB clients don't speak signed SMB 3. Connection settings reach rclone only through `RCLONE_SMB_*` environment variables, the password obscured the way rclone expects (`media/rclone.ts`). Paths are `/<share>/<folder>`, and browsing `/` lists the server's shares. Each share gets one `rclone serve http` (`media/rcloneServe.ts`) on a free loopback port with random credentials, read-only, its directory cache 10 s, started on first read. A full listing may take up to 30 minutes, other rclone calls 2. Without rclone (`RCLONE_PATH`), SMB is off and adding one answers 400. **NFS:** mount it on the host and use This server.

### FOLDER_ROOTS

`FOLDER_ROOTS` (`config.ts`, comma-separated absolute paths, default `/`) limits which local folders a source may use and Settings may browse (`checkFolder`, `listFolders` in `catalog/paths.ts`). The Docker image sets `/host`. Host folders are mounted under it, read-only, through `compose.override.yaml` (see `docker/compose.override.example.yaml`). A root that isn't mounted shows as empty with a hint. Remote folders aren't limited by it: there, the account's own permissions are the limit. Streaming re-checks that every folder file is inside its source's folder (`FileResolver` in `catalog/files.ts`).

## 6. Settings → Sources

Routes are in `routes/settings.ts`, and the logic is in `SourceManager` (`catalog/sources.ts`). The web panel is `apps/web/src/components/SourcesPanel.tsx`, and the iOS app has the same panel under its admin settings. Members see the list without connection settings. Changing it needs an admin, or the home network before the server is set up (`requireAdmin`; see [accounts-and-access.md](accounts-and-access.md)). Endpoints are listed in [api.md](api.md).

- **List:** sources in priority order, dragged to reorder. Each row shows its status (syncing, matching with albums left and an estimate, error, off) and its counts. For Lidarr these are complete, incomplete and unidentified albums. For folders they're songs on complete and incomplete albums, songs unidentified, and matched, not matched and left as tagged.
- **Add:** Lidarr takes a URL and API key, with Test. A folder is on This server (a folder browser inside `FOLDER_ROOTS`), over SSH or SFTP (host, port 22, user, password or key file, path), or on an SMB share (host, port 445, user, or `guest` with no password, domain, then a share and folder). A remote folder is connected to and checked before it's saved (`verify`): errors come back as 400.
- **Row actions:** Rescan; for folders, Match again and Organize files; Edit, with a "Use this source" switch to disable it; Remove.
- **Disabling** a source keeps its rows but leaves its copies out of the library.
- **Removing** a source deletes its copies, reported songs, scan cache, match decisions and move journal. Catalog rows stay, and favorites and playlists keep greyed-out entries.
- **Accounts** can be limited to some sources. Each set of sources gets its own view of the catalog, built from those copies alone (`Library.view`).

### Per-source settings and secrets

`sources.settings` holds, per kind:
- Lidarr: `url`, `apiKey`.
- Local folder: `path`.
- SSH and SFTP: `access`, `host`, `port`, `user`, `path`, `password?`, `privateKeyPath?`.
- SMB: `access`, `host`, `port`, `user`, `path`, `password?`, `domain?`.

`apiKey` and `password` are secrets (`SECRET_FIELDS`). They're stored as plain text in the database and never sent to a browser or app: the API returns the other fields, plus a `secrets` list naming which are saved. Leaving a secret empty on edit keeps the saved one, but only for the same server:
- A saved Lidarr key is only reused for the same origin. A new address needs its key.
- A saved password is only reused for the same host and user, in saves, tests and browsing.

The AcoustID key lives in `app_settings` and is only reported as set or not.
