# Discover, requests and recommendations

This is how Playarr looks beyond the library: searching for music you don't have, asking Lidarr to fetch it, listing an artist's missing albums, and suggesting songs for a playlist. The code lives in `apps/server/src/discover` (search, MusicBrainz, ListenBrainz, requests, recommendations), `apps/server/src/lidarr/client.ts`, and the routes in `apps/server/src/routes/discover.ts` and `apps/server/src/routes/playlists.ts`.

No source needs a key except Lidarr. Deezer, MusicBrainz and ListenBrainz are public APIs, called from the server only. For the full route list see [api.md](api.md); for who may request albums see [accounts-and-access.md](accounts-and-access.md).

---

## 1. Where each answer comes from

| Need | Source | Why |
|---|---|---|
| Songs ("bohemian rhapsody") | Deezer's public search (`discover/deezer.ts`) | Ranked by popularity, so it finds Queen rather than a cover. MusicBrainz has no popularity, and Lidarr has no song search |
| Artists and albums | Lidarr's `/api/v1/search`; without Lidarr, MusicBrainz's artist and release-group search | Results carry MusicBrainz ids and are ready to add; Lidarr's search is MusicBrainz's data, ranked |
| An artist's discography | MusicBrainz release-group browse (`discover/musicbrainz.ts`) | Complete, and every Lidarr album *is* a MusicBrainz release group (`foreignAlbumId`) |
| Similar artists and songs | ListenBrainz labs API (`discover/listenbrainz.ts`) | Built from real listening sessions, keyed by MusicBrainz ids |

MusicBrainz allows about one request a second, so `MusicBrainz` sends everything through one queue, at least 1.1 s apart, with a descriptive User-Agent. Answers are cached for 30 minutes (500 entries). A 503 or network error is retried once after 2 s for a lookup someone is waiting on, and with longer back-offs (2, 5, 10, 20 s) for background work. `GET /api/musicbrainz/status` reports the length of the queue, so the apps can explain a slow lookup.

Deezer answers are cached for 30 minutes. Every upstream call has a timeout, and the discover routes abort their upstream work when the client hangs up (a newer query was typed).

## 2. Search (`GET /api/discover/search?q=`)

`Discover.search` (`discover/discover.ts`) needs at least two characters. It asks Lidarr and Deezer (40 songs) at the same time; either may fail and the other's results still come back. Without a Lidarr source, MusicBrainz finds the artists and albums instead (`searchMusicBrainz`): artists by name or alias, kept when the query names them; then, for an artist whose whole name is in the query ("radiohead", "teardrop massive attack"), their official albums and EPs, newest first, and for any other query albums and EPs with an official release whose title or artist matches (`MusicBrainz.searchAlbums`). Both go through the same `rankAlbums` as Lidarr's hits. That's two MusicBrainz requests, about a second apart.

**Songs.** When the query names an artist plus a title ("teardrop massive attack"), Deezer's free-text ranking favours remixes that contain every word. So when a result's artist name is part of the query, that artist's top 50 tracks are also fetched, and those whose titles match the rest of the query go first. `rankTracks` then scores every song:

