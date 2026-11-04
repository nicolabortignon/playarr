import PlayarrAPI

extension Demo {
  /// `count` four-minute songs ("Song 1", "Song 2", …) for the long-queue checks (`-UITestsLongQueue`).
  public static func manyTracks(_ count: Int) -> [Track] {
    (0..<count).map { n in
      track(20_000 + n, "Song \(n + 1)", album: 70, albumTitle: "Mezzanine", artist: artist, number: n + 1, duration: 240)
    }
  }
}
