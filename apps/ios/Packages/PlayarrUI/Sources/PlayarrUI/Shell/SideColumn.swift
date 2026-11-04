/// The column on the right of the iPad layout: the queue or the lyrics of the song playing.
public enum SideColumn: String, Hashable, Sendable, Codable, CaseIterable {
  case queue, lyrics

  public var title: String {
    switch self {
    case .queue: "Queue"
    case .lyrics: "Lyrics"
    }
  }

  public var systemImage: String {
    switch self {
    case .queue: "list.bullet"
    case .lyrics: "quote.bubble"
    }
  }
}
