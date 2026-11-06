import PlayarrAPI
import SwiftUI

/// On a library artist's page: their albums and EPs not in the library at all, from their MusicBrainz discography,
/// each with Request (pages/Artist.tsx NotInLibrary). Only for artists with a MusicBrainz id, on a server with Lidarr.
public struct NotInLibrarySection: View {
  let artistMbid: String
  let owned: [Album]

  @Environment(DiscoverContext.self) private var context: DiscoverContext?
  @State private var artist: DiscoverArtistDetail?
  @State private var failed = false
  @State private var loading = false

  private let columns = [GridItem(.adaptive(minimum: 150), spacing: 16, alignment: .top)]

  public init(artistMbid: String, owned: [Album]) {
    self.artistMbid = artistMbid
    self.owned = owned
  }

  public var body: some View {
    if let context, context.gate.hasLidarr {
      content
        .task(id: context.generation(.discoverArtist)) { await load(context) }
    }
  }

  @ViewBuilder private var content: some View {
    if failed || artist?.discographyError != nil {
      VStack(alignment: .leading, spacing: 0) {
        SectionHeader(title: "Not in your library")
        VStack(alignment: .leading, spacing: 12) {
          Text("Couldn’t load the rest of this artist’s albums from MusicBrainz right now.").font(.sans(.footnote)).foregroundStyle(.secondary)
          TryAgainButton(busy: loading) { context?.invalidate([.discoverArtist]) }
        }
        .padding(.horizontal, 20)
      }
    } else if let artist {
      VStack(alignment: .leading, spacing: 32) {
        ForEach(Discography.notInLibrary(artist, owned: owned)) { group in
          VStack(alignment: .leading, spacing: 0) {
            SectionHeader(title: group.title, kicker: group.kicker)
            LazyVGrid(columns: columns, alignment: .leading, spacing: 24) {
              ForEach(group.albums, id: \.mbid) { DiscoverAlbumCard(album: $0, width: 150, onArtistPage: true) }
            }
            .padding(.horizontal, 20)
          }
        }
      }
    } else {
      VStack(alignment: .leading, spacing: 0) {
        SectionHeader(title: "Not in your library")
        VStack(alignment: .leading, spacing: 12) {
          LazyVGrid(columns: columns, spacing: 16) { ForEach(0..<4, id: \.self) { _ in Skeleton() } }
          SlowLookup(what: "the rest of this artist’s albums")
        }
        .padding(.horizontal, 20)
      }
    }
  }

  private func load(_ context: DiscoverContext) async {
    loading = true
    defer { loading = false }
    do {
      artist = try await context.discoverArtist(artistMbid)
      failed = false
    } catch is CancellationError {
    } catch {
      failed = true
    }
  }
}
