import XCTest

extension XCUIApplication {
  /// The app signed in to the demo library, playing silence (phase 4's `-UITestsDemo`), plus `extra` arguments.
  static func demo(_ extra: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-UITests", "-UITestsDemo"] + extra
    return app
  }

  /// Anything with this accessibility identifier (sidebar rows are cells, buttons or other elements, depending on
  /// the iOS version).
  func element(_ identifier: String) -> XCUIElement {
    descendants(matching: .any).matching(identifier: identifier).firstMatch
  }

  /// A button whose label starts with `prefix`: Library's rows read "Albums, 3".
  func button(startingWith prefix: String) -> XCUIElement {
    buttons.matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
  }
}

extension XCTestCase {
  /// XCTest calls `setUp` and the tests on the main thread.
  var isPad: Bool { MainActor.assumeIsolated { UIDevice.current.userInterfaceIdiom == .pad } }

  /// The phone's flows go through the tab bar; a full-screen iPad shows the sidebar instead (IPadLayoutTests).
  /// Call it first in a phone test class's `setUpWithError()`.
  func skipOnIPad() throws {
    try XCTSkipIf(isPad, "Phone layout; IPadLayoutTests covers the iPad")
  }
}
