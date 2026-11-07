import PlayarrAPI
import SwiftUI

/// The player bar with nothing playing (apps/web/src/components/PlayerBar.tsx `Idle`; docs/design.md, "The idle player
/// bar"): never controls that do nothing, but what to play instead. The album heard last, on any device, under "Heard
/// last", with Resume to play it again and Feeling lucky beside it; with no history, "Nothing playing" and Feeling
/// lucky. It fills two of the bar's parts: what was heard where the song goes, the buttons where the transport goes.
struct IdlePlayerBar: View {
  let session: AccountSession
  @State private var heardLately: Query<[Album]>?
  @State private var resuming = false
  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    let last = heardLately?.value?.first
    heard(last)
      .frame(maxWidth: typeSize.isAccessibilitySize ? nil : .infinity, alignment: .leading)
      .task { await load() }
    ZStack {
      // The transport's room, kept unseen, so the bar doesn't change height as a song starts.
      PlayerBar.deck(session.player).hidden()
      buttons(last)
    }
  }

  @ViewBuilder private func heard(_ album: Album?) -> some View {
    if let album {
      HStack(spacing: 14) {
        Cover(path: album.coverUrl, points: 56, label: album.title, corner: Radius.cover).frame(width: 56, height: 56)
        // One target, 44 points high, for the words: the album's page.
        Button { session.router.open(.album(album.id)) } label: {
          VStack(alignment: .leading, spacing: 2) {
            Kicker(text: "Heard last")
            Text(album.title).typeRole(.body).essentialLineLimit()
            Text(album.artistName).typeRole(.small).foregroundStyle(.paperDim).essentialLineLimit()
          }
          .frame(minHeight: 44, alignment: .leading)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .pointerHover()
        .accessibilityLabel("Heard last: \(album.title), \(album.artistName)")
        .accessibilityHint("Opens the album")
      }
    } else {
      Kicker(text: "Nothing playing")
    }
  }

  /// Resume (the album heard last, from its start, as Jump back in) and Feeling lucky; Feeling lucky alone, filled, when
  /// nothing has been heard yet.
  private func buttons(_ album: Album?) -> some View {
    HStack(spacing: 12) {
      if let album {
        Button { resume(album) } label: {
          SteadyLabel(resuming ? "Resuming…" : "Resume", systemImage: "play.fill", among: [("Resume", "play.fill"), ("Resuming…", "play.fill")])
        }
        .buttonStyle(.pill(.primary, size: .regular))
        .disabled(resuming)
        .accessibilityLabel(resuming ? "Resuming \(album.title)" : "Resume \(album.title)")
        .accessibilityHint("Plays the album heard last")
      }
      FeelingLuckyButton(variant: album == nil ? .primary : .secondary, size: .regular)
    }
  }

  private func resume(_ album: Album) {
    Task {
      resuming = true
      await session.actions.playAlbum(album.id)
      resuming = false
    }
  }

  private func load() async {
    if heardLately == nil {
      let api = session.api
      heardLately = Query(.recentAlbums, cache: session.queries, staleAfter: 60) { try await api.send(API.Library.recentAlbums()) }
    }
    await heardLately?.load()
  }
}
