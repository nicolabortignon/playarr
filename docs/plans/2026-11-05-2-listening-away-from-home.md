# Plan 2: Listening away from home

Agreed 2026-11-05 from the reviews; second of four (after [safety and release](2026-11-05-1-safety-and-release.md)).

**Goal:** a member on mobile data, away from home, presses play and it plays: quickly, at a sensible size, over HTTPS, and keeps playing through a dead spot. Today every client streams the original file (24-bit FLAC included), the web's even volume streams uncompressed WAV (about 1.4 Mbit/s, on by default), HTTPS is a manual job for the owner, and a blip stops playback for good.

**Where it stands (2026-11-06):** not started; plans 5 to 7, on the apps' design and flows, were taken first.

## 1. Transcoding and a quality setting — M–L

- Server: `GET /stream/:fileId/aac?kbps=256|128` (and Opus where the client asks for it), encoded as it's asked for with ffmpeg, where the files are, as the WAV routes do (`apps/server/src/routes/stream.ts`, `media/source.ts`). Seeking: a fixed bitrate gives a byte position for a time; decode from that time.
- The levelled stream can come encoded too, with the gain applied (`/stream/:id/levelled.aac?gain=`), so even volume no longer means uncompressed WAV.
- A cap on concurrent encodes per account and overall (also asked for by the server review).
- Clients: a quality setting, separately for Wi-Fi and mobile data (Original, High 256, Normal 128), in iOS Settings → Playback and the web's settings; downloads have their own (default Original).
- **Done when** an hour of listening on mobile data uses about 115 MB at Normal instead of 300–600 MB, seeking works, and DJ transitions still line up.

## 2. Even volume without the WAV on desktop — S

On desktop the audio already goes through Web Audio: apply the level with a gain node on the song's own stream and keep `levelled.*` for where volume can't be set (iOS Safari). Songs kept on the device then level the same way as streamed ones (today they play unlevelled). (`apps/web/src/player/levels.ts`, `AudioEngine.tsx`.)

## 3. HTTPS that an owner can actually set up — M

- An optional Caddy service in `docker/compose.yaml` (profile `https`), with the owner's domain in `.env`; a Tailscale guide as the no-domain alternative.
- Settings → Server: "Reachable from outside over HTTPS?", checked from the server against its public address, with what to fix when it isn't.
- **Done when** a fresh owner gets a working public HTTPS address following the docs in under 15 minutes.

## 4. AirPlay — S

The store description promises AirPlay; there's no route picker in the app. An `AVRoutePickerView` in Now Playing and the iPad player bar; try `longFormAudio` routing on a HomePod (`AudioSessionController.swift`) and keep it if it behaves better. Add both to the device checklist.

## 5. Playback rides out a dead spot — M

- iOS: downloads back off (1, 3, 8 s…) instead of three quick retries; a failed song waits for the network (`NWPath`) and resumes at its time instead of stopping (`PlayarrPlayer/Download.swift`, `Player.swift` `handle(.failed)`, `networkChanged`). Songs, levels and transitions use the home address too once plan 1 makes that safe.
- Web: a watchdog on the playing deck (stuck in `waiting` more than about 8 s while online: reload from the current time); retries with backoff; out of retries offline, wait for `online`; online, move to the next song; a default timeout on API requests (`AudioEngine.tsx` `retryStream`, `lib/api.ts`).
- **Done when** turning the network off for 20 s mid-song and back on resumes the song where it was, on both.

## Order

1 and 2 together → 5 → 4 → 3.
