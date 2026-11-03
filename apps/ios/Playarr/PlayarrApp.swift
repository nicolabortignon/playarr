import Foundation
import PlayarrUI
import SwiftUI

@main
struct PlayarrApp: App {
  /// UI tests launch with `-UITests`: no servers, and nothing kept between runs.
  @State private var model = ProcessInfo.processInfo.arguments.contains("-UITests") ? AppModel.empty() : AppModel.live()

  var body: some Scene {
    WindowGroup {
      RootView(model: model)
        .onOpenURL { model.open($0) }
    }
  }
}
