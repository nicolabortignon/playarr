import SwiftUI

/// The toasts at the top of the screen (apps/web/src/components/Toasts.tsx). VoiceOver reads each one out.
struct ToastsView: View {
  @Environment(ToastCenter.self) private var center
  @Environment(Theme.self) private var theme

  var body: some View {
    VStack(spacing: 8) {
      ForEach(center.toasts) { toast in
        HStack(spacing: 12) {
          Text(toast.message).font(.sans(.subheadline))
          if let action = toast.action {
            Spacer(minLength: 8)
            Button(action.label) { center.perform(toast) }.foregroundStyle(theme.accent.color)
            Button("Later") { center.dismiss(toast.id) }.foregroundStyle(.secondary)
          }
        }
        .font(.sans(.caption).weight(.semibold))
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.regularMaterial, in: Capsule())
        .overlay(Capsule().stroke(toast.tone == .error ? Color.red.opacity(0.4) : Color.secondary.opacity(0.2)))
        .foregroundStyle(toast.tone == .error ? Color.red : Color.primary)
        .onTapGesture { if toast.action == nil { center.dismiss(toast.id) } }
        .transition(.move(edge: .top).combined(with: .opacity))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isStaticText)
        .sensoryFeedback(toast.tone == .error ? .error : .success, trigger: toast.id)
      }
    }
    .padding(.horizontal, 16)
    .animation(.spring(duration: 0.3), value: center.toasts.map(\.id))
    .onChange(of: center.toasts.last?.id) { _, _ in
      if let message = center.toasts.last?.message { AccessibilityNotification.Announcement(message).post() }
    }
  }
}
