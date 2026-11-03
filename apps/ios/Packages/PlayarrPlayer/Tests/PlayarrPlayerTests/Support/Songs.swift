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
