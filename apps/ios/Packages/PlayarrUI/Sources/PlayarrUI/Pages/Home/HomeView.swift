import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// Home (apps/web/src/pages/Home.tsx), every section in the web's order.
struct HomeView: View {
  @State private var model: HomeModel
  @Environment(Theme.self) private var theme
  @Environment(AccountSession.self) private var session

  init(session: AccountSession) {
    _model = State(initialValue: HomeModel(session: session))
  }

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 36) {
        intro
        if model.showsMixes { mixes }
        if let review = model.yearInReview { yearInReview(review) }
        if !model.jumpBackIn.isEmpty { albumShelf(model.jumpBackIn, title: "Jump back in", kicker: "Heard lately") }
        if !model.favoriteTracks.isEmpty { favorites }
        if let playlists = session.playlists.playlists, !playlists.isEmpty { playlistShelf(playlists) }
        albumShelf(model.recent.value, title: "Recently added", kicker: "Just added", seeAll: .albums(.added))
        artists
        rediscover
      }
      .padding(.vertical, 16)
    }
    .navigationTitle("Playarr")
    .task { await model.load() }
    .refreshable { await model.refresh() }
  }

  private var intro: some View {
    VStack(alignment: .leading, spacing: 20) {
      Text(model.libraryLine ?? "Loading library")
        .font(.sans(.callout))
        .foregroundStyle(.secondary)
        .redacted(reason: model.libraryLine == nil ? .placeholder : [])
      // Side by side on one line: a long song title is cut short rather than pushing Resume onto the next.
      HStack(spacing: 12) {
        Button { Task { await model.shuffleEverything() } } label: {
          Label("Shuffle all", systemImage: "shuffle").padding(.horizontal, 6).padding(.vertical, 6)
        }
        .buttonStyle(.borderedProminent)
        .buttonBorderShape(.capsule)
        .tint(theme.accent.color)
        .foregroundStyle(.black)
        .fixedSize()
        .accessibilityLabel("Shuffle all")
        if let track = model.listening { ListeningButton(track: track, playing: model.isPlaying) { model.togglePlay() } }
      }
    }
    .padding(.horizontal, 20)
  }

  private var mixes: some View {
    VStack(alignment: .leading, spacing: 0) {
      SectionHeader(title: "Your mixes", kicker: "Made for you", seeAll: .mixes)
      Shelf {
        if let mixes = session.mixes.mixes {
          ForEach(mixes, id: \.key) { MixCard(mix: $0) }
        } else {
          ForEach(0..<5, id: \.self) { _ in Skeleton().frame(width: ShelfCard.width) }
        }
      }
    }
  }

  private func yearInReview(_ review: (year: Int, minutes: Int, top: Artist?)) -> some View {
    NavigationLink(value: Route.listeningRange(String(review.year))) {
      HStack(spacing: 16) {
        if let top = review.top {
          Cover(path: top.imageUrl, points: 96, label: top.name).frame(width: 96, height: 96)
        }
        VStack(alignment: .leading, spacing: 4) {
          Text("YEAR IN REVIEW").font(.mono(.caption2)).tracking(2).foregroundStyle(theme.accent.color)
          Text("Your \(String(review.year)) in music").font(.display(.title))
          Text("\(review.minutes.formatted()) minutes\(review.top.map { ", most of all \($0.name)" } ?? "")")
            .font(.sans(.subheadline)).foregroundStyle(.secondary)
        }
      }
      .padding(16)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(RoundedRectangle(cornerRadius: 12).fill(Color.secondary.opacity(0.12)))
    }
    .buttonStyle(.plain)
    .padding(.horizontal, 20)
  }

  private var favorites: some View {
    VStack(alignment: .leading, spacing: 0) {
      SectionHeader(title: "Favorites", kicker: "Songs you love", seeAll: .favorites)
      let tracks = model.favoriteTracks
      ForEach(Array(tracks.enumerated()), id: \.offset) { index, track in
        TrackRow(track: track, style: .mixed) {
          session.player.play(tracks, startAt: index, source: PlaySource(label: "Favorites", href: "/favorites"))
        }
        .padding(.horizontal, 20)
      }
    }
  }

  private func playlistShelf(_ playlists: [PlaylistSummary]) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      SectionHeader(title: "Playlists", kicker: "Made by you", seeAll: .playlists)
      Shelf { ForEach(playlists) { PlaylistCard(playlist: $0) } }
    }
  }

  private func albumShelf(_ albums: [Album]?, title: String, kicker: String, seeAll: Route? = nil) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      SectionHeader(title: title, kicker: kicker, seeAll: seeAll)
      Shelf {
        if let albums {
          ForEach(albums) { AlbumCard(album: $0, width: ShelfCard.width) }
        } else {
          ForEach(0..<6, id: \.self) { _ in Skeleton().frame(width: ShelfCard.width) }
        }
      }
    }
  }

  private var artists: some View {
    VStack(alignment: .leading, spacing: 0) {
      SectionHeader(title: "Artists", kicker: "The roster", seeAll: .artists)
      Shelf { ForEach(model.shelf) { ArtistCard(artist: $0, width: ShelfCard.artistWidth) } }
    }
  }

  private var rediscover: some View {
    VStack(alignment: .leading, spacing: 0) {
      SectionHeader(title: "Rediscover", kicker: "Pulled from the crates") {
        Button { Task { await model.reshuffle() } } label: {
          Image(systemName: "dice")
            .rotationEffect(.degrees(model.rediscover.isFetching ? 180 : 0))
            .animation(.easeInOut(duration: 0.5), value: model.rediscover.isFetching)
            .frame(width: 44, height: 44)
        }
        .accessibilityLabel("Reshuffle")
        .sensoryFeedback(.selection, trigger: model.seed)
      }
      LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 16)], spacing: 24) {
        ForEach(model.rediscover.value ?? []) { AlbumCard(album: $0) }
      }
      .padding(.horizontal, 20)
    }
  }
}

/// The listening session, beside Shuffle all: paused, "Resume" and the song's title beside its cover with a play sign;
/// playing, just the cover, round, with a pause sign. It draws in and out between the two (apps/web/src/pages/Home.tsx
/// ResumeButton, which hides while playing).
private struct ListeningButton: View {
  let track: Track
  let playing: Bool
  let toggle: () -> Void

  var body: some View {
    Button(action: toggle) {
      HStack(spacing: 10) {
        Cover(path: track.coverUrl, points: 36, label: track.albumTitle, circle: true)
          .frame(width: 36, height: 36)
          .overlay {
            Circle().fill(.black.opacity(0.45))
            Image(systemName: playing ? "pause.fill" : "play.fill")
              .font(.system(size: 13, weight: .bold))
              .foregroundStyle(.white)
              .contentTransition(.symbolEffect(.replace))
          }
        if !playing {
          VStack(alignment: .leading, spacing: 0) {
            Kicker(text: "Resume")
            Text(track.title).font(.sans(.subheadline)).lineLimit(1)
          }
          .transition(.opacity.combined(with: .move(edge: .leading)))
        }
      }
      .padding(5)
      .padding(.trailing, playing ? 0 : 11)
      .background(Capsule().fill(.tint.opacity(0.16)))
      .clipShape(Capsule())
      .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .animation(.snappy(duration: 0.35), value: playing)
    .accessibilityLabel(playing ? "Pause \(track.title)" : "Resume \(track.title)")
  }
}

