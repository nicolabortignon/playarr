import PlayarrAPI
import SwiftUI

/// An artist (apps/web/src/pages/Artist.tsx): with a photo of their own, the header over it in a band; without one, a
/// compact header with their best album cover in a circle.
struct ArtistView: View {
  @State private var model: ArtistModel
  @Environment(\.verticalSizeClass) private var verticalSizeClass

  init(id: Int, session: AccountSession) {
    _model = State(initialValue: ArtistModel(id: id, session: session))
  }

  var body: some View {
    // The photo's band runs from the very top of the screen, behind the status bar and the back button (as its stand-in
    // does while the artist loads); a compact header starts below the bar.
    let band = model.artist.value.map { $0.heroPhoto != nil } ?? true
    ScrollView {
      if let error = model.artist.error {
        ErrorState(message: error) { await model.artist.refresh() }
      } else if let artist = model.artist.value {
        VStack(alignment: .leading, spacing: 32) {
          if let photo = artist.heroPhoto {
            hero(artist, photo: photo)
          } else {
            header(artist, compact: true)
              .padding(.horizontal, 20)
              .padding(.top, 12)
          }
          if model.groups.isEmpty {
            EmptyState(systemImage: "square.stack", line: PageLines.artist(artist.name))
          }
          ForEach(model.groups, id: \.title) { group in
            VStack(alignment: .leading, spacing: 0) {
              SectionHeader(title: group.title, kicker: Format.plural(group.albums.count, "release"))
              LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 16, alignment: .top)], spacing: 24) {
                // Their name would say nothing here: what each is and when ("EP · 2019").
                ForEach(group.albums) { AlbumCard(album: $0, onArtistPage: true) }
              }
              .padding(.horizontal, 20)
            }
          }
          if let mbid = artist.mbid { NotInLibrarySection(artistMbid: mbid, owned: artist.albums) }
          similar
          if let overview = artist.overview { about(overview) }
        }
        .padding(.bottom, 24)
      } else {
        // The band, then the first albums in their grid.
        VStack(alignment: .leading, spacing: 32) {
          Skeleton(aspectRatio: nil, height: heroHeight, corner: 0)
          VStack(alignment: .leading, spacing: 12) {
            TextBar(role: .sectionTitle, fraction: 0.4)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 16, alignment: .top)], spacing: 24) {
              CardSkeletons(count: 4)
            }
          }
          .padding(.horizontal, 20)
        }
      }
    }
    .ignoresSafeArea(edges: band ? .top : [])
    // iOS 27 draws a hard edge, a flat band with a line, over a photo that starts under the bar; the soft one fades.
    .scrollEdgeEffectStyle(band ? .soft : nil, for: .top)
    .titleInBar(model.artist.value?.name ?? "")
    .task { await model.load() }
    .refreshable { await model.artist.refresh() }
  }

  /// The photo's band: lower on an iPhone held sideways, so the albums start on the first screen.
  private var heroHeight: CGFloat { GatefoldRule.applies(verticalSizeClass) ? 240 : 380 }

  private func hero(_ artist: ArtistDetail, photo: String) -> some View {
    ArtistBand(height: heroHeight) {
      header(artist, compact: false)
    } photo: {
      if artist.fanartUrl != nil {
        Cover(path: photo, points: 600).aspectRatio(contentMode: .fill)
      } else {
        // No wide photo: the square one as a soft, blurred backdrop.
        Cover(path: photo, points: 240, label: artist.name).aspectRatio(contentMode: .fill).blur(radius: 40).opacity(0.6).saturation(1.5)
      }
    }
  }

  /// Artist, the name (or their logo), how much of them is here and the action row: over their photo, or `compact`,
  /// below their best album cover in a circle, for an artist without one.
  private func header(_ artist: ArtistDetail, compact: Bool) -> some View {
    DetailHeader(kicker: "Artist", round: true, overArt: !compact, showsCover: compact) {
      Cover(path: artist.roundCover, points: 192, label: artist.name, circle: true)
    } title: {
      ArtistTitle(name: artist.name, logoUrl: artist.logoUrl)
    } meta: {
      MetaLine(model.counts)
    } actions: {
      ActionRow(
        title: artist.name, playState: model.playState, play: { Task { await model.playOrPause() } },
        shuffle: { Task { await model.play(shuffle: true) } }, moreLabel: "More for \(artist.name)"
      ) {
        Button("Play next", systemImage: "text.line.first.and.arrowtriangle.forward") { Task { await model.queue(next: true) } }
        Button("Add to queue", systemImage: "text.append") { Task { await model.queue(next: false) } }
      }
    }
  }

  @ViewBuilder private var similar: some View {
    if model.similar?.error != nil {
      VStack(alignment: .leading, spacing: 0) {
        SectionHeader(title: "Similar artists", kicker: "From ListenBrainz")
        InlineError(SimilarArtistGroups.failed) { await model.similar?.refresh() }.padding(.horizontal, 20)
      }
    } else if let artists = model.similar?.value {
      // Those in the library first, then the others, whose discography opens to request albums.
      ForEach(SimilarArtistGroups.make(artists), id: \.title) { group in
        VStack(alignment: .leading, spacing: 0) {
          SectionHeader(title: group.title, kicker: SimilarArtistGroups.kicker)
          Shelf { ForEach(group.artists, id: \.mbid) { DiscoverArtistCard(artist: $0) } }
        }
      }
    }
  }

  /// About: the genres as its kicker, then the biography.
  private func about(_ overview: String) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      SectionHeader(title: "About", kicker: model.genres)
      Text(overview).font(.sans(.callout)).foregroundStyle(.secondary).lineLimit(model.bioOpen ? nil : 5).padding(.horizontal, 20)
      Button { model.bioOpen.toggle() } label: {
        Kicker(text: model.bioOpen ? "Less" : "Read more").frame(minHeight: 44).contentShape(Rectangle())
      }
      .padding(.horizontal, 20)
    }
  }
}

