import SwiftUI

/// A `Label` as wide as the widest of the words it may show, so a button changing its words (Play, Pause, Resume)
/// moves nothing beside it.
struct SteadyLabel: View {
  let title: String
  let systemImage: String
  /// Every title and icon it may show.
  let alternatives: [(title: String, systemImage: String)]

  init(_ title: String, systemImage: String, among alternatives: [(title: String, systemImage: String)]) {
    self.title = title
    self.systemImage = systemImage
    self.alternatives = alternatives
  }

  var body: some View {
    ZStack {
      ForEach(alternatives.indices, id: \.self) { index in
        Label(alternatives[index].title, systemImage: alternatives[index].systemImage).hidden()
      }
      Label(title, systemImage: systemImage)
    }
  }
}
