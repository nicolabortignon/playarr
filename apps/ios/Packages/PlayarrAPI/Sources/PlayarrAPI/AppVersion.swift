import Foundation

/// The app's version as people see it, "1.0.0 (812)": the marketing version and the build number.
/// Versions compare by the marketing version, part by part ("1.10.0" > "1.9.3"; missing parts count
/// as 0), which is what a server's `minAppVersion` names; the build doesn't take part.
public struct AppVersion: Sendable, Comparable, CustomStringConvertible {
  public let marketing: String
  public let build: String

  public init(marketing: String, build: String) {
    self.marketing = marketing
    self.build = build
  }

  /// A marketing version alone, as a server writes it ("1.2.0").
  public init(_ marketing: String) {
    self.init(marketing: marketing, build: "0")
  }

  /// Reads `CFBundleShortVersionString` and `CFBundleVersion`, as found in `Bundle.main.infoDictionary`.
  public init(infoDictionary: [String: Any]) {
    self.init(
      marketing: infoDictionary["CFBundleShortVersionString"] as? String ?? "0.0.0",
      build: infoDictionary["CFBundleVersion"] as? String ?? "0"
    )
  }

  /// This app's version.
  public static var current: AppVersion {
    AppVersion(infoDictionary: Bundle.main.infoDictionary ?? [:])
  }

  public var label: String { "\(marketing) (\(build))" }

  public var description: String { marketing }

  /// The marketing version's numbers: "1.2.3" → [1, 2, 3].
  public var parts: [Int] {
    marketing.split(separator: ".").map { Int($0.prefix { $0.isNumber }) ?? 0 }
  }

  public static func < (lhs: AppVersion, rhs: AppVersion) -> Bool {
    let count = max(lhs.parts.count, rhs.parts.count)
    let left = lhs.parts + Array(repeating: 0, count: count - lhs.parts.count)
    let right = rhs.parts + Array(repeating: 0, count: count - rhs.parts.count)
    return left.lexicographicallyPrecedes(right)
  }

  public static func == (lhs: AppVersion, rhs: AppVersion) -> Bool { !(lhs < rhs) && !(rhs < lhs) }
}

extension ServerInfo {
  /// The server works with this version of the app (its minAppVersion is not newer).
  public func supports(_ app: AppVersion) -> Bool { app >= AppVersion(minAppVersion) }
}
