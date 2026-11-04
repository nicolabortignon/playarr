import SwiftUI

extension View {
  /// The iPad pointer's highlight on something that can be clicked (cards, rows, bar buttons); covers are highlighted
  /// too rather than lifted, as the web's stay put under the mouse. Nothing on the Mac, where `swift test` builds this
  /// package.
  func pointerHover() -> some View {
    #if os(iOS)
      hoverEffect(.highlight)
    #else
      self
    #endif
  }
}
