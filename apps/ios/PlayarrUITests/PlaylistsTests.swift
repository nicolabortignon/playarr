import XCTest

/// Favorites and playlists on the simulator, against the demo library (`-UITestsDemo`: signed in, playing silence; the
/// demo server remembers favorites and playlists while the app runs).
final class PlaylistsTests: XCTestCase {
  override func setUpWithError() throws {
    try skipOnIPad()
    continueAfterFailure = false
  }

  @MainActor
  private func launch() -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-UITests", "-UITestsDemo"]
    app.launch()
    return app
  }

  /// Library → Albums → Mezzanine.
  @MainActor
  private func openMezzanine(_ app: XCUIApplication) {
    app.tabBars.buttons["Library"].tap()
    app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Albums")).firstMatch.tap()
    let mezzanine = app.buttons["Mezzanine, Massive Attack · 1998 · 3 of 5"].firstMatch
    XCTAssertTrue(mezzanine.waitForExistence(timeout: 5))
    mezzanine.tap()
  }

  /// A song's ⋯ → Add to playlist… → the playlist.
  @MainActor
  private func add(_ title: String, to playlist: String, _ app: XCUIApplication) {
    let more = app.buttons["More for \(title)"].firstMatch
    XCTAssertTrue(more.waitForExistence(timeout: 5))
    more.tap()
    app.buttons["Add to playlist…"].tap()
    let choice = app.buttons[playlist].firstMatch
    XCTAssertTrue(choice.waitForExistence(timeout: 5))
    choice.tap()
    XCTAssertTrue(app.staticTexts["Added “\(title)” to “\(playlist)”"].waitForExistence(timeout: 5), app.debugDescription)
  }

  @MainActor
  func testMakeAPlaylistAddSongsEditItAndDeleteIt() {
    let app = launch()
    app.tabBars.buttons["Library"].tap()
    let new = app.buttons["library.newPlaylist"]
    XCTAssertTrue(new.waitForExistence(timeout: 10))
    new.tap()
    let name = app.textFields["playlist.name"]
    XCTAssertTrue(name.waitForExistence(timeout: 5))
    name.typeText("Road trip")
    app.buttons["playlist.create"].tap()
    // A playlist made from nothing opens.
    XCTAssertTrue(app.staticTexts["This playlist is empty. Use Add to playlist… from any song’s ⋯ menu, an album, the queue or Now Playing."].waitForExistence(timeout: 5))

    openMezzanine(app)
    add("Angel", to: "Road trip", app)
    add("Risingson", to: "Road trip", app)

    app.tabBars.buttons["Library"].tap()
    app.tabBars.buttons["Library"].tap()  // back to the Library's first page
    let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Road trip")).firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 5))
    row.tap()
    let angel = app.buttons["Angel, Massive Attack, Mezzanine, 6:19"]
    let risingson = app.buttons["Risingson, Massive Attack, Mezzanine, 4:58"]
    XCTAssertTrue(risingson.waitForExistence(timeout: 5))
    XCTAssertLessThan(angel.frame.minY, risingson.frame.minY)

    // Edit shows the reorder handles. Dragging one isn't tested here: XCUITest's drags don't reach SwiftUI's list
    // reordering on the iOS 26.5 simulator (the row never lifts), so the move itself is PlaylistModelTests'.
    app.buttons["Edit"].tap()
    let handle = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@ AND label CONTAINS %@", "Reorder", "Risingson")).firstMatch
    XCTAssertTrue(handle.waitForExistence(timeout: 5), app.debugDescription)
    app.buttons["Done"].tap()

    app.buttons["Playlist actions"].tap()
    app.buttons["Delete playlist"].tap()
    let delete = app.buttons["Delete"].firstMatch
    XCTAssertTrue(delete.waitForExistence(timeout: 5))
    delete.tap()
    XCTAssertTrue(app.buttons["library.newPlaylist"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Road trip")).firstMatch.exists)
  }

  @MainActor
  func testAHeartShowsInFavorites() {
    let app = launch()
    openMezzanine(app)
    let heart = app.buttons["Add “Angel” to favorites"]
    XCTAssertTrue(heart.waitForExistence(timeout: 5))
    heart.tap()
    XCTAssertTrue(app.buttons["Remove “Angel” from favorites"].waitForExistence(timeout: 5))
    app.tabBars.buttons["Library"].tap()
    app.tabBars.buttons["Library"].tap()
    let favorites = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Favorites")).firstMatch
    XCTAssertTrue(favorites.waitForExistence(timeout: 5))
    favorites.tap()
    XCTAssertTrue(app.buttons["Angel, Massive Attack, Mezzanine, 6:19"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["Risingson, Massive Attack, Mezzanine, 4:58"].exists)
  }
}
