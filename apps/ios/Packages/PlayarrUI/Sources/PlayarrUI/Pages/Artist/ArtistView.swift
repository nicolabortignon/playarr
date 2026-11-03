import PlayarrAPI
import SwiftUI

/// An artist (apps/web/src/pages/Artist.tsx).
struct ArtistView: View {
  @State private var model: ArtistModel
  @Environment(Theme.self) private var theme

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
          // Phase 8: "Not in your library" (the rest of the discography, with Request) goes here.
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

  private func hero(_ artist: ArtistDetail) -> some View {
    ZStack(alignment: .bottomLeading) {
      if let fanart = artist.fanartUrl {
        Cover(path: fanart, points: 600).aspectRatio(contentMode: .fill).frame(height: 380).clipped()
      } else {
        // No wide photo: the square one as a soft, blurred backdrop.
        Cover(path: artist.imageUrl, points: 240, label: artist.name)
          .aspectRatio(contentMode: .fill).frame(height: 380).clipped().blur(radius: 40).opacity(0.6).saturation(1.5)
      }
      LinearGradient(colors: [.clear, .black.opacity(0.45), .black], startPoint: .top, endPoint: .bottom)
      VStack(alignment: .leading, spacing: 12) {
        Kicker(text: model.kicker)
        Text(artist.name).font(.system(.largeTitle, design: .serif, weight: .bold)).lineLimit(2).minimumScaleFactor(0.5)
          .accessibilityAddTraits(.isHeader)
        HStack(spacing: 12) {
          Button { Task { await model.play() } } label: { Label("Play", systemImage: "play.fill").padding(.horizontal, 6) }
            .buttonStyle(.borderedProminent).tint(theme.accent.color).foregroundStyle(.black)
          Button { Task { await model.play(shuffle: true) } } label: { Label("Shuffle", systemImage: "shuffle") }
            .buttonStyle(.bordered)
          if let counts = model.counts { Text(counts).font(.caption.monospaced()).foregroundStyle(.secondary) }
        }
        .buttonBorderShape(.capsule)
      }
      .padding(20)
    }
    .frame(height: 380)
  }

  @ViewBuilder private var similar: some View {
    if model.similar?.error != nil {
      VStack(alignment: .leading, spacing: 0) {
        SectionHeader(title: "Similar artists", kicker: "From ListenBrainz")
        Text("Couldn’t reach ListenBrainz for similar artists right now.").font(.subheadline).foregroundStyle(.secondary).padding(.horizontal, 20)
      }
    } else if !model.similarInLibrary.isEmpty {
      VStack(alignment: .leading, spacing: 0) {
        SectionHeader(title: "Similar artists in your library", kicker: "From ListenBrainz")
        Shelf {
          ForEach(model.similarInLibrary, id: \.mbid) { artist in
            if let id = artist.artistId {
              NavigationLink(value: Route.artist(id)) {
                VStack(spacing: 8) {
                  Cover(path: artist.imageUrl, points: 140, label: artist.name, circle: true)
                  Text(artist.name).font(.subheadline).lineLimit(1)
                }
                .frame(width: 140)
              }
              .buttonStyle(.plain)
              .accessibilityLabel(artist.name)
            }
          }
        }
      }
    }
  }

  private func about(_ overview: String) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      SectionHeader(title: "About")
      Text(overview).font(.callout).foregroundStyle(.secondary).lineLimit(model.bioOpen ? nil : 5).padding(.horizontal, 20)
      Button { model.bioOpen.toggle() } label: { Kicker(text: model.bioOpen ? "Less" : "Read more") }
        .padding(.horizontal, 20)
    }
  }
}
