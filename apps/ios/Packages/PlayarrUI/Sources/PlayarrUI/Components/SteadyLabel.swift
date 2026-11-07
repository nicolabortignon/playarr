import SwiftUI

/// A `Label` as wide as the widest of the words it may show, so a button changing its words (Play, Pause, Resume)
/// moves nothing beside it.
struct SteadyLabel: View {
  /// One of the titles and icons it may show.
  struct Alternative: Hashable, Sendable {
    let title: String
    let systemImage: String
  }

  let title: String
  let systemImage: String
  /// Every title and icon it may show.
  let alternatives: [Alternative]

  init(_ title: String, systemImage: String, among alternatives: [(title: String, systemImage: String)]) {
    self.title = title
    self.systemImage = systemImage
    self.alternatives = alternatives.map { Alternative(title: $0.title, systemImage: $0.systemImage) }
  }

  var body: some View {
    ZStack {
      // Made by a function outside the main actor, not a closure made here: SwiftUI can make a ForEach's items while
      // it draws an animation off the main thread (iOS 26), and a closure made in `body` is the main actor's, which
      // traps there (build 684, pressing Play).
      ForEach(alternatives, id: \.self, content: Self.room(for:))
      Label(title, systemImage: systemImage)
    }
  }

  /// One of the words it may show, unseen, taking its room.
  nonisolated static func room(for alternative: Alternative) -> some View {
    Label(alternative.title, systemImage: alternative.systemImage).hidden()
  }
}
