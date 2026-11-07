import Foundation
import Testing
@testable import PlayarrUI

@MainActor @Suite struct ThemeTests {
  func settings() -> AppearanceSettings { AppearanceSettings(defaults: UserDefaults(suiteName: UUID().uuidString)!) }

  @Test func followsTheCoverUnlessAColourIsChosen() async {
    let appearance = settings()
    let theme = Theme(appearance: appearance)
    #expect(theme.accent == Theme.defaultAccent)
    appearance.accent = .fixed(.sky)
    #expect(theme.accent == RGB(hex: 0x38bdf8))
  }

  @Test func remembersTheChoices() {
    let defaults = UserDefaults(suiteName: UUID().uuidString)!
    let first = AppearanceSettings(defaults: defaults)
    first.accent = .fixed(.violet)
    first.motion = .reduce
    first.formatBadges = false
    let again = AppearanceSettings(defaults: defaults)
    #expect(again.accent == .fixed(.violet))
    #expect(again.motion == .reduce)
    #expect(!again.formatBadges)
    #expect(!again.statsForNerds)
  }

  @Test func takesTheSongsCoverAccentAtOnceOrangeWhenTheServerFoundNone() async {
    let theme = Theme(appearance: settings())
    let song = Demo.protectionTracks[0]
    // No image cache: the color can only have come from the song.
    await theme.follow(song, bpm: 87, images: nil, reduceMotion: true)
    #expect(theme.accent == RGB(hex: 0xc68258))
    // Mezzanine's cover was read and has no color to give: Playarr's orange, without reading the picture.
    await theme.follow(Demo.mezzanineTracks[0], bpm: 80, images: nil, reduceMotion: true)
    #expect(theme.accent == Theme.defaultAccent)
  }

  @Test func knowsWhatTheServerHasReadOfACover() {
    #expect(Theme.knownAccent(coverAccent: "#5b8fd9", coverColor: "#10203a") == .some(RGB(hex: 0x5b8fd9)))
    #expect(Theme.knownAccent(coverAccent: nil, coverColor: "#808080") == .some(nil))
    #expect(Theme.knownAccent(coverAccent: nil, coverColor: nil) == nil)
    #expect(RGB(css: "#ff7a1a") == RGB(hex: 0xff7a1a))
    #expect(RGB(css: "ff7a1a") == nil)
    #expect(RGB(css: "#fff") == nil)
  }

  @Test func glidesToANewSongsColorOverOneBeatOfIt() {
    #expect(Theme.glide(bpm: 120) == 0.5)
    #expect(abs(Theme.glide(bpm: 174) - 0.345) < 0.001)
    #expect(Theme.glide(bpm: nil) == 0.8)
    #expect(Theme.glide(bpm: 0) == 0.8)
    // A misread tempo doesn't make it snap or crawl.
    #expect(Theme.glide(bpm: 40) == 1.2)
    #expect(Theme.glide(bpm: 400) == 0.3)
  }

  @Test func motionFollowsTheDeviceOnlyOnSystem() {
    let appearance = settings()
    #expect(appearance.reduceMotion(system: true))
    appearance.motion = .full
    #expect(!appearance.reduceMotion(system: true))
    appearance.motion = .reduce
    #expect(appearance.reduceMotion(system: false))
  }
}
