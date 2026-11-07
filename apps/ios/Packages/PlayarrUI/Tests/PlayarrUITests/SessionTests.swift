import Foundation
import PlayarrAPI
import PlayarrPlayer
import Security
import Synchronization
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

  @Test func eachSessionHasItsDiscoverContext() throws {
    let model = demoModel()
    let session = try #require(model.session)
    #expect(session.discover.account == Demo.account)
    #expect(session.discover.sheets.settings === session.player.settings)
    // What a request or a new match makes stale is asked for again by phase 4's pages.
    session.queries.set(Demo.albums, for: .albums(.artist))
    #expect(!session.queries.isStale(.albums(.artist), after: 60))
    session.discover.invalidate([.albums])
    #expect(session.queries.isStale(.albums(.artist), after: 60))
  }

  @Test func theDemoAppStartsSignedIn() {
    #expect(AppModel.demo().session?.account.username == "demo")
  }

  // A session that can't open says why and how out, rather than leaving RootView's spinner up for ever.

  func liveModel(secrets: any SecretStore) throws -> AppModel {
    let directory = FileManager.default.temporaryDirectory.appending(path: "playarr-\(UUID().uuidString)", directoryHint: .isDirectory)
    let store = ServerStore(directory: directory, secrets: secrets)
    try store.signedIn(SignInResponse(token: "tok", account: Demo.account), server: Demo.server, at: Demo.baseURL)
    return AppModel(store: store, browser: ServerBrowser(), appVersion: AppVersion("1.0.0"), device: DeviceInfo(name: "Test", platform: "ios"))
  }

  @Test func signsOutAnAccountWhoseTokenIsntOnThisDevice() throws {
    // An unencrypted backup restored: the server list came back, the Keychain didn't.
    let secrets = InMemorySecretStore()
    let model = try liveModel(secrets: secrets)
    let key = try #require(model.store.active)
    try secrets.removeToken(for: key.keychainAccount)

    model.syncSession()

    #expect(model.session == nil)
    #expect(model.sessionFailure == nil)
    // RootView now shows its sign-in again, with the account kept.
    #expect(model.store.activeAccount?.signedIn == false)
  }

  @Test func saysWhyWhenTheKeychainCantBeRead() throws {
    let model = try liveModel(secrets: UnreadableSecrets())

    model.syncSession()

    #expect(model.session == nil)
    #expect(model.sessionFailure == "This account’s sign-in couldn’t be read from the Keychain. Unlock the device and try again.")
    // Not taken for a token that's gone: the account stays signed in, for Try again.
    #expect(model.store.activeAccount?.signedIn == true)
  }

  @Test func saysWhyASessionCouldntOpenAndTriesAgain() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: "playarr-\(UUID().uuidString)", directoryHint: .isDirectory)
    let store = ServerStore(directory: directory, secrets: InMemorySecretStore())
    try store.signedIn(SignInResponse(token: "demo", account: Demo.account), server: Demo.server, at: Demo.baseURL)
    let engineStarts = Mutex(false)
    let model = AppModel(
      store: store, browser: ServerBrowser(), appVersion: AppVersion("1.0.0"), device: DeviceInfo(name: "Test", platform: "ios"),
      playback: PlaybackSettings(defaults: UserDefaults(suiteName: UUID().uuidString)!),
      makeSession: { record, model in
        guard engineStarts.withLock({ $0 }) else { throw EngineWontStart() }
        return try AccountSession.demo(record, model: model, offline: true)
      })

    model.syncSession()
    #expect(model.session == nil)
    #expect(model.sessionFailure == "Playarr couldn’t get playback ready on this device: The audio engine wouldn’t start.")

    // Try again.
    engineStarts.withLock { $0 = true }
    model.syncSession()
    #expect(model.session?.account == Demo.account)
    #expect(model.sessionFailure == nil)
  }
}

/// A Keychain locked away, as before a device's first unlock.
private struct UnreadableSecrets: SecretStore {
  func token(for key: String) throws -> String? { throw KeychainError(status: errSecInteractionNotAllowed) }
  func setToken(_ token: String, for key: String) throws {}
  func removeToken(for key: String) throws {}
}

private struct EngineWontStart: LocalizedError {
  var errorDescription: String? { "The audio engine wouldn’t start." }
}
