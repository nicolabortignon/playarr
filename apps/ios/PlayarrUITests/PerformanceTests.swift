import XCTest

/// Checks that need no Instruments: the app opens quickly, and a queue of 5,000 songs scrolls.
final class PerformanceTests: XCTestCase {
  /// The demo library's Home shows within 10 s of launching (cold, on a simulator that has been busy with UI tests,
  /// it took about 6 s): a launch that blocks on work, such as reading a whole cache on the main thread, shows up here.
  @MainActor
  func testOpensQuickly() {
    let app = XCUIApplication.demo()
    let started = Date()
    app.launch()
    XCTAssertTrue(app.staticTexts["8 tracks across 3 albums, 45 min of music waiting in your library."].waitForExistence(timeout: 15))
    let seconds = Date().timeIntervalSince(started)
    XCTAssertLessThan(seconds, 10, "Home took \(seconds) s to show")
  }

  /// Xcode's launch metric, five launches, for the result bundle. Slow, so only with
  /// `TEST_RUNNER_PLAYARR_PERF=1 make -C apps/ios test-app`.
  @MainActor
  func testLaunchMetric() throws {
    try XCTSkipUnless(ProcessInfo.processInfo.environment["PLAYARR_PERF"] == "1", "Set TEST_RUNNER_PLAYARR_PERF=1")
    measure(metrics: [XCTApplicationLaunchMetric()]) {
      XCUIApplication.demo().launch()
    }
  }

  /// 5,000 songs in Up next (`-UITestsLongQueue`): the list builds its rows as they come on screen, so flicking
  /// through it keeps up, and rows far down appear.
  @MainActor
  func testAQueueOf5000SongsScrolls() throws {
    let app = XCUIApplication.demo(["-UITestsLongQueue"])
    app.launch()
    if isPad {
      XCTAssertTrue(app.element("sidebar.queue").waitForExistence(timeout: 10))
      app.element("sidebar.queue").tap()
    } else {
      XCTAssertTrue(app.tabBars.buttons["Queue"].waitForExistence(timeout: 10))
      app.tabBars.buttons["Queue"].tap()
    }
    let second = app.buttons["Song 2, Massive Attack, 4:00"]
    XCTAssertTrue(second.waitForExistence(timeout: 10))
    let list = app.collectionViews.firstMatch
    // No stopwatch here: XCTest spends almost 3 s per swipe checking for interruptions, whatever the app does.
    // Hitches are what the scrolling metric below measures.
    for _ in 0..<15 { list.swipeUp(velocity: .fast) }
    XCTAssertFalse(second.exists && second.isHittable)
    // The rows on screen now are far down the queue: the list built them as they came.
    let rows = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Song '")).allElementsBoundByIndex
    let shown = rows.filter(\.isHittable).compactMap { Int($0.label.dropFirst(5).prefix(while: \.isNumber)) }
    XCTAssertGreaterThan(shown.max() ?? 0, 50, "rows further down were drawn")

    if ProcessInfo.processInfo.environment["PLAYARR_PERF"] == "1" {
      let options = XCTMeasureOptions()
      options.invocationOptions = [.manuallyStop]
      measure(metrics: [XCTOSSignpostMetric.scrollingAndDecelerationMetric], options: options) {
        list.swipeUp(velocity: .fast)
        stopMeasuring()
        list.swipeDown(velocity: .fast)
      }
    }
  }
}
