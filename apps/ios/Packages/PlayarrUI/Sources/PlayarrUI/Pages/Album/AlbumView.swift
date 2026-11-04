import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// An album (apps/web/src/pages/Album.tsx).
struct AlbumView: View {
  @State private var model: AlbumModel
  @Environment(AccountSession.self) private var session
  @Environment(Theme.self) private var theme

  init(id: Int, session: AccountSession, theme: Theme) {
    _model = State(initialValue: AlbumModel(id: id, session: session, theme: theme))
  }

  var body: some View {
    ScrollView {
      if let error = model.album.error {
        ErrorState(message: error) { await model.album.refresh() }
      } else if let album = model.album.value {
        VStack(alignment: .leading, spacing: 24) {
          header(album)
          buttons(album)
          songs
          if let overview = album.overview { linerNotes(overview) }
          if !model.moreByArtist.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
              SectionHeader(title: "More by \(album.artistName)", kicker: "Discography", seeAll: .artist(album.artistId))
              Shelf { ForEach(model.moreByArtist) { AlbumCard(album: $0, width: ShelfCard.width) } }
            }
          }
        }
        .padding(.bottom, 24)
        .background(alignment: .top) { tint }
      } else {
        VStack(spacing: 16) {
          Skeleton().frame(width: 260)
          ForEach(0..<8, id: \.self) { _ in Skeleton(aspectRatio: nil, height: 36) }
        }
        .padding(20)
      }
    }
    .inlineTitle()
    .task { await model.load() }
    .refreshable { await model.album.refresh() }
  }

  /// The header's wash, tinted with the album's own colour.
  @ViewBuilder private var tint: some View {
    if let tint = model.tint {
      LinearGradient(
        stops: [.init(color: tint.color.opacity(0.32), location: 0), .init(color: tint.color.opacity(0.08), location: 0.55), .init(color: .clear, location: 1)],
        startPoint: .top, endPoint: .bottom
      )
      .frame(height: 520)
      .ignoresSafeArea()
    }
  }

  private func header(_ album: AlbumDetail) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      Cover(path: album.coverUrl, points: 280, label: album.title)
        .frame(maxWidth: 280)
        .frame(maxWidth: .infinity)
        .shadow(color: .black.opacity(0.6), radius: 24, y: 16)
        .padding(.bottom, 8)
      if let kicker = model.kicker { Kicker(text: kicker) }
      Text(album.title).font(.display(.largeTitle)).accessibilityAddTraits(.isHeader)
      NavigationLink(value: Route.artist(album.artistId)) {
        HStack(spacing: 8) {
          if let image = model.artist?.value?.imageUrl {
            Cover(path: image, points: 24, circle: true).frame(width: 24, height: 24)
          }
          Text(album.artistName)
        }
      }
      .buttonStyle(.plain)
      HStack(spacing: 8) {
        if let details = model.details() { Text(details).font(.mono(.caption)).foregroundStyle(.secondary) }
        FormatBadge(format: album.format)
      }
    }
    .padding(.horizontal, 20)
  }

  private func buttons(_ album: AlbumDetail) -> some View {
    HStack(spacing: 12) {
      Button { model.playOrPause() } label: {
        Label(model.playLabel, systemImage: model.isPlaying ? "pause.fill" : "play.fill").padding(.horizontal, 6)
      }
      .buttonStyle(.borderedProminent)
      .tint(theme.accent.color)
      .foregroundStyle(.black)
      .accessibilityLabel("\(model.playLabel) \(album.title)")
      .sensoryFeedback(.selection, trigger: model.isPlaying)
      Button { model.shuffle() } label: { Label("Shuffle", systemImage: "shuffle") }
        .buttonStyle(.bordered)
        .accessibilityLabel("Shuffle \(album.title)")
      Menu {
        Button("Play next", systemImage: "text.line.first.and.arrowtriangle.forward") { session.actions.playNext(album.tracks) }
        Button("Add to queue", systemImage: "text.append") { session.actions.addToQueue(album.tracks) }
        Button("Go to artist", systemImage: "music.mic") { session.router.open(.artist(album.artistId)) }
      } label: {
        Image(systemName: "ellipsis").frame(width: 44, height: 44)
      }
      .accessibilityLabel("More for \(album.title)")
      DownloadButton(
        store: session.player.downloads,
        item: DownloadItem(
          key: PinnedDownload.Key.album(album.id), title: album.title, subtitle: album.artistName, coverUrl: album.coverUrl,
          href: "/albums/\(album.id)"),
        tracks: album.tracks)
      RequestRestButton(album: Album(album))
    }
    .buttonBorderShape(.capsule)
    .padding(.horizontal, 20)
  }

  private var songs: some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(model.rows) { row in
        switch row {
        case .disc(let number):
          Label("Disc \(number)", systemImage: "opticaldisc")
            .font(.mono(.caption2))
            .foregroundStyle(.secondary)
            .padding(.top, 16)
            .accessibilityAddTraits(.isHeader)
        case .track(let track, let index):
          TrackRow(track: track) { model.tap(track, index: index) }
        case .missing(let missing):
          MissingTrackRow(missing: missing)
        }
      }
    }
    .padding(.horizontal, 20)
  }

  private func linerNotes(_ overview: String) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Kicker(text: "Liner notes")
      Text(overview).font(.sans(.callout)).foregroundStyle(.secondary)
    }
    .padding(.horizontal, 20)
  }
}
