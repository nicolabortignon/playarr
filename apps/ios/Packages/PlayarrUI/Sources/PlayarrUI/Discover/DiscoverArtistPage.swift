import PlayarrAPI
import SwiftUI

/// An artist's discography from MusicBrainz, with what's in the library and what can be requested
/// (pages/DiscoverArtist.tsx): Albums, then EPs & soundtracks; `album` brings one into view and marks it.
public struct DiscoverArtistPage: View {
  let mbid: String
  let album: String?

  @Environment(DiscoverContext.self) private var context: DiscoverContext?

  public init(mbid: String, album: String? = nil) {
    self.mbid = mbid
    self.album = album
  }

  public var body: some View {
    if let context {
      DiscographyView(context: context, model: DiscoverArtistModel(context: context, mbid: mbid, album: album))
    }
  }
}

private struct DiscographyView: View {
  let context: DiscoverContext
  @State var model: DiscoverArtistModel
  @State private var bioOpen = false

  private let columns = [GridItem(.adaptive(minimum: 150), spacing: 16, alignment: .top)]

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        VStack(alignment: .leading, spacing: 32) {
          if let artist = model.artist, let discography = model.discography {
            hero(artist, discography)
            if let notice = discography.notice { Text(notice).font(.sans(.footnote)).foregroundStyle(.secondary).padding(.horizontal, 20) }
            ForEach(discography.groups) { group in
              VStack(alignment: .leading, spacing: 0) {
                SectionHeader(title: group.title, kicker: group.kicker)
                LazyVGrid(columns: columns, alignment: .leading, spacing: 24) {
                  ForEach(group.albums, id: \.mbid) { DiscoverAlbumCard(album: $0, highlighted: $0.mbid == discography.highlighted, width: 150) }
                }
                .padding(.horizontal, 20)
              }
            }
            if let failure = artist.discographyError {
              VStack(alignment: .leading, spacing: 8) {
                Text("Couldn’t load the discography from MusicBrainz right now.").font(.sans(.subheadline)).foregroundStyle(.secondary)
                Text(failure).font(.mono(.caption)).foregroundStyle(.secondary)
                TryAgainButton(busy: model.loading) { Task { await model.load(again: true) } }
              }
              .padding(.horizontal, 20)
            } else if let empty = discography.empty {
              Text(empty).foregroundStyle(.secondary).padding(.horizontal, 20)
            }
            SimilarArtistsSection(mbid: artist.mbid)
          } else if let error = model.error {
            VStack(alignment: .leading, spacing: 12) {
              Text(error).foregroundStyle(.secondary)
              TryAgainButton(busy: model.loading) { Task { await model.load(again: true) } }
            }
            .padding(.horizontal, 20)
          } else {
            VStack(alignment: .leading, spacing: 16) {
              Skeleton(aspectRatio: nil, height: 14).frame(width: 160)
              Skeleton(aspectRatio: nil, height: 48).frame(width: 280)
              SlowLookup(what: "this artist’s albums")
              LazyVGrid(columns: columns, spacing: 16) { ForEach(0..<8, id: \.self) { _ in Skeleton() } }
            }
            .padding(.horizontal, 20)
          }
        }
        .padding(.vertical, 20)
      }
      .onChange(of: model.discography?.highlighted) { _, mbid in
        guard let mbid else { return }
        withAnimation { proxy.scrollTo(mbid, anchor: .center) }
      }
    }
    .navigationTitle(model.artist?.name ?? "")
    .inlineTitle()
    .task(id: context.generation(.discoverArtist)) { await model.load() }
  }

  private func hero(_ artist: DiscoverArtistDetail, _ discography: Discography) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Kicker(text: artist.genres.isEmpty ? (artist.disambiguation ?? "Artist") : artist.genres.joined(separator: " · "))
      Text(artist.name).font(.display(.largeTitle)).accessibilityAddTraits(.isHeader)
      HStack(spacing: 16) {
        Text(discography.summary)
        if let id = artist.artistId {
          NavigationLink(value: DiscoverDestination.libraryArtist(id: id).route) { Label("Open in your library", systemImage: "arrow.right") }
            .foregroundStyle(.tint)
        }
      }
      .font(.mono(.caption))
      .foregroundStyle(.secondary)
      if let overview = artist.overview {
        Text(overview).font(.sans(.callout)).foregroundStyle(.secondary).lineLimit(bioOpen ? nil : 3)
        Button { bioOpen.toggle() } label: {
          Kicker(text: bioOpen ? "Less" : "Read more").frame(minHeight: 44).contentShape(Rectangle())
        }
      }
    }
    .padding(.horizontal, 20)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(alignment: .topLeading) {
      Cover(path: artist.imageUrl, points: 360, label: artist.name)
        .frame(width: 360, height: 360).blur(radius: 60).opacity(0.35).allowsHitTesting(false)
    }
  }
}
