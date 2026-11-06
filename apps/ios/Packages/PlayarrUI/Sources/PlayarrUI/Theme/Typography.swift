import CoreText
import SwiftUI

#if canImport(UIKit)
  import UIKit
#endif

/// The web's fonts (apps/web/src/index.css), bundled in Fonts/: Schibsted Grotesk for text (`--font-sans`), Gloock for
/// titles (`--font-display`: page, album and section titles, empty states) and DM Mono for labels and numbers
/// (`--font-mono`). `Font.sans`, `.display` and `.mono` take the system text styles' sizes and grow with Dynamic Type.
public enum Typography {
  static let sans = "Schibsted Grotesk"
  static let display = "Gloock"
  static let mono = "DM Mono"

  /// Makes the bundled fonts available to this process and puts the navigation bars' titles in them. Once, before the
  /// first screen (later calls do nothing).
  @MainActor public static func register() {
    guard !registered else { return }
    registered = true
    let folder = Bundle.module.url(forResource: "Fonts", withExtension: nil)
    let files = folder.flatMap { try? FileManager.default.contentsOfDirectory(at: $0, includingPropertiesForKeys: nil) } ?? []
    for file in files where file.pathExtension == "ttf" {
      CTFontManagerRegisterFontsForURL(file as CFURL, .process, nil)
    }
    #if canImport(UIKit)
      let bar = UINavigationBar.appearance()
      let appearance = UINavigationBarAppearance()
      if let title = UIFont(name: display, size: size(.largeTitle)) {
        let attributes: [NSAttributedString.Key: Any] = [.font: UIFontMetrics(forTextStyle: .largeTitle).scaledFont(for: title)]
        bar.largeTitleTextAttributes = attributes
        appearance.largeTitleTextAttributes = attributes
      }
      if let title = UIFont(name: sans, size: size(.headline))?.withWeight(.semibold) {
        let attributes: [NSAttributedString.Key: Any] = [.font: UIFontMetrics(forTextStyle: .headline).scaledFont(for: title)]
        bar.titleTextAttributes = attributes
        appearance.titleTextAttributes = attributes
      }
      // The count under a page's title ("128 albums", `pageHeader(_:count:)`): the meta role, DM Mono in `.muted`.
      if let count = UIFont(name: mono, size: size(.caption)) {
        let muted = UIColor { UIColor(white: 1, alpha: Muted.opacity($0.accessibilityContrast == .high ? .increased : .standard)) }
        let attributes: [NSAttributedString.Key: Any] = [.font: UIFontMetrics(forTextStyle: .caption1).scaledFont(for: count), .foregroundColor: muted]
        appearance.subtitleTextAttributes = attributes
        appearance.largeSubtitleTextAttributes = attributes
      }
      // The system's look otherwise; the bar at the scroll edge is drawn from it.
      bar.standardAppearance = appearance
    #endif
  }

  @MainActor private static var registered = false

  /// The system's size for a text style at the default Dynamic Type setting (Large), which `relativeTo:` scales from.
  static func size(_ style: Font.TextStyle) -> CGFloat {
    switch style {
    case .largeTitle: 34
    case .title: 28
    case .title2: 22
    case .title3: 20
    case .headline, .body: 17
    case .callout: 16
    case .subheadline: 15
    case .footnote: 13
    case .caption: 12
    case .caption2: 11
    @unknown default: 17
    }
  }
}

extension Font {
  /// Text: Schibsted Grotesk at a text style's size (semibold for `.headline`, as the system's).
  public static func sans(_ style: Font.TextStyle) -> Font {
    let font = Font.custom(Typography.sans, size: Typography.size(style), relativeTo: style)
    return style == .headline ? font.weight(.semibold) : font
  }

  /// Text at a fixed size, as `.system(size:weight:)`.
  public static func sans(size: CGFloat, weight: Font.Weight = .regular) -> Font {
    .custom(Typography.sans, fixedSize: size).weight(weight)
  }

  /// Titles: Gloock, which has one weight (the web's titles are all in it).
  public static func display(_ style: Font.TextStyle) -> Font {
    .custom(Typography.display, size: Typography.size(style), relativeTo: style)
  }

  public static func display(size: CGFloat) -> Font {
    .custom(Typography.display, fixedSize: size)
  }

  /// Gloock at its own size that still grows with Dynamic Type, as `style` does: Stats' big numbers.
  public static func display(size: CGFloat, relativeTo style: Font.TextStyle) -> Font {
    .custom(Typography.display, size: size, relativeTo: style)
  }

  /// Labels and numbers: DM Mono (regular or medium).
  public static func mono(_ style: Font.TextStyle, weight: Font.Weight = .regular) -> Font {
    let font = Font.custom(Typography.mono, size: Typography.size(style), relativeTo: style)
    // Only when asked: the accessibility audit reads a regular font with a weight applied as not fully following
    // Dynamic Type.
    return weight == .regular ? font : font.weight(weight)
  }

  /// Labels at their own size that still grow with Dynamic Type, as `style` does.
  public static func mono(size: CGFloat, relativeTo style: Font.TextStyle, weight: Font.Weight = .regular) -> Font {
    let font = Font.custom(Typography.mono, size: size, relativeTo: style)
    return weight == .regular ? font : font.weight(weight)
  }

  public static func mono(size: CGFloat, weight: Font.Weight = .regular) -> Font {
    .custom(Typography.mono, fixedSize: size).weight(weight)
  }
}

#if canImport(UIKit)
  extension UIFont {
    /// The same family at another weight (a variable font's named instance).
    fileprivate func withWeight(_ weight: UIFont.Weight) -> UIFont {
      let descriptor = fontDescriptor.addingAttributes([.traits: [UIFontDescriptor.TraitKey.weight: weight]])
      return UIFont(descriptor: descriptor, size: pointSize)
    }
  }
#endif
