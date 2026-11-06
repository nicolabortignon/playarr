import SwiftUI

/// "2 requests in progress", opening Requests (Search, while any are on their way).
public struct RequestsPill: View {
  @Environment(DiscoverContext.self) private var context: DiscoverContext?

  public init() {}

  public var body: some View {
    if let count = context?.requests.activeCount, count > 0 {
      NavigationLink(value: Route.requests) {
        Label(Format.plural(count, "request") + " in progress", systemImage: "arrow.triangle.2.circlepath")
      }
      .buttonStyle(.pill(.secondary, size: .small))
    }
  }
}
