# Native iOS app, Phase 3: Audio Engine Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** `PlayarrPlayer` plays a queue of real songs from a Playarr server: gapless, levelled up and down with a limiter at −1 dBFS, crossfaded (Settings: 0, 3, 6, 9 or 12 s; never within an album played in order), with shuffle and repeat, seeking anywhere (beyond what's downloaded too), lock-screen controls and Now Playing, interruptions and route changes handled, play reports sent, radio continuation, the sleep timer's 20 s fade, and the queue kept across launches. A debug-only "Player lab" screen plays an album by id and shows the decks, the buffer and the gains.

**Architecture:** `AVAudioEngine` with three `AVAudioPlayerNode`s (decks A and B taking turns, and a transition node for phase 5), each into its own `AVAudioMixerNode`, then a bus mixer, an `AVAudioUnitEQ` (flat, bypassed until phase 5), Apple's peak limiter and the main mixer. All nodes play 44.1 kHz stereo float and are started together, so their player timelines are one sample clock (an "epoch"); every buffer is scheduled at an exact sample on it. Songs' gains and fades are multiplied into the PCM before scheduling (sample-exact, and above 0 dB). `TrackSource` (an actor) downloads a song's own file into a per-account cache with range requests and decodes it as it arrives (`AudioFileStream` + one `AVAudioConverter`), or plays the server's `levelled.wav?gain=0` from the exact byte of a seek past the download. `Player` (`@MainActor @Observable`) holds the queue, a port of `apps/web/src/player/store.ts`, and keeps the engine, `LevelStore`, `PlayTracker`, radio, `SleepTimer`, `NowPlayingBridge` and the stream cache in step with it.

**Tech Stack:** Swift 6.2 language mode with strict concurrency (written and checked with Xcode 27.2 / Swift 6.4 on macOS 26), AVFAudio (`AVAudioEngine`, `AVAudioPlayerNode`, `AVAudioMixerNode`, `AVAudioUnitEQ`, `AVAudioUnitEffect` with `kAudioUnitSubType_PeakLimiter`, `AVAudioConverter`, `AVAudioFile`, `AVAudioSession`), AudioToolbox (`AudioFileStream`), MediaPlayer, Network (`NWPathMonitor`), Accelerate (vDSP), Synchronization (`Mutex`), Observation, SwiftUI (the lab), Swift Testing. No third-party packages.

**Design:** [2026-11-03-ios-app-design.md](2026-11-03-ios-app-design.md), section 3 ("Audio engine"; section 4 for what phase 7 adds). Names and layout: [2026-11-03-ios-conventions.md](2026-11-03-ios-conventions.md). Rules to port: [2026-11-03-ios-parity-inventory.md](2026-11-03-ios-parity-inventory.md), section 4.

---

## Conventions

