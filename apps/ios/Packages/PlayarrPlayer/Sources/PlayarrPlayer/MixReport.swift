import Foundation

/// How a changeover of the last mix went, for Stats for nerds: where it was scheduled on the engine's one clock, and
/// how far ahead of the playhead its first audio was handed to the node (the web measured two files' drift; here the
/// changeover is sample-exact by construction, so what's worth seeing is that it was scheduled, and with what margin).
public struct MixReport: Sendable, Equatable {
  public enum Kind: String, Sendable, CaseIterable {
    /// From A's own file to the transition (or, mixed live, B coming in).
    case mixIn = "mix in"
    /// From the transition to B's own file (or, mixed live, A gone).
    case mixOut = "mix out"
  }

  public enum Way: String, Sendable {
    case server = "made on the server"
    case live = "mixed on this device"
    case cut = "cut on the beat"
  }

  public let kind: Kind
  public let way: Way
  /// "Into the Trees → Hung Up".
  public let songs: String
  /// The timeline sample of the changeover.
  public let sample: SampleTime
  /// Where that is in the song it happens in: A's time for a mix in, B's for a mix out.
  public let songTime: Double
  /// Seconds before the changeover its first audio was scheduled; nil until it has been.
  public var headroom: Double?

  public init(kind: Kind, way: Way, songs: String, sample: SampleTime, songTime: Double, headroom: Double? = nil) {
    self.kind = kind
    self.way = way
    self.songs = songs
    self.sample = sample
    self.songTime = songTime
    self.headroom = headroom
  }
}
