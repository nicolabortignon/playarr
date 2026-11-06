import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// Home (apps/web/src/pages/Home.tsx), every section in the web's order.
struct HomeView: View {
  @State private var model: HomeModel
  /// Feeling lucky is picking its songs.
  @State private var picking = false
  @Environment(Theme.self) private var theme
  @Environment(AccountSession.self) private var session
  @Environment(\.verticalSizeClass) private var verticalSizeClass
  @Environment(\.dynamicTypeSize) private var typeSize

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
    // No title in the bar, scrolled or not: the page greets you instead. (Hiding the bar outright kept the app from
    // ever settling, the tab bar and the bar's safe area chasing each other.)
    .navigationTitle("")
    .inlineTitle()
    .task { await model.load() }
    .refreshable { await model.refresh() }
    .overlay {
      if let failure = model.failure {
        ErrorState(message: failure) { await model.refresh() }.background(.background)
      }
    }
  }

  /// The greeting, the library in a line, Feeling lucky and Resume: a column upright; held sideways, one row with the
  /// buttons on the right, so the shelves start on the first screen.
  private var intro: some View {
    let sideways = GatefoldRule.applies(verticalSizeClass)
    let layout = sideways ? AnyLayout(HStackLayout(alignment: .bottom, spacing: 24)) : AnyLayout(VStackLayout(alignment: .leading, spacing: 20))
    return layout {
      VStack(alignment: .leading, spacing: sideways ? 8 : 20) {
        Text("Hi, \(greetingName).")
          .font(.display(.largeTitle))
          .lineLimit(1)
          .minimumScaleFactor(0.6)
          .accessibilityAddTraits(.isHeader)
        Text(model.libraryLine ?? "Loading library")
          .font(.sans(.callout))
          .foregroundStyle(.secondary)
          .redacted(reason: model.libraryLine == nil ? .placeholder : [])
      }
      if sideways { Spacer(minLength: 0) }
      // Side by side on one line: a long song title is cut short rather than pushing Resume onto the next. At the
      // accessibility sizes, one above the other.
      AdaptiveStack(spacing: 12) {
        Button {
          Task {
            picking = true
            await model.feelingLucky()
            picking = false
          }
        } label: {
          // The sparkles twinkle in turn while the songs are picked.
          Label {
            Text("Feeling lucky")
          } icon: {
            Twinkle(on: picking)
          }
        }
        .buttonStyle(.pill(.primary, size: .large))
        .fixedSize(horizontal: !typeSize.isAccessibilitySize, vertical: false)
        .disabled(picking)
        .accessibilityLabel("Feeling lucky")
        .accessibilityHint("Plays 15 songs picked for this hour, new every time")
        .sensoryFeedback(.success, trigger: picking) { wasPicking, nowPicking in wasPicking && !nowPicking }
        if let track = model.listening { ListeningButton(track: track, playing: model.isPlaying, player: session.player) { model.togglePlay() } }
      }
    }
    .padding(.horizontal, 20)
  }

  /// The account's name, else its username.
  private var greetingName: String {
    let name = session.account.name.trimmingCharacters(in: .whitespaces)
    return name.isEmpty ? session.account.username : name
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
          Cover(path: top.imageUrl, points: 96, label: top.name, circle: true).frame(width: 96, height: 96)
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
        SongRow(track: track) { session.player.play(tracks, startAt: index, source: FavoritesStore.source) }
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
      Shelf { ForEach(model.shelf) { ArtistCard(artist: $0, width: ShelfCard.width) } }
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

/// The listening session, beside Feeling lucky: paused, "Resume" and the song's title beside its cover with a play sign;
/// playing, just the cover, round, ringed by how far into the song it is, with a pause sign. It draws in and out between
/// the two (apps/web/src/pages/Home.tsx ListeningButton).
private struct ListeningButton: View {
  let track: Track
  let playing: Bool
  let player: Player
  let toggle: () -> Void
  @Environment(Theme.self) private var theme

  var body: some View {
    Button(action: toggle) {
      HStack(spacing: 10) {
        Cover(path: track.coverUrl, points: 36, label: track.albumTitle, circle: true)
          .frame(width: 36, height: 36)
          .overlay {
            if playing { SongRing(player: player).tint(theme.accent.color).padding(-3) }
          }
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

/// How far into the song it is, as a ring: its own view, so only it redraws as the song plays.
private struct SongRing: View {
  let player: Player

  var body: some View {
    ProgressRing(fraction: player.duration > 0 ? min(1, player.time / player.duration) : 0, lineWidth: 2)
      .accessibilityHidden(true)
  }
}
