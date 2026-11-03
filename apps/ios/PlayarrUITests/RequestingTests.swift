import XCTest

/// Requesting an album from Search against the in-app demo server with Lidarr (`-UITestsRequests`): the button goes
/// Request → Searching, the toasts say so, and the album lands on the next look at the requests.
final class RequestingTests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  /// A button or text whose label is `label`, whatever its case (the request controls are drawn upper-case).
  private func labelled(_ query: XCUIElementQuery, _ label: String) -> XCUIElement {
    query.matching(NSPredicate(format: "label ==[c] %@", label)).firstMatch
  }

  @MainActor
  func testRequestingAnAlbumFromSearch() {
    let app = XCUIApplication()
    app.launchArguments = ["-UITests", "-UITestsRequests"]
    app.launch()

    app.tabBars.buttons["Search"].tap()
    let field = app.searchFields.firstMatch
    XCTAssertTrue(field.waitForExistence(timeout: 10))
    field.tap()
    // Search on the keyboard puts it away: the floating search field would cover the results.
    field.typeText("Heligoland\n")

    XCTAssertTrue(app.staticTexts["Not in your library"].waitForExistence(timeout: 10))
    let request = labelled(app.buttons, "Request")
    XCTAssertTrue(request.waitForExistence(timeout: 10))
    request.tap()

    XCTAssertTrue(app.staticTexts["Requested “Heligoland”. Lidarr is searching for it"].waitForExistence(timeout: 10))
    XCTAssertTrue(labelled(app.staticTexts, "Searching").waitForExistence(timeout: 10))
    // The requests are asked for every 10 s while one is on its way: the next look finds it in the library.
    XCTAssertTrue(app.staticTexts["“Heligoland” is ready to play"].waitForExistence(timeout: 25))

    // With Search open the other tabs fold into one button: unfold them, then Library.
    let library = app.tabBars.buttons["Library"]
    if !library.exists { app.buttons["Home"].firstMatch.tap() }
    XCTAssertTrue(library.waitForExistence(timeout: 5))
    library.tap()
    let requests = app.buttons["library-requests"]
    XCTAssertTrue(requests.waitForExistence(timeout: 10))
    requests.tap()
    XCTAssertTrue(app.staticTexts["Heligoland"].waitForExistence(timeout: 10))
    let ready = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Ready to play")).firstMatch
    XCTAssertTrue(ready.waitForExistence(timeout: 10))
  }
}
