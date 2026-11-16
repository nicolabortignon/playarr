import XCTest

/// Downloads and songs kept as you listen, on the simulator against a real server (`make offline-check` starts one
/// with the web tour's library and runs this): an album downloaded from its page, then in Library → Downloads; another
/// played, so songs are kept as you listen; then "Keep up to" lowered to 512 MB and turned off, which lets go of the
/// kept songs and never of the download. Needs the server, an account and two of its albums, given to the test runner
/// (xcodebuild passes each TEST_RUNNER_<NAME> variable on as <NAME>):
///
///     TEST_RUNNER_PLAYARR_UITEST_SERVER=http://127.0.0.1:4100
///     TEST_RUNNER_PLAYARR_UITEST_ADMIN=<username> TEST_RUNNER_PLAYARR_UITEST_PASSWORD=<password>
///     TEST_RUNNER_PLAYARR_UITEST_ALBUMS="Air:Moon Safari|Portishead:Dummy"
///
/// Skipped without them, so the suite still passes where no server runs (CI).
final class OfflineTests: XCTestCase {
  override func setUpWithError() throws {
    try skipOnIPad()
    continueAfterFailure = false
  }

  @MainActor
  func testDownloadsAnAlbumAndLetsGoOfSongsKeptAsYouListenButNeverOfIt() async throws {
    let environment = ProcessInfo.processInfo.environment
    guard let server = environment["PLAYARR_UITEST_SERVER"].flatMap(URL.init(string:)),
      let username = environment["PLAYARR_UITEST_ADMIN"], let password = environment["PLAYARR_UITEST_PASSWORD"],
      let albums = environment["PLAYARR_UITEST_ALBUMS"]?.split(separator: "|").map({ $0.split(separator: ":", maxSplits: 1).map(String.init) }),
      albums.count == 2, albums.allSatisfy({ $0.count == 2 })
    else {
      throw XCTSkip("Run make -C apps/ios offline-check, which starts a server and runs this against it.")
    }
    let (downloaded, played) = (albums[0][1], albums[1][1])
    let dev = DevServer(url: server)
    let token = try await dev.signIn(username: username, password: password)
    addTeardownBlock { try? await dev.signOut(token: token) }

    let app = XCUIApplication()
    app.launchArguments = ["-UITests"]
    app.launchEnvironment = ["PLAYARR_UITEST_SERVER": server.absoluteString, "PLAYARR_UITEST_TOKEN": token]
    app.launch()
    XCTAssertTrue(app.tabBars.buttons["Search"].waitForExistence(timeout: 20), "Not signed in")

    // An album downloaded from its page: its button goes from Download through its progress to Downloaded.
    open(downloaded, by: albums[0][0], in: app)
    app.buttons["Download \(downloaded)"].tap()
    let done = app.buttons["Downloaded: remove \(downloaded) from this device"]
    XCTAssertTrue(done.waitForExistence(timeout: 120), "\(downloaded) didn't finish downloading")
    attach(app, "1 album downloaded")

    // Library → Downloads lists it.
    app.tabBars.buttons["Library"].tap()
    let downloads = app.button(startingWith: "Downloads")
    XCTAssertTrue(downloads.waitForExistence(timeout: 10), "No Downloads row in Library")
    downloads.tap()
    XCTAssertTrue(app.buttons["Play \(downloaded)"].waitForExistence(timeout: 10))
    attach(app, "2 Library, Downloads")

    // Another album played: the song playing and those after it are kept as you listen.
    open(played, by: albums[1][0], in: app)
    app.buttons["Play \(played)"].tap()
    XCTAssertTrue(app.buttons["Pause \(played)"].waitForExistence(timeout: 15), "\(played) didn't play")

    // Settings → Playback → On this device, from a tab's first page (where the account button is).
    app.tabBars.buttons["Home"].tap()
    let account = app.buttons["Account and settings"].firstMatch
    XCTAssertTrue(account.waitForExistence(timeout: 10))
    account.tap()
    app.buttons["Settings"].tap()
    app.buttons["settings.playback"].firstMatch.tap()
    // On this device is at the foot of the panel.
    let keepUpTo = app.button(startingWith: "Keep up to")
    for _ in 0..<8 where !keepUpTo.exists { app.swipeUp() }
    XCTAssertTrue(keepUpTo.waitForExistence(timeout: 5), "No Keep up to in Settings → Playback")
    let kept = app.staticTexts.matching(NSPredicate(format: "label MATCHES %@", "[1-9][0-9]* songs?")).firstMatch
    XCTAssertTrue(kept.waitForExistence(timeout: 30), "No song kept as you listen")
    XCTAssertTrue(app.button(startingWith: "Plus 1 download").exists, "The download isn't counted apart")
    attach(app, "3 kept as you listen")

    // Lowered to 512 MB: the few MB kept stay. Off: they go, the download stays.
    choose("512 MB", forKeepUpTo: app)
    XCTAssertTrue(kept.waitForExistence(timeout: 5), "512 MB let go of songs that fit in it")
    choose("Off", forKeepUpTo: app)
    XCTAssertTrue(kept.waitForNonExistence(timeout: 5), "Off kept songs")
    XCTAssertTrue(app.button(startingWith: "Plus 1 download").exists, "Off let go of the download")
    attach(app, "4 kept as you listen, off")

    app.button(startingWith: "Plus 1 download").tap()
    XCTAssertTrue(app.buttons["Play \(downloaded)"].waitForExistence(timeout: 10), "The download is gone from Downloads")
  }

  /// Opens an album through its artist, one of those Search suggests before anything's typed.
  @MainActor
  private func open(_ album: String, by artist: String, in app: XCUIApplication) {
    app.tabBars.buttons["Search"].tap()
    let suggested = app.buttons[artist].firstMatch
    // Search keeps the page it was left on: its tab, tapped again, goes back to its first.
    if !suggested.waitForExistence(timeout: 3) { app.tabBars.buttons["Search"].tap() }
    XCTAssertTrue(suggested.waitForExistence(timeout: 10), "Search doesn't suggest \(artist)")
    suggested.tap()
    let card = app.button(startingWith: "\(album),")
    XCTAssertTrue(card.waitForExistence(timeout: 10), "\(album) isn't on \(artist)'s page")
    card.tap()
    XCTAssertTrue(app.buttons["Play \(album)"].waitForExistence(timeout: 10), "\(album)'s page didn't open")
  }

  @MainActor
  private func choose(_ limit: String, forKeepUpTo app: XCUIApplication) {
    // Its label says what's chosen: "Keep up to, 2 GB".
    app.button(startingWith: "Keep up to").tap()
    let option = app.buttons[limit].firstMatch
    XCTAssertTrue(option.waitForExistence(timeout: 5), "No \(limit) in Keep up to")
    option.tap()
  }

  @MainActor
  private func attach(_ app: XCUIApplication, _ name: String) {
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = name
    shot.lifetime = .keepAlways
    add(shot)
  }
}
