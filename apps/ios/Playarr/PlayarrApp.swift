import Foundation
import PlayarrUI
import SwiftUI

@main
struct PlayarrApp: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  @State private var model = PlayarrApp.makeModel()

  init() {
    Typography.register()
  }

  var body: some Scene {
    WindowGroup {
      #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-UITestsDownloads") {
          DownloadsDemoView()
        } else {
          root
        }
      #else
        root
      #endif
    }
    // The keyboard's shortcuts, in the iPad's menu bar and the list shown while ⌘ is held.
    .commands { PlayarrCommands(model: model) }
  }

  private var root: some View {
    RootView(model: model)
      // No scroll bars anywhere: every page, list and sheet below inherits this.
      .scrollIndicators(.hidden)
      .onOpenURL { model.open($0) }
      // A UI test may hand over a session it started on a dev server (AccountsUITests).
      .task { if ProcessInfo.processInfo.arguments.contains("-UITests") { await model.signInForUITests() } }
  }

  /// UI tests launch with `-UITests` (no servers, nothing kept between runs; a dev server's session when the test hands
  /// one over in PLAYARR_UITEST_SERVER and PLAYARR_UITEST_TOKEN), plus `-UITestsDemo` to start signed in
  /// to the demo library, playing silence, or `-UITestsRequests` for the demo with Lidarr and an album to request.
  /// `-UITestsDownloads` (Debug builds) opens Library → Downloads on made-up downloads (`DownloadsDemoView`).
  static func makeModel() -> AppModel {
    let arguments = ProcessInfo.processInfo.arguments
    if arguments.contains("-UITestsRequests") { return .demo(requests: true) }
    if arguments.contains("-UITestsDemo") { return .demo() }
    if arguments.contains("-UITests") { return .empty() }
    return .live()
  }
}
