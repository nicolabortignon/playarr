import Foundation

/// CSS `oklch(l c h)` to sRGB, for mix covers: the server gives each mix a hue (apps/web/src/components/Mixes.tsx).
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

  /// Linear light to sRGB, clipped to what a screen shows.
  static func gamma(_ x: Double) -> Double {
    let v = x <= 0.0031308 ? 12.92 * x : 1.055 * pow(x, 1 / 2.4) - 0.055
    return min(1, max(0, v))
  }
}
