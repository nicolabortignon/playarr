import PlayarrAPI
import SwiftUI

/// An artist's discography from MusicBrainz, with what's in the library and what can be requested
/// (pages/DiscoverArtist.tsx): the header (their picture in a circle, how many releases and how many are here), Albums,
/// then EPs & soundtracks, similar artists and About; `album` brings one into view and marks it.
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
            header(artist, discography).padding(.horizontal, 20)
            if let notice = discography.notice { Text(notice).font(.sans(.footnote)).foregroundStyle(.secondary).padding(.horizontal, 20) }
            ForEach(discography.groups) { group in
              VStack(alignment: .leading, spacing: 0) {
                SectionHeader(title: group.title, kicker: group.kicker)
                LazyVGrid(columns: columns, alignment: .leading, spacing: 24) {
                  ForEach(group.albums, id: \.mbid) {
                    DiscoverAlbumCard(album: $0, highlighted: $0.mbid == discography.highlighted, width: 150, onArtistPage: true)
                  }
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
            if let overview = artist.overview { about(overview, genres: artist.genres) }
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
        .padding(.top, 12)
        .padding(.bottom, 20)
      }
      .onChange(of: model.discography?.highlighted) { _, mbid in
        guard let mbid else { return }
        withAnimation { proxy.scrollTo(mbid, anchor: .center) }
      }
    }
    .titleInBar(model.artist?.name ?? "")
    .task(id: context.generation(.discoverArtist)) { await model.load() }
  }

  /// Their picture in a circle, Artist, the name, and how many releases there are and how many are here.
  private func header(_ artist: DiscoverArtistDetail, _ discography: Discography) -> some View {
    DetailHeader(kicker: "Artist", round: true) {
      Cover(path: artist.imageUrl, points: 192, label: artist.name, circle: true)
    } title: {
      DetailTitle(artist.name)
    } meta: {
      VStack(alignment: .leading, spacing: 4) {
        MetaLine(artist.disambiguation, discography.summary)
        if let id = artist.artistId {
          NavigationLink(value: DiscoverDestination.libraryArtist(id: id).route) {
            HStack(spacing: 6) {
              Text("Open in your library")
              Image(systemName: "arrow.right")
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
          }
          .foregroundStyle(.tint)
        }
      }
    } actions: {
      EmptyView()
    }
  }

  /// About: the genres as its kicker, then the biography.
  private func about(_ overview: String, genres: [String]) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      SectionHeader(title: "About", kicker: genres.isEmpty ? nil : genres.prefix(3).joined(separator: " · "))
      Text(overview).font(.sans(.callout)).foregroundStyle(.secondary).lineLimit(bioOpen ? nil : 5).padding(.horizontal, 20)
      Button { bioOpen.toggle() } label: {
        Kicker(text: bioOpen ? "Less" : "Read more").frame(minHeight: 44).contentShape(Rectangle())
      }
      .padding(.horizontal, 20)
    }
  }
}
