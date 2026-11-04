import XCTest

/// Screenshots of the app's main screens against the demo library, to look at rather than to assert: `pnpm ios:screens`
/// runs only this class and saves them as PNGs in apps/ios/build/screens/ (the folder comes in as SCREENS_DIR, set for
/// the test runner with xcodebuild's TEST_RUNNER_ prefix). A step whose button isn't there is skipped, not failed, so
/// one moved button doesn't cost the rest of the tour. In the normal test run it does nothing.
final class ScreenTour: XCTestCase {
  private var folder: URL?
  private var app: XCUIApplication!

  override func setUpWithError() throws {
    continueAfterFailure = true
    guard let dir = ProcessInfo.processInfo.environment["SCREENS_DIR"], !dir.isEmpty else {
      throw XCTSkip("Screenshots only: run with pnpm ios:screens")
    }
    folder = URL(filePath: dir)
    try FileManager.default.createDirectory(at: folder!, withIntermediateDirectories: true)
  }

  @MainActor
  private func launch(_ arguments: [String]) {
    app = XCUIApplication()
    app.launchArguments = arguments
    app.launch()
  }

  /// The screen as it is now, saved as `<name>.png`, once animations and images have settled (`after` seconds).
  @MainActor
  private func shot(_ name: String, after: TimeInterval = 1.2) {
    Thread.sleep(forTimeInterval: after)
    guard let folder else { return }
    try? XCUIScreen.main.screenshot().pngRepresentation.write(to: folder.appending(path: "\(name).png"))
  }

  /// Taps the element if it shows up; false (and the step skipped) when it doesn't.
  @MainActor
  @discardableResult
  private func tap(_ element: XCUIElement, timeout: TimeInterval = 5) -> Bool {
    guard element.waitForExistence(timeout: timeout) else { return false }
    element.tap()
    return true
  }

  @MainActor
  private func button(beginningWith prefix: String) -> XCUIElement {
    app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
  }

  @MainActor
  func testTheMainScreens() {
    launch(["-UITests", "-UITestsDemo"])
    _ = app.staticTexts["8 tracks across 3 albums, 45 min of music waiting in your library."].waitForExistence(timeout: 10)
    shot("01-home")
    app.swipeUp()
    shot("02-home-scrolled")
    app.swipeDown()

    if tap(app.buttons["Mezzanine, Massive Attack · 1998 · 3 of 5"].firstMatch) {
      shot("03-album")
      // Download: the pill draws in to a circle filling as the songs arrive, then a tick.
      if tap(button(beginningWith: "Download Mezzanine"), timeout: 2) {
        shot("03b-album-downloading", after: 0.4)
        shot("03c-album-downloaded", after: 4)
      }
      app.swipeUp()
      shot("04-album-tracks")
      if tap(app.buttons["Play Mezzanine"]) || tap(app.buttons["Play"].firstMatch) {
        shot("05-album-playing")
      }
    }

    if tap(app.buttons["Open now playing"]) {
      shot("06-now-playing")
      if tap(app.buttons["Lyrics"]) {
        shot("07-lyrics")
        tap(app.buttons["Lyrics"])
      }
      tap(app.buttons["Close now playing"])
    }

    if tap(app.tabBars.buttons["Queue"]) { shot("08-queue") }

    if tap(app.tabBars.buttons["Library"]) {
      shot("09-library")
      if tap(button(beginningWith: "Albums")) {
        shot("10-albums")
        app.navigationBars.buttons.firstMatch.tap()
      }
      if tap(button(beginningWith: "Artists")) {
        shot("11-artists")
        if tap(button(beginningWith: "Massive Attack")) { shot("12-artist") }
      }
    }
    if tap(app.tabBars.buttons["Library"]) { tap(app.tabBars.buttons["Library"], timeout: 1) }
    if tap(button(beginningWith: "Favorites"), timeout: 2) {
      shot("17-favorites")
      app.navigationBars.buttons.firstMatch.tap()
    }
    if tap(button(beginningWith: "Made for you"), timeout: 2) {
      if tap(button(beginningWith: "Your vibes"), timeout: 3) { shot("18-mix") }
      tap(app.tabBars.buttons["Library"], timeout: 1)
      tap(app.tabBars.buttons["Library"], timeout: 1)
    }
    app.swipeUp()
    if tap(app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "songs")).firstMatch, timeout: 2) {
      shot("19-playlist")
      tap(app.tabBars.buttons["Library"], timeout: 1)
      tap(app.tabBars.buttons["Library"], timeout: 1)
    }
    if tap(button(beginningWith: "Downloads"), timeout: 2) {
      shot("16-downloads")
      app.navigationBars.buttons.firstMatch.tap()
    }

    if tap(app.tabBars.buttons["Library"]) {
      // Back to Library's root (the tab remembers the artist page).
      tap(app.tabBars.buttons["Library"], timeout: 1)
    }
    if tap(button(beginningWith: "Settings")) {
      shot("14-settings")
      if tap(app.buttons["Appearance"]) { shot("15-appearance") }
    }

    // Last: the search field takes the tab bar's place while it's active.
    if tap(app.tabBars.buttons["Search"]) {
      let field = app.searchFields.firstMatch
      if field.waitForExistence(timeout: 5) {
        field.tap()
        field.typeText("mass")
        shot("13-search")
      }
    }
  }

}
