import XCTest

final class LaunchTests: XCTestCase {
  @MainActor
  func testLaunchShowsTheNameAndVersion() {
    let app = XCUIApplication()
    app.launch()
    XCTAssertTrue(app.staticTexts["Playarr"].waitForExistence(timeout: 10))
    let version = app.staticTexts["version"]
    XCTAssertTrue(version.exists)
    XCTAssertTrue(version.label.hasPrefix("Version 1.0.0 ("), version.label)
  }
}
