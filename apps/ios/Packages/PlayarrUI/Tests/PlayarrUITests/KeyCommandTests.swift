import PlayarrAPI
import SwiftUI
import GameController
import Testing
@testable import PlayarrUI

/// The keyboard's player, writing down what it was asked.
@MainActor
final class FakeControls: PlaybackControlling {
  var song: Track?
  var time: Double = 0
  var duration: Double = 0
  var masterVolume: Double = 1
  var asked: [String] = []

  func togglePlay() { asked.append("togglePlay") }
  func seek(to seconds: Double) { asked.append("seek \(seconds)") }
  func next() { asked.append("next") }
  func previous() { asked.append("previous") }
  func setVolume(_ volume: Double) { masterVolume = volume; asked.append("volume \(volume)") }
  func toggleMute() { asked.append("mute") }
  func toggleShuffle() { asked.append("shuffle") }
}

@MainActor @Suite struct KeyCommandTests {
  func handler(_ controls: FakeControls, favorites: @escaping @MainActor (Track) -> Void = { _ in }, search: @escaping @MainActor () -> Void = {}) -> KeyCommandHandler {
    KeyCommandHandler(controls: controls, toggleFavorite: favorites, openSearch: search)
  }

  @Test func usesTheWebsKeys() {
    #expect(KeyCommand.playPause.key == .space)
    #expect(KeyCommand.next.key == .rightArrow && KeyCommand.next.modifiers == .shift)
    #expect(KeyCommand.seekForward.key == .rightArrow && KeyCommand.seekForward.modifiers == [])
    #expect(KeyCommand.search.key == "/")
    #expect(Set(KeyCommand.allCases.map { "\($0.key.character)\($0.modifiers.rawValue)" }).count == KeyCommand.allCases.count)
  }

  @Test func seeksTenSecondsWithinTheSong() {
    let controls = FakeControls()
    controls.song = Demo.mezzanineTracks[0]
    controls.duration = 379
    controls.time = 375
    let keys = handler(controls)
    keys.perform(.seekForward)
    controls.time = 4
    keys.perform(.seekBack)
    controls.time = 100
    keys.perform(.seekBack)
    #expect(controls.asked == ["seek 379.0", "seek 0.0", "seek 90.0"])
  }

  @Test func changesSongsAndPlaysOrPauses() {
    let controls = FakeControls()
    controls.song = Demo.mezzanineTracks[0]
    let keys = handler(controls)
    keys.perform(.playPause)
    keys.perform(.next)
    keys.perform(.previous)
    #expect(controls.asked == ["togglePlay", "next", "previous"])
  }

  @Test func movesTheVolumeInSteps() {
    let controls = FakeControls()
    controls.masterVolume = 0.97
    let keys = handler(controls)
    keys.perform(.volumeUp)
    keys.perform(.volumeDown)
    keys.perform(.volumeDown)
    #expect(controls.masterVolume == 0.9)
    controls.masterVolume = 0.02
    keys.perform(.volumeDown)
    #expect(controls.masterVolume == 0)
  }

  @Test func needsASongToPlayOrFavorite() {
    let controls = FakeControls()
    var favorited: [String] = []
    let keys = handler(controls, favorites: { favorited.append($0.title) })
    for command in [KeyCommand.playPause, .seekForward, .next, .favorite] { keys.perform(command) }
    keys.perform(.mute)
    keys.perform(.shuffle)
    #expect(controls.asked == ["mute", "shuffle"])
    controls.song = Demo.mezzanineTracks[0]
    keys.perform(.favorite)
    #expect(favorited == ["Angel"])
  }

  @Test func goesToSearch() {
    var searched = 0
    handler(FakeControls(), search: { searched += 1 }).perform(.search)
    #expect(searched == 1)
  }

  @Test func drivesTheSessionsPlayerAndRouter() {
    let session = demoSession()
    session.player.play(Demo.mezzanineTracks)
    let keys = KeyCommandHandler(session: session)
    keys.perform(.playPause)
    #expect(!session.player.queue.playing)
    keys.perform(.shuffle)
    #expect(session.player.queue.shuffle)
    keys.perform(.search)
    #expect(session.router.tab == .search)
  }

  @Test func readsTheShortcutsOut() {
    #expect(KeyboardShortcutsSection.spoken([["Shift", "←"], ["Shift", "→"]]) == "Shift + ← or Shift + →")
    #expect(KeyboardShortcutsSection.rows.count == 8)
  }

  @Test func listsTheShortcutsOnlyWhileAKeyboardIsAttached() {
    var attached = false
    let keyboard = HardwareKeyboard { attached }
    #expect(!keyboard.attached)
    #expect(!HardwareKeyboard.showsShortcuts(onPad: true, attached: keyboard.attached))
    // A keyboard connects: asked again, the list shows.
    attached = true
    keyboard.recheck()
    #expect(HardwareKeyboard.showsShortcuts(onPad: true, attached: keyboard.attached))
    // Disconnected again (no other keyboard left).
    attached = false
    keyboard.recheck()
    #expect(!keyboard.attached)
    // Where the shortcuts are menu commands: on an iPad. An iPhone has no menu bar to hold them.
    #expect(!HardwareKeyboard.showsShortcuts(onPad: false, attached: true))
    #expect(HardwareKeyboard.changes == [.GCKeyboardDidConnect, .GCKeyboardDidDisconnect])
  }
}
