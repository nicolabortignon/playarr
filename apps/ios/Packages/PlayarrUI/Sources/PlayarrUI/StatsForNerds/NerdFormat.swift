import Foundation
import PlayarrAPI

/// Numbers as Stats for nerds and the transition sheet write them (apps/web/src/lib/format.ts, StatsForNerds.tsx).
public enum NerdFormat {
  /// 83 → "1:23"; an hour or more → "1:02:03" (phase 4's `Format.time`).
  public static func time(_ seconds: Double) -> String { Format.time(seconds) }

  /// 83.46 → "1:23.4".
  public static func at(_ seconds: Double) -> String {
    "\(time(seconds)).\(Int((max(0, seconds).truncatingRemainder(dividingBy: 1)) * 10))"
  }

  /// −5.25 → "−5.3 dB", 0 → "±0.0 dB".
  public static func dB(_ db: Double) -> String {
    let sign = db > 0 ? "+" : db < 0 ? "−" : "±"
    return "\(sign)\(fixed(abs(db), 1)) dB"
  }

  /// −9.04 → "−9.0", with a real minus sign.
  public static func signed(_ x: Double) -> String { (x < 0 ? "−" : "") + fixed(abs(x), 1) }

  public static func pct(_ x: Double) -> String { "\(Int((min(1, max(0, x)) * 100).rounded()))%" }

  public static func n2(_ x: Double) -> String { fixed(x, 2) }

  /// JavaScript's `toFixed`: halves away from zero (printf's `%.1f` takes 5.25 to 5.2, toFixed to 5.3).
  static func fixed(_ x: Double, _ digits: Int) -> String {
    let scale = pow(10, Double(digits))
    return String(format: "%.\(digits)f", (x * scale).rounded(.toNearestOrAwayFromZero) / scale)
  }

  /// "FLAC · 24-bit / 96 kHz · stereo · lossless" (`describeFormat`).
  public static func format(_ f: AudioFormat) -> String {
    var parts = [f.codec]
    let depth = [f.bits.map { "\($0)-bit" }, f.sampleRate.map { "\(Double($0) / 1000) kHz".replacingOccurrences(of: ".0 kHz", with: " kHz") }]
      .compactMap { $0 }
    if !depth.isEmpty { parts.append(depth.joined(separator: " / ")) }
    if let bitrate = f.bitrate { parts.append("\(Int(bitrate.rounded())) kbps") }
    if let channels = f.channels { parts.append(channels == 1 ? "mono" : channels == 2 ? "stereo" : "\(channels) ch") }
    parts.append(f.lossless ? "lossless" : "lossy")
    return parts.joined(separator: " · ")
  }

  /// How far the server has got making the transition: "43% · mixing", "waiting · 2 ahead" (`makingOf`).
  public static func making(_ render: RenderProgress) -> String {
    if render.step == .waiting {
      if let ahead = render.ahead, ahead > 0 { return "waiting · \(Int(ahead)) ahead" }
      return "waiting"
    }
    return "\(Int((min(1, max(0, render.done)) * 100).rounded(.down)))% · \(render.step.rawValue)"
  }
}
