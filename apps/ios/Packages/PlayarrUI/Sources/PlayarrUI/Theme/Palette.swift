import SwiftUI

// The design language's colors, by role, with the web's names (docs/design.md). The web fills a canvas that's all
// Playarr's with warm ink and paper. iOS pages share the screen with the system's menus, sheets, lists and alerts,
// so text takes the system's white, and danger, success and warning its red, green and yellow.

extension ShapeStyle where Self == Color {
  /// Text: titles, row titles, paragraphs.
  public static var paper: Color { .primary }
  /// Hairlines, panel borders and unselected choices. (A secondary button's outline is brighter: paper at 15 %.)
  public static var line: Color { .white.opacity(0.08) }
  /// Errors, and actions that destroy something.
  public static var danger: Color { .red }
  /// Done: downloaded, saved, connected.
  public static var success: Color { .green }
  /// Worth a look before going on.
  public static var warning: Color { .yellow }
}

/// Secondary text (the artist under a title, a description) that gets brighter with Increase Contrast. Playarr is
/// always dark, so it's white at 70 % (readable over a tinted header or a blurred cover), or 85 % with more contrast
/// (the system's `.secondary` doesn't move as far). The web's `paper-dim`.
public struct PaperDim: ShapeStyle {
  public static func opacity(_ contrast: ColorSchemeContrast) -> Double {
    contrast == .increased ? 0.85 : 0.7
  }

  public func resolve(in environment: EnvironmentValues) -> Color {
    Color.white.opacity(Self.opacity(environment.colorSchemeContrast))
  }
}

/// Quieter text (kickers, times, counts, hints): white at 50 %, or 65 % with Increase Contrast. The web's `muted`.
public struct Muted: ShapeStyle {
  public static func opacity(_ contrast: ColorSchemeContrast) -> Double {
    contrast == .increased ? 0.65 : 0.5
  }

  public func resolve(in environment: EnvironmentValues) -> Color {
    Color.white.opacity(Self.opacity(environment.colorSchemeContrast))
  }
}

extension ShapeStyle where Self == PaperDim {
  public static var paperDim: PaperDim { PaperDim() }
}

extension ShapeStyle where Self == Muted {
  public static var muted: Muted { Muted() }
}
