import SwiftUI

/// A colour as red, green and blue from 0 to 1 (sRGB).
public struct RGB: Hashable, Sendable {
  public var r: Double
  public var g: Double
  public var b: Double

  public init(r: Double, g: Double, b: Double) {
    self.r = r
    self.g = g
    self.b = b
  }

  /// `0xff7a1a`.
  public init(hex: UInt32) {
    self.init(r: Double((hex >> 16) & 0xff) / 255, g: Double((hex >> 8) & 0xff) / 255, b: Double(hex & 0xff) / 255)
  }

  public var color: Color { Color(.sRGB, red: r, green: g, blue: b) }

  /// Relative luminance (WCAG): 0 for black, 1 for white.
  public var luminance: Double {
    func linear(_ c: Double) -> Double { c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
    return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
  }
}
