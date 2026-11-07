# Plan 2: Listening away from home

Agreed 2026-11-05 from the reviews; second of four (after [safety and release](2026-11-05-1-safety-and-release.md)).

**Goal:** a member on mobile data, away from home, presses play and it plays: quickly, at a sensible size, over HTTPS, and keeps playing through a dead spot. Today every client streams the original file (24-bit FLAC included), the web's even volume streams uncompressed WAV (about 1.4 Mbit/s, on by default), HTTPS is a manual job for the owner, and a blip stops playback for good.

**Where it stands (2026-11-07):** 1, 2 and 5 done. Left: 4's HomePod trial and 3.

## 1. Transcoding and a quality setting — M–L — done 2026-11-07

*Done on iOS: Settings → Playback → Streaming quality (Wi-Fi, mobile data, downloads, the web's defaults); a song streams its encoded stream from any sample (`start=`) where it comes encoded, decoded by `StreamDecoder` as an M4A trimmed by its packet table, exact to the sample (`decodesAnEncodedStreamAsItArrivesToTheSample`, on a stream made by the server's own code from Apple's AAC); the stream's padding is never fetched (`StreamPadding`); a copy on the device as good as wanted plays instead, a download's whatever its quality; downloads come at their own quality and are fetched again below it; an old server, a song it can't encode or an encode that fails plays the song's own file (docs/ios/audio-engine.md §3). Not measured yet: an hour on mobile data on a device, against a server with ffmpeg.*

*Done: `GET /stream/:fileId/aac` and `levelled.aac` (and Opus, which nothing plays yet), AAC from ffmpeg's own encoder in fragmented MP4 written by the server (`media/encoded.ts`, `media/mp4.ts`), encoded where the files are, one encode per stream shared by everyone reading it, at most 8 at once and 4 for an account (`ENCODES_MAX`, `ENCODES_PER_ACCOUNT`), held in memory, finished ones kept for whoever asks next, within `ENCODE_CACHE_MB`. Seeking: rather than a byte position from a fixed bitrate (ffmpeg's AAC isn't constant), a stream starts at any sample asked for (`start=`), and every sample is where the song's file has it: 2112 samples of priming, the song's own audio before the start warming the encoder, said in iTunSMPB. Measured with a click track: exact through Apple's decoders and AVPlayer (Safari), and held by `media/encoded.alignment.test.ts`, whose ffmpeg half runs where ffmpeg is installed. Chrome and Firefox aren't measured, so there the web plays songs' own files with DJ mix. The web's setting is Settings → Playback → Streaming quality (Wi-Fi, mobile data, downloads), mobile data's applying only where the browser says it's on it (Chrome on Android). Normal is 128 kbps, about 58 MB an hour (115 MB is High's). Safari starts an encoded stream only once it's all encoded, a few seconds for a song: HLS or Media Source Extensions would start it sooner. The routes' contract for the iOS app is in [server/streaming-and-art.md](../server/streaming-and-art.md#2-encoded-streams-streamfileidaac).*

- Server: `GET /stream/:fileId/aac?kbps=256|128` (and Opus where the client asks for it), encoded as it's asked for with ffmpeg, where the files are, as the WAV routes do (`apps/server/src/routes/stream.ts`, `media/source.ts`). Seeking: a fixed bitrate gives a byte position for a time; decode from that time.
- The levelled stream can come encoded too, with the gain applied (`/stream/:id/levelled.aac?gain=`), so even volume no longer means uncompressed WAV.
- A cap on concurrent encodes per account and overall (also asked for by the server review).
- Clients: a quality setting, separately for Wi-Fi and mobile data (Original, High 256, Normal 128), in iOS Settings → Playback and the web's settings; downloads have their own (default Original).
- **Done when** an hour of listening on mobile data uses about 115 MB at Normal instead of 300–600 MB, seeking works, and DJ transitions still line up.

## 2. Even volume without the WAV on desktop — S — done 2026-11-07

*Done: on a desktop (`playsThroughGraph` in `player/levels.ts`) each song plays its own file, its encoded stream or the copy kept on the device, turned by its gain in the graph, up by at most 12 dB as well as down (`graphGain`); transitions are asked for at those gains. Phones and tablets keep the leveled stream (`levelled.aac` at High and Normal), Android too: its element volume works, but only turns songs down, and Web Audio stops there with the screen locked.*

On desktop the audio already goes through Web Audio: apply the level with a gain node on the song's own stream and keep `levelled.*` for where volume can't be set (iOS Safari). Songs kept on the device then level the same way as streamed ones (today they play unlevelled). (`apps/web/src/player/levels.ts`, `AudioEngine.tsx`.)

## 3. HTTPS that an owner can actually set up — M

- An optional Caddy service in `docker/compose.yaml` (profile `https`), with the owner's domain in `.env`; a Tailscale guide as the no-domain alternative.
- Settings → Server: "Reachable from outside over HTTPS?", checked from the server against its public address, with what to fix when it isn't.
- **Done when** a fresh owner gets a working public HTTPS address following the docs in under 15 minutes.

## 4. AirPlay — S — done but for the HomePod trial

*Done: the AirPlay button (`AirPlayButton`, an `AVRoutePickerView`) is in Now Playing and the iPad's player bar, since plans 5 and 6. Left: trying `longFormAudio` on a HomePod, on a device.*

The store description promises AirPlay; there's no route picker in the app. An `AVRoutePickerView` in Now Playing and the iPad player bar; try `longFormAudio` routing on a HomePod (`AudioSessionController.swift`) and keep it if it behaves better. Add both to the device checklist.

## 5. Playback rides out a dead spot — M — done 2026-11-07

*Done on iOS: downloads back off (1, 3, 8 s), and a song stopped by the network waits where it was and plays on when the network is back, or after 2 to 30 s while the phone is online (docs/ios/audio-engine.md, "Dead spots"). The songs, levels and transitions on the home address came with plan 1 §3.*

*Done on the web (`AudioEngine.tsx`: `recover`, `watch`; `lib/api.ts`): a stream that breaks off is asked for again from where it stopped after 1, 3 and 8 s, then every 15 s while the server can't be reached; offline, the song waits for `online` and goes on where it was (after 30 s, a song kept on the device plays); the watchdog asks again for a song stuck 8 s while online, once it has played; a stream that never started is asked about (HEAD for an encoded one, which starts no encode): retried if the server wasn't reached, its own file from then on if the server refused it, this time only if it was busy; a song the server serves that still won't play gives way to the next (three in a row stop); API requests give up on a server that hasn't answered after 15 s (2 minutes for slow ones, lyrics among them), an answer then taking as long as it takes. The test: the network off for 20 s mid-song and back on, and the song goes on from where it was, its own file or its encoded stream (from that very sample).*

- iOS: downloads back off (1, 3, 8 s…) instead of three quick retries; a failed song waits for the network (`NWPath`) and resumes at its time instead of stopping (`PlayarrPlayer/Download.swift`, `Player.swift` `handle(.failed)`, `networkChanged`). Songs, levels and transitions use the home address too once plan 1 makes that safe (plan 1 §3 has: `MediaURLs.onHomeAddress` gives a song's home address once `HomeAddress` has proven it on this network, and `request(for:)` then carries the token there).
- Web: a watchdog on the playing deck (stuck in `waiting` more than about 8 s while online: reload from the current time); retries with backoff; out of retries offline, wait for `online`; online, move to the next song; a default timeout on API requests (`AudioEngine.tsx` `retryStream`, `lib/api.ts`).
- **Done when** turning the network off for 20 s mid-song and back on resumes the song where it was, on both.

## Order

1 and 2 together → 5 → 4 → 3.
