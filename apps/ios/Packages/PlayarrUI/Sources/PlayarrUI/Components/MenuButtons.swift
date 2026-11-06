import SwiftUI

/// A menu's groups as buttons, with a line between each group: inside a `Menu` or a `.contextMenu`. In VoiceOver's
/// actions (`.accessibilityActions`), without the lines.
struct MenuButtons: View {
  let groups: [[MenuAction]]
  var divided = true

  var body: some View {
    let shown = groups.filter { !$0.isEmpty }
    ForEach(shown.indices, id: \.self) { index in
      if divided, index > 0 { Divider() }
      ForEach(shown[index]) { item in
        Button(item.title, systemImage: item.systemImage, role: item.destructive ? .destructive : nil, action: item.perform)
      }
    }
  }
}

/// A row's ⋯: its menu, 44 points to tap, named "More for {title}" for VoiceOver.
struct MoreMenu: View {
  let title: String
  let groups: [[MenuAction]]

  var body: some View {
    Menu {
      MenuButtons(groups: groups)
    } label: {
      Image(systemName: "ellipsis")
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .foregroundStyle(.paperDim)
    .pointerHover()
    .accessibilityLabel("More for \(title)")
  }
}
