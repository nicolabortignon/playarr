import Foundation
import PlayarrAPI

/// A transition rendered by the server, downloaded whole to this device, ready to be played between two songs.
///
/// The file is `lead` seconds of A as it is, the transition (`plan.length`), then `tail` seconds of B as it is. Its
/// first sample is A's frame `round(aStart × 44 100) − leadFrames`, and the sample after the transition is B's frame
/// `round(bResume × 44 100)` (packages/mix/src/render/transition.ts), so the engine places it on A's timeline to the
/// sample and changes over inside the lead, where both hold the same sound.
public struct TransitionJoin: Sendable, Equatable {
  public var plan: TransitionPlan
  /// The transition file on this device.
  public var file: URL
  /// Whole samples (the server floors the lead to one).
  public var leadFrames: Int64
  public var tailFrames: Int64
  /// What each song's own playback adds to the level it was made at (dB): the gain the phone plays the song at,
  /// less the level sent with the request (0 when none was). Zero when the transition was made at the levels the
  /// songs play at; otherwise the file is turned by `MixSequence.bridgeGain` so neither changeover jumps.
  public var correctionA: Double
  public var correctionB: Double

  public init(plan: TransitionPlan, file: URL, leadFrames: Int64, tailFrames: Int64, correctionA: Double = 0, correctionB: Double = 0) {
    self.plan = plan
    self.file = file
    self.leadFrames = leadFrames
    self.tailFrames = tailFrames
    self.correctionA = correctionA
    self.correctionB = correctionB
  }

  /// From a ready answer and its downloaded file, for songs playing at `gainA` and `gainB` dB.
  public init(_ ready: TransitionAnswer.Ready, file: URL, gainA: Double, gainB: Double) {
    self.init(
      plan: ready.plan, file: file, leadFrames: EngineFormat.frames(ready.lead ?? 0), tailFrames: EngineFormat.frames(ready.tail ?? 0),
      correctionA: gainA - (ready.levels?.a ?? 0), correctionB: gainB - (ready.levels?.b ?? 0))
  }

  public var lengthFrames: Int64 { EngineFormat.frames(plan.length) }
}
