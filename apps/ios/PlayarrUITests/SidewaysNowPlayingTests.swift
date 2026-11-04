import XCTest

/// Now Playing held sideways on an iPhone (docs/plans/2026-11-04-ios-now-playing-landscape.md): turning the phone
/// with a song queued opens it as the sleeve, the cover beside the tracklist; a tap on a line plays it; turning back
/// upright keeps Now Playing open, upright.
final class SidewaysNowPlayingTests: XCTestCase {
  override func setUpWithError() throws {
    try skipOnIPad()
    continueAfterFailure = false
  }

  override func tearDown() {
    MainActor.assumeIsolated { XCUIDevice.shared.orientation = .portrait }
  }

  @MainActor
  func testTurningThePhoneOpensTheSleeve() {
    let app = XCUIApplication.demo()
    app.launch()
    XCTAssertTrue(app.buttons["Mezzanine, Massive Attack · 1998 · 3 of 5"].firstMatch.waitForExistence(timeout: 10))
    app.buttons["Mezzanine, Massive Attack · 1998 · 3 of 5"].firstMatch.tap()
    app.buttons["Play Mezzanine"].tap()
    XCTAssertTrue(app.buttons["Pause Mezzanine"].waitForExistence(timeout: 5))

    XCUIDevice.shared.orientation = .landscapeLeft
    XCTAssertTrue(app.element("nowPlaying.tracklist").waitForExistence(timeout: 10))
    XCTAssertTrue(app.element("nowPlaying.deck").exists)
    XCTAssertTrue(app.element("Now playing: Angel, Massive Attack").exists)
    XCTAssertTrue(app.staticTexts["3 songs · 17 min left"].exists || app.staticTexts.matching(NSPredicate(format: "label ENDSWITH 'left'")).firstMatch.exists)

    // The album's own numbers, and a tap plays from that song.
    app.buttons["4, Inertia Creeps, 5:56"].tap()
    XCTAssertTrue(app.element("Now playing: Inertia Creeps, Massive Attack").waitForExistence(timeout: 5))

    // Upright again: Now Playing stays open, as a column.
    XCUIDevice.shared.orientation = .portrait
    XCTAssertTrue(app.buttons["Close now playing"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.element("nowPlaying.tracklist").waitForNonExistence(timeout: 5))
    app.buttons["Close now playing"].tap()
    XCTAssertTrue(app.buttons["Close now playing"].waitForNonExistence(timeout: 5))

    // Closed, with a song queued: turning the phone opens it again.
    XCUIDevice.shared.orientation = .landscapeRight
    XCTAssertTrue(app.element("nowPlaying.tracklist").waitForExistence(timeout: 10))
  }
}
