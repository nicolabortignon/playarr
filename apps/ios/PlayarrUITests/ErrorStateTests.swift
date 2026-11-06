import XCTest

/// With the server unreachable and nothing kept (`-UITestsOffline`), each page says so and offers Try again (and,
/// away from Home, Back home) instead of a blank page or a spinner that never ends.
final class ErrorStateTests: XCTestCase {
  override func setUpWithError() throws {
    try skipOnIPad()
    continueAfterFailure = false
  }

  @MainActor
  func testPagesSayTheServerCantBeReached() {
    let app = XCUIApplication.demo(["-UITestsOffline"])
    app.launch()
    XCTAssertTrue(app.staticTexts["The needle skipped."].waitForExistence(timeout: 10))  // Home
    XCTAssertTrue(app.buttons["Try again"].exists)
    XCTAssertFalse(app.buttons["Back home"].exists)

    app.tabBars.buttons["Library"].tap()
    app.button(startingWith: "Albums").tap()
    XCTAssertTrue(app.staticTexts["The needle skipped."].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["Back home"].exists)
    app.navigationBars.buttons.firstMatch.tap()
    app.button(startingWith: "Artists").tap()
    XCTAssertTrue(app.staticTexts["The needle skipped."].waitForExistence(timeout: 10))
    app.buttons["Back home"].tap()
    expectation(for: NSPredicate(format: "isSelected == true"), evaluatedWith: app.tabBars.buttons["Home"])
    waitForExpectations(timeout: 5)

    app.tabBars.buttons["Queue"].tap()
    XCTAssertTrue(app.staticTexts["The deck’s empty."].waitForExistence(timeout: 5))
  }
}
