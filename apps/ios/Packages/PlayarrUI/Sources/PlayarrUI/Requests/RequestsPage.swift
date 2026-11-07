import PlayarrAPI
import SwiftUI

/// Albums asked of Lidarr, with live progress (pages/Requests.tsx). Swipe a row to take it off the list, with Undo
/// (Lidarr keeps the album wanted).
public struct RequestsPage: View {
  @Environment(DiscoverContext.self) private var context: DiscoverContext?

  public init() {}

  public var body: some View {
    if let context {
      RequestsList(context: context, requests: context.requests)
    }
  }
}

private struct RequestsList: View {
  let context: DiscoverContext
  let requests: RequestsModel
  @Environment(AccountSession.self) private var session

  var body: some View {
    List {
      // Only where there's a Lidarr to ask: without one, the empty page says why there are no requests.
      if context.gate.hasLidarr {
        Section {
          Text("Albums you asked Lidarr to find. Progress updates live; finished albums land in your library automatically.")
            .font(.sans(.footnote)).foregroundStyle(.secondary)
        }
      }
      if let error = requests.error, requests.requests == nil {
        ErrorState(message: error) { await requests.refresh() }
          .listRowSeparator(.hidden)
      } else if let list = requests.shown {
        if list.isEmpty {
          if context.health == nil, !context.healthFailed {
            // What to say depends on what the server allows: wait to know.
            ListRowsSkeleton(count: 3, cover: 64)
          } else {
            empty(NoRequests.of(context.gate, admin: session.account.role == .admin))
              .listRowSeparator(.hidden)
          }
        }
        ForEach(list, id: \.mbid) { request in
          row(request)
            .swipeActions {
              if context.gate.canRequest {
                Button("Remove", role: .destructive) { remove(request) }
              }
            }
            .contextMenu {
              if context.gate.canRequest {
                Button("Remove from this list", systemImage: "xmark") { remove(request) }
              }
            }
        }
      } else {
        ListRowsSkeleton(count: 3, cover: 64)
      }
    }
    .pageHeader("Requests", count: requests.shown.map { Format.plural($0.count, "request") })
    .refreshable { await requests.refresh() }
    .task { if requests.requests == nil { await requests.refresh() } }
  }

  /// Off the list at once, with Undo; the server forgets it once the Undo has gone.
  private func remove(_ request: AlbumRequest) {
    requests.hide(request)
    session.toasts.undo("Removed “\(request.title)” from Requests") {
      requests.unhide(request)
    } done: {
      Task { await requests.remove(request) }
    }
  }

  /// Nothing requested: how to ask, or why asking isn't possible here and who can change that.
  private func empty(_ state: NoRequests) -> some View {
    EmptyState(
      systemImage: "binoculars", line: state.line,
      fill: state.action.map { action in
        .action(
          EmptyState.Action(action.title, systemImage: action.systemImage) {
            switch action.destination {
            case .search: session.router.search("")
            case .settings(let panel): session.router.open(.settingsPanel(panel))
            }
          })
      })
  }

  @ViewBuilder private func row(_ request: AlbumRequest) -> some View {
    HStack(spacing: 12) {
      if request.availability.state == .available, let id = request.availability.albumId {
        NavigationLink(value: DiscoverDestination.libraryAlbum(id: id).route) { summary(request) }
      } else {
        summary(request)
      }
      RequestButton(album: AlbumRef(mbid: request.mbid, artistName: request.artistName, albumTitle: request.title), availability: request.availability)
    }
    .accessibilityElement(children: .contain)
  }

  private func summary(_ request: AlbumRequest) -> some View {
    HStack(spacing: 12) {
      Cover(path: request.coverUrl, points: 64, label: request.title).frame(width: 64, height: 64)
      VStack(alignment: .leading, spacing: 3) {
        Text(request.title).lineLimit(1)
        Text(request.artistName).font(.sans(.footnote)).foregroundStyle(.secondary).lineLimit(1)
        TimelineView(.periodic(from: .now, by: 60)) { clock in
          Text(RequestRowText.status(request, now: clock.date)).font(.mono(.caption2)).foregroundStyle(.secondary).lineLimit(1)
        }
        if request.availability.state == .downloading {
          ProgressView(value: min(max(request.availability.progress ?? 0, 0), 1)).frame(maxWidth: 240)
        }
      }
    }
  }
}
