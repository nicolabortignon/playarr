import Foundation
import PlayarrAPI
import PlayarrPlayer
import Testing
@testable import PlayarrUI

@MainActor @Suite struct SessionTests {
  @Test func opensASessionForTheSignedInAccount() {
    let model = demoModel()
    #expect(model.session?.account.name == "Demo")
    #expect(model.session?.serverName == "Demo")
  }

  @Test func switchingAccountsClosesTheOneBefore() throws {
    let model = demoModel()
    let first = try #require(model.session)
    first.player.play(Demo.mezzanineTracks)
    let sam = Account(id: 2, username: "sam", name: "Sam", role: .member, canRequest: false, sources: nil, hasPassword: true)
    try model.store.signedIn(SignInResponse(token: "t2", account: sam), server: Demo.server, at: Demo.baseURL)
    model.syncSession()
    #expect(model.session?.account.name == "Sam")
    #expect(model.session !== first)
    // The first account's player stopped when it was switched away.
    #expect(!first.player.queue.playing)
  }

  @Test func noSessionOnceSignedOut() throws {
    let model = demoModel()
    let key = try #require(model.store.active)
    model.store.markSignedOut(key)
    model.syncSession()
    #expect(model.session == nil)
  }

  @Test func theDemoAppStartsSignedIn() {
    #expect(AppModel.demo().session?.account.username == "demo")
  }
}
