import SwiftUI

/// The toasts at the top of the screen (apps/web/src/components/Toasts.tsx). VoiceOver reads each one out, and offers
/// Dismiss on it (or the escape gesture); an Undo waits while VoiceOver or the pointer is on it. Buttons take 44 points.
struct ToastsView: View {
  @Environment(ToastCenter.self) private var center
  /// Which toast VoiceOver is on, and on which part of it.
  @AccessibilityFocusState private var focus: Focus?

  private struct Focus: Hashable {
    let id: Int
    let part: Int
  }

  var body: some View {
    VStack(spacing: 8) {
      ForEach(center.toasts) { toast in
        HStack(spacing: 8) {
          Text(toast.message)
            .typeRole(.body)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, toast.action == nil ? 12 : 6)
            .dismissible { center.dismiss(toast.id) }
            .accessibilityFocused($focus, equals: Focus(id: toast.id, part: 0))
          if let action = toast.action {
            Button(action.label) { center.perform(toast) }
              .buttonStyle(.pill(.primary, size: .small))
              .dismissible { center.dismiss(toast.id) }
              .accessibilityFocused($focus, equals: Focus(id: toast.id, part: 1))
            // Something that waits for an answer (a new version to load) can be put off; an Undo goes by itself.
            if toast.timeout == nil {
              Button("Later") { center.dismiss(toast.id) }
                .buttonStyle(.pill(.ghost, size: .small))
                .accessibilityFocused($focus, equals: Focus(id: toast.id, part: 2))
            }
          }
        }
        .padding(.leading, 16)
        .padding(.trailing, toast.action == nil ? 16 : 6)
        .fixedSize(horizontal: false, vertical: true)
        .background(.regularMaterial, in: shape)
        .overlay(shape.stroke(toast.tone == .error ? Color.danger.opacity(0.4) : Color.paper.opacity(0.15)))
        .foregroundStyle(toast.tone == .error ? Color.danger : Color.paper)
        .contentShape(shape)
        .onTapGesture { if toast.action == nil { center.dismiss(toast.id) } }
        .onHover { inside in center.hold(toast.id, inside) }
        .transition(.move(edge: .top).combined(with: .opacity))
        .sensoryFeedback(Haptic.toast(isError: toast.tone == .error), trigger: toast.id)
      }
    }
    .padding(.horizontal, 16)
    .animation(.spring(duration: 0.3), value: center.toasts.map(\.id))
    .onChange(of: center.toasts.last?.id) { _, _ in
      if let message = center.toasts.last?.message { AccessibilityNotification.Announcement(message).post() }
    }
    // VoiceOver on a toast holds its Undo; moving on lets its time start over.
    .onChange(of: focus?.id) { before, now in
      if let before { center.hold(before, false) }
      if let now { center.hold(now, true) }
    }
  }

  private var shape: Capsule { Capsule() }
}

private extension View {
  /// VoiceOver's Dismiss action, and its escape gesture (two fingers drawing a Z), on each part of a toast.
  func dismissible(_ dismiss: @escaping () -> Void) -> some View {
    accessibilityAction(named: "Dismiss", dismiss)
      .accessibilityAction(.escape, dismiss)
  }
}
