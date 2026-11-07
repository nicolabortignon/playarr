# The iOS audio engine

This is how the app plays music: from a song's file on the server to samples out of the speaker, with gapless joins, crossfades, even volume and DJ transitions. It all lives in `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer`. The screens only talk to `Player`.

The rules are the web player's (`apps/web/src/player`), ported file for file where they can be. The mixing itself (mix maps, plans, rendering) is the server's, and is described in [How Playarr mixes songs](../mixing.md). For the server's `/stream` and levelled streams, see [Streaming and art](../server/streaming-and-art.md). Downloads and offline playback are in [offline.md](offline.md).

---

## 1. Who does what

- **`Player`** (`Player.swift`, `@MainActor @Observable`): the queue (`QueueState`, a port of the web's `store.ts`) and its 10 Hz clock. Every change goes through a method on it, which edits `queue` and then `sync()`s everything else: the engine, levels, transitions, radio, keep-ahead, Now Playing and the saved queue (`queue.json`, written every 5 s and on close). The 5 s save notes where to resume past `queue`'s observation (`_queue`), since no view shows it: a change to `queue` redraws every view of the queue, and a redraw closes any menu open on one.
- **`Player.live`** (`PlayerLive.swift`): the player as the app runs it, with `NowPlayingBridge`, `AudioSessionController`, `NetworkMonitor`, the background download session and app-life notifications wired in.
- **`AudioEngine`** (`AudioEngine.swift`, `@MainActor`): the AVAudioEngine graph and everything placed on its timeline.
- **`Deck`** (`Deck.swift`): one player node fed from one `PCMSource`.
- **`TrackSource`** (`TrackSource.swift`, an actor): a song's audio from any frame.
- **`StreamCache`** (`StreamCache.swift`, an actor): song files on disk.

Decoding happens in the sources' actors. Blocks reach the main actor as `PCMBlock` (two `[Float]`, `PCMBlock.swift`). The render thread runs none of our code: it only plays buffers already scheduled.

## 2. The graph and the one clock

```
Deck A ─ mixer ┐
Deck B ─ mixer ├─ bus mixer ─ EQ (bypassed) ─ peak limiter ─ main mixer ─ out
Transition ─ mixer ┘
```

- Every node plays `EngineFormat.av`: 44.1 kHz stereo Float32 (`EngineFormat.swift`). Songs at other rates or widths are converted as they're decoded. 44.1 kHz is also the rate of the server's levelled WAV, so an engine frame is a frame of that stream. The main mixer converts to the hardware rate.
- **Epochs.** The three player nodes are started together, 50 ms ahead at one host time (`startNodes`). Their player timelines are then one sample clock (`SampleTime`), and every buffer is scheduled at an exact sample on it. Stopping a node resets its clock, so a deck never stops alone. Anything that would need scheduled audio taken back starts a **new epoch** (`resetEpoch`): all nodes stopped, rescheduled from sample 0 and started together. That covers seeking, loading another song, an output change, a missed buffer and changing a join already placed.
- **Gains in the PCM.** A song's level and its fades are multiplied into each block before it's scheduled (`GainEnvelope.swift`, equal-power `sin`/`cos` curves). They're exact to the sample, and they can go above 0 dB, which a mixer's volume can't. Only unpredictable changes go to the bus mixer's volume: the volume slider (squared), mute and the sleep timer's fade, set on every tick.
- **The limiter.** Apple's `kAudioUnitSubType_PeakLimiter` with +1 dB pre-gain, then the main mixer at −1 dB. Music below the ceiling passes unchanged and peaks stay under −1 dBFS. It only catches album gains and overlaps: the server's gains already respect the ceiling.

## 3. Where a song's audio comes from

`TrackSource` picks its way at the first read:

1. **A file kept elsewhere** (`Origin.kept`, a download's transition continuation): decoded from there.
2. **The whole file in the stream cache**: `FileDecoder` (`AVAudioFile` plus one `AVAudioConverter`), which seeks exactly.
3. **From the start**: the file's `Download`, decoded as it arrives by `StreamDecoder` (AudioFileStream plus one converter). It handles FLAC, MP3 and AAC (ADTS, or M4A with its index first), and trims MP3/AAC priming and padding from the packet table, so joins stay gapless.
4. **From a later frame, the song measured**: the server's `levelled.wav?gain=0` from byte `44 + frame × 4` (`LevelledWAV.swift`), exact to the sample. The file's own download carries on for next time.
5. **From a later frame, not measured**: the file from its start, decoding and dropping frames up to the seek.

A format the decoder can't stream (WAV, Ogg, M4A with its index last) plays from the levelled stream if there is one, else once downloaded whole.

`Download` (`Download.swift`) fetches one file over HTTP, readable while it arrives. A broken connection is asked again from the byte it stopped at (`Range: bytes=N-`), 3 times per file, 1 s apart. After that, `PlaybackError.diagnose` asks for `bytes=0-1` to tell the server's refusal (its own message) from a file that broke off, won't decode or isn't supported, or a server out of reach. Each case gets the web's words (`PlaybackError.swift`).

**Files.** Each server and account has its own folder, `Application Support/Playarr/<serverId>/<accountId>/` (`OfflineFolder`). Inside it:

- `stream/<fileId>.<ext>`: song files, with `.part` while incomplete.
- `stream/levelled-<uuid>.wav`: a seek's levelled stream, deleted when its source closes.
- `stream/transition-<name>`: transition files the player fetched.
- `stream/-<hash>.flac`: an MP3's continuation (see §5), filed under a negative file id made from its URL (`Track+Continuation.swift`).

The cache keeps the least recently played under 1 GB until `DownloadStore` takes over its books. From then on the store decides which songs go, and the 1 GB limit only applies to the player's transition files (see [offline.md](offline.md)).

## 4. Items and joins

An `EngineItem` (`EngineItem.swift`) is one play of a song: a fresh id, the track, its gain in dB, where it starts, and optionally a `Continuation`. `setUpcoming(_:join:)` says what plays next and how (`Join`):

- `.crossfade(seconds:)`: 0 means gapless. Otherwise the two songs overlap with equal-power fades. `JoinRules.fadeSeconds` never fades songs of one album in order, and never for more than a third of either song. Repeat one joins a song to itself, gapless.
- `.transition`, `.cut` and `.mix`: DJ mix only (§5).

How a join is placed (`Tuning` in `AudioEngine.swift`):

- The next song is cued (decoding, not placed) from `preload` = 30 s before the current one ends, or before a DJ join's leave time.
- A crossfade is placed as soon as the current song's end is known: its source returned nil. The ramp starts at `max(end − fade, what's already scheduled, now + startMargin)`, so a fade is shortened rather than misplaced.
- A deck holds back its last `min(maxFade = 12 s, duration ÷ 3)` near the expected end until the end is known, so a fade out can still be applied.
- Decks schedule `scheduleAhead` = 10 s ahead (2.5 s with DJ mix, `Player.djScheduleAhead`), in 0.5 s blocks.
- A load starts playing once 2 s (`highWater`) are scheduled.
- **Running short.** Under 0.5 s (`lowWater`) scheduled ahead, the whole AVAudioEngine pauses (`.buffering`) until 2 s are ready again. A slow network is heard as a pause, never as decks drifting apart. A deck already behind `now` reloads the song where it is (a new epoch), because the nodes drop late buffers.
- The engine reports `.advanced` (the next item took over), `.ended`, `.failed` and `.mixMissed` to the Player.

## 5. DJ mix

With Settings → Playback → Transitions on DJ mix (`PlaybackSettings.transitions == .dj`), the Player asks for a server transition into the next song. It plays the transition when it's here, and otherwise mixes or cuts on its own.

- **`TransitionPlanner`** asks `POST /api/transitions`, following the web's `transitions.ts` rule for rule:
  - only once the song has played `minPlayed` = 5 s, and 2 s after the pair settles;
  - while the server renders, again every 3 s, then every 10 s after 5 polls or while paused;
  - errors (connection lost, 429, 5xx): again after 3 s, then every 10 s; any other 4xx gives up;
  - "unavailable": asked once more after 60 s;
  - gives up 20 s before the mix point;
  - a ready answer survives a seek that lands at least 1 s before its mix point.

  Offline it asks nothing. The pair carries the gains the songs play at, so the server renders at those levels. `kept` and `onPairChange` are hooks for downloads ([offline.md](offline.md)).
- **`TransitionCoordinator`** downloads a ready answer's file whole, before the mix point, never as it plays. A kept copy comes first, then the stream cache. Its `mixSoon` = 3 s is how long a press of Next waits for a mix already coming.
- **`MixMapStore`** keeps the songs' mix maps (`POST /api/mix-maps`, 50 to a request). A map counts as fresh for 60 s. What's on screen is asked again every 30 s, 10 times at most, while a map is missing or out of date.
- **`DJJoin.decide`** picks the join from what's known:
  - **`.transition`**: a ready answer whose file is on the device, more than 1 s before its mix point.
  - **`.cut`**: the server's straight on, as a cut where the songs' sounds end and start.
  - **`.mix`**: a fade, or a quick mix whose stretch of B is within 2.1% (`liveStretch`), played live from the plan.
  - Anything else falls back to a cut on the beat, then a silence cut (`MixSequence`), then gapless. A long blend is never played live: varispeed over its stretch would be heard as pitch.

  Within an album in order, in a queue playing that album or its artist (`DJJoin.playsAlbum`), the request says `albumQueue` and the phone's own cuts leave the songs alone.

**Placing a DJ join** (`placeMix`). It's placed as late as possible: once its start is within `scheduleAhead + block` of now. Until then it can change without a new epoch.

- **A transition** (`TransitionJoin`, `TransitionFileSource`). A is cut in the middle of the file's lead, where both files hold the same sound, or as soon after it as can still be. The file plays on the transition node from the cut to the end of its body. B starts on the sample after that, from `bResume`. If the levels changed since the render, the file is turned by `MixSequence.bridgeGain`.
- **The continuation.** For an MP3, B runs on from the server's `continuationUrl`, which follows on from the transition sample for sample. Another decoder couldn't start an MP3 at an exact sample. Only a `.flac` continuation is used, because it streams as it downloads.
- **A live mix.** `DeckAutomation` runs the plan's gain curves and filters into each block as it's scheduled. `MixFilter` is the renderer's 250 Hz low shelf and A's high-pass sweep, redesigned every 128 samples. A stretched B is resampled by `VarispeedSource` (Catmull-Rom at the plan's `bRate`), so it lands exactly on `bResume`. `AVAudioUnitTimePitch` was rejected: its latency and rate changes aren't sample-exact.
- **A cut.** A stops and B starts on the same sample.
- **Changeover.** The queue, Now Playing and the lock screen move on at the plan's `switchAt`. `engine.position` shows A's time until then, and B's after.
- **Too late.** If B isn't decoded in time, A's scheduling is held at the join while B gets ready, until the join is 0.7 s away (`lowWater + startMargin + 0.1`). The join is then missed (`.mixMissed`): B follows gapless, and that item isn't mixed again.
- **A new epoch abandons a mix.** The song shown plays on alone, and the next joins gapless. The phone doesn't seek inside a transition.

**A press of Next** (`Player.takeNextPress`). With DJ mix on, playing, mixing on, not repeat one, no sleep-timer end of song and no mix under way:

- A mix into that song starting within 3 s is waited for.
- Otherwise `SkipPlanner` (a port of `skipPlan` in `packages/mix/src/plan.ts`) plans one from `time + scheduleAhead + block + 0.25 s`. Both beats sure gives a quick mix on A's next bar, with a 4-beat lead-in (2 when that lands a bar sooner). Otherwise it's a 2.5 s crossfade, or straight on.
- A second press, a straight plan or missing maps: the queue moves on at once. The play report says skipped.

`apps/ios/scripts/mix-fixtures.mjs` runs the TypeScript originals and writes their answers to `Tests/PlayarrPlayerTests/Support/MixFixtures.generated.swift`. The Swift ports (`SkipPlanner`, `MixSequence`, the curves) are tested against them.

## 6. Even volume

`LevelStore` asks `POST /api/levels` for songs it doesn't know: 50 to a request, each song at most every 15 s. `JoinRules.levelDb` uses the album's level when the song before or after it in play order is its neighbour on the album (an album played in order keeps its quiet and loud songs), else the track's. The gain goes into `EngineItem.gainDb`, and from there into the PCM. A measured song seeks through the levelled stream at gain 0, and the phone applies the gain itself. Downloads keep their songs' levels, so they play levelled offline.

## 7. Keeping ahead

`KeepAhead.plan` (the web's `loadAhead.ts`), after the queue has been still for 2.5 s:

- **Wi-Fi**: the next 3 songs, then the current one.
- **Mobile data**: the next 1.
- **Low Data Mode or offline**: none.
- **Repeat one**: the current song first.
- **Limit Off**: nothing.

The stream cache fetches the plan one file at a time. What plays now and next is protected from eviction. Details: [offline.md](offline.md).

## 8. The lock screen and remote commands

`NowPlayingBridge` publishes title, artist, album, duration, elapsed time and rate to `MPNowPlayingInfoCenter`, with 512 px artwork from the server. It's updated on play, pause, seek and song changes; the system extrapolates in between. It takes these commands: play, pause, toggle, next, previous (restart past 3 s), seek (`changePlaybackPosition`), stop (pauses) and like (toggles the favorite, when the app supplies it). `Player.shutDown()` (switching account) unregisters them, so the next account's player owns them.

## 9. The audio session

`AudioSessionController` (iOS only) sets category `.playback`, mode `.default`, when playing starts. Background audio comes from `UIBackgroundModes` = `audio` in `apps/ios/Config/Info.plist`. `SessionPolicy` decides the answers:

- **Interruption began**: pause, remembering whether music was playing.
- **Interruption ended**: resume only if the system says `shouldResume` and music was playing. That's a new epoch from where it was.
- **Old device unavailable** (headphones out, a speaker gone): pause.
- **Media services reset**: a new engine, playing on from where it was.
- **Output changed** (`AVAudioEngineConfigurationChange`, which stops the engine): the engine reloads the current song where it is.

## 10. Play reports

`PlayTracker` reports a song when it stops being the current one:

- It counts only time heard; seeks don't count.
- A play is 30 s heard, or half of a shorter song.
- A skip is leaving it for another song after at least 3 s.
- Closing the app reports the song so far, never as a skip.

`PlayReportQueue` sends one request at a time. What can't go waits in `pending-plays.json` (at most 300) and is tried again at launch and when the network comes back. "Count what this device plays" off sends nothing.

## 11. The sleep timer

`SleepTimer`: stop after some minutes, fading the bus over the last 20 s, or at the end of the song. With "end of song", nothing is asked and no mix is placed. A mix already placed plays out, and the music pauses where it ends, with the next song shown (`pauseAtMixEnd`).

## 12. Previews and the Player lab

Edit mix points' "Play from" plays 8 s (`Player.previewSeconds`) on a second engine while the queue waits paused (`PreviewSession`). Previews are never reported. Debug builds have a Player lab in Settings (`PlayarrUI/PlayerLabView.swift`): play an album by id and watch the decks, buffer and gains.

## 13. Stats for nerds

Settings → Appearance → Stats for nerds shows a panel over the app: `PlayarrUI/StatsForNerds/` (`StatsForNerdsOverlay`, `NerdStats`, a port of the web's `StatsForNerds.tsx`). Its groups are Song, Playback, Rhythm, Structure, Loudness, Sound and Next. In Playback, there are no `<audio>` elements to show, so it shows:

- what's heard: its own file levelled at a gain, the server's transition, a live mix, or the continuation;
- each deck's decoded and scheduled seconds;
- each changeover's `MixReport`: the way it was made, the timeline sample, and how far ahead it was scheduled.

## 14. Tests

`swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer`. Engine tests render the real graph offline on the Mac (`AudioEngine(manualRendering: true)`). DJ joins are checked to the sample with a tag channel (`Support/TransitionFiles.swift`). Session code is `#if os(iOS)`, and its decisions (`SessionPolicy`) are tested on the Mac.