- Run everything from the repo root, `/Users/bortignon/dev/playarr`.
- The player's tests: `swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer` (one suite: add `--filter QueueStateTests`). `--disable-sandbox` because SwiftPM's own sandbox can't start inside Claude's shell (`sandbox_apply: Operation not permitted`); the Makefile passes it too. Everything (scripts, the three packages, the app's UI tests on a simulator): `make -C apps/ios test` (`corepack pnpm ios:test`).
- AVAudioEngine exists on macOS, so engine tests run in `swift test` on the Mac, rendering the real graph offline (`enableManualRenderingMode(.offline, …)`). `AVAudioSession` code is `#if os(iOS)`; its decisions live in `SessionPolicy`, tested on the Mac.
- Swift: 2-space indentation like phase 0's files; one primary type per file, named after it; no force unwraps outside tests; user-facing text in the web's words.
- Commit after every task, on `main`, only that task's files, with the message given (plain English, no prefixes, ending with the `Co-Authored-By` line). The pre-commit hook bumps the version: never bypass it. The user pushes.

## Before you start

Phase 0 is in the tree (`apps/ios`, the Makefile, the three packages with a placeholder in `PlayarrPlayer`, `UIBackgroundModes` = `audio` in `Config/Info.plist`). **Phase 2 must have landed.** This plan uses these of its names (from `docs/plans/2026-11-03-ios-phase2-api-sign-in.md`):

- Models (generated, `Codable, Hashable, Sendable`, memberwise `public init` with optionals defaulting to nil): `Track` (`id`, `recordingId`, `fileId`, `albumId`, `artistId`, `title`, `artistName`, `albumTitle`, `trackNumber`, `discNumber`, `duration: Double`, `explicit`, `format`, `size`, `streamUrl`, `coverUrl`), `AudioFormat`, `TrackLevel` (`track`, `album?`, `lufs?`, `peak?`), `PlayReport` (`seconds: Double`), `AlbumDetail` (`title`, `tracks`), `MixMode` (`.auto`, `.party`, `.off`, `.unknown(String)`, `allCases` without `unknown`).
- `APIClient.send(_:)`, `API.Playback.levels(ids:)`, `API.Playback.reportPlays(_:)`, `API.Playback.radio(seeds:exclude:count:)`, `API.Library.album(id:)`.
- `MediaURLs.stream(fileId:)`, `.levelled(_:gain:)`, `.art(_:size:)`, `.request(for:)` (the token in the Authorization header), `.baseURL`.
- `ServerStore.activeAccount`, `.client(for:)`, `.mediaURLs(for:)`, `AccountRecord.key` (`serverId`, `accountId`), `AppModel.store`, and `SignedInHomeView(model:)`.

Only `PlayerBackend.swift` (Task 18), `PlayerLabEntry.swift` (Task 20) and the test helper `Songs.swift` (Task 3) spell these out. If phase 2 named something differently, change it there and nowhere else.

---

## Key decisions

**1. Player nodes, with gains and fades in the PCM.** Each deck is an `AVAudioPlayerNode` fed with buffers we decode ourselves. A mixer's `outputVolume` isn't sample-accurate and stops at 1.0, so a song's level (up to +12 dB from `/api/levels`) and crossfade curves are multiplied into each block before it's scheduled (`GainEnvelope`, vDSP). The render thread runs no code of ours: it only plays buffers already scheduled. (An `AVAudioSourceNode` mixing our own ring buffers was the alternative; it puts our code on the render thread, where Swift's allocations and locks don't belong.) Unpredictable changes stay off the PCM: the sleep timer's fade and the volume go to the bus mixer's volume ten times a second, which needs no sample accuracy.

**2. One clock at 44.1 kHz.** Every deck plays `EngineFormat.av` (44.1 kHz stereo Float32). Songs at 48, 88.2 or 96 kHz, 16 or 24 bits, mono or stereo are converted while decoding by the same `AVAudioConverter` that decodes them. 44.1 kHz because most music is, and because the server's levelled WAV is 16-bit stereo at `LOUDNESS_RATE` = 44 100 (`apps/server/src/analysis/loudness.ts`), so a frame of the engine is a frame of the levelled stream: byte `44 + frame × 4`. The main mixer converts to the hardware rate on the way out.

**3. Epochs.** The three nodes are started together (one host time live; before the first render offline), so `playerTime` is the same on all of them and scheduling a buffer at sample S on any node means the same moment. Only stopping a node resets its clock, so a deck never stops alone: seeking, loading another song, an output change, a buffer missed and taking back a join already scheduled all start a new epoch (all nodes stopped, rescheduled from sample 0, started together). A user's seek costs the 2 s of decoding before it starts, as on the web.

**4. Joins.** A song's end is known when its source returns nil. The next song is cued (decoding, not placed) from 30 s before the end (`PRELOAD_S`), and placed at `end − fade` the moment the end is known; the outgoing deck gets the same ramp as a fade out, so the two curves are `sin` and `cos` of one position: equal power at every sample. To keep a fade possible, a deck holds back its last `min(12 s, duration ÷ 3)` near the expected end (from `Track.duration`) until the end is known; if the duration lied and frames were already scheduled, the fade is shortened to what's left, never misplaced. Fade 0 is gapless: the next song's first sample follows the last one's. Repeat one joins the song to itself, gapless.

**5. Running short.** Every tick checks each audible deck's scheduled audio. Under 0.5 s ahead, the engine pauses the whole `AVAudioEngine` (all nodes freeze on the same sample) until 2 s are decoded again: a slow network is a pause, never a drift between decks.

**6. Never schedule late (measured).** On macOS 26, a buffer scheduled at a sample already rendered was dropped entirely after a node had played earlier buffers, and partly played when it hadn't. So the engine never relies on that: it keeps ≥ 0.5 s ahead, places joins at least 0.1 s after `now` (the render thread runs ahead of `lastRenderTime`), and if a deck still ends up behind, it reloads the song where it is (a new epoch).

**7. The limiter.** Apple's peak limiter adds 88 samples of lookahead (2 ms, irrelevant to joins: every node goes through it) and limits at about −0.8 dBFS. With `kLimiterParam_PreGain` +1 dB and the main mixer at −1 dB, music below the ceiling passes as it is (0.5 in, 0.5 out) and a +6 dB over comes out at −1.8 dBFS: under −1 dBFS, as the design asks. The server's gains already respect a −1 dBFS peak ceiling (`apps/server/src/routes/levels.ts`), so the limiter only catches album gains and overlaps.

**8. Streaming.** `TrackSource` picks its way at the first read: the whole file in the cache → `FileDecoder` (`AVAudioFile`, exact seek); from the start → the file's `Download`, decoded progressively by `StreamDecoder`; from a later frame with the song measured → `levelled.wav?gain=0` from byte `44 + frame × 4` (exact, the server decodes from that sample) while the file's download carries on for next time; from a later frame not measured → the file from its start, decoding and dropping up to the frame. A format AudioFileStream can't stream (Ogg, WAV, M4A with its index last) plays from the levelled stream, else once downloaded whole. A connection that breaks is asked again from the byte it stopped at, 3 times per song (`STREAM_RETRIES`); after that, the failure is explained with the web's messages (a `Range: bytes=0-1` probe, as `reportError`).

**9. Concurrency, Swift 6.** UI-facing state is `@MainActor @Observable`. `AudioEngine` and `Deck` are `@MainActor`: scheduling is cheap and happens twice a second per deck. Decoding happens inside `TrackSource`, an actor; blocks cross to the main actor as `PCMBlock`, a value of two `[Float]` (Sendable, unlike `AVAudioPCMBuffer`). `Download` is called by URLSession's delegate queue and read by tasks: all its state is in a `Mutex` (a checked `Sendable`, no `@unchecked`), and waiting readers are continuations resumed outside the lock, cancellable. `StreamDecoder` gets AudioFileStream's C callbacks through an `Unmanaged` context pointer; the callbacks run synchronously inside `AudioFileStreamParseBytes`, on its owner's executor, so it needs no lock and stays a plain non-Sendable class owned by one actor. The only `@unchecked Sendable` is in tests (the `URLProtocol` stub), with a comment.

**10. The phase 5 seam.** Transition files are scheduled on the third node, sample-aligned with a deck: `timelineSample(of: itemID, songFrame:)` turns a frame of a placed song (e.g. A's `aStart − lead`) into a timeline sample, and `scheduleTransition(_:at:envelope:)` plays any `PCMSource` on the transition node from that sample, on the same epoch. A `GainEnvelope` with a zero-length fade out is a cut at a sample. Phase 5 adds a `Join.transition(...)` case that places B's own file (or its `continuationUrl`) at the transition's `plan.length`, from `bResume`, with `Deck.place(at:)` and a source opened at that frame, and cuts A with `setFadeOut(Ramp(start: cut, frames: 0))`. The rule to keep: the transition node must have played out its previous file before the next one is scheduled (a node's queued buffers can only be cleared by a new epoch). Task 15 tests the seam: a click scheduled at A's frame 30 000 comes out exactly at A's frame 30 000.

**11. Checked before writing.** On macOS 26 with Xcode 27.2: FLAC parsed by AudioFileStream in 997-byte chunks decodes to exactly the encoder's samples once the last packet is flushed with an empty `AudioFileStreamParseBytes` call (it holds the last packet back otherwise); one `AVAudioConverter` decodes, resamples 48 → 44.1 kHz with an exact frame total, and plays a mono file in both channels; offline renders show sample-exact joins; `AVAudioEngine.pause()`/`start()` keeps nodes aligned. All the code below was compiled under Swift 6 strict concurrency for macOS 26 and the iOS 26 Simulator against stand-ins carrying phase 2's names, and its 101 tests passed in repeated runs, rebuilt task by task from this document.

---

### Task 0: Check the starting point

**Files:** none.

**Step 1: Phase 2's names are there**

```bash
grep -n "public static func levels\|public static func reportPlays\|public static func radio" apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/Endpoints/API+Playback.swift
grep -n "public func stream(fileId\|public func levelled\|public func art\|public func request(for" apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/MediaURLs.swift
grep -n "public struct Track:\|public enum MixMode\|public struct PlayReport:" apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/Models.generated.swift
grep -n "public func mediaURLs(for\|public func client(for\|public var activeAccount" apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/ServerStore.swift
```

Expected: each grep prints its lines. If one is missing, phase 2 isn't done: stop and say so. If a name differs, note it for Tasks 3, 18 and 20.

**Step 2: The packages build and test**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrAPI
```

Expected: both pass (the player package has only phase 0's placeholder test).

### Task 1: The engine's format and PCM blocks

The one format every deck plays, and the `Sendable` value decoded audio travels in.

**Files:**
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/EngineFormat.swift`
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PCMBlock.swift`
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PCMSource.swift`
- Test: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/PCMBlockTests.swift`
- Delete: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PlayerPlaceholder.swift`
- Delete: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/PlayerPlaceholderTests.swift`

**Step 1: Write the failing test**

Delete phase 0's placeholder (its own comment says phase 3 removes it):

```bash
git rm -q apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PlayerPlaceholder.swift apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/PlayerPlaceholderTests.swift
```

`apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/PCMBlockTests.swift`:

```swift
import AVFoundation
import Testing
@testable import PlayarrPlayer

struct PCMBlockTests {
  @Test func goesToAnEngineBufferAndBack() throws {
    let block = PCMBlock(left: [0.1, 0.2, 0.3], right: [-0.1, -0.2, -0.3])
    let buffer = try #require(block.makeBuffer())
    #expect(buffer.format == EngineFormat.av)
    #expect(buffer.frameLength == 3)
    #expect(PCMBlock(buffer) == block)
  }

  @Test func slicesAndDrops() {
    let block = PCMBlock(left: [1, 2, 3, 4], right: [5, 6, 7, 8])
    #expect(block.slice(1..<3) == PCMBlock(left: [2, 3], right: [6, 7]))
    #expect(block.dropping(3) == PCMBlock(left: [4], right: [8]))
    #expect(block.dropping(9).frames == 0)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter PCMBlockTests
```

Expected: the build fails with `cannot find 'PCMBlock' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/EngineFormat.swift`:

```swift
import AVFoundation

/// A position on the engine's sample clock: frames at `EngineFormat.sampleRate` since the current epoch began
/// (the last time the decks were started together, see `AudioEngine`).
public typealias SampleTime = Int64

/// The one format every deck plays: 44.1 kHz stereo Float32, non-interleaved. Songs at other rates and widths
/// are converted as they're decoded, so all decks share one sample clock. 44.1 kHz because most music is at that
/// rate and so are the server's levelled streams (`LOUDNESS_RATE`), so a seek into one needs no conversion. The
/// main mixer converts to the hardware's rate (often 48 kHz) on the way out.
public enum EngineFormat {
  public static let sampleRate: Double = 44_100
  public static let channelCount: AVAudioChannelCount = 2
  public static let av: AVAudioFormat = {
    guard let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: channelCount) else {
      preconditionFailure("44.1 kHz stereo float is always a valid format")
    }
    return format
  }()

  public static func frames(_ seconds: Double) -> Int64 { Int64((seconds * sampleRate).rounded()) }
  public static func seconds(_ frames: Int64) -> Double { Double(frames) / sampleRate }
}
```

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PCMBlock.swift`:

```swift
import AVFoundation
import Accelerate

/// Decoded audio in the engine's format, as plain arrays: a value that crosses from a decoder's actor to the
/// engine on the main actor without sharing memory (`AVAudioPCMBuffer` isn't `Sendable`).
public struct PCMBlock: Sendable, Equatable {
  public var left: [Float]
  public var right: [Float]

  public init(left: [Float], right: [Float]) {
    precondition(left.count == right.count, "both channels hold the same number of frames")
    self.left = left
    self.right = right
  }

  public static func silence(frames: Int) -> PCMBlock {
    PCMBlock(left: [Float](repeating: 0, count: frames), right: [Float](repeating: 0, count: frames))
  }

  public var frames: Int { left.count }

  /// Frames `range` of this block.
  public func slice(_ range: Range<Int>) -> PCMBlock {
    PCMBlock(left: Array(left[range]), right: Array(right[range]))
  }

  /// The frames after the first `count`.
  public func dropping(_ count: Int) -> PCMBlock { slice(min(count, frames)..<frames) }

  public mutating func scale(by gain: Float) {
    guard gain != 1 else { return }
    left = vDSP.multiply(gain, left)
    right = vDSP.multiply(gain, right)
  }

  /// Multiplies frame `i` by `gains[i]`.
  public mutating func scale(by gains: [Float]) {
    precondition(gains.count == frames)
    left = vDSP.multiply(left, gains)
    right = vDSP.multiply(right, gains)
  }

  /// A copy of an engine-format buffer (a mono buffer is heard in both ears).
  public init(_ buffer: AVAudioPCMBuffer) {
    let n = Int(buffer.frameLength)
    guard let data = buffer.floatChannelData, n > 0 else {
      self.init(left: [], right: [])
      return
    }
    let l = Array(UnsafeBufferPointer(start: data[0], count: n))
    let r = buffer.format.channelCount > 1 ? Array(UnsafeBufferPointer(start: data[1], count: n)) : l
    self.init(left: l, right: r)
  }

  /// An engine-format buffer holding these frames, for a player node.
  public func makeBuffer() -> AVAudioPCMBuffer? {
    guard frames > 0,
      let buffer = AVAudioPCMBuffer(pcmFormat: EngineFormat.av, frameCapacity: AVAudioFrameCount(frames)),
      let data = buffer.floatChannelData
    else { return nil }
    buffer.frameLength = AVAudioFrameCount(frames)
    for (channel, samples) in [left, right].enumerated() {
      samples.withUnsafeBufferPointer { source in
        if let base = source.baseAddress { data[channel].update(from: base, count: frames) }
      }
    }
    return buffer
  }
}
```

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PCMSource.swift`:

```swift
/// Where a deck gets its audio: a song's own file, its levelled stream, a transition file, or (in tests) a
/// synthetic signal. Reads come in order; each returns the next frames in `EngineFormat`.
public protocol PCMSource: Sendable {
  /// Up to `maxFrames` frames, waiting for the network as needed; nil once the audio has ended.
  func read(maxFrames: Int) async throws -> PCMBlock?
  /// Stop downloading and decoding. Later reads return nil.
  func close() async
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter PCMBlockTests
```

Expected: `Test run with 2 tests` … `passed`.

**Step 5: Commit**

The placeholder's removal was staged by `git rm` in Step 1 and goes in this commit.

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/EngineFormat.swift \
  apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PCMBlock.swift \
  apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PCMSource.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/PCMBlockTests.swift
git commit -F - <<'EOF'
Add the player's audio format and PCM blocks

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

### Task 2: Gain envelopes: levels up and down, equal-power fades

A deck's gain for each sample: the song's level times a fade in and a fade out, applied to the PCM. `fadeCurve` is the web's (`decks.ts`).

**Files:**
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/GainEnvelope.swift`
- Test: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/GainEnvelopeTests.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/GainEnvelopeTests.swift`:

```swift
import Foundation
import Testing
@testable import PlayarrPlayer

struct GainEnvelopeTests {
  @Test func theFadeCurveIsEqualPower() {
    #expect(fadeCurve(0) == 0)
    #expect(fadeCurve(1) == 1)
    #expect(abs(fadeCurve(0.5) - 0.5.squareRoot()) < 1e-12)
    for x in stride(from: 0.0, through: 1.0, by: 0.05) {
      let power = fadeCurve(x) * fadeCurve(x) + fadeCurve(1 - x) * fadeCurve(1 - x)
      #expect(abs(power - 1) < 1e-12)
    }
  }

  @Test func aCrossfadeKeepsThePowerSteadyAtEverySample() {
    let ramp = Ramp(start: 1000, frames: 441)
    let outgoing = GainEnvelope(fadeOut: ramp)
    let incoming = GainEnvelope(fadeIn: ramp)
    #expect(outgoing.value(at: 999) == 1)
    #expect(incoming.value(at: 999) == 0)
    for t in ramp.start..<ramp.end {
      let a = Double(outgoing.value(at: t)), b = Double(incoming.value(at: t))
      #expect(abs(a * a + b * b - 1) < 1e-5)
    }
    #expect(outgoing.value(at: ramp.end) == 0)
    #expect(incoming.value(at: ramp.end) == 1)
  }

  @Test func gainsGoUpAsWellAsDown() {
    #expect(abs(GainEnvelope(gainDb: 6).gain - 1.9953) < 1e-3)
    #expect(abs(GainEnvelope(gainDb: -6).gain - 0.5012) < 1e-3)
    var block = PCMBlock(left: [0.25, 0.25], right: [0.1, 0.1])
    GainEnvelope(gainDb: 6).apply(to: &block, at: 0)
    #expect(abs(block.left[0] - 0.4988) < 1e-3)
    #expect(abs(block.right[1] - 0.1995) < 1e-3)
  }

  @Test func aFadeIsAppliedSampleBySampleWhereABlockMeetsIt() {
    var block = PCMBlock(left: [Float](repeating: 1, count: 10), right: [Float](repeating: 1, count: 10))
    let envelope = GainEnvelope(gainDb: 0, fadeOut: Ramp(start: 105, frames: 4))
    envelope.apply(to: &block, at: 100)
    #expect(Array(block.left.prefix(5)) == [1, 1, 1, 1, 1])
    #expect(block.left[5] == 1)
    #expect(abs(block.left[6] - Float(fadeCurve(0.75))) < 1e-6)
    #expect(Array(block.left.suffix(1)) == [0])
  }

  @Test func aZeroLengthFadeOutIsACut() {
    let cut = GainEnvelope(fadeOut: Ramp(start: 50, frames: 0))
    #expect(cut.value(at: 49) == 1)
    #expect(cut.value(at: 50) == 0)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter GainEnvelopeTests
```

Expected: the build fails with `cannot find 'fadeCurve' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/GainEnvelope.swift`:

```swift
import Foundation

/// Equal-power fade: `x` from 0 (silent) to 1 (full). As `fadeCurve` in apps/web/src/player/decks.ts.
public func fadeCurve(_ x: Double) -> Double { sin(min(1, max(0, x)) * .pi / 2) }

/// A stretch of the timeline over which a fade runs.
public struct Ramp: Sendable, Equatable {
  public var start: SampleTime
  public var frames: Int64
  public init(start: SampleTime, frames: Int64) {
    self.start = start
    self.frames = frames
  }
  public var end: SampleTime { start + frames }
}

/// How loud a deck plays each sample: its song's level (up as well as down), times a fade in at its start and a
/// fade out at its end. Applied to the PCM before it is scheduled, so fades and gains are exact to the sample
/// (a mixer's volume isn't) and gains above 0 dB work.
public struct GainEnvelope: Sendable, Equatable {
  public var gain: Float
  /// Rising from silence to full over the ramp; silent before it.
  public var fadeIn: Ramp?
  /// Falling from full to silence over the ramp; silent after it. A ramp of 0 frames is a cut.
  public var fadeOut: Ramp?

  public init(gainDb: Double = 0, fadeIn: Ramp? = nil, fadeOut: Ramp? = nil) {
    gain = Float(pow(10, gainDb / 20))
    self.fadeIn = fadeIn
    self.fadeOut = fadeOut
  }

  public func value(at t: SampleTime) -> Float {
    var v = Double(gain)
    if let r = fadeIn, t < r.end {
      v *= r.frames > 0 ? fadeCurve(Double(t - r.start) / Double(r.frames)) : 1
    }
    if let r = fadeOut, t >= r.start {
      v *= r.frames > 0 ? fadeCurve(Double(r.end - t) / Double(r.frames)) : 0
    }
    return Float(v)
  }

  /// Scales `block`, whose first frame plays at timeline sample `start`.
  public func apply(to block: inout PCMBlock, at start: SampleTime) {
    let end = start + Int64(block.frames)
    let fading = (fadeIn.map { start < $0.end } ?? false) || (fadeOut.map { end > $0.start } ?? false)
    guard fading else { return block.scale(by: gain) }
    block.scale(by: (0..<block.frames).map { value(at: start + Int64($0)) })
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter GainEnvelopeTests
```

Expected: `Test run with 5 tests` … `passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/GainEnvelope.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/GainEnvelopeTests.swift
git commit -F - <<'EOF'
Add gain envelopes: levels up and down and equal-power fades, to the sample

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

### Task 3: The queue, ported from store.ts

The web's queue model, rule for rule: `queue` in the order added, `order` as indices into it, `pos` in `order`; shuffle keeps history and shuffles only what's upcoming; repeat off → all → one; Next and the song ending differ under repeat one; previous restarts past 3 s; `playNext` / `addToQueue` / `move` / `removeAt` / `setUpcoming`; persisted fields as `partialize` (`playing`, `restartToken` and `startAt` never saved), an unknown mix mode read as Auto. `takeNextPresses` (a desktop live mix taking a press of Next) is phase 5's and isn't ported. The tests port `store.test.ts` and cover the rules it didn't. `repeat` is a Swift keyword: the property is `repeatMode`, saved under `"repeat"`.

**Files:**
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/QueueState.swift`
- Test: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/QueueStateTests.swift`
- Test support: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/Songs.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/Songs.swift`:

```swift
import PlayarrAPI

/// A song for tests: album 1, disc 1, track number = id, 200 s, FLAC, unless told otherwise.
func song(
  _ id: Int, albumId: Int = 1, artistId: Int = 1, disc: Int = 1, number: Int? = nil, duration: Double = 200,
  container: String = "flac"
) -> Track {
  Track(
    id: id, recordingId: "rec-\(id)", fileId: id, albumId: albumId, artistId: artistId, title: "Song \(id)",
    artistName: "Artist", albumTitle: "Album \(albumId)", trackNumber: number ?? id, discNumber: disc,
    duration: duration, explicit: false,
    format: AudioFormat(codec: container.uppercased(), container: container, lossless: container == "flac"),
    size: 1_000_000, streamUrl: "/stream/\(id)", coverUrl: "/art/album/\(albumId)/cover")
}

/// A repeatable shuffle (SplitMix64), so shuffle tests know the order they get.
struct SeededRandom: RandomNumberGenerator {
  var state: UInt64
  init(_ seed: UInt64) { state = seed }
  mutating func next() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var z = state
    z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
    z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
    return z ^ (z >> 31)
  }
}
```

`apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/QueueStateTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrPlayer

/// Ported from apps/web/src/player/store.test.ts, plus the rules of store.ts that test didn't cover.
struct QueueStateTests {
  let songs = [song(1), song(2), song(3)]

  @Test func startsOnAutoAndKeepsWhatIsPickedWithTheQueue() throws {
    var q = QueueState()
    #expect(q.mixMode == .auto)
    q.playTracks([song(1), song(2)])
    q.mixMode = .party
    let saved = try JSONDecoder().decode(QueueState.self, from: JSONEncoder().encode(q))
    #expect(saved.mixMode == .party)
  }

  @Test func goesBackToAutoWhenSomethingNewIsPlayed() {
    var q = QueueState()
    q.mixMode = .off
    q.playTracks([song(3)])
    #expect(q.mixMode == .auto)
  }

  @Test func staysAsPickedWhenSongsAreAddedToTheQueue() {
    var q = QueueState()
    q.playTracks([song(1)])
    q.mixMode = .party
    q.addToQueue([song(2)])
    q.playNext([song(3)])
    #expect(q.mixMode == .party)
  }

  @Test func startAtIsAskedOnceAndNeverSaved() throws {
    var q = QueueState()
    q.playTracks([song(1), song(2)], at: 30)
    #expect(q.startAt == 30)
    q.jumpTo(1, at: 12)
    #expect(q.startAt == 12)
    let json = try #require(String(data: JSONEncoder().encode(q), encoding: .utf8))
    #expect(!json.contains("startAt"))
    #expect(!json.contains("playing"))
    #expect(!json.contains("restartToken"))
    q.jumpTo(0)
    #expect(q.startAt == nil)
  }

  @Test func savesWhatTheWebSaves() throws {
    var q = QueueState()
    q.playTracks(songs, source: PlaySource(label: "Album 1", href: "/albums/1"))
    q.repeatMode = .all
    q.resumeAt = 42
    let saved = try JSONDecoder().decode(QueueState.self, from: JSONEncoder().encode(q))
    #expect(saved.queue == q.queue)
    #expect(saved.order == q.order)
    #expect(saved.pos == q.pos)
    #expect(saved.repeatMode == .all)
    #expect(saved.resumeAt == 42)
    #expect(saved.source == q.source)
    #expect(saved.playing == false)  // a relaunch never starts playing by itself
  }

  @Test func anUnknownMixModePlaysAsAuto() throws {
    let json = #"{"queue":[],"order":[],"pos":-1,"mixMode":"club"}"#
    let q = try JSONDecoder().decode(QueueState.self, from: Data(json.utf8))
    #expect(q.mixMode == .auto)
  }

  @Test func theSongANextPressGoesTo() {
    var q = QueueState()
    q.queue = songs
    q.order = [0, 1, 2]
    q.pos = 0
    #expect(q.nextByPress?.id == 2)
    q.pos = 2
    #expect(q.nextByPress == nil)
    q.repeatMode = .all
    #expect(q.nextByPress?.id == 1)
    q.pos = 1
    q.repeatMode = .one
    #expect(q.nextByPress?.id == 3)  // Next leaves the song
    q.order = [2, 0, 1]
    q.pos = 0
    q.repeatMode = .off
    #expect(q.nextByPress?.id == 1)  // the play order, not the queue's
    q.pos = 2
    q.repeatMode = .all
    #expect(q.nextByPress?.id == 3)
  }

  @Test func theSongThatPlaysNextOnItsOwn() {
    var q = QueueState()
    q.queue = songs
    q.order = [0, 1, 2]
    q.pos = 1
    #expect(q.upNext?.id == 3)
    q.pos = 2
    #expect(q.upNext == nil)
    q.repeatMode = .all
    #expect(q.upNext?.id == 1)
    q.repeatMode = .one
    #expect(q.upNext == nil)
    q.repeatMode = .all
    q.queue = [song(1)]
    q.order = [0]
    q.pos = 0
    #expect(q.upNext == nil)  // a queue of one with repeat all restarts instead
  }

  @Test func playNextGoesRightAfterTheCurrentSongAndAddToQueueAtTheEnd() {
    var q = QueueState()
    q.playTracks(songs)
    q.playNext([song(9)])
    #expect(q.order == [0, 3, 1, 2])
    q.addToQueue([song(8)])
    #expect(q.order == [0, 3, 1, 2, 4])
    #expect(q.queue.map(\.id) == [1, 2, 3, 9, 8])
  }

  @Test func addingToAnEmptyQueuePlaysIt() {
    var q = QueueState()
    q.addToQueue([song(5)])
    #expect(q.pos == 0)
    #expect(q.playing)
    #expect(q.currentTrack?.id == 5)
  }

  @Test func removingNeverRemovesTheCurrentSongAndKeepsIndices() {
    var q = QueueState()
    q.playTracks(songs, startIndex: 1)
    q.removeAt(1)
    #expect(q.order == [0, 1, 2])
    q.removeAt(0)
    #expect(q.order == [1, 2])
    #expect(q.pos == 0)
    #expect(q.currentTrack?.id == 2)
    #expect(q.queue.count == 3)
  }

  @Test func movingKeepsTheCurrentSongCurrent() {
    var q = QueueState()
    q.playTracks(songs)
    q.move(from: 0, to: 2)
    #expect(q.order == [1, 2, 0])
    #expect(q.pos == 2)
    #expect(q.currentTrack?.id == 1)
  }

  @Test func setAndClearUpcoming() {
    var q = QueueState()
    q.playTracks(songs)
    q.setUpcoming([2, 0, 7, 1])
    #expect(q.order == [0, 2, 1])  // never the current song, never an unknown index
    q.clearUpcoming()
    #expect(q.order == [0])
  }

  @Test func theEndOfTheQueueStopsOnTheLastSong() {
    var q = QueueState()
    q.playTracks(songs, startIndex: 2)
    let token = q.restartToken
    q.next(auto: true)
    #expect(q.pos == 2)
    #expect(!q.playing)
    #expect(q.restartToken == token + 1)
  }

  @Test func repeatOneRestartsWhenTheSongEndsButNextLeavesIt() {
    var q = QueueState()
    q.playTracks(songs)
    q.repeatMode = .one
    let token = q.restartToken
    q.next(auto: true)
    #expect(q.pos == 0)
    #expect(q.restartToken == token + 1)
    q.next()
    #expect(q.pos == 1)
  }

  @Test func repeatAllGoesRoundToTheFirst() {
    var q = QueueState()
    q.playTracks(songs, startIndex: 2)
    q.repeatMode = .all
    q.next(auto: true)
    #expect(q.pos == 0)
    #expect(q.playing)
  }

  @Test func previousRestartsPastThreeSecondsElseGoesBack() {
    var q = QueueState()
    q.playTracks(songs, startIndex: 1)
    let token = q.restartToken
    q.prev(currentTime: 3.5)
    #expect(q.pos == 1)
    #expect(q.restartToken == token + 1)
    q.prev(currentTime: 2)
    #expect(q.pos == 0)
    q.prev(currentTime: 0)
    #expect(q.pos == 0)  // the first song restarts
    #expect(q.restartToken == token + 2)
    q.repeatMode = .all
    q.prev(currentTime: 0)
    #expect(q.pos == 2)  // round to the last
  }

  @Test func shuffleKeepsHistoryAndShufflesOnlyWhatIsUpcoming() {
    var q = QueueState()
    q.playTracks((1...10).map { song($0) }, startIndex: 3)
    var rng = SeededRandom(7)
    q.toggleShuffle(using: &rng)
    #expect(q.shuffle)
    #expect(Array(q.order.prefix(4)) == [0, 1, 2, 3])
    #expect(Set(q.order.dropFirst(4)) == Set(4...9))
    #expect(q.pos == 3)
    q.next()
    let current = q.order[q.pos]
    q.toggleShuffle(using: &rng)
    #expect(!q.shuffle)
    #expect(q.order == Array(0...9))
    #expect(q.order[q.pos] == current)
  }

  @Test func shufflePlayStartsAnywhereAndPlaysEverySongOnce() {
    var q = QueueState()
    var rng = SeededRandom(1)
    q.playTracks((1...10).map { song($0) }, shuffle: true, using: &rng)
    #expect(q.pos == 0)
    #expect(q.shuffle)
    #expect(Set(q.order) == Set(0...9))
  }

  @Test func repeatCyclesOffAllOne() {
    var q = QueueState()
    q.cycleRepeat()
    #expect(q.repeatMode == .all)
    q.cycleRepeat()
    #expect(q.repeatMode == .one)
    q.cycleRepeat()
    #expect(q.repeatMode == .off)
  }

  @Test func volumeIsClampedAndUnmutes() {
    var q = QueueState()
    q.muted = true
    q.setVolume(1.5)
    #expect(q.volume == 1)
    #expect(!q.muted)
    q.setVolume(-1)
    #expect(q.volume == 0)
  }

  @Test func toggleNeedsASong() {
    var q = QueueState()
    q.toggle()
    #expect(!q.playing)
    q.playTracks(songs)
    q.toggle()
    #expect(!q.playing)
  }

  @Test func aDamagedFileStartsEmpty() throws {
    let json = #"{"queue":[],"order":[3],"pos":0}"#
    let q = try JSONDecoder().decode(QueueState.self, from: Data(json.utf8))
    #expect(q == QueueState())
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter QueueStateTests
```

Expected: the build fails with `cannot find 'QueueState' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/QueueState.swift`:

```swift
import PlayarrAPI

public enum RepeatMode: String, Codable, Sendable { case off, all, one }

/// What the queue was started from (an album, a mix, a playlist…), for "Playing from".
public struct PlaySource: Codable, Sendable, Hashable {
  public var label: String
  public var href: String
  public init(label: String, href: String) {
    self.label = label
    self.href = href
  }
}

/// The queue, as `usePlayer` in apps/web/src/player/store.ts: songs in the order added, the play order as indices
/// into them, and the position in that order. Every rule below is ported from there, test by test.
public struct QueueState: Codable, Sendable, Equatable {
  /// Tracks in the order they were added.
  public var queue: [Track] = []
  /// Play order: indices into `queue` (identity unless shuffled).
  public var order: [Int] = []
  /// Position within `order` of the current track, -1 when empty.
  public var pos = -1
  public var shuffle = false
  public var repeatMode: RepeatMode = .off
  public var volume: Double = 1
  public var muted = false
  /// Where to resume after a relaunch.
  public var resumeAt: Double = 0
  /// What the queue was started from; unset, Now Playing shows the song's album.
  public var source: PlaySource?
  /// How this queue is mixed when transitions are DJ mix.
  public var mixMode: MixMode = .auto

  // Not persisted:
  public var playing = false
  /// Bumped to ask the engine to restart the current track (e.g. "previous" near the start).
  public var restartToken = 0
  /// Where the engine starts the song it loads next, once (then nil).
  public var startAt: Double?

  public init() {}

  // MARK: Reading

  public var currentTrack: Track? {
    order.indices.contains(pos) ? queue[order[pos]] : nil
  }

  /// The song a press of Next goes to (repeat one included: Next leaves the song), if any.
  public var nextByPress: Track? {
    guard pos >= 0 else { return nil }
    if pos + 1 < order.count { return queue[order[pos + 1]] }
    return repeatMode == .all && !order.isEmpty ? queue[order[0]] : nil
  }

  /// The song that plays when this one ends on its own; none with repeat one (the song restarts).
  public var upNext: Track? {
    guard pos >= 0, repeatMode != .one else { return nil }
    if pos + 1 < order.count { return queue[order[pos + 1]] }
    return repeatMode == .all && order.count > 1 ? queue[order[0]] : nil
  }

  /// Where `upNext` is in `queue`.
  public var upNextIndex: Int? {
    guard upNext != nil else { return nil }
    return pos + 1 < order.count ? order[pos + 1] : order[0]
  }

  /// The songs after the current one in play order, at most `count` (round to the first with repeat all).
  public func upcoming(_ count: Int) -> [Track] {
    guard pos >= 0, count > 0 else { return [] }
    let after = order.dropFirst(pos + 1) + (repeatMode == .all ? order.prefix(pos) : [])
    return after.prefix(count).map { queue[$0] }
  }

  // MARK: Changing

  /// `at`: start the song there (seconds) instead of its beginning.
  public mutating func playTracks(_ tracks: [Track], startIndex: Int = 0, shuffle: Bool? = nil, source: PlaySource? = nil, at: Double? = nil) {
    var rng = SystemRandomNumberGenerator()
    playTracks(tracks, startIndex: startIndex, shuffle: shuffle, source: source, at: at, using: &rng)
  }

  public mutating func playTracks(
    _ tracks: [Track], startIndex: Int = 0, shuffle: Bool? = nil, source: PlaySource? = nil, at: Double? = nil,
    using rng: inout some RandomNumberGenerator
  ) {
    guard !tracks.isEmpty else { return }
    let shuffled = shuffle ?? self.shuffle
    let start = shuffle == true ? Int.random(in: 0..<tracks.count, using: &rng) : startIndex
    queue = tracks
    order = shuffled ? [start] + Array(0..<tracks.count).filter { $0 != start }.shuffled(using: &rng) : Array(0..<tracks.count)
    pos = shuffled ? 0 : start
    self.shuffle = shuffled
    self.source = source
    // A party mode picked for the last queue shouldn't carry over to something new.
    mixMode = .auto
    playing = true
    resumeAt = 0
    startAt = at
    restartToken += 1
  }

  public mutating func playNext(_ tracks: [Track]) {
    guard pos >= 0 else { return playTracks(tracks) }
    let base = queue.count
    queue += tracks
    order = Array(order.prefix(pos + 1)) + tracks.indices.map { base + $0 } + Array(order.dropFirst(pos + 1))
  }

  public mutating func addToQueue(_ tracks: [Track]) {
    guard pos >= 0 else { return playTracks(tracks) }
    let base = queue.count
    queue += tracks
    order += tracks.indices.map { base + $0 }
  }

  public mutating func jumpTo(_ orderPos: Int, at: Double? = nil) {
    guard order.indices.contains(orderPos) else { return }
    pos = orderPos
    playing = true
    resumeAt = 0
    startAt = at
    restartToken += 1
  }

  public mutating func removeAt(_ orderPos: Int) {
    guard orderPos != pos, order.indices.contains(orderPos) else { return }
    // Leave the track in `queue` (indices stay valid); just drop it from the play order.
    order.remove(at: orderPos)
    if orderPos < pos { pos -= 1 }
  }

  public mutating func move(from fromPos: Int, to toPos: Int) {
    guard fromPos != toPos, order.indices.contains(fromPos), order.indices.contains(toPos) else { return }
    let current = order[pos]
    let item = order.remove(at: fromPos)
    order.insert(item, at: toPos)
    pos = order.firstIndex(of: current) ?? pos
  }

  /// Replace what plays after the current song: indices into `queue`, e.g. reordered or restored.
  public mutating func setUpcoming(_ queueIndices: [Int]) {
    let current = order.indices.contains(pos) ? order[pos] : nil
    let valid = queueIndices.filter { queue.indices.contains($0) && $0 != current }
    order = Array(order.prefix(pos + 1)) + valid
  }

  public mutating func clearUpcoming() {
    order = Array(order.prefix(pos + 1))
  }

  /// On to the next song: `auto` when the song ended (or the engine moved on); a press of Next otherwise.
  public mutating func next(auto: Bool = false) {
    guard auto else { return _ = moveOn() }
    if repeatMode == .one {
      restartToken += 1
      resumeAt = 0
      return
    }
    // End of queue: stop at the last track.
    if !moveOn() {
      playing = false
      resumeAt = 0
      restartToken += 1
    }
  }

  /// Restarts the song if past 3 s (or at the first song without repeat all), else goes back one.
  public mutating func prev(currentTime: Double) {
    if currentTime > 3 || (pos == 0 && repeatMode != .all) {
      restartToken += 1
      resumeAt = 0
      return
    }
    pos = pos > 0 ? pos - 1 : order.count - 1
    playing = true
    resumeAt = 0
  }

  public mutating func toggle() {
    if pos >= 0 { playing.toggle() }
  }

  public mutating func toggleShuffle() {
    var rng = SystemRandomNumberGenerator()
    toggleShuffle(using: &rng)
  }

  public mutating func toggleShuffle(using rng: inout some RandomNumberGenerator) {
    guard pos >= 0 else { return shuffle.toggle() }
    let current = order[pos]
    if !shuffle {
      // Keep history, shuffle only what's upcoming.
      order = Array(order.prefix(pos + 1)) + order.dropFirst(pos + 1).shuffled(using: &rng)
      shuffle = true
    } else {
      // Restore the queue's order, continuing from the current track.
      let kept = Set(order)
      order = queue.indices.filter { kept.contains($0) }
      pos = order.firstIndex(of: current) ?? 0
      shuffle = false
    }
  }

  /// Off → all → one → off.
  public mutating func cycleRepeat() {
    repeatMode = switch repeatMode {
    case .off: .all
    case .all: .one
    case .one: .off
    }
  }

  public mutating func setVolume(_ v: Double) {
    volume = min(1, max(0, v))
    muted = false
  }

  private mutating func moveOn() -> Bool {
    if pos + 1 < order.count {
      pos += 1
    } else if repeatMode == .all && !order.isEmpty {
      pos = 0
    } else {
      return false
    }
    playing = true
    resumeAt = 0
    return true
  }

  // MARK: Saving

  private enum CodingKeys: String, CodingKey {
    case queue, order, pos, shuffle, repeatMode = "repeat", volume, muted, resumeAt, source, mixMode
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    queue = try c.decodeIfPresent([Track].self, forKey: .queue) ?? []
    order = try c.decodeIfPresent([Int].self, forKey: .order) ?? []
    pos = try c.decodeIfPresent(Int.self, forKey: .pos) ?? -1
    shuffle = try c.decodeIfPresent(Bool.self, forKey: .shuffle) ?? false
    repeatMode = (try? c.decodeIfPresent(RepeatMode.self, forKey: .repeatMode)) ?? .off
    volume = try c.decodeIfPresent(Double.self, forKey: .volume) ?? 1
    muted = try c.decodeIfPresent(Bool.self, forKey: .muted) ?? false
    resumeAt = try c.decodeIfPresent(Double.self, forKey: .resumeAt) ?? 0
    source = try c.decodeIfPresent(PlaySource.self, forKey: .source)
    // A mix mode this version doesn't know (or none, from before mixing) plays as Auto.
    let mode = try c.decodeIfPresent(MixMode.self, forKey: .mixMode) ?? .auto
    mixMode = MixMode.allCases.contains(mode) ? mode : .auto
    // A queue whose indices don't fit its songs (a damaged file) starts empty rather than crash.
    if order.contains(where: { !queue.indices.contains($0) }) || (pos != -1 && !order.indices.contains(pos)) {
      self = QueueState()
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(queue, forKey: .queue)
    try c.encode(order, forKey: .order)
    try c.encode(pos, forKey: .pos)
    try c.encode(shuffle, forKey: .shuffle)
    try c.encode(repeatMode, forKey: .repeatMode)
    try c.encode(volume, forKey: .volume)
    try c.encode(muted, forKey: .muted)
    try c.encode(resumeAt, forKey: .resumeAt)
    try c.encodeIfPresent(source, forKey: .source)
    try c.encode(mixMode, forKey: .mixMode)
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter QueueStateTests
```

Expected: `Test run with 23 tests` … `passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/QueueState.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/QueueStateTests.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/Songs.swift
git commit -F - <<'EOF'
Port the web's queue to Swift: order, shuffle keeping history, repeat, previous at 3 s

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

### Task 4: Join rules: album in order, crossfade length, level choice

From `decks.ts`: two songs of one album in order are heard as one (never faded, the album's level); a crossfade is never longer than a third of either song.

**Files:**
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/JoinRules.swift`
- Test: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/JoinRulesTests.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/JoinRulesTests.swift`:

```swift
import PlayarrAPI
import Testing
@testable import PlayarrPlayer

/// Ported from apps/web/src/player/decks.test.ts.
struct JoinRulesTests {
  @Test func neverFadesWithinAnAlbumPlayedInOrderNorForMoreThanAThird() {
    #expect(JoinRules.continues(song(1), song(2)))
    #expect(JoinRules.continues(song(9, disc: 1), song(1, disc: 2)))
    #expect(!JoinRules.continues(song(1), song(3)))
    #expect(JoinRules.fadeSeconds(song(1), song(2), crossfade: 6) == 0)
    #expect(JoinRules.fadeSeconds(song(1), song(3), crossfade: 6) == 6)
    #expect(JoinRules.fadeSeconds(song(1), song(3, duration: 9), crossfade: 6) == 3)
    #expect(JoinRules.fadeSeconds(song(1), song(3), crossfade: 0) == 0)
  }

  @Test func turnsSongsByTheirOwnLevelOrTheAlbumsWithinAnAlbum() {
    var q = QueueState()
    q.queue = [song(1), song(2), song(7, albumId: 2)]
    q.order = [0, 1, 2]
    q.pos = 0
    let level = TrackLevel(track: -6, album: -3)
    #expect(JoinRules.levelDb(song(1), level, in: q) == -3)
    #expect(JoinRules.levelDb(q.queue[2], level, in: q) == -6)
    #expect(JoinRules.levelDb(song(1), TrackLevel(track: -6), in: q) == -6)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter JoinRulesTests
```

Expected: the build fails with `cannot find 'JoinRules' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/JoinRules.swift`:

```swift
import PlayarrAPI

/// How one song goes into the next, as apps/web/src/player/decks.ts decides it.
public enum JoinRules {
  /// `b` is the song after `a` on the same album: the two are heard as one, never faded into each other.
  public static func continues(_ a: Track?, _ b: Track?) -> Bool {
    guard let a, let b, a.albumId == b.albumId else { return false }
    return (b.discNumber == a.discNumber && b.trackNumber == a.trackNumber + 1)
      || (b.discNumber == a.discNumber + 1 && b.trackNumber == 1)
  }

  /// How long `a`'s end and `b`'s start overlap: none within an album, never more than a third of either song.
  public static func fadeSeconds(_ a: Track?, _ b: Track?, crossfade: Double) -> Double {
    guard let a, let b, crossfade > 0, !continues(a, b) else { return 0 }
    return min(crossfade, a.duration / 3, b.duration / 3)
  }

  /// How much to turn a song (dB) so it's as loud as the others. Within an album played in order the album's
  /// level applies, so its quiet songs stay quiet next to its loud ones.
  public static func levelDb(_ track: Track, _ level: TrackLevel, in s: QueueState) -> Double {
    let at = s.order.indices.first { p in abs(p - s.pos) <= 2 && s.queue[s.order[p]].fileId == track.fileId }
    let before = at.flatMap { $0 > 0 ? s.queue[s.order[$0 - 1]] : nil }
    let after = at.flatMap { $0 + 1 < s.order.count ? s.queue[s.order[$0 + 1]] : nil }
    let inAlbum = continues(before, track) || continues(track, after)
    return inAlbum ? level.album ?? level.track : level.track
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter JoinRulesTests
```

Expected: `Test run with 2 tests` … `passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/JoinRules.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/JoinRulesTests.swift
git commit -F - <<'EOF'
Port the join rules: no fade within an album in order, a third of a song at most, the album's level

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

### Task 5: Settings → Playback on the device

Per device as on the web (`lib/prefs.ts`): transitions (Off, Crossfade, DJ mix), crossfade length (0, 3, 6, 9, 12 s), even volume, autoplay, count plays. Only Crossfade fades (`crossfadeSeconds`). Phase 4 builds the screen; the lab uses it now.

**Files:**
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PlaybackSettings.swift`
- Test: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/PlaybackSettingsTests.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/PlaybackSettingsTests.swift`:

```swift
import Foundation
import Testing
@testable import PlayarrPlayer

@MainActor
struct PlaybackSettingsTests {
  @Test func startsAsTheWebDoesAndKeepsWhatIsPicked() {
    let defaults = UserDefaults(suiteName: UUID().uuidString)!
    let settings = PlaybackSettings(defaults: defaults)
    #expect(settings.transitions == .off)
    #expect(settings.crossfade == 0)
    #expect(settings.levelVolume)
    #expect(settings.autoplay)
    #expect(settings.recordPlays)
    settings.transitions = .crossfade
    settings.crossfade = 9
    settings.levelVolume = false
    let again = PlaybackSettings(defaults: defaults)
    #expect(again.crossfadeSeconds == 9)
    #expect(!again.levelVolume)
  }

  @Test func onlyCrossfadeFades() {
    let settings = PlaybackSettings(defaults: UserDefaults(suiteName: UUID().uuidString)!)
    settings.crossfade = 6
    settings.transitions = .dj
    #expect(settings.crossfadeSeconds == 0)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter PlaybackSettingsTests
```

Expected: the build fails with `cannot find 'PlaybackSettings' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PlaybackSettings.swift`:

```swift
import Foundation
import Observation

/// Settings → Playback, per device as on the web (apps/web/src/lib/prefs.ts), kept in UserDefaults.
@MainActor @Observable
public final class PlaybackSettings {
  public enum Transitions: String, Sendable, CaseIterable { case off, crossfade, dj }
  /// The crossfade lengths offered (seconds), as `CROSSFADES` on the web.
  public static let crossfades: [Double] = [0, 3, 6, 9, 12]

  public var transitions: Transitions { didSet { defaults.set(transitions.rawValue, forKey: Key.transitions) } }
  public var crossfade: Double { didSet { defaults.set(crossfade, forKey: Key.crossfade) } }
  /// "Even out the volume".
  public var levelVolume: Bool { didSet { defaults.set(levelVolume, forKey: Key.levelVolume) } }
  /// "Keep playing when the queue ends".
  public var autoplay: Bool { didSet { defaults.set(autoplay, forKey: Key.autoplay) } }
  /// "Count what this device plays".
  public var recordPlays: Bool { didSet { defaults.set(recordPlays, forKey: Key.recordPlays) } }

  @ObservationIgnored private let defaults: UserDefaults

  private enum Key {
    static let transitions = "playback.transitions"
    static let crossfade = "playback.crossfade"
    static let levelVolume = "playback.levelVolume"
    static let autoplay = "playback.autoplay"
    static let recordPlays = "playback.recordPlays"
  }

  public init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    let saved = defaults.double(forKey: Key.crossfade)
    crossfade = Self.crossfades.contains(saved) ? saved : 0
    transitions = defaults.string(forKey: Key.transitions).flatMap(Transitions.init) ?? .off
    levelVolume = defaults.object(forKey: Key.levelVolume) as? Bool ?? true
    autoplay = defaults.object(forKey: Key.autoplay) as? Bool ?? true
    recordPlays = defaults.object(forKey: Key.recordPlays) as? Bool ?? true
  }

  /// Seconds songs overlap on this setting: only Crossfade fades (DJ mix plays gapless until it can mix).
  public var crossfadeSeconds: Double { transitions == .crossfade ? crossfade : 0 }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter PlaybackSettingsTests
```

Expected: `Test run with 2 tests` … `passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PlaybackSettings.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/PlaybackSettingsTests.swift
git commit -F - <<'EOF'
Keep Settings → Playback on the device

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

### Task 6: Even volume: LevelStore

From `levels.ts`: `POST /api/levels` for songs not known, at most once per 15 s per song (the server measures a song in a second or two), at most 50 ids a request (the route's limit); the album's gain within an album in order. A failed request is asked again at once.

**Files:**
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/LevelStore.swift`
- Test: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/LevelStoreTests.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/LevelStoreTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Synchronization
import Testing
@testable import PlayarrPlayer

@MainActor
struct LevelStoreTests {
  final class Server: Sendable {
    let requests = Mutex<[[String]]>([])
    let failing = Mutex(false)
    func levels(_ ids: [String]) throws -> [String: TrackLevel] {
      requests.withLock { $0.append(ids) }
      if failing.withLock({ $0 }) { throw URLError(.notConnectedToInternet) }
      return Dictionary(uniqueKeysWithValues: ids.filter { $0 != "rec-9" }.map { ($0, TrackLevel(track: -4, album: -2)) })
    }
  }

  @Test func asksOnceForWhatItDoesNotKnowAndAgainAfterFifteenSeconds() async {
    let server = Server()
    var clock = Date(timeIntervalSince1970: 0)
    let store = LevelStore(now: { clock }) { try server.levels($0) }
    await store.load([song(1), song(9), song(1), nil])
    #expect(server.requests.withLock { $0 } == [["rec-1", "rec-9"]])
    #expect(store.levels["rec-1"]?.track == -4)
    await store.load([song(1), song(9)])
    #expect(server.requests.withLock { $0.count } == 1)  // rec-9 was asked just now
    clock += 16
    await store.load([song(1), song(9)])
    #expect(server.requests.withLock { $0.last } == ["rec-9"])
  }

  @Test func asksAtMostFiftyAtATime() async {
    let server = Server()
    let store = LevelStore { try server.levels($0) }
    await store.load((1...120).map { song($0 + 100) })
    #expect(server.requests.withLock { $0.map(\.count) } == [50, 50, 20])
  }

  @Test func aFailedRequestIsAskedAgainAtOnce() async {
    let server = Server()
    server.failing.withLock { $0 = true }
    let store = LevelStore { try server.levels($0) }
    await store.load([song(1)])
    server.failing.withLock { $0 = false }
    await store.load([song(1)])
    #expect(store.levels["rec-1"] != nil)
  }

  @Test func theGainIsTheAlbumsWithinAnAlbumAndNoneWhenOff() async {
    let server = Server()
    let store = LevelStore { try server.levels($0) }
    var q = QueueState()
    q.playTracks([song(1), song(2), song(3, albumId: 2)])
    await store.load(q.queue)
    #expect(store.gainDb(for: q.queue[0], in: q, enabled: true) == -2)
    #expect(store.gainDb(for: q.queue[2], in: q, enabled: true) == -4)
    #expect(store.gainDb(for: q.queue[0], in: q, enabled: false) == nil)
    #expect(store.gainDb(for: song(9), in: q, enabled: true) == nil)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter LevelStoreTests
```

Expected: the build fails with `cannot find 'LevelStore' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/LevelStore.swift`:

```swift
import Foundation
import Observation
import PlayarrAPI

/// How loud each song is, as far as the server has measured (`POST /api/levels`), for even volume. As
/// apps/web/src/player/levels.ts: songs not known are asked about at most every 15 s (measuring one takes a second or
/// two), at most 50 to a request.
@MainActor @Observable
public final class LevelStore {
  public static let retryInterval: TimeInterval = 15
  public static let batchSize = 50

  public private(set) var levels: [String: TrackLevel] = [:]

  @ObservationIgnored private var asked: [String: Date] = [:]
  @ObservationIgnored private let fetch: @Sendable ([String]) async throws -> [String: TrackLevel]
  @ObservationIgnored private let now: () -> Date

  public init(now: @escaping () -> Date = Date.init, fetch: @escaping @Sendable ([String]) async throws -> [String: TrackLevel]) {
    self.fetch = fetch
    self.now = now
  }

  /// Learn the levels of these songs, unless known or asked lately.
  public func load(_ tracks: [Track?]) async {
    let at = now()
    var seen = Set<String>()
    let ids = tracks.compactMap { $0?.recordingId }.filter {
      seen.insert($0).inserted && levels[$0] == nil && at.timeIntervalSince(asked[$0] ?? .distantPast) > Self.retryInterval
    }
    guard !ids.isEmpty else { return }
    for id in ids { asked[id] = at }
    for start in stride(from: 0, to: ids.count, by: Self.batchSize) {
      let batch = Array(ids[start..<min(start + Self.batchSize, ids.count)])
      do {
        let found = try await fetch(batch)
        levels.merge(found) { _, new in new }
      } catch {
        for id in batch { asked[id] = nil }
      }
    }
  }

  /// The gain (dB) a song plays at with even volume on: nil when off or not measured yet (it plays as it is).
  public func gainDb(for track: Track, in queue: QueueState, enabled: Bool) -> Double? {
    guard enabled, let level = levels[track.recordingId] else { return nil }
    return JoinRules.levelDb(track, level, in: queue)
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter LevelStoreTests
```

Expected: `Test run with 4 tests` … `passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/LevelStore.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/LevelStoreTests.swift
git commit -F - <<'EOF'
Learn songs' levels for even volume, 50 at a time, asking again after 15 s

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

### Task 7: Play reports: PlayTracker and the report queue

From `playTracker.ts`: a play at 30 s heard or half the song; a skip when changed from 3 s heard before that; closing is never a skip; seeking isn't listening (only steps under 2 s count). Unsent reports wait in a JSON file (at most 300) and go one request at a time. `JSONFile` (the queue uses it too) arrives here. The tests port `playTracker.test.ts`; `Gate` lets a test answer requests one at a time.

**Files:**
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/JSONFile.swift`
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PlayTracker.swift`
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PlayReportQueue.swift`
- Test: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/PlayTrackerTests.swift`
- Test: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/PlayReportQueueTests.swift`
- Test support: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/Gate.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/Gate.swift`:

```swift
/// Lets a test release a waiting task one step at a time (a request answered, a stalled download resumed).
actor Gate {
  private var waiting: [CheckedContinuation<Void, Never>] = []
  private var opened = 0

  func wait() async {
    if opened > 0 {
      opened -= 1
      return
    }
    await withCheckedContinuation { waiting.append($0) }
  }

  func open() {
    if waiting.isEmpty { opened += 1 } else { waiting.removeFirst().resume() }
  }
}
```

`apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/PlayTrackerTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrPlayer

/// Ported from apps/web/src/player/playTracker.test.ts.
struct PlayTrackerTests {
  final class Sent { var plays: [PlayReport] = [] }

  /// Play from `from` to `to` seconds in quarter-second ticks, as the player's clock does.
  func listen(_ t: PlayTracker, _ from: Double, _ to: Double) {
    for s in stride(from: from, through: to, by: 0.25) { t.tick(s) }
  }

  var calendar: Calendar {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = TimeZone(identifier: "Europe/London")!
    return c
  }

  @Test func aSongHeardForThirtySecondsIsAPlayWithTheLocalHourAndWeekday() {
    let sent = Sent()
    let t = PlayTracker(calendar: calendar) { sent.plays += $0 }
    let at = calendar.date(from: DateComponents(year: 2026, month: 11, day: 1, hour: 21, minute: 15))!  // a Sunday
    t.start(song(7, duration: 240), at: at)
    listen(t, 0, 31)
    t.finish(.changed)
    #expect(sent.plays == [PlayReport(trackId: 7, recordingId: "rec-7", at: "2026-11-01T21:15:00.000Z", hour: 21, weekday: 0, seconds: 31, skipped: false)])
  }

  @Test func onlyWhatWasHeardCountsSeekingAheadIsNotListening() {
    let sent = Sent()
    let t = PlayTracker { sent.plays += $0 }
    t.start(song(7, duration: 240))
    listen(t, 0, 10)
    t.pause()  // seeking
    listen(t, 200, 205)
    t.finish(.changed)
    #expect(sent.plays.first?.skipped == true)
    #expect(sent.plays.first?.seconds == 15)
  }

  @Test func aShortSongHeardHalfwayIsAPlayLeavingInTheFirstSecondsIsNothing() {
    let sent = Sent()
    let t = PlayTracker { sent.plays += $0 }
    t.start(song(7, duration: 40))
    listen(t, 0, 21)
    t.finish(.ended)
    t.start(song(8, duration: 240))
    listen(t, 0, 2)
    t.finish(.changed)
    #expect(sent.plays.count == 1)
    #expect(sent.plays.first?.skipped == false)
  }

  @Test func closingTheAppMidSongIsNeverASkip() {
    let sent = Sent()
    let t = PlayTracker { sent.plays += $0 }
    t.start(song(7, duration: 240))
    listen(t, 0, 10)
    t.finish(.closed)
    #expect(sent.plays.isEmpty)
  }
}
```

`apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/PlayReportQueueTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Synchronization
import Testing
@testable import PlayarrPlayer

/// Ported from the sendWithRetry tests in apps/web/src/player/playTracker.test.ts.
struct PlayReportQueueTests {
  func report(_ n: Int) -> PlayReport {
    PlayReport(trackId: n, recordingId: "rec-\(n)", at: "2026-11-01T10:0\(n):00.000Z", hour: 10, weekday: 0, seconds: 60, skipped: false)
  }

  func file() -> URL { FileManager.default.temporaryDirectory.appending(path: "plays-\(UUID().uuidString).json") }

  @Test func keepsReportsThatCouldNotBeSentAndSendsThemWithTheNextOne() async {
    let url = file()
    let offline = PlayReportQueue(file: url) { _ in throw URLError(.notConnectedToInternet) }
    await offline.send([report(1)])
    #expect(await offline.pending == [report(1)])
    let received = Mutex<[[PlayReport]]>([])
    let online = PlayReportQueue(file: url) { plays in received.withLock { $0.append(plays) } }
    await online.send([report(2)])
    #expect(received.withLock { $0 } == [[report(1), report(2)]])
    #expect(await online.pending.isEmpty)
    #expect(!FileManager.default.fileExists(atPath: url.path()))
  }

  @Test func keepsAtMostThreeHundred() async {
    let queue = PlayReportQueue(file: file()) { _ in throw URLError(.timedOut) }
    await queue.send((0..<310).map { PlayReport(trackId: $0, recordingId: "r", at: "\($0)", hour: 0, weekday: 0, seconds: 30, skipped: false) })
    let pending = await queue.pending
    #expect(pending.count == 300)
    #expect(pending.first?.trackId == 10)
  }

  @Test func sendsOneRequestAtATimeReportsMadeMeanwhileFollowOnceItIsAnswered() async {
    let calls = Mutex<[[PlayReport]]>([])
    let gate = Gate()
    let queue = PlayReportQueue(file: file()) { plays in
      calls.withLock { $0.append(plays) }
      await gate.wait()
    }
    async let first: Void = queue.send([report(1)])
    while calls.withLock({ $0.isEmpty }) { await Task.yield() }
    await queue.send([report(2)])  // waits on disk: one request is on its way
    #expect(calls.withLock { $0.count } == 1)
    await gate.open()
    while calls.withLock({ $0.count }) < 2 { await Task.yield() }
    await gate.open()
    await first
    #expect(calls.withLock { $0 } == [[report(1)], [report(2)]])
    #expect(await queue.pending.isEmpty)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter 'PlayTrackerTests|PlayReportQueueTests'
```

Expected: the build fails with `cannot find 'PlayTracker' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/JSONFile.swift`:

```swift
import Foundation

/// A value kept as a JSON file (the queue, unsent play reports), written atomically. Reading a missing or
/// unreadable file gives nil: losing a saved queue beats failing to start.
public struct JSONFile<Value: Codable & Sendable>: Sendable {
  public let url: URL

  public init(_ url: URL) { self.url = url }

  public func read() -> Value? {
    guard let data = try? Data(contentsOf: url) else { return nil }
    return try? JSONDecoder().decode(Value.self, from: data)
  }

  /// Writes `value`, or removes the file for nil.
  public func write(_ value: Value?) {
    guard let value else {
      try? FileManager.default.removeItem(at: url)
      return
    }
    do {
      try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
      try JSONEncoder().encode(value).write(to: url, options: .atomic)
    } catch {
      // Disk full or the folder gone: the next write tries again.
    }
  }
}
```

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PlayTracker.swift`:

```swift
import Foundation
import PlayarrAPI

/// Why a song stopped being the current one.
public enum Finish: Sendable { case ended, changed, closed }

/// The listening history, as heard on this device (apps/web/src/player/playTracker.ts): each song is reported once
/// it stops being the current one, with how long it was actually heard (seeking doesn't count) and where in the day.
public final class PlayTracker {
  /// Heard this long (or half a shorter song): a play.
  public static let playSeconds: Double = 30
  /// Left before this: just looking around, not a verdict on the song.
  public static let skipFromSeconds: Double = 3

  private struct Current {
    let track: Track
    let startedAt: Date
    var heard: Double = 0
    var lastTime: Double?
  }

  private var current: Current?
  private let calendar: Calendar
  private let send: ([PlayReport]) -> Void

  public init(calendar: Calendar = .current, send: @escaping ([PlayReport]) -> Void) {
    self.calendar = calendar
    self.send = send
  }

  public func start(_ track: Track, at date: Date = Date()) {
    current = Current(track: track, startedAt: date)
  }

  /// The playhead moved while playing. Jumps (seeks) aren't counted as heard.
  public func tick(_ time: Double) {
    guard var c = current else { return }
    if let last = c.lastTime {
      let delta = time - last
      if delta > 0 && delta < 2 { c.heard += delta }
    }
    c.lastTime = time
    current = c
  }

  /// Paused, or jumped: the next tick starts counting afresh.
  public func pause() {
    current?.lastTime = nil
  }

  public func finish(_ reason: Finish) {
    guard let c = current else { return }
    current = nil
    let duration = c.track.duration > 0 ? c.track.duration : .infinity
    let played = c.heard >= min(Self.playSeconds, duration / 2)
    let skipped = !played && reason == .changed && c.heard >= Self.skipFromSeconds
    guard played || skipped else { return }
    send([
      PlayReport(
        trackId: c.track.id, recordingId: c.track.recordingId,
        at: c.startedAt.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true)),
        hour: calendar.component(.hour, from: c.startedAt),
        weekday: calendar.component(.weekday, from: c.startedAt) - 1,
        seconds: c.heard.rounded(), skipped: skipped)
    ])
  }
}
```

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PlayReportQueue.swift`:

```swift
import Foundation
import PlayarrAPI

/// Sends play reports, keeping the ones that couldn't go (offline, server restarting) on disk for next time, at most
/// 300. One request at a time: reports arriving meanwhile wait for it, then go together. (The server ignores a report
/// it already has.) As `sendWithRetry` in apps/web/src/player/playTracker.ts.
public actor PlayReportQueue {
  public static let maxPending = 300

  private let file: JSONFile<[PlayReport]>
  private let report: @Sendable ([PlayReport]) async throws -> Void
  private var sending = false

  public init(file: URL, report: @escaping @Sendable ([PlayReport]) async throws -> Void) {
    self.file = JSONFile(file)
    self.report = report
  }

  public var pending: [PlayReport] { file.read() ?? [] }

  public func send(_ plays: [PlayReport]) async {
    write(Array((pending + plays).suffix(Self.maxPending)))
    guard !sending else { return }
    let batch = pending
    guard !batch.isEmpty else { return }
    sending = true
    let sent: Bool
    do {
      try await report(batch)
      write(pending.filter { p in !batch.contains { $0.trackId == p.trackId && $0.at == p.at } })
      sent = true
    } catch {
      sent = false
    }
    sending = false
    // More arrived while this was on its way: send them now.
    if sent && !pending.isEmpty { await send([]) }
  }

  /// Try the waiting reports again (at launch, and when the network comes back).
  public func retry() async { await send([]) }

  private func write(_ plays: [PlayReport]) { file.write(plays.isEmpty ? nil : plays) }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter 'PlayTrackerTests|PlayReportQueueTests'
```

Expected: `Test run with 7 tests` … `passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/JSONFile.swift \
  apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PlayTracker.swift \
  apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PlayReportQueue.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/PlayTrackerTests.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/PlayReportQueueTests.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/Gate.swift
git commit -F - <<'EOF'
Report plays as the web does and keep unsent ones on disk

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

### Task 8: The sleep timer and radio continuation rules

From `sleep.ts`: a timer that fades over its last 20 s then stops (once), "End of song", and its label. From `radio.ts`: when the last song of the queue starts, repeat off, autoplay on: seeds are the last 5 played, exclusions the whole queue; Start radio plays from the song's album. The tests port `sleep.test.ts` and `radio.test.ts`.

**Files:**
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/SleepTimer.swift`
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Radio.swift`
- Test: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/SleepTimerTests.swift`
- Test: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/RadioTests.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/SleepTimerTests.swift`:

```swift
import Foundation
import Testing
@testable import PlayarrPlayer

/// Ported from apps/web/src/player/sleep.test.ts.
@MainActor
struct SleepTimerTests {
  @Test func fadesOutOverTheLastSecondsAndSaysHowLongIsLeft() {
    let now = Date(timeIntervalSince1970: 1_000)
    let timer = SleepTimer()
    timer.sleep(minutes: 10, from: now)
    #expect(timer.gain(at: now) == 1)
    #expect(abs(timer.gain(at: now + 600 - SleepTimer.fadeSeconds / 2) - 0.5) < 1e-6)
    #expect(timer.gain(at: now + 660) == 0)
    #expect(timer.label(at: now) == "10 min")
    timer.sleep(minutes: 90, from: now)
    #expect(timer.label(at: now) == "1 h 30 min")
    timer.sleep(minutes: 60, from: now)
    #expect(timer.label(at: now) == "1 h")
    timer.sleepAtEndOfSong()
    #expect(timer.label() == "End of song")
    timer.cancel()
    #expect(timer.gain() == 1)
    #expect(timer.label() == nil)
  }

  @Test func stopsOnceAtTheEndOfTheSong() {
    let timer = SleepTimer()
    timer.sleepAtEndOfSong()
    #expect(timer.stopsAtSongEnd())
    #expect(!timer.stopsAtSongEnd())
  }

  @Test func runsOutOnce() {
    let now = Date(timeIntervalSince1970: 0)
    let timer = SleepTimer()
    timer.sleep(minutes: 1, from: now)
    #expect(!timer.runsOut(at: now + 59))
    #expect(timer.runsOut(at: now + 60))
    #expect(!timer.runsOut(at: now + 61))
    #expect(timer.endsAt == nil)
  }
}
```

`apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/RadioTests.swift`:

```swift
import Testing
@testable import PlayarrPlayer

/// Ported from apps/web/src/player/radio.test.ts.
struct RadioTests {
  @Test func asksForSongsLikeTheLastOnesWhenTheLastSongStarts() throws {
    var q = QueueState()
    q.playTracks([song(1), song(2)])
    #expect(Radio.continuation(for: q, autoplay: true) == nil)  // more to play yet
    q.jumpTo(1)
    let ask = try #require(Radio.continuation(for: q, autoplay: true))
    #expect(ask.seeds == ["rec-1", "rec-2"])
    #expect(ask.exclude == ["rec-1", "rec-2"])
  }

  @Test func seedsAreTheLastFivePlayed() throws {
    var q = QueueState()
    q.playTracks((1...8).map { song($0) }, startIndex: 7)
    #expect(try #require(Radio.continuation(for: q, autoplay: true)).seeds == ["rec-4", "rec-5", "rec-6", "rec-7", "rec-8"])
  }

  @Test func staysQuietWhenTurnedOffOrWhenTheQueueRepeats() {
    var q = QueueState()
    q.playTracks([song(1)])
    #expect(Radio.continuation(for: q, autoplay: false) == nil)
    q.repeatMode = .all
    #expect(Radio.continuation(for: q, autoplay: true) == nil)
  }

  @Test func startRadioPlaysFromTheSongsAlbum() {
    #expect(Radio.source(for: song(3, albumId: 9)) == PlaySource(label: "Song 3 radio", href: "/albums/9"))
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter 'SleepTimerTests|RadioTests'
```

Expected: the build fails with `cannot find 'SleepTimer' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/SleepTimer.swift`:

```swift
import Foundation
import Observation

/// The sleep timer (apps/web/src/player/sleep.ts): stop after a while, fading out over the last 20 s, or when this
/// song ends.
@MainActor @Observable
public final class SleepTimer {
  public static let fadeSeconds: TimeInterval = 20

  /// When the music stops.
  public private(set) var endsAt: Date?
  /// Stop when the song playing ends.
  public private(set) var endOfSong = false

  public init() {}

  public func sleep(minutes: Double, from now: Date = Date()) {
    endsAt = now.addingTimeInterval(minutes * 60)
    endOfSong = false
  }

  public func sleepAtEndOfSong() {
    endsAt = nil
    endOfSong = true
  }

  public func cancel() {
    endsAt = nil
    endOfSong = false
  }

  /// How loud to play as the timer runs out: 1, then down to 0 over the fade.
  public func gain(at now: Date = Date()) -> Float {
    guard let endsAt else { return 1 }
    return Float(max(0, min(1, endsAt.timeIntervalSince(now) / Self.fadeSeconds)))
  }

  /// True once, when the timer has run out (it is then cancelled): the player pauses.
  public func runsOut(at now: Date = Date()) -> Bool {
    guard let endsAt, now >= endsAt else { return false }
    cancel()
    return true
  }

  /// Called when a song ends on its own: true if the timer stops the music here.
  public func stopsAtSongEnd() -> Bool {
    guard endOfSong else { return false }
    cancel()
    return true
  }

  /// "23 min" left, for the timer's button.
  public func label(at now: Date = Date()) -> String? {
    if endOfSong { return "End of song" }
    guard let endsAt else { return nil }
    let minutes = max(1, Int((endsAt.timeIntervalSince(now) / 60).rounded(.up)))
    guard minutes >= 60 else { return "\(minutes) min" }
    return minutes % 60 == 0 ? "\(minutes / 60) h" : "\(minutes / 60) h \(minutes % 60) min"
  }
}
```

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Radio.swift`:

```swift
import PlayarrAPI

/// Radio continuation (apps/web/src/player/radio.ts): when the last song of the queue starts and nothing repeats,
/// ask for songs like the last few played, so playback carries on without a gap.
public enum Radio {
  /// Songs to base what comes next on: the last few played.
  public static let seedCount = 5
  public static let count = 25

  /// What to ask `POST /api/radio` for now, or nil when it shouldn't ask.
  public static func continuation(for q: QueueState, autoplay: Bool) -> (seeds: [String], exclude: [String])? {
    guard autoplay, q.currentTrack != nil, q.repeatMode == .off, q.pos == q.order.count - 1 else { return nil }
    let played = q.order.prefix(q.pos + 1).map { q.queue[$0] }
    return (played.suffix(seedCount).map(\.recordingId), q.queue.map(\.recordingId))
  }

  /// "Playing from" for Start radio on a song.
  public static func source(for track: Track) -> PlaySource {
    PlaySource(label: "\(track.title) radio", href: "/albums/\(track.albumId)")
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter 'SleepTimerTests|RadioTests'
```

Expected: `Test run with 7 tests` … `passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/SleepTimer.swift \
  apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Radio.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/SleepTimerTests.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/RadioTests.swift
git commit -F - <<'EOF'
Add the sleep timer with its 20 s fade, and radio continuation rules

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

### Task 9: Downloads with ranges and retries

A file fetched into a local file, readable while it arrives. It continues a partial file with `Range: bytes=<size>-`, starts at any byte (the levelled stream from a seek), copes with a server that ignores the range, and asks again from where a broken connection stopped, 3 times. The server's refusal keeps its `{ error }`. `PlaybackError` arrives here with the web's messages ("by your browser" becomes "on this device"). The tests run against `StubServer`, a `URLProtocol` that serves bytes in chunks with pauses and breaks connections on cue.

**Files:**
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PlaybackError.swift`
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Download.swift`
- Test: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/DownloadTests.swift`
- Test support: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/StubServer.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/StubServer.swift`:

```swift
import Foundation
import Synchronization

/// A pretend Playarr server for URLSession: serves bytes by path with Range support, in small chunks with a pause
/// between them (so readers really wait), and can break a connection off after some bytes or answer an error.
final class StubServer: URLProtocol, @unchecked Sendable {
  // @unchecked: URLProtocol is an NSObject subclass URLSession drives from its own threads; its only state is the
  // static `routes` and `log` and the `stopped` flag, all behind locks.
  struct Route: Sendable {
    var body: Data
    var status = 200
    var chunk = 16 * 1024
    var pause: Duration = .milliseconds(1)
    /// Break each of the first `breaks` connections off after this many bytes.
    var breakAfter: Int?
    var breaks = 0
    /// Ignore Range and send everything with 200.
    var ignoresRange = false
    /// No answer at all: the server can't be reached.
    var unreachable = false
  }

  static let routes = Mutex<[String: Route]>([:])
  static let log = Mutex<[(path: String, range: String?)]>([])

  static func serve(_ path: String, _ route: Route) { routes.withLock { $0[path] = route } }
  static func requests(_ path: String) -> [String?] { log.withLock { $0.filter { $0.path == path }.map(\.range) } }

  static func configuration() -> URLSessionConfiguration {
    let c = URLSessionConfiguration.ephemeral
    c.protocolClasses = [StubServer.self]
    return c
  }

  static let base = URL(string: "https://playarr.test")!
  static func request(_ path: String) -> URLRequest { URLRequest(url: base.appending(path: path)) }

  private let stopped = Flag()

  override class func canInit(with request: URLRequest) -> Bool { request.url?.host() == "playarr.test" }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    guard let url = request.url, let client else { return }
    let path = url.path()
    let range = request.value(forHTTPHeaderField: "Range")
    Self.log.withLock { $0.append((path, range)) }
    guard var route = Self.routes.withLock({ $0[path] }) else {
      return respond(client, url, status: 404, headers: [:], body: Data(#"{"error":"Unknown track file"}"#.utf8))
    }
    if route.unreachable { return client.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost)) }
    let breakAfter = route.breaks > 0 ? route.breakAfter : nil
    if route.breaks > 0 { Self.routes.withLock { $0[path]?.breaks -= 1 } }
    guard (200..<300).contains(route.status) else {
      return respond(client, url, status: route.status, headers: [:], body: route.body)
    }
    var start = 0
    if let range, !route.ignoresRange, let from = Int(range.dropFirst("bytes=".count).split(separator: "-").first ?? "") {
      start = from
    }
    if start >= route.body.count && start > 0 {
      return respond(client, url, status: 416, headers: ["Content-Range": "bytes */\(route.body.count)"], body: Data())
    }
    let partial = start > 0 || (range != nil && !route.ignoresRange)
    let headers = partial
      ? ["Content-Range": "bytes \(start)-\(route.body.count - 1)/\(route.body.count)", "Content-Length": "\(route.body.count - start)"]
      : ["Content-Length": "\(route.body.count)"]
    route.body = route.body.subdata(in: start..<route.body.count)
    let response = HTTPURLResponse(url: url, statusCode: partial ? 206 : 200, httpVersion: "HTTP/1.1", headerFields: headers)!
    client.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    // Boxed: capturing `self` of a nonisolated URLProtocol override trips region-based isolation checking.
    let me = Unchecked(self).value
    let stopped = self.stopped
    Task.detached { [route, client, breakAfter] in
      var sent = 0
      while sent < route.body.count {
        if stopped.isSet { return }
        if let breakAfter, sent >= breakAfter {
          client.urlProtocol(me, didFailWithError: URLError(.networkConnectionLost))
          return
        }
        let end = min(sent + route.chunk, route.body.count, breakAfter.map { max($0, sent + 1) } ?? .max)
        client.urlProtocol(me, didLoad: route.body.subdata(in: sent..<end))
        sent = end
        try? await Task.sleep(for: route.pause)
      }
      client.urlProtocolDidFinishLoading(me)
    }
  }

  override func stopLoading() { stopped.set() }

  private func respond(_ client: any URLProtocolClient, _ url: URL, status: Int, headers: [String: String], body: Data) {
    let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
    client.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client.urlProtocol(self, didLoad: body)
    client.urlProtocolDidFinishLoading(self)
  }
}

/// Carries a value URLSession itself shares between threads into a task.
struct Unchecked<Value>: @unchecked Sendable {
  let value: Value
  init(_ value: Value) { self.value = value }
}

/// A one-way switch shared with the delivering task.
final class Flag: Sendable {
  private let value = Mutex(false)
  var isSet: Bool { value.withLock { $0 } }
  func set() { value.withLock { $0 = true } }
}

func temporaryDirectory() -> URL {
  let url = FileManager.default.temporaryDirectory.appending(path: "playarr-\(UUID().uuidString)")
  try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
  return url
}
```

`apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/DownloadTests.swift`:

```swift
import Foundation
import Testing
@testable import PlayarrPlayer

@Suite(.serialized)
struct DownloadTests {
  let body = Data((0..<200_000).map { UInt8($0 % 251) })

  func download(_ path: String, firstByte: Int64 = 0, file: URL? = nil, finalFile: URL? = nil) -> Download {
    Download(
      request: StubServer.request(path), firstByte: firstByte, file: file ?? temporaryDirectory().appending(path: "f.part"),
      finalFile: finalFile, retryDelay: .milliseconds(5), configuration: StubServer.configuration)
  }

  @Test func readersGetBytesAsTheyArrive() async throws {
    StubServer.serve("/stream/1", .init(body: body))
    let d = download("/stream/1")
    d.start()
    let first = try await d.bytes(at: 0, maxLength: 1000)
    #expect(first == body.prefix(first.count))
    #expect(!first.isEmpty)
    let later = try await d.bytes(at: 150_000, maxLength: 10)
    #expect(later == body.subdata(in: 150_000..<150_000 + later.count))
    try await d.waitUntilFinished()
    #expect(try await d.bytes(at: Int64(body.count), maxLength: 10).isEmpty)
    #expect(try Data(contentsOf: d.file) == body)
  }

  @Test func aBrokenConnectionIsAskedAgainFromWhereItStoppedThreeTimes() async throws {
    StubServer.serve("/stream/2", .init(body: body, breakAfter: 50_000, breaks: 3))
    let d = download("/stream/2")
    d.start()
    try await d.waitUntilFinished()
    #expect(try Data(contentsOf: d.file) == body)
    // Each time from the byte it had (bytes in flight when a connection breaks may be lost, so not always 50 000).
    let ranges = StubServer.requests("/stream/2")
    #expect(ranges.count == 4)
    #expect(ranges.first == .some(nil))
    let starts = ranges.dropFirst().compactMap { $0.flatMap { Int($0.dropFirst("bytes=".count).dropLast()) } }
    #expect(starts.count == 3 && starts == starts.sorted() && starts.allSatisfy { $0 > 0 })
  }

  @Test func aFourthBreakIsAFailure() async throws {
    StubServer.serve("/stream/3", .init(body: body, breakAfter: 10_000, breaks: 4))
    let d = download("/stream/3")
    d.start()
    await #expect(throws: Download.Failure.network) { try await d.waitUntilFinished() }
  }

  @Test func theServersRefusalCarriesItsMessage() async throws {
    StubServer.serve("/stream/4", .init(body: Data(#"{"error":"Cannot read audio file: gone"}"#.utf8), status: 502))
    let d = download("/stream/4")
    d.start()
    await #expect(throws: Download.Failure.server(status: 502, message: "Cannot read audio file: gone")) {
      try await d.bytes(at: 0, maxLength: 10)
    }
  }

  @Test func startsFromAByteAndContinuesAnEarlierFile() async throws {
    StubServer.serve("/stream/5", .init(body: body))
    let dir = temporaryDirectory()
    let part = dir.appending(path: "5.flac.part")
    try body.prefix(70_000).write(to: part)
    let d = download("/stream/5", file: part, finalFile: dir.appending(path: "5.flac"))
    d.start()
    try await d.waitUntilFinished()
    #expect(StubServer.requests("/stream/5") == ["bytes=70000-"])
    #expect(d.file == dir.appending(path: "5.flac"))
    #expect(try Data(contentsOf: d.file) == body)

    StubServer.serve("/levelled", .init(body: body))
    let fromByte = download("/levelled", firstByte: 1000)
    fromByte.start()
    try await fromByte.waitUntilFinished()
    #expect(try Data(contentsOf: fromByte.file) == body.dropFirst(1000))
  }

  @Test func aServerIgnoringTheRangeStillGivesTheRightBytes() async throws {
    StubServer.serve("/stream/6", .init(body: body, ignoresRange: true))
    let d = download("/stream/6", firstByte: 5000)
    d.start()
    try await d.waitUntilFinished()
    #expect(try Data(contentsOf: d.file) == body.dropFirst(5000))
  }

  @Test func aCancelledReaderStopsWaiting() async throws {
    StubServer.serve("/stream/7", .init(body: body, pause: .seconds(10)))
    let d = download("/stream/7")
    d.start()
    let reader = Task { try await d.bytes(at: 190_000, maxLength: 10) }
    try await Task.sleep(for: .milliseconds(20))
    reader.cancel()
    await #expect(throws: CancellationError.self) { try await reader.value }
    d.cancel()
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter DownloadTests
```

Expected: the build fails with `cannot find 'Download' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PlaybackError.swift`:

```swift
import Foundation

/// Why a song couldn't play, in the web's words (`reportError` in apps/web/src/player/AudioEngine.tsx).
public enum PlaybackError: Error, Sendable, Equatable {
  /// The server said why (its `{ error }`), e.g. "Unknown track file".
  case server(String)
  case keptBreakingOff
  case undecodable
  case unsupported
  case unreachable

  public var message: String {
    switch self {
    case .server(let message): message
    case .keptBreakingOff: "The song kept stopping loading: the Playarr server or the network is too busy"
    case .undecodable: "This file couldn’t be decoded: it may be damaged"
    case .unsupported: "This file format is not supported on this device"
    case .unreachable: "Cannot reach the Playarr server"
    }
  }

  /// What went wrong on this side, before asking the server.
  public enum Cause: Sendable { case network, decoding, format }

  /// As the web does: ask for the first two bytes of the file to tell the server's refusal (its message), a file
  /// that's there but broke off or won't decode, and a server out of reach.
  public static func diagnose(_ cause: Cause, probe: URLRequest, session: URLSession) async -> PlaybackError {
    var request = probe
    request.setValue("bytes=0-1", forHTTPHeaderField: "Range")
    do {
      let (data, response) = try await session.data(for: request)
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      if !(200..<300).contains(status) { return .server(serverMessage(data) ?? "Playback failed") }
      return switch cause {
      case .network: .keptBreakingOff
      case .decoding: .undecodable
      case .format: .unsupported
      }
    } catch {
      return .unreachable
    }
  }

  /// The `error` of a server's JSON answer.
  static func serverMessage(_ data: Data) -> String? {
    struct Answer: Decodable { let error: String }
    return try? JSONDecoder().decode(Answer.self, from: data).error
  }
}
```

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Download.swift`:

```swift
import Foundation
import Synchronization

/// One file fetched over HTTP into a local file, from a byte on, readable while it arrives. A connection that breaks
/// is asked again from the byte it stopped at, up to `retries` times (3, as `STREAM_RETRIES` on the web).
///
/// URLSession calls the delegate methods on its own queue while readers wait on other tasks, so all state sits in a
/// `Mutex` (a checked `Sendable`, no `@unchecked` needed). Waiting readers are continuations resumed outside the lock.
public final class Download: NSObject, URLSessionDataDelegate, Sendable {
  public enum Failure: Error, Sendable, Equatable {
    /// The connection kept breaking off (retries used up).
    case network
    /// The server answered with an error status and, usually, `{ error }`.
    case server(status: Int, message: String?)
  }

  public let request: URLRequest
  /// The byte of the resource the local file starts at.
  public let firstByte: Int64

  private struct Waiter {
    let id: UUID
    let wanted: Int64
    let continuation: CheckedContinuation<Void, any Error>
  }

  private struct State {
    var file: URL
    var finalFile: URL?
    var received: Int64 = 0
    var total: Int64?
    var finished = false
    var cancelled = false
    var failure: Failure?
    var retriesLeft: Int
    var session: URLSession?
    var task: URLSessionDataTask?
    var writer: FileHandle?
    var status = 0
    var skip: Int64 = 0
    var errorBody = Data()
    var waiters: [Waiter] = []
    var onFinish: (@Sendable () -> Void)?
  }

  private let state: Mutex<State>
  private let configuration: @Sendable () -> URLSessionConfiguration
  private let retryDelay: Duration

  /// `file` already holding bytes (an earlier, interrupted download) is continued from its end. With `finalFile`,
  /// the file is moved there once complete.
  public init(
    request: URLRequest, firstByte: Int64 = 0, file: URL, finalFile: URL? = nil, retries: Int = 3,
    retryDelay: Duration = .seconds(1), configuration: @escaping @Sendable () -> URLSessionConfiguration = { .default }
  ) {
    self.request = request
    self.firstByte = firstByte
    self.retryDelay = retryDelay
    self.configuration = configuration
    let existing = (try? FileManager.default.attributesOfItem(atPath: file.path())[.size] as? Int64) ?? 0
    state = Mutex(State(file: file, finalFile: finalFile, received: existing, retriesLeft: retries))
  }

  public var received: Int64 { state.withLock { $0.received } }
  public var isFinished: Bool { state.withLock { $0.finished } }
  /// Fetching, or waiting to fetch again.
  public var isActive: Bool { state.withLock { !$0.finished && !$0.cancelled && $0.failure == nil && $0.session != nil } }
  public var file: URL { state.withLock { $0.file } }

  public func onFinish(_ action: @escaping @Sendable () -> Void) {
    state.withLock { $0.onFinish = action }
  }

  public func start() {
    state.withLock { s in
      guard s.session == nil, !s.finished, !s.cancelled, s.failure == nil else { return }
      if !FileManager.default.fileExists(atPath: s.file.path()) {
        FileManager.default.createFile(atPath: s.file.path(), contents: nil)
      }
      s.session = URLSession(configuration: configuration(), delegate: self, delegateQueue: nil)
      begin(&s)
    }
  }

  public func cancel() {
    let waiters = state.withLock { s -> [Waiter] in
      s.cancelled = true
      s.task?.cancel()
      s.session?.invalidateAndCancel()
      s.session = nil
      try? s.writer?.close()
      s.writer = nil
      defer { s.waiters = [] }
      return s.waiters
    }
    for w in waiters { w.continuation.resume(throwing: CancellationError()) }
  }

  /// Up to `maxLength` bytes from `offset` of the local file, waiting for them to arrive; empty at the end.
  public func bytes(at offset: Int64, maxLength: Int) async throws -> Data {
    try await wait(for: offset + 1)
    let (file, available) = state.withLock { ($0.file, $0.received - offset) }
    guard available > 0 else { return Data() }
    let handle = try FileHandle(forReadingFrom: file)
    defer { try? handle.close() }
    try handle.seek(toOffset: UInt64(offset))
    return try handle.read(upToCount: min(maxLength, Int(available))) ?? Data()
  }

  /// Returns once the whole file is here.
  public func waitUntilFinished() async throws {
    try await wait(for: .max)
  }

  private func wait(for wanted: Int64) async throws {
    let id = UUID()
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, any Error>) in
        let ready: Result<Void, any Error>? = state.withLock { s in
          if s.received >= wanted || s.finished { return .success(()) }
          if let failure = s.failure { return .failure(failure) }
          if s.cancelled || Task.isCancelled { return .failure(CancellationError()) }
          s.waiters.append(Waiter(id: id, wanted: wanted, continuation: c))
          return nil
        }
        if let ready { c.resume(with: ready) }
      }
    } onCancel: {
      let waiter = state.withLock { s -> Waiter? in
        guard let i = s.waiters.firstIndex(where: { $0.id == id }) else { return nil }
        return s.waiters.remove(at: i)
      }
      waiter?.continuation.resume(throwing: CancellationError())
    }
  }

  /// Asks for the bytes from where the file ends. Called with the lock held.
  private func begin(_ s: inout State) {
    var request = self.request
    let from = firstByte + s.received
    if from > 0 { request.setValue("bytes=\(from)-", forHTTPHeaderField: "Range") }
    s.status = 0
    s.skip = 0
    s.errorBody = Data()
    s.task = s.session?.dataTask(with: request)
    s.task?.resume()
  }

  // MARK: URLSessionDataDelegate

  public func urlSession(
    _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
    completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void
  ) {
    let http = response as? HTTPURLResponse
    state.withLock { s in
      s.status = http?.statusCode ?? 0
      if s.status == 206, let range = http?.value(forHTTPHeaderField: "Content-Range"),
        let total = range.split(separator: "/").last.flatMap({ Int64($0) })
      {
        s.total = total - firstByte
      } else if s.status == 200 {
        // The server sent the whole resource rather than the range: drop what's already here or not wanted.
        s.skip = firstByte
        if s.received > 0 {
          try? s.writer?.close()
          s.writer = nil
          try? Data().write(to: s.file)
          s.received = 0
        }
        if response.expectedContentLength > 0 { s.total = response.expectedContentLength - firstByte }
      }
    }
    completionHandler(.allow)
  }

  public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    let ready = state.withLock { s -> [Waiter] in
      guard (200..<300).contains(s.status) else {
        s.errorBody.append(data)
        return []
      }
      var data = data
      if s.skip > 0 {
        let dropped = min(Int64(data.count), s.skip)
        data = data.dropFirst(Int(dropped))
        s.skip -= dropped
      }
      guard !data.isEmpty else { return [] }
      do {
        if s.writer == nil {
          s.writer = try FileHandle(forWritingTo: s.file)
          try s.writer?.seekToEnd()
        }
        try s.writer?.write(contentsOf: data)
      } catch {
        s.task?.cancel()  // disk full: ends as a broken connection
        return []
      }
      s.received += Int64(data.count)
      let now = s.received
      let (go, stay) = (s.waiters.filter { $0.wanted <= now }, s.waiters.filter { $0.wanted > now })
      s.waiters = stay
      return go
    }
    for w in ready { w.continuation.resume() }
  }

  public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
    enum Outcome { case done, failed(Failure), retry, nothing }
    let (outcome, waiters, onFinish) = state.withLock { s -> (Outcome, [Waiter], (@Sendable () -> Void)?) in
      s.task = nil
      if s.cancelled { return (.nothing, [], nil) }
      let broken = error != nil || (s.status == 206 && s.total.map { s.received < $0 } == true)
      let outcome: Outcome
      if s.status == 416 && s.received > 0 {
        outcome = .done  // asked from the end: it's all here
      } else if s.status >= 300 {
        outcome = .failed(.server(status: s.status, message: PlaybackError.serverMessage(s.errorBody)))
      } else if broken {
        if s.retriesLeft > 0 {
          s.retriesLeft -= 1
          return (.retry, [], nil)
        }
        outcome = .failed(.network)
      } else {
        outcome = .done
      }
      try? s.writer?.close()
      s.writer = nil
      s.session?.finishTasksAndInvalidate()
      s.session = nil
      if case .failed(let failure) = outcome {
        s.failure = failure
      } else {
        s.finished = true
        if let final = s.finalFile {
          try? FileManager.default.removeItem(at: final)
          if (try? FileManager.default.moveItem(at: s.file, to: final)) != nil { s.file = final }
        }
      }
      defer { s.waiters = [] }
      return (outcome, s.waiters, s.onFinish)
    }
    switch outcome {
    case .retry:
      Task { [retryDelay] in
        try? await Task.sleep(for: retryDelay)
        self.state.withLock { s in if !s.cancelled { self.begin(&s) } }
      }
    case .failed(let failure):
      for w in waiters { w.continuation.resume(throwing: failure) }
    case .done:
      for w in waiters { w.continuation.resume() }
      onFinish?()
    case .nothing:
      break
    }
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter DownloadTests
```

Expected: `Test run with 7 tests` … `passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PlaybackError.swift \
  apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Download.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/DownloadTests.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/StubServer.swift
git commit -F - <<'EOF'
Download songs with ranges, reading while they arrive, three retries from where they broke

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

### Task 10: Progressive decoding: FLAC and MP3 through AudioFileStream

The riskiest piece. Test files are made on the spot by the system's FLAC encoder (no binaries in the repo). MP3 has no encoder on Apple platforms, so its test uses hand-made MPEG-1 Layer III frames of silence; real MP3s (and their gapless trim from the LAME header, read as `kAudioFileStreamProperty_PacketTableInfo`) are checked in Task 21.

**Files:**
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/StreamDecoder.swift`
- Test: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/StreamDecoderTests.swift`
- Test support: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/AudioFiles.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/AudioFiles.swift`:

```swift
import AVFoundation
import Foundation
@testable import PlayarrPlayer

/// Test files made on the spot with the system's encoders, so no binary fixtures live in the repo.
enum AudioFiles {
  /// A sine at `hertz` (amplitude 0.5) that starts at phase 0; `frame` is the index at the file's rate.
  static func sine(_ hertz: Double, rate: Double) -> (Int, Int) -> Float {
    { frame, _ in Float(0.5 * sin(2 * .pi * hertz * Double(frame) / rate)) }
  }

  /// Writes a FLAC file. (Apple's encoder writes nothing for less than one block, so keep files ≥ 0.2 s.)
  static func flac(
    seconds: Double, rate: Double = 44_100, channels: AVAudioChannelCount = 2, bits: Int = 24,
    signal: ((Int, Int) -> Float)? = nil
  ) throws -> URL {
    let url = temporaryDirectory().appending(path: "test.flac")
    let frames = Int(seconds * rate)
    let signal = signal ?? sine(441, rate: rate)
    let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: channels, interleaved: false)!
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames))!
    buffer.frameLength = AVAudioFrameCount(frames)
    for c in 0..<Int(channels) {
      for i in 0..<frames { buffer.floatChannelData![c][i] = signal(i, c) }
    }
    do {
      let file = try AVAudioFile(
        forWriting: url,
        settings: [AVFormatIDKey: kAudioFormatFLAC, AVSampleRateKey: rate, AVNumberOfChannelsKey: channels, AVLinearPCMBitDepthKey: bits],
        commonFormat: .pcmFormatFloat32, interleaved: false)
      try file.write(from: buffer)
    }  // closing the file flushes its last block
    return url
  }

  /// MPEG-1 Layer III frames of silence (128 kb/s, 44.1 kHz, stereo, 417 bytes each): a header and zeroed side
  /// information and main data, which decoders read as 1152 frames of silence.
  static func silentMP3(frames: Int) -> Data {
    var frame = Data([0xFF, 0xFB, 0x90, 0x04])
    frame.append(Data(count: 417 - 4))
    return Data((0..<frames).flatMap { _ in frame })
  }

  /// A levelled stream as the server makes it (apps/server/src/media/levelled.ts): a 44-byte header, then 16-bit
  /// stereo frames at 44.1 kHz.
  static func levelledWAV(frames: Int, signal: (Int, Int) -> Float) -> Data {
    var data = Data(count: 44)
    for i in 0..<frames {
      for c in 0..<2 {
        let v = Int16(max(-32_768, min(32_767, (signal(i, c) * 32_768).rounded())))
        withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) }
      }
    }
    return data
  }

  /// Every frame of `data`, decoded by a StreamDecoder fed `chunk` bytes at a time.
  static func decodeStreaming(_ data: Data, container: String, chunk: Int = 997, maxFrames: Int = 4096) throws -> PCMBlock {
    let decoder = try StreamDecoder(fileType: StreamDecoder.fileType(forContainer: container)!)
    var out = PCMBlock(left: [], right: [])
    var offset = 0
    while true {
      guard let block = try decoder.decode(maxFrames: maxFrames) else { return out }
      if block.frames > 0 {
        out.left += block.left
        out.right += block.right
        continue
      }
      if offset < data.count {
        let end = min(offset + chunk, data.count)
        try decoder.feed(data.subdata(in: offset..<end))
        offset = end
      } else {
        try decoder.endOfInput()
      }
    }
  }
}
```

`apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/StreamDecoderTests.swift`:

```swift
import AVFoundation
import Testing
@testable import PlayarrPlayer

struct StreamDecoderTests {
  @Test func decodesAFLACAsItsBytesArriveToTheSample() throws {
    let url = try AudioFiles.flac(seconds: 2, rate: 44_100)
    let pcm = try AudioFiles.decodeStreaming(Data(contentsOf: url), container: "flac")
    #expect(pcm.frames == 88_200)
    let sine = AudioFiles.sine(441, rate: 44_100)
    let worst = (0..<pcm.frames).map { abs(pcm.left[$0] - sine($0, 0)) }.max() ?? 1
    #expect(worst < 1e-6)  // 24-bit: the same samples
    #expect(pcm.left == pcm.right)
  }

  @Test func convertsOtherRatesAndWidthsToTheEnginesClock() throws {
    for (rate, bits) in [(48_000.0, 16), (88_200.0, 24), (96_000.0, 24)] {
      let url = try AudioFiles.flac(seconds: 1.5, rate: rate, bits: bits)
      let pcm = try AudioFiles.decodeStreaming(Data(contentsOf: url), container: "flac")
      #expect(pcm.frames == Int((1.5 * 44_100).rounded()), "\(rate) Hz")
    }
  }

  @Test func playsAMonoFileInBothEars() throws {
    let url = try AudioFiles.flac(seconds: 0.5, channels: 1)
    let pcm = try AudioFiles.decodeStreaming(Data(contentsOf: url), container: "flac")
    #expect(pcm.frames == 22_050)
    #expect(pcm.left == pcm.right)
    #expect(pcm.left.contains { $0 != 0 })
  }

  @Test func decodesMP3() throws {
    let pcm = try AudioFiles.decodeStreaming(AudioFiles.silentMP3(frames: 40), container: "mp3")
    #expect(pcm.frames >= 38 * 1152 && pcm.frames <= 40 * 1152)
    #expect(pcm.left.allSatisfy { $0 == 0 })
  }

  @Test func saysWhenItCannotStreamAFormatSoTheCallerFallsBack() throws {
    #expect(StreamDecoder.fileType(forContainer: "ogg") == nil)
    let decoder = try StreamDecoder(fileType: kAudioFileFLACType)
    #expect(throws: StreamDecoder.Failure.self) {
      try decoder.feed(Data(repeating: 0x42, count: 4096))
      try decoder.endOfInput()
    }
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter StreamDecoderTests
```

Expected: the build fails with `cannot find 'StreamDecoder' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/StreamDecoder.swift`:

```swift
import AVFoundation
import AudioToolbox

/// Decodes a song's own file as its bytes arrive: AudioFileStream finds the packets, one AVAudioConverter turns them
/// into engine-format PCM (decoding, converting the rate and the channels in one step). FLAC, MP3 and AAC (ADTS, or
/// M4A with its index first).
///
/// AudioFileStream's C callbacks run synchronously inside `AudioFileStreamParseBytes`, on the caller's thread, so the
/// decoder is a plain non-Sendable class owned by one actor (`TrackSource`): the callbacks reach it through an
/// unretained pointer and need no lock.
final class StreamDecoder {
  enum Failure: Error, Equatable {
    /// Not a format this decoder streams (found before any audio): the caller falls back.
    case unsupported(OSStatus)
    /// The data is damaged.
    case damaged(OSStatus)
  }

  private var stream: AudioFileStreamID?
  private var format: AVAudioFormat?
  private var cookie: Data?
  private var packetTable: AudioFilePacketTableInfo?
  private var packets: [(data: Data, description: AudioStreamPacketDescription)] = []
  private var converter: AVAudioConverter?
  private var inputEnded = false
  /// The header says plain PCM (WAV, AIFF): not streamed here.
  private var plainPCM = false
  private var outputEnded = false
  /// Engine frames still to drop at the start (an encoder's priming), and the most to give in all (its padding).
  private var toDrop: Int64 = 0
  private var limit: Int64?
  private var produced: Int64 = 0

  /// The AudioFileStream type for a file extension, nil for formats it can't stream (they go another way).
  static func fileType(forContainer container: String) -> AudioFileTypeID? {
    switch container.lowercased() {
    case "flac": kAudioFileFLACType
    case "mp3": kAudioFileMP3Type
    case "aac": kAudioFileAAC_ADTSType
    case "m4a", "mp4", "alac": kAudioFileM4AType
    default: nil
    }
  }

  init(fileType: AudioFileTypeID) throws {
    let context = Unmanaged.passUnretained(self).toOpaque()
    let status = AudioFileStreamOpen(context, { context, stream, property, _ in
      Unmanaged<StreamDecoder>.fromOpaque(context).takeUnretainedValue().property(property, of: stream)
    }, { context, _, count, bytes, descriptions in
      Unmanaged<StreamDecoder>.fromOpaque(context).takeUnretainedValue().packets(count, bytes, descriptions)
    }, fileType, &stream)
    guard status == noErr else { throw Failure.unsupported(status) }
  }

  deinit {
    if let stream { AudioFileStreamClose(stream) }
  }

  /// The source's format, once the header has been read.
  var sourceFormat: AVAudioFormat? { format }

  func feed(_ data: Data) throws {
    guard let stream, !data.isEmpty else { return }
    let status = data.withUnsafeBytes { raw in
      AudioFileStreamParseBytes(stream, UInt32(raw.count), raw.baseAddress, [])
    }
    guard status == noErr else {
      throw converter == nil ? Failure.unsupported(status) : Failure.damaged(status)
    }
    if plainPCM { throw Failure.unsupported(kAudioFileUnsupportedDataFormatError) }
  }

  /// No more bytes: hand over the last packet, which the parser holds until it knows where it ends.
  func endOfInput() throws {
    guard let stream, !inputEnded else { return }
    _ = AudioFileStreamParseBytes(stream, 0, nil, [])
    inputEnded = true
    if converter == nil { throw Failure.unsupported(kAudioFileStreamError_DataUnavailable) }
  }

  /// Up to `maxFrames` frames from the packets parsed so far: empty when it needs more bytes, nil once it's done.
  func decode(maxFrames: Int) throws -> PCMBlock? {
    if outputEnded { return nil }
    guard let converter, let format else {
      return inputEnded ? nil : PCMBlock(left: [], right: [])
    }
    guard let out = AVAudioPCMBuffer(pcmFormat: EngineFormat.av, frameCapacity: AVAudioFrameCount(maxFrames)) else { return nil }
    var error: NSError?
    let status = converter.convert(to: out, error: &error) { [self] wanted, inputStatus in
      guard !packets.isEmpty else {
        inputStatus.pointee = inputEnded ? .endOfStream : .noDataNow
        return nil
      }
      let take = packets.prefix(max(1, Int(wanted)))
      let bytes = take.reduce(0) { $0 + $1.data.count }
      let maxPacket = take.map(\.data.count).max() ?? 0
      let buffer = AVAudioCompressedBuffer(format: format, packetCapacity: AVAudioPacketCount(take.count), maximumPacketSize: maxPacket)
      var offset = 0
      for (i, packet) in take.enumerated() {
        packet.data.withUnsafeBytes { raw in
          if let base = raw.baseAddress { buffer.data.advanced(by: offset).copyMemory(from: base, byteCount: raw.count) }
        }
        var description = packet.description
        description.mStartOffset = Int64(offset)
        buffer.packetDescriptions?[i] = description
        offset += packet.data.count
      }
      buffer.packetCount = AVAudioPacketCount(take.count)
      buffer.byteLength = UInt32(bytes)
      packets.removeFirst(take.count)
      inputStatus.pointee = .haveData
      return buffer
    }
    if status == .error { throw Failure.damaged(OSStatus(error?.code ?? -1)) }
    if status == .endOfStream { outputEnded = true }
    var block = PCMBlock(out)
    // An encoder's priming and padding (MP3, AAC) aren't part of the song: trimmed, for gapless joins.
    if toDrop > 0 {
      let dropped = min(toDrop, Int64(block.frames))
      block = block.dropping(Int(dropped))
      toDrop -= dropped
    }
    if let limit, produced + Int64(block.frames) > limit {
      block = block.slice(0..<Int(max(0, limit - produced)))
      outputEnded = true
    }
    produced += Int64(block.frames)
    if block.frames == 0 && outputEnded { return nil }
    return block
  }

  // MARK: AudioFileStream callbacks

  private func property(_ property: AudioFileStreamPropertyID, of stream: AudioFileStreamID) {
    switch property {
    case kAudioFileStreamProperty_DataFormat:
      var asbd = AudioStreamBasicDescription()
      var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
      if AudioFileStreamGetProperty(stream, property, &size, &asbd) == noErr { format = AVAudioFormat(streamDescription: &asbd) }
    case kAudioFileStreamProperty_MagicCookieData:
      var size: UInt32 = 0
      guard AudioFileStreamGetPropertyInfo(stream, property, &size, nil) == noErr, size > 0 else { return }
      var data = Data(count: Int(size))
      let status = data.withUnsafeMutableBytes { raw in
        raw.baseAddress.map { AudioFileStreamGetProperty(stream, property, &size, $0) } ?? kAudioFileStreamError_DataUnavailable
      }
      if status == noErr { cookie = data }
    case kAudioFileStreamProperty_PacketTableInfo:
      var info = AudioFilePacketTableInfo()
      var size = UInt32(MemoryLayout<AudioFilePacketTableInfo>.size)
      if AudioFileStreamGetProperty(stream, property, &size, &info) == noErr { packetTable = info }
    case kAudioFileStreamProperty_ReadyToProducePackets:
      makeConverter()
    default:
      break
    }
  }

  private func packets(_ count: UInt32, _ bytes: UnsafeRawPointer, _ descriptions: UnsafeMutablePointer<AudioStreamPacketDescription>?) {
    // Formats without packet descriptions are constant-size PCM, which this decoder doesn't take (see makeConverter).
    guard let descriptions else { return }
    for i in 0..<Int(count) {
      let d = descriptions[i]
      packets.append((Data(bytes: bytes.advanced(by: Int(d.mStartOffset)), count: Int(d.mDataByteSize)), d))
    }
  }

  private func makeConverter() {
    guard let format else { return }
    guard format.streamDescription.pointee.mFormatID != kAudioFormatLinearPCM else { return plainPCM = true }
    if let cookie { format.magicCookie = cookie }
    converter = AVAudioConverter(from: format, to: EngineFormat.av)
    if let table = packetTable, table.mNumberValidFrames > 0 {
      let ratio = EngineFormat.sampleRate / format.sampleRate
      toDrop = Int64((Double(table.mPrimingFrames) * ratio).rounded())
      limit = Int64((Double(table.mNumberValidFrames) * ratio).rounded())
    }
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter StreamDecoderTests
```

Expected: `Test run with 5 tests` … `passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/StreamDecoder.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/StreamDecoderTests.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/AudioFiles.swift
git commit -F - <<'EOF'
Decode FLAC and MP3 as they download, to the engine's 44.1 kHz

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

### Task 11: Whole files and levelled streams

A file all on disk decodes with `AVAudioFile` from an exact frame (AVAudioFile throws rather than reading nothing at its end, so the decoder stops before it). The levelled stream's bytes become frames however they're split, and every frame is at byte `44 + frame × 4`.

**Files:**
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/FileDecoder.swift`
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/LevelledWAV.swift`
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/WAVDecoder.swift`
- Test: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/FileDecoderTests.swift`
- Test: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/LevelledWAVTests.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/FileDecoderTests.swift`:

```swift
import Foundation
import Testing
@testable import PlayarrPlayer

struct FileDecoderTests {
  @Test func decodesAWholeFileFromAnExactFrame() throws {
    let url = try AudioFiles.flac(seconds: 1, rate: 48_000)
    let decoder = try FileDecoder(url: url, firstFrame: 0)
    var frames = 0
    while let block = try decoder.decode(maxFrames: 4096) { frames += block.frames }
    #expect(frames == 44_100)
    let sine = AudioFiles.sine(441, rate: 44_100)
    let late = try FileDecoder(url: try AudioFiles.flac(seconds: 1), firstFrame: 20_000)
    let first = try #require(try late.decode(maxFrames: 16))
    #expect(abs(first.left[0] - sine(20_000, 0)) < 1e-6)
  }
}
```

`apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/LevelledWAVTests.swift`:

```swift
import Foundation
import Testing
@testable import PlayarrPlayer

struct LevelledWAVTests {
  @Test func everyFrameIsAtAKnownByte() {
    #expect(LevelledWAV.byteOffset(ofFrame: 0) == 44)
    #expect(LevelledWAV.byteOffset(ofFrame: 1) == 48)
    #expect(LevelledWAV.byteOffset(ofFrame: 44_100) == 176_444)
    // 90.5 s into a song.
    #expect(LevelledWAV.byteOffset(ofFrame: EngineFormat.frames(90.5)) == 44 + 3_991_050 * 4)
  }

  @Test func itsRateIsTheEnginesSoFramesNeedNoConversion() {
    #expect(LevelledWAV.sampleRate == EngineFormat.sampleRate)
  }

  @Test func itsBytesDecodeToTheSameFramesHoweverTheyAreSplit() {
    let audio = AudioFiles.levelledWAV(frames: 100) { i, c in Float(i) / 200 * (c == 0 ? 1 : -1) }.dropFirst(44)
    var whole = WAVDecoder()
    let all = whole.decode(Data(audio))
    var split = WAVDecoder()
    var pieces = PCMBlock(left: [], right: [])
    for start in stride(from: audio.startIndex, to: audio.endIndex, by: 7) {
      let block = split.decode(Data(audio[start..<min(start + 7, audio.endIndex)]))
      pieces.left += block.left
      pieces.right += block.right
    }
    #expect(all.frames == 100)
    #expect(pieces == all)
    #expect(abs(all.left[50] - 0.25) < 1e-4)
    #expect(abs(all.right[50] + 0.25) < 1e-4)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter 'FileDecoderTests|LevelledWAVTests'
```

Expected: the build fails with `cannot find 'FileDecoder' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/FileDecoder.swift`:

```swift
import AVFoundation

/// Decodes a song whose file is all on this device (the stream cache's, later a download's): AVAudioFile reads any
/// format the system knows and seeks exactly, and an AVAudioConverter brings it to the engine's format.
final class FileDecoder {
  private let file: AVAudioFile
  private let converter: AVAudioConverter
  private var inputEnded = false

  /// Starts at `firstFrame` (engine frames, 44.1 kHz), converted to the file's rate.
  init(url: URL, firstFrame: Int64 = 0) throws {
    file = try AVAudioFile(forReading: url)
    guard let converter = AVAudioConverter(from: file.processingFormat, to: EngineFormat.av) else {
      throw PlaybackError.unsupported
    }
    self.converter = converter
    let ratio = file.processingFormat.sampleRate / EngineFormat.sampleRate
    file.framePosition = min(file.length, Int64((Double(firstFrame) * ratio).rounded()))
  }

  /// Up to `maxFrames` frames; nil at the end.
  func decode(maxFrames: Int) throws -> PCMBlock? {
    guard let out = AVAudioPCMBuffer(pcmFormat: EngineFormat.av, frameCapacity: AVAudioFrameCount(maxFrames)) else { return nil }
    var error: NSError?
    var readError: (any Error)?
    let status = converter.convert(to: out, error: &error) { [self] wanted, inputStatus in
      let left = file.length - file.framePosition
      guard !inputEnded, left > 0,
        let input = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: max(wanted, 4096))
      else {
        // AVAudioFile throws rather than reading nothing at its end: stop before it.
        inputEnded = true
        inputStatus.pointee = .endOfStream
        return nil
      }
      do {
        try file.read(into: input, frameCount: AVAudioFrameCount(min(Int64(input.frameCapacity), left)))
      } catch {
        readError = error
        inputStatus.pointee = .endOfStream
        return nil
      }
      inputStatus.pointee = .haveData
      return input
    }
    if status == .error || readError != nil { throw PlaybackError.undecodable }
    if out.frameLength == 0 && status == .endOfStream { return nil }
    return PCMBlock(out)
  }
}
```

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/LevelledWAV.swift`:

```swift
/// The server's levelled stream (`/stream/:fileId/levelled.wav?gain=`, apps/server/src/media/levelled.ts): 16-bit
/// stereo PCM at 44.1 kHz behind a 44-byte header, every byte at a known place. A range from any byte is decoded by
/// the server from that very sample, so a seek into it is exact.
public enum LevelledWAV {
  public static let headerBytes: Int64 = 44
  public static let bytesPerFrame: Int64 = 4
  public static let sampleRate: Double = 44_100

  /// The byte where frame `frame` (at 44.1 kHz) starts.
  public static func byteOffset(ofFrame frame: Int64) -> Int64 { headerBytes + frame * bytesPerFrame }
}
```

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/WAVDecoder.swift`:

```swift
import Foundation

/// Turns the bytes of a levelled stream's audio (16-bit little-endian stereo at 44.1 kHz, see `LevelledWAV`) into
/// engine frames. Bytes arrive in any split: an incomplete frame waits for the next chunk.
struct WAVDecoder {
  private var carry = Data()

  mutating func decode(_ data: Data) -> PCMBlock {
    let bytes = carry + data
    let frames = bytes.count / Int(LevelledWAV.bytesPerFrame)
    carry = bytes.suffix(from: bytes.startIndex + frames * Int(LevelledWAV.bytesPerFrame))
    var left = [Float](repeating: 0, count: frames)
    var right = [Float](repeating: 0, count: frames)
    bytes.withUnsafeBytes { raw in
      for i in 0..<frames {
        left[i] = Float(Int16(littleEndian: raw.loadUnaligned(fromByteOffset: i * 4, as: Int16.self))) / 32_768
        right[i] = Float(Int16(littleEndian: raw.loadUnaligned(fromByteOffset: i * 4 + 2, as: Int16.self))) / 32_768
      }
    }
    return PCMBlock(left: left, right: right)
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter 'FileDecoderTests|LevelledWAVTests'
```

Expected: `Test run with 4 tests` … `passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/FileDecoder.swift \
  apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/LevelledWAV.swift \
  apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/WAVDecoder.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/FileDecoderTests.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/LevelledWAVTests.swift
git commit -F - <<'EOF'
Decode whole files and the server's levelled WAV from an exact frame

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

### Task 12: The stream cache and fetching ahead

Songs' own files on disk, one folder per server and account, `<fileId>.<ext>` (`.part` while incomplete), one `Download` per file shared by its readers, least recently played dropped past 1 GB. Prefetch fetches one song at a time once nothing else downloads: 3 ahead on Wi-Fi, 1 on mobile data, none in Low Data Mode or offline (`loadAhead.ts`), from `NWPathMonitor`. Offline pinning is phase 7's and lives elsewhere.

**Files:**
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/StreamCache.swift`
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/NetworkMonitor.swift`
- Test: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/StreamCacheTests.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/StreamCacheTests.swift`:

```swift
import Foundation
import Testing
@testable import PlayarrPlayer

@Suite(.serialized)
struct StreamCacheTests {
  let body = Data(repeating: 7, count: 100_000)

  func cache(maxBytes: Int64 = 1 << 30) -> StreamCache {
    StreamCache(directory: temporaryDirectory(), maxBytes: maxBytes, retryDelay: .milliseconds(5), configuration: StubServer.configuration)
  }

  @Test func prefetchesOneSongAtATimeInOrder() async throws {
    for id in 201...203 { StubServer.serve("/stream/\(id)", .init(body: body)) }
    let cache = cache()
    await cache.prefetch((201...203).map { (song($0), StubServer.request("/stream/\($0)")) })
    for _ in 0..<500 where await cache.completedFile(for: song(203)) == nil { try await Task.sleep(for: .milliseconds(2)) }
    #expect(await cache.completedFile(for: song(203)) != nil)
    #expect(StubServer.requests("/stream/201").count == 1)
    #expect(StubServer.requests("/stream/203").count == 1)
  }

  @Test func theNetworkPolicyIsThreeOnWiFiOneOnMobileDataNoneOtherwise() {
    #expect(PrefetchPolicy.songsAhead(on: .wifi) == 3)
    #expect(PrefetchPolicy.songsAhead(on: .cellular) == 1)
    #expect(PrefetchPolicy.songsAhead(on: .constrained) == 0)
    #expect(PrefetchPolicy.songsAhead(on: .offline) == 0)
  }

  @Test func dropsTheLeastRecentlyPlayedPastItsLimit() async throws {
    for id in 211...213 { StubServer.serve("/stream/\(id)", .init(body: body)) }
    let cache = cache(maxBytes: 250_000)
    for id in 211...213 {
      try await cache.download(for: song(id), request: StubServer.request("/stream/\(id)")).waitUntilFinished()
      try await Task.sleep(for: .milliseconds(20))
    }
    try await Task.sleep(for: .milliseconds(50))
    #expect(await cache.completedFile(for: song(211)) == nil)
    #expect(await cache.completedFile(for: song(213)) != nil)
  }

  @Test func keepOnlyStopsTheOthers() async throws {
    StubServer.serve("/stream/221", .init(body: body, pause: .seconds(5)))
    let cache = cache()
    let d = await cache.download(for: song(221), request: StubServer.request("/stream/221"))
    await cache.keepOnly([])
    await #expect(throws: CancellationError.self) { try await d.waitUntilFinished() }
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter StreamCacheTests
```

Expected: the build fails with `cannot find 'StreamCache' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/StreamCache.swift`:

```swift
import Foundation
import PlayarrAPI

/// Songs' own files on disk, fetched ahead of playback: one `Download` per file at a time, shared by whoever reads
/// it. Files are named by file id (`<fileId>.<ext>`, `.part` while incomplete), one folder per server and account
/// (the caller's `directory`). The least recently played go first past `maxBytes`. Keeping songs for offline
/// listening is phase 7's, outside this cache.
public actor StreamCache {
  public let directory: URL
  private let maxBytes: Int64
  private let configuration: @Sendable () -> URLSessionConfiguration
  private let retryDelay: Duration
  private var downloads: [Int: Download] = [:]
  private var waiting: [(Track, URLRequest)] = []

  public init(
    directory: URL, maxBytes: Int64 = 1 << 30, retryDelay: Duration = .seconds(1),
    configuration: @escaping @Sendable () -> URLSessionConfiguration = { .default }
  ) {
    self.directory = directory
    self.maxBytes = maxBytes
    self.retryDelay = retryDelay
    self.configuration = configuration
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  }

  public func file(for track: Track) -> URL { directory.appending(path: "\(track.fileId).\(track.format.container.lowercased())") }

  /// The whole file, if it's here. Marks it as just played.
  public func completedFile(for track: Track) -> URL? {
    let url = file(for: track)
    guard FileManager.default.fileExists(atPath: url.path()) else { return nil }
    try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path())
    return url
  }

  /// The download of this song's file, started (or continued from what's here) if it isn't running.
  public func download(for track: Track, request: URLRequest) -> Download {
    if let running = downloads[track.fileId], running.isActive || running.isFinished { return running }
    let final = file(for: track)
    let d = Download(
      request: request, file: final.appendingPathExtension("part"), finalFile: final, retryDelay: retryDelay,
      configuration: configuration)
    d.onFinish { [weak self] in Task { await self?.finished() } }
    downloads[track.fileId] = d
    d.start()
    return d
  }

  /// A download outside the cache (a levelled stream from a seek), into a file of its own removed on `discard`.
  public func temporary(request: URLRequest, firstByte: Int64) -> Download {
    let d = Download(
      request: request, firstByte: firstByte, file: directory.appending(path: "levelled-\(UUID().uuidString).wav"),
      retryDelay: retryDelay, configuration: configuration)
    d.start()
    return d
  }

  public func discard(_ download: Download) {
    download.cancel()
    try? FileManager.default.removeItem(at: download.file)
  }

  /// The songs to fetch ahead, in order (the next 3 on Wi-Fi, 1 on mobile data: see `PrefetchPolicy`): one at a time,
  /// once nothing else is downloading. Replaces the earlier list.
  public func prefetch(_ songs: [(Track, URLRequest)]) {
    waiting = songs.filter { completedFile(for: $0.0) == nil }
    pump()
  }

  /// Stops the downloads of other songs (what's here stays, and continues later).
  public func keepOnly(_ fileIds: Set<Int>) {
    for (id, d) in downloads where !fileIds.contains(id) && !d.isFinished {
      d.cancel()
      downloads[id] = nil
    }
    waiting.removeAll { !fileIds.contains($0.0.fileId) }
  }

  private func finished() {
    evict()
    pump()
  }

  private func pump() {
    guard !downloads.values.contains(where: \.isActive), !waiting.isEmpty else { return }
    let (track, request) = waiting.removeFirst()
    _ = download(for: track, request: request)
  }

  private func evict() {
    let keys: [URLResourceKey] = [.contentModificationDateKey, .fileSizeKey]
    guard let files = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: keys) else { return }
    let busy = Set(downloads.values.filter(\.isActive).map(\.file))
    var entries = files.compactMap { url -> (URL, Date, Int64)? in
      guard !busy.contains(url), let v = try? url.resourceValues(forKeys: Set(keys)) else { return nil }
      return (url, v.contentModificationDate ?? .distantPast, Int64(v.fileSize ?? 0))
    }
    var total = entries.reduce(0) { $0 + $1.2 }
    entries.sort { $0.1 < $1.1 }
    for (url, _, size) in entries where total > maxBytes {
      try? FileManager.default.removeItem(at: url)
      total -= size
    }
  }
}
```

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/NetworkMonitor.swift`:

```swift
import Foundation
import Network
import Observation

public enum NetworkKind: Sendable, Equatable {
  case wifi
  /// Mobile data or a hotspot.
  case cellular
  /// Low Data Mode (the web's data saver).
  case constrained
  case offline
}

/// How many songs after the current one to fetch ahead (`loadAhead.ts` on the web): 3 on Wi-Fi, 1 on mobile data,
/// none in Low Data Mode or offline.
public enum PrefetchPolicy {
  public static func songsAhead(on network: NetworkKind) -> Int {
    switch network {
    case .wifi: 3
    case .cellular: 1
    case .constrained, .offline: 0
    }
  }
}

/// The network the phone is on, from NWPathMonitor.
@MainActor @Observable
public final class NetworkMonitor {
  public private(set) var kind: NetworkKind = .wifi
  @ObservationIgnored private let monitor = NWPathMonitor()

  public init() {
    monitor.pathUpdateHandler = { [weak self] path in
      let kind = NetworkKind(path)
      Task { @MainActor in self?.kind = kind }
    }
    monitor.start(queue: DispatchQueue(label: "playarr.network"))
  }

  isolated deinit { monitor.cancel() }
}

extension NetworkKind {
  init(_ path: NWPath) {
    if path.status != .satisfied {
      self = .offline
    } else if path.isConstrained {
      self = .constrained
    } else if path.isExpensive {
      self = .cellular
    } else {
      self = .wifi
    }
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter StreamCacheTests
```

Expected: `Test run with 4 tests` … `passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/StreamCache.swift \
  apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/NetworkMonitor.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/StreamCacheTests.swift
git commit -F - <<'EOF'
Cache songs' files per account and fetch ahead: 3 on Wi-Fi, 1 on mobile data

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

### Task 13: TrackSource: a song's audio from any frame

The four ways of key decision 8, the fallbacks, and the web's error messages. A seek past the download asks `levelled.wav` from byte `44 + 44 100 × 4 = 176 444` for frame 44 100, and the first sample is that frame's.

**Files:**
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/TrackSource.swift`
- Test: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/TrackSourceTests.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/TrackSourceTests.swift`:

```swift
import Foundation
import Testing
@testable import PlayarrPlayer

@Suite(.serialized)
struct TrackSourceTests {
  let sine = AudioFiles.sine(441, rate: 44_100)

  func source(_ id: Int, container: String = "flac", from frame: Int64 = 0, levelled: Bool = false, cache: StreamCache? = nil) -> (TrackSource, StreamCache) {
    let cache = cache ?? StreamCache(directory: temporaryDirectory(), retryDelay: .milliseconds(5), configuration: StubServer.configuration)
    let origin = TrackSource.Origin(
      stream: StubServer.request("/stream/\(id)"),
      levelled: levelled ? StubServer.request("/stream/\(id)/levelled.wav") : nil)
    let session = URLSession(configuration: StubServer.configuration())
    return (TrackSource(track: song(id, container: container), firstFrame: frame, origin: origin, cache: cache, probeSession: session), cache)
  }

  func readAll(_ source: TrackSource) async throws -> PCMBlock {
    var all = PCMBlock(left: [], right: [])
    while let block = try await source.read(maxFrames: 22_050) {
      all.left += block.left
      all.right += block.right
    }
    return all
  }

  @Test func playsAFLACFromTheStartAsItDownloads() async throws {
    StubServer.serve("/stream/101", .init(body: try Data(contentsOf: AudioFiles.flac(seconds: 2)), chunk: 4096))
    let (source, _) = source(101)
    let pcm = try await readAll(source)
    #expect(pcm.frames == 88_200)
    #expect(abs(pcm.left[12_345] - sine(12_345, 0)) < 1e-6)
  }

  @Test func aSeekBeyondTheDownloadPlaysTheLevelledStreamFromThatSample() async throws {
    StubServer.serve("/stream/102", .init(body: try Data(contentsOf: AudioFiles.flac(seconds: 2)), pause: .seconds(5)))
    let ramp: (Int, Int) -> Float = { i, c in Float(i % 1000) / 2000 * (c == 0 ? 1 : -1) }
    StubServer.serve("/stream/102/levelled.wav", .init(body: AudioFiles.levelledWAV(frames: 88_200, signal: ramp)))
    let (source, _) = source(102, from: 44_100, levelled: true)
    let first = try #require(try await source.read(maxFrames: 4096))
    #expect(StubServer.requests("/stream/102/levelled.wav") == ["bytes=176444-"])
    #expect(abs(first.left[0] - ramp(44_100, 0)) < 1e-4)
    #expect(abs(first.right[7] - ramp(44_107, 1)) < 1e-4)
    await source.close()
  }

  @Test func aSeekIntoASongNotMeasuredDecodesFromTheStartAndDropsUpToIt() async throws {
    StubServer.serve("/stream/103", .init(body: try Data(contentsOf: AudioFiles.flac(seconds: 2))))
    let (source, _) = source(103, from: 30_000)
    let pcm = try await readAll(source)
    #expect(pcm.frames == 88_200 - 30_000)
    #expect(abs(pcm.left[0] - sine(30_000, 0)) < 1e-6)
  }

  @Test func aSongAlreadyInTheCachePlaysFromDiskWithAnExactSeek() async throws {
    StubServer.serve("/stream/104", .init(body: try Data(contentsOf: AudioFiles.flac(seconds: 2))))
    let (first, cache) = source(104)
    _ = try await readAll(first)
    try await Task.sleep(for: .milliseconds(50))  // the download's last callback renames the file
    let asked = StubServer.requests("/stream/104").count
    let (again, _) = source(104, from: 10_000, cache: cache)
    let pcm = try await readAll(again)
    #expect(StubServer.requests("/stream/104").count == asked)
    #expect(pcm.frames == 78_200)
    #expect(abs(pcm.left[0] - sine(10_000, 0)) < 1e-6)
  }

  @Test func aFormatItCannotStreamPlaysFromTheLevelledStream() async throws {
    StubServer.serve("/stream/105", .init(body: Data(repeating: 1, count: 1000)))
    StubServer.serve("/stream/105/levelled.wav", .init(body: AudioFiles.levelledWAV(frames: 1000, signal: { _, _ in 0.25 })))
    let (source, _) = source(105, container: "ogg", levelled: true)
    let pcm = try await readAll(source)
    #expect(pcm.frames == 1000)
    #expect(pcm.left[500] == 0.25)
  }

  @Test func explainsFailuresInTheWebsWords() async throws {
    let (missing, _) = source(106)  // no route: the stub answers 404 {"error":"Unknown track file"}
    await #expect(throws: PlaybackError.server("Unknown track file")) { try await missing.read(maxFrames: 4096) }

    StubServer.serve("/stream/107", .init(body: try Data(contentsOf: AudioFiles.flac(seconds: 2)), breakAfter: 1000, breaks: 4))
    let (breaking, _) = source(107)
    await #expect(throws: PlaybackError.keptBreakingOff) { _ = try await readAll(breaking) }

    StubServer.serve("/stream/108", .init(body: Data(repeating: 0x42, count: 50_000)))
    let (damaged, _) = source(108)
    await #expect(throws: PlaybackError.unsupported) { _ = try await readAll(damaged) }

    StubServer.serve("/stream/109", .init(body: Data(), unreachable: true))
    let (away, _) = source(109)
    await #expect(throws: PlaybackError.unreachable) { _ = try await readAll(away) }
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter TrackSourceTests
```

Expected: the build fails with `cannot find 'TrackSource' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/TrackSource.swift`:

```swift
import Foundation
import PlayarrAPI

/// A song's audio for a deck, from a frame on: its own file, downloaded ahead into the stream cache and decoded as it
/// arrives; or, for a seek beyond what's downloaded, the server's levelled stream at gain 0 from that very sample
/// while the download catches up. Which one is chosen at the first read:
///
/// 1. The whole file is in the cache: decoded from disk (`FileDecoder`), exact seek.
/// 2. From the start: the file's download, decoded progressively (`StreamDecoder`).
/// 3. From a later frame, the song measured (`origin.levelled` set): `levelled.wav?gain=0` from byte
///    `44 + frame × 4`; the file's download carries on for next time.
/// 4. From a later frame, not measured: the file from its start, decoding and dropping frames up to the seek.
///
/// A file the decoder can't stream (unknown format) plays from the levelled stream if there is one, else once
/// downloaded whole. Broken connections are retried by `Download`; what's left is explained in the web's words.
public actor TrackSource: PCMSource {
  public struct Origin: Sendable {
    /// The song's own file (`/stream/:fileId`), authorized.
    public var stream: URLRequest
    /// Its levelled stream at gain 0, when the server has measured the song; nil otherwise.
    public var levelled: URLRequest?
    public init(stream: URLRequest, levelled: URLRequest?) {
      self.stream = stream
      self.levelled = levelled
    }
  }

  static let readSize = 64 * 1024

  private enum Mode {
    case file(FileDecoder)
    case stream(Download, StreamDecoder)
    case levelled(Download)
  }

  private let track: Track
  private let firstFrame: Int64
  private let origin: Origin
  private let cache: StreamCache
  private let probeSession: URLSession
  private var mode: Mode?
  private var readOffset: Int64 = 0
  private var skipFrames: Int64 = 0
  private var wav = WAVDecoder()
  private var produced = false
  private var closed = false

  public init(track: Track, firstFrame: Int64, origin: Origin, cache: StreamCache, probeSession: URLSession = .shared) {
    self.track = track
    self.firstFrame = firstFrame
    self.origin = origin
    self.cache = cache
    self.probeSession = probeSession
  }

  public func read(maxFrames: Int) async throws -> PCMBlock? {
    do {
      while !closed {
        if mode == nil { mode = try await open() }
        guard let block = try await next(maxFrames: maxFrames) else { return nil }
        if block.frames > 0 {
          produced = true
          return block
        }
      }
      return nil
    } catch let error as PlaybackError {
      throw error
    } catch is CancellationError {
      throw CancellationError()
    } catch Download.Failure.server(_, let message) {
      throw PlaybackError.server(message ?? "Playback failed")
    } catch is Download.Failure {
      throw await PlaybackError.diagnose(.network, probe: origin.stream, session: probeSession)
    } catch {
      throw await PlaybackError.diagnose(.decoding, probe: origin.stream, session: probeSession)
    }
  }

  public func close() async {
    closed = true
    if case .levelled(let download) = mode { await cache.discard(download) }
    mode = nil
  }

  private func open() async throws -> Mode {
    if let url = await cache.completedFile(for: track) {
      return .file(try FileDecoder(url: url, firstFrame: firstFrame))
    }
    let download = await cache.download(for: track, request: origin.stream)
    if firstFrame > 0, origin.levelled != nil { return try await levelled() }
    guard let type = StreamDecoder.fileType(forContainer: track.format.container) else { return try await fallback(download) }
    skipFrames = firstFrame
    readOffset = 0
    return .stream(download, try StreamDecoder(fileType: type))
  }

  /// The levelled stream from `firstFrame`, exact to the sample.
  private func levelled() async throws -> Mode {
    guard let request = origin.levelled else { throw PlaybackError.unsupported }
    readOffset = 0
    return .levelled(await cache.temporary(request: request, firstByte: LevelledWAV.byteOffset(ofFrame: firstFrame)))
  }

  /// A file the decoder can't stream: its levelled stream, else the whole file once it's here.
  private func fallback(_ download: Download) async throws -> Mode {
    if origin.levelled != nil { return try await levelled() }
    try await download.waitUntilFinished()
    do {
      return .file(try FileDecoder(url: download.file, firstFrame: firstFrame))
    } catch {
      throw await PlaybackError.diagnose(.format, probe: origin.stream, session: probeSession)
    }
  }

  /// The next frames of the chosen way: empty when it wants calling again, nil at the end.
  private func next(maxFrames: Int) async throws -> PCMBlock? {
    switch mode {
    case .file(let decoder):
      return try decoder.decode(maxFrames: maxFrames)

    case .stream(let download, let decoder):
      do {
        guard let block = try decoder.decode(maxFrames: maxFrames) else { return nil }
        if block.frames == 0 {
          let data = try await download.bytes(at: readOffset, maxLength: Self.readSize)
          if data.isEmpty {
            try decoder.endOfInput()
          } else {
            readOffset += Int64(data.count)
            try decoder.feed(data)
          }
          return PCMBlock(left: [], right: [])
        }
        guard skipFrames > 0 else { return block }
        let dropped = min(skipFrames, Int64(block.frames))
        skipFrames -= dropped
        return block.dropping(Int(dropped))
      } catch StreamDecoder.Failure.unsupported where !produced {
        mode = try await fallback(download)
        return PCMBlock(left: [], right: [])
      }

    case .levelled(let download):
      do {
        let data = try await download.bytes(at: readOffset, maxLength: min(Self.readSize, maxFrames * 4))
        if data.isEmpty { return nil }
        readOffset += Int64(data.count)
        return wav.decode(data)
      } catch Download.Failure.server where !produced {
        // No levelled stream after all (the file changed since it was measured): its own file from the start.
        await cache.discard(download)
        let file = await cache.download(for: track, request: origin.stream)
        guard let type = StreamDecoder.fileType(forContainer: track.format.container) else {
          try await file.waitUntilFinished()
          mode = .file(try FileDecoder(url: file.file, firstFrame: firstFrame))
          return PCMBlock(left: [], right: [])
        }
        skipFrames = firstFrame
        readOffset = 0
        mode = .stream(file, try StreamDecoder(fileType: type))
        return PCMBlock(left: [], right: [])
      }

    case nil:
      return nil
    }
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter TrackSourceTests
```

Expected: `Test run with 6 tests` … `passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/TrackSource.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/TrackSourceTests.swift
git commit -F - <<'EOF'
Open a song's audio from any frame: its file, or the levelled stream past the download

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

### Task 14: The engine: decks on one timeline, gapless and crossfaded joins, gains, the limiter

The graph of key decision 1, epochs, cueing and placing the next song, holding back a song's end, events (`advanced`, `ended`, `failed`), pause. Seeking, running short, output changes and the transition seam come in Task 15. Tests render the real graph offline with synthetic songs: a 441 Hz sine (exactly 441 cycles a second, so a whole-second song ends at phase 0) must run through the join as one sine to 1e-4; a crossfade puts A in the left ear and B in the right, so each fade is read off its own channel and their powers must sum to the same value at every point; `latency(of:matching:)` finds the limiter's 88-sample delay instead of assuming it.

**Files:**
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/EngineItem.swift`
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Deck.swift`
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/AudioEngine.swift`
- Test: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/AudioEngineTests.swift`
- Test support: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/Signals.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/Signals.swift`:

```swift
import AVFoundation
import Foundation
@testable import PlayarrPlayer

/// A synthetic song: `signal(frame)` per channel for `seconds`, from `firstFrame` on (as a seek would ask).
actor SignalSource: PCMSource {
  let total: Int64
  let signal: @Sendable (Int64, Int) -> Float
  private var position: Int64
  private var gate: Gate?
  private var gateAfter: Int64 = .max

  init(seconds: Double, from firstFrame: Int64 = 0, signal: @escaping @Sendable (Int64, Int) -> Float) {
    total = EngineFormat.frames(seconds)
    position = firstFrame
    self.signal = signal
  }

  /// After `frames`, every read waits for the gate to open once (a slow network).
  func stall(after frames: Int64, until gate: Gate) {
    gateAfter = frames
    self.gate = gate
  }

  func read(maxFrames: Int) async throws -> PCMBlock? {
    if position >= gateAfter, let gate {
      await gate.wait()
      self.gate = nil
    }
    guard position < total else { return nil }
    let range = position..<min(position + Int64(maxFrames), total)
    position = range.upperBound
    return PCMBlock(left: range.map { signal($0, 0) }, right: range.map { signal($0, 1) })
  }

  func close() {}
}

enum Signals {
  /// A 441 Hz sine at amplitude 0.5: exactly 441 cycles a second, so a song of whole seconds ends at phase 0.
  static let sine: @Sendable (Int64, Int) -> Float = { n, _ in Float(0.5 * sin(2 * .pi * 441 * Double(n) / 44_100)) }
  static func constant(_ left: Float, _ right: Float) -> @Sendable (Int64, Int) -> Float { { _, c in c == 0 ? left : right } }
}

extension AudioEngine {
  /// An offline engine whose songs are synthetic: `signals[track.id]` for `track.duration` seconds.
  static func offline(_ signals: [Int: @Sendable (Int64, Int) -> Float], tuning: Tuning = Tuning()) throws -> AudioEngine {
    try AudioEngine(tuning: tuning, manualRendering: true) { item, firstFrame in
      SignalSource(seconds: item.track.duration, from: firstFrame, signal: signals[item.track.id] ?? Signals.sine)
    }
  }

  /// Lets every read in flight finish and the engine pump, until nothing is being read, or nothing has been decoded
  /// for 50 ms (a stalled source).
  func settle() async {
    var progress = -1
    var still = 0
    while still < 50 {
      pump()
      let all = decks + [transitionDeck]
      if all.allSatisfy({ $0.reading == nil }) { return }
      let now = all.reduce(0) { $0 + Int($1.segment?.decoded ?? 0) }
      still = now == progress ? still + 1 : 0
      progress = now
      try? await Task.sleep(for: .milliseconds(1))
    }
  }

  /// Renders up to `seconds` offline, settling between blocks of 4096 frames (about the Player's 10 Hz tick). Stops
  /// early when the engine stops running (paused, buffering).
  func render(seconds: Double) async throws -> PCMBlock {
    var out = PCMBlock(left: [], right: [])
    var left = Int(EngineFormat.frames(seconds))
    let buffer = AVAudioPCMBuffer(pcmFormat: engine.manualRenderingFormat, frameCapacity: 4096)!
    while left > 0 {
      await settle()
      guard engine.isRunning else { break }
      let n = min(4096, left)
      _ = try engine.renderOffline(AVAudioFrameCount(n), to: buffer)
      let block = PCMBlock(buffer)
      out.left += block.left
      out.right += block.right
      left -= n
    }
    await settle()
    return out
  }
}

/// The limiter's lookahead delays everything by a few milliseconds: the lag (in frames) at which `out` matches
/// `expected`, searched up to 512.
func latency(of out: PCMBlock, matching expected: (Int) -> Float) -> Int {
  (0..<512).min { a, b in
    let ea = (0..<2000).reduce(Float(0)) { $0 + abs(out.left[$1 + a] - expected($1)) }
    let eb = (0..<2000).reduce(Float(0)) { $0 + abs(out.left[$1 + b] - expected($1)) }
    return ea < eb
  } ?? 0
}
```

`apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/AudioEngineTests.swift`:

```swift
import AVFoundation
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrPlayer

/// The engine rendered offline (manual rendering mode): every join, fade and gain checked to the sample.
@MainActor
@Suite(.serialized)
struct AudioEngineTests {
  @Test func twoSongsJoinWithoutAGapToTheSample() async throws {
    let audio = try AudioEngine.offline([1: Signals.sine, 2: { n, c in Signals.sine(n, c) }])
    var events: [EngineEvent] = []
    audio.onEvent = { events.append($0) }
    let a = EngineItem(track: song(1, duration: 1)), b = EngineItem(track: song(2, duration: 1))
    audio.load(a, playing: true)
    audio.setUpcoming(b, join: .crossfade(seconds: 0))
    let out = try await audio.render(seconds: 2.1)
    let sine = { (n: Int) in Signals.sine(Int64(n), 0) }
    let lag = latency(of: out, matching: sine)
    // One continuous sine across the join at frame 44 100: any gap, overlap or click would break it.
    let worst = (40_000..<48_000).map { abs(out.left[$0 + lag] - sine($0 % 44_100)) }.max() ?? 1
    #expect(worst < 1e-4)
    #expect(events.contains(.advanced(b.id)))
    #expect(events.last == .ended(b.id))
  }

  @Test func aCrossfadeIsEqualPowerAndEndsWhereTheSongEnds() async throws {
    // A in the left ear only, B in the right only: the fade of each can be read off its own channel.
    let audio = try AudioEngine.offline([1: Signals.constant(0.4, 0), 2: Signals.constant(0, 0.4)])
    audio.load(EngineItem(track: song(1, duration: 3)), playing: true)
    audio.setUpcoming(EngineItem(track: song(2, duration: 3)), join: .crossfade(seconds: 1))
    let out = try await audio.render(seconds: 4)
    let lag = (0..<512).first { out.left[$0] > 0.2 } ?? 0
    let fadeStart = 2 * 44_100 + lag, fadeEnd = 3 * 44_100 + lag
    #expect(abs(out.left[fadeStart - 10] - 0.4) < 1e-4)
    #expect(out.right[fadeStart - 10] == 0)
    for i in stride(from: fadeStart, to: fadeEnd, by: 441) {
      let power = out.left[i] * out.left[i] + out.right[i] * out.right[i]
      #expect(abs(power - 0.16) < 1e-3)
    }
    #expect(abs(out.left[fadeStart + 22_050] - 0.4 * Float(0.5.squareRoot())) < 1e-3)
    #expect(abs(out.left[fadeEnd + 10]) < 1e-4)
    #expect(abs(out.right[fadeEnd + 10] - 0.4) < 1e-4)
  }

  @Test func gainsGoUpAsWellAsDownAndTheLimiterHoldsPeaksUnderMinusOneDB() async throws {
    let quiet = try AudioEngine.offline([1: Signals.constant(0.25, 0.25)])
    quiet.load(EngineItem(track: song(1, duration: 1), gainDb: 6), playing: true)
    let raised = try await quiet.render(seconds: 0.5)
    #expect(abs(raised.left[10_000] - 0.25 * Float(pow(10, 6.0 / 20))) < 1e-3)

    let loud = try AudioEngine.offline([1: { n, _ in Float(0.9 * sin(2 * .pi * 1000 * Double(n) / 44_100)) }])
    loud.load(EngineItem(track: song(1, duration: 2), gainDb: 6), playing: true)
    let limited = try await loud.render(seconds: 1.5)
    let peak = limited.left.dropFirst(4410).map(abs).max() ?? 1
    #expect(peak <= Float(pow(10, -1.0 / 20)) + 1e-4)
    #expect(peak > 0.8)
  }

  @Test func aSongThatFailsSaysWhyAndStops() async throws {
    struct Broken: PCMSource {
      func read(maxFrames: Int) async throws -> PCMBlock? { throw PlaybackError.unreachable }
      func close() async {}
    }
    let audio = try AudioEngine(manualRendering: true) { _, _ in Broken() }
    var events: [EngineEvent] = []
    audio.onEvent = { events.append($0) }
    let item = EngineItem(track: song(1))
    audio.load(item, playing: true)
    await audio.settle()
    #expect(events == [.failed(item.id, .unreachable)])
    #expect(audio.state == .idle)
  }

  @Test func pausingFreezesTheTimelineAndPlayGoesOnFromThere() async throws {
    let audio = try AudioEngine.offline([1: Signals.sine])
    audio.load(EngineItem(track: song(1, duration: 3)), playing: true)
    _ = try await audio.render(seconds: 1)
    audio.pause()
    #expect(audio.state == .paused)
    let position = audio.position
    #expect(try await audio.render(seconds: 1).frames == 0)
    audio.play()
    let out = try await audio.render(seconds: 0.5)
    let start = EngineFormat.frames(position)
    let lag = latency(of: out) { Signals.sine(Int64($0) + start, 0) }
    #expect(lag < 512)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter AudioEngineTests
```

Expected: the build fails with `cannot find 'AudioEngine' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/EngineItem.swift`:

```swift
import Foundation
import PlayarrAPI

/// One play of a song, as handed to the engine: a new id each time (the same song twice in a queue is two items).
public struct EngineItem: Sendable, Equatable, Identifiable {
  public let id: UUID
  public var track: Track
  /// The song's even-volume gain (dB), up as well as down; 0 plays it as it is.
  public var gainDb: Double
  /// Seconds into the song where it starts.
  public var startAt: Double

  public init(id: UUID = UUID(), track: Track, gainDb: Double = 0, startAt: Double = 0) {
    self.id = id
    self.track = track
    self.gainDb = gainDb
    self.startAt = startAt
  }
}

/// How the upcoming item joins the current one.
public enum Join: Sendable, Equatable {
  /// It starts where the current one ends, overlapping by `seconds` with equal-power fades (0: gapless).
  case crossfade(seconds: Double)
  // Phase 5 adds `.transition(...)`: a rendered transition file on the transition node and the next song's own file
  // from `bResume`, both placed with `timelineSample(of:songFrame:)` and `scheduleTransition(_:at:envelope:)`.
}

public enum EngineState: Sendable, Equatable {
  case idle
  /// Decoding the first seconds before starting.
  case loading
  case playing
  case paused
  /// Ran short of audio (a slow network): held until enough is decoded again.
  case buffering
}

public enum EngineEvent: Sendable, Equatable {
  /// The upcoming item took over: its first sample is playing (the one before may still be fading out).
  case advanced(UUID)
  /// The item played to its end with nothing joined after it.
  case ended(UUID)
  /// The item couldn't play.
  case failed(UUID, PlaybackError)
}

/// What the Player lab shows of a deck.
public struct DeckSnapshot: Sendable, Equatable {
  public let name: String
  public let title: String?
  /// Timeline second where it starts; nil while cued.
  public let startsAt: Double?
  public let decodedSeconds: Double
  public let scheduledSeconds: Double
  public let finished: Bool
  public let gain: Float
}

public struct EngineSnapshot: Sendable, Equatable {
  public let state: EngineState
  public let now: Double
  public let decks: [DeckSnapshot]
}
```

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Deck.swift`:

```swift
import AVFoundation

/// A player node and its mixer, fed from one `PCMSource` at a time onto the engine's shared timeline. It decodes
/// ahead in blocks of half a second, applies its `GainEnvelope` to each block and schedules it at its exact sample.
/// Near the end of a song it holds back the last seconds until the end is known, so a fade out can still be applied.
///
/// A deck never stops its node on its own: stopping resets a node's clock, and the decks only share one while they
/// are started together (see `AudioEngine.resetEpoch`).
@MainActor
final class Deck {
  struct Segment {
    let id: UUID
    let source: any PCMSource
    /// The song frame the segment starts at (0, or where playback started in the song).
    let firstFrame: Int64
    /// Frames the song is expected to have from `firstFrame` on (from its duration): where holding back starts.
    let expectedFrames: Int64
    /// Frames kept back near the end until the end is known.
    let holdback: Int64
    /// Timeline sample of `firstFrame`; nil while cued (decoding ahead, not placed yet).
    var timelineStart: SampleTime?
    var envelope: GainEnvelope
    var pending: [PCMBlock] = []
    var decoded: Int64 = 0
    var scheduled: Int64 = 0
    var finished = false

    var end: SampleTime? { finished ? timelineStart.map { $0 + decoded } : nil }
    var scheduledEnd: SampleTime? { timelineStart.map { $0 + scheduled } }
    var fullyScheduled: Bool { finished && pending.isEmpty }
  }

  let name: String
  let node = AVAudioPlayerNode()
  let mixer = AVAudioMixerNode()
  private(set) var segment: Segment?
  private(set) var reading: Task<Void, Never>?
  /// A read finished: the engine looks at what changed.
  var onProgress: (() -> Void)?
  var onError: ((UUID, any Error) -> Void)?

  init(name: String) { self.name = name }

  func load(id: UUID, source: any PCMSource, firstFrame: Int64, expectedFrames: Int64, holdback: Int64, envelope: GainEnvelope) {
    release()
    segment = Segment(id: id, source: source, firstFrame: firstFrame, expectedFrames: expectedFrames, holdback: holdback, envelope: envelope)
  }

  func place(at sample: SampleTime) { segment?.timelineStart = sample }
  func setFadeIn(_ ramp: Ramp) { segment?.envelope.fadeIn = ramp }
  func setFadeOut(_ ramp: Ramp) { segment?.envelope.fadeOut = ramp }
  func setGain(_ gainDb: Double) { segment?.envelope.gain = GainEnvelope(gainDb: gainDb).gain }

  /// Forgets the segment (its source is closed). What's already scheduled still plays: only `stop` clears that.
  func release() {
    reading?.cancel()
    reading = nil
    if let source = segment?.source { Task { await source.close() } }
    segment = nil
  }

  /// Clears what's scheduled and resets the node's clock: only as part of a new epoch.
  func stop() {
    release()
    node.stop()
  }

  /// Schedules what is decoded and due, and reads more if fewer than `ahead + holdback` frames are decoded ahead.
  func pump(now: SampleTime, ahead: Int64, block: Int64) {
    scheduleReady(now: now, ahead: ahead)
    guard reading == nil, let s = segment, !s.finished else { return }
    let decodedAhead = s.timelineStart.map { $0 + s.decoded - now } ?? s.decoded
    guard decodedAhead < ahead + s.holdback + block else { return }
    let (source, id) = (s.source, s.id)
    reading = Task { [weak self] in
      do {
        let pcm = try await source.read(maxFrames: Int(block))
        self?.received(pcm, for: id)
      } catch is CancellationError {
        return
      } catch {
        self?.failed(error, for: id)
      }
    }
  }

  private func received(_ pcm: PCMBlock?, for id: UUID) {
    guard segment?.id == id else { return }
    reading = nil
    if let pcm {
      if pcm.frames > 0 {
        segment?.pending.append(pcm)
        segment?.decoded += Int64(pcm.frames)
      }
    } else {
      segment?.finished = true
    }
    onProgress?()
  }

  private func failed(_ error: any Error, for id: UUID) {
    guard segment?.id == id else { return }
    reading = nil
    onError?(id, error)
  }

  private func scheduleReady(now: SampleTime, ahead: Int64) {
    guard var s = segment, let start = s.timelineStart else { return }
    let holdFrom = s.expectedFrames - s.holdback
    while let pcm = s.pending.first {
      let at = start + s.scheduled
      let blockEnd = s.scheduled + Int64(pcm.frames)
      guard at < now + ahead else { break }
      // Near the end, a block waits until the end is known or enough beyond it is decoded: it might fade out.
      if !s.finished && s.holdback > 0 && blockEnd > holdFrom && blockEnd > s.decoded - s.holdback { break }
      s.pending.removeFirst()
      var scaled = pcm
      s.envelope.apply(to: &scaled, at: at)
      if let buffer = scaled.makeBuffer() {
        node.scheduleBuffer(buffer, at: AVAudioTime(sampleTime: at, atRate: EngineFormat.sampleRate), options: [], completionHandler: nil)
      }
      s.scheduled = blockEnd
    }
    segment = s
  }

  func snapshot(title: String?) -> DeckSnapshot {
    DeckSnapshot(
      name: name, title: segment == nil ? nil : title, startsAt: segment?.timelineStart.map(EngineFormat.seconds),
      decodedSeconds: EngineFormat.seconds(segment?.decoded ?? 0), scheduledSeconds: EngineFormat.seconds(segment?.scheduled ?? 0),
      finished: segment?.finished ?? false, gain: segment?.envelope.gain ?? 1)
  }
}
```

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/AudioEngine.swift`:

```swift
import AVFoundation
import AudioToolbox

/// The audio engine: AVAudioEngine with two decks taking turns and a third player node for transition files, each
/// through its own mixer into a bus, an EQ (flat for now) and a peak limiter, then out.
///
/// Everything runs on one sample clock. The three player nodes are started together, at the same host time, so their
/// player timelines are the same timeline ("an epoch"); every buffer is scheduled at an exact sample on it. A song
/// that follows another is placed where the other ends (or `fade` earlier, with equal-power fades applied to the PCM),
/// so joins are gapless or crossfaded to the sample. Seeking, loading another song and anything that would need a
/// node's scheduled audio taken back start a new epoch: all nodes stopped, rescheduled and started together again.
///
/// Pausing pauses the AVAudioEngine itself, which freezes all three nodes at the same sample. Running short of decoded
/// audio does the same (`buffering`) until enough is decoded again, so the decks never drift apart.
///
/// The main actor drives it: `pump()` runs on each finished read and on the Player's 10 Hz tick. Decoding happens in
/// the sources' actors; the render thread only ever sees buffers already scheduled.
@MainActor
public final class AudioEngine {
  public struct Tuning: Sendable {
    /// Prepare the next song this long before the current one ends (`PRELOAD_S` on the web).
    public var preload: Double = 30
    /// Keep this much audio scheduled ahead.
    public var scheduleAhead: Double = 10
    /// Less than this scheduled ahead: hold everything until `highWater` is.
    public var lowWater: Double = 0.5
    public var highWater: Double = 2
    /// The soonest a join can start: the render thread runs a little ahead of what `now` reports.
    public var startMargin: Double = 0.1
    /// The longest crossfade (Settings offers up to 12 s): frames kept back near a song's end.
    public var maxFade: Double = 12
    public var block: Double = 0.5
    public init() {}
  }

  public private(set) var state: EngineState = .idle
  public var onEvent: ((EngineEvent) -> Void)?
  public let tuning: Tuning

  let engine = AVAudioEngine()
  let decks: [Deck]
  let transitionDeck = Deck(name: "Transition")
  private let bus = AVAudioMixerNode()
  private let eq = AVAudioUnitEQ(numberOfBands: 0)
  private let limiter = AVAudioUnitEffect(
    audioComponentDescription: AudioComponentDescription(
      componentType: kAudioUnitType_Effect, componentSubType: kAudioUnitSubType_PeakLimiter,
      componentManufacturer: kAudioUnitManufacturer_Apple, componentFlags: 0, componentFlagsMask: 0))
  private let makeSource: @MainActor (EngineItem, Int64) -> any PCMSource

  private var items: [UUID: EngineItem] = [:]
  private var current: Deck?
  private var upcoming: (item: EngineItem, join: Join)?
  private var upcomingDeck: Deck?
  private var wantsToPlay = false
  private var nodesStarted = false
  private var lastNow: SampleTime = 0
  private var endReported: UUID?
  private var pumping = false
  private var pumpAgain = false
  private var events: [EngineEvent] = []

  /// `makeSource` opens a song's audio from a frame (44.1 kHz) on. `manualRendering` renders offline, for tests.
  public init(tuning: Tuning = Tuning(), manualRendering: Bool = false, makeSource: @escaping @MainActor (EngineItem, Int64) -> any PCMSource) throws {
    self.tuning = tuning
    self.makeSource = makeSource
    decks = [Deck(name: "A"), Deck(name: "B")]
    let format = EngineFormat.av
    for node in [bus, eq, limiter] as [AVAudioNode] { engine.attach(node) }
    for deck in decks + [transitionDeck] {
      engine.attach(deck.node)
      engine.attach(deck.mixer)
      engine.connect(deck.node, to: deck.mixer, format: format)
      engine.connect(deck.mixer, to: bus, fromBus: 0, toBus: bus.nextAvailableInputBus, format: format)
      deck.onProgress = { [weak self] in self?.pump() }
      deck.onError = { [weak self] id, error in self?.failed(id, error) }
    }
    engine.connect(bus, to: eq, format: format)
    engine.connect(eq, to: limiter, format: format)
    engine.connect(limiter, to: engine.mainMixerNode, format: format)
    eq.bypass = true
    // The limiter catches what gains and overlaps push past full scale: +1 dB into it and −1 dB after it, so music
    // below the ceiling passes as it is and peaks stay under −1 dBFS.
    AudioUnitSetParameter(limiter.audioUnit, kLimiterParam_PreGain, kAudioUnitScope_Global, 0, 1, 0)
    engine.mainMixerNode.outputVolume = Float(pow(10, -1.0 / 20))
    if manualRendering {
      try engine.enableManualRenderingMode(.offline, format: format, maximumFrameCount: 4096)
    }
  }

  // MARK: Commands

  /// Plays `item` from `item.startAt` on a new epoch (what was playing stops), once its first seconds are decoded.
  public func load(_ item: EngineItem, playing: Bool) {
    resetEpoch()
    upcoming = nil
    wantsToPlay = playing
    let deck = decks[0]
    open(item, on: deck)
    deck.place(at: 0)
    current = deck
    state = .loading
    pump()
  }

  /// What plays after the current item, and how it joins. The same item again (same id) only updates its gain and
  /// join, until it's placed. Another one replaces it: if the old one was already placed, the current song is
  /// reloaded where it is (a new epoch), so its end is as it should be for the new one.
  public func setUpcoming(_ item: EngineItem?, join: Join = .crossfade(seconds: 0)) {
    let placed = upcomingDeck?.segment?.timelineStart != nil
    if let item, item.id == upcoming?.item.id {
      guard !placed else { return }
      upcoming = (item, join)
      items[item.id] = item
      upcomingDeck?.setGain(item.gainDb)
      return
    }
    upcomingDeck?.release()
    upcomingDeck = nil
    upcoming = item.map { ($0, join) }
    if let item { items[item.id] = item }
    if placed { reloadCurrent() }
    pump()
  }

  public func play() {
    wantsToPlay = true
    guard state == .paused else { return }
    if nodesStarted {
      resumeEngine()
      state = .playing
    } else {
      state = .loading
    }
    pump()
  }

  public func pause() {
    wantsToPlay = false
    switch state {
    case .playing, .buffering:
      engine.pause()
      state = .paused
    case .idle, .loading, .paused:
      break
    }
  }

  /// Stops and forgets everything.
  public func stop() {
    resetEpoch()
    upcoming = nil
    items = [:]
    wantsToPlay = false
    state = .idle
  }

  /// The sleep timer's fade (and a mute): the bus's volume, 0–1.
  public func setMasterGain(_ gain: Float) { bus.outputVolume = max(0, min(1, gain)) }
  public var masterGain: Float { bus.outputVolume }

  // MARK: Reading

  /// The current sample of the epoch.
  public var now: SampleTime {
    if let t = decks[0].node.lastRenderTime, t.isSampleTimeValid, let p = decks[0].node.playerTime(forNodeTime: t) {
      lastNow = max(0, p.sampleTime)
    }
    return lastNow
  }

  public var currentItem: EngineItem? { current?.segment.flatMap { items[$0.id] } }

  /// Seconds into the current item.
  public var position: Double {
    guard let s = current?.segment, let start = s.timelineStart else { return currentItem?.startAt ?? 0 }
    let played = min(max(0, now - start), s.finished ? s.decoded : .max)
    return EngineFormat.seconds(s.firstFrame + played)
  }

  /// Seconds of the current item decoded ahead of the playhead.
  public var bufferedAhead: Double {
    guard let s = current?.segment, let start = s.timelineStart else { return 0 }
    return max(0, EngineFormat.seconds(start + s.decoded - now))
  }

  public func snapshot() -> EngineSnapshot {
    EngineSnapshot(
      state: state, now: EngineFormat.seconds(now),
      decks: (decks + [transitionDeck]).map { $0.snapshot(title: $0.segment.flatMap { items[$0.id] }?.track.title) })
  }

  // MARK: Driving

  /// Moves everything on: schedules and reads, prepares and places the next song, notices joins, ends, and running
  /// short. Events go out once it's done, so their handlers can call back in.
  public func pump() {
    guard !pumping else { return pumpAgain = true }
    pumping = true
    repeat {
      pumpAgain = false
      step()
    } while pumpAgain
    pumping = false
    let out = events
    events = []
    for event in out { onEvent?(event) }
  }

  private func step() {
    let now = self.now
    let ahead = EngineFormat.frames(tuning.scheduleAhead)
    let block = EngineFormat.frames(tuning.block)
    // The join is placed before anything is scheduled: the current song's last blocks may need its fade out.
    prepareUpcoming()
    placeUpcoming(now: now)
    for deck in decks + [transitionDeck] { deck.pump(now: now, ahead: ahead, block: block) }
    advance(now: now)
    retire(now: now)
    startWhenReady(now: now)
    reportEnd(now: now)
  }

  private func prepareUpcoming() {
    guard let (item, _) = upcoming, upcomingDeck == nil, let cur = current, let s = cur.segment, let curItem = items[s.id],
      let deck = decks.first(where: { $0 !== cur && $0.segment == nil })
    else { return }
    let remaining = curItem.track.duration - position
    guard remaining <= tuning.preload || s.finished else { return }
    open(item, on: deck)
    upcomingDeck = deck
  }

  private func placeUpcoming(now: SampleTime) {
    guard let next = upcomingDeck, next.segment?.timelineStart == nil, let cur = current?.segment, let end = cur.end,
      let scheduledEnd = cur.scheduledEnd, case .crossfade(let seconds)? = upcoming?.join
    else { return }
    let soonest = now + EngineFormat.frames(tuning.startMargin)
    // A fade can't reach back into what's already scheduled, nor start before the soonest moment.
    let rampStart = max(end - EngineFormat.frames(seconds), scheduledEnd, soonest)
    if rampStart < end {
      let ramp = Ramp(start: rampStart, frames: end - rampStart)
      current?.setFadeOut(ramp)
      next.setFadeIn(ramp)
      next.place(at: rampStart)
    } else {
      next.place(at: max(end, soonest))
    }
    pumpAgain = true
  }

  private func advance(now: SampleTime) {
    guard nodesStarted, let next = upcomingDeck, let s = next.segment, let start = s.timelineStart, now >= start else { return }
    current = next
    upcomingDeck = nil
    upcoming = nil
    events.append(.advanced(s.id))
  }

  /// Decks done playing (a song faded out) are freed for the next song.
  private func retire(now: SampleTime) {
    for deck in decks where deck !== current && deck !== upcomingDeck {
      if let s = deck.segment, let end = s.end, s.fullyScheduled, now >= end {
        items[s.id] = nil
        deck.release()
      }
    }
    if let s = transitionDeck.segment, let end = s.end, s.fullyScheduled, now >= end { transitionDeck.release() }
  }

  private func startWhenReady(now: SampleTime) {
    guard state == .loading, let s = current?.segment, let start = s.timelineStart else { return }
    let ready = s.fullyScheduled || start + s.scheduled - now >= EngineFormat.frames(tuning.highWater)
    guard ready else { return }
    guard wantsToPlay else { return state = .paused }
    startNodes()
  }

  private func reportEnd(now: SampleTime) {
    guard let s = current?.segment, let end = s.end, now >= end, upcomingDeck?.segment?.timelineStart == nil, endReported != s.id else { return }
    endReported = s.id
    events.append(.ended(s.id))
  }

  // MARK: Epochs

  private func open(_ item: EngineItem, on deck: Deck) {
    items[item.id] = item
    let firstFrame = EngineFormat.frames(item.startAt)
    let length = EngineFormat.frames(item.track.duration)
    // A fade is never longer than a third of the song (see JoinRules.fadeSeconds): no need to hold back more.
    deck.load(
      id: item.id, source: makeSource(item, firstFrame), firstFrame: firstFrame, expectedFrames: max(0, length - firstFrame),
      holdback: min(EngineFormat.frames(tuning.maxFade), length / 3), envelope: GainEnvelope(gainDb: item.gainDb))
  }

  /// Stops all nodes (clearing what they had scheduled and their clocks): the next start begins a new epoch at 0.
  private func resetEpoch() {
    for deck in decks + [transitionDeck] { deck.stop() }
    current = nil
    upcomingDeck = nil
    nodesStarted = false
    lastNow = 0
    endReported = nil
  }

  /// Starts the three nodes at the same moment, so they share one timeline.
  private func startNodes() {
    do {
      if !engine.isRunning {
        engine.prepare()
        try engine.start()
      }
    } catch {
      return state = .paused
    }
    // Offline (tests), nodes started before the first render all begin at sample 0; live, at one host time.
    let when = engine.isInManualRenderingMode ? nil : AVAudioTime(hostTime: mach_absolute_time() + AVAudioTime.hostTime(forSeconds: 0.05))
    for deck in decks + [transitionDeck] { deck.node.play(at: when) }
    nodesStarted = true
    state = .playing
  }

  private func resumeEngine() {
    if !engine.isRunning { try? engine.start() }
  }

  private func reload(_ item: EngineItem) {
    let keep = upcoming
    let playing = wantsToPlay
    load(item, playing: playing)
    upcoming = keep
    pump()
  }

  /// The current item again from where it is: after a missed buffer, or to take back a join already scheduled.
  private func reloadCurrent() {
    guard let id = current?.segment?.id, var item = items[id] else { return }
    item.startAt = position
    items[id] = item
    reload(item)
  }

  private func failed(_ id: UUID, _ error: any Error) {
    let playbackError = error as? PlaybackError ?? .undecodable
    if id == upcoming?.item.id {
      // The next song didn't load: it loads again the usual way when its turn comes.
      upcomingDeck?.release()
      upcomingDeck = nil
      upcoming = nil
    } else if id == current?.segment?.id {
      engine.pause()
      resetEpoch()
      wantsToPlay = false
      state = .idle
    } else if id == transitionDeck.segment?.id {
      transitionDeck.release()
    }
    events.append(.failed(id, playbackError))
    pump()
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter AudioEngineTests
```

Expected: `Test run with 5 tests` … `passed`. (A run takes a few seconds: each test renders seconds of audio.)

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/EngineItem.swift \
  apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Deck.swift \
  apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/AudioEngine.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/AudioEngineTests.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/Signals.swift
git commit -F - <<'EOF'
Play songs on one sample clock: gapless and crossfaded joins, gains and a −1 dBFS limiter

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

### Task 15: The engine: seeking, running short, output changes, the transition seam

Seeking reloads the song from a frame on a new epoch. Running short pauses the whole engine (key decision 5); a deck found behind reloads where it is (key decision 6). `AVAudioEngineConfigurationChange` (the output's rate or channels changed, e.g. AirPods connecting) restarts from where it was. And the phase 5 seam of key decision 10.

**Files:**
- Modify: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/AudioEngine.swift`
- Test: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/AudioEngineTests.swift`

**Step 1: Write the failing tests**

Add these tests at the end of `AudioEngineTests`, before its closing brace:

```swift
  @Test func aSeekStartsAtThatVerySample() async throws {
    let audio = try AudioEngine.offline([1: Signals.sine])
    audio.load(EngineItem(track: song(1, duration: 3)), playing: true)
    _ = try await audio.render(seconds: 0.3)
    audio.seek(to: 1.5)
    let out = try await audio.render(seconds: 0.5)
    let lag = latency(of: out) { Signals.sine(Int64($0) + 66_150, 0) }
    #expect(lag < 512)
    let worst = (0..<10_000).map { abs(out.left[$0 + lag] - Signals.sine(Int64($0) + 66_150, 0)) }.max() ?? 1
    #expect(worst < 1e-4)
    #expect(abs(audio.position - (1.5 + 0.5)) < 0.1)
  }

  @Test func aTransitionFileLinesUpWithItsDeckToTheSample() async throws {
    let audio = try AudioEngine.offline([1: Signals.constant(0.1, 0.1)])
    let a = EngineItem(track: song(1, duration: 2))
    audio.load(a, playing: true)
    let at = try #require(audio.timelineSample(of: a.id, songFrame: 30_000))
    audio.scheduleTransition(SignalSource(seconds: 0.01) { n, _ in n == 0 ? 0.5 : 0 }, at: at)
    let out = try await audio.render(seconds: 1)
    let lag = (0..<512).first { out.left[$0] > 0.05 } ?? 0  // A's start shows the limiter's delay
    let click = out.left.indices.max { out.left[$0] < out.left[$1] } ?? 0
    #expect(click - lag == 30_000)
  }

  @Test func runsShortThenWaitsForTheNetworkWithoutDrifting() async throws {
    let gate = Gate()
    let source = SignalSource(seconds: 10, signal: Signals.sine)
    await source.stall(after: EngineFormat.frames(3), until: gate)
    let audio = try AudioEngine(manualRendering: true) { _, _ in source }
    audio.load(EngineItem(track: song(1, duration: 10)), playing: true)
    _ = try await audio.render(seconds: 5)
    #expect(audio.state == .buffering)
    #expect(abs(audio.position - 2.5) < 0.2)
    await gate.open()
    await audio.settle()
    #expect(audio.state == .playing)
    let out = try await audio.render(seconds: 1)
    let start = EngineFormat.frames(audio.position - 1)
    let lag = latency(of: out) { Signals.sine(Int64($0) + start, 0) }
    #expect(lag < 512)
  }
```

**Step 2: Run them to see them fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter AudioEngineTests
```

Expected: the build fails with `value of type 'AudioEngine' has no member 'seek'` (and `timelineSample`, `scheduleTransition`).

**Step 3: Implement**

Make these replacements in `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/AudioEngine.swift` (each `old` appears once).

1. The configuration watch, a stored property:

   Replace:

```swift
  private var events: [EngineEvent] = []
```

   with:

```swift
  private var events: [EngineEvent] = []
  private var configurationWatch: Task<Void, Never>?
```

2. Watching for output changes, at the end of `init`, and cancelling the watch:

   Replace:

```swift
    if manualRendering {
      try engine.enableManualRenderingMode(.offline, format: format, maximumFrameCount: 4096)
    }
  }
```

   with:

```swift
    if manualRendering {
      try engine.enableManualRenderingMode(.offline, format: format, maximumFrameCount: 4096)
    }
    configurationWatch = Task { [weak self, engine] in
      for await _ in NotificationCenter.default.notifications(named: .AVAudioEngineConfigurationChange, object: engine) {
        self?.configurationChanged()
      }
    }
  }

  isolated deinit {
    configurationWatch?.cancel()
  }
```

3. `seek(to:)`, before `stop()`:

   Replace:

```swift
  /// Stops and forgets everything.
```

   with:

```swift
  /// Plays the current item from `seconds` (a new epoch).
  public func seek(to seconds: Double) {
    guard let id = current?.segment?.id, var item = items[id] else { return }
    item.startAt = max(0, seconds)
    items[id] = item
    reload(item)
  }

  /// Stops and forgets everything.
```

4. The seam, before `// MARK: Driving`:

   Replace:

```swift
  // MARK: Driving
```

   with:

```swift
  // MARK: Phase 5 seam: transitions

  /// Where frame `songFrame` (44.1 kHz) of an item that's placed sits on the timeline; nil if it isn't placed.
  public func timelineSample(of id: UUID, songFrame: Int64) -> SampleTime? {
    guard let s = decks.compactMap(\.segment).first(where: { $0.id == id }), let start = s.timelineStart else { return nil }
    return start + songFrame - s.firstFrame
  }

  /// Plays `source` on the transition node from timeline sample `sample`, sample-aligned with the decks. The node
  /// must have played out what it had (a node's scheduled audio can't be taken back without a new epoch).
  public func scheduleTransition(_ source: any PCMSource, at sample: SampleTime, envelope: GainEnvelope = GainEnvelope()) {
    transitionDeck.load(id: UUID(), source: source, firstFrame: 0, expectedFrames: .max, holdback: 0, envelope: envelope)
    transitionDeck.place(at: sample)
    pump()
  }

  // MARK: Driving
```

5. Running short, in `step()`:

   Replace:

```swift
    startWhenReady(now: now)
    reportEnd(now: now)
```

   with:

```swift
    startWhenReady(now: now)
    watchBuffer(now: now)
    reportEnd(now: now)
```

6. `watchBuffer`, before `reportEnd`:

   Replace:

```swift
  private func reportEnd(now: SampleTime) {
```

   with:

```swift
  private func watchBuffer(now: SampleTime) {
    guard state == .playing || state == .buffering else { return }
    let low = EngineFormat.frames(tuning.lowWater)
    let audible = decks.compactMap(\.segment).filter { s in
      guard let start = s.timelineStart else { return false }
      return start <= now + low && !s.fullyScheduled
    }
    let ahead = audible.compactMap { $0.scheduledEnd.map { $0 - now } }.min()
    if state == .playing, let ahead {
      if ahead < 0 { return reloadCurrent() }  // missed: buffers due before now would be dropped
      if ahead < low {
        engine.pause()
        state = .buffering
      }
    } else if state == .buffering, (ahead ?? .max) >= EngineFormat.frames(tuning.highWater) {
      resumeEngine()
      state = .playing
    }
  }

  private func reportEnd(now: SampleTime) {
```

7. `configurationChanged`, before `failed`:

   Replace:

```swift
  private func failed(_ id: UUID, _ error: any Error) {
```

   with:

```swift
  private func configurationChanged() {
    // The output changed (rate, channels): AVAudioEngine stopped itself. Start over from here.
    guard current != nil else { return }
    reloadCurrent()
  }

  private func failed(_ id: UUID, _ error: any Error) {
```

**Step 4: Run them to see them pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter AudioEngineTests
```

Expected: `Test run with 8 tests` … `passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/AudioEngine.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/AudioEngineTests.swift
git commit -F - <<'EOF'
Seek, wait for the network without drifting, and leave a seam for transition files

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

### Task 16: Now Playing and remote commands

As the web's Media Session: title, artist, album, artwork at 512 px (`?size=`), duration, elapsed and rate (the system extrapolates elapsed time from the rate, so it's updated on play, pause, seek and song changes only). Commands: play, pause, toggle, next, previous (the Player's 3 s rule), change position, stop, and like when phase 6 gives it an action. Remote command handlers run on the main thread, hence `MainActor.assumeIsolated`.

**Files:**
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/NowPlayingBridge.swift`
- Test: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/NowPlayingInfoTests.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/NowPlayingInfoTests.swift`:

```swift
import MediaPlayer
import Testing
@testable import PlayarrPlayer

struct NowPlayingInfoTests {
  @Test func showsTheSongWhereItIsAndWhetherItPlays() {
    let info = NowPlayingInfo(track: song(3, duration: 245), elapsed: 12.5, playing: true).dictionary
    #expect(info[MPMediaItemPropertyTitle] as? String == "Song 3")
    #expect(info[MPMediaItemPropertyArtist] as? String == "Artist")
    #expect(info[MPMediaItemPropertyAlbumTitle] as? String == "Album 1")
    #expect(info[MPMediaItemPropertyPlaybackDuration] as? Double == 245)
    #expect(info[MPNowPlayingInfoPropertyElapsedPlaybackTime] as? Double == 12.5)
    #expect(info[MPNowPlayingInfoPropertyPlaybackRate] as? Double == 1)
    #expect(NowPlayingInfo(track: song(3), elapsed: 0, playing: false).dictionary[MPNowPlayingInfoPropertyPlaybackRate] as? Double == 0)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter NowPlayingInfoTests
```

Expected: the build fails with `cannot find 'NowPlayingInfo' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/NowPlayingBridge.swift`:

```swift
import Foundation
import MediaPlayer
import PlayarrAPI

#if canImport(UIKit)
  import UIKit
#else
  import AppKit
#endif

/// What the lock screen and Control Center show.
public struct NowPlayingInfo: Equatable, Sendable {
  public var title: String
  public var artist: String
  public var album: String
  public var duration: Double
  public var elapsed: Double
  public var playing: Bool

  public init(track: Track, elapsed: Double, playing: Bool) {
    title = track.title
    artist = track.artistName
    album = track.albumTitle
    duration = track.duration
    self.elapsed = elapsed
    self.playing = playing
  }

  /// The system extrapolates the elapsed time from the rate: updated on play, pause, seek and song changes only.
  public var dictionary: [String: Any] {
    [
      MPMediaItemPropertyTitle: title,
      MPMediaItemPropertyArtist: artist,
      MPMediaItemPropertyAlbumTitle: album,
      MPMediaItemPropertyPlaybackDuration: duration,
      MPNowPlayingInfoPropertyElapsedPlaybackTime: elapsed,
      MPNowPlayingInfoPropertyPlaybackRate: playing ? 1.0 : 0.0,
      MPNowPlayingInfoPropertyDefaultPlaybackRate: 1.0,
      MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
    ]
  }
}

/// The lock screen, Control Center, headphone buttons and CarPlay-style remotes: Now Playing info out
/// (`MPNowPlayingInfoCenter`), commands in (`MPRemoteCommandCenter`), as the web's Media Session handlers.
@MainActor
public final class NowPlayingBridge {
  public struct Commands {
    public var play: () -> Void
    public var pause: () -> Void
    public var toggle: () -> Void
    public var next: () -> Void
    /// Restarts the song past 3 s, else the one before (the Player's rule).
    public var previous: () -> Void
    public var seek: (Double) -> Void
    /// Phase 6 wires this to favorites; nil leaves the like button off.
    public var like: (() -> Void)?

    public init(
      play: @escaping () -> Void, pause: @escaping () -> Void, toggle: @escaping () -> Void, next: @escaping () -> Void,
      previous: @escaping () -> Void, seek: @escaping (Double) -> Void, like: (() -> Void)? = nil
    ) {
      self.play = play
      self.pause = pause
      self.toggle = toggle
      self.next = next
      self.previous = previous
      self.seek = seek
      self.like = like
    }
  }

  /// Album art at this size (px) from the server's `?size=`.
  public static let artworkSize = 512

  private let commands: Commands
  private let artwork: @Sendable (Track) async -> Data?
  private var info: NowPlayingInfo?
  private var artworkTrack: Int?
  private var art: MPMediaItemArtwork?

  public init(commands: Commands, artwork: @escaping @Sendable (Track) async -> Data?) {
    self.commands = commands
    self.artwork = artwork
    register()
  }

  public func update(track: Track?, elapsed: Double, playing: Bool) {
    guard let track else {
      info = nil
      MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
      return
    }
    let next = NowPlayingInfo(track: track, elapsed: elapsed, playing: playing)
    guard next != info || artworkTrack != track.id else { return }
    info = next
    if artworkTrack != track.id {
      artworkTrack = track.id
      art = nil
      Task { [weak self, artwork] in
        guard let data = await artwork(track) else { return }
        self?.show(data, for: track.id)
      }
    }
    publish()
  }

  private func show(_ data: Data, for trackId: Int) {
    guard artworkTrack == trackId else { return }
    let size = CGSize(width: Self.artworkSize, height: Self.artworkSize)
    art = MPMediaItemArtwork(boundsSize: size) { _ in Self.image(data) }
    publish()
  }

  private func publish() {
    guard var dictionary = info?.dictionary else { return }
    if let art { dictionary[MPMediaItemPropertyArtwork] = art }
    MPNowPlayingInfoCenter.default().nowPlayingInfo = dictionary
  }

  #if canImport(UIKit)
    nonisolated private static func image(_ data: Data) -> UIImage { UIImage(data: data) ?? UIImage() }
  #else
    nonisolated private static func image(_ data: Data) -> NSImage { NSImage(data: data) ?? NSImage() }
  #endif

  private func register() {
    let center = MPRemoteCommandCenter.shared()
    // Remote command handlers are called on the main thread.
    center.playCommand.addTarget { [weak self] _ in self?.run { $0.play() } ?? .commandFailed }
    center.pauseCommand.addTarget { [weak self] _ in self?.run { $0.pause() } ?? .commandFailed }
    center.togglePlayPauseCommand.addTarget { [weak self] _ in self?.run { $0.toggle() } ?? .commandFailed }
    center.nextTrackCommand.addTarget { [weak self] _ in self?.run { $0.next() } ?? .commandFailed }
    center.previousTrackCommand.addTarget { [weak self] _ in self?.run { $0.previous() } ?? .commandFailed }
    center.changePlaybackPositionCommand.addTarget { [weak self] event in
      guard let position = (event as? MPChangePlaybackPositionCommandEvent)?.positionTime else { return .commandFailed }
      return self?.run { $0.seek(position) } ?? .commandFailed
    }
    center.likeCommand.isEnabled = commands.like != nil
    if commands.like != nil {
      center.likeCommand.addTarget { [weak self] _ in self?.run { $0.like?() } ?? .commandFailed }
    }
    center.stopCommand.addTarget { [weak self] _ in self?.run { $0.pause() } ?? .commandFailed }
  }

  nonisolated private func run(_ action: @MainActor (Commands) -> Void) -> MPRemoteCommandHandlerStatus {
    MainActor.assumeIsolated { action(commands) }
    return .success
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter NowPlayingInfoTests
```

Expected: `Test run with 1 test` … `passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/NowPlayingBridge.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/NowPlayingInfoTests.swift
git commit -F - <<'EOF'
Show the song on the lock screen and take its commands

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

### Task 17: The audio session: interruptions, route changes, resets

Category `.playback`, mode `.default`, with the background-audio mode phase 0 put in Info.plist. A call or Siri pauses, and play resumes after it only when iOS says `shouldResume` and music was playing; headphones unplugged (`oldDeviceUnavailable`) pause; a media-services reset rebuilds the engine. The decisions are `SessionPolicy`, tested on the Mac; `AudioSessionController` (iOS only) turns notifications into `SessionEvent`s. After an interruption the system has stopped the engine, so resuming is a new epoch from where it was (the Player seeks to its time).

**Files:**
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/SessionPolicy.swift`
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/AudioSessionController.swift`
- Test: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/SessionPolicyTests.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/SessionPolicyTests.swift`:

```swift
import Testing
@testable import PlayarrPlayer

struct SessionPolicyTests {
  @Test func interruptionsPauseAndResumeOnlyWhenTheSystemSaysSo() {
    var policy = SessionPolicy()
    #expect(policy.action(for: .interruptionBegan, playing: true) == .pause)
    #expect(policy.action(for: .interruptionEnded(shouldResume: true), playing: false) == .resume)
    #expect(policy.action(for: .interruptionBegan, playing: false) == .none)
    #expect(policy.action(for: .interruptionEnded(shouldResume: true), playing: false) == .none)
    #expect(policy.action(for: .interruptionBegan, playing: true) == .pause)
    #expect(policy.action(for: .interruptionEnded(shouldResume: false), playing: false) == .none)
    #expect(policy.action(for: .oldDeviceUnavailable, playing: true) == .pause)
    #expect(policy.action(for: .mediaServicesReset, playing: true) == .rebuild)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter SessionPolicyTests
```

Expected: the build fails with `cannot find 'SessionPolicy' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/SessionPolicy.swift`:

```swift
/// What the audio session tells the app (iOS: `AudioSessionController` turns notifications into these).
public enum SessionEvent: Sendable, Equatable {
  /// A call, Siri, an alarm: the system has stopped the audio.
  case interruptionBegan
  case interruptionEnded(shouldResume: Bool)
  /// Headphones unplugged, a Bluetooth speaker gone.
  case oldDeviceUnavailable
  /// The media server restarted: every audio object is gone.
  case mediaServicesReset
}

public enum SessionAction: Sendable, Equatable {
  case pause
  /// Play again from where it was (on a new epoch: the system stopped the engine).
  case resume
  /// Build a new engine and play on from where it was.
  case rebuild
  case none
}

/// How the player answers the session, as Apple's guidance and the web: pause for interruptions and resume after
/// them only when the system says so and music was playing; pause when headphones go away; rebuild after a reset.
public struct SessionPolicy: Sendable {
  private var resumeAfterInterruption = false

  public init() {}

  public mutating func action(for event: SessionEvent, playing: Bool) -> SessionAction {
    switch event {
    case .interruptionBegan:
      resumeAfterInterruption = playing
      return playing ? .pause : .none
    case .interruptionEnded(let shouldResume):
      defer { resumeAfterInterruption = false }
      return shouldResume && resumeAfterInterruption ? .resume : .none
    case .oldDeviceUnavailable:
      return playing ? .pause : .none
    case .mediaServicesReset:
      return .rebuild
    }
  }
}

/// The audio session as the Player needs it: iOS only (`AudioSessionController`); nil on the Mac and in tests.
@MainActor
public protocol AudioSessionControlling: AnyObject {
  /// Category `.playback`, active: plays with the screen locked and the silent switch on.
  func activate() throws
}
```

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/AudioSessionController.swift`:

```swift
#if os(iOS)
  import AVFAudio
  import Foundation

  /// The app's AVAudioSession: category `.playback` (mode `.default`) with the background-audio mode from Info.plist,
  /// so music plays on the lock screen; interruptions, route changes and media-server resets go to `onEvent`.
  @MainActor
  public final class AudioSessionController: AudioSessionControlling {
    private var observers: [any NSObjectProtocol] = []

    public init(onEvent: @escaping @MainActor (SessionEvent) -> Void) {
      let center = NotificationCenter.default
      let session = AVAudioSession.sharedInstance()
      let names = [
        AVAudioSession.interruptionNotification, AVAudioSession.routeChangeNotification,
        AVAudioSession.mediaServicesWereResetNotification,
      ]
      for name in names {
        // Delivered on the main queue, as asked.
        observers.append(
          center.addObserver(forName: name, object: session, queue: .main) { note in
            guard let event = SessionEvent(note) else { return }
            MainActor.assumeIsolated { onEvent(event) }
          })
      }
    }

    isolated deinit {
      for observer in observers { NotificationCenter.default.removeObserver(observer) }
    }

    public func activate() throws {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.playback, mode: .default)
      try session.setActive(true)
    }
  }

  extension SessionEvent {
    init?(_ note: Notification) {
      let info = note.userInfo ?? [:]
      switch note.name {
      case AVAudioSession.interruptionNotification:
        guard let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt, let type = AVAudioSession.InterruptionType(rawValue: raw) else { return nil }
        if type == .began {
          self = .interruptionBegan
        } else {
          let options = AVAudioSession.InterruptionOptions(rawValue: info[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
          self = .interruptionEnded(shouldResume: options.contains(.shouldResume))
        }
      case AVAudioSession.routeChangeNotification:
        guard let raw = info[AVAudioSessionRouteChangeReasonKey] as? UInt,
          AVAudioSession.RouteChangeReason(rawValue: raw) == .oldDeviceUnavailable
        else { return nil }
        self = .oldDeviceUnavailable
      case AVAudioSession.mediaServicesWereResetNotification:
        self = .mediaServicesReset
      default:
        return nil
      }
    }
  }
#endif
```

`AudioSessionController.swift` compiles only for iOS; check it with the simulator build in Task 19.

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter SessionPolicyTests
```

Expected: `Test run with 1 test` … `passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/SessionPolicy.swift \
  apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/AudioSessionController.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/SessionPolicyTests.swift
git commit -F - <<'EOF'
Pause for calls and unplugged headphones, resume when iOS says so

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

### Task 18: The Player

The queue driving everything. Each command edits `queue` (the `QueueState` of Task 3), then `sync()` brings the engine in line: a different current entry (queue index and restart token) loads on a new epoch at `startAt`, or at `resumeAt` on the first load after a launch, paused; otherwise play or pause. The next song goes to the engine with its join (`JoinRules.fadeSeconds` with the Crossfade setting; 0 within an album in order; repeat one joins the song to itself; the sleep timer's "End of song" joins nothing). When the engine joins on its own, the Player moves the queue on with `next(auto: true)` without reloading, and the play tracker reports the song as ended. Levels are asked for the current and next songs; radio continues the queue on its last song; the cache keeps the current song and fetches ahead; the queue is saved on each change and every 5 s while playing. The 10 Hz tick moves the engine, the clock, the play tracker and the sleep fade. `PlayerBackend` is the one seam to the server; `APIBackend` is the real one over phase 2's `APIClient` and `MediaURLs`.

**Files:**
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PlayerBackend.swift`
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Player.swift`
- Test: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/PlayerTests.swift`
- Test support: `apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/FakeBackend.swift`

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/FakeBackend.swift`:

```swift
import Foundation
import PlayarrAPI
import Synchronization
@testable import PlayarrPlayer

/// The server, as the Player sees it, for tests.
final class FakeBackend: PlayerBackend {
  let levelTable = Mutex<[String: TrackLevel]>([:])
  let plays = Mutex<[PlayReport]>([])
  let radioAnswer = Mutex<[Track]>([])
  let radioAsks = Mutex<[(seeds: [String], exclude: [String])]>([])

  func levels(_ recordingIds: [String]) async throws -> [String: TrackLevel] {
    levelTable.withLock { table in table.filter { recordingIds.contains($0.key) } }
  }
  func reportPlays(_ reported: [PlayReport]) async throws { plays.withLock { $0 += reported } }
  func radio(seeds: [String], exclude: [String], count: Int) async throws -> [Track] {
    radioAsks.withLock { $0.append((seeds, exclude)) }
    return radioAnswer.withLock { $0 }
  }
  func streamRequest(_ track: Track) -> URLRequest { StubServer.request(track.streamUrl) }
  func levelledRequest(_ track: Track) -> URLRequest { StubServer.request(track.streamUrl + "/levelled.wav") }
  func artwork(_ track: Track, size: Int) async -> Data? { nil }
}

extension Player {
  /// A Player on an offline engine whose songs are 441 Hz sines (see `Signals`).
  static func testing(_ backend: FakeBackend = FakeBackend(), directory: URL = temporaryDirectory(), settings: PlaybackSettings? = nil) throws -> Player {
    let defaults = UserDefaults(suiteName: UUID().uuidString)!
    return try Player(
      backend: backend, directory: directory, settings: settings ?? PlaybackSettings(defaults: defaults),
      makeEngine: { try AudioEngine(manualRendering: true, makeSource: $0) },
      makeSource: { item, frame in SignalSource(seconds: item.track.duration, from: frame, signal: Signals.sine) })
  }

  /// Renders `seconds` in steps of 0.1 s, ticking the Player's clock between them.
  func play(for seconds: Double) async throws {
    for _ in 0..<Int((seconds * 10).rounded()) {
      _ = try await engine.render(seconds: 0.1)
      tick()
    }
  }
}

/// Waits (up to a second) for something another task does.
@MainActor
func eventually(_ condition: () -> Bool) async {
  for _ in 0..<1000 where !condition() { try? await Task.sleep(for: .milliseconds(1)) }
}
```

`apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/PlayerTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrPlayer

@MainActor
@Suite(.serialized)
struct PlayerTests {
  @Test func restoresTheSavedQueuePausedWhereItWas() async throws {
    let directory = temporaryDirectory()
    var saved = QueueState()
    saved.playTracks([song(1), song(2)], startIndex: 1)
    saved.resumeAt = 42
    JSONFile<QueueState>(directory.appending(path: "queue.json")).write(saved)
    let player = try Player.testing(directory: directory)
    #expect(player.queue.currentTrack?.id == 2)
    #expect(!player.queue.playing)
    #expect(player.engine.currentItem?.startAt == 42)
    #expect(player.time == 42)
  }

  @Test func savesTheQueueAsItChanges() throws {
    let directory = temporaryDirectory()
    let player = try Player.testing(directory: directory)
    player.play([song(1), song(2), song(3)], startAt: 1)
    let saved = try #require(JSONFile<QueueState>(directory.appending(path: "queue.json")).read())
    #expect(saved.pos == 1)
    #expect(saved.queue.count == 3)
  }

  @Test func anAlbumInOrderNeverFadesOtherSongsDo() throws {
    let defaults = UserDefaults(suiteName: UUID().uuidString)!
    let settings = PlaybackSettings(defaults: defaults)
    settings.transitions = .crossfade
    settings.crossfade = 6
    let player = try Player.testing(settings: settings)
    player.play([song(1), song(2), song(7, albumId: 2)])
    #expect(player.upcoming?.join == .crossfade(seconds: 0))
    player.next()
    #expect(player.upcoming?.join == .crossfade(seconds: 6))
  }

  @Test func repeatOnePlaysTheSongAgainWithoutAGap() throws {
    let player = try Player.testing()
    player.play([song(1), song(2)])
    player.cycleRepeat()
    player.cycleRepeat()
    #expect(player.queue.repeatMode == .one)
    #expect(player.upcoming?.index == 0)
    #expect(player.upcoming?.join == .crossfade(seconds: 0))
  }

  @Test func aJoinMovesTheQueueOnAndReportsThePlay() async throws {
    let backend = FakeBackend()
    let player = try Player.testing(backend)
    player.play([song(1, duration: 2), song(2, duration: 2)])
    try await player.play(for: 2.6)
    #expect(player.queue.pos == 1)
    #expect(player.time > 0.3 && player.time < 0.9)
    await eventually { !backend.plays.withLock { $0.isEmpty } }
    #expect(backend.plays.withLock { $0.map(\.trackId) } == [1])
    #expect(backend.plays.withLock { $0.first?.skipped } == false)
  }

  @Test func theEndOfTheQueueStopsOnTheLastSongAtItsStart() async throws {
    let player = try Player.testing()
    player.play([song(1, duration: 1)])
    try await player.play(for: 1.5)
    #expect(!player.queue.playing)
    #expect(player.queue.pos == 0)
    #expect(player.engine.currentItem?.startAt == 0)
  }

  @Test func previousRestartsPastThreeSecondsElseGoesBack() async throws {
    let player = try Player.testing()
    player.play([song(1), song(2)], startAt: 1)
    try await player.play(for: 3.5)
    player.previous()
    #expect(player.queue.pos == 1)
    #expect(player.time == 0)
    player.previous()
    #expect(player.queue.pos == 0)
  }

  @Test func theSleepTimersEndOfSongMovesOnAndPauses() async throws {
    let player = try Player.testing()
    player.play([song(1, duration: 1), song(2, duration: 1)])
    player.sleepAtEndOfSong()
    #expect(player.upcoming == nil)
    try await player.play(for: 1.5)
    #expect(player.queue.pos == 1)
    #expect(!player.queue.playing)
    #expect(!player.sleep.endOfSong)
  }

  @Test func theSleepTimerFadesOverItsLastTwentySecondsThenStops() throws {
    let player = try Player.testing()
    player.play([song(1)])
    let start = Date()
    player.sleep.sleep(minutes: 1, from: start)
    player.tick(now: start + 50)
    #expect(abs(player.engine.masterGain - 0.5) < 0.01)
    player.tick(now: start + 60)
    #expect(!player.queue.playing)
    #expect(player.notice?.text == "Sleep timer: music stopped")
  }

  @Test func radioCarriesOnWhenTheLastSongStarts() async throws {
    let backend = FakeBackend()
    backend.radioAnswer.withLock { $0 = [song(10), song(11)] }
    let player = try Player.testing(backend)
    player.play([song(1), song(2)])
    #expect(backend.radioAsks.withLock { $0.isEmpty })
    player.next()
    await eventually { player.queue.queue.count == 4 }
    #expect(player.queue.queue.map(\.id) == [1, 2, 10, 11])
    #expect(backend.radioAsks.withLock { $0.first?.seeds } == ["rec-1", "rec-2"])
  }

  @Test func evenVolumeUsesTheServersLevels() async throws {
    let backend = FakeBackend()
    backend.levelTable.withLock { $0 = ["rec-1": TrackLevel(track: -5, album: -3), "rec-2": TrackLevel(track: 4, album: -3)] }
    let player = try Player.testing(backend)
    player.play([song(1), song(2)])
    await eventually { player.upcoming?.item.gainDb == -3 }
    #expect(player.upcoming?.item.gainDb == -3)  // within the album, in order: the album's level
    player.settings.levelVolume = false
    player.next()
    #expect(player.engine.currentItem?.gainDb == 0)
  }

  @Test func aSongThatFailsShowsTheWebsMessageAndPauses() async throws {
    struct Broken: PCMSource {
      func read(maxFrames: Int) async throws -> PCMBlock? { throw PlaybackError.keptBreakingOff }
      func close() async {}
    }
    let player = try Player(
      backend: FakeBackend(), directory: temporaryDirectory(), settings: PlaybackSettings(defaults: UserDefaults(suiteName: UUID().uuidString)!),
      makeEngine: { try AudioEngine(manualRendering: true, makeSource: $0) }, makeSource: { _, _ in Broken() })
    player.play([song(1)])
    await player.engine.settle()
    #expect(player.error == "The song kept stopping loading: the Playarr server or the network is too busy")
    #expect(!player.queue.playing)
  }

  @Test func headphonesUnpluggedPause() async throws {
    let player = try Player.testing()
    player.play([song(1)])
    player.handle(.oldDeviceUnavailable)
    #expect(!player.queue.playing)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter PlayarrPlayerTests.PlayerTests
```

Expected: the build fails with `cannot find 'Player' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PlayerBackend.swift`:

```swift
import Foundation
import PlayarrAPI

/// What the player needs from the server: one seam, so the Player is tested against a fake.
public protocol PlayerBackend: Sendable {
  func levels(_ recordingIds: [String]) async throws -> [String: TrackLevel]
  func reportPlays(_ plays: [PlayReport]) async throws
  func radio(seeds: [String], exclude: [String], count: Int) async throws -> [Track]
  /// The song's own file, authorized.
  func streamRequest(_ track: Track) -> URLRequest
  /// The song's levelled stream at gain 0 (the phone applies the gain), authorized.
  func levelledRequest(_ track: Track) -> URLRequest
  func artwork(_ track: Track, size: Int) async -> Data?
}

/// The real server, through PlayarrAPI.
public struct APIBackend: PlayerBackend {
  let client: APIClient
  let media: MediaURLs
  let session: URLSession

  public init(client: APIClient, media: MediaURLs, session: URLSession = .shared) {
    self.client = client
    self.media = media
    self.session = session
  }

  public func levels(_ recordingIds: [String]) async throws -> [String: TrackLevel] {
    try await client.send(API.Playback.levels(ids: recordingIds))
  }

  public func reportPlays(_ plays: [PlayReport]) async throws {
    _ = try await client.send(API.Playback.reportPlays(plays))
  }

  public func radio(seeds: [String], exclude: [String], count: Int) async throws -> [Track] {
    try await client.send(API.Playback.radio(seeds: seeds, exclude: exclude, count: count))
  }

  // A server address that can't take the path (never, for a URL that signed in) asks the server's root: the
  // request fails and is explained like any other.
  public func streamRequest(_ track: Track) -> URLRequest {
    media.request(for: media.stream(fileId: track.fileId) ?? media.baseURL)
  }

  public func levelledRequest(_ track: Track) -> URLRequest {
    media.request(for: media.levelled(track, gain: 0) ?? media.baseURL)
  }

  public func artwork(_ track: Track, size: Int) async -> Data? {
    guard let url = media.art(track.coverUrl, size: size),
      let (data, response) = try? await session.data(for: media.request(for: url)),
      (response as? HTTPURLResponse)?.statusCode == 200
    else { return nil }
    return data
  }
}
```

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Player.swift`:

```swift
import Foundation
import Observation
import PlayarrAPI

/// The player the screens use: the queue (as the web's `usePlayer`) and its clock, driving the audio engine, even
/// volume, play reports, radio continuation, the sleep timer, Now Playing and the stream cache. Everything a screen
/// changes goes through a method here, which updates `queue` and then `sync()`s the engine to it.
@MainActor @Observable
public final class Player {
  public struct Notice: Equatable, Sendable {
    public let id = UUID()
    public let text: String
    public let isError: Bool
  }

  /// A song in the queue at one moment: its index in `queue`, and the restart token (the same song played again is
  /// another entry).
  struct Entry: Equatable {
    let index: Int
    let token: Int
  }

  public private(set) var queue: QueueState
  /// Seconds into the current song.
  public private(set) var time: Double = 0
  public private(set) var duration: Double = 0
  /// Seconds decoded ahead of the playhead.
  public private(set) var buffered: Double = 0
  public private(set) var loading = false
  public private(set) var error: String?
  /// A message for a toast.
  public private(set) var notice: Notice?

  public let settings: PlaybackSettings
  public let levels: LevelStore
  public let sleep = SleepTimer()

  @ObservationIgnored public private(set) var engine: AudioEngine
  @ObservationIgnored public var nowPlaying: NowPlayingBridge?
  @ObservationIgnored public var session: (any AudioSessionControlling)?
  @ObservationIgnored public var network: () -> NetworkKind = { .wifi }

  @ObservationIgnored private let backend: any PlayerBackend
  @ObservationIgnored private let cache: StreamCache
  @ObservationIgnored private let reports: PlayReportQueue
  @ObservationIgnored private let saved: JSONFile<QueueState>
  @ObservationIgnored private let makeEngine: () throws -> AudioEngine
  @ObservationIgnored private var tracker: PlayTracker
  @ObservationIgnored private(set) var loaded: (entry: Entry, item: EngineItem)?
  @ObservationIgnored private(set) var upcoming: (index: Int, item: EngineItem, join: Join)?
  @ObservationIgnored private var policy = SessionPolicy()
  @ObservationIgnored private var firstLoad = true
  @ObservationIgnored private var lastSaved = Date.distantPast
  @ObservationIgnored private var radioAskedAt: Entry?
  @ObservationIgnored private var ticker: Task<Void, Never>?

  /// `directory` is this server and account's folder in Application Support: the queue, unsent plays and the stream
  /// cache live there. `makeSource` replaces the real sources (tests); `makeEngine` the real engine.
  public init(
    backend: any PlayerBackend, directory: URL, settings: PlaybackSettings = PlaybackSettings(),
    makeEngine: (@MainActor (@escaping @MainActor (EngineItem, Int64) -> any PCMSource) throws -> AudioEngine)? = nil,
    makeSource: (@MainActor (EngineItem, Int64) -> any PCMSource)? = nil
  ) throws {
    let cache = StreamCache(directory: directory.appending(path: "stream", directoryHint: .isDirectory))
    let levels = LevelStore { ids in try await backend.levels(ids) }
    let reports = PlayReportQueue(file: directory.appending(path: "pending-plays.json")) { try await backend.reportPlays($0) }
    let sources: @MainActor (EngineItem, Int64) -> any PCMSource = makeSource ?? { item, frame in
      TrackSource(
        track: item.track, firstFrame: frame,
        origin: TrackSource.Origin(
          stream: backend.streamRequest(item.track),
          levelled: levels.levels[item.track.recordingId] == nil ? nil : backend.levelledRequest(item.track)),
        cache: cache)
    }
    let build = { try makeEngine?(sources) ?? AudioEngine(makeSource: sources) }
    self.backend = backend
    self.settings = settings
    self.levels = levels
    self.cache = cache
    self.reports = reports
    self.makeEngine = build
    saved = JSONFile(directory.appending(path: "queue.json"))
    queue = saved.read() ?? QueueState()
    engine = try build()
    tracker = PlayTracker { _ in }
    tracker = PlayTracker { [weak self] plays in self?.report(plays) }
    engine.onEvent = { [weak self] in self?.handle($0) }
    sync()
    Task { await reports.retry() }
  }

  /// Runs the 10 Hz clock (the app calls this once; tests call `tick()` themselves).
  public func start() {
    ticker?.cancel()
    ticker = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .milliseconds(100))
        self?.tick()
      }
    }
  }

  // MARK: The queue (as store.ts)

  /// Plays `tracks` from `startAt` (an index), in order unless `shuffle` ("Play means in order"), from `at` seconds.
  public func play(_ tracks: [Track], startAt index: Int = 0, source: PlaySource? = nil, shuffle: Bool = false, at seconds: Double? = nil) {
    queue.playTracks(tracks, startIndex: index, shuffle: shuffle, source: source, at: seconds)
    sync()
  }

  public func playNext(_ tracks: [Track]) { change { $0.playNext(tracks) } }
  public func addToQueue(_ tracks: [Track]) { change { $0.addToQueue(tracks) } }
  public func jump(to orderPos: Int, at seconds: Double? = nil) { change { $0.jumpTo(orderPos, at: seconds) } }
  public func remove(at orderPos: Int) { change { $0.removeAt(orderPos) } }
  public func move(from: Int, to: Int) { change { $0.move(from: from, to: to) } }
  public func setUpcoming(_ queueIndices: [Int]) { change { $0.setUpcoming(queueIndices) } }
  public func clearUpcoming() { change { $0.clearUpcoming() } }
  /// A press of Next.
  public func next() { change { $0.next() } }
  /// Restarts the song past 3 s, else goes back one.
  public func previous() { change { [time] in $0.prev(currentTime: time) } }
  public func toggleShuffle() { change { $0.toggleShuffle() } }
  public func cycleRepeat() { change { $0.cycleRepeat() } }
  public func setVolume(_ volume: Double) { change { $0.setVolume(volume) } }
  public func toggleMute() { change { $0.muted.toggle() } }
  public func setMixMode(_ mode: MixMode) { change { $0.mixMode = mode } }

  public func setPlaying(_ on: Bool) {
    guard queue.pos >= 0 else { return }
    change { $0.playing = on }
  }

  public func togglePlay() { setPlaying(!queue.playing) }

  public func seek(to seconds: Double) {
    guard loaded != nil else { return }
    tracker.pause()
    engine.seek(to: seconds)
    time = seconds
    showNowPlaying()
  }

  /// "Start radio" on a song: it, then songs like it from the library.
  public func startRadio(_ track: Track) async {
    do {
      let more = try await backend.radio(seeds: [track.recordingId], exclude: [track.recordingId], count: Radio.count)
      play([track] + more, source: Radio.source(for: track))
    } catch {
      notice = Notice(text: "Couldn’t start a radio: \(error.localizedDescription)", isError: true)
    }
  }

  // MARK: Sleep timer

  public func sleep(minutes: Double) {
    sleep.sleep(minutes: minutes)
    sync()
  }

  public func sleepAtEndOfSong() {
    sleep.sleepAtEndOfSong()
    sync()
  }

  public func cancelSleep() {
    sleep.cancel()
    sync()
  }

  // MARK: The system

  public func handle(_ event: SessionEvent) {
    switch policy.action(for: event, playing: queue.playing) {
    case .pause:
      setPlaying(false)
    case .resume:
      // The system stopped the engine: a new epoch from where it was.
      setPlaying(true)
      seek(to: time)
    case .rebuild:
      rebuildEngine()
    case .none:
      break
    }
  }

  /// The app is closing: the song so far is reported (never as a skip), the queue saved.
  public func appWillTerminate() {
    tracker.finish(.closed)
    queue.resumeAt = time
    saved.write(queue)
  }

  /// The 10 Hz clock: moves the engine on, the time, the history, the sleep timer's fade; saves where it is every 5 s.
  public func tick(now: Date = Date()) {
    engine.pump()
    if loaded != nil { time = engine.position }
    buffered = engine.bufferedAhead
    loading = engine.state == .loading || engine.state == .buffering
    if engine.state == .playing { tracker.tick(time) } else { tracker.pause() }
    let volume = queue.muted ? 0 : Float(queue.volume * queue.volume)
    engine.setMasterGain(volume * sleep.gain(at: now))
    if sleep.runsOut(at: now) {
      setPlaying(false)
      notice = Notice(text: "Sleep timer: music stopped", isError: false)
    }
    if loaded != nil, now.timeIntervalSince(lastSaved) >= 5 {
      queue.resumeAt = time
      save(at: now)
    }
  }

  // MARK: Keeping the engine in step

  private func change(_ edit: (inout QueueState) -> Void) {
    edit(&queue)
    sync()
  }

  private var currentEntry: Entry? {
    queue.currentTrack == nil ? nil : Entry(index: queue.order[queue.pos], token: queue.restartToken)
  }

  /// Brings the engine, levels, radio, prefetch, Now Playing and the saved queue in line with `queue`.
  private func sync() {
    let entry = currentEntry
    if entry != loaded?.entry || (entry != nil && queue.playing && engine.state == .idle) {
      loadCurrent(entry)
    } else if loaded != nil {
      if queue.playing {
        try? session?.activate()
        engine.play()
      } else {
        engine.pause()
      }
    }
    updateUpcoming()
    loadLevels()
    continueRadio()
    prefetch()
    showNowPlaying()
    save()
  }

  private func loadCurrent(_ entry: Entry?) {
    guard let entry, let track = queue.currentTrack else {
      tracker.finish(.changed)
      engine.stop()
      loaded = nil
      upcoming = nil
      (time, duration) = (0, 0)
      return
    }
    // Played again from the start (repeat one, "previous" near the start): it counts as heard through.
    tracker.finish(loaded?.entry.index == entry.index ? .ended : .changed)
    tracker.start(track)
    let start = queue.startAt ?? (firstLoad ? queue.resumeAt : 0)
    queue.startAt = nil
    firstLoad = false
    let item = EngineItem(track: track, gainDb: gainDb(track), startAt: start)
    loaded = (entry, item)
    upcoming = nil
    error = nil
    (time, duration) = (start, track.duration)
    if queue.playing { try? session?.activate() }
    engine.load(item, playing: queue.playing)
  }

  /// Tells the engine what plays after the current song and how: the album in order never fades (JoinRules), repeat
  /// one plays the song again without a gap, the sleep timer's "end of song" plays nothing after it.
  private func updateUpcoming() {
    guard let current = loaded, !sleep.endOfSong,
      let index = queue.repeatMode == .one ? current.entry.index : queue.upNextIndex
    else {
      upcoming = nil
      engine.setUpcoming(nil)
      return
    }
    let track = queue.queue[index]
    let fade = queue.repeatMode == .one ? 0 : JoinRules.fadeSeconds(current.item.track, track, crossfade: settings.crossfadeSeconds)
    let id = upcoming?.index == index ? upcoming?.item.id ?? UUID() : UUID()
    let item = EngineItem(id: id, track: track, gainDb: gainDb(track))
    upcoming = (index, item, .crossfade(seconds: fade))
    engine.setUpcoming(item, join: .crossfade(seconds: fade))
  }

  private func gainDb(_ track: Track) -> Double {
    levels.gainDb(for: track, in: queue, enabled: settings.levelVolume) ?? 0
  }

  private func loadLevels() {
    let tracks = [queue.currentTrack, queue.upNext]
    Task {
      await levels.load(tracks)
      updateUpcoming()  // the next song's gain, if it came in time
    }
  }

  /// When the last song of the queue starts (nothing repeating, autoplay on): songs like the last few.
  private func continueRadio() {
    guard let entry = currentEntry, entry != radioAskedAt, let ask = Radio.continuation(for: queue, autoplay: settings.autoplay) else { return }
    radioAskedAt = entry
    Task {
      guard let more = try? await backend.radio(seeds: ask.seeds, exclude: ask.exclude, count: Radio.count), !more.isEmpty else { return }
      // Still on that last song (nothing was queued meanwhile): carry on with these.
      guard currentEntry == entry, queue.pos == queue.order.count - 1 else { return }
      addToQueue(more)
    }
  }

  private func prefetch() {
    let ahead = queue.upcoming(PrefetchPolicy.songsAhead(on: network()))
    let keep = Set((ahead + [queue.currentTrack].compactMap { $0 }).map(\.fileId))
    let requests = ahead.map { ($0, backend.streamRequest($0)) }
    Task { [cache] in
      await cache.keepOnly(keep)
      await cache.prefetch(requests)
    }
  }

  private func showNowPlaying() {
    nowPlaying?.update(track: queue.currentTrack, elapsed: time, playing: queue.playing)
  }

  private func save(at now: Date = Date()) {
    lastSaved = now
    saved.write(queue)
  }

  private func report(_ plays: [PlayReport]) {
    // Settings → Playback can keep this device out of the history.
    guard settings.recordPlays else { return }
    Task { [reports] in await reports.send(plays) }
  }

  private func handle(_ event: EngineEvent) {
    switch event {
    case .advanced(let id):
      guard let joined = upcoming, joined.item.id == id else { return }
      // Joined on its own at the end of the song: heard through.
      tracker.finish(.ended)
      tracker.start(joined.item.track)
      queue.next(auto: true)
      if let entry = currentEntry { loaded = (entry, joined.item) }
      upcoming = nil
      time = 0
      duration = joined.item.track.duration
      sync()
    case .ended(let id):
      guard loaded?.item.id == id else { return }
      tracker.finish(.ended)
      queue.next(auto: true)
      // The sleep timer's "end of song": on to the next song, paused, for when you're back.
      if sleep.stopsAtSongEnd() { queue.playing = false }
      sync()
    case .failed(let id, let failure):
      guard loaded?.item.id == id else { return }
      error = failure.message
      notice = Notice(text: failure.message, isError: true)
      queue.playing = false
      showNowPlaying()
    }
  }

  private func rebuildEngine() {
    let at = time
    guard let fresh = try? makeEngine() else { return }
    engine.stop()
    engine = fresh
    engine.onEvent = { [weak self] in self?.handle($0) }
    loaded = nil
    queue.startAt = at
    sync()
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer --filter PlayarrPlayerTests.PlayerTests
```

Expected: `Test run with 13 tests` … `passed`. Then the whole package: `swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer` → `Test run with 101 tests` … `passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PlayerBackend.swift \
  apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/Player.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/PlayerTests.swift \
  apps/ios/Packages/PlayarrPlayer/Tests/PlayarrPlayerTests/Support/FakeBackend.swift
git commit -F - <<'EOF'
Add the Player: the queue driving the engine, levels, plays, radio, sleep and Now Playing

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

### Task 19: The live player

`Player.live(backend:directory:)`: the Player as the app runs it, with Now Playing and remote commands, the audio session (iOS), the network for prefetching, its 10 Hz clock, and a last play report when the app is closed (iOS gives no reliable notice otherwise; music keeps playing in the background, so backgrounding isn't closing). Nothing here can run in `swift test` (the audio session and the lock screen need a device), so this task's check is building it for the Mac and the simulator.

**Files:**
- Create: `apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PlayerLive.swift`

**Step 1: Write it**

`apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PlayerLive.swift`:

```swift
import Foundation

#if canImport(UIKit)
  import UIKit
#endif

extension Player {
  /// The player as the app runs it: lock-screen controls and Now Playing, the audio session (iOS), the network for
  /// prefetching, its 10 Hz clock, and a last report when the app is closed.
  public static func live(backend: any PlayerBackend, directory: URL, settings: PlaybackSettings = PlaybackSettings()) throws -> Player {
    let player = try Player(backend: backend, directory: directory, settings: settings)
    player.nowPlaying = NowPlayingBridge(
      commands: NowPlayingBridge.Commands(
        play: { [weak player] in player?.setPlaying(true) },
        pause: { [weak player] in player?.setPlaying(false) },
        toggle: { [weak player] in player?.togglePlay() },
        next: { [weak player] in player?.next() },
        previous: { [weak player] in player?.previous() },
        seek: { [weak player] in player?.seek(to: $0) }),
      artwork: { await backend.artwork($0, size: NowPlayingBridge.artworkSize) })
    let network = NetworkMonitor()
    player.network = { network.kind }
    #if os(iOS)
      player.session = AudioSessionController { [weak player] in player?.handle($0) }
    #endif
    #if canImport(UIKit)
      NotificationCenter.default.addObserver(forName: UIApplication.willTerminateNotification, object: nil, queue: .main) { [weak player] _ in
        MainActor.assumeIsolated { player?.appWillTerminate() }
      }
    #endif
    player.start()
    return player
  }
}
```

**Step 2: Build it for the Mac and the simulator**

```bash
swift build --disable-sandbox --package-path apps/ios/Packages/PlayarrPlayer
make -C apps/ios build
```

Expected: both succeed (the simulator build compiles `AudioSessionController` and the UIKit branches).

**Step 3: Commit**

```bash
git add apps/ios/Packages/PlayarrPlayer/Sources/PlayarrPlayer/PlayerLive.swift
git commit -F - <<'EOF'
Wire the live player: lock screen, audio session, network and its clock

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

### Task 20: The Player lab

Debug builds only: a "Player lab" button over the signed-in app opens a screen that plays an album by id through the active account and shows the queue, the clock, the buffer, each deck (song, where it's placed, decoded and scheduled seconds, whether its end is known, its gain in dB) and the master gain; with the crossfade picker, even volume, autoplay, count plays, and the sleep timer (1 min, End of song). The player is made on the first tap and kept for the app's life. Its folder is `Application Support/Playarr/<server id>/<account id>/` (queue, unsent plays, `stream/`).

**Files:**
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/PlayerLabView.swift`
- Create: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/PlayerLabEntry.swift`
- Modify: `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/SignedInHomeView.swift` (phase 2's)

**Step 1: Write the lab**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/PlayerLabView.swift`:

```swift
#if DEBUG
  import PlayarrAPI
  import PlayarrPlayer
  import SwiftUI

  /// Debug builds only: play an album by id from the server and watch the engine (decks, buffer, gains), the
  /// harness phase 3 ends with, before any real screen sits on the player.
  public struct PlayerLabView: View {
    let player: Player
    let client: APIClient
    @State private var albumId = ""
    @State private var failure: String?
    @State private var scrubbing: Double?

    public init(player: Player, client: APIClient) {
      self.player = player
      self.client = client
    }

    public var body: some View {
      NavigationStack {
        Form {
          album
          nowPlaying
          playback
          sleep
          engine
          queue
        }
        .navigationTitle("Player lab")
      }
    }

    private var album: some View {
      Section("Album") {
        TextField("Album id", text: $albumId)
        #if os(iOS)
          .keyboardType(.numberPad)
        #endif
        Button("Play album") { Task { await playAlbum() } }
          .disabled(Int(albumId) == nil)
        if let failure { Text(failure).foregroundStyle(.red) }
      }
    }

    private var nowPlaying: some View {
      Section("Now playing") {
        Text(player.queue.currentTrack.map { "\($0.title) · \($0.artistName)" } ?? "Nothing")
        TimelineView(.periodic(from: .now, by: 0.25)) { _ in
          VStack(alignment: .leading) {
            Slider(
              value: Binding(get: { scrubbing ?? player.time }, set: { scrubbing = $0 }),
              in: 0...max(1, player.duration),
              onEditingChanged: { editing in
                if !editing, let to = scrubbing { player.seek(to: to) }
                if !editing { scrubbing = nil }
              })
            Text("\(clock(player.time)) / \(clock(player.duration)) · \(Int(player.buffered)) s ahead\(player.loading ? " · loading" : "")")
              .font(.caption.monospacedDigit())
          }
        }
        HStack {
          Button("Previous", systemImage: "backward.fill") { player.previous() }
          Button(player.queue.playing ? "Pause" : "Play", systemImage: player.queue.playing ? "pause.fill" : "play.fill") { player.togglePlay() }
          Button("Next", systemImage: "forward.fill") { player.next() }
          Button("Shuffle", systemImage: player.queue.shuffle ? "shuffle.circle.fill" : "shuffle") { player.toggleShuffle() }
          Button("Repeat", systemImage: player.queue.repeatMode == .one ? "repeat.1" : "repeat") { player.cycleRepeat() }
            .foregroundStyle(player.queue.repeatMode == .off ? .secondary : .primary)
        }
        .labelStyle(.iconOnly)
        .buttonStyle(.borderless)
        if let error = player.error { Text(error).foregroundStyle(.red) }
      }
    }

    private var playback: some View {
      Section("Playback") {
        Picker("Crossfade", selection: crossfade) {
          ForEach(PlaybackSettings.crossfades, id: \.self) { Text($0 == 0 ? "Off" : "\(Int($0)) s").tag($0) }
        }
        Toggle("Even out the volume", isOn: Bindable(player.settings).levelVolume)
        Toggle("Keep playing when the queue ends", isOn: Bindable(player.settings).autoplay)
        Toggle("Count what this device plays", isOn: Bindable(player.settings).recordPlays)
      }
    }

    private var sleep: some View {
      Section("Sleep timer") {
        HStack {
          Button("1 min") { player.sleep(minutes: 1) }
          Button("End of song") { player.sleepAtEndOfSong() }
          Button("Cancel") { player.cancelSleep() }
        }
        .buttonStyle(.borderless)
        TimelineView(.periodic(from: .now, by: 1)) { _ in
          Text(player.sleep.label() ?? "Off").foregroundStyle(.secondary)
        }
      }
    }

    private var engine: some View {
      Section("Engine") {
        TimelineView(.periodic(from: .now, by: 0.25)) { _ in
          let snapshot = player.engine.snapshot()
          VStack(alignment: .leading, spacing: 6) {
            Text("\(String(describing: snapshot.state)) · timeline \(clock(snapshot.now)) · gain \(String(format: "%.2f", player.engine.masterGain))")
            ForEach(snapshot.decks, id: \.name) { deck in
              Text(describe(deck)).font(.caption.monospaced())
            }
          }
        }
      }
    }

    private var queue: some View {
      Section("Queue") {
        ForEach(player.queue.order.indices, id: \.self) { pos in
          let track = player.queue.queue[player.queue.order[pos]]
          Button {
            player.jump(to: pos)
          } label: {
            HStack {
              Text(track.title)
              Spacer()
              if pos == player.queue.pos { Image(systemName: "speaker.wave.2.fill") }
            }
          }
        }
      }
    }

    private var crossfade: Binding<Double> {
      Binding(
        get: { player.settings.crossfadeSeconds },
        set: {
          player.settings.crossfade = $0
          player.settings.transitions = $0 > 0 ? .crossfade : .off
        })
    }

    private func playAlbum() async {
      guard let id = Int(albumId) else { return }
      do {
        let album = try await client.send(API.Library.album(id: id))
        player.play(album.tracks, source: PlaySource(label: album.title, href: "/albums/\(id)"))
        failure = nil
      } catch {
        failure = error.localizedDescription
      }
    }

    private func describe(_ deck: DeckSnapshot) -> String {
      guard let title = deck.title else { return "\(deck.name): idle" }
      let start = deck.startsAt.map { "at \(clock($0))" } ?? "cued"
      let gain = 20 * log10(Double(max(deck.gain, 0.0001)))
      return "\(deck.name): \(title) \(start) · decoded \(clock(deck.decodedSeconds)) · scheduled \(clock(deck.scheduledSeconds))\(deck.finished ? " · end known" : "") · \(String(format: "%+.1f", gain)) dB"
    }

    private func clock(_ seconds: Double) -> String {
      let s = max(0, Int(seconds))
      return String(format: "%d:%02d", s / 60, s % 60)
    }
  }
#endif
```

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/PlayerLabEntry.swift`:

```swift
#if DEBUG
  import PlayarrAPI
  import PlayarrPlayer
  import SwiftUI

  /// Debug builds only: a "Player lab" button over the app that opens `PlayerLabView`. The player is made once, on
  /// the first tap, and kept for the app's life (the lock screen and audio session belong to one player).
  public struct PlayerLabEntry: ViewModifier {
    public typealias Lab = (player: Player, client: APIClient)
    let make: @MainActor () throws -> Lab
    @State private var lab: Lab?
    @State private var shown = false
    @State private var failure: String?

    public init(make: @escaping @MainActor () throws -> Lab) { self.make = make }

    public func body(content: Content) -> some View {
      content
        .overlay(alignment: .bottomTrailing) {
          Button("Player lab", systemImage: "waveform") { open() }
            .buttonStyle(.borderedProminent)
            .padding()
        }
        .sheet(isPresented: $shown) {
          if let lab {
            PlayerLabView(player: lab.player, client: lab.client)
          } else {
            Text(failure ?? "No account signed in")
          }
        }
    }

    private func open() {
      do {
        if lab == nil { lab = try make() }
      } catch {
        failure = error.localizedDescription
      }
      shown = true
    }
  }

  extension View {
    /// Debug builds only: the Player lab, with a player `make` builds.
    public func playerLab(_ make: @escaping @MainActor () throws -> PlayerLabEntry.Lab) -> some View {
      modifier(PlayerLabEntry(make: make))
    }

    /// Debug builds only: the Player lab, playing through the active account. Its queue, unsent plays and stream
    /// cache go in Application Support/Playarr/<server id>/<account id>/.
    public func playerLab(for model: AppModel) -> some View {
      playerLab {
        guard let account = model.store.activeAccount, let client = model.store.client(for: account),
          let media = model.store.mediaURLs(for: account)
        else { throw URLError(.userAuthenticationRequired) }
        let folder = URL.applicationSupportDirectory.appending(
          path: "Playarr/\(account.key.serverId)/\(account.key.accountId)", directoryHint: .isDirectory)
        return (try Player.live(backend: APIBackend(client: client, media: media), directory: folder), client)
      }
    }
  }
#endif
```

**Step 2: Put the entry on the signed-in screen**

In `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/SignedInHomeView.swift`, add the modifier to the outermost view `body` returns, whatever phase 2 put there, e.g.:

```swift
  public var body: some View {
    NavigationStack {
      // … phase 2's content, unchanged …
    }
    #if DEBUG
      .playerLab(for: model)
    #endif
  }
```

**Step 3: Build**

```bash
swift build --disable-sandbox --package-path apps/ios/Packages/PlayarrUI
make -C apps/ios build
```

Expected: both succeed.

**Step 4: Run the existing tests**

```bash
make -C apps/ios test
```

Expected: everything passes (the lab adds no test: it's a debug harness, and the release build doesn't contain it).

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/PlayerLabView.swift \
  apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/PlayerLabEntry.swift \
  apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/SignedInHomeView.swift
git commit -F - <<'EOF'
Add the Player lab, a debug screen to play an album and watch the decks

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

### Task 21: Real songs from the dev server, then the phone

The harness the design asks for: real files through the whole path. No code unless something below fails (then fix it test-first in the task it belongs to, and commit there).

**Files:** none.

**Step 1: Start the dev server and the app**

The NAS isn't reachable from Claude's shell (macOS Local Network). Ask the user to start the dev server if it needs the NAS (`corepack pnpm -C apps/server dev`), or start it if the media source is local. Then:

```bash
make -C apps/ios build
xcrun simctl boot "iPhone 17 Pro" 2>/dev/null || true
xcrun simctl install booted apps/ios/build/DerivedData/Build/Products/Debug-iphonesimulator/Playarr.app
xcrun simctl launch booted me.tracklistme.playarr
```

Sign in to the dev server (phase 2's flow), tap **Player lab**.

**Step 2: In the simulator, with the Player lab**

Pick album ids from the web app's URLs (`/albums/<id>`).

1. A FLAC album: plays; deck A shows "decoded" running ahead of "scheduled" and the end known ~20 s before the end; B is cued 30 s before the end and placed; the join is silent (no click, no gap): try a live album or a classical work whose tracks run into each other.
2. An MP3 album: same, and the join between MP3 tracks is gapless (if there's a gap of ~25 ms, `kAudioFileStreamProperty_PacketTableInfo` didn't arrive: note it under the risks below).
3. Crossfade 6 s, album in order: no fade (both decks never overlap). Shuffle on: the next song fades in over 6 s while the last fades out.
4. Even volume on, a quiet song after a loud one: the gain shown is positive and the level is even; off: the gain is +0.0 dB.
5. Seek to near the end of a song that's still downloading (throttle the network with the Network Link Conditioner, "3G"): playback starts within ~2 s; the dev server's log shows a request for `/stream/<id>/levelled.wav?gain=0` (asked from byte `44 + frame × 4`).
6. Sleep timer 1 min: the music fades over the last 20 s and stops; "Sleep timer: music stopped" is the notice. End of song: stops at the end, the next song shown, paused.
7. Quit the app (swipe away), reopen, open the lab: the same song, paused at the same second (within 5 s).
8. Last song of a queue with autoplay on: songs like it are added.
9. Repeat one: the song plays again without a gap.

**Step 3: On a phone**

```bash
corepack pnpm ios:device
```

The on-device checklist (each line: expected result):

- [ ] **Lock screen**: lock while playing. Title, artist, album and artwork show; play/pause, next and previous work (previous restarts past 3 s, else goes back); dragging the scrubber seeks; the time doesn't jump after a seek.
- [ ] **Screen off, whole album**: the album plays through with the screen locked, joins gapless.
- [ ] **AirPods out** (or a wired headphone unplugged, or a Bluetooth speaker switched off): playback pauses. Putting them back doesn't start it; play does.
- [ ] **AirPods in mid-song** (an output change): playback goes on from where it was (a new epoch: a short gap is acceptable, a jump or a stop isn't).
- [ ] **Phone call** (call the phone): music pauses when it rings; after hanging up it resumes by itself. Decline instead: it resumes too. Siri: pauses and resumes.
- [ ] **Alarm or another app taking audio** (play a video in Safari): music pauses and doesn't resume by itself.
- [ ] **Airplane mode mid-song**: the current song plays to its end (its file was downloaded ahead), then the next songs fetched ahead (3 on Wi-Fi). Past those: an error in the web's words ("Cannot reach the Playarr server"), paused. Airplane mode off, play: it plays.
- [ ] **Seek far ahead on mobile data** in a song just started: plays from there within a couple of seconds (levelled stream), with no jump back when the download catches up.
- [ ] **Slow network** (Settings → Developer → Network Link Conditioner, "Very Bad Network"): playback pauses while buffering and goes on from the same sample; both decks stay together through a crossfade.
- [ ] **Media services reset** (Settings → Developer → Reset Media Services) while playing: playback comes back by itself from about where it was.
- [ ] **Even volume and the limiter**: a quiet track with a large positive gain doesn't distort; loud masters next to quiet ones sound even.
- [ ] **Battery and heat**: an hour of playback with the screen off: no warm phone, no audio dropouts.
- [ ] **Play reports**: after a few songs, the web's Your listening (or `GET /api/stats`) shows them; with airplane mode during a song, the report is sent after reconnecting.

**Step 4: TestFlight**

If the checklist passes, ask the user whether to ship a build to TestFlight (`corepack pnpm ios:beta`), as each phase ends with one.

---

## Risks, and how this plan meets them

- **FLAC through AudioFileStream on iOS 26**: verified on macOS 26 (the same AudioToolbox); Task 21 confirms it on the device. If it fails there, `TrackSource` already falls back to the levelled stream for measured songs and to the whole file otherwise; the fix would be making that the path for FLAC (`StreamDecoder.fileType(forContainer:)` returning nil for `"flac"`).
- **Late buffers** are dropped by `AVAudioPlayerNode` (measured): the engine never schedules into the past (key decision 6).
- **Starting three nodes at one host time** keeps them on one sample live: documented behaviour, checked offline only; the crossfade and the slow-network lines of the checklist would show a drift as phasing.
- **Engine pause/start keeps nodes aligned**: measured offline; the slow-network line checks it live.
- **MP3 gapless trim** depends on AudioFileStream reporting the LAME header's priming and padding; untested here (no MP3 encoder on the Mac). Step 2.2 above checks it.
- **AUPeakLimiter on iOS**: the subtype exists on iOS; its ceiling (−0.8 dBFS before the −1 dB trim) was measured on macOS.

## Not in this phase

DJ transitions and Stats for nerds (phase 5, through the seam of key decision 10), favorites and the like command's action (phase 6), offline downloads, pinned songs and "Offline: skipped songs that aren't on this device" (phase 7), the real Now Playing, Queue and Settings screens (phase 4), keyboard shortcuts (phase 10).
