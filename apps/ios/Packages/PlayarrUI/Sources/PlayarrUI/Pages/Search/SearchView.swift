import PlayarrAPI
import SwiftUI

/// Search (apps/web/src/pages/Search.tsx).
struct SearchView: View {
  @State private var model: SearchModel
  @Environment(AccountSession.self) private var session
  @FocusState private var searchFocused: Bool
  @Environment(DiscoverContext.self) private var discover: DiscoverContext?

  init(session: AccountSession) {
    _model = State(initialValue: SearchModel(session: session))
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 32) {
        RequestsPill().padding(.horizontal, 20)
        if model.query.isEmpty {
          suggestions
        } else if model.isEmpty {
          notFound
        } else if model.results != nil {
          results
        }
        DiscoverSection(query: model.query)
      }
      .padding(.vertical, 16)
    }
    .navigationTitle("Search")
    .searchable(text: $model.text, prompt: "Artists, albums, tracks")
    .searchFocused($searchFocused)
    .task(id: session.router.focusSearch) {
      // "/" on a keyboard: the cursor goes to the field.
      if session.router.focusSearch {
        session.router.focusSearch = false
        searchFocused = true
      }
    }
    .overlay(alignment: .top) { if model.isSearching { ProgressView().padding(.top, 4) } }
    .task { await model.loadSuggestions() }
    .onChange(of: session.router.searchQuery, initial: true) { _, query in
      guard let query else { return }
      model.text = query
      session.router.searchQuery = nil
    }
    .task(id: model.text) {
      // A moment between keystrokes: typing doesn't ask for every letter.
      try? await Task.sleep(for: .milliseconds(250))
      if !Task.isCancelled { await model.search() }
    }
  }

  private var suggestions: some View {
    VStack(alignment: .leading, spacing: 12) {
      if !model.suggestions.isEmpty {
        Kicker(text: "Try an artist")
        FlowLayout {
          ForEach(model.suggestions) { Chip(text: $0.name, route: .artist($0.id)) }
          if let all = model.allArtistsLabel { Chip(text: all, route: .artists) }
        }
      }
    }
    .padding(.horizontal, 20)
  }

  private var notFound: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("Not in your crates.").font(.display(.title))
      Text("Nothing in your library matches “\(model.searched)”." + (discover?.gate.hasLidarr == true ? " Here’s what’s out there:" : ""))
        .font(.sans(.subheadline)).foregroundStyle(.secondary)
    }
    .padding(.horizontal, 20)
  }

  @ViewBuilder private var results: some View {
    if let top = model.topArtist {
      VStack(alignment: .leading, spacing: 0) {
        SectionHeader(title: "Top result")
        NavigationLink(value: Route.artist(top.id)) {
          HStack(spacing: 16) {
            Cover(path: top.imageUrl, points: 96, label: top.name, circle: true).frame(width: 96, height: 96)
            VStack(alignment: .leading, spacing: 4) {
              Text(top.name).font(.display(.title))
              Kicker(text: "Artist")
            }
            Spacer()
          }
          .padding(16)
          .background(RoundedRectangle(cornerRadius: 10).fill(Color.secondary.opacity(0.08)))
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 20)
      }
    }
    if !model.tracks.isEmpty {
      VStack(alignment: .leading, spacing: 0) {
        SectionHeader(title: "Tracks")
        let tracks = model.tracks
        ForEach(Array(tracks.enumerated()), id: \.offset) { index, track in
          TrackRow(track: track, style: .mixed) { session.player.play(tracks, startAt: index) }
            .padding(.horizontal, 20)
        }
        if let label = model.showAllLabel {
          Button { model.showAllTracks = true } label: { Kicker(text: label) }
            .padding(.horizontal, 20)
            .padding(.top, 8)
        }
      }
    }
    if !model.playlistHits.isEmpty {
      VStack(alignment: .leading, spacing: 0) {
        SectionHeader(title: "Playlists")
        FlowLayout { ForEach(model.playlistHits) { Chip(text: "\($0.name) · \($0.trackCount)", route: .playlist($0.id)) } }
          .padding(.horizontal, 20)
      }
    }
    if let albums = model.results?.albums, !albums.isEmpty {
      VStack(alignment: .leading, spacing: 0) {
        SectionHeader(title: "Albums")
        Shelf { ForEach(albums) { AlbumCard(album: $0, width: ShelfCard.width) } }
      }
    }
    if let artists = model.results?.artists, artists.count > 1 {
      VStack(alignment: .leading, spacing: 0) {
        SectionHeader(title: "Artists")
        Shelf { ForEach(artists) { ArtistCard(artist: $0, width: ShelfCard.artistWidth) } }
      }
    }
  }
}
