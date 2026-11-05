import XCTest

/// The iPhone held sideways: every page turns, the artwork-led ones as a gatefold, and Now Playing opens as the sleeve,
/// the cover beside the tracklist; a tap on a line plays it; turning back upright keeps Now Playing open, upright. With
/// Settings → Appearance → Turn to open on, turning the phone opens Now Playing instead of turning the page.
final class SidewaysNowPlayingTests: XCTestCase {
  override func setUpWithError() throws {
    try skipOnIPad()
    continueAfterFailure = false
  }

  override func tearDown() {
    MainActor.assumeIsolated { XCUIDevice.shared.orientation = .portrait }
  }

  @MainActor
  private func playMezzanine(_ app: XCUIApplication) {
    XCTAssertTrue(app.buttons["Mezzanine, Massive Attack · 1998 · 3 of 5"].firstMatch.waitForExistence(timeout: 10))
    app.buttons["Mezzanine, Massive Attack · 1998 · 3 of 5"].firstMatch.tap()
    app.buttons["Play Mezzanine"].tap()
    XCTAssertTrue(app.buttons["Pause Mezzanine"].waitForExistence(timeout: 5))
  }

  @MainActor
  func testPagesTurnAndNowPlayingOpensAsTheSleeve() {
    let app = XCUIApplication.demo()
    app.launch()
    playMezzanine(app)

    // The album turns with the phone: its page, now a gatefold, and Now Playing stays closed.
    XCUIDevice.shared.orientation = .landscapeLeft
    XCTAssertTrue(app.staticTexts["LINER NOTES"].waitForExistence(timeout: 5) || app.buttons["Pause Mezzanine"].exists)
    XCTAssertFalse(app.buttons["Close now playing"].exists)
    keepScreenshot("album-sideways")

    app.buttons["Open now playing"].firstMatch.tap()
    XCTAssertTrue(app.element("nowPlaying.tracklist").waitForExistence(timeout: 10))
    XCTAssertTrue(app.element("nowPlaying.deck").exists)
    XCTAssertTrue(app.element("Now playing: Angel, Massive Attack").exists)
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label ENDSWITH 'left'")).firstMatch.exists)

    // The album's own numbers, and a tap plays from that song.
    app.buttons["4, Inertia Creeps, 5:56"].tap()
    XCTAssertTrue(app.element("Now playing: Inertia Creeps, Massive Attack").waitForExistence(timeout: 5))
    keepScreenshot("sleeve")

    // Upright again: Now Playing stays open, as a column.
    XCUIDevice.shared.orientation = .portrait
    XCTAssertTrue(app.buttons["Close now playing"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.element("nowPlaying.tracklist").waitForNonExistence(timeout: 5))
    app.buttons["Close now playing"].tap()
    XCTAssertTrue(app.buttons["Close now playing"].waitForNonExistence(timeout: 5))
  }

  @MainActor
  func testTurnToOpenOpensNowPlayingWhenTheSettingIsOn() {
    let app = XCUIApplication.demo()
    app.launchArguments += ["-UITestsTurnToOpen"]
    app.launch()
    playMezzanine(app)
    XCUIDevice.shared.orientation = .landscapeRight
    XCTAssertTrue(app.element("nowPlaying.tracklist").waitForExistence(timeout: 10))
  }

  /// The main pages held sideways, each kept as a screenshot to look at.
  @MainActor
  func testTourOfThePagesSideways() {
    let app = XCUIApplication.demo()
    app.launch()
    XCTAssertTrue(app.buttons["Mezzanine, Massive Attack · 1998 · 3 of 5"].firstMatch.waitForExistence(timeout: 10))
    XCUIDevice.shared.orientation = .landscapeLeft
    keepScreenshot("tour-home")
    app.buttons["Mezzanine, Massive Attack · 1998 · 3 of 5"].firstMatch.tap()
    XCTAssertTrue(app.buttons["Play Mezzanine"].waitForExistence(timeout: 5))
    keepScreenshot("tour-album")
    app.buttons["Play Mezzanine"].tap()
    app.buttons["Massive Attack"].firstMatch.tap()
    keepScreenshot("tour-artist")
    app.tabBars.buttons["Library"].tap()
    keepScreenshot("tour-library")
    // The playlist is opened upright, where Library shows it without scrolling, then turned.
    XCUIDevice.shared.orientation = .portrait
    let playlist = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Late night'")).firstMatch
    for _ in 0..<3 where !playlist.exists || !playlist.isHittable { app.swipeUp() }
    playlist.tap()
    XCUIDevice.shared.orientation = .landscapeLeft
    keepScreenshot("tour-playlist")
    app.tabBars.buttons["Search"].tap()
    // Sideways, Search folds the other tabs into one button beside the field, as iOS does.
    keepScreenshot("tour-search")
  }

  /// The sleeve as drawn, kept in the result bundle to look at (`xcresulttool export attachments`).
  @MainActor
  private func keepScreenshot(_ name: String) {
    RunLoop.current.run(until: Date().addingTimeInterval(1.5))
    let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
