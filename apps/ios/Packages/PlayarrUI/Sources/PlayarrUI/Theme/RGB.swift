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
}
