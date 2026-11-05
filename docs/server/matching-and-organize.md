# Matching folder music and organizing files

Folder sources often hold music without MusicBrainz tags: rips, downloads, old collections. **Matching** identifies it on MusicBrainz, so it merges with the rest of the library, gets full track lists and keeps its favorites. **Organizing** optionally moves a folder's files into a tidy `Artist/Album/NN Title.ext` layout.

Matching never touches files. Organizing is the one place Playarr writes to a folder, and only when asked. How folders are scanned and merged into the catalog is in [sources-and-catalog.md](sources-and-catalog.md).

The code: `apps/server/src/catalog/matcher.ts` (the queue and the decisions), `match.ts` (release scoring), `songMatch.ts` (one song at a time), `acoustid.ts` (fingerprints), `mbRelease.ts`, `organize.ts` (planning moves) and `organizer.ts` (applying them), and `apps/server/src/discover/musicbrainz.ts` (the MusicBrainz client).

---

## 1. Matches are overlays

A match is stored per file in `folder_matches`, keyed by source and relative path. It holds a state and an **overlay**: the MusicBrainz ids, titles, album, artist and positions the file *should* have had in its tags. When the folder's catalog is built, `FolderSource` lays the overlay of each `auto` or `manual` match over the file's own tags. After that the file goes through the same `folderSync` as a Picard-tagged file (`catalog/folderSource.ts`).

A few consequences:
- When a match names a release (`releaseId`), its cached track list in `mb_releases` brings the album's other songs as missing songs, and its title, type and date at `meta_rank` 1. Tags are rank 2 and Lidarr is rank 0.
- When a song from a various-artists compilation is matched to its own album, the compilation's track total and year are dropped, so the album doesn't read "1 of 100".
- When a song's id goes from `local:…` to a MusicBrainz recording, its favorites, playlist entries, analysis and plays follow it (see [sources-and-catalog.md](sources-and-catalog.md#2-ids)).

Matching changes no scan data. After a batch of matches the library is rebuilt from the last scan (`Library.rebuildSoon`, 10 s debounce), not rescanned.

## 2. What gets matched

After every scan of a folder source, `FolderSource` hands it to the `Matcher`. The Matcher works through one source at a time and one **album group** at a time (`groupFiles` in `matcher.ts`).

- **Grouping.** Files are grouped by artist and album tag (`<artist>|<album>`). Without an album, they're grouped by their folder (`dir:<folder>`).
- **Compilations.** A group whose album artist is "Various Artists", or whose songs have more than one lead artist, is a compilation. It's split so each song is a group of its own, matched and reviewed on its own.
- **Skipped:** files whose tags already carry a recording and a release group id (trusted as they are), and files with a `manual` or `ignored` decision.
- **Matched again:** files that are new, whose size or mtime changed, or that are still waiting for review under a group key that no longer exists.

Every 10 groups, and at the end, the library is rebuilt so matches show up as they land.

## 3. How a group is matched

`Matcher.matchGroup` tries these in order and stops at the first that answers:

1. **Release search.** This step is for albums that aren't compilations. It searches MusicBrainz releases by artist and album, keeping hits scoring at least 70 (`SEARCH_MIN_SCORE`), and fetches and scores the best 3 (`CANDIDATES`). If nothing comes back, it looks up the artist by name (score ≥ 90) and searches that artist's releases, for artists who go by another name on MusicBrainz. An `auto` verdict is applied at once.
2. **Compilations: song by song** (see below).
3. **Fingerprints** (not compilations): AcoustID, see below.
4. **No release came close (`unmatched`): song by song.** The songs may be on other albums MusicBrainz knows.
5. **A `review` verdict** keeps the top 3 candidates and the best score, and waits in the review list.
6. **Otherwise `unmatched`**, also in the review list, as "nothing found".

### Scoring a release (`match.ts`)

Each file is paired with at most one track, best pairs first. A pair scores:

- **0.6 × title similarity.** Levenshtein on normalised titles, ignoring notes like "(2019 Remaster)", "(Album Version)" or "(Bonus Track)".
- **0.3 × duration closeness.** 1 within 3 s, falling to 0 at 15 s, and 0.5 when either length is unknown.
- **0.1 × position.** 1 when disc and track number agree.

