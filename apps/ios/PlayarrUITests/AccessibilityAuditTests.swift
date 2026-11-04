import XCTest

/// Xcode's accessibility audit (labels, contrast, hit regions, Dynamic Type, clipped text, traits) on each main
/// screen of the demo library, on the iPhone and on the iPad, and at the largest text size.
final class AccessibilityAuditTests: XCTestCase {
  override func setUpWithError() throws {
    // Every screen's issues are worth seeing in one run.
    continueAfterFailure = true
  }

  /// Every check but the two about text size: at the usual size the audit only predicts how text would grow, and
  /// reported the sidebar's system-drawn rows as not growing; `testTheLargestTextSize` draws the screens at AX5 and
  /// measures it.
  static let screenChecks = XCUIAccessibilityAuditType.all.subtracting([.dynamicType, .textClipped])

  @MainActor
  private func audit(_ app: XCUIApplication, _ screen: String, _ types: XCUIAccessibilityAuditType = screenChecks) throws {
    try XCTContext.runActivity(named: "Audit: \(screen)") { _ in
      try app.performAccessibilityAudit(for: types) { issue in
        let ignored = AuditExceptions.ignores(issue, in: app)
        if !ignored {
          let e = issue.element
          print("AUDIT [\(screen)] \(issue.compactDescription) {\(issue.detailedDescription)} | type=\(e.map { String($0.elementType.rawValue) } ?? "-") label=\(e?.label ?? "-") id=\(e?.identifier ?? "-") frame=\(e?.frame ?? .zero)")
        }
        return ignored
      }
    }
  }

  @MainActor
  private func playMezzanine(_ app: XCUIApplication) {
    app.buttons["Play Mezzanine"].tap()
    XCTAssertTrue(app.buttons["Pause Mezzanine"].waitForExistence(timeout: 5))
  }

  @MainActor
  func testPhoneScreens() throws {
    try skipOnIPad()
    let app = XCUIApplication.demo()
    app.launch()
    XCTAssertTrue(app.staticTexts["8 tracks across 3 albums, 45 min of music waiting in your library."].waitForExistence(timeout: 10))
    try audit(app, "Home")

    app.tabBars.buttons["Library"].tap()
    try audit(app, "Library")
    app.button(startingWith: "Albums").tap()
    try audit(app, "Albums")
    app.buttons["Mezzanine, Massive Attack · 1998 · 3 of 5"].firstMatch.tap()
    XCTAssertTrue(app.staticTexts["LINER NOTES"].waitForExistence(timeout: 5))
    try audit(app, "Album")
    playMezzanine(app)

    app.tabBars.buttons["Library"].tap()
    app.button(startingWith: "Artists").tap()
    app.buttons["Massive Attack, 2 albums · 5 tracks"].firstMatch.tap()
    try audit(app, "Artist")

    app.tabBars.buttons["Queue"].tap()
    XCTAssertTrue(app.buttons["Risingson, Massive Attack, 4:58"].waitForExistence(timeout: 5))
    try audit(app, "Queue")

    app.buttons["Open now playing"].tap()
    XCTAssertTrue(app.buttons["Close now playing"].waitForExistence(timeout: 5))
    try audit(app, "Now Playing")
    app.buttons["Lyrics"].tap()
    XCTAssertTrue(app.buttons["You are my angel"].waitForExistence(timeout: 5))
    try audit(app, "Lyrics")
    app.buttons["Close now playing"].tap()

    app.tabBars.buttons["Library"].tap()
    app.buttons["Settings"].tap()
    try audit(app, "Settings")
    app.buttons["Playback"].tap()
    try audit(app, "Settings → Playback")
    app.navigationBars.buttons.firstMatch.tap()
    app.buttons["Appearance"].tap()
    try audit(app, "Settings → Appearance")

    // Last: the search tab turns the tab bar into its search field.
    app.tabBars.buttons["Search"].tap()
    try audit(app, "Search")
  }

