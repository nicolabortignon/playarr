import SwiftUI

/// Secondary text (artists, times, counts) that gets brighter with Increase Contrast. Playarr is always dark, so
/// it's white at 70 % (readable over a tinted header or a blurred cover), or 85 % with more contrast (the system's
/// `.secondary` doesn't move as far).
public struct Muted: ShapeStyle {
  public static func opacity(_ contrast: ColorSchemeContrast) -> Double {
    contrast == .increased ? 0.85 : 0.7
  }

  public func resolve(in environment: EnvironmentValues) -> Color {
    Color.white.opacity(Self.opacity(environment.colorSchemeContrast))
  }
}

extension ShapeStyle where Self == Muted {
  public static var muted: Muted { Muted() }
}
