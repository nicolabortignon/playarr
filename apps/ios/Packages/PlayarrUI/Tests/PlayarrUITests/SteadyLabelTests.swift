import SwiftUI
import Testing
@testable import PlayarrUI

struct SteadyLabelTests {
  /// SwiftUI can make a ForEach's items while it draws an animation off the main thread (iOS 26): build 684 crashed as
  /// Play became Pause, the label's unseen words made by a closure of `body`, which is the main actor's. A function
  /// outside the main actor makes them now, so they can be made on any thread.
  @Test func makesTheWordsItMayShowOffTheMainThread() async {
    let room = await Task.detached {
      String(describing: type(of: SteadyLabel.room(for: .init(title: "Pause", systemImage: "pause.fill"))))
    }.value
    #expect(room.contains("Label"))
  }
}
