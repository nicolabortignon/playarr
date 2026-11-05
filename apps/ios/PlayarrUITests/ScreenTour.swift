import XCTest

/// Screenshots of the app's main views against the demo library, to look at rather than to assert: `pnpm ios:screens`
/// runs only this class on each device's own simulator (iPhone, iPad, iPhone Duo) and saves PNGs in screenshots/<device>/
/// at the repo root, the iPhone's sideways views in screenshots/iphone-sideways/ (the folder comes in as SCREENS_DIR, set
/// for the test runner with xcodebuild's TEST_RUNNER_ prefix). A step whose button isn't there is skipped, not failed, so
/// one moved button doesn't cost the rest of the tour. In the normal test run it does nothing.
final class ScreenTour: XCTestCase {
  private var folder: URL?
  private var app: XCUIApplication!
  private var onIPad: Bool { UIDevice.current.userInterfaceIdiom == .pad }

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
    // The demo albums' real covers, downloaded by `make screens` (scripts/screens-covers.mjs).
    if let covers = ProcessInfo.processInfo.environment["PLAYARR_DEMO_COVERS"] { app.launchEnvironment["PLAYARR_DEMO_COVERS"] = covers }
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
  func testTheMainScreens() throws {
    try XCTSkipIf(onIPad, "The iPad has its own tour")
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

    // Home's listening button: playing, the cover alone with a pause sign; tapped, paused, Resume and the title.
    if tap(app.tabBars.buttons["Home"]) {
      app.swipeDown()
      shot("05b-home-playing")
      if tap(button(beginningWith: "Pause"), timeout: 2) {
        shot("05c-home-paused")
        tap(button(beginningWith: "Resume"), timeout: 2)
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
    if tap(app.buttons["Account and settings"].firstMatch), tap(app.buttons["Settings"]) {
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

  /// The iPhone held sideways: Home, the gatefold pages, the artist, Library, Search and Now Playing's sleeve.
  @MainActor
  func testTheMainScreensSideways() throws {
    try XCTSkipIf(onIPad, "The iPad has its own tour")
    guard let upright = folder else { return }
    folder = upright.deletingLastPathComponent().appending(path: upright.lastPathComponent + "-sideways")
    try FileManager.default.createDirectory(at: folder!, withIntermediateDirectories: true)
    defer { XCUIDevice.shared.orientation = .portrait }
    launch(["-UITests", "-UITestsDemo"])
    _ = app.staticTexts["8 tracks across 3 albums, 45 min of music waiting in your library."].waitForExistence(timeout: 10)
    // The playlist first, opened upright where Library shows it, then turned.
    if tap(app.tabBars.buttons["Library"]), tap(button(beginningWith: "Late night"), timeout: 3) {
      XCUIDevice.shared.orientation = .landscapeLeft
      shot("06-playlist", after: 2)
      XCUIDevice.shared.orientation = .portrait
      tap(app.tabBars.buttons["Library"], timeout: 1)
    }
    XCUIDevice.shared.orientation = .landscapeLeft
    shot("05-library", after: 2)
    if tap(app.tabBars.buttons["Home"]) { shot("01-home") }
    if tap(app.buttons["Mezzanine, Massive Attack · 1998 · 3 of 5"].firstMatch) {
      shot("02-album")
      if tap(app.buttons["Play Mezzanine"]), tap(app.buttons["Massive Attack"].firstMatch, timeout: 2) { shot("03-artist") }
    }
    if tap(app.buttons["Open now playing"].firstMatch) {
      shot("04-now-playing", after: 2)
      if tap(app.buttons["Lyrics"]) { shot("04b-lyrics") }
      tap(app.buttons["Close now playing"], timeout: 2)
    }
    if tap(app.tabBars.buttons["Search"]) { shot("07-search") }
  }

  /// The iPad, sideways as it's mostly held: Home, an album, the artist, the albums, Now Playing, the queue and lyrics
  /// columns, a playlist, Settings and Search.
  @MainActor
  func testTheMainScreensOnIPad() throws {
    try XCTSkipUnless(onIPad, "The iPad's tour")
    XCUIDevice.shared.orientation = .landscapeLeft
    defer { XCUIDevice.shared.orientation = .portrait }
    // Enough playlists that the sidebar scrolls, to see its links fold to the one you're on.
    launch(["-UITests", "-UITestsDemo", "-UITestsManyPlaylists"])
    _ = app.staticTexts["8 tracks across 3 albums, 45 min of music waiting in your library."].waitForExistence(timeout: 10)
    shot("01-home")
    let sidebar = { (item: String) in self.app.descendants(matching: .any)["sidebar.\(item)"].firstMatch }
    if sidebar("favorites").waitForExistence(timeout: 3) {
      sidebar("favorites").swipeUp(velocity: .slow)
      shot("01b-sidebar-scrolled")
      sidebar("newPlaylist").swipeDown(velocity: .fast)
      app.descendants(matching: .any)["sidebar.playlist.1000"].firstMatch.swipeDown(velocity: .fast)
    }
    if tap(app.buttons["Mezzanine, Massive Attack · 1998 · 3 of 5"].firstMatch) {
      shot("02-album")
      if tap(app.buttons["Play Mezzanine"]) {
        shot("03-album-playing")
        if tap(app.descendants(matching: .any)["playerBar.queue"].firstMatch) { shot("04-queue-column") }
        if tap(app.descendants(matching: .any)["playerBar.lyrics"].firstMatch) { shot("05-lyrics-column") }
        tap(app.descendants(matching: .any)["playerBar.lyrics"].firstMatch, timeout: 1)
      }
      if tap(app.buttons["Massive Attack"].firstMatch, timeout: 2) { shot("06-artist") }
    }
    if tap(app.buttons["Open now playing"].firstMatch) {
      shot("07-now-playing", after: 2)
      tap(app.buttons["Close now playing"], timeout: 2)
    }
    if tap(sidebar("albums")) { shot("08-albums") }
    if tap(sidebar("playlist.1"), timeout: 2) { shot("09-playlist") }
    if tap(sidebar("settings")) { shot("10-settings") }
    if tap(sidebar("search")) {
      let field = app.searchFields.firstMatch
      if field.waitForExistence(timeout: 5) {
        field.tap()
        field.typeText("mass")
        shot("11-search")
      }
    }
  }

  /// Now Playing as an iPhone Duo held part-open or open lays it out, the fold forced (`-UITestsFold`: the simulator
  /// can't open the hinge): propped up like a laptop on the Duo's cover screen, and as two pages on the iPad sideways,
  /// the nearest window to the Duo open.
  @MainActor
  func testNowPlayingFolded() throws {
    let pad = onIPad
    try XCTSkipUnless(pad || folder?.lastPathComponent == "duo", "On the iPhone Duo and the iPad")
    if pad { XCUIDevice.shared.orientation = .landscapeLeft }
    defer { XCUIDevice.shared.orientation = .portrait }
    launch(["-UITests", "-UITestsDemo", "-UITestsFold", pad ? "flat" : "half"])
    if tap(app.buttons["Mezzanine, Massive Attack · 1998 · 3 of 5"].firstMatch, timeout: 10), tap(app.buttons["Play Mezzanine"]),
      tap(app.buttons["Open now playing"].firstMatch)
    {
      shot(pad ? "12-now-playing-duo-open" : "09-now-playing-duo-propped", after: 2)
    }
  }
}
