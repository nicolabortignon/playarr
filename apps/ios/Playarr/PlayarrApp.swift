import Foundation
import PlayarrUI
import SwiftUI

@main
struct PlayarrApp: App {
  @State private var model = PlayarrApp.makeModel()

  var body: some Scene {
    WindowGroup {
      RootView(model: model)
        .onOpenURL { model.open($0) }
    }
  }

  /// UI tests launch with `-UITests` (no servers, nothing kept between runs), plus `-UITestsDemo` to start signed in
  /// to the demo library, playing silence, or `-UITestsRequests` for the demo with Lidarr and an album to request.
  static func makeModel() -> AppModel {
    let arguments = ProcessInfo.processInfo.arguments
    if arguments.contains("-UITestsRequests") { return .demo(requests: true) }
    if arguments.contains("-UITestsDemo") { return .demo() }
    if arguments.contains("-UITests") { return .empty() }
    return .live()
  }
}
