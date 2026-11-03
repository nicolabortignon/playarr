import Foundation
import PlayarrAPI
import PlayarrPlayer
import Testing
@testable import PlayarrUI

@MainActor @Suite struct TrackSheetsTests {
  @Test func offersEditMixPointsOnlyWithDJMixOn() {
    let settings = PlaybackSettings(defaults: UserDefaults(suiteName: UUID().uuidString)!)
    let sheets = TrackSheets()
    sheets.settings = settings
    let song = MixPointsModelTests.song
    #expect(!sheets.offersMixPoints(for: song))
    settings.transitions = .dj
    #expect(sheets.offersMixPoints(for: song))
    var local = song
    local.recordingId = ""
    #expect(!sheets.offersMixPoints(for: local))
  }

  @Test func opensOneSheetPerSong() {
    let sheets = TrackSheets()
    sheets.showMetadata(700)
    #expect(sheets.metadata?.id == 700)
    sheets.editMixPoints(MixPointsModelTests.song)
    #expect(sheets.mixPoints?.id == 7)
  }
}
