import XCTest

/// Settings → Accounts on the simulator, against the dev server: an admin adds an account and sees its setup
/// code. Needs the dev server and an admin's sign-in, given to the test runner (xcodebuild passes each
/// TEST_RUNNER_<NAME> variable on as <NAME>):
///
///     TEST_RUNNER_PLAYARR_UITEST_SERVER=http://localhost:4000
///     TEST_RUNNER_PLAYARR_UITEST_ADMIN=<username> TEST_RUNNER_PLAYARR_UITEST_PASSWORD=<password>
///
/// Skipped without them, so the suite still passes where no dev server runs (CI).
final class AccountsUITests: XCTestCase {
  @MainActor
  func testAddingAnAccountShowsItsSetupCode() async throws {
    let environment = ProcessInfo.processInfo.environment
    guard let server = environment["PLAYARR_UITEST_SERVER"].flatMap(URL.init(string:)),
      let admin = environment["PLAYARR_UITEST_ADMIN"], let password = environment["PLAYARR_UITEST_PASSWORD"]
    else {
      throw XCTSkip("Set TEST_RUNNER_PLAYARR_UITEST_SERVER, TEST_RUNNER_PLAYARR_UITEST_ADMIN and TEST_RUNNER_PLAYARR_UITEST_PASSWORD to run this against the dev server.")
    }
    let dev = DevServer(url: server)
    let token = try await dev.signIn(username: admin, password: password)
    let username = "uitest\(UInt32.random(in: 100_000...999_999))"
    addTeardownBlock {
      try? await dev.removeAccount(username, token: token)
      try? await dev.signOut(token: token)
    }

    let app = XCUIApplication()
    app.launchArguments = ["-UITests"]
    app.launchEnvironment = ["PLAYARR_UITEST_SERVER": server.absoluteString, "PLAYARR_UITEST_TOKEN": token]
    app.launch()

    let menu = app.buttons["Account and settings"].firstMatch
    XCTAssertTrue(menu.waitForExistence(timeout: 15), "No account menu: is the app signed in?")
    menu.tap()
    let settings = app.buttons["settings"].firstMatch
    XCTAssertTrue(settings.waitForExistence(timeout: 5))
    settings.tap()
    let accounts = app.buttons["settings.accounts"].firstMatch
    XCTAssertTrue(accounts.waitForExistence(timeout: 5))
    accounts.tap()

    let add = app.buttons["accounts.add"]
    XCTAssertTrue(add.waitForExistence(timeout: 10), "No Add account: is \(admin) an admin?")
    add.tap()
    let name = app.textFields["account.name"]
    XCTAssertTrue(name.waitForExistence(timeout: 5))
    name.tap()
    name.typeText("UI Test")
    let user = app.textFields["account.username"]
    user.tap()
    user.typeText(username)
    app.buttons["account.submit"].tap()

    let code = app.staticTexts["setup.code"]
    XCTAssertTrue(code.waitForExistence(timeout: 10))
    XCTAssertNotNil(code.label.range(of: "^[A-HJKMNP-Z2-9]{8}$", options: .regularExpression), code.label)
    XCTAssertTrue(app.staticTexts["setup.link"].label.hasSuffix("/redeem?code=\(code.label)"), app.staticTexts["setup.link"].label)
  }
}
