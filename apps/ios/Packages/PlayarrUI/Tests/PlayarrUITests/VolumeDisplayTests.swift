import Testing
@testable import PlayarrUI

@Suite struct VolumeDisplayTests {
  @Test func showsTheSpeakerAsTheWebDoes() {
    #expect(VolumeDisplay(volume: 0.8, muted: false).systemImage == "speaker.wave.2.fill")
    #expect(VolumeDisplay(volume: 0.3, muted: false).systemImage == "speaker.wave.1.fill")
    #expect(VolumeDisplay(volume: 0, muted: false).systemImage == "speaker.slash.fill")
    #expect(VolumeDisplay(volume: 0.8, muted: true).systemImage == "speaker.slash.fill")
  }

  @Test func readsTheLevel() {
    #expect(VolumeDisplay(volume: 0.4, muted: false).valueText == "40%")
    #expect(VolumeDisplay(volume: 0.4, muted: true).valueText == "0%")
    #expect(VolumeDisplay(volume: 0.4, muted: true).muteLabel == "Unmute")
    #expect(VolumeDisplay(volume: 0.4, muted: false).muteLabel == "Mute")
  }
}
