import Foundation

/// CSS `oklch(l c h)` to sRGB and back to a hue, for mix covers: the server gives each mix a hue, or the covers do
/// (apps/web/src/components/Mixes.tsx).
public enum OKLCH {
  public static func rgb(l: Double, c: Double, h: Double) -> RGB {
    let a = c * cos(h * .pi / 180)
    let b = c * sin(h * .pi / 180)
    let l1 = pow(l + 0.3963377774 * a + 0.2158037573 * b, 3)
    let m1 = pow(l - 0.1055613458 * a - 0.0638541728 * b, 3)
    let s1 = pow(l - 0.0894841775 * a - 1.2914855480 * b, 3)
    let red = 4.0767416621 * l1 - 3.3077115913 * m1 + 0.2309699292 * s1
    let green = -1.2684380046 * l1 + 2.6097574011 * m1 - 0.3413193965 * s1
    let blue = -0.0041960863 * l1 - 0.7034186147 * m1 + 1.7076147010 * s1
    return RGB(r: gamma(red), g: gamma(green), b: gamma(blue))
  }

  /// The OKLCH hue (degrees) of an sRGB colour, as the web's `oklchHue`.
  public static func hue(of rgb: RGB) -> Double {
    func linear(_ v: Double) -> Double { v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
    let (r, g, b) = (linear(rgb.r), linear(rgb.g), linear(rgb.b))
    let l = cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
    let m = cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
    let s = cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
    let a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
    let bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
    return (atan2(bb, a) * 180 / .pi + 360).truncatingRemainder(dividingBy: 360)
  }

  /// Linear light to sRGB, clipped to what a screen shows.
  static func gamma(_ x: Double) -> Double {
    let v = x <= 0.0031308 ? 12.92 * x : 1.055 * pow(x, 1 / 2.4) - 0.055
    return min(1, max(0, v))
  }
}
