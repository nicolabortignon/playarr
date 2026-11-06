import PlayarrAPI
import SwiftUI

/// Search's "Not in your library" (Search.tsx DiscoverSection): songs, albums and artists from MusicBrainz, Lidarr
/// and Deezer, each with request controls. Shown under the library results when the server has Lidarr.
public struct DiscoverSection: View {
  let query: String

  @Environment(DiscoverContext.self) private var context: DiscoverContext?

  /// `query`: what's typed, trimmed.
  public init(query: String) {
    self.query = query
  }

  public var body: some View {
    if let context, context.gate.hasLidarr, !query.isEmpty {
      DiscoverResultsView(context: context, query: query)
    }
  }
}

private struct DiscoverResultsView: View {
  let context: DiscoverContext
  let query: String
  @State private var model: DiscoverSearchModel

  init(context: DiscoverContext, query: String) {
    self.context = context
    self.query = query
    _model = State(initialValue: DiscoverSearchModel(context: context))
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 28) {
      Divider().padding(.horizontal, 20)
      VStack(alignment: .leading, spacing: 6) {
        Kicker(text: "Lidarr · MusicBrainz · Deezer")
        HStack(spacing: 10) {
          Text("Not in your library").font(.display(.largeTitle)).accessibilityAddTraits(.isHeader)
          if model.fetching { Circle().fill(.tint).frame(width: 8, height: 8).accessibilityLabel("Searching") }
        }
        Text("Request an album and Lidarr will search your indexers for it. It shows up here when it’s ready.")
          .font(.sans(.footnote)).foregroundStyle(.secondary)
      }
      .padding(.horizontal, 20)
      if model.loading {
        VStack(spacing: 12) { ForEach(0..<4, id: \.self) { _ in Skeleton(aspectRatio: nil, height: 56) } }
          .padding(.horizontal, 20)
      }
      if let error = model.error, model.results == nil {
        Text(error).font(.sans(.footnote)).foregroundStyle(.danger).padding(.horizontal, 20)
      }
      if model.nothing {
        Text("Nothing found for “\(model.answered)”.").font(.sans(.footnote)).foregroundStyle(.secondary).padding(.horizontal, 20)
      }
      if !model.tracks.isEmpty {
        VStack(alignment: .leading, spacing: 0) {
          SectionHeader(title: "Songs", kicker: "Request the album it’s on")
          ForEach(model.tracks) { DiscoverTrackRow(track: $0).padding(.horizontal, 20) }
        }
      }
      if !model.albums.isEmpty {
        VStack(alignment: .leading, spacing: 0) {
          SectionHeader(title: "Albums")
          Shelf { ForEach(model.albums, id: \.mbid) { DiscoverAlbumCard(album: $0) } }
        }
      }
      if !model.artists.isEmpty {
        VStack(alignment: .leading, spacing: 0) {
          SectionHeader(title: "Artists")
          Shelf { ForEach(model.artists, id: \.mbid) { DiscoverArtistCard(artist: $0) } }
        }
      }
    }
    .task(id: query) { model.update(query) }
    .onChange(of: context.generation(.discover)) { Task { await model.reload() } }
  }
}
