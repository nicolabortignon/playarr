import XCTest

final class LaunchTests: XCTestCase {
  @MainActor
  func testLaunchAsksForAServerAndShowsTheVersion() {
    let app = XCUIApplication()
    app.launchArguments = ["-UITests"]
    app.launch()
    XCTAssertTrue(app.navigationBars["Add a server"].waitForExistence(timeout: 10))
    let version = app.staticTexts["version"]
    XCTAssertTrue(version.exists)
    XCTAssertTrue(version.label.hasPrefix("Version 1.0.0 ("), version.label)
  }
}
