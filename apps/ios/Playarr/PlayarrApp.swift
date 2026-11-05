import AppIntents
import Foundation
import PlayarrUI
import SwiftUI

@main
struct PlayarrApp: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  @State private var model: AppModel

  init() {
    Typography.register()
    let model = PlayarrApp.makeModel()
    _model = State(initialValue: model)
    // The Shortcuts actions and Siri find the app's model through this (`@Dependency`), even when they start it.
    AppDependencyManager.shared.add(dependency: model)
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
  /// With the demo, `-UITestsOffline` makes the server unreachable, `-UITestsLongQueue` queues 5,000 songs,
  /// `-UITestsTurnToOpen` turns on Settings → Appearance → Turn to open, and `-UITestsRestore` brings back where the
  /// last run was (otherwise each run starts on Home).
  /// `-UITestsDownloads` (Debug builds) opens Library → Downloads on made-up downloads (`DownloadsDemoView`).
  static func makeModel() -> AppModel {
    let arguments = ProcessInfo.processInfo.arguments
    if arguments.contains("-UITestsRequests") {
      let model = AppModel.demo(requests: true)
      model.restoresPlace = arguments.contains("-UITestsRestore")
      return model
    }
    if arguments.contains("-UITestsDemo") {
      // -UITestsOffline: a server that can't be reached. -UITestsLongQueue: 5,000 songs queued, paused.
      let model = AppModel.demo(api: arguments.contains("-UITestsOffline") ? OfflineAPI() : nil)
      model.restoresPlace = arguments.contains("-UITestsRestore")
      model.appearance.turnToOpen = arguments.contains("-UITestsTurnToOpen")
      if arguments.contains("-UITestsLongQueue"), let player = model.session?.player {
        player.play(Demo.manyTracks(5000))
        player.setPlaying(false)
      }
      return model
    }
    if arguments.contains("-UITests") {
      let model = AppModel.empty()
      model.restoresPlace = arguments.contains("-UITestsRestore")
      return model
    }
    return .live()
  }
}
