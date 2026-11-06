import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers
@testable import PlayarrUI

@Suite struct AccentColorTests {
  /// 32×32 pixels: `count` of `color`, the rest `rest`.
  func pixels(_ color: (UInt8, UInt8, UInt8), count: Int = 1024, rest: (UInt8, UInt8, UInt8) = (0, 0, 0)) -> [UInt8] {
    (0..<1024).flatMap { i -> [UInt8] in
      let c = i < count ? color : rest
      return [c.0, c.1, c.2, 255]
    }
  }

  @Test func clampsAVividColourForADarkScreen() {
    // Pure red: hue 0, saturation 1 → clamped to 90 %, lightness 0.5 → 56 %.
    #expect(AccentColor.extract(rgba: pixels((255, 0, 0))) == .init(h: 0, s: 90, l: 56))
  }

  @Test func liftsAColourTooDarkToRead() {
    // Pure blue at 56 % is a luminance of 0.09: black on it, and it on black, read at under 3:1. At 70 % both clear 4.5:1.
    let blue = AccentColor.extract(rgba: pixels((0, 0, 255)))
    #expect(blue == .init(h: 240, s: 90, l: 70))
    #expect((blue?.rgb.luminance ?? 0) >= 0.2)
    #expect(AccentColor.HSL(h: 240, s: 90, l: 69).rgb.luminance < 0.2)
  }

  @Test @MainActor func liftsTheAccentAgainForTheRowsOfASystemList() {
    // Lifted for the page, the blue reads 3.5:1 on a sheet's row: there it goes up to 76 %, the same hue.
    let blue = AccentColor.HSL(h: 240, s: 90, l: 70).rgb
    #expect(blue.contrast(with: Theme.listRow) < 4.5)
    let lifted = AccentColor.legible(blue, on: Theme.listRow)
    #expect(lifted == AccentColor.HSL(h: 240, s: 90, l: 76).rgb)
    #expect(lifted.contrast(with: Theme.listRow) >= 4.5)
    #expect(lifted.contrast(with: RGB(hex: 0x1c1c1e)) >= 4.5)
    // Playarr's orange reads there already (6.5:1 on a page's row) and stays as it is.
    #expect(AccentColor.legible(Theme.defaultAccent, on: Theme.listRow) == Theme.defaultAccent)
  }

  @Test @MainActor func measuresContrastBothWaysRound() {
    #expect(abs(RGB(hex: 0x000000).contrast(with: RGB(hex: 0xffffff)) - 21) < 0.001)
    #expect(RGB(hex: 0xffffff).contrast(with: RGB(hex: 0x000000)) == RGB(hex: 0x000000).contrast(with: RGB(hex: 0xffffff)))
    #expect(Theme.defaultAccent.contrast(with: Theme.defaultAccent) == 1)
  }

  @Test func aGrayCoverGivesNoAccentRatherThanADustyRed() {
    #expect(AccentColor.extract(rgba: pixels((128, 128, 128))) == nil)
  }

  @Test func ignoresNearBlackAndNearWhite() {
    #expect(AccentColor.extract(rgba: pixels((0, 0, 0))) == nil)
    #expect(AccentColor.extract(rgba: pixels((250, 250, 250))) == nil)
  }

  @Test func theMostColorfulHueWinsOverMoreGray() {
    // A quarter of the cover is teal; the rest is mid gray, which has no hue to vote for.
    let mixed = pixels((0, 160, 160), count: 256, rest: (128, 128, 128))
    #expect(AccentColor.extract(rgba: mixed)?.h == 180)
  }

  @Test func needsEnoughColourToChoose() {
    // Two dark-ish blue pixels weigh less than the 0.5 the web asks for.
    #expect(AccentColor.extract(rgba: pixels((10, 10, 60), count: 2, rest: (0, 0, 0))) == nil)
  }

  @Test func turnsHSLIntoRGB() {
    let rgb = AccentColor.HSL(h: 0, s: 90, l: 56).rgb
    #expect(abs(rgb.r - 0.956) < 0.001)
    #expect(abs(rgb.g - 0.164) < 0.001)
    #expect(abs(rgb.b - 0.164) < 0.001)
  }

  @Test func readsAnImageFile() throws {
    let data = try png(width: 64, height: 64, rgb: (40, 200, 90))
    let accent = try #require(AccentColor.extract(imageData: data))
    #expect((130...145).contains(accent.h))
  }

  @Test func turnsOKLCHIntoRGB() {
    // oklch(62.8% 0.2577 29.23) is sRGB red.
    let red = OKLCH.rgb(l: 0.628, c: 0.2577, h: 29.23)
    #expect(abs(red.r - 1) < 0.01 && red.g < 0.02 && red.b < 0.02)
  }

  func png(width: Int, height: Int, rgb: (UInt8, UInt8, UInt8)) throws -> Data {
    var bytes = [UInt8](repeating: 255, count: width * height * 4)
    for i in stride(from: 0, to: bytes.count, by: 4) { (bytes[i], bytes[i + 1], bytes[i + 2]) = rgb }
    let space = try #require(CGColorSpace(name: CGColorSpace.sRGB))
    let context = try #require(CGContext(data: &bytes, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
    let image = try #require(context.makeImage())
    let out = NSMutableData()
    let destination = try #require(CGImageDestinationCreateWithData(out, UTType.png.identifier as CFString, 1, nil))
    CGImageDestinationAddImage(destination, image, nil)
    #expect(CGImageDestinationFinalize(destination))
    return out as Data
  }
}
