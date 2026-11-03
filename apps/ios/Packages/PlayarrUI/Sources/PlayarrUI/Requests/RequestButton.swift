import PlayarrAPI
import SwiftUI

/// One control for every state of an album that may not be in the library yet (components/Discover.tsx):
/// Request → Requesting (Looking up) → Searching → 42% → Importing → In library; Search again and Retry when Lidarr
/// is stuck; "3/12" and Request for an album partly here. Hidden where nothing may be asked for.
public struct RequestButton: View {
  let album: AlbumRef
  let availability: Availability
  var small: Bool

  @Environment(DiscoverContext.self) private var context: DiscoverContext?

  public init(album: AlbumRef, availability: Availability, small: Bool = false) {
    self.album = album
    self.availability = availability
    self.small = small
  }

  public var body: some View {
    if let context {
      control(context.requests.buttonState(for: album, availability: availability, allowed: context.gate.allowsRequests), context.requests)
    }
  }

  @ViewBuilder
  private func control(_ state: RequestButtonState, _ requests: RequestsModel) -> some View {
    switch state {
    case .hidden:
      EmptyView()
    case .requesting:
      Pill(style: .quiet, small: small) { HStack(spacing: 6) { ProgressView().controlSize(.mini); Text(state.label) } }
        .help(state.help ?? "")
    case .partial(let count, let summary, let albumId, let canRequest):
      HStack(spacing: 6) {
        if let albumId {
          NavigationLink(value: DiscoverDestination.libraryAlbum(id: albumId).route) { Pill(style: .done, small: small) { Text(count) } }
            .buttonStyle(.plain)
            .accessibilityLabel("\(summary): open the album")
        } else {
          Pill(style: .done, small: small) { Text(count) }.accessibilityLabel(summary)
        }
        if canRequest {
          Button { requests.request(album) } label: {
            Pill(style: .filled, small: small) { Label("Request", systemImage: "arrow.down") }
          }
          .buttonStyle(.plain)
          .help("Request the whole album")
        }
      }
    case .request:
      ask(requests, style: .filled, icon: "arrow.down", state)
    case .searchAgain:
      ask(requests, style: .quiet, icon: "clock", state)
    case .retry:
      ask(requests, style: .warning, icon: "exclamationmark.triangle", state)
    case .searching, .importing:
      Pill(style: .outlined, small: small) { HStack(spacing: 6) { ProgressView().controlSize(.mini); Text(state.label) } }
        .help(state.help ?? "")
    case .downloading(let percent, _):
      Pill(style: .outlined, small: small, progress: Double(percent) / 100) { Label(state.label, systemImage: "arrow.down") }
        .help(state.help ?? "")
        .accessibilityLabel("Downloading, \(percent)%")
    case .inLibrary(let albumId):
      if let albumId {
        NavigationLink(value: DiscoverDestination.libraryAlbum(id: albumId).route) {
          Pill(style: .done, small: small) { Label(state.label, systemImage: "checkmark") }
        }
        .buttonStyle(.plain)
      } else {
        Pill(style: .done, small: small) { Label(state.label, systemImage: "checkmark") }
      }
    }
  }

  private func ask(_ requests: RequestsModel, style: PillTone, icon: String, _ state: RequestButtonState) -> some View {
    Button { requests.request(album) } label: {
      Pill(style: style, small: small) { Label(state.label, systemImage: icon) }
    }
    .buttonStyle(.plain)
    .help(state.help ?? "")
  }
}