The release's score is the mean over all the group's files. When there are more files than tracks, it's multiplied by tracks ÷ files.

| verdict | rule (`AUTO_SCORE`, `MIN_FILE_SCORE`, `REVIEW_SCORE`) |
|---|---|
| `auto` | score ≥ **0.85** and every paired file ≥ **0.6** |
| `review` | score ≥ **0.5** |
| `unmatched` | below that, or no candidates |

An `auto` or `manual` match from a release sets each paired file's recording, title, track and disc number, plus the release group, album artist, year and `releaseId`. A file left unpaired becomes `unmatched` in an automatic match, and `ignored` when the user picked the release.

### Song by song (`songMatch.ts`)

Each file's recording is searched by artist and title, with notes like "feat." and "(Radio Edit)" stripped (`bareTitle`), first within ±5 s of the file's length (`CLOSE_LENGTH_S`). A hit needs title and artist similarity of at least 0.8, an official release, and not a various-artists one. Among the hits, the most "original" release group wins (`releaseGroupRank`: studio album, EP, soundtrack, single, compilation, other, live), then the earliest.

If the close search finds no studio album, EP or soundtrack, a second search without a length allows up to 90 s off (`WIDE_LENGTH_S`). That's how a radio edit still finds its album. For a compilation's song, the last resort is its fingerprint, skipping compilation and various-artists albums.

A compilation keeps every song found. Other folders keep the result only when at least half their songs were found, since the rest is probably an album MusicBrainz lacks, better reviewed whole. Song-by-song matches name a release group, not a release, so they bring no track list.

### Fingerprints (`acoustid.ts`)

Fingerprints run only with an AcoustID key saved (Settings → Sources → matching, stored in `app_settings` as `acoustid.key`) and a source that can compute them:
- local folders and SMB shares: if `fpcalc` (`FPCALC_PATH`) runs on this server;
- SSH folders: on their own host;
- SFTP folders: never.

`fpcalc` runs at low priority with a 60 s timeout. AcoustID lookups are spaced at least 350 ms apart (about 3 a second), with a 15 s timeout.

A result counts at a score of **0.8** or more (`FINGERPRINT_MIN_SCORE`). It is filed under the recording's most original release group: studio album, EP, single, then anything with secondary types, then live. If fewer than half a group's files are recognised, the group is left to the next step.

## 4. States and the review list

| state | meaning | shown in Settings as |
|---|---|---|
| *(no row)*, fully tagged | the file's own tags carry MusicBrainz ids | matched |
| `auto` | matched automatically | matched |
| `manual` | the user picked a release, or gave names | matched |
| `review` | candidates found, none sure enough | not matched |
| `unmatched` | nothing found | not matched |
| `ignored` | left as its tags describe it, never matched again | left as tagged |

`manual` and `ignored` are user decisions. Automatic matching never overrides them, even when the file changes. They're the "fixes" the original design had a separate table for.

The review list (`Matcher.reviewGroups`, `GET`/`POST /api/settings/sources/:id/review`, web `ReviewDialog.tsx`) shows each waiting album with its files and candidates side by side. Albums with candidates come first. Each candidate shows its score, track list, which file pairs with which track, and edition details (country, label, format, barcode). Those details are fetched in the background for the album on screen and the next one. The actions:

- **Use this album:** apply that release as `manual`.
- **Search** with other artist and album names: replaces the candidates, still `review`.
- **Fix names:** the user's own artist, album and song titles, saved as a `manual` overlay with no MusicBrainz ids.
- **Leave unmatched:** `ignored`.

## 5. Re-matching

- **Automatically:** after each scan, for new and changed files (section 2).
- **Match again** on a folder source (`POST /api/settings/sources/:id/rematch`): forgets every automatic result for the source, keeping `manual` and `ignored`, and queues it.
- **Show metadata → Match again** on a song (`POST /api/files/:fileId/rematch`, `routes/metadata.ts`): for a folder file, forgets the decisions of that file's whole album group, the user's own included, regroups from the tags, matches it at once and rebuilds before answering. For a Lidarr song, asks Lidarr to refresh the artist from MusicBrainz and picks the changes up a minute later.
- **Failed lookups** (MusicBrainz unreachable, or still refusing after its back-offs) leave those files without a row. The source is queued again up to 6 times, 5 minutes apart (`RETRY_TIMES`, `RETRY_AFTER_MS`), without a rescan.

