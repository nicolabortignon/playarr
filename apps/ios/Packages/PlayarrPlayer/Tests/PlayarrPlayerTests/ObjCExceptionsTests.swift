import AVFoundation
import Foundation
import ObjCExceptions
import Testing

struct ObjCExceptionsTests {
  @Test func anExceptionComesBackAsAnError() {
    #expect {
      try ObjCExceptions.catching { NSException(name: .internalInconsistencyException, reason: "the deck stopped", userInfo: nil).raise() }
    } throws: { error in
      let error = error as NSError
      return error.domain == NSExceptionName.internalInconsistencyException.rawValue && error.localizedDescription == "the deck stopped"
    }
  }

  @Test func aBlockThatRaisesNothingRunsOnce() throws {
    var runs = 0
    try ObjCExceptions.catching { runs += 1 }
    #expect(runs == 1)
  }

  /// What AudioEngine.startNodes guards against: AVFoundation raises when a node can't play, which would end the app.
  /// On iOS that's a node told to play as its engine stops itself; on the Mac, where that doesn't raise, a node that
  /// belongs to no engine.
  @Test func aNodeThatCantPlayIsAnErrorNotACrash() {
    let node = AVAudioPlayerNode()
    #expect {
      try ObjCExceptions.catching { node.play() }
    } throws: { error in
      (error as NSError).domain == "com.apple.coreaudio.avfaudio"
    }
  }
}
