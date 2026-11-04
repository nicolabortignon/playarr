// Draws the app icon's dark and tinted variants (iOS 18 and later let people pick them on the Home Screen) from the
// same shapes as AppIcon.png: three thin rings and the orange label with its hole, on a 1024-point square.
//   swift scripts/make-icons.swift Playarr/Assets.xcassets/AppIcon.appiconset
// Writes AppIcon-Dark.png (no background: the system puts its own dark one behind it) and AppIcon-Tinted.png
// (grey levels on black: the system colours it with the tint people choose).
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let size = 1024
let centre = CGPoint(x: 512, y: 512)
// From AppIcon.png: rings at radii 336, 272 and 208, 4 points wide; the label 128 across its radius, its hole 20.
let rings: [(radius: CGFloat, gray: CGFloat)] = [(336, 0.18), (272, 0.145), (208, 0.13)]

struct Variant {
  let file: String
  let background: CGColor?
  let ringBoost: CGFloat
  let label: CGColor
  let hole: CGColor?
}

let orange = CGColor(srgbRed: 1, green: 122 / 255, blue: 26 / 255, alpha: 1)
let variants = [
  Variant(file: "AppIcon-Dark.png", background: nil, ringBoost: 1.6, label: orange, hole: nil),
  Variant(file: "AppIcon-Tinted.png", background: CGColor(gray: 0, alpha: 1), ringBoost: 2.2, label: CGColor(gray: 1, alpha: 1), hole: CGColor(gray: 0, alpha: 1)),
]

guard CommandLine.arguments.count == 2 else {
  FileHandle.standardError.write(Data("usage: swift make-icons.swift <AppIcon.appiconset folder>\n".utf8))
  exit(1)
}
let folder = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)

for variant in variants {
  let space = CGColorSpace(name: CGColorSpace.sRGB)!
  let alpha = variant.background == nil ? CGImageAlphaInfo.premultipliedLast : CGImageAlphaInfo.noneSkipLast
  guard let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: alpha.rawValue) else { exit(1) }
  if let background = variant.background {
    context.setFillColor(background)
    context.fill(CGRect(x: 0, y: 0, width: size, height: size))
  }
  context.setLineWidth(4)
  for ring in rings {
    context.setStrokeColor(CGColor(gray: min(1, ring.gray * variant.ringBoost), alpha: 1))
    context.strokeEllipse(in: CGRect(x: centre.x - ring.radius, y: centre.y - ring.radius, width: ring.radius * 2, height: ring.radius * 2))
  }
  context.setFillColor(variant.label)
  context.fillEllipse(in: CGRect(x: centre.x - 128, y: centre.y - 128, width: 256, height: 256))
  let hole = CGRect(x: centre.x - 20, y: centre.y - 20, width: 40, height: 40)
  if let colour = variant.hole {
    context.setFillColor(colour)
    context.fillEllipse(in: hole)
  } else {
    context.setBlendMode(.clear)
    context.fillEllipse(in: hole)
    context.setBlendMode(.normal)
  }
  guard let image = context.makeImage(),
    let destination = CGImageDestinationCreateWithURL(folder.appending(path: variant.file) as CFURL, UTType.png.identifier as CFString, 1, nil)
  else { exit(1) }
  CGImageDestinationAddImage(destination, image, nil)
  guard CGImageDestinationFinalize(destination) else { exit(1) }
  print("wrote \(variant.file)")
}
