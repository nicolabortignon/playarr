import PlayarrAPI
import SwiftUI

/// Albums asked of Lidarr, with live progress (pages/Requests.tsx). Swipe a row to take it off the list (Lidarr
/// keeps the album wanted).
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
      Section {
        Text("Albums you asked Lidarr to find. Progress updates live; finished albums land in your library automatically.")
          .font(.sans(.footnote)).foregroundStyle(.secondary)
      }
      if let error = requests.error, requests.requests == nil {
        Text(error).foregroundStyle(.secondary)
      } else if let list = requests.requests {
        if list.isEmpty {
          VStack(alignment: .leading, spacing: 8) {
            Text("No requests yet. Search for something that isn’t in your library and hit Request.")
            Button("Search") { session.router.search("") }.buttonStyle(.borderless)
          }
          .font(.sans(.footnote)).foregroundStyle(.secondary)
        }
        ForEach(list, id: \.mbid) { request in
          row(request)
            .swipeActions {
              if context.gate.canRequest {
                Button("Remove", role: .destructive) { Task { await requests.remove(request) } }
              }
            }
            .contextMenu {
              if context.gate.canRequest {
                Button("Remove from this list", systemImage: "xmark") { Task { await requests.remove(request) } }
              }
            }
        }
      } else {
        ForEach(0..<3, id: \.self) { _ in Skeleton(aspectRatio: nil, height: 64) }
      }
    }
    .pageHeader("Requests", count: requests.requests.map { Format.plural($0.count, "request") })
    .refreshable { await requests.refresh() }
    .task { if requests.requests == nil { await requests.refresh() } }
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
