import XCTest

/// Library → Downloads on made-up downloads (`DownloadsDemoView`): no server needed.
final class DownloadsUITests: XCTestCase {
  @MainActor
  func testShowsEachDownloadWithItsProgressAndFailuresAndPlaysAndRemovesThem() {
    let app = XCUIApplication()
    app.launchArguments = ["-UITestsDownloads"]
    app.launch()

    XCTAssertTrue(app.navigationBars["Downloads"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["Massive Attack · 11 songs · 484 MB"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Playlist · 3 of 10 songs · 132 MB · 1 couldn’t download"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.progressIndicators.firstMatch.exists)

    app.buttons["Play Mezzanine"].tap()
    XCTAssertTrue(app.staticTexts["Playing Mezzanine"].waitForExistence(timeout: 2))

    app.buttons["Remove Mezzanine from this device"].tap()
    let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: app.buttons["Play Mezzanine"])
    wait(for: [gone], timeout: 5)
    XCTAssertTrue(app.buttons["Play Late Night"].exists)
  }
}
