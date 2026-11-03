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
