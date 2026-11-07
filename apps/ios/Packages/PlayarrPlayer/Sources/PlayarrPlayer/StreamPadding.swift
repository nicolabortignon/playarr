import Foundation

/// Where an encoded stream's audio ends. The server declares a stream's length before encoding it, as an upper bound,
/// and pads what the encoder didn't use with a `free` box at the end (docs/server/streaming-and-art.md, the layout):
/// up to a fifth more than the bitrate, which needn't be fetched or kept. Found by walking the top-level boxes as the
/// bytes arrive, in order.
struct StreamPadding {
  /// Where the `free` box starts: the stream's audio is the bytes before it.
  private(set) var start: Int64?
  /// The walk stopped: a box it can't step over (a size of 0 or a 64-bit one, never in Playarr's streams).
  private(set) var lost = false
  /// Where the next top-level box starts, and the bytes of its header seen so far.
  private var next: Int64 = 0
  private var header = Data()
  private var seen: Int64 = 0

  /// The stream's next bytes.
  mutating func scan(_ data: Data) {
    let from = seen
    seen += Int64(data.count)
    while start == nil, !lost, next + Int64(header.count) < seen {
      let at = Int(next + Int64(header.count) - from)
      let take = min(8 - header.count, data.count - at)
      header.append(data[data.startIndex + at..<data.startIndex + at + take])
      guard header.count == 8 else { return }
      let size = header.prefix(4).reduce(Int64(0)) { $0 << 8 | Int64($1) }
      let type = String(decoding: header.suffix(4), as: UTF8.self)
      header.removeAll()
      if type == "free" {
        start = next
      } else if size < 8 {
        lost = true
      } else {
        next += size
      }
    }
  }

  /// Cuts a whole stream on disk (a download fetched by the system, which can't stop early) at its padding. Its size
  /// after: unchanged for a file without padding.
  static func trim(_ url: URL) -> Int64? {
    guard let handle = try? FileHandle(forUpdating: url) else { return nil }
    defer { try? handle.close() }
    guard let size = try? handle.seekToEnd() else { return nil }
    var at: UInt64 = 0
    while at + 8 <= size {
      guard (try? handle.seek(toOffset: at)) != nil, let header = try? handle.read(upToCount: 8), header.count == 8 else { break }
      let boxSize = header.prefix(4).reduce(UInt64(0)) { $0 << 8 | UInt64($1) }
      if String(decoding: header.suffix(4), as: UTF8.self) == "free" {
        guard (try? handle.truncate(atOffset: at)) != nil else { return Int64(size) }
        return Int64(at)
      }
      guard boxSize >= 8 else { break }
      at += boxSize
    }
    return Int64(size)
  }
}
