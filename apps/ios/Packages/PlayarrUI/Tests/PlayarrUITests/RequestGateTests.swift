import PlayarrAPI
import Testing
@testable import PlayarrUI

@Suite struct RequestGateTests {
  @Test func allowsRequestsOnlyWithLidarrRequestsOnAndTheRight() {
    #expect(RequestGate(health: health(), account: account()).allowsRequests)
    #expect(!RequestGate(health: health(requests: false), account: account()).allowsRequests)
    #expect(!RequestGate(health: health(), account: account(canRequest: false)).allowsRequests)
    #expect(!RequestGate(health: health(), account: nil).allowsRequests)
  }

  @Test func showsDiscoverOnlyWithLidarr() {
    #expect(RequestGate(health: health(), account: account(canRequest: false)).hasLidarr)
    #expect(!RequestGate(health: health(lidarr: false, requests: false), account: account()).hasLidarr)
  }

  @Test func hidesNothingTheAccountMayUseBeforeHealthIsKnown() {
    let gate = RequestGate(health: nil, account: account())
    #expect(gate.hasLidarr)
    #expect(gate.allowsRequests)
    #expect(!RequestGate(health: nil, account: account(canRequest: false)).allowsRequests)
  }
}
