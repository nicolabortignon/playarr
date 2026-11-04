import XCTest

/// The App Store screenshots in store/screenshots. `make screenshots` (scripts/screenshots.mjs) runs this on
/// simulators of its own, signed in to a local Playarr server that holds only Creative Commons albums, and passes
/// the server, the account and the album to feature as PLAYARR_* variables. Ordinary test runs skip it.
/// Each screenshot is an attachment named like its file ("01-now-playing"); the number is its place on the App
/// Store, not the order it's taken in.
final class StoreScreenshots: XCTestCase {
    private let env = ProcessInfo.processInfo.environment

    override func setUpWithError() throws {
        try XCTSkipUnless(env["PLAYARR_SCREENSHOTS"] == "1", "Taken by make screenshots only")
        continueAfterFailure = false
    }

    @MainActor
    func testStoreScreenshots() throws {
        let app = XCUIApplication()
        app.launch()
        if env["PLAYARR_LANDSCAPE"] == "1" { XCUIDevice.shared.orientation = .landscapeLeft }
        addUIInterruptionMonitor(withDescription: "Local network or saving the password") { alert in
            for label in ["Allow", "Not Now"] where alert.buttons[label].exists {
                alert.buttons[label].tap()
                return true
            }
            return false
        }
        try signIn(app)

        // Home, with the listening screenshots.mjs seeded: Jump back in and the mixes.
        XCTAssertTrue(app.staticTexts["Jump back in"].waitForExistence(timeout: 30))
        shot("02-home")

        // The albums: the sidebar's Albums on iPad; on iPhone, the Library tab, then its Albums.
        let iPad = UIDevice.current.userInterfaceIdiom == .pad
        if iPad {
            tab(app, "sidebar.albums")
            shot("05-library")
        } else {
            app.tabBars.buttons["Library"].tap()
            settle(seconds: 2)
            shot("05-library")
            tab(app, "Albums")
        }

        let album = try XCTUnwrap(env["PLAYARR_ALBUM"])
        let cover = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", album)).firstMatch
        XCTAssertTrue(cover.waitForExistence(timeout: 10))
        cover.tap()
        XCTAssertTrue(app.staticTexts[album].waitForExistence(timeout: 10))
        shot("03-album")

        app.buttons["Play \(album)"].firstMatch.tap()
        // The phone's mini player and the iPad's player bar both open Now Playing with this button.
        let open = app.buttons["Open now playing"].firstMatch
        XCTAssertTrue(open.waitForExistence(timeout: 15))
        open.tap()
        XCTAssertTrue(app.buttons["Lyrics"].waitForExistence(timeout: 10))
        settle(seconds: 4) // the artwork, its accent colour and a few seconds of playing
        shot("01-now-playing")

        app.buttons["Lyrics"].tap()
        settle(seconds: 3)
        shot("04-lyrics")
    }

    @MainActor
    private func signIn(_ app: XCUIApplication) throws {
        let address = app.textFields["Server address"]
        XCTAssertTrue(address.waitForExistence(timeout: 20))
        address.tap()
        address.typeText(try XCTUnwrap(env["PLAYARR_SERVER"]))
        app.buttons["Connect"].tap()
        let username = app.textFields["Username"]
        XCTAssertTrue(username.waitForExistence(timeout: 20))
        username.tap()
        username.typeText(try XCTUnwrap(env["PLAYARR_USERNAME"]))
        let password = app.secureTextFields["Password"]
        password.tap()
        password.typeText(try XCTUnwrap(env["PLAYARR_PASSWORD"]))
        app.buttons["Sign in"].tap()
        app.tap() // lets the interruption monitor answer an alert, if one came up
    }

    /// A tab or a row on iPhone, a sidebar item (by its identifier) on iPad.
    @MainActor
    private func tab(_ app: XCUIApplication, _ name: String) {
        let button = app.descendants(matching: .any)[name].firstMatch
        XCTAssertTrue(button.waitForExistence(timeout: 10))
        button.tap()
        settle(seconds: 2)
    }

    @MainActor
    private func shot(_ name: String) {
        settle(seconds: 1.5)
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// Waits for images to load and animations to end.
    private func settle(seconds: TimeInterval) {
        RunLoop.current.run(until: Date().addingTimeInterval(seconds))
    }
}
