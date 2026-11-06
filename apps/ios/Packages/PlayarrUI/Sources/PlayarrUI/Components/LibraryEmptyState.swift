import SwiftUI

/// Albums or Artists with nothing in the library (docs/design.md, The lines): an admin is told how music arrives and
/// gets Add music (Settings → Sources); a member, that it shows up once an admin adds some.
struct LibraryEmptyState: View {
  let systemImage: String
  /// The page's line, for an admin or a member.
  let line: (_ admin: Bool) -> PageLines.Line
  let session: AccountSession

  var body: some View {
    let admin = session.account.role == .admin
    EmptyState(
      systemImage: systemImage, line: line(admin),
      fill: admin ? .action(EmptyState.Action("Add music", systemImage: "folder.badge.plus") { session.router.open(.settingsPanel(.sources)) }) : nil)
  }
}
