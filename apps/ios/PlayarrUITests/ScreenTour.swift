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

  /// A tab: in the tab bar, or on the iPhone Duo's cover screen in the column down the right, which isn't one.
  @MainActor
  private func tab(_ name: String) -> XCUIElement {
    let inBar = app.tabBars.buttons[name]
    return inBar.exists ? inBar : app.buttons[name].firstMatch
  }

  /// Closes a sheet with its Cancel or, where there's none, with a tap beside it: on the iPhone Duo's cover screen a
  /// full-height sheet's bar buttons move to the column down the right, where those with only words (Cancel, Use this)
  /// don't show, and the sheet doesn't follow a drag down. It leaves a thin edge of the page showing on the left.
  @MainActor
  private func closeSheet(_ title: String) {
    if tap(app.buttons["Cancel"].firstMatch, timeout: 2) { return }
    let bar = app.navigationBars[title].firstMatch
    guard bar.exists else { return }
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.005, dy: 0.5)).tap()
    if bar.waitForNonExistence(timeout: 3) { return }
    // Else Escape, as a hardware keyboard would.
    app.typeKey(XCUIKeyboardKey.escape.rawValue, modifierFlags: [])
    _ = bar.waitForNonExistence(timeout: 3)
  }

  /// Back to the page before, with the bar's back button (in the Duo's column, outside any navigation bar).
  @MainActor
  private func back() {
    let inBar = app.navigationBars.buttons.firstMatch
    (inBar.exists ? inBar : app.buttons["BackButton"].firstMatch).tap()
  }

  @MainActor
  func testTheMainScreens() throws {
    try XCTSkipIf(onIPad, "The iPad has its own tour")
    launch(["-UITests", "-UITestsDemo"])
    _ = app.staticTexts["8 songs across 3 albums, 45 min of music waiting in your library."].waitForExistence(timeout: 10)
    shot("01-home")
    app.swipeUp()
    shot("02-home-scrolled")
    app.swipeDown()

    if tap(app.buttons["Mezzanine, Massive Attack · 1998 · 3 of 5"].firstMatch) {
      shot("03-album")
      // Download: the ring fills as the songs arrive, then a tick.
      if tap(button(beginningWith: "Download Mezzanine"), timeout: 2) {
        shot("03b-album-downloading", after: 0.4)
        shot("03c-album-downloaded", after: 4)
      }
      app.swipeUp()
      shot("04-album-tracks")
      // A song's one menu, from its ⋯; then Add to playlist, Late night ticked as it holds the song already.
      if tap(app.buttons["More for Risingson"].firstMatch, timeout: 2) {
        shot("04b-song-menu", after: 0.8)
        if tap(app.buttons["Add to playlist…"], timeout: 2) {
          shot("04c-add-to-playlist", after: 1.5)
          closeSheet("Add “Risingson”")
        }
      }
      // Back up to Play: left under the bar, it doesn't take the tap.
      app.swipeDown()
      if tap(app.buttons["Play Mezzanine"]) || tap(app.buttons["Play"].firstMatch) {
        shot("05-album-playing")
      }
    }

    // Home's listening button: playing, the cover alone with a pause sign; tapped, paused, Resume and the title.
    if tap(tab("Home")) {
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

    if tap(tab("Queue")) { shot("08-queue") }

    if tap(tab("Library")) {
      shot("09-library")
      if tap(button(beginningWith: "Albums")) {
        shot("10-albums")
        back()
      }
      if tap(button(beginningWith: "Artists")) {
        shot("11-artists")
        if tap(button(beginningWith: "Massive Attack")) {
          shot("12-artist")
          back()
        }
        // An artist without a photo of their own: the compact header, their album's cover in a circle.
        if tap(button(beginningWith: "Portishead"), timeout: 2) { shot("12b-artist-without-photo") }
      }
    }
    if tap(tab("Library")) { tap(tab("Library"), timeout: 1) }
    if tap(button(beginningWith: "Favorites"), timeout: 2) {
      shot("17-favorites")
      back()
    }
    if tap(button(beginningWith: "Your listening"), timeout: 2) {
      shot("20-stats", after: 2)
      back()
    }
    if tap(button(beginningWith: "Made for you"), timeout: 2) {
      if tap(button(beginningWith: "Your vibes"), timeout: 3) {
        shot("18-mix")
        // Scrolled: the mix's name in the bar, now that its own title has gone under it.
        app.swipeUp()
        shot("18b-mix-scrolled")
      }
      tap(tab("Library"), timeout: 1)
      tap(tab("Library"), timeout: 1)
    }
    app.swipeUp()
    if tap(app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", "songs")).firstMatch, timeout: 2) {
      shot("19-playlist")
      // The cover picker, with what the cover is drawn from under the candidates.
      if tap(app.buttons["New cover"].firstMatch, timeout: 2) {
        app.swipeUp()
        shot("19b-cover-picker", after: 2)
        closeSheet("New cover")
      }
      tap(tab("Library"), timeout: 1)
      tap(tab("Library"), timeout: 1)
    }
    if tap(button(beginningWith: "Downloads"), timeout: 2) {
      shot("16-downloads")
      back()
    }

    if tap(tab("Library")) {
      // Back to Library's root (the tab remembers the artist page).
      tap(tab("Library"), timeout: 1)
    }
    if tap(app.buttons["Account and settings"].firstMatch), tap(app.buttons["Settings"]) {
      shot("14-settings")
      if tap(app.buttons["Playback"]) {
        shot("14b-playback")
        back()
      }
      if tap(app.buttons["Appearance"]) { shot("15-appearance") }
    }

    // Last: the search field takes the tab bar's place while it's active. On the iPhone Duo's cover screen, where the
    // tabs are a rail, the field can be there but out of sight: pulled down for, else the page is shot as it is.
    if tap(tab("Search")) {
      let field = app.searchFields.firstMatch
      if field.waitForExistence(timeout: 5), !field.isHittable { app.swipeDown() }
      if field.exists, field.isHittable {
        field.tap()
        field.typeText("mass")
      }
      shot("13-search")
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
    _ = app.staticTexts["8 songs across 3 albums, 45 min of music waiting in your library."].waitForExistence(timeout: 10)
    // The playlist first, opened upright where Library shows it, then turned.
    if tap(tab("Library")), tap(button(beginningWith: "Late night"), timeout: 3) {
      XCUIDevice.shared.orientation = .landscapeLeft
      shot("06-playlist", after: 2)
      XCUIDevice.shared.orientation = .portrait
      tap(tab("Library"), timeout: 1)
    }
    XCUIDevice.shared.orientation = .landscapeLeft
    shot("05-library", after: 2)
    if tap(tab("Home")) { shot("01-home") }
    if tap(app.buttons["Mezzanine, Massive Attack · 1998 · 3 of 5"].firstMatch) {
      shot("02-album")
      if tap(app.buttons["Play Mezzanine"]), tap(app.buttons["Massive Attack"].firstMatch, timeout: 2) { shot("03-artist") }
    }
    if tap(app.buttons["Open now playing"].firstMatch) {
      shot("04-now-playing", after: 2)
      if tap(app.buttons["Lyrics"]) { shot("04b-lyrics") }
      tap(app.buttons["Close now playing"], timeout: 2)
    }
    if tap(tab("Search")) { shot("07-search") }
  }

  /// The iPad, sideways as it's mostly held: Home, an album, the artist, the albums, Now Playing, the queue and lyrics
  /// columns, a playlist, Favorites, a mix, Settings and its Playback, Your listening and Search.
  @MainActor
  func testTheMainScreensOnIPad() throws {
    try XCTSkipUnless(onIPad, "The iPad's tour")
    XCUIDevice.shared.orientation = .landscapeLeft
    defer { XCUIDevice.shared.orientation = .portrait }
    // Enough playlists that the sidebar scrolls, to see its links fold to the one you're on.
    launch(["-UITests", "-UITestsDemo", "-UITestsManyPlaylists"])
    _ = app.staticTexts["8 songs across 3 albums, 45 min of music waiting in your library."].waitForExistence(timeout: 10)
    shot("01-home")
    let sidebar = { (item: String) in self.app.descendants(matching: .any)["sidebar.\(item)"].firstMatch }
    if sidebar("favorites").waitForExistence(timeout: 3) {
      sidebar("favorites").swipeUp(velocity: .slow)
      shot("01b-sidebar-scrolled")
      sidebar("newPlaylist").swipeDown(velocity: .fast)
      app.descendants(matching: .any)["sidebar.playlist.1000"].firstMatch.swipeDown(velocity: .fast)
    }
    // Home can take a while to settle after the sidebar's swipes.
    if tap(app.buttons["Mezzanine, Massive Attack · 1998 · 3 of 5"].firstMatch, timeout: 10) {
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
    if tap(sidebar("favorites")) { shot("13-favorites") }
    if tap(sidebar("mixes")), tap(button(beginningWith: "Your vibes"), timeout: 3) { shot("14-mix") }
    if tap(sidebar("settings")) {
      shot("10-settings")
      if tap(app.buttons["Playback"]) { shot("10b-playback") }
      // Picking Settings again goes back to its first page.
      if tap(sidebar("settings")), tap(app.buttons["Your listening"]) { shot("15-stats", after: 2) }
    }
    if tap(sidebar("search")) {
      let field = app.searchFields.firstMatch
      if field.waitForExistence(timeout: 5) {
        field.tap()
        field.typeText("mass")
        shot("11-search")
      }
    }
  }

  /// With Lidarr (`-UITestsRequests`): a partly-here album's action row with Request the rest, and Search's Request
  /// buttons before and after one is pressed.
  @MainActor
  func testRequesting() throws {
    try XCTSkipIf(folder?.lastPathComponent == "duo", "On the iPhone and the iPad")
    if onIPad { XCUIDevice.shared.orientation = .landscapeLeft }
    defer { XCUIDevice.shared.orientation = .portrait }
    launch(["-UITests", "-UITestsRequests"])
    if tap(app.buttons["Mezzanine, Massive Attack · 1998 · 3 of 5"].firstMatch, timeout: 10) { shot("21-album-request") }
    let search = onIPad ? app.descendants(matching: .any)["sidebar.search"].firstMatch : tab("Search")
    guard tap(search) else { return }
    let field = app.searchFields.firstMatch
    guard field.waitForExistence(timeout: 5) else { return }
    field.tap()
    // Search on the keyboard puts it away.
    field.typeText("Heligoland\n")
    if app.staticTexts["Not in your library"].waitForExistence(timeout: 10) {
      shot("22-search-request")
      if tap(app.buttons.matching(NSPredicate(format: "label ==[c] %@", "Request")).firstMatch) { shot("23-search-requested", after: 1.5) }
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
