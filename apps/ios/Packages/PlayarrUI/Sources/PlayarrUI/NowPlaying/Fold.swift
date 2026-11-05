import SwiftUI

/// How a foldable iPhone (the iPhone Duo) is held, from its hinge. `none`: no hinge, or folded shut (the cover screen is
/// a phone like any other). `flat`: open all the way, one wide screen with the crease down its middle. `half`: part
/// open, propped up like a small laptop (the crease across the screen) or held like a book (the crease down it).
public enum Fold: Equatable, Sendable {
  case none, flat, half

  /// `-UITestsFold flat` or `-UITestsFold half`: the simulator can't open the hinge, so UI tests and screenshots
  /// say how it's held.
  static var forcedForUITests: Fold? {
    let arguments = ProcessInfo.processInfo.arguments
    guard let at = arguments.firstIndex(of: "-UITestsFold"), at + 1 < arguments.count else { return nil }
    switch arguments[at + 1] {
    case "flat": return .flat
    case "half": return .half
    default: return Fold.none
    }
  }
}

extension View {
  /// Keeps `fold` in step with the device's hinge (iOS 27.1 on an iPhone Duo); it stays `.none` everywhere else.
  func tracksFold(_ fold: Binding<Fold>) -> some View { modifier(FoldReader(fold: fold)) }
}

private struct FoldReader: ViewModifier {
  @Binding var fold: Fold

  func body(content: Content) -> some View {
    hinged(content)
      .onAppear { if let forced = Fold.forcedForUITests { fold = forced } }
  }

  @ViewBuilder private func hinged(_ content: Content) -> some View {
    // The hinge came with the iOS 27.1 SDK (Swift 6.4); builds with an older Xcode (CI's) leave it out.
    #if compiler(>=6.4) && os(iOS)
      if #available(iOS 27.1, *), Fold.forcedForUITests == nil {
        content.onHingeChange { _, new in fold = Fold(new.hinge) }
      } else {
        content
      }
    #else
      content
    #endif
  }
}

#if compiler(>=6.4) && os(iOS)
  @available(iOS 27.1, *)
  extension Fold {
    init(_ hinge: DeviceHinge?) {
      switch hinge?.status {
      case .some(.fullyOpen): self = .flat
      case .some(.partiallyOpen): self = .half
      default: self = .none
      }
    }
  }
#endif