  @MainActor
  func testIPadScreens() throws {
    try XCTSkipUnless(isPad, "iPad only")
    XCUIDevice.shared.orientation = .landscapeLeft
    let app = XCUIApplication.demo()
    app.launch()
    XCTAssertTrue(app.element("sidebar.home").waitForExistence(timeout: 10))
    try audit(app, "Home with the sidebar and player bar")
    app.element("sidebar.albums").tap()
    try audit(app, "Albums")
    app.buttons["Mezzanine, Massive Attack · 1998 · 3 of 5"].firstMatch.tap()
    XCTAssertTrue(app.staticTexts["LINER NOTES"].waitForExistence(timeout: 5))
    playMezzanine(app)
    try audit(app, "Album, playing")
    app.element("playerBar.queue").tap()
    XCTAssertTrue(app.element("sideColumn").waitForExistence(timeout: 5))
    try audit(app, "Queue column")
    app.element("playerBar.lyrics").tap()
    try audit(app, "Lyrics column")
    app.buttons["Open now playing"].tap()
    XCTAssertTrue(app.element("nowPlaying.upNext").waitForExistence(timeout: 5))
    try audit(app, "Now Playing with Up next")
    app.buttons["Close now playing"].tap()
    app.element("sidebar.settings").tap()
    try audit(app, "Settings")
  }

  /// The largest accessibility text size (AX5): nothing essential is cut short, everything grows.
  @MainActor
  func testTheLargestTextSize() throws {
    let app = XCUIApplication.demo(["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
    app.launch()
    let types: XCUIAccessibilityAuditType = [.dynamicType, .textClipped]
    if isPad {
      XCUIDevice.shared.orientation = .landscapeLeft
      XCTAssertTrue(app.element("sidebar.albums").waitForExistence(timeout: 10))
      app.element("sidebar.albums").tap()
    } else {
      XCTAssertTrue(app.tabBars.buttons["Library"].waitForExistence(timeout: 10))
      try audit(app, "Home at AX5", types)
      app.tabBars.buttons["Library"].tap()
      app.button(startingWith: "Albums").tap()
    }
    app.buttons["Mezzanine, Massive Attack · 1998 · 3 of 5"].firstMatch.tap()
    XCTAssertTrue(app.staticTexts["LINER NOTES"].waitForExistence(timeout: 5))
    playMezzanine(app)
    try audit(app, "Album at AX5", types)
    app.buttons["Open now playing"].tap()
    XCTAssertTrue(app.buttons["Close now playing"].waitForExistence(timeout: 5))
    try audit(app, "Now Playing at AX5", types)
  }

  /// Library → Downloads with phase 7's made-up downloads.
  @MainActor
  func testDownloads() throws {
    let app = XCUIApplication()
    app.launchArguments = ["-UITestsDownloads"]
    app.launch()
    XCTAssertTrue(app.staticTexts["Mezzanine"].waitForExistence(timeout: 10))
    try audit(app, "Downloads")
  }
}

/// Issues the audit reports that aren't the app's to fix. Each says what, where and why; add one only after
/// trying to fix the view (Task 25), never to get a run green.
enum AuditExceptions {
  @MainActor
  static func ignores(_ issue: XCUIAccessibilityAuditIssue, in app: XCUIApplication) -> Bool {
    // The tab bar's own labels don't grow with Dynamic Type: iOS shows them in the large content viewer instead
    // (press and hold a tab at the accessibility sizes).
    if issue.auditType == .dynamicType, let label = issue.element?.label, app.tabBars.buttons[label].exists {
      return true
    }
    // The audit reads colours from a screenshot: text scrolled under the tab bar's or the player bar's glass is
    // blurred into it. The same text passes once it's scrolled into view.
    if issue.auditType == .contrast, let frame = issue.element?.frame {
      for bar in [app.tabBars.firstMatch, app.descendants(matching: .any).matching(identifier: "playerBar").firstMatch] where bar.exists {
        if frame.maxY > bar.frame.minY { return true }
      }
    }
    // Contrast reported against SwiftUI's internal nodes with no element and no text (over Liquid Glass and the
    // blurred cover): there's nothing on them to read, and nothing to point a fix at.
    if issue.auditType == .contrast, issue.element == nil || issue.element?.label.isEmpty == true {
      return true
    }
    // The navigation bar's back button is the system's: at the accessibility sizes iOS shortens it and offers the
    // large content viewer on a long press.
    if issue.auditType == .textClipped, let label = issue.element?.label, app.navigationBars.buttons[label].exists {
      return true
    }
    // The system's search field truncates its own placeholder in the iOS 26 tab bar.
    if issue.auditType == .textClipped, issue.element?.elementType == .searchField {
      return true
    }
    return false
  }
}