## 6. The MusicBrainz queue

`MusicBrainz` (`discover/musicbrainz.ts`) is one client for the whole server, shared by matching and Discover:

- **Pace:** requests go through one queue, at least **1.1 s apart** (`MIN_INTERVAL_MS`). MusicBrainz allows about one per second.
- **Identity:** requests carry the user agent `Playarr/0.1.0 ( <MUSICBRAINZ_CONTACT> )`.
- **Caching:** responses are cached for 30 minutes (up to 500 entries). Fetched releases are kept for good in `mb_releases`.
- **Background work:** matching's requests are marked as background. They're counted apart in `status()`, so Discover can say why a search waits. On a 503 or a network error, background requests back off 2, 5, 10, then 20 s; a search someone is waiting on retries once after 2 s.

Each album takes a few lookups. Settings estimates about 3.3 s per album still to match. A big first scan takes hours, and Discover searches queue behind it.

---

## 7. Organizing files

Organizing is opt-in and works per folder source: Settings → Sources → (folder) → Organize files (`OrganizeDialog.tsx`). The server proposes moves, you choose which to make, and every applied batch can be undone. Tags are never rewritten.

### Layout (`organize.ts`)

- `Artist/Album/NN Title.ext`, with `D-NN Title.ext` when the album has more than one disc. Without a track number it's `Title.ext`.
- A song with no known album (a loose song) goes to `Artist/Title.ext`.
- The artist is the **album's** artist in the merged catalog. The album, title and numbers come from the catalog too, so matched and Lidarr metadata win over the file's tags.
- The extension is lower-cased.

Names are made safe (`safeSegment`):
- `/ \ : * ? " < > |` and control characters become `_`;
- whitespace is collapsed, and leading and trailing dots and spaces are dropped;
- each segment is at most 120 characters, and an empty one becomes `Unknown`.

### The plan

`Organizer.plan` lists a move for every audio file not already where the layout puts it.

- **Confident or guess.** A move is *confident* when the song has a MusicBrainz recording id (not `local:`) and its album a MusicBrainz key. Confident moves start checked. Guesses are labelled and start unchecked.
- **Order.** Confident files claim their targets first, then the rest in path order.
- **Skipped** with a reason: when another file is going to the same place, or a file is already there. Comparisons ignore case, so a case-only rename is allowed and nothing lands on a file already in place.
- **Server decides.** The client sends only which files to move, by current path, at most 10 000 (`routes/settings.ts`). The server recomputes the plan and applies those entries.

### Safety (`organizer.ts`)

- **Local folders only.** For SSH, SFTP and SMB folders the plan says "Organizing works for folders on this server only", and apply and undo answer 409.
- **Writable.** The folder must be writable (`access(W_OK)`). In Docker the `/host` mount is read-only, so a folder to organize needs its own read-write mount (`docker/compose.override.example.yaml`).
- **Never during a scan.** Apply and undo are refused (409) while a scan is running, since the scan is writing the file list.
- **Never outside the folder.** Both paths must be inside the source's folder, and their real parent folders inside its real path, so a symlinked folder can't lead out.
- **Never overwrite.** An existing target skips the file, unless it's the same file on a case-insensitive disk.
- **Rename only.** A failed rename is skipped and reported ("On a different drive" for `EXDEV`, "Not allowed to move it"). Nothing is copied and then deleted.
- **Companions.** When all of a folder's audio moved to one folder and none is left behind, `jpg jpeg png webp gif cue log nfo txt m3u m3u8` files there follow it, unless their name is taken.
- **Tidying up.** Folders left empty are removed, up to but not including the source's folder.

### Journal and undo

Every move, companions included, is written to `file_moves` with its batch number. The plan reports the newest batch with moves left to undo, and **Undo** reverses that batch newest move first. It applies the same safety rules: a file no longer at its new place, or whose old place is taken, is skipped and reported. Removing the source deletes its journal.

### The catalog follows

After each move, `CatalogStore.renameFolderFile` updates the copy's path and `source_ref`, the tag cache row and the match row in place. Copy ids, saved queues, offline songs, favorites and match decisions survive, and the library is reloaded without a rescan.
