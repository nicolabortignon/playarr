# Streaming and artwork

How the server sends songs, transition files, pictures and lyrics to the players. The code lives in `apps/server/src/routes/stream.ts`, `routes/levels.ts`, `routes/transitions.ts`, `routes/art.ts` and `routes/lyrics.ts`, with `media/encoded.ts` and `media/mp4.ts` (encoded streams), `media/levelled.ts` (WAV streams), `analysis/loudness.ts` (loudness), `catalog/files.ts` (where a file's bytes are), `catalog/build.ts` and `catalog/folderArt.ts` (which picture an album gets), `library/coverColors.ts` and `library/coverColorStore.ts` (covers' colors), `discover/art.ts` (remote images) and `lyrics/lyrics.ts`.

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

## 2. Encoded streams: `/stream/:fileId/aac`

Settings → Playback → Streaming quality ([../web.md](../web.md#10-settings-panels)). At High (256 kbps) or Normal (128 kbps) a song isn't sent as its file: the server encodes it as it's asked for, AAC-LC at 44.1 kHz in stereo, in fragmented MP4 (`media/encoded.ts`, `media/mp4.ts`, the routes in `routes/stream.ts`). An hour at Normal is about 58 MB, at High about 115 MB, against 300 to 600 MB for lossless files.

### The routes

| path | what |
|---|---|
| `GET/HEAD /stream/:fileId/aac?kbps=&start=` | the song encoded, from its sample `start` on |
| `GET/HEAD /stream/:fileId/levelled.aac?gain=&kbps=&start=` | the same at its even-volume level: `gain` dB (at most ±20) applied before it's encoded |
| `GET/HEAD /stream/:fileId/opus`, `/levelled.opus` | the same as Opus (see [Opus](#opus) below) |

- **`kbps`**: `128` (when left out) or `256`; anything else is 400.
- **`start`**: where the stream starts in the song, in samples at 44.1 kHz: an integer, 0 when left out. 400 if it isn't an integer of 0 or more, or is at or past the song's end. Its first sample is the song's sample `start`, whatever the file's format: an MP3, whose seeking lands only near a time, is decoded from its start to get there.
- **`gain`**, on the leveled routes, as on `levelled.wav`; the plain routes ignore it.
- **The song's length** is the one loudness analysis counted, when it measured this very file; otherwise the file's header says (exact for FLAC, Apple Lossless, WAV and AIFF; for an MP3 an estimate, so the stream's end may be cut or padded a little), and a song measured from an older version of its file is measured again. Neither known: 404.
- **Caching.** The `ETag` is made of the file's size and modification time, the song's length, `start`, `gain`, the codec and bitrate, and the layout's version (`ENCODED_VERSION`, bumped whenever the same arguments would give other bytes); 304 on `If-None-Match`. `Cache-Control: private, max-age=86400`, `Content-Type: audio/mp4`.

What they answer:

- **200 or 206**: the stream, with byte ranges as for `/stream` (416 past its end). Its length is declared at once, before a sample is encoded, as an upper bound (see [the layout](#the-layout)): AVFoundation won't play a stream of unknown length. A range within the init segment is answered at once; one past what's encoded waits for it.
- **404**: the server can't make it. No ffmpeg where the file is (an SFTP source), or the song's length is unknown. Play the song's own file (or `levelled.wav`).
- **502**: the encode failed before its first fragment, or took more than 20 s to make it (`FIRST_FRAGMENT_MS`). Play the song's own file.
- **503** with `Retry-After: 5`: too many songs are being encoded (below). Ask again after that.

### How a stream is made

- **Where the files are**, as the WAV streams are decoded: ffmpeg on this server for its own folders and SMB shares (reading rclone's loopback address), on the host for SSH sources, so only the encoded audio crosses the network. A Lidarr library's files are encoded as `MEDIA_SOURCE` reads them. SFTP sources have no ffmpeg (404).
- **ffmpeg's own AAC encoder** (every ffmpeg has it) writes ADTS, whose frames the server checks (AAC-LC, 44.1 kHz, stereo) and puts into fragmented MP4 itself. Everything before the encoder happens at 44.1 kHz, sample by sample: resampling, dropping the samples before the stream's first, silence before the song's start, the gain, and the length made exact (`ffmpegEncodeArgs` in `media/source.ts`). ffmpeg seeks in the file before decoding only to a time on a 10 ms grid, which formats that seek exactly land on exactly; MP3s are decoded from their start. The output is bitexact, so the same file and arguments give the same bytes.
- **One encode per stream**, shared by everyone reading it at once (an `<audio>` element's ranges, the device keeping the song). It runs up to 1 MiB past the furthest reader, then waits for them (`READ_AHEAD`): a stream heard over a slow connection is encoded as it's heard. One nobody reads any more is stopped after 10 s.
- **Memory.** Encoded streams, finished and being encoded, are held within `ENCODE_CACHE_MB` (128). Finished streams stay for whoever asks next, so the same stream asked for again is sent at once; the least recently read go first, and a stream bigger than half of it (an hour's mix) isn't kept. Past that, an encode lets go of the fragments every one of its readers is past (one too big to keep first, then any over its share), and a request for bytes it let go of starts another encode. Bytes a reader still needs are never let go of.
- **Limits.** At most `ENCODES_MAX` (8) encodes at once, and `ENCODES_PER_ACCOUNT` (4) for any one account. Encodes nobody reads any more are stopped first to make room (for an account at its own limit, only its own).

### Why AAC in fragmented MP4

- **Every player Playarr has plays it**: Safari on a Mac, iPhone and iPad, and every iPhone browser (AVFoundation); Chrome and Firefox, on computers and Android; the iOS app's AudioFileStream and AVAudioFile. Opus in MP4 doesn't play in older Safari, and Apple's decoders put it off by samples (see [Opus](#opus)). ffmpeg's own AAC encoder is in every ffmpeg, so nothing more is needed on a NAS.
- **A plain MP4** lists every frame's size in its header, before the audio: not known until the song is encoded, so a player would wait for all of it. Fragmented MP4 says up front what the stream holds and lists each fragment's frames as they're made, so the stream goes out as it's encoded.
- **Bare ADTS**, which needs no container, can't say what to trim: AVPlayer plays it 2112 samples late and guesses its duration, and Apple's AudioFile decodes it 2112 samples late too (both measured).

### The layout

Every stream is laid out so that any player can put every sample exactly where it is in the song.

```
ftyp        M4A , with mp42 and isom
moov        mvhd (the song's samples from start as its duration), one trak (mdhd at 44,100;
            esds: AAC-LC, 44.1 kHz, stereo; no samples), mvex (mehd, trex),
            udta → meta → ilst: iTunSMPB
moof, mdat  the first fragment: 43 frames, about a second
moof, mdat  then 431 frames each, about 10 s
…
free        padding to the declared length; its last 64 bytes are zeros
```

- **Frames and priming.** An AAC frame holds 1024 samples. A stream holds `ceil((2112 + valid) / 1024)` frames: 2112 samples of priming, then the song's `valid = length − start` samples from `start`, then padding to the end of the last frame. The priming is the encoder's own delay (1024 samples) and the 1088 samples of the song before `start` (silence before the song's first sample), fed to the encoder first so it's warmed up on the song itself when sample `start` comes. 2112 is also the priming of Apple's encoder, which AVFoundation takes for granted.
- **iTunSMPB** says so, as iTunes writes it: ` 00000000 00000840 <padding, 8 hex digits> <valid, 16 hex digits>` and eight more zeros (0x840 is 2112). AudioFileStream, AVAudioFile and AVAssetReader read it as the packet table (`mPrimingFrames` 2112, `mNumberValidFrames`, `mRemainderFrames`) and trim by it. There's no edit list: AVFoundation would take 2112 samples off twice.
- **Fragments**: `tfhd` with default-base-is-moof, `tfdt` (version 1: the decode time of the fragment's first sample, priming included) and `trun` with the data offset and each frame's size. The first fragment is short so a request is answered at once; the others are long because AVPlayer reads every fragment's header before it plays (below).
- **The free box** fills the stream to its declared length: 20% over the bitrate, plus 16 KiB, which ffmpeg's encoder never reaches over a song (a stream that would overrun is cut short there, and logged). A player may stop reading where it starts. One that reads it uses up to a fifth more data than the bitrate.

Decoded and trimmed by iTunSMPB, sample *k* of a stream is the song's sample `start + k` at 44.1 kHz, exactly. So a song's encoded stream and its own file line up to the sample, and DJ transitions, cut to the sample of the song's file, join either the same way ([../mixing.md](../mixing.md)).

### Measured

`media/encoded.alignment.test.ts` holds it, on a click track: 8 s of quiet noise with a one-sample click every 57,331 samples from sample 10,000.

- **Apple's decoders** (where `afconvert` is: macOS). The track encoded by Apple's AAC encoder (priming 2112, as the server's streams have), run through the server's encode job into a stream, decoded by AudioFile with its packet table: exactly the song's length, every click on its sample. The same frames as bare ADTS, which can't say what to trim, put every click 2112 samples late: the test sees the trimming, not just its absence.
- **ffmpeg** (where ffmpeg is). The server's real encode, from the start and from sample 100,003 at −6 dB, decoded by ffmpeg, and by `afconvert` too on a Mac: every click on its sample, at the gain asked for. The Mac this was built on had no ffmpeg, so this half hasn't run yet; it runs on any machine that has it.
- **By hand, on macOS 27.2.** Streams from the real routes, played by AVPlayer (what Safari's `<audio>` plays through) and recorded through an audio tap: every click lands where the WAV of the same song puts it, from the start, from sample 140,003 (its duration 8.825329 s, exact), and after a seek within the stream (AVPlayer seeks by the fragments' `tfdt`, exactly). The iOS app's two decoders read the same stream exactly too, AudioFileStream trimming by the packet table and AVAudioFile (seeks included), and so does AVAssetReader.
- **Not measured**: Chrome and Firefox, which play MP4 through their own demuxers (Chrome through FFmpeg's, which reads iTunSMPB's priming, by its source). So with DJ mix on, the web plays songs' own files there ([../web.md](../web.md#6-the-player)).

### Safari reads the whole stream before it plays

AVPlayer (Safari, and every browser on an iPhone) asks for a stream's first two bytes, for its length, then reads every fragment's `moof` before it starts, page by page, whether or not the stream has a `sidx` or an `mfra` (both measured). So an encoded stream starts in Safari once it's all encoded: a four-minute song about five seconds after it's asked for, on a server encoding at 40 to 50 times real time (the 10 s fragments keep the reading to a few dozen requests). Seeking afterwards is instant and exact. The web loads the next song 30 s before it's due, so songs still follow each other without a gap; the first song, or one skipped to, waits. An HLS playlist of the same fragments, or Media Source Extensions (ManagedMediaSource on iOS 17.1 and later), would start sooner; neither is done yet.

Bare ADTS starts at once in AVPlayer, but 2112 samples late and with a guessed duration: not used.

### Opus

`/opus` and `/levelled.opus` are libopus at a constant bitrate, 48 kHz, 20 ms packets, in fragmented MP4: the pre-skip (312) in `dOps`, and the edit list the Opus-in-ISOBMFF spec asks for. Nothing in Playarr plays them. AudioFileStream leaves the pre-skip in (176 samples late at 44.1 kHz), AVAssetReader comes within a sample, and no browser was measured. They're there for a client that measures its own.

### For the iOS app

The app does all this (docs/ios/audio-engine.md §3, offline.md §5):

- Ask for `aac`, or `levelled.aac` with the song's gain, never Opus; `kbps` 128 or 256; `start` 0 for a song from its start.
- Read it as an M4A file (AudioFileStream opened with `kAudioFileM4AType`, as `StreamDecoder` opens an `m4a`; or AVAudioFile and AVAssetReader on a copy on the device) and trim by its packet table (`kAudioFileStreamProperty_PacketTableInfo`): after the 2112 primed samples, the first decoded sample is the song's sample `start`; stop after `mNumberValidFrames`.
- To seek, ask for a new stream from `start` (samples at 44.1 kHz), or seek within what's downloaded by its fragments.
- After a broken connection, resume with a range from the last byte received: the same URL is the same bytes. (A server update that brings another ffmpeg could change them under the same `ETag`; resuming across one garbles a frame at the join, as it would in any file replaced meanwhile.)
- 503: wait `Retry-After` seconds and ask again. 404 or 502: play the song's own file.
- A download may stop at the `free` box.

---

## 3. Even volume: leveled streams

Settings → Playback → Even out the volume. iPhones ignore an audio element's volume, and an element's volume only turns a song down, so on phones and tablets the web levels songs in the audio itself: a leveled stream. Desktop browsers turn each song by a gain in Web Audio instead, up as well as down, playing its own file ([../web.md](../web.md#6-the-player)). The iOS app levels songs in its own audio engine.

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

It answers 404, and the player plays the song's own file instead, when the song isn't measured yet, when its file changed since (it's then measured again), or when its source can't decode. The `ETag` includes the gain. The stream is uncompressed, about 1.4 Mbit/s: at High and Normal the web asks for `levelled.aac` instead, the same encoded ([2](#2-encoded-streams-streamfileidaac)).

DJ transitions are rendered at the gains the two songs play at ([../mixing.md](../mixing.md)); with even volume off, the player sends no gains.

---

## 4. Transition files: `/transitions/:file`

DJ mix transitions are rendered by the server in the background, then played between song A and song B. How they're planned and rendered is in [../mixing.md](../mixing.md).

- `POST /api/transitions` asks for A→B (with the mode, A's position, the files, fade length, whether the queue plays an album, and even-volume gains). It answers with the file's name when ready, or "unavailable" with a reason the player can fall back on (it crossfades). Without audio analysis every answer is "unavailable". An account that hears only some sources plans from its own songs.
- `GET` and `HEAD /transitions/:file` send a rendered file: `<40 hex>.flac`, or `.rest.flac` for B's remainder (`.wav` where there's no ffmpeg). The service decides which names exist, never a path from the client, and an account that hears only some sources gets the file only if it may hear both songs. Byte ranges as for `/stream`; the names are content keys (another plan makes another name), so files are cached for good (`private, max-age=31536000, immutable`).
- **The cache** is under `CACHE_DIR/transitions`, trimmed after each render to `TRANSITIONS_CACHE_MB` (default 1024), least recently used first; a transition's files are removed together. Its index is read from disk at start, so transitions made before a restart are served, not made again. New cue points for a song forget its transitions.

---

## 5. Artwork

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
- **`/art/remote?url=`**: artwork for music outside the library (Discover, match candidates), and the MusicBrainz cover of a library album that has no other (step 3 above). Only `https` URLs on an allowlist (`discover/art.ts`): `images.lidarr.audio`, `coverartarchive.org`, `archive.org` and its subdomains, `assets.fanart.tv`, and Deezer's `dzcdn.net`. Redirects are followed by hand, at most 5, each hop checked against the allowlist; 15 s timeout; the answer must be an image. `?wide=1` keeps the aspect ratio.
- **`/art/playlist/:id`** and `/art/playlist/:id/preview`: generated playlist covers, see [playlist-covers.md](playlist-covers.md).

### Sizes and caching

`?size=` snaps up to one of 96, 160, 240, 320, 480, 640, 960 or 1200 px, which bounds the variants kept. A sized image is resized with sharp (covers and posters cropped square, never enlarged) and encoded as WebP at quality 82; without `size`, the original is sent. Each variant is saved under `CACHE_DIR/art`, keyed by a hash of what it is (for Lidarr art, including its version), and the folder is trimmed to `ART_CACHE_MB` (default 2048), least recently used first, 5 minutes after start and then every 6 hours.

Browser caching: Lidarr art with `?v=` is `public, max-age=31536000, immutable` (a new picture in Lidarr brings a new `v`); without it, one day. Folder pictures get one day, remote ones 30 days. Errors are `no-store`, so a missing picture doesn't stick.

### Cover colors

Albums and songs carry two colors of their cover, as `#rrggbb`, so the apps can fill a cover's space while it loads and color the page and the player without decoding the picture:

- **`coverColor`**: what the cover reads as from afar (the idea of Apple Music's artwork `bgColor`). Its pixels are sorted into boxes 32 levels of red, green and blue wide; the box whose neighborhood (itself and the boxes around it) holds the most pixels wins, and the color is that neighborhood's average: the cover's largest area of one color, not its most vivid. Every cover that has been read has one, gray ones included.
- **`coverAccent`**: the vivid accent the apps pick, ported from the web's `accentOf` (`apps/web/src/lib/color.ts`; iOS's `AccentColor.extract` is the same; the three name each other, keep them in step): 12 hue buckets weighted by saturation and mid-lightness, near black and near white left out, and pixels with no saturation at all too (counted as red, they gave gray and black-and-white covers a dusty red); the heaviest bucket's average with saturation clamped to 45–90 % and lightness to 56–68 %, then lightened until its relative luminance reaches 0.2. Absent when the cover has no color to give.

`library/coverColors.ts` reads both from the picture cropped square (as the routes crop covers) at 32×32, as the web draws it on a canvas; transparent parts count as black. Every library album's cover is read: Lidarr's (`/art/album/:id/cover`), a folder file's picture (`/art/copy/:id`), or the MusicBrainz cover of an album with neither (`/art/remote`: the Cover Art Archive through Lidarr's image CDN). The remote covers of Discover, search results, requests and match candidates aren't.

`library/coverColorStore.ts` keeps them in the `cover_colors` table, keyed by what identifies the picture, so a new picture is read again: `album/<Lidarr album id>/<v>` for Lidarr's covers (Lidarr gives a changed picture a new `v`), `copy/<file id>/<file size>[/embedded]` for folder pictures (re-tagging a file changes its size; the art cache keys them the same way), and `remote/<url>` for MusicBrainz covers (the remote image's address, as the art route reads it). Each row has the version of the algorithm that read it: when `COVER_COLORS_VERSION` goes up, covers are read again, and keep their old colors until then. The Library gives albums and their songs the colors as it builds the catalog, and the moment a cover is read, in its snapshot and every account's view.

Nothing waits for them; a cover not read yet just has no colors. They're read:

- **in the background** after each library refresh, once `LocalArt.warm` is done: covers without colors, newest albums first, two at a time, and remote covers one at a time beside them. Lidarr's are read only from originals already on disk (never asking Lidarr). Folder pictures and remote covers come from a variant in the art cache when a page had one drawn, else from the file, or from the remote host, each fetch starting at least a second after the last: the Cover Art Archive is someone else's service, and nothing else on the server limits how often it's asked (the MusicBrainz queue is for its API, not its covers). A cover with no picture (a file without one, a remote 404) is looked at again after a day. A source whose covers fail five times in a row (a NAS that's away, the Cover Art Archive refusing; remote covers count as one source) is left until the next refresh. What's read is kept, so after a restart the fill goes on where it stopped.
- **from the art routes**: a library album's cover they have in hand (an original fetched, or a variant served from the cache) is handed over after the answer, and read one at a time, at most 16 waiting. `/art/remote` hands over only covers of library albums, never Discover's.

---

## 6. Lyrics

`GET /api/tracks/:id/lyrics` (`lyrics/lyrics.ts`) looks in order for:

1. an `.lrc` file beside the song, with the same name (up to 256 KB);
2. lyrics in the file's tags, timed or plain;
3. [LRCLIB](https://lrclib.net), by artist, title, album and length; failing that, its search, for the closest song by length within 3 s, timed lyrics preferred. It can also say a song is instrumental.

Timed lines (LRC, with `[offset:]`) come back as `{ at, text }`; anything else as plain text. Results are stored per recording in the `lyrics` table, found or not; songs without lyrics are looked up again after 14 days. Browsers keep the answer for an hour.
