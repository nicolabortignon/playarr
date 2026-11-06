import SwiftUI

/// What the app asks before losing something for good (docs/design.md, "Taking things back"; the web's
/// `ConfirmDialog`): the question names what goes ("Remove Sam?", "Remove 312 songs from this device?"), the words
/// under it say what goes and what stays, Cancel keeps it, and the danger verb goes ahead ("Delete", "Remove", "Sign
/// out"). Taking something out of a list doesn't ask: it happens at once, with Undo.
struct LossQuestion: Equatable, Sendable {
  let title: String
  /// What goes, and what stays.
  let message: String
  /// The danger verb.
  let verb: String
}

extension View {
  /// Asks `question` while `isPresented`; its verb runs `perform`.
  func confirmLoss(_ question: LossQuestion?, isPresented: Binding<Bool>, perform: @escaping @MainActor () -> Void) -> some View {
    confirmationDialog(question?.title ?? "", isPresented: isPresented, titleVisibility: .visible) {
      Button(question?.verb ?? "", role: .destructive, action: perform)
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(question?.message ?? "")
    }
  }

  /// Asks about `item` while there is one (the device, the account, the source to remove); its verb runs `perform`
  /// with it.
  func confirmLoss<Item>(
    _ item: Binding<Item?>, question: @escaping (Item) -> LossQuestion, perform: @escaping @MainActor (Item) -> Void
  ) -> some View {
    let shown = item.wrappedValue.map(question)
    return confirmationDialog(
      shown?.title ?? "", isPresented: Binding(get: { item.wrappedValue != nil }, set: { if !$0 { item.wrappedValue = nil } }),
      titleVisibility: .visible, presenting: item.wrappedValue
    ) { value in
      Button(question(value).verb, role: .destructive) { perform(value) }
      Button("Cancel", role: .cancel) {}
    } message: { value in
      Text(question(value).message)
    }
  }
}
