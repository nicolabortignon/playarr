import XCTest

/// The iPad layout on a full-screen iPad, against the demo library: the sidebar, pages in the detail column, the
/// player bar, the queue and lyrics column, Now Playing with Up next, the keyboard, dragging songs and coming back
/// where it was.
final class IPadLayoutTests: XCTestCase {
  override func setUpWithError() throws {
    try XCTSkipUnless(isPad, "iPad only")
    continueAfterFailure = false
    MainActor.assumeIsolated { XCUIDevice.shared.orientation = .landscapeLeft }
  }

  @MainActor
  private func playMezzanine(_ app: XCUIApplication) {
    app.element("sidebar.albums").tap()
    app.buttons["Mezzanine, Massive Attack · 1998 · 3 of 5"].firstMatch.tap()
    XCTAssertTrue(app.buttons["Play Mezzanine"].waitForExistence(timeout: 5))
    app.buttons["Play Mezzanine"].tap()
    XCTAssertTrue(app.buttons["Pause Mezzanine"].waitForExistence(timeout: 5))
  }

  @MainActor
  func testSidebarPlayerBarAndTheQueueAndLyricsColumn() {
    let app = XCUIApplication.demo()
    app.launch()
    XCTAssertTrue(app.element("sidebar.home").waitForExistence(timeout: 10))
    XCTAssertFalse(app.tabBars.firstMatch.exists)
    for item in ["home", "search", "mixes", "artists", "albums", "favorites", "downloads", "queue", "settings", "newPlaylist", "footer"] {
      XCTAssertTrue(app.element("sidebar.\(item)").exists, "sidebar.\(item)")
    }
    XCTAssertTrue(app.element("sidebar.playlist.1").exists)  // the demo's "Late night"
    XCTAssertTrue(app.staticTexts["TRACKS"].exists)
    XCTAssertTrue(app.element("playerBar").exists)
    XCTAssertTrue(app.staticTexts["NOTHING PLAYING"].exists)

    playMezzanine(app)
    let open = app.buttons["Open now playing"]
    XCTAssertEqual(open.value as? String, "Angel, Massive Attack")

    app.element("playerBar.queue").tap()
    XCTAssertTrue(app.element("sideColumn").waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["Risingson, Massive Attack, 4:58"].waitForExistence(timeout: 5))
    app.element("playerBar.lyrics").tap()
    XCTAssertTrue(app.buttons["You are my angel"].waitForExistence(timeout: 5))
    app.element("playerBar.lyrics").tap()
    XCTAssertTrue(app.element("sideColumn").waitForNonExistence(timeout: 5))

    // The song's title goes to its album.
    app.element("sidebar.home").tap()
    app.buttons["Angel, Massive Attack"].tap()
    XCTAssertTrue(app.staticTexts["LINER NOTES"].waitForExistence(timeout: 5))
  }

  @MainActor
  func testNowPlayingShowsUpNext() {
    let app = XCUIApplication.demo()
    app.launch()
    playMezzanine(app)
    app.buttons["Open now playing"].tap()
    XCTAssertTrue(app.element("nowPlaying.upNext").waitForExistence(timeout: 5))
    app.buttons["Inertia Creeps, Massive Attack, 5:56"].tap()
    XCTAssertTrue(app.staticTexts["Inertia Creeps"].waitForExistence(timeout: 5))
    app.buttons["Close now playing"].tap()
    XCTAssertTrue(app.buttons["Close now playing"].waitForNonExistence(timeout: 5))
  }

  @MainActor
  func testTheWebsKeyboardShortcuts() {
    let app = XCUIApplication.demo()
    app.launch()
    playMezzanine(app)
    let bar = app.element("playerBar")

    app.typeKey(" ", modifierFlags: [])
    XCTAssertTrue(bar.buttons["Play"].waitForExistence(timeout: 5))
    // Paused, so only the key moves the time: 10 s ahead.
    let seek = bar.sliders["Seek"]
    let before = seek.value as? String
    app.typeKey(XCUIKeyboardKey.rightArrow.rawValue, modifierFlags: [])
    XCTAssertNotEqual(seek.value as? String, before)
    app.typeKey("s", modifierFlags: [])
    XCTAssertTrue(bar.buttons["Shuffle"].isSelected)
    app.typeKey("m", modifierFlags: [])
    XCTAssertTrue(bar.buttons["Unmute"].waitForExistence(timeout: 5))
    app.typeKey("m", modifierFlags: [])
    XCTAssertTrue(bar.buttons["Mute"].waitForExistence(timeout: 5))
    // ↓ is the app's own volume, 5 % down (changing the volume unmutes, as on the web).
    app.typeKey(XCUIKeyboardKey.downArrow.rawValue, modifierFlags: [])
    let volume = app.element("playerBar.volume")
    expectation(for: NSPredicate(format: "value == '95%'"), evaluatedWith: volume)
    waitForExpectations(timeout: 5)

    // "/" goes to Search with the cursor in the field; letters typed there are text, not shortcuts.
    app.typeKey("/", modifierFlags: [])
    let field = app.searchFields.firstMatch
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    app.typeKey("s", modifierFlags: [])
    XCTAssertEqual((field.value as? String)?.lowercased(), "s")  // the field capitalizes the first letter
    XCTAssertTrue(bar.buttons["Shuffle"].isSelected)
  }

  @MainActor
  func testDraggingASongOntoTheQueue() {
    let app = XCUIApplication.demo()
    app.launch()
    playMezzanine(app)
    // A List doesn't report a tap on the row already selected: go through another item to Albums' first page.
    app.element("sidebar.home").tap()
    app.element("sidebar.albums").tap()
    app.buttons["Dummy, Portishead · 1994"].firstMatch.tap()
    let song = app.buttons["2. Sour Times, 4:14"]
    XCTAssertTrue(song.waitForExistence(timeout: 5))
    song.press(forDuration: 0.6, thenDragTo: app.element("sidebar.queue"), withVelocity: .slow, thenHoldForDuration: 0.5)
    XCTAssertTrue(app.staticTexts["Added 1 track to queue"].waitForExistence(timeout: 5))
  }

  @MainActor
  func testComesBackWhereItWas() throws {
    // On the simulator the scene's storage didn't survive XCTest terminating the app from the background (iOS treats
    // it as a forced quit, which discards scene state); the device checklist covers coming back.
    try XCTSkipUnless(ProcessInfo.processInfo.environment["PLAYARR_RESTORE"] == "1", "Scene state is checked on a device")
    let app = XCUIApplication.demo(["-UITestsRestore"])
    app.launch()
    app.element("sidebar.artists").tap()
    app.buttons["Portishead, 1 album · 3 tracks"].firstMatch.tap()
    XCTAssertTrue(app.staticTexts["Portishead"].waitForExistence(timeout: 5))
    // iOS keeps a scene's state when it goes to the background, and gives it back when it closed the app there.
    XCUIDevice.shared.press(.home)
    sleep(2)
    app.terminate()
    app.launch()
    XCTAssertTrue(app.staticTexts["Portishead"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.element("sidebar.artists").isSelected)
  }
}
