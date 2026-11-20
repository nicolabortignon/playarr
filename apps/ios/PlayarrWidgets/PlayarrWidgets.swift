import PlayarrWidgetData
import SwiftUI
import WidgetKit

/// Playarr's widgets and controls (plan 11). They show the snapshot the app writes to the App Group's folder and never
/// ask a server; their buttons name the app's audio playback intents, which the system performs in the app.
@main
struct PlayarrWidgets: WidgetBundle {
  var body: some Widget {
    QuickPlayWidget()
    JumpBackInWidget()
    MadeForYouWidget()
    NowPlayingWidget()
    FeelingLuckyControl()
  }
}

/// A widget's moment: the snapshot as the app last wrote it (nil before it has, or in a build without the App Group).
struct SnapshotEntry: TimelineEntry {
  let date: Date
  let snapshot: WidgetSnapshot?
}

/// Reads the snapshot. The app reloads the widgets whenever it writes a new one, so a timeline holds one entry and
/// never asks for another.
struct SnapshotProvider: TimelineProvider {
  func placeholder(in context: Context) -> SnapshotEntry {
    SnapshotEntry(date: .now, snapshot: .placeholder)
  }

  func getSnapshot(in context: Context, completion: @escaping (SnapshotEntry) -> Void) {
    // The gallery shows the widget as it would be, signed in, even before the app has written anything.
    let snapshot = WidgetStore.live()?.read()
    completion(SnapshotEntry(date: .now, snapshot: context.isPreview && snapshot?.account == nil ? .placeholder : snapshot))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<SnapshotEntry>) -> Void) {
    completion(Timeline(entries: [SnapshotEntry(date: .now, snapshot: WidgetStore.live()?.read())], policy: .never))
  }
}

extension Color {
  /// Playarr's near-black, `ink950` in the app.
  static let widgetInk = Color("WidgetBackground")
}

/// What a widget says with nobody signed in; tapping it opens the app.
struct SignInPrompt: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Image(systemName: "music.note")
        .font(.title2)
        .foregroundStyle(.tint)
      Spacer(minLength: 0)
      Text("Open Playarr to sign in")
        .font(.headline)
        .foregroundStyle(.white)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
  }
}
