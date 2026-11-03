import Foundation

/// The app's version as people see it, "1.0.0 (812)": the marketing version and the build number.
public struct AppVersion: Sendable, Equatable {
  public let marketing: String
  public let build: String

  public init(marketing: String, build: String) {
    self.marketing = marketing
    self.build = build
  }

  /// Reads `CFBundleShortVersionString` and `CFBundleVersion`, as found in `Bundle.main.infoDictionary`.
  public init(infoDictionary: [String: Any]) {
    self.init(
      marketing: infoDictionary["CFBundleShortVersionString"] as? String ?? "0.0.0",
      build: infoDictionary["CFBundleVersion"] as? String ?? "0"
    )
  }

  public var label: String { "\(marketing) (\(build))" }
}
