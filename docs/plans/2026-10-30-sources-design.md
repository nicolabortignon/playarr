# Settings and catalog sources: design

Date: 2026-10-30. Status: approved design, not yet implemented.

## Goal

Add a Settings panel to Playarr. Its first subpanel, **Sources**, manages where the catalog comes from. Lidarr becomes one source among several, and a new **folder** source adds plain filesystem folders. Music from all sources merges into one library.

## Decisions

| Topic | Decision |
|---|---|
| What folders hold | All of these: music Lidarr can't know (bootlegs, mixes, local bands), an existing collection, a second drive or machine that overlaps Lidarr, and Lidarr's own folder. Overlap and messy metadata are normal. |
| Duplicates | One entry per song and album. The best copy plays; other copies are alternates. |
| Best copy | Quality first (lossless, then bit depth, then bitrate), then source order from Settings. Unreachable copies are skipped. |
| Editions | Albums merge by MusicBrainz release group. The album shows the union of tracks from all copies. |
| Metadata | Tags first. Files without MusicBrainz IDs are auto-matched (MusicBrainz lookup, then AcoustID fingerprints). Doubtful matches go to a review list. |
| Manual fixes | Stored in Playarr only. Music files are never modified; folders can be mounted read-only. |
| Organizing files (added 2026-10-30) | Opt-in per folder source: Playarr proposes moving files to `Artist/Album/NN Title.ext`, you review the list and apply all, some or none. Files only move within their own source, never into Lidarr's folders. Tags are never rewritten. |
| Scanning | Periodic scan (size + mtime, only changed files re-read) plus a Rescan button. No live watching. |
| Folder locations | The server's disk, folders on the Docker host, SSH/SFTP, and SMB/NFS shares. |
| Docker host access | One broad read-only mount (e.g. home folder or `/Volumes`) at `/host`, with a folder browser in Settings. Running natively with Node is also supported and sees the whole disk. |
| Lidarr | Optional. Requests and Discover only appear when a Lidarr source exists. |
| Loose songs | A song on several releases goes to the album its tags or folder name; otherwise the earliest official studio album, then EP, single, soundtrack/compilation. Overridable in the review list. |
| Partial albums | Shown in the Albums grid with a marker ("1 of 12"). The album page lists the full track list; missing songs are greyed out, with Request when Lidarr exists. Applies to Lidarr albums too. |
| Settings panels | Sources now. Playback, Requests and Appearance fit the same shell later. |
| Access | Until login exists, Settings is read-only for visitors outside the local network. |
| Architecture | One catalog in SQLite fed by source adapters (chosen over merging in-memory snapshots, and over handing folders to Lidarr). |

## Architecture and data model

Each source is an **adapter** that reports the files it has. The Lidarr adapter syncs from Lidarr's API; the folder adapter scans a directory. Each file is a **copy**.

New SQLite tables:

- **sources**: kind (`lidarr` or `folder`), name, position (priority), enabled, connection settings (URL, API key, path, access method, credentials), last scan time and status.
- **copies**: source, path or Lidarr track-file id, size, mtime, format, duration, raw tags, fingerprint, MusicBrainz ids (recording, release, release group, artist), disc and track numbers, match state (`lidarr`, `tagged`, `auto`, `review`, `manual`, `unmatched`), song id, missing-since.
- **songs, albums, artists**: the merged catalog. Each row has a permanent Playarr integer id and a merge key: the MusicBrainz id when known, else the fingerprint (songs) or normalized names (albums, artists).
- **fixes**: manual corrections, keyed so they survive rescans and moves (fingerprint, falling back to source + relative path).

**Merging.** Copies with the same recording id form one song. Songs group into albums by release group, which gives the union of editions. Unmatched copies merge by fingerprint, so the same rip on two drives counts once. When an unmatched song is matched later, its merge key changes but its Playarr id stays, so favorites, playlists and links keep working.

