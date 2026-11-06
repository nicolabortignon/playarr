import PlayarrAPI
import SwiftUI

/// An empty page that listening fills (the queue, Favorites; docs/design.md, The lines): its line, with Jump back in,
/// which plays the album heard last, and Feeling lucky. The queue offers Feeling lucky first and Jump back in beside it;
/// Favorites offers Jump back in, and Feeling lucky only when nothing has been heard yet.
struct ListeningEmptyState: View {
  let systemImage: String
  let line: PageLines.Line
  /// Feeling lucky leads (the queue), else Jump back in does (Favorites).
  var luckyFirst = false

  @Environment(AccountSession.self) private var session
  @State private var heardLately: Query<[Album]>?

  var body: some View {
    let actions = Self.actions(heardLast: heardLately?.value?.first, luckyFirst: luckyFirst) { album in
      Task { await session.actions.playAlbum(album.id) }
    }
    EmptyState(systemImage: systemImage, line: line, fill: actions.fill, secondary: actions.secondary)
      .task {
        if heardLately == nil {
          let api = session.api
          heardLately = Query(.recentAlbums, cache: session.queries, staleAfter: 60) { try await api.send(API.Library.recentAlbums()) }
        }
        await heardLately?.load()
      }
  }

  /// What fills the page: Feeling lucky and Jump back in (the album heard last, when there is one), in the page's
  /// order; Feeling lucky alone when nothing has been heard.
  static func actions(
    heardLast: Album?, luckyFirst: Bool, play: @escaping @MainActor (Album) -> Void
  ) -> (fill: EmptyState.Fill, secondary: EmptyState.Action?) {
    guard let album = heardLast else { return (.lucky, nil) }
    let jump = EmptyState.Action("Jump back in", systemImage: "arrow.uturn.backward", hint: "Plays \(album.title), the album heard last") {
      play(album)
    }
    return luckyFirst ? (.lucky, jump) : (.action(jump), nil)
  }
}
