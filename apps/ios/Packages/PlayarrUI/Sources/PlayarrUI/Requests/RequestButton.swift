import PlayarrAPI
import SwiftUI

/// One control for every state of an album that may not be in the library yet (components/Discover.tsx): Request →
/// Requesting… (Looking up…) → Searching → 42% → Importing → In library; Try again when Lidarr has found nothing or
/// failed; "3/12" and Request for an album partly here. What can be tapped is a pill button, what only says how it's
/// going a `StatusBadge`. Hidden where nothing may be asked for.
public struct RequestButton: View {
  /// Where it sits.
  public enum Placement: Equatable, Sendable {
    /// In a card or a row: small, with Request filled with the accent.
    case inline
    /// An album page's own action, in its action row: large and outlined beside Play, or an icon once the row has no
    /// room for words (`compact`).
    case actionRow(compact: Bool)
  }

  let album: AlbumRef
  let availability: Availability
  var placement: Placement

  @Environment(DiscoverContext.self) private var context: DiscoverContext?

  public init(album: AlbumRef, availability: Availability, placement: Placement = .inline) {
    self.album = album
    self.availability = availability
    self.placement = placement
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
      // Pending: the verb with an ellipsis and a spinner. In a card nothing can be pressed meanwhile, so it's a
      // status (the web's too); in the action row the button stays, disabled, so the row doesn't change shape.
      if placement == .inline {
        StatusBadge(text: state.label, spinning: true, tone: .quiet).help(state.help ?? "")
      } else {
        ask(state, variant: .secondary, systemImage: nil, requests).disabled(true)
      }
    case .partial(let count, let summary, let albumId, let canRequest):
      partial(count: count, summary: summary, albumId: albumId, canRequest: canRequest, requests)
    case .request:
      // A plus rather than the web's arrow: on an album page, Download's arrow sits beside it.
      ask(state, variant: .primary, systemImage: "plus", requests)
    case .searchAgain:
      ask(state, variant: .secondary, systemImage: "clock", requests)
    case .retry:
      ask(state, variant: .secondary, systemImage: "exclamationmark.triangle", warning: true, requests)
    case .searching, .importing:
      status(state, spokenAs: state.label, spinning: true)
    case .downloading(let percent, _):
      status(state, spokenAs: "Downloading, \(percent)%", systemImage: "arrow.down", progress: Double(percent) / 100)
    case .inLibrary(let albumId):
      inLibrary(state, albumId: albumId)
    }
  }

  /// A button that asks Lidarr for the album. In a card Request is the main action (`variant`); in the action row
  /// Play is, so it's outlined there, and asks for the rest of the album.
  @ViewBuilder
  private func ask(
    _ state: RequestButtonState, variant: PillVariant, systemImage: String?, warning: Bool = false, _ requests: RequestsModel
  ) -> some View {
    let button = Button { requests.request(album) } label: {
      switch placement {
      case .inline: title(state.label, systemImage: systemImage, warning: warning)
      case .actionRow(compact: false): title(state.restLabel, systemImage: systemImage, warning: warning)
      case .actionRow(compact: true): icon(systemImage, warning: warning)
      }
    }
    switch placement {
    case .inline:
      button.buttonStyle(.pill(variant, size: .small)).help(state.help ?? "")
    case .actionRow(compact: false):
      button.buttonStyle(.pill(.secondary, size: .large)).help(state.help ?? "")
    case .actionRow(compact: true):
      button.buttonStyle(.outlinedIcon).accessibilityLabel(state.restLabel).help(state.help ?? "")
    }
  }

  /// "3/12" opening the album, and Request for the rest.
  @ViewBuilder
  private func partial(count: String, summary: String, albumId: Int?, canRequest: Bool, _ requests: RequestsModel) -> some View {
    switch placement {
    case .inline:
      // Request loses its icon where the two don't fit a card.
      ViewThatFits(in: .horizontal) {
        partialPair(count: count, summary: summary, albumId: albumId, canRequest: canRequest, withIcon: true, requests)
        partialPair(count: count, summary: summary, albumId: albumId, canRequest: canRequest, withIcon: false, requests)
      }
    case .actionRow:
      // On the album's own page: only the request for the rest.
      if canRequest { ask(.request, variant: .secondary, systemImage: "plus", requests) }
    }
  }

  private func partialPair(
    count: String, summary: String, albumId: Int?, canRequest: Bool, withIcon: Bool, _ requests: RequestsModel
  ) -> some View {
    HStack(spacing: 6) {
      if let albumId {
        NavigationLink(value: DiscoverDestination.libraryAlbum(id: albumId).route) { Text(count).monospacedDigit() }
          .buttonStyle(.pill(.secondary, size: .small))
          .accessibilityLabel("\(summary): open the album")
          .help(summary)
      } else {
        StatusBadge(text: count, tone: .quiet).accessibilityLabel(summary).help(summary)
      }
      if canRequest {
        Button { requests.request(album) } label: {
          if withIcon { Label("Request", systemImage: "plus") } else { Text("Request") }
        }
        .buttonStyle(.pill(.primary, size: .small))
        .help("Request the whole album")
      }
    }
  }

  /// How it's going: a badge, or in a crowded action row a circle with a spinner or a filling ring.
  @ViewBuilder
  private func status(
    _ state: RequestButtonState, spokenAs label: String, systemImage: String? = nil, spinning: Bool = false, progress: Double? = nil
  ) -> some View {
    if case .actionRow(compact: true) = placement {
      OutlinedIcon(progress: progress) {
        if spinning {
          ProgressView()
        } else if let systemImage {
          Image(systemName: systemImage).foregroundStyle(.tint)
        }
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(label)
      .help(state.help ?? "")
    } else {
      StatusBadge(text: state.label, systemImage: systemImage, spinning: spinning, progress: progress)
        .accessibilityLabel(label)
        .help(state.help ?? "")
    }
  }

  /// "In library" with a green tick, opening the album when there's one to open.
  @ViewBuilder
  private func inLibrary(_ state: RequestButtonState, albumId: Int?) -> some View {
    if let albumId {
      NavigationLink(value: DiscoverDestination.libraryAlbum(id: albumId).route) {
        Label {
          Text(state.label)
        } icon: {
          Image(systemName: "checkmark").foregroundStyle(.success)
        }
      }
      .buttonStyle(.pill(.secondary, size: placement == .inline ? .small : .large))
    } else {
      StatusBadge(text: state.label, systemImage: "checkmark", tone: .success)
    }
  }

  /// The words after the icon (a spinner while it asks); a warning's icon in red.
  private func title(_ text: String, systemImage: String?, warning: Bool) -> some View {
    Label {
      Text(text)
    } icon: {
      icon(systemImage, warning: warning)
    }
  }

  /// The icon alone, or a spinner while it asks.
  @ViewBuilder
  private func icon(_ systemImage: String?, warning: Bool) -> some View {
    if let systemImage {
      Image(systemName: systemImage).foregroundStyle(warning ? AnyShapeStyle(.danger) : AnyShapeStyle(.foreground))
    } else {
      ProgressView()
    }
  }
}