**Metadata precedence:** Lidarr, then MusicBrainz lookups, then tags, then folder and file names.

**Playback.** The best copy is chosen when the catalog is rebuilt. A song's stream URL points at that copy. If it fails when playback starts, the server falls back to the next best copy.

**In memory.** The `Library` snapshot is built from the database instead of directly from Lidarr. Its public methods stay as they are, so routes, search, playlists, covers, recommendations and Discover keep working.

**Migration.** New catalog rows take the Lidarr id (artists, albums, tracks) or Lidarr track-file id (copies) as their Playarr id when it's free. On an existing install every id stays the same, so links, saved queues and the offline song cache need no migration. Catalog rows are never deleted and ids are never reused. On first start, the `.env` Lidarr settings become a Lidarr source.

Favorites and playlists are already keyed by MusicBrainz recording id. Unmatched songs use a fingerprint-based key, so moving files doesn't orphan them.

## Scanning and matching

Scanning and matching are separate stages: music is playable after the scan and identified in the background.

**Scan.** Walk the folder for audio files and compare size and mtime with stored copies. Read tags only for new or changed files, from byte ranges at the start and end of each file, so the same code works locally and over SSH, SFTP or SMB.

**Same physical file seen twice.** When a folder source overlaps Lidarr's folder, compare mapped paths and keep only the Lidarr copy.

**Match**, album by album (files sharing a folder or album tag):

1. Tags with MusicBrainz ids (e.g. Picard) are trusted.
2. Album lookup: search MusicBrainz by artist, album and track count; score candidates by track titles and durations. Confident matches apply automatically.
3. Fingerprints: Chromaprint via ffmpeg where the files live (like song analysis today), looked up on AcoustID. Needs a free AcoustID API key, set in Settings. Only for files without MusicBrainz ids.
4. Partial or doubtful matches go to the review list. No match: stays unmatched with tag metadata.

MusicBrainz allows about one request per second, so a large collection takes an hour or more to match. Matching is a background queue with progress shown in Settings.

**Loose songs.** A song on several releases goes to the album named in its tags or folder; otherwise the earliest official studio album, then EP, single, soundtrack or compilation (the rule Discover already uses). The song's other releases are listed in its menu. Unmatched songs with no album tag are grouped under their artist as "Loose songs".

**Partial albums.** The album page shows the full track list from MusicBrainz. Owned songs play; missing ones are greyed out with their duration, plus Request when a Lidarr source exists. Playing the album plays only owned songs. The Albums grid shows every album with at least one song, with a "1 of 12" marker on partial ones.

**Artwork.** Embedded cover, then a cover image in the folder, then Cover Art Archive once matched. Folder-only artists get a Deezer picture (as Discover does) or a generated placeholder.

**Missing files.** If a source's root can't be reached, the source is offline: copies stay but are skipped for playback. If the root is reachable and files are gone, their copies are removed; songs with no copies disappear, and favorites and playlists keep greyed-out entries.

## Settings and the Sources UI

**Location.** Desktop: a gear at the bottom of the sidebar. Mobile: a gear in the Library page header. Settings has its own route with one panel per section. The offline storage control later moves from Library into Playback.

**Sources panel.** Sources listed in priority order, drag to reorder. Each row: kind icon, name, status (online, offline, scanning with progress, error), counts (songs, albums, matched, needs review), and Rescan, Edit, Disable, Remove.

**Add source.**
- *Lidarr:* URL, API key, Test.
- *Folder:* choose where it is. "This server" opens a folder browser, limited to the host mount in Docker and the whole disk when native. "SSH or SFTP" asks for host, user, password or key, then browses over that connection. "Network share" asks for server, share and credentials.

**Review list.** Grouped by album: files side by side with the best candidate (titles, durations). Accept, pick another candidate, search MusicBrainz, or leave unmatched. A matching section holds the AcoustID key.

**Removing a source** deletes its copies and keeps its fixes. Favorites and playlists keep greyed-out entries.

