import PlayarrAPI
import SwiftUI

/// Search's "Not in your library" (Search.tsx `Beyond`; docs/design.md, "Patterns"): songs, albums and artists from
/// Lidarr, else MusicBrainz, with Deezer for songs, under the library's results whenever there's anything there (or
/// on its way), with or without Lidarr. Request shows only where requesting is possible (`RequestButton` decides).
/// Search owns the model and tells it what's typed, so it knows when nothing is out there either.
struct DiscoverSection: View {
  let query: String
  let model: DiscoverSearchModel?
  /// It follows "Here's what's out there:" straight on, rather than results of the library's own.
  var continues = false

  @Environment(DiscoverContext.self) private var context: DiscoverContext?

  /// `query`: what's typed, trimmed.
  init(query: String, model: DiscoverSearchModel?, continues: Bool = false) {
    self.query = query
    self.model = model
    self.continues = continues
  }

  var body: some View {
    if let context, let model, BeyondLibrary.shows(query: query, model: model) {
      DiscoverResultsView(context: context, model: model, query: query, continues: continues)
    }
  }
}

/// What the section beyond the library says, and when it's there.
@MainActor enum BeyondLibrary {
  /// Where it's from: "Lidarr · MusicBrainz · Deezer", or without Lidarr "MusicBrainz · Deezer".
  static func kicker(_ gate: RequestGate) -> String {
    gate.hasLidarr ? "Lidarr · MusicBrainz · Deezer" : "MusicBrainz · Deezer"
  }

  /// The line beside the title: what Request does where it shows, else what this is.
  static func explanation(_ gate: RequestGate) -> String {
    gate.allowsRequests
      ? "Request an album and Lidarr will search your indexers for it. It lands in your library when it’s ready."
      : "Music from MusicBrainz and Deezer that isn’t in your library yet."
  }

  /// Over the songs, where they have Request buttons.
  static func songsKicker(_ gate: RequestGate) -> String? {
    gate.allowsRequests ? "Request the album it’s on" : nil
  }

  /// There while what's typed (two letters or more) is asked about and once anything is found; not once the answer for
  /// it is that there's nothing (the page above says so then).
  static func shows(query: String, model: DiscoverSearchModel) -> Bool {
    guard query.count >= DiscoverSearchModel.minimumLength else { return false }
    let answered = model.answered == query && model.typed == query && !model.fetching
    return !(answered && model.error == nil && model.nothing)
  }

  /// The answer for what's typed is that it couldn't be asked.
  static func failed(query: String, model: DiscoverSearchModel) -> Bool {
    model.answered == query && !model.fetching && model.error != nil
  }
}

private struct DiscoverResultsView: View {
  let context: DiscoverContext
  let model: DiscoverSearchModel
  let query: String
  let continues: Bool

  var body: some View {
    let gate = context.gate
    VStack(alignment: .leading, spacing: 28) {
      if !continues { Divider().padding(.horizontal, 20) }
      VStack(alignment: .leading, spacing: 6) {
        Kicker(text: BeyondLibrary.kicker(gate))
        HStack(spacing: 10) {
          Text("Not in your library").font(.display(.largeTitle)).accessibilityAddTraits(.isHeader)
          if model.fetching { Circle().fill(.tint).frame(width: 8, height: 8).accessibilityLabel("Searching") }
        }
        Text(BeyondLibrary.explanation(gate)).typeRole(.small).foregroundStyle(.paperDim)
      }
      .padding(.horizontal, 20)
      if BeyondLibrary.failed(query: query, model: model) {
        InlineError("Couldn’t search beyond your library", reason: model.error) { await model.reload() }.padding(.horizontal, 20)
      } else if model.albums.isEmpty, model.artists.isEmpty, model.tracks.isEmpty {
        // On its way: shown only while there's an answer to come.
        SongRowsSkeleton(count: 4).padding(.horizontal, 20)
      } else {
        if !model.tracks.isEmpty {
          VStack(alignment: .leading, spacing: 0) {
            SectionHeader(title: "Songs", kicker: BeyondLibrary.songsKicker(gate))
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
    }
    .onChange(of: context.generation(.discover)) { Task { await model.reload() } }
  }
}
