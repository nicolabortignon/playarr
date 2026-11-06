# Streaming and artwork

How the server sends songs, transition files, pictures and lyrics to the players. The code lives in `apps/server/src/routes/stream.ts`, `routes/levels.ts`, `routes/transitions.ts`, `routes/art.ts` and `routes/lyrics.ts`, with `media/levelled.ts` (WAV streams), `analysis/loudness.ts` (loudness), `catalog/files.ts` (where a file's bytes are), `catalog/build.ts` and `catalog/folderArt.ts` (which picture an album gets), `library/coverColors.ts` and `library/coverColorStore.ts` (covers' colors), `discover/art.ts` (remote images) and `lyrics/lyrics.ts`.

Every route here answers only for songs the account may hear, through its view of the catalog ([accounts-and-access.md](accounts-and-access.md#each-accounts-catalog)). None of them needs Playarr's own header (an `<audio>` or `<img>` element can't send one); once the server is set up, they need a session like every other route.

---

## 1. Songs: `/stream/:fileId`

`GET` and `HEAD /stream/:fileId` send the file as it is, with HTTP byte ranges so players can seek.

- **Ranges.** One parser, `parseRange` in `packages/shared/src/range.ts`, serves the server and the web's service worker, so a song kept on the device answers exactly like a streamed one. It reads a single `bytes=` range (`start-end`, `start-` or the suffix form `-n`); with several ranges, only the first counts. A satisfiable range gets 206 with `Content-Range`; an unsatisfiable one 416 with `Content-Range: bytes */<size>`; no range, the whole file.
- **Caching.** `ETag` from the file's size and modification time (304 on `If-None-Match`), `Cache-Control: private, max-age=86400`, and a `Content-Type` from the file's extension.
- **Reading stops** as soon as the player drops the connection (a seek or skip), so nothing keeps reading from disk or SSH.

### What `/stream` will read

The client never sends a path, only a file id:

1. The id must be a file in the account's view of the catalog (404 otherwise).
2. `FileResolver.resolve` finds where its bytes are. A folder source's file must lie inside that source's folder (403 otherwise) and is read through that source's filesystem (this server, SSH, SFTP or an SMB share). A Lidarr file's path goes through `PATH_MAP`, and must then lie inside one of `PATH_MAP`'s target folders (403 otherwise), read through `MEDIA_SOURCE`. With an empty `PATH_MAP` there's no root to check against.
3. A source that's unreachable answers 503; a file that can't be read, 502.

How sources and files are set up is in [sources-and-catalog.md](sources-and-catalog.md).

### Lossless WAV: `/stream/:fileId/lossless.wav`

Chrome and Firefox can't play Apple Lossless or AIFF (`wavFallbackOf` in `packages/shared/src/playable.ts`). For those files the server also offers the song as a WAV at its own sample rate, mono or stereo, 16-bit or 24-bit (above 16 bits), so it stays lossless. The web player asks for it only where the browser can't play the original (`apps/web/src/lib/playable.ts`). It has its own address so a copy of the original kept on the device never stands in for it. The file's exact length comes from its header (`pcmLengthFrom` in `catalog/tags.ts`, remembered for the last 2000 files); other formats answer 404.

---

## 2. Even volume: levelled streams

Settings → Playback → Even out the volume. iPhones ignore an audio element's volume, so the levelling is done in the audio itself.

### Loudness analysis

`analysis/loudness.ts` and `analysis/loudnessJobs.ts` measure each song's integrated loudness by ITU-R BS.1770-4 (EBU R128) and its peak, from one decode of the whole file in stereo at 44.1 kHz (`LOUDNESS_RATE`): K-weighting, 400 ms blocks every 100 ms, gated at −70 LUFS and then 10 LU below the rest. The result goes in `track_loudness`, per recording, with the file it was measured from, that file's size and modification time, and its exact length in samples. It runs as one of Settings → Analysis's four analyses.

### `POST /api/levels`

The player sends up to 50 recording ids and gets, for each measured song:

- `track`: the gain (dB) that brings the song to **−14 LUFS** (`TARGET_LUFS`). Loud songs come down, by at most 20 dB. Quiet songs go up by at most 12 dB, and only as far as keeps the peak under −1 dBFS. Rounded to 0.1 dB.
- `album`: the same for the album as a whole, when more than one of its songs is measured. The album's loudness is the power average of its songs, weighted by length; its peak is the loudest song's. The player uses it when the queue plays the album in order (`apps/web/src/player/decks.ts`), so quiet and loud songs keep their places.
- `lufs` and `peak`.

Songs not measured yet are queued at once, ahead of everything, and the rest of their albums after them; the player asks again shortly. A song measured from a different file than the one now playing is measured again.

### `/stream/:fileId/levelled.wav?gain=`

The song decoded with the gain applied, as a 16-bit stereo 44.1 kHz WAV (`media/levelled.ts`). The gain may be at most ±20 dB (400 otherwise). Because loudness analysis counted the samples, the file's length is known before a byte is decoded: every byte is at a known place, so a range from anywhere is decoded from that exact sample, and players seek, buffer and join songs as in any file. Formats whose seeking lands only near a time are decoded from the start to reach it exactly.

It answers 404, and the player plays the song's own file instead, when the song isn't measured yet, when its file changed since (it's then measured again), or when its source can't decode. The `ETag` includes the gain. The stream is uncompressed, about 1.4 Mbit/s.

DJ transitions are rendered at the gains the two songs play at ([../mixing.md](../mixing.md)); with even volume off, the player sends no gains.

---

## 3. Transition files: `/transitions/:file`

DJ mix transitions are rendered by the server in the background, then played between song A and song B. How they're planned and rendered is in [../mixing.md](../mixing.md).

- `POST /api/transitions` asks for A→B (with the mode, A's position, the files, fade length, whether the queue plays an album, and even-volume gains). It answers with the file's name when ready, or "unavailable" with a reason the player can fall back on (it crossfades). Without audio analysis every answer is "unavailable". An account that hears only some sources plans from its own songs.
- `GET` and `HEAD /transitions/:file` send a rendered file: `<40 hex>.flac`, or `.rest.flac` for B's remainder (`.wav` where there's no ffmpeg). The service decides which names exist, never a path from the client, and an account that hears only some sources gets the file only if it may hear both songs. Byte ranges as for `/stream`; the names are content keys (another plan makes another name), so files are cached for good (`private, max-age=31536000, immutable`).
- **The cache** is under `CACHE_DIR/transitions`, trimmed after each render to `TRANSITIONS_CACHE_MB` (default 1024), least recently used first; a transition's files are removed together. Its index is read from disk at start, so transitions made before a restart are served, not made again. New cue points for a song forget its transitions.

---

## 4. Artwork

### Which picture an album or artist gets

`catalog/build.ts` gives each album a cover URL, in this order:

1. **Lidarr's cover**, for albums Lidarr has a picture for: `/art/album/:id/cover?v=<lastWrite>` (`artUrl` in `catalog/lidarr.ts`).
2. **The folder that holds the album**: the folder with the most of the album's songs, as long as at least half of that folder's songs are the album's ("Coldplay/Parachutes/", a single in a folder of its own). Never a folder of many albums' songs (a compilation, a "1 song only" collection, loose songs), whose pictures belong to other albums. The cover is `/art/copy/<first song's file>`: the picture embedded in that file, else `cover`, `folder`, `front` or `album` `.jpg`/`.jpeg`/`.png`/`.webp` beside it.
3. **MusicBrainz**: for an album matched to a release group, its Cover Art Archive front cover (500 px), fetched through Lidarr's image CDN (`images.lidarr.audio`), which serves it in one hop.
4. **The first song's own picture**: `/art/copy/<first song's file>?embedded=1`, the picture embedded in the album's first song wherever it's kept, never the folder's images. This is how an album in a folder of many albums' songs, with no MusicBrainz match, still gets its cover.

Songs take their album's cover. An artist's photo is Lidarr's poster, else the cover of their newest album that has one; fanart, banners and logos come from Lidarr only.

### The routes

- **`/art/:kind/:id/:type`**: Lidarr's artwork. Kinds and types: `album/cover`, `artist/poster`, `artist/fanart`, `artist/banner`, `artist/clearlogo`. The original is fetched once from Lidarr's `mediacover` endpoint and kept on disk; after each library refresh, missing originals are fetched in the background, two at a time. Only for albums and artists in the account's view.
- **`/art/copy/:id`**: a folder file's picture, as above (`?embedded=1` for the embedded picture alone). Only for files in the account's view.
- **`/art/remote?url=`**: artwork for music outside the library (Discover, match candidates). Only `https` URLs on an allowlist (`discover/art.ts`): `images.lidarr.audio`, `coverartarchive.org`, `archive.org` and its subdomains, `assets.fanart.tv`, and Deezer's `dzcdn.net`. Redirects are followed by hand, at most 5, each hop checked against the allowlist; 15 s timeout; the answer must be an image. `?wide=1` keeps the aspect ratio.
- **`/art/playlist/:id`** and `/art/playlist/:id/preview`: generated playlist covers, see [playlist-covers.md](playlist-covers.md).

### Sizes and caching

`?size=` snaps up to one of 96, 160, 240, 320, 480, 640, 960 or 1200 px, which bounds the variants kept. A sized image is resized with sharp (covers and posters cropped square, never enlarged) and encoded as WebP at quality 82; without `size`, the original is sent. Each variant is saved under `CACHE_DIR/art`, keyed by a hash of what it is (for Lidarr art, including its version), and the folder is trimmed to `ART_CACHE_MB` (default 2048), least recently used first, 5 minutes after start and then every 6 hours.

Browser caching: Lidarr art with `?v=` is `public, max-age=31536000, immutable` (a new picture in Lidarr brings a new `v`); without it, one day. Folder pictures get one day, remote ones 30 days. Errors are `no-store`, so a missing picture doesn't stick.

### Cover colors

Albums and songs carry two colors of their cover, as `#rrggbb`, so the apps can fill a cover's space while it loads and color the page and the player without decoding the picture:

- **`coverColor`**: what the cover reads as from afar (the idea of Apple Music's artwork `bgColor`). Its pixels are sorted into boxes 32 levels of red, green and blue wide; the box whose neighborhood (itself and the boxes around it) holds the most pixels wins, and the color is that neighborhood's average: the cover's largest area of one color, not its most vivid. Every cover that has been read has one, gray ones included.
- **`coverAccent`**: the vivid accent the apps pick, ported from the web's `accentOf` (`apps/web/src/lib/color.ts`; iOS's `AccentColor.extract` is the same; the three name each other, keep them in step): 12 hue buckets weighted by saturation and mid-lightness, near black and near white left out, and pixels with no saturation at all too (counted as red, they gave gray and black-and-white covers a dusty red); the heaviest bucket's average with saturation clamped to 45–90 % and lightness to 56–68 %, then lightened until its relative luminance reaches 0.2. Absent when the cover has no color to give.

`library/coverColors.ts` reads both from the picture cropped square (as the routes crop covers) at 32×32, as the web draws it on a canvas; transparent parts count as black. Only covers the library serves itself are read: Lidarr's (`/art/album/:id/cover`) and folder files' pictures (`/art/copy/:id`). Remote covers (an album's MusicBrainz cover through `/art/remote`) have no colors.

`library/coverColorStore.ts` keeps them in the `cover_colors` table, keyed by what identifies the picture, so a new picture is read again: `album/<Lidarr album id>/<v>` for Lidarr's covers (Lidarr gives a changed picture a new `v`), `copy/<file id>/<file size>[/embedded]` for folder pictures (re-tagging a file changes its size; the art cache keys them the same way). Each row has the version of the algorithm that read it: when `COVER_COLORS_VERSION` goes up, covers are read again, and keep their old colors until then. The Library gives albums and their songs the colors as it builds the catalog, and the moment a cover is read, in its snapshot and every account's view.

Nothing waits for them; a cover not read yet just has no colors. They're read:

- **in the background** after each library refresh, once `LocalArt.warm` is done: covers without colors, newest albums first, two at a time. Lidarr's are read only from originals already on disk (never asking Lidarr), folder pictures from a variant in the art cache when a page had one drawn, else from the file. A file with no picture is looked at again after a day. A source whose covers fail five times in a row (a NAS that's away) is left until the next refresh. What's read is kept, so after a restart the fill goes on where it stopped.
- **from the art routes**: an album cover they have in hand (an original fetched, or a variant served from the cache) is handed over after the answer, and read one at a time, at most 16 waiting.

---

## 5. Lyrics

`GET /api/tracks/:id/lyrics` (`lyrics/lyrics.ts`) looks in order for:

1. an `.lrc` file beside the song, with the same name (up to 256 KB);
2. lyrics in the file's tags, timed or plain;
3. [LRCLIB](https://lrclib.net), by artist, title, album and length; failing that, its search, for the closest song by length within 3 s, timed lyrics preferred. It can also say a song is instrumental.

Timed lines (LRC, with `[offset:]`) come back as `{ at, text }`; anything else as plain text. Results are stored per recording in the `lyrics` table, found or not; songs without lyrics are looked up again after 14 days. Browsers keep the answer for an hour.
