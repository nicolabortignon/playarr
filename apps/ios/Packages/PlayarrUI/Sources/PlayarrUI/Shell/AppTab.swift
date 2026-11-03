/// The phone's tabs, as the web's bottom bar (apps/web/src/components/Nav.tsx).
public enum AppTab: String, Hashable, Sendable, CaseIterable {
  case home, search, library, queue

  public var title: String {
    switch self {
    case .home: "Home"
    case .search: "Search"
    case .library: "Library"
    case .queue: "Queue"
    }
  }

  public var systemImage: String {
    switch self {
    case .home: "house"
    case .search: "magnifyingglass"
    case .library: "books.vertical"
    case .queue: "list.bullet"
    }
  }
}
