import SwiftUI

/// "2 requests in progress", opening Requests (Search, while any are on their way).
public struct RequestsPill: View {
  @Environment(DiscoverContext.self) private var context: DiscoverContext?

  public init() {}

  public var body: some View {
    if let count = context?.requests.activeCount, count > 0 {
      NavigationLink(value: Route.requests) {
        // On their way: the system's spinner, as the web's turning LoaderCircle (two arrows round mean "do it again").
        Label {
          Text(Format.plural(count, "request") + " in progress")
        } icon: {
          ProgressView().controlSize(.mini)
        }
      }
      .buttonStyle(.pill(.secondary, size: .small))
    }
  }
}
