import Foundation
import Testing
@testable import PlayarrUI

@MainActor @Suite struct LongQueueTests {
  @Test func listsAQueueOf5000SongsQuickly() {
    let session = demoSession()
    session.player.play(Demo.manyTracks(5000))
    let model = QueueModel(session: session)
    let took = ContinuousClock().measure {
      for _ in 0..<20 {
        _ = model.upcoming
        _ = model.header
      }
    }
    #expect(model.upcoming.count == 4999)
    #expect(model.header == "Up next · 4999 tracks · 333 hr 16 min")
    #expect(took < .seconds(1), "20 redraws' worth took \(took)")
  }
}
