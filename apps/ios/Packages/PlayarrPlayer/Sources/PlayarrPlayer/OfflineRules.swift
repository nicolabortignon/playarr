import Foundation
import PlayarrAPI

/// How far along a download is; its bytes count its transitions too.
public struct DownloadProgress: Sendable, Equatable {
  public var done: Int
  public var total: Int
  public var bytes: Int64
  public var isComplete: Bool { done == total }
  public init(done: Int, total: Int, bytes: Int64) {
    self.done = done
    self.total = total
    self.bytes = bytes
  }
}

/// The rules of apps/web/src/player/offline.ts and downloads.ts that need no I/O: what's pinned, what makes room,
/// what to fetch next. `DownloadStore` does the rest.
public enum OfflineRules {
  public static let noRoom = "Not enough space on this device"

  /// Downloads keep the transitions the player asks for by default: a queue's mix mode starts out Auto.
  public static let transitionMode: MixMode = .auto

  /// How a transition is known in a download: the two files and the mix mode, like the server's own pair.
  public static func pair(_ fromFileId: Int, _ toFileId: Int, _ mode: MixMode) -> String { "\(fromFileId)-\(toFileId)-\(mode.rawValue)" }

  /// The pairs a song order plays, back to back.
  public static func pairs(of tracks: [Track], mode: MixMode) -> Set<String> {
    Set(zip(tracks, tracks.dropFirst()).map { pair($0.fileId, $1.fileId, mode) })
  }

  /// The songs of every download.
  public static func pinnedSongs(_ pins: [String: PinnedDownload]) -> Set<Int> {
    Set(pins.values.flatMap { $0.tracks.map(\.fileId) })
  }

  /// The transition files of every download.
  public static func pinnedTransitionFiles(_ pins: [String: PinnedDownload]) -> Set<String> {
    Set(pins.values.flatMap { $0.transitions.values.flatMap(\.fileNames) })
  }

  public static func bytes(_ files: some Sequence<KeptFile>) -> Int64 { files.reduce(0) { $0 + $1.bytes } }

  /// Songs kept as you listen: those in no download. Only these count towards the limit and make room.
  public static func unpinned(_ songs: [Int: KeptFile], pins: [String: PinnedDownload]) -> [Int: KeptFile] {
    let pinned = pinnedSongs(pins)
    return songs.filter { !pinned.contains($0.key) }
  }

  /// Songs to drop, least recently used first, so that `need` more bytes fit within `limit`; nil when they can't fit
  /// even then (songs in `protect` are never dropped).
  public static func evictions(_ songs: [Int: KeptFile], need: Int64, limit: Int64, protect: Set<Int> = []) -> [Int]? {
    var used = bytes(songs.values)
    var out: [Int] = []
    for (id, song) in oldestFirst(songs) where !protect.contains(id) {
      if used + need <= limit { break }
      out.append(id)
      used -= song.bytes
    }
    return used + need <= limit ? out : nil
  }

  /// The least recently used songs that free `bytes`; nil if all of them together don't.
  public static func freeUp(_ songs: [Int: KeptFile], bytes wanted: Int64, protect: Set<Int> = []) -> [Int]? {
    var out: [Int] = []
    var freed: Int64 = 0
    for (id, song) in oldestFirst(songs) where !protect.contains(id) {
      if freed >= wanted { break }
      out.append(id)
      freed += song.bytes
    }
    return freed >= wanted ? out : nil
  }

  /// Whether every file of a transition is on this device.
  public static func transitionKept(_ t: KeptTransition, files: [String: KeptFile]) -> Bool {
    t.fileNames.allSatisfy { files[$0] != nil }
  }

  public static func progress(of d: PinnedDownload, in m: OfflineManifest) -> DownloadProgress {
    let done = d.tracks.filter { m.songs[$0.fileId] != nil }
    let songBytes = bytes(Set(done.map(\.fileId)).compactMap { m.songs[$0] })
    let transitionBytes = bytes(Set(d.transitions.values.flatMap(\.fileNames)).compactMap { m.transitionFiles[$0] })
    return DownloadProgress(done: done.count, total: d.tracks.count, bytes: songBytes + transitionBytes)
  }

  /// Downloads in the order they were added.
  public static func inOrder(_ pins: [String: PinnedDownload]) -> [PinnedDownload] {
    pins.values.sorted { ($0.addedAt, $0.key) < ($1.addedAt, $1.key) }
  }

  /// The next song of a download to fetch: downloads in the order they were added, songs in order. `skip`: songs
  /// that failed this session, or are on their way.
  public static func nextToDownload(_ pins: [String: PinnedDownload], songs: [Int: KeptFile], skip: Set<Int> = []) -> Track? {
    for d in inOrder(pins) {
      if let t = d.tracks.first(where: { songs[$0.fileId] == nil && !skip.contains($0.fileId) }) { return t }
    }
    return nil
  }

  /// The next transition a download is missing: downloads in the order they were added, pairs in their song order,
  /// once both songs are on the device. Pairs in `skipped` (none to be had this session) and `busy` ones (the player
  /// is asking about that song) are left for later.
  public static func nextTransition(
    _ pins: [String: PinnedDownload], manifest m: OfflineManifest, skipped: Set<String> = [],
    busy: (Track, Track) -> Bool = { _, _ in false }
  ) -> (key: String, from: Track, to: Track)? {
    for d in inOrder(pins) {
      for (from, to) in zip(d.tracks, d.tracks.dropFirst()) {
        let pair = pair(from.fileId, to.fileId, transitionMode)
        guard from.fileId != to.fileId, m.songs[from.fileId] != nil, m.songs[to.fileId] != nil, !skipped.contains(pair) else { continue }
        if let kept = d.transitions[pair], transitionKept(kept, files: m.transitionFiles) { continue }
        if busy(from, to) { continue }
        return (d.key, from, to)
      }
    }
    return nil
  }

  /// The queue plays the songs' album, as the player will ask (`playsAlbum` in apps/web/src/player/decks.ts): a
  /// download of an album (or an artist) mixes like playing it from its page.
  public static func playsAlbum(_ href: String?, _ a: Track) -> Bool {
    guard let href else { return true }
    return href == "/albums/\(a.albumId)" || href == "/artists/\(a.artistId)"
  }

  /// The fade asked for songs that can't be mixed on the beat: the crossfade setting, else 6 s (`djFadeSeconds`).
  public static func transitionFade(crossfade: Double) -> Double { crossfade > 0 ? crossfade : 6 }

  private static func oldestFirst(_ songs: [Int: KeptFile]) -> [(Int, KeptFile)] {
    songs.map { ($0.key, $0.value) }.sorted { ($0.1.usedAt, $0.0) < ($1.1.usedAt, $1.0) }
  }
}