- popularity, `10 × log10(rank + 10)`;
- title match: 40 for an exact match (with or without the artist's name), 22 if the query contains the title, 10 if the title contains the query;
- +30 when the query contains the artist's name;
- −18 for a version (remix, live, edit, dub, acoustic…) in the title's version, and −6 for one in the album title, unless the query asks for a version.

Duplicates (same title and artist) keep their best score, and the top 10 are shown.

**Artists.** Lidarr matches loosely, so only artists whose name is in the query (or the reverse) are kept. If the best songs' artist is named in the query but Lidarr didn't return them, they're looked up by name and put first. An exact name match sorts to the top; six are shown.

**Albums.** `rankAlbums` scores Lidarr's album hits by the same title and artist match, +10 for a studio album and +4 for an EP, −10 for live, compilation, remix and similar secondary types, −15 for a version word in the title, −12 for Various Artists, and a small penalty for Lidarr's own order. Twelve are shown.

Album ids are not resolved per search result: a Deezer song only knows its artist's and album's names, and the album is found on MusicBrainz when it's requested (section 4). This keeps search fast.

## 3. Already own it? Artist and album links

Every album and song result carries an `availability`, from `Requests.availability` (by release-group id) or `availabilityByName` (artist and album title). Names are compared with `albumKey` (`library/search.ts`): accents, case and punctuation ignored, and edition suffixes stripped by `baseTitle`, so "Mezzanine (Deluxe)" and "Mezzanine - 2005 Remaster" both match "Mezzanine". The states are `available`, `partial` (some of its songs are here), one of the request states (section 5), or `none`. It's answered from the library snapshot, so it's instant.

Links follow what is known (`apps/web/src/lib/links.ts`):

- Library songs link straight to their artist and album pages.
- Deezer songs only know names. Search attaches a MusicBrainz artist id when it already has one (the library, or an artist elsewhere in the same results); otherwise the link is `/discover/artist?name=`.
- That page calls `GET /api/discover/artist-lookup?name=`, which resolves the name with `Discover.findArtist`: the library first, then an exact name in Lidarr's search, then MusicBrainz (artist name or alias; an exact name, else a score of at least 95). It answers `{ mbid, artistId? }`, or 404, and the page forwards to the library artist or the discover artist page.
- An album not in the library opens the artist's discography with `?album=`, which scrolls to it and highlights it. Titles are compared loosely (`titleKey`), so "(Deluxe Edition)" still matches. Singles and compilations aren't listed there, and the page says so.

## 4. Artist pages and discographies

`GET /api/discover/artists/:mbid` (`Discover.artist`) asks Lidarr's artist lookup and MusicBrainz's release-group browse (`type=album|ep`, up to 100) together. It keeps release groups whose primary type is Album or EP and drops those with a secondary type of Live, Compilation, Remix, DJ-mix, Mixtape/Street, Demo, Interview, Spokenword, Audiobook, Audio drama or Field recording, so soundtracks stay. Newest first, each with its availability. If MusicBrainz fails the page still shows Lidarr's artist, with `discographyError`.

**Missing albums.** A library artist's page shows, below its own albums, the albums and EPs from that discography that aren't in the library at all, each with Request (`NotInLibrary` in `apps/web/src/pages/Artist.tsx`). The browse asks for each group's artist credits (`inc=artist-credits`) and only for groups with an official release (`release-group-status=website-default`, as MusicBrainz's own pages list them), so bootlegs stay out; without Lidarr, the page's name is the credit carrying the artist's own id. Albums partly in the library stay in the sections above, with their own Request for the rest.

**Similar artists.** `GET /api/discover/artists/:mbid/similar` returns up to 24 artists from ListenBrainz's labs `similar-artists`, cached 6 h. Library artists carry their Playarr id and photo; the others get a Deezer photo for that exact name, where Deezer has a real one.

## 5. Requests through Lidarr

