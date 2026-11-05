import PlayarrAPI
import SwiftUI

/// An artist (apps/web/src/pages/Artist.tsx).
struct ArtistView: View {
  @State private var model: ArtistModel
  @Environment(Theme.self) private var theme
  @Environment(\.verticalSizeClass) private var verticalSizeClass

  init(id: Int, session: AccountSession) {
    _model = State(initialValue: ArtistModel(id: id, session: session))
  }

  var body: some View {
    ScrollView {
      if let error = model.artist.error {
        ErrorState(message: error) { await model.artist.refresh() }
      } else if let artist = model.artist.value {
        VStack(alignment: .leading, spacing: 32) {
          hero(artist)
          ForEach(model.groups, id: \.title) { group in
            VStack(alignment: .leading, spacing: 0) {
              SectionHeader(title: group.title, kicker: Format.plural(group.albums.count, "release"))
              LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 16)], spacing: 24) {
                ForEach(group.albums) { AlbumCard(album: $0) }
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
        VStack(alignment: .leading, spacing: 16) {
          Skeleton(aspectRatio: nil, height: 360)
          Skeleton(aspectRatio: nil, height: 16).frame(width: 180).padding(.horizontal, 20)
        }
      }
    }
    .ignoresSafeArea(edges: .top)
    .inlineTitle()
    .task { await model.load() }
    .refreshable { await model.artist.refresh() }
  }

  /// The photo's band: lower on an iPhone held sideways, so the albums start on the first screen.
  private var heroHeight: CGFloat { GatefoldRule.applies(verticalSizeClass) ? 240 : 380 }

  private func hero(_ artist: ArtistDetail) -> some View {
    ZStack(alignment: .bottomLeading) {
      if let fanart = artist.fanartUrl {
        Cover(path: fanart, points: 600).aspectRatio(contentMode: .fill).frame(height: heroHeight).clipped()
      } else {
        // No wide photo: the square one as a soft, blurred backdrop.
        Cover(path: artist.imageUrl, points: 240, label: artist.name)
          .aspectRatio(contentMode: .fill).frame(height: heroHeight).clipped().blur(radius: 40).opacity(0.6).saturation(1.5)
      }
      LinearGradient(colors: [.clear, .black.opacity(0.45), .black], startPoint: .top, endPoint: .bottom)
      VStack(alignment: .leading, spacing: 12) {
        Kicker(text: model.kicker)
        ArtistTitle(name: artist.name, logoUrl: artist.logoUrl)
        // The counts beside the buttons on one line, else under them.
        ViewThatFits(in: .horizontal) {
          HStack(spacing: 12) {
            playButtons(artist.name)
            counts
          }
          VStack(alignment: .leading, spacing: 10) {
            playButtons(artist.name)
            counts
          }
        }
        .buttonBorderShape(.capsule)
      }
      .padding(20)
    }
    .frame(height: heroHeight)
  }

  @ViewBuilder private var similar: some View {
    if model.similar?.error != nil {
      VStack(alignment: .leading, spacing: 0) {
        SectionHeader(title: "Similar artists", kicker: "From ListenBrainz")
        Text("Couldn’t reach ListenBrainz for similar artists right now.").font(.sans(.subheadline)).foregroundStyle(.secondary).padding(.horizontal, 20)
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

  private func about(_ overview: String) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      SectionHeader(title: "About")
      Text(overview).font(.sans(.callout)).foregroundStyle(.secondary).lineLimit(model.bioOpen ? nil : 5).padding(.horizontal, 20)
      Button { model.bioOpen.toggle() } label: { Kicker(text: model.bioOpen ? "Less" : "Read more") }
        .padding(.horizontal, 20)
    }
  }
}

extension ArtistView {
  fileprivate func playButtons(_ artist: String) -> some View {
    PlayShuffleButtons(title: artist) {
      Task { await model.play() }
    } shuffle: {
      Task { await model.play(shuffle: true) }
    }
  }

  @ViewBuilder fileprivate var counts: some View {
    if let counts = model.counts { Text(counts).font(.mono(.caption)).foregroundStyle(.secondary).lineLimit(1).fixedSize() }
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
        Text(name).font(.display(.largeTitle)).lineLimit(2).minimumScaleFactor(0.5)
      }
    }
    .accessibilityAddTraits(.isHeader)
    .task(id: logoUrl) {
      logo = await session.images.original(logoUrl).flatMap(Image.decoded)
    }
  }
}
