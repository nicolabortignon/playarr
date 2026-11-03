import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct CoverPickerTests {
  @Test func startsPastTheCoversOwnVariationAndShufflesOn() {
    var playlist = Listening.playlist(items: [Listening.three[0]])
    playlist.cover = Listening.cover(layout: .horizon, variant: 2)
    let picker = CoverPickerModel(playlist: playlist)
    #expect(CoverPickerModel.styles.map(\.label) == ["Currents", "Colonies", "Horizon", "Ridges", "Grooves", "Blocks"])
    #expect(picker.chosen == .horizon)
    #expect(picker.intro == "Drawn from the 1 songs in this playlist as they are now.")
    #expect(picker.preview(.currents) == "/art/playlist/5/preview?layout=currents&variant=3")
    picker.shuffle()
    #expect(picker.preview(.blocks) == "/art/playlist/5/preview?layout=blocks&variant=4")
  }

  @Test func describesWhatTheCoverIsMadeOf() {
    var cover = Listening.cover(layout: .ridges)
    cover.tempo = 120
    cover.styles = ["Electronic", "House"]
    cover.era = [1990, 1999]
    cover.energy = 0.724
    let note = CoverNote(cover)
    #expect(note.listening == nil)
    #expect(note.story == "Each line is a song, traced from its loudness over time.")
    #expect(note.facts == "120 BPM · Electronic / House · 1990–1999 · energy 72%")
    cover.era = [2001, 2001]
    cover.tempo = nil
    cover.styles = []
    #expect(CoverNote(cover).facts == "2001 · energy 72%")
  }

  @Test func saysItsStillListeningUntilTheCoverIsPinned() {
    #expect(CoverNote(Listening.cover(pending: true)).listening == "Listening to the songs to draw the cover… 1 of 3")
  }
}
