import PlayarrAPI
import SwiftUI

/// Search's "Not in your library" (Search.tsx DiscoverSection): songs, albums and artists from MusicBrainz, Lidarr
/// and Deezer, each with request controls. Shown under the library results when the server has Lidarr. Search owns
/// the model and tells it what's typed, so it knows when nothing is out there either.
struct DiscoverSection: View {
  let query: String
  let model: DiscoverSearchModel?

  @Environment(DiscoverContext.self) private var context: DiscoverContext?

  /// `query`: what's typed, trimmed.
  init(query: String, model: DiscoverSearchModel?) {
    self.query = query
    self.model = model
  }

  var body: some View {
    if let context, context.gate.hasLidarr, !query.isEmpty, let model {
      DiscoverResultsView(context: context, model: model)
    }
  }
}

private struct DiscoverResultsView: View {
  let context: DiscoverContext
  let model: DiscoverSearchModel

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
        SongRowsSkeleton(count: 4).padding(.horizontal, 20)
      }
      if let error = model.error, model.results == nil {
        InlineError("Couldn’t search beyond your library", reason: error) { await model.reload() }.padding(.horizontal, 20)
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
    .onChange(of: context.generation(.discover)) { Task { await model.reload() } }
  }
}
