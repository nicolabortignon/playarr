import PlayarrAPI
import SwiftUI

/// Search (apps/web/src/pages/Search.tsx): while empty, the account's recent searches and artists to try; then the
/// library's results, and what's beyond the library whenever there's anything there.
struct SearchView: View {
  @State private var model: SearchModel
  /// What's beyond the library (Lidarr's search, else MusicBrainz's), told what's typed here.
  @State private var beyond: DiscoverSearchModel?
  @Environment(AccountSession.self) private var session
  @FocusState private var searchFocused: Bool
  @Environment(DiscoverContext.self) private var discover: DiscoverContext?
  /// On the iPhone Duo's cover screen the tabs are a column with no room for the search field.
  @Environment(\.underTheRail) private var underTheRail

  init(session: AccountSession) {
    _model = State(initialValue: SearchModel(session: session))
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 32) {
        RequestsPill().padding(.horizontal, 20)
        if model.query.isEmpty {
          RecentSearchesSection(recents: session.recentSearches, toasts: session.toasts) { query in
            model.text = query
            session.recentSearches.record(query)
          }
          suggestions
        } else if model.isEmpty {
          notFound
        } else if let results = model.results {
          if results.near == true {
            // Nothing matched as typed: these are a letter or two away, and say so.
            Text(PageLines.near(model.searched)).typeRole(.body).foregroundStyle(.paperDim).padding(.horizontal, 20)
          }
          self.results
        }
        DiscoverSection(query: model.query, model: beyond, continues: model.isEmpty)
      }
      // From the leading edge, however narrow what's shown (Try an artist alone sat in the middle).
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.vertical, 16)
    }
    .navigationTitle("Search")
    .searchable(text: $model.text, placement: fieldPlacement, prompt: "Search music")
    .searchFocused($searchFocused)
    // Return counts the search as made.
    .onSubmit(of: .search) { session.recentSearches.record(model.query) }
    .task(id: session.router.focusSearch) {
      // "/" on a keyboard: the cursor goes to the field.
      if session.router.focusSearch {
        session.router.focusSearch = false
        searchFocused = true
      }
    }
    .overlay(alignment: .top) { if model.isSearching { ProgressView().padding(.top, 4) } }
    .task { await model.loadSuggestions() }
    .task(id: discover.map(ObjectIdentifier.init)) {
      if let discover, beyond == nil { beyond = DiscoverSearchModel(context: discover) }
    }
    // Beyond the library is asked too, with or without Lidarr (the server asks MusicBrainz then), from two letters:
    // the model waits for them.
    .task(id: [model.query, beyond.map { "\(ObjectIdentifier($0))" } ?? ""]) {
      beyond?.update(model.query)
    }
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
    // Words left alone a moment count as searched for; another letter starts the wait again.
    .task(id: model.query) { await session.recentSearches.recordWhenSettled(model.query) }
    // A result opened from here (a page pushed over Search) counts too.
    .onChange(of: session.router.searchDepth) { before, now in
      if now > before { session.recentSearches.record(model.query) }
    }
  }

  /// Where the search field goes: the tab bar's, as the search tab's role has it; on the iPhone Duo's cover screen,
  /// where the tabs stand in a column with no room for it (it was in the tree there but never on screen), under the
  /// page's title, always showing.
  private var fieldPlacement: SearchFieldPlacement {
    #if os(iOS)
      underTheRail ? .navigationBarDrawer(displayMode: .always) : .automatic
    #else
      .automatic
    #endif
  }

  private var suggestions: some View {
    VStack(alignment: .leading, spacing: 12) {
      if !model.suggestions.isEmpty {
        Kicker(text: "Try an artist")
        FlowLayout(lineSpacing: 0) {
          ForEach(model.suggestions) { Chip(text: $0.name, route: .artist($0.id)) }
          if let all = model.allArtistsLabel { Chip(text: all, route: .artists) }
        }
      }
    }
    .padding(.horizontal, 20)
  }

  /// The server can look beyond the library for what's typed: with Lidarr, else on MusicBrainz.
  private var asksBeyond: Bool { beyond != nil && model.query.count >= DiscoverSearchModel.minimumLength }

  /// Nothing in the library (docs/design.md, The lines). While what's beyond it may have something, it says so and lets
  /// those results follow; with nothing anywhere, what to try, a new search, and artists to try.
  @ViewBuilder private var notFound: some View {
    let state = SearchModel.notFound(model.searched, asksBeyond: asksBeyond, beyond: beyond)
    if state.offersNewSearch {
      VStack(alignment: .leading, spacing: 0) {
        EmptyState(
          systemImage: "magnifyingglass", line: state.line,
          fill: .action(EmptyState.Action("New search", systemImage: "magnifyingglass") {
            model.text = ""
            searchFocused = true
          }))
        suggestions
      }
    } else {
      EmptyState(systemImage: "magnifyingglass", line: state.line)
    }
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
        SectionHeader(title: "Songs")
        let tracks = model.tracks
        ForEach(Array(tracks.enumerated()), id: \.offset) { index, track in
          SongRow(track: track) {
            // Playing a result makes the search a recent one.
            session.recentSearches.record(model.query)
            session.player.play(tracks, startAt: index)
          }
          .padding(.horizontal, 20)
        }
        if let label = model.showAllLabel {
          Button { model.showAllTracks = true } label: { Kicker(text: label).frame(minHeight: 44).contentShape(Rectangle()) }
            .padding(.horizontal, 20)
        }
      }
    }
    if !model.playlistHits.isEmpty {
      VStack(alignment: .leading, spacing: 0) {
        SectionHeader(title: "Playlists")
        FlowLayout(lineSpacing: 0) { ForEach(model.playlistHits) { Chip(text: "\($0.name) · \($0.trackCount)", route: .playlist($0.id)) } }
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
        Shelf { ForEach(artists) { ArtistCard(artist: $0, width: ShelfCard.width) } }
      }
    }
  }
}

/// The empty search page's first offer (Search.tsx `RecentSearches`): what this account searched for lately on this
/// device, newest first, each searched again with a tap; × takes one off the list and Clear all of them, with Undo.
private struct RecentSearchesSection: View {
  let recents: RecentSearches
  let toasts: ToastCenter
  let search: (String) -> Void

  var body: some View {
    if !recents.list.isEmpty {
      VStack(alignment: .leading, spacing: 0) {
        HStack {
          Kicker(text: "Recent searches").accessibilityAddTraits(.isHeader)
          Spacer()
          Button("Clear") { recents.removeAll(toasts: toasts) }
            .buttonStyle(.pill(.ghost, size: .small))
        }
        ForEach(recents.list, id: \.self) { query in
          HStack(spacing: 4) {
            Button { search(query) } label: {
              HStack(spacing: 12) {
                Image(systemName: "clock.arrow.circlepath").foregroundStyle(.muted).accessibilityHidden(true)
                Text(query).typeRole(.body).foregroundStyle(.paper).lineLimit(1)
                Spacer(minLength: 0)
              }
              .frame(minHeight: SongRow.compactHeight)
              .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .pointerHover()
            .accessibilityLabel("Search for “\(query)”")
            Button { recents.remove(query, toasts: toasts) } label: {
              Image(systemName: "xmark").frame(width: 44, height: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(.paperDim)
            .pointerHover()
            .accessibilityLabel("Remove “\(query)” from recent searches")
          }
        }
      }
      .padding(.horizontal, 20)
    }
  }
}