`POST /api/requests` takes `{ mbid }` (a release group), `{ releaseMbid, artistName, albumTitle }` (a specific release, from recommendations), or `{ artistName, albumTitle }` (a Deezer song's album). `Requests.request` (`discover/requests.ts`):

1. **Checks.** No Lidarr source: **409** ("Requests need a Lidarr source"). Requests turned off in Settings: **403**. An account without the request right: 403 from `requireCanRequest`.
2. **Finds the release group.** By mbid, Lidarr's `album/lookup?term=lidarr:<mbid>`. By release, MusicBrainz's release → release group, falling back to the name. By name, a MusicBrainz release-group search (title and artist, edition suffixes stripped), preferring the studio album, then EP, soundtrack, single, compilation, live (`releaseGroupRank`). If that finds nothing, the artist is searched by name or alias (score ≥ 90) and the album looked for in their discography, which handles files that call an artist by another name ("N Sync" for *NSYNC). Lidarr's name search is the last resort. MusicBrainz down and nothing found: 503.
3. **Refuses an album already complete in the library** (409). One only partly here can be requested for the rest.
4. **Wants it in Lidarr.** If Lidarr already has the album (part of a known artist's discography), `PUT /album/monitor`. Otherwise `POST /api/v1/album`, monitored, any release OK, with Lidarr's own search off so Playarr can track the command. A new artist is added with `monitor: none` and `monitorNewItems: none`, so only the requested album is wanted. Lidarr records albums added this way as manually added (`AddType.Manual`), which its refresh never deletes, so singles and soundtracks outside the metadata profile are safe.
5. **Searches.** `AlbumSearch` is sent when "Search right away" is on, or when the album was requested before ("Search again", "Retry" always search). Otherwise the answer is "Added to Lidarr; it will search on its schedule".

Requests are kept in the database (`album_requests`; a `requests.json` left in the cache folder by older versions is imported once and renamed `requests.json.imported`). Each stores the account that asked first, the release group, the Lidarr album id, the search command id, and the album's key both as Lidarr names it and as the requester did, so a Deezer title still finds it. `GET /api/requests` lists them, newest first, with progress; `DELETE /api/requests/:mbid` forgets one (Lidarr keeps the album).

**Progress** combines three Lidarr answers, fetched together and cached for 15 s (the queue can be megabytes): the command's status, `/queue` (up to 500 items), and the album's statistics.

| State | When |
|---|---|
| `available` | the library has the album (for a partial album, once Lidarr has every track it knows of) |
| `importing` | Lidarr has files the library hasn't, or a queue item is importing |
| `downloading` | in the queue, with progress from size left; a queue warning or error is the message |
| `searching` | the search command is queued or running |
| `failed` | the album left Lidarr, the download failed, or the search failed |
| `waiting` | nothing yet: "No release found yet. Lidarr will keep looking", or not monitored |

When Lidarr's file count for a request grows, the library refreshes, once each time more files land.

**Settings → Requests** (`GET/PUT /api/settings/requests`, admins, `routes/settings.ts`) is stored as one JSON app setting and read on every request, so changes apply at once:

- **Allow requests** (`enabled`, default on). Off, `POST /api/requests` answers 403, and `/api/health` reports `requests: false` so the apps hide Request buttons. The flag is also false without Lidarr or for an account without the right.
- **Search right away** (`searchOnAdd`, default on).
- **Root folder, quality profile, metadata profile** for new artists. Each falls back to `.env` (`LIDARR_ROOT_FOLDER`, `LIDARR_QUALITY_PROFILE_ID`, `LIDARR_METADATA_PROFILE_ID`), then the root folder's defaults; a chosen root folder Lidarr no longer has is skipped. Saving `null` clears a choice. The panel lists Lidarr's options with a 5 s timeout.

## 6. "Songs like these": playlist recommendations

`GET /api/playlists/:id/recommendations?variant=` (`discover/recommendations.ts`) suggests up to 10 songs you own (Add) and 20 you don't (Request).

1. **Seeds.** Up to 10 of the playlist's songs: evenly spread for `variant=0`; for "New mix", a seeded shuffle of up to 70% of the songs. Folder songs without a MusicBrainz id are looked up by lead artist and title (score ≥ 90, remembered).
2. **Similar recordings.** One labs `similar-recordings` call per seed, in parallel (the API takes one seed per call), each cached for 1 h. The dataset is `session_based_days_7500_…`; the older `days_9000` one stopped updating. If every call fails the route answers 502.
3. **Scoring.** Each seed's scores are divided by its own best, then summed, so songs similar to several playlist songs rise. A song's "Similar to …" names the seed it's closest to. Songs already in the playlist (by id or by lead artist and title) are dropped. A variant multiplies each score by a random 0.5–1.5, so a refresh doesn't always return the same winners.
4. **Owned or missing.** Owned means the recording id is in the account's library, else artist and title match. Per lead artist (the name before "feat.", "&" or a comma) at most 3 owned and 2 missing songs. Missing songs without a release name are skipped.
5. **Filling in ids.** One batch call to ListenBrainz's `metadata/recording` adds what similar-recordings leaves out: the lead artist's MusicBrainz id (for links) and the release group, so Request goes straight to Lidarr. Cached 1 h; if it fails, a request falls back to the release id (mapped through MusicBrainz), then the name (section 5).

Covers come from the Cover Art Archive through Lidarr's image CDN. The pooled result itself isn't cached on the server, only the ListenBrainz answers; the web app keeps it for 10 minutes.

## 7. Remote artwork (`/art/remote`)

Artwork for music outside the library goes through `/art/remote?url=` (`routes/art.ts`, `discover/art.ts`), resized to WebP and cached on disk. Only HTTPS URLs on these hosts are fetched: `images.lidarr.audio`, `coverartarchive.org`, `*.archive.org`, `assets.fanart.tv` and `*.dzcdn.net` (Deezer). Redirects are followed by hand, at most five, and every hop is checked against the list; a non-image answer is refused. Release-group covers use Lidarr's image CDN (`images.lidarr.audio/cache/https://coverartarchive.org/...`), one hop instead of the Cover Art Archive's two redirects. The rest of Playarr's artwork is in [streaming-and-art.md](streaming-and-art.md).

---

See also: [../architecture.md](../architecture.md), [playlist-covers.md](playlist-covers.md), [../mixes.md](../mixes.md) (radio and mixes), and [../decisions.md](../decisions.md) for why Deezer, ListenBrainz and Lidarr were chosen.
