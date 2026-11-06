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

  /// Closes a sheet with its Cancel or close (on the iPhone Duo's cover screen a full-height sheet's bar buttons move to the
  /// column down the right, which shows them by their icons) or, where there's none, with a tap beside it: there the
  /// sheet doesn't follow a drag down, and leaves a thin edge of the page showing on the left.
  @MainActor
  private func closeSheet(_ title: String) {
    if tap(app.buttons["Cancel"].firstMatch, timeout: 2) || tap(app.buttons["Close"].firstMatch, timeout: 1) { return }
    let bar = app.navigationBars[title].firstMatch
    guard bar.exists else { return }
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.005, dy: 0.5)).tap()
    if bar.waitForNonExistence(timeout: 3) { return }
    // Else Escape, as a hardware keyboard would.
    app.typeKey(XCUIKeyboardKey.escape.rawValue, modifierFlags: [])
    _ = bar.waitForNonExistence(timeout: 3)
  }

  /// Back to the page before, with the bar's back button (in the Duo's column, outside any navigation bar); skipped, as
  /// any step, when there's none (the page didn't open).
  @MainActor
  private func back() {
    // The one on screen: the other tabs' bars keep their back buttons in the tree, out of sight (on the iPhone SE the
    // first of them had no point to tap, and the tap went nowhere).
    let backButtons = app.navigationBars.buttons.matching(identifier: "BackButton").allElementsBoundByIndex
    if let shown = backButtons.first(where: { $0.isHittable }) { return shown.tap() }
    let inBar = app.navigationBars.buttons.firstMatch
    if inBar.exists { inBar.tap() } else { tap(app.buttons["BackButton"].firstMatch, timeout: 2) }
  }

  /// `back()` from the page titled `title`, once more if it's still there, so a tap that went nowhere doesn't skip the
  /// rest of Settings.
  @MainActor
  private func back(from title: String) {
    back()
    let page = app.navigationBars[title]
    if page.exists, !page.waitForNonExistence(timeout: 2) { back() }
  }

  /// Puts away a question a phone shows as a popover without Cancel, with a tap beside it: above it, or below it when
  /// it sits at the top (on the iPhone SE the list had scrolled its button up, and the tap above landed on it).
  @MainActor
  private func dismissQuestion(answer verb: String) {
    if tap(app.buttons["Cancel"].firstMatch, timeout: 1) { return }
    let answer = app.buttons[verb].firstMatch
    let high = answer.exists && answer.frame.minY < app.frame.height * 0.4
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: high ? 0.75 : 0.1)).tap()
  }

  /// The element, the page swiped up until it's there and clear of the bars at the foot (three swipes at most): a list
  /// draws only the rows near the screen, and the iPhone Duo's cover screen shows few.
  @MainActor
  private func reveal(_ element: XCUIElement) -> XCUIElement {
    var swipes = 0
    while swipes < 3, !(element.waitForExistence(timeout: 1) && element.frame.midY < app.frame.height * 0.7) {
      app.swipeUp(velocity: .slow)
      swipes += 1
    }
    return element
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
    // The queue before anything plays: its empty state, with Feeling lucky and Jump back in.
    if tap(tab("Queue"), timeout: 2) {
      shot("02b-queue-empty")
      tap(tab("Home"), timeout: 2)
    }

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
      // A full-height sheet with only a close: on the Duo's cover screen it's in the column.
      if tap(app.buttons["More for Risingson"].firstMatch, timeout: 2), tap(app.buttons["Show metadata"], timeout: 2) {
        shot("04d-metadata", after: 1.5)
        closeSheet("Song metadata")
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
    // The accounts, a picker: half the screen, its close in the corner.
    if tap(app.buttons["Account and settings"].firstMatch), tap(app.buttons["Account"], timeout: 2) {
      shot("14a-accounts")
      closeSheet("Accounts")
    }
    if tap(app.buttons["Account and settings"].firstMatch), tap(app.buttons["Settings"]) {
      shot("14-settings")
      if tap(app.buttons["Playback"]) {
        shot("14b-playback")
        back(from: "Playback")
      }
      if tap(app.buttons["Appearance"]) {
        shot("15-appearance")
        back(from: "Appearance")
      }
      // Accounts: someone invited who never set up says so, with Copy invite link and New code; this device made no link
      // for them, so copying asks for a new one.
      if tap(reveal(app.buttons["settings.accounts"].firstMatch), timeout: 2) {
        shot("14c-settings-accounts", after: 1.5)
        if tap(app.buttons["Copy Jo’s invite link"], timeout: 2) {
          shot("14d-invite-question", after: 1)
          dismissQuestion(answer: "Make a new link")
        }
        back(from: "Accounts")
      }
      // Sources: each source's ⋯ says what it does in words.
      if tap(reveal(app.buttons["settings.sources"].firstMatch), timeout: 2) {
        shot("14e-settings-sources", after: 1.5)
        if tap(app.buttons["More for “Music”"].firstMatch, timeout: 2) {
          shot("14f-source-menu", after: 0.8)
          app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)).tap()
        }
        back(from: "Sources")
      }
    }

    // A playlist of your own with nothing in it yet, and what deleting it asks.
    if tap(tab("Library")) {
      tap(tab("Library"), timeout: 1)
      let name = app.textFields["playlist.name"]
      if tap(app.buttons["library.newPlaylist"], timeout: 2), name.waitForExistence(timeout: 3) {
        name.typeText("Road trip")
        if tap(app.buttons["playlist.create"]) {
          shot("19c-playlist-empty")
          if tap(app.buttons["Playlist actions"], timeout: 2), tap(app.buttons["Delete playlist"], timeout: 2) {
            shot("19d-delete-question", after: 1)
            // A phone shows the question as a popover without Cancel: a tap beside it puts it away.
            if !tap(app.buttons["Cancel"].firstMatch, timeout: 1) { app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.1)).tap() }
          }
        }
      }
    }

    // Last: the search field takes the tab bar's place while it's active. On the iPhone Duo's cover screen, where the
    // tabs are a rail, it sits under the page's title instead.
    if tap(tab("Search")) {
      let field = app.searchFields.firstMatch
      if field.waitForExistence(timeout: 5), !field.isHittable { app.swipeDown() }
      if field.exists, field.isHittable {
        field.tap()
        field.typeText("mass")
      }
      shot("13-search")
      if field.exists, field.isHittable {
        // Return counts the search as a recent one, and puts the keyboard away: further down, what's beyond the library.
        field.typeText("\n")
        // Its heading near the top, with where it's from and what Request does: dragged there and held, so the page
        // doesn't fling past it.
        let beyond = app.staticTexts["Not in your library"]
        let height = app.frame.height
        var drags = 0
        while drags < 5, beyond.waitForExistence(timeout: 3), beyond.frame.minY > height * 0.3 {
          let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
          let distance = min(beyond.frame.minY - height * 0.15, height * 0.45)
          start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -distance)), withVelocity: .slow, thenHoldForDuration: 0.3)
          drags += 1
        }
        shot("13a-search-beyond")
        for _ in 0..<drags { app.swipeDown() }
      }
      // Nothing in the library: what to try, and New search.
      if field.exists, field.isHittable {
        field.tap()
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 4) + "zzzz")
        shot("13b-search-nothing")
        // Empty again: the searches made lately, above the artists to try.
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 4))
        shot("13c-search-recent")
      }
    }
  }

  /// A page that couldn't load (`-UITestsOffline`): Home's, and a page's with Back home.
  @MainActor
  func testAPageThatCouldntLoad() throws {
    try XCTSkipIf(onIPad, "The iPad has its own tour")
    launch(["-UITests", "-UITestsDemo", "-UITestsOffline"])
    _ = app.staticTexts["The needle skipped."].waitForExistence(timeout: 10)
    shot("24-error-home")
    if tap(tab("Library")), tap(button(beginningWith: "Albums")) {
      _ = app.staticTexts["The needle skipped."].waitForExistence(timeout: 10)
      shot("25-error-page")
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
    }
    // Your listening, from the account menu (on a page's root, not over Settings → Playback): it isn't a setting.
    if tap(sidebar("home")), tap(app.buttons["Account and settings"].firstMatch), tap(app.buttons["Your listening"], timeout: 2) {
      shot("15-stats", after: 2)
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
