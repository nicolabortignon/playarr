import PlayarrAPI
import PlayarrPlayer
import Testing
@testable import PlayarrUI

@Suite struct ActionRowTests {
  @Test func shuffleDropsItsWordBeforeThePagesOwnActionAndTheGapsCloseLast() {
    let shuffleOnly = ActionRowCompaction(shuffle: true)
    let withAction = ActionRowCompaction.steps(hasAction: true)
    #expect(withAction == [.none, shuffleOnly, ActionRowCompaction(shuffle: true, action: true), .all])
    #expect(ActionRowCompaction.steps(hasAction: false) == [.none, shuffleOnly, .all])
    // The page's action never loses its words while Shuffle keeps its own.
    for step in withAction where step.action { #expect(step.shuffle) }
    // Play loses its icon only once everything else has lost its words.
    #expect(withAction.filter(\.tight) == [.all])
  }

  @Test func playSaysPauseAndResumeOnlyForThePagesOwnQueue() {
    #expect(PlayState(isCurrent: false, playing: true) == .stopped)
    #expect(PlayState(isCurrent: true, playing: true) == .playing)
    #expect(PlayState(isCurrent: true, playing: false) == .paused)
    #expect(PlayState.allCases.map(\.label) == ["Play", "Pause", "Resume"])
    #expect(PlayState.allCases.map(\.systemImage) == ["play.fill", "pause.fill", "play.fill"])
    #expect(!PlayState.stopped.isCurrent && PlayState.paused.isCurrent)
  }

  @Test func knowsAPagesQueueByWhereItWasStarted() {
    var queue = QueueState()
    queue.queue = Demo.mezzanineTracks
    queue.order = Array(Demo.mezzanineTracks.indices)
    queue.pos = 0
    queue.source = PlaySource(label: "Road trip", href: "/playlists/5")
    queue.playing = true
    #expect(PlayState.of(queue, href: "/playlists/5") == .playing)
    #expect(PlayState.of(queue, href: "/playlists/6") == .stopped)
    queue.playing = false
    #expect(PlayState.of(queue, href: "/playlists/5") == .paused)
    // Nothing left to resume.
    queue.pos = -1
    #expect(PlayState.of(queue, href: "/playlists/5") == .stopped)
  }
}
