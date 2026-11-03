import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// Presents the song sheets the menus open. Put on the signed-in app once, and once more inside Now Playing (a sheet
/// can't be presented under a full-screen cover): `active` says which of the two presents them now.
struct TrackSheetsModifier: ViewModifier {
  let player: Player?
  let active: Bool

  @Environment(DiscoverContext.self) private var context: DiscoverContext?

  func body(content: Content) -> some View {
    if let context {
      let sheets = context.sheets
      content
        .sheet(item: Binding(get: { active ? sheets.metadata : nil }, set: { sheets.metadata = $0 })) { target in
          TrackMetadataSheet(
            model: TrackMetadataModel(trackId: target.id, api: context.api, toast: context.toast, invalidate: { context.invalidate($0) }))
        }
        .sheet(item: Binding(get: { active ? sheets.mixPoints : nil }, set: { sheets.mixPoints = $0 })) { track in
          MixPointsSheet(
            model: MixPointsModel(
              track: track, api: context.api, player: player, toast: context.toast,
              invalidate: { context.invalidate($0) }, cuesChanged: sheets.cuesChanged))
        }
    } else {
      content
    }
  }
}

extension View {
  /// Show metadata and Edit mix points, opened from any song menu: on the signed-in app, and inside Now Playing while
  /// it's open (`active`).
  func trackSheets(player: Player?, active: Bool = true) -> some View {
    modifier(TrackSheetsModifier(player: player, active: active))
  }
}
