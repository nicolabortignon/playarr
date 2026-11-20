import AppIntents
import PlayarrWidgetData
import SwiftUI
import WidgetKit

/// Feeling lucky as a control: in Control Center, on the Lock Screen or on the Action button, 15 songs for this hour.
struct FeelingLuckyControl: ControlWidget {
  var body: some ControlWidgetConfiguration {
    StaticControlConfiguration(kind: WidgetKind.luckyControl) {
      ControlWidgetButton(action: FeelingLuckyIntent()) {
        Label("Feeling lucky", systemImage: "sparkles")
      }
    }
    .displayName("Feeling lucky")
    .description("Plays 15 songs put together for this hour, new every time.")
  }
}
