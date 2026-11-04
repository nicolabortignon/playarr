import PlayarrPlayer
import Testing
@testable import PlayarrUI

@MainActor @Suite struct UpNextPreviewTests {
  @Test func listsTheNextFourSongs() {
    let player = demoSession().player
    player.play(Demo.mezzanineTracks + Demo.protectionTracks + Demo.dummyTracks)
    let entries = UpNextPreview.entries(player.queue)
    #expect(entries.map(\.track.title) == ["Risingson", "Inertia Creeps", "Protection", "Karmacoma"])
    #expect(entries.map(\.orderPos) == [1, 2, 3, 4])
    player.jump(to: 6)
    #expect(UpNextPreview.entries(player.queue).map(\.track.title) == ["Glory Box"])
    #expect(UpNextPreview.entries(QueueState()).isEmpty)
  }
}
