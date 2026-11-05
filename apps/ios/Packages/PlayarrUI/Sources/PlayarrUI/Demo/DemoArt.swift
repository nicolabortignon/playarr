import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Artwork for the demo library, which has no server to ask: each cover and artist photo is drawn from its address
/// (abstract, a palette and a shape of its own), so screenshots and UI tests show pictures, not the stand-ins for
/// missing art. The demo's image cache fetches through `session`.
enum DemoArt {
  static let session: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [DemoArtProtocol.self]
    return URLSession(configuration: configuration)
  }()

  /// A PNG for an `/art/…` address, as wide as its `size` asks (480 without one). Screenshots of the main views
  /// (`make screens`, on this Mac only) use the albums' real covers instead, from the folder in PLAYARR_DEMO_COVERS.
  static func png(for url: URL) -> Data? {
    guard url.path.contains("/art/") else { return nil }
    if let covers = ProcessInfo.processInfo.environment["PLAYARR_DEMO_COVERS"],
      let id = url.path.firstMatch(of: /\/art\/album\/(\d+)\/cover/)?.1,
      let real = try? Data(contentsOf: URL(filePath: covers).appending(path: "\(id).jpg"))
    {
      return real
    }
    let asked = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "size" }?.value
    let side = min(max(Int(asked ?? "") ?? 480, 32), 1200)
    var seed = fnv(url.path)
    let random = { () -> Double in
      seed = seed &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
      return Double(seed >> 11) / Double(1 << 53)
    }
    guard
      let context = CGContext(
        data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return nil }
    let size = CGFloat(side)
    let hue = random()
    let back = [color(hue, 0.55, 0.22), color(hue + 0.08 + random() * 0.1, 0.65, 0.42)]
    let gradient = CGGradient(colorsSpace: nil, colors: back as CFArray, locations: [0, 1])!
    context.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: size, y: size), options: [])
    let accent = color(hue + 0.45 + random() * 0.15, 0.75, 0.92)
    let light = color(hue + 0.1, 0.25, 0.95, alpha: 0.85)
    if url.path.contains("/artist/") {
      // A figure against a soft light: head and shoulders.
      context.setFillColor(color(hue, 0.4, 0.75, alpha: 0.35))
      context.fillEllipse(in: CGRect(x: size * 0.1, y: size * 0.1, width: size * 0.8, height: size * 0.8))
      context.setFillColor(color(hue, 0.6, 0.12))
      context.fillEllipse(in: CGRect(x: size * 0.36, y: size * 0.42, width: size * 0.28, height: size * 0.32))
      context.fillEllipse(in: CGRect(x: size * 0.18, y: -size * 0.25, width: size * 0.64, height: size * 0.6))
    } else {
      switch Int(random() * 3) {
      case 0:
        // A sun and its moon.
        let r = size * (0.22 + random() * 0.12)
        context.setFillColor(accent)
        context.fillEllipse(in: CGRect(x: size * (0.2 + random() * 0.3), y: size * (0.25 + random() * 0.3), width: r * 2, height: r * 2))
        context.setFillColor(light)
        context.fillEllipse(in: CGRect(x: size * (0.15 + random() * 0.5), y: size * (0.1 + random() * 0.5), width: r * 0.7, height: r * 0.7))
      case 1:
        // Bands across.
        context.setFillColor(accent)
        let bands = 3 + Int(random() * 4)
        for i in 0..<bands where i % 2 == 0 {
          let y = size * CGFloat(i) / CGFloat(bands)
          context.fill(CGRect(x: 0, y: y, width: size, height: size / CGFloat(bands) * 0.8))
        }
        context.setFillColor(light)
        context.fill(CGRect(x: size * (0.1 + random() * 0.5), y: 0, width: size * 0.06, height: size))
      default:
        // Rings from a point.
        let centre = CGPoint(x: size * (0.3 + random() * 0.4), y: size * (0.3 + random() * 0.4))
        context.setLineWidth(size * 0.035)
        for i in stride(from: 6, through: 1, by: -1) {
          context.setStrokeColor(i % 2 == 0 ? accent : light)
          let r = size * 0.09 * CGFloat(i)
          context.strokeEllipse(in: CGRect(x: centre.x - r, y: centre.y - r, width: r * 2, height: r * 2))
        }
      }
    }
    guard let image = context.makeImage() else { return nil }
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else { return nil }
    CGImageDestinationAddImage(destination, image, nil)
    return CGImageDestinationFinalize(destination) ? data as Data : nil
  }

  private static func color(_ hue: Double, _ saturation: Double, _ brightness: Double, alpha: Double = 1) -> CGColor {
    let h = (hue.truncatingRemainder(dividingBy: 1) + 1).truncatingRemainder(dividingBy: 1) * 6
    let c = brightness * saturation
    let x = c * (1 - abs(h.truncatingRemainder(dividingBy: 2) - 1))
    let (r, g, b): (Double, Double, Double) =
      switch Int(h) {
      case 0: (c, x, 0)
      case 1: (x, c, 0)
      case 2: (0, c, x)
      case 3: (0, x, c)
      case 4: (x, 0, c)
      default: (c, 0, x)
      }
    let m = brightness - c
    return CGColor(srgbRed: r + m, green: g + m, blue: b + m, alpha: alpha)
  }

  /// A hash that's the same on every run (Swift's own isn't), so an album keeps its cover.
  private static func fnv(_ text: String) -> UInt64 {
    text.utf8.reduce(14_695_981_039_346_656_037) { ($0 ^ UInt64($1)) &* 1_099_511_628_211 }
  }
}

/// Answers the demo image cache's requests with `DemoArt`.
final class DemoArtProtocol: URLProtocol, @unchecked Sendable {
  override class func canInit(with request: URLRequest) -> Bool { request.url?.path.contains("/art/") == true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    guard let url = request.url, let data = DemoArt.png(for: url),
      let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "image/png"])
    else {
      client?.urlProtocol(self, didFailWithError: URLError(.fileDoesNotExist))
      return
    }
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: data)
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}
}
