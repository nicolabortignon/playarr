import XCTest

/// With the server unreachable and nothing kept (`-UITestsOffline`), each page says so and offers Try again
/// instead of a blank page or a spinner that never ends.
final class ErrorStateTests: XCTestCase {
  override func setUpWithError() throws {
    try skipOnIPad()
    continueAfterFailure = false
  }

  @MainActor
  func testPagesSayTheServerCantBeReached() {
    let app = XCUIApplication.demo(["-UITestsOffline"])
    app.launch()
    XCTAssertTrue(app.staticTexts["Something skipped."].waitForExistence(timeout: 10))  // Home
    XCTAssertTrue(app.buttons["Try again"].exists)

    app.tabBars.buttons["Library"].tap()
    app.button(startingWith: "Albums").tap()
    XCTAssertTrue(app.staticTexts["Something skipped."].waitForExistence(timeout: 10))
    app.navigationBars.buttons.firstMatch.tap()
    app.button(startingWith: "Artists").tap()
    XCTAssertTrue(app.staticTexts["Something skipped."].waitForExistence(timeout: 10))

    app.tabBars.buttons["Queue"].tap()
    XCTAssertTrue(app.staticTexts["Nothing queued"].waitForExistence(timeout: 5))
  }
}