/// The photo's band with the header at its foot: `height` tall, or taller where the header needs the room to keep clear
/// of the bar it runs up under (an iPhone held sideways, larger text).
private struct ArtistBand<Header: View, Photo: View>: View {
  let height: CGFloat
  let header: Header
  let photo: Photo

  @Environment(BarTitle.self) private var bar: BarTitle?

  init(height: CGFloat, @ViewBuilder header: () -> Header, @ViewBuilder photo: () -> Photo) {
    self.height = height
    self.header = header()
    self.photo = photo()
  }

  var body: some View {
    header
      .padding(20)
      // The band starts at the top of the screen, so the bar's foot is how far down the header must stay.
      .padding(.top, bar?.barBottom ?? 0)
      .frame(maxWidth: .infinity, minHeight: height, alignment: .bottomLeading)
      .background {
        Color.clear
          .overlay { photo }
          .overlay { LinearGradient(colors: [.clear, .black.opacity(0.45), .black], startPoint: .top, endPoint: .bottom) }
          .clipped()
          // Under the iPhone Duo's column on the right too; the header keeps clear of it.
          .ignoresSafeArea(edges: .horizontal)
      }
  }
}

/// The artist's name, or their logo where the server has one (apps/web/src/pages/Artist.tsx): the name stays what
/// VoiceOver reads, and shows if the logo can't be had.
private struct ArtistTitle: View {
  let name: String
  let logoUrl: String?

  @Environment(AccountSession.self) private var session
  @State private var logo: Image?

  var body: some View {
    Group {
      if let logo {
        logo.resizable().scaledToFit()
          .frame(maxWidth: 360, maxHeight: 96, alignment: .leading)
          .shadow(color: .black.opacity(0.6), radius: 12, y: 4)
          .accessibilityLabel(name)
      } else {
        Text(name).typeRole(.pageTitle).foregroundStyle(.paper).lineLimit(2).minimumScaleFactor(0.5)
      }
    }
    .accessibilityAddTraits(.isHeader)
    .task(id: logoUrl) {
      logo = await session.images.original(logoUrl).flatMap(Image.decoded)
    }
  }
}
