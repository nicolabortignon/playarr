// Draws the TV app's pictures from the web icon's shapes (three faint rings, the orange disc with its hole) and the
// name in Gloock, on Playarr's ink: Google Play's icon (512×512), feature graphic (1024×500) and TV banner (1280×720)
// into store/en-US/images/, and the launcher's banner (160×90 at mdpi up to 640×360 at xxxhdpi for 4K screens; TVs are
// xhdpi, 320×180), which Android TV wants with the app's name on it.
//   swift scripts/store-images.swift            (from apps/tv; make store-images)
import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let fonts = root.appending(path: "app/src/main/res/font")

func color(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
  CGColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
}

// docs/design.md's palette.
let ink = color(0x0F0E0C)
let paper = color(0xECE6DC)
let paperDim = color(0xB8B0A3)
let accent = color(0xFF7A1A)

func font(_ file: String, size: CGFloat) -> CTFont {
  guard let provider = CGDataProvider(url: fonts.appending(path: file) as CFURL), let graphics = CGFont(provider) else {
    FileHandle.standardError.write(Data("Can't read \(file) in \(fonts.path)\n".utf8))
    exit(1)
  }
  return CTFontCreateWithGraphicsFont(graphics, size, nil, nil)
}

func line(_ text: String, _ font: CTFont, _ color: CGColor) -> CTLine {
  let attributes: [NSAttributedString.Key: Any] = [NSAttributedString.Key(kCTFontAttributeName as String): font, NSAttributedString.Key(kCTForegroundColorAttributeName as String): color]
  return CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attributes))
}

func width(_ line: CTLine) -> CGFloat { CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil)) }

/// The mark at `centre`, `size` the outer ring's radius: the launcher icon's proportions (rings 25, 20 and 15.5, the
/// disc 9.5 and its hole 1.5, on the outer ring's 25).
func mark(_ c: CGContext, centre: CGPoint, size r: CGFloat) {
  let line = max(1, r / 50)
  for (radius, alpha) in [(r, 0.14), (r * 0.8, 0.10), (r * 0.62, 0.08)] {
    c.setStrokeColor(color(0xECE6DC, alpha))
    c.setLineWidth(line)
    c.strokeEllipse(in: CGRect(x: centre.x - radius, y: centre.y - radius, width: radius * 2, height: radius * 2))
  }
  let disc = r * 0.38
  c.setFillColor(accent)
  c.fillEllipse(in: CGRect(x: centre.x - disc, y: centre.y - disc, width: disc * 2, height: disc * 2))
  let hole = r * 0.06
  c.setFillColor(ink)
  c.fillEllipse(in: CGRect(x: centre.x - hole, y: centre.y - hole, width: hole * 2, height: hole * 2))
}

/// The mark beside "Playarr" (and a line under it), the two centred together.
func lockup(_ c: CGContext, width w: CGFloat, height h: CGFloat, tagline: String?) {
  let r = h * (tagline == nil ? 0.30 : 0.26)
  let name = line("Playarr", font("gloock.ttf", size: h * (tagline == nil ? 0.24 : 0.2)), paper)
  let under = tagline.map { line($0, font("schibsted_grotesk.ttf", size: h * 0.052), paperDim) }
  let gap = r * 0.55
  let textWidth = max(width(name), under.map(width) ?? 0)
  let left = (w - (r * 2 + gap + textWidth)) / 2
  mark(c, centre: CGPoint(x: left + r, y: h / 2), size: r)
  let x = left + r * 2 + gap
  // CoreGraphics' y goes up: the name sits a little above the middle, the line under it.
  c.textPosition = CGPoint(x: x, y: h / 2 - (under == nil ? h * 0.08 : h * 0.02))
  CTLineDraw(name, c)
  if let under {
    c.textPosition = CGPoint(x: x + h * 0.005, y: h / 2 - h * 0.13)
    CTLineDraw(under, c)
  }
}

func write(_ path: String, width w: Int, height h: Int, draw: (CGContext) -> Void) {
  let space = CGColorSpace(name: CGColorSpace.sRGB)!
  // No alpha: Play refuses transparent feature graphics, and none of these needs it.
  guard let c = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { exit(1) }
  c.setFillColor(ink)
  c.fill(CGRect(x: 0, y: 0, width: w, height: h))
  c.setShouldAntialias(true)
  c.setShouldSmoothFonts(true)
  draw(c)
  let url = root.appending(path: path)
  try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
  guard let image = c.makeImage(), let out = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else { exit(1) }
  CGImageDestinationAddImage(out, image, nil)
  guard CGImageDestinationFinalize(out) else { exit(1) }
  print("\(path) (\(w)×\(h))")
}

write("store/en-US/images/icon.png", width: 512, height: 512) { mark($0, centre: CGPoint(x: 256, y: 256), size: 168) }
write("store/en-US/images/feature-graphic.png", width: 1024, height: 500) {
  lockup($0, width: 1024, height: 500, tagline: "Your music server, on the big screen")
}
write("store/en-US/images/tv-banner.png", width: 1280, height: 720) { lockup($0, width: 1280, height: 720, tagline: nil) }
for (density, scale) in [("mdpi", 1.0), ("hdpi", 1.5), ("xhdpi", 2.0), ("xxhdpi", 3.0), ("xxxhdpi", 4.0)] {
  let w = Int(160 * scale), h = Int(90 * scale)
  write("app/src/main/res/drawable-\(density)/banner.png", width: w, height: h) {
    lockup($0, width: CGFloat(w), height: CGFloat(h), tagline: nil)
  }
}
