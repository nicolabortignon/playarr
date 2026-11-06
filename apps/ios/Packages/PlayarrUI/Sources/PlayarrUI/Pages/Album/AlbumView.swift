import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// An album (apps/web/src/pages/Album.tsx).
struct AlbumView: View {
  @State private var model: AlbumModel
  @Environment(AccountSession.self) private var session
  @Environment(\.verticalSizeClass) private var verticalSizeClass

  init(id: Int, session: AccountSession, theme: Theme) {
    _model = State(initialValue: AlbumModel(id: id, session: session, theme: theme))
  }

  var body: some View {
    Group {
      if GatefoldRule.applies(verticalSizeClass), let album = model.album.value {
        // Sideways: the cover stays on the left, the rest scrolls beside it, all on the album's wash.
        Gatefold { side in
          Cover(path: album.coverUrl, points: side, label: album.title).coverShadow(.hero)
        } page: {
          ScrollView { content(cover: false).padding(.top, 16) }
        }
        .background(alignment: .top) { wash().ignoresSafeArea() }
      } else {
        ScrollView {
          // The page starts below the bar; its wash scrolls with it and reaches up behind the status bar and the back
          // button (and on the iPhone Duo's cover screen under the column on the right).
          content(cover: true)
            .padding(.top, 12)
            .background(alignment: .top) { wash(overhang: 200) }
        }
      }
    }
    .titleInBar(model.album.value?.title ?? "")
    .task { await model.load() }
    .refreshable { await model.album.refresh() }
  }

  @ViewBuilder private func content(cover: Bool) -> some View {
    if let error = model.album.error {
      ErrorState(message: error) { await model.album.refresh() }
    } else if let album = model.album.value {
      VStack(alignment: .leading, spacing: 24) {
        header(album, cover: cover)
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
    } else {
      DetailSkeleton().padding(.horizontal, 20)
    }
  }

  /// The header's wash, tinted with the album's own color. With an overhang it reaches that far past the top and the
  /// sides of what it's behind: scrolled content can't ignore the safe area, but it's drawn under the bars all the same.
  @ViewBuilder private func wash(overhang: CGFloat = 0) -> some View {
    if let tint = model.tint {
      LinearGradient(
        stops: [.init(color: tint.color.opacity(0.32), location: 0), .init(color: tint.color.opacity(0.08), location: 0.55), .init(color: .clear, location: 1)],
        startPoint: .top, endPoint: .bottom
      )
      .frame(height: 520 + overhang)
      .padding(.top, -overhang)
      .padding(.horizontal, -overhang)
    }
  }

  /// The cover (unless it's beside the page), what kind of release it is, the title, the meta line and the action row.
  private func header(_ album: AlbumDetail, cover: Bool) -> some View {
    DetailHeader(kicker: model.kicker ?? "Album", overArt: true, showsCover: cover) {
      Cover(path: album.coverUrl, points: 256, label: album.title)
    } title: {
      DetailTitle(album.title)
    } meta: {
      AlbumMetaLine(album: album, facts: model.facts ?? "", photo: model.artistPhoto)
    } actions: {
      buttons(album)
    }
    .padding(.horizontal, 20)
  }

  /// Play, Shuffle, Request the rest when only some of it is here, Download and ⋯.
  private func buttons(_ album: AlbumDetail) -> some View {
    ActionRow(
      title: album.title, playState: model.playState, play: model.playOrPause, shuffle: model.shuffle,
      download: DownloadButton(
        store: session.player.downloads,
        item: DownloadItem(
          key: PinnedDownload.Key.album(album.id), title: album.title, subtitle: album.artistName, coverUrl: album.coverUrl,
          href: "/albums/\(album.id)"),
        tracks: album.tracks),
      moreLabel: "More for \(album.title)"
    ) { compact in
      RequestRestButton(album: Album(album), compact: compact)
    } more: {
      MenuButtons(groups: PlayableMenu.album(album.id, artistId: album.artistId, tracks: album.tracks, session: session))
    }
  }

  /// The songs by number, missing ones grayed in their place, a heading before each disc when there are several.
  private var songs: some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(model.rows) { row in
        switch row {
        case .disc(let number):
          Label("Disc \(number)", systemImage: "opticaldisc")
            .typeRole(.kicker)
            .foregroundStyle(.muted)
            .padding(.top, 16)
            .accessibilityAddTraits(.isHeader)
        case .track(let track, let index):
          SongRow(track: track, lead: .number, place: SongMenu.Place(inAlbum: true)) { model.play(from: index) }
        case .missing(let missing):
          MissingSongRow(title: missing.title, lead: .number(missing.trackNumber), duration: missing.duration)
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

/// An album's meta line (docs/design.md, "Headers"): the artist, with their photo when they have one of their own,
/// then "1998 · 3 songs · 17 min" and the format badge. One line where it fits; on a phone the artist has a line of
/// their own and the rest follows, so the badge never sits beside a wrapped block of words.
private struct AlbumMetaLine: View {
  let album: AlbumDetail
  let facts: String
  let photo: String?

  var body: some View {
    ViewThatFits(in: .horizontal) {
      HStack(spacing: 8) {
        artist
        Text(verbatim: "·").accessibilityHidden(true)
        factsAndBadge
      }
      VStack(alignment: .leading, spacing: 8) {
        artist
        factsAndBadge
      }
      VStack(alignment: .leading, spacing: 8) {
        artist
        Text(facts)
        FormatBadge(format: album.format)
      }
    }
  }

  private var artist: some View {
    NavigationLink(value: Route.artist(album.artistId)) {
      HStack(spacing: 8) {
        if let photo { Cover(path: photo, points: 24, circle: true).frame(width: 24, height: 24) }
        Text(album.artistName).typeRole(.body).foregroundStyle(.paper).lineLimit(1)
      }
      // 44 points to tap, without spreading the header's lines apart.
      .frame(minHeight: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .padding(.vertical, -10)
  }

  private var factsAndBadge: some View {
    HStack(spacing: 8) {
      Text(facts).lineLimit(1)
      FormatBadge(format: album.format)
    }
  }
}
