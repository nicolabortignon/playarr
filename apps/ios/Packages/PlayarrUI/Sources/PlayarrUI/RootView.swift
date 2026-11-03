import Foundation
import PlayarrAPI
import SwiftUI

/// The app's only screen in phase 0: its name and the version installed.
public struct RootView: View {
  let version: AppVersion

  public init(version: AppVersion = AppVersion(infoDictionary: Bundle.main.infoDictionary ?? [:])) {
    self.version = version
  }

  var versionText: String { "Version \(version.label)" }

  public var body: some View {
    VStack(spacing: 8) {
      Text("Playarr")
        .font(.largeTitle.bold())
      Text(versionText)
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .accessibilityIdentifier("version")
    }
  }
}
