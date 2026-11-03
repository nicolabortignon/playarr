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
  /// The rest of the song after a transition as the server made it (`continuationUrl`), played instead of the song's
  /// own file from `from` on (an MP3 can't be started at an exact sample; the server's copy runs on from the
  /// transition's tail sample for sample).
  public var continuation: Continuation?

  public struct Continuation: Sendable, Equatable {
    /// The server's path for it (`/transitions/<name>.rest.flac`).
    public var url: String
    /// The song second it starts at: the plan's `bResume`.
    public var from: Double
    /// Its gain: it was made at the level sent with the request, so it's turned only by the difference.
    public var gainDb: Double
    public init(url: String, from: Double, gainDb: Double) {
      self.url = url
      self.from = from
      self.gainDb = gainDb
    }
  }

  public init(id: UUID = UUID(), track: Track, gainDb: Double = 0, startAt: Double = 0, continuation: Continuation? = nil) {
    self.id = id
    self.track = track
    self.gainDb = gainDb
    self.startAt = startAt
    self.continuation = continuation
  }
}

/// How the upcoming item joins the current one.
public enum Join: Sendable, Equatable {
  /// It starts where the current one ends, overlapping by `seconds` with equal-power fades (0: gapless).
  case crossfade(seconds: Double)
  /// A transition rendered by the server and downloaded (see `TransitionJoin`): A is cut inside the file's lead, the
  /// file plays on the transition node, and the item goes on from the plan's `bResume` where the transition ends.
  case transition(TransitionJoin)
  /// A stops at `aEnd` and the item starts at `bStart`, on the same sample: a cut on the beat, a silence cut, or the
  /// server's straight on.
  case cut(BeatCut)
  /// The engine mixes the two songs itself from the plan's curves: a fade, a quick mix, a press of Next. The item comes
  /// in at the plan's `aStart`, from `bStart`, at the plan's rate.
  case mix(TransitionPlan)

  /// Where in A (song seconds) the join begins: A's own audio must not be scheduled past it before the join is
  /// placed. Nil for a crossfade, which goes by A's end.
  public var leaveTime: Double? {
    switch self {
    case .crossfade: nil
    case .transition(let t): t.plan.aStart - EngineFormat.seconds(t.leadFrames)
    case .cut(let c): c.aEnd
    case .mix(let plan): plan.aStart
    }
  }

  /// Where in A the mix is first heard (song seconds): a transition's `aStart` (its lead is A alone), else where the
  /// join begins. Nil for a crossfade.
  public var mixBegins: Double? {
    if case .transition(let t) = self { return t.plan.aStart }
    return leaveTime
  }
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
  /// The item's mix couldn't be placed in time (asked for too late, or the item not ready): it joins gapless instead.
  case mixMissed(UUID)
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

  public init(name: String, title: String?, startsAt: Double?, decodedSeconds: Double, scheduledSeconds: Double, finished: Bool, gain: Float) {
    self.name = name
    self.title = title
    self.startsAt = startsAt
    self.decodedSeconds = decodedSeconds
    self.scheduledSeconds = scheduledSeconds
    self.finished = finished
    self.gain = gain
  }
}

public struct EngineSnapshot: Sendable, Equatable {
  public let state: EngineState
  public let now: Double
  public let decks: [DeckSnapshot]
}
