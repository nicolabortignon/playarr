import CoreGraphics
import Foundation
import ImageIO

/// The accent colour taken from album art, as apps/web/src/lib/color.ts does it: the cover drawn at 32×32, its
/// pixels sorted into 12 hue bins weighted by saturation and mid-lightness (near-black and near-white dropped),
/// the heaviest bin's average hue, with saturation clamped to 45–90 % and lightness to 56–68 %, then raised where the
/// colour is too dark to read (`legible`).
public enum AccentColor {
  /// A colour as hue (degrees), saturation and lightness (percent), rounded as the web's `hsl()` string.
  public struct HSL: Hashable, Sendable {
    public var h: Int
    public var s: Int
    public var l: Int

    public init(h: Int, s: Int, l: Int) {
      self.h = h
      self.s = s
      self.l = l
    }

    public var rgb: RGB {
      let s = Double(self.s) / 100
      let l = Double(self.l) / 100
      let c = (1 - abs(2 * l - 1)) * s
      let hue = Double(h).truncatingRemainder(dividingBy: 360) / 60
      let x = c * (1 - abs(hue.truncatingRemainder(dividingBy: 2) - 1))
      let (r, g, b): (Double, Double, Double) =
        switch hue {
        case ..<1: (c, x, 0)
        case ..<2: (x, c, 0)
        case ..<3: (0, c, x)
        case ..<4: (0, x, c)
        case ..<5: (x, 0, c)
        default: (c, 0, x)
        }
      let m = l - c / 2
      return RGB(r: r + m, g: g + m, b: b + m)
    }
  }

  static let side = 32

  /// The accent of 32×32 RGBA pixels (8 bits each), or nil when nothing in them is colourful enough.
  public static func extract(rgba: [UInt8]) -> HSL? {
    var buckets = [(w: Double, h: Double, s: Double, l: Double)](repeating: (0, 0, 0, 0), count: 12)
    for i in stride(from: 0, to: rgba.count - 3, by: 4) {
      let (h, s, l) = hsl(rgba[i], rgba[i + 1], rgba[i + 2])
      // Favor saturated mid-tones; ignore near-black and near-white pixels.
      let weight = s * s * (1 - abs(l - 0.5) * 2) + 0.001
      if l < 0.08 || l > 0.95 { continue }
      // A gray pixel has no hue to vote for (`hsl` calls it red), or a gray cover would get a dusty red accent. As the
      // web's `accentOf` and the server's `coverAccent`.
      if s == 0 { continue }
      let b = Int((h * 12).rounded(.down)) % 12
      buckets[b].w += weight
      buckets[b].h += h * weight
      buckets[b].s += s * weight
      buckets[b].l += l * weight
    }
    let best = buckets.reduce(buckets[0]) { $1.w > $0.w ? $1 : $0 }
    guard best.w >= 0.5 else { return nil }
    let h = best.h / best.w
    let s = min(0.9, max(0.45, best.s / best.w))
    let l = min(0.68, max(0.56, best.l / best.w))
    return legible(HSL(h: Int((h * 360).rounded()), s: Int((s * 100).rounded()), l: Int((l * 100).rounded())))
  }

  /// The accent's ink is near black, and the accent is also text on the near-black app: below a relative luminance of
  /// 0.2 (blues, purples, deep reds) one of the two falls under 4.5:1, so the lightness goes up a percent at a time
  /// until it's there. As the web's `legibleLightness`.
  static func legible(_ color: HSL) -> HSL {
    var color = color
    while color.rgb.luminance < 0.2, color.l < 95 { color.l += 1 }
    return color
  }

  /// The accent as text on something lighter than the page (a system list's rows, `Theme.listAccent`): its lightness
  /// raised a percent at a time, as `legible` does for the page, until it reads 4.5:1 on `surface`. Unchanged when it
  /// reads there already.
  public static func legible(_ color: RGB, on surface: RGB) -> RGB {
    guard color.contrast(with: surface) < 4.5 else { return color }
    func byte(_ c: Double) -> UInt8 { UInt8((min(1, max(0, c)) * 255).rounded()) }
    let (h, s, l) = hsl(byte(color.r), byte(color.g), byte(color.b))
    var lifted = HSL(h: Int((h * 360).rounded()), s: Int((s * 100).rounded()), l: Int((l * 100).rounded()))
    while lifted.rgb.contrast(with: surface) < 4.5, lifted.l < 95 { lifted.l += 1 }
    return lifted.rgb
  }

  /// The accent of an image (JPEG, PNG or WebP bytes), drawn at 32×32 as the web draws it on a canvas.
  public static func extract(imageData: Data) -> HSL? {
    guard let source = CGImageSourceCreateWithData(imageData as CFData, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
      let space = CGColorSpace(name: CGColorSpace.sRGB)
    else { return nil }
    var pixels = [UInt8](repeating: 0, count: side * side * 4)
    let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
      guard let context = CGContext(
        data: buffer.baseAddress, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side * 4, space: space,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
      else { return false }
      context.interpolationQuality = .medium
      context.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))
      return true
    }
    return drawn ? extract(rgba: pixels) : nil
  }

  /// Hue (0–1), saturation and lightness of an 8-bit colour, as the web's `rgbToHsl`.
  static func hsl(_ r8: UInt8, _ g8: UInt8, _ b8: UInt8) -> (Double, Double, Double) {
    let r = Double(r8) / 255
    let g = Double(g8) / 255
    let b = Double(b8) / 255
    let high = max(r, g, b)
    let low = min(r, g, b)
    let l = (high + low) / 2
    if high == low { return (0, 0, l) }
    let d = high - low
    let s = l > 0.5 ? d / (2 - high - low) : d / (high + low)
    let h: Double =
      if high == r { (g - b) / d + (g < b ? 6 : 0) } else if high == g { (b - r) / d + 2 } else { (r - g) / d + 4 }
    return (h / 6, s, l)
  }
}
