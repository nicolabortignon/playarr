import Foundation
import PlayarrAPI

extension Track {
  /// The server's rest of `track` after a transition (`continuationUrl`), as a song of its own for `TrackSource`: it
  /// streams and caches like any file, under a file id of its own (negative, from its URL, so it never meets a real
  /// one), and starts at `from` seconds into the song.
  static func continuation(of track: Track, url: String, from: Double) -> Track {
    var hash: UInt32 = 2_166_136_261
    for byte in url.utf8 { hash = (hash ^ UInt32(byte)) &* 16_777_619 }
    var rest = track
    rest.fileId = -Int(hash & 0x7fff_ffff) - 1
    rest.streamUrl = url
    rest.duration = max(0, track.duration - from)
    rest.format = AudioFormat(codec: "FLAC", container: url.lowercased().hasSuffix(".wav") ? "wav" : "flac", lossless: true)
    return rest
  }
}
