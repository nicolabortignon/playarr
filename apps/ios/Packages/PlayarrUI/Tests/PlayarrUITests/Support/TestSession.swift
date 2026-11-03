import Foundation
import PlayarrAPI
import PlayarrPlayer
@testable import PlayarrUI

/// An app signed in to the demo library through `api`, with an offline player: view-model tests start here.
@MainActor
func demoModel(api: any APISending = FakeAPI.demoLibrary()) -> AppModel {
  let directory = FileManager.default.temporaryDirectory.appending(path: "playarr-\(UUID().uuidString)", directoryHint: .isDirectory)
  let store = ServerStore(directory: directory, secrets: InMemorySecretStore())
  try? store.signedIn(SignInResponse(token: "demo", account: Demo.account), server: Demo.server, at: Demo.baseURL)
  let defaults = UserDefaults(suiteName: UUID().uuidString)!
  let model = AppModel(
    store: store, browser: ServerBrowser(), appVersion: AppVersion("1.0.0"), device: DeviceInfo(name: "Test", platform: "ios"),
    playback: PlaybackSettings(defaults: defaults), appearance: AppearanceSettings(defaults: defaults),
    makeSession: { record, model in try AccountSession.demo(record, model: model, api: api, offline: true) })
  model.syncSession()
  return model
}

@MainActor
func demoSession(api: any APISending = FakeAPI.demoLibrary()) -> AccountSession {
  demoModel(api: api).session!
}
