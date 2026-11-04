// Writes a copy of a PNG without transparency, in the same colours: App Store Connect refuses screenshots
// with an alpha channel, and XCUITest's screenshots have one. Run by scripts/screenshots.mjs:
//   swift scripts/flatten-png.swift in.png out.png
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count == 3,
      let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: args[1]) as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
      let space = image.colorSpace ?? CGColorSpace(name: CGColorSpace.sRGB),
      let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0,
                              space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
else {
  FileHandle.standardError.write(Data("usage: swift flatten-png.swift in.png out.png (in.png must be an image)\n".utf8))
  exit(1)
}
let all = CGRect(x: 0, y: 0, width: image.width, height: image.height)
context.setFillColor(CGColor(gray: 0, alpha: 1))
context.fill(all)
context.draw(image, in: all)
guard let flat = context.makeImage(),
      let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: args[2]) as CFURL, UTType.png.identifier as CFString, 1, nil)
else { exit(1) }
CGImageDestinationAddImage(destination, flat, nil)
exit(CGImageDestinationFinalize(destination) ? 0 : 1)
