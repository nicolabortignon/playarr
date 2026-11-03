import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor
@Test func showsTheVersionAndBuild() {
  let view = RootView(version: AppVersion(marketing: "1.0.0", build: "812"))
  #expect(view.versionText == "Version 1.0.0 (812)")
}
