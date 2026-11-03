#if canImport(UIKit)
  import UIKit
#else
  import AppKit
#endif

/// Copies text for pasting elsewhere (a file's path).
enum Pasteboard {
  @MainActor static func copy(_ text: String) {
    #if canImport(UIKit)
      UIPasteboard.general.string = text
    #else
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(text, forType: .string)
    #endif
  }
}
