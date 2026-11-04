import XCTest

/// Day-to-day listening on the simulator, against the demo library (`-UITestsDemo`: signed in, playing silence).
final class BrowseTests: XCTestCase {
  override func setUp() {
    continueAfterFailure = false
  }

  @MainActor
  private func launch() -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-UITests", "-UITestsDemo"]
    app.launch()
    return app
  }

  @MainActor
  func testHomeOpensAnAlbumThatPlaysAndNowPlayingOpensAndCloses() {
    let app = launch()
    XCTAssertTrue(app.staticTexts["8 tracks across 3 albums, 45 min of music waiting in your library."].waitForExistence(timeout: 10))

    app.buttons["Mezzanine, Massive Attack · 1998 · 3 of 5"].firstMatch.tap()
    XCTAssertTrue(app.staticTexts["LINER NOTES"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["3. Teardrop, not in your library"].exists || app.otherElements["3. Teardrop, not in your library"].exists)

    app.buttons["Play Mezzanine"].tap()
    XCTAssertTrue(app.buttons["Pause Mezzanine"].waitForExistence(timeout: 5))

    app.buttons["Open now playing"].tap()
    let close = app.buttons["Close now playing"]
    XCTAssertTrue(close.waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["Angel"].exists)
    XCTAssertTrue(app.buttons["Mezzanine"].exists)  // Playing from

    app.buttons["Lyrics"].tap()
    XCTAssertTrue(app.buttons["You are my angel"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["LYRICS FROM"].exists)
    app.buttons["Lyrics"].tap()

    app.buttons["Sleep timer"].tap()
    app.buttons["In 15 minutes"].tap()
    XCTAssertTrue(app.buttons["Sleep timer: 15 min"].waitForExistence(timeout: 5))

    // Swipe down on the cover, as far as a thumb does.
    let cover = app.otherElements["nowPlaying"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
    cover.press(forDuration: 0.05, thenDragTo: cover.withOffset(CGVector(dx: 0, dy: 300)), withVelocity: .fast, thenHoldForDuration: 0)
    XCTAssertTrue(close.waitForNonExistence(timeout: 5))
    XCTAssertTrue(app.buttons["Open now playing"].exists)
  }

  @MainActor
  func testTheQueueTogglesEditAndClearsWithUndo() {
    let app = launch()
    app.buttons["Mezzanine, Massive Attack · 1998 · 3 of 5"].firstMatch.tap()
    app.buttons["Play Mezzanine"].tap()
    app.tabBars.buttons["Queue"].tap()
    XCTAssertTrue(app.buttons["Risingson, Massive Attack, 4:58"].waitForExistence(timeout: 5))
    app.buttons["Edit"].tap()
    XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 5))
    app.buttons["Done"].tap()
    XCTAssertTrue(app.buttons["Edit"].waitForExistence(timeout: 5))
    app.buttons["Clear"].tap()
    XCTAssertTrue(app.staticTexts["The queue ends after this track."].waitForExistence(timeout: 5))
    app.buttons["Undo"].tap()
    XCTAssertTrue(app.buttons["Risingson, Massive Attack, 4:58"].waitForExistence(timeout: 5))
  }

  @MainActor
  func testSearchFindsAnArtist() {
    let app = launch()
    app.tabBars.buttons["Search"].tap()
    XCTAssertTrue(app.buttons["Portishead"].waitForExistence(timeout: 5))  // Try an artist
    let field = app.searchFields.firstMatch
    field.tap()
    field.typeText("portis")
    XCTAssertTrue(app.staticTexts["Top result"].waitForExistence(timeout: 5))
    app.buttons["Mysterons, Portishead, Dummy, 5:06"].tap()
    XCTAssertTrue(app.buttons["Open now playing"].waitForExistence(timeout: 5))
  }

  @MainActor
  func testAppearanceChangesTheAccent() {
    let app = launch()
    app.buttons["Account and settings"].firstMatch.tap()
    app.buttons["Settings"].tap()
    app.buttons["Appearance"].tap()
    app.buttons["Violet"].tap()
    XCTAssertTrue(app.staticTexts["Violet, whatever is playing."].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["Violet"].isSelected)
  }
}
