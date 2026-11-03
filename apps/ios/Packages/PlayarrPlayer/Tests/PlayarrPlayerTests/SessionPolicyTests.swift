import Testing
@testable import PlayarrPlayer

struct SessionPolicyTests {
  @Test func interruptionsPauseAndResumeOnlyWhenTheSystemSaysSo() {
    var policy = SessionPolicy()
    #expect(policy.action(for: .interruptionBegan, playing: true) == .pause)
    #expect(policy.action(for: .interruptionEnded(shouldResume: true), playing: false) == .resume)
    #expect(policy.action(for: .interruptionBegan, playing: false) == .none)
    #expect(policy.action(for: .interruptionEnded(shouldResume: true), playing: false) == .none)
    #expect(policy.action(for: .interruptionBegan, playing: true) == .pause)
    #expect(policy.action(for: .interruptionEnded(shouldResume: false), playing: false) == .none)
    #expect(policy.action(for: .oldDeviceUnavailable, playing: true) == .pause)
    #expect(policy.action(for: .mediaServicesReset, playing: true) == .rebuild)
  }
}
