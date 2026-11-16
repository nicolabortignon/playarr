import Foundation
import PlayarrAPI

/// Settings → Playback → Streaming quality: Automatic, which goes by how fast songs arrive, or one quality whatever
/// the connection.
public enum StreamingChoice: String, Sendable, CaseIterable, Codable {
  case automatic, original, high, normal, low

  /// The quality chosen; nil for Automatic.
  public var fixed: StreamQuality? { StreamQuality(rawValue: rawValue) }
}

/// Automatic streaming quality: each song at the best quality the connection keeps up with, as `Bandwidth` measures it,
/// whatever the network is called (Wi-Fi can be slow, mobile data fast). Before anything is measured, Normal; in Low
/// Data Mode, which asks apps to spare data, never better than Normal.
public enum AutoQuality {
  /// Songs must arrive this much faster than they play: room for a bitrate that's only an average, and for the
  /// connection to dip.
  public static let headroom = 1.3
  /// The quality before anything is measured: one that starts quickly almost anywhere.
  public static let first = StreamQuality.normal

  /// The best quality whose bitrate for this song, with `headroom`, fits in `kbps`; Low when none does.
  public static func pick(for track: Track, kbps: Double?, lowDataMode: Bool = false) -> StreamQuality {
    let ceiling: StreamQuality = lowDataMode ? .normal : .original
    guard let kbps else { return first }
    for quality in StreamQuality.bestFirst where ceiling.atLeast(quality) {
      if quality.bitrate(of: track) * headroom <= kbps { return quality }
    }
    return .low
  }

  /// The next quality down that makes this song smaller (an MP3 at 192 kbps plays as it is at High, so below its own
  /// file comes Normal); nil at Low.
  public static func below(_ quality: StreamQuality, for track: Track) -> StreamQuality? {
    let bitrate = quality.bitrate(of: track)
    return StreamQuality.bestFirst.first { !$0.atLeast(quality) && $0.bitrate(of: track) < bitrate }
  }
}
