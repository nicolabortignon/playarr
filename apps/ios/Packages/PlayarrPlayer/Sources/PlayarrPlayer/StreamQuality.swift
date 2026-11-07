import Foundation
import PlayarrAPI
import Synchronization

/// Settings → Playback → Streaming quality (plan 2 §1, `lib/quality.ts` on the web): a song's own file, or the
/// server's encoded stream of it, AAC at High (256 kbps) or Normal (128 kbps), made as it's asked for from any sample on
/// (docs/server/streaming-and-art.md §2).
public enum StreamQuality: String, Sendable, CaseIterable, Codable {
  case original, high, normal

  /// The encoded stream's bitrate (kbps); nil for the song's own file.
  public var kbps: Int? {
    switch self {
    case .original: nil
    case .high: 256
    case .normal: 128
    }
  }

  /// A copy kept at this quality will do where `wanted` is asked for.
  public func atLeast(_ wanted: StreamQuality) -> Bool { rank >= wanted.rank }

  private var rank: Int {
    switch self {
    case .original: 2
    case .high: 1
    case .normal: 0
    }
  }

  /// The song comes encoded at this quality: not at Original, not a song the server doesn't stream from `/stream/`,
  /// and not a file already about that small (an MP3 at 128 kbps plays as it is at Normal: encoding it again would
  /// only lose quality).
  public func encodes(_ track: Track) -> Bool {
    guard let kbps, track.streamUrl.hasPrefix("/stream/") else { return false }
    return Double(kbps) * 1.25 < Self.fileKbps(track)
  }

  /// What the song is at this quality: this one when it comes encoded, else its own file.
  public func of(_ track: Track) -> StreamQuality { encodes(track) ? self : .original }

  /// The bytes the song takes at this quality: its own file's size, or at most what its encoded stream declares (the
  /// server allows the encoder 20% over its bitrate, and 16 KiB more).
  public func size(of track: Track) -> Int64 {
    guard encodes(track), let kbps else { return Int64(track.size) }
    return Int64((track.duration * Double(kbps) * 125 * 1.2).rounded(.up)) + 16 * 1024
  }

  /// The song's own file's bitrate (kbps), as its format says or its size gives.
  static func fileKbps(_ track: Track) -> Double {
    if let bitrate = track.format.bitrate, bitrate > 0 { return bitrate }
    return track.duration > 0 && track.size > 0 ? Double(track.size) * 8 / track.duration / 1000 : .infinity
  }
}

/// What a session learns of the server's encoded streams as songs ask for them: a server from before them (0.6.571)
/// answers the first "Not found", and the songs it can't encode (an SFTP source, a length it can't read) or whose
/// encode failed play their own files for the rest of the session, as on the web (`encodedStreamFailed`). A busy
/// server (503) is only busy now.
public final class EncodeSupport: Sendable {
  private struct State {
    var serverLacks = false
    var files: Set<Int> = []
  }

  private let state = Mutex(State())

  public init() {}

  /// The song may be asked for encoded.
  public func allows(_ fileId: Int) -> Bool { state.withLock { !$0.serverLacks && !$0.files.contains(fileId) } }

  /// The song's encoded stream didn't come (the server's status and `{ error }`): its own file from now on, and every
  /// song's when the server has no such route.
  public func failed(_ fileId: Int, status: Int, message: String?) {
    guard status != 503 else { return }
    state.withLock { s in
      s.files.insert(fileId)
      if status == 404 && message == "Not found" { s.serverLacks = true }
    }
  }
}