**Secrets.** Passwords and API keys are stored in the database and never sent back to the browser; forms show "saved" with a Replace option.

**Access.** Until login exists, Settings is read-only for visitors outside the local network.

**Network shares (risk).** Mounting SMB or NFS inside a container needs extra privileges, so Playarr would need its own client. Node's SMB libraries are immature and there is no practical pure-Node NFS client. SMB gets a userspace client only if one proves reliable; NFS is documented as "mount it on the host and use This server".

## Organizing files (opt-in)

Added after the original design, at the user's request: a folder source can have its files moved into a tidy layout. This is the one exception to "Playarr only reads folders", and it is off unless turned on for a source.

**Layout.** `Artist/Album/NN Title.ext`, with `D-NN Title.ext` on multi-disc albums. Artist is the album artist. Loose songs whose album the library knows go into that album's folder; songs with no known album go to `Artist/Title.ext`. Names are made safe for every filesystem (no `/ \ : * ? " < > |`, no trailing dots or spaces, length-limited).

**Scope.** Every file whose path doesn't match the layout gets a proposal, not only loose songs. Files never leave their source's folder: a song that belongs to a Lidarr album goes to `Artist/Album` inside the folder source, so Lidarr never finds stray files to import, rename or delete.

**Review, then apply.** Settings → Sources → (folder) → Organize shows the proposed moves as a from → to list, grouped by album, with a reason when a file is skipped. You apply all, some, or none. Nothing moves on its own.

**Safety.**
- Needs write access: Playarr checks the folder is writable before offering Organize. In Docker the folder must come from a read-write mount (the broad `/host` mount stays read-only; mount the folders you want organized separately).
- Moves are renames within the same filesystem. If a rename would cross filesystems, or the destination already exists, that file is skipped and reported, never overwritten.
- Proposals are only made for songs whose album is known: tagged with MusicBrainz ids, matched (phase 4), or confirmed in the review list. Name-only guesses are listed separately and unchecked by default.
- Cover images and other non-audio files move with their album when every audio file in their folder moves; folders left empty are removed.
- Every move is written to a journal (`file_moves`), so an apply can be undone from the same screen.
- After applying, the source is rescanned; copies keep their songs because the catalog keys songs, not paths.


## Rollout

Each phase ships on its own and leaves the app working.

1. **Catalog foundation.** New tables, the Lidarr adapter, Playarr ids, migration of links, saved queues and offline songs. No visible change; existing smoke tests pass.
2. **Settings shell and Lidarr source.** Settings route and Sources panel. Lidarr settings move from `.env` into the database. Local-network guard.
3. **Folder sources on this server.** Scanning, tags, artwork, same-file detection, loose songs, partial albums. Compose file gains the read-only host mount.
4. **Matching.** MusicBrainz album lookup, fingerprints with AcoustID, review list.
4b. **Organizing files.** Proposals, review and apply, the move journal and undo. After matching, so moves follow verified albums.
5. **SSH and SFTP folder sources.**
6. **Network shares.** SMB if a client proves reliable; NFS via host mount and docs.

## Error handling

- Lidarr unreachable: its copies stay as last synced; the source shows the error.
- Folder unreachable: source offline, copies skipped, never deleted.
- A copy fails when playback starts: fall back to the next best copy.
- MusicBrainz or AcoustID down or rate-limited: the match queue retries with backoff; music stays playable with tag metadata.
- Broken or missing tags: fall back to folder and file names; one bad file never blocks a scan.

## Testing

- Merge rules: fixtures for editions forming one album, loose songs choosing the right album, the same rip on two drives, ids stable when a song is matched later.
- Best copy: quality ranking, source order on ties, offline sources skipped.
- Scanner: small tagged audio fixtures in a temporary folder; changes, deletions, same-file detection.
- Matching: recorded MusicBrainz and AcoustID responses, no network.
- Migration: old Lidarr ids resolve to new ones.
- Smoke tests extended to cover a folder source.
