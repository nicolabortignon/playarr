import PlayarrAPI
import SwiftUI

/// A song not in the library: its cover, title, artist and album (each leading on), length, and the Request button
/// for the album it's on. Opens its album when the album is (partly) here (components/Discover.tsx DiscoverTrackRow).
struct DiscoverTrackRow: View {
  let track: DiscoverTrack

  init(track: DiscoverTrack) {
    self.track = track
  }

  var body: some View {
    HStack(spacing: 12) {
      if let opens = DiscoverDestination.row(track) {
        NavigationLink(value: opens.route) { cover }.buttonStyle(.plain)
      } else {
        cover
      }
      VStack(alignment: .leading, spacing: 2) {
        Text(track.title).lineLimit(1)
        HStack(spacing: 4) {
          NavigationLink(track.artistName, value: DiscoverDestination.artist(id: track.artistId, mbid: track.artistMbid, name: track.artistName).route)
          Text("·").foregroundStyle(.tertiary)
          NavigationLink(
            track.albumTitle,
            value: DiscoverDestination.album(
              id: track.availability.state == .available ? track.availability.albumId : nil,
              artistMbid: track.artistMbid, artistName: track.artistName, title: track.albumTitle
            ).route)
        }
        .buttonStyle(.plain)
        .font(.footnote)
        .foregroundStyle(.secondary)
        .lineLimit(1)
      }
      Spacer(minLength: 8)
      if let duration = track.duration {
        Text(Format.time(duration)).font(.footnote.monospacedDigit()).foregroundStyle(.secondary)
      }
      RequestButton(album: track.album, availability: track.availability, small: true)
    }
    .padding(.vertical, 6)
  }

  private var cover: some View {
    Cover(path: track.coverUrl, points: 44, label: track.albumTitle).frame(width: 44, height: 44)
  }
}
