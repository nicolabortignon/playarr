import Foundation
import PlayarrAPI
import PlayarrPlayer
import PlayarrWidgetData
import Testing
@testable import PlayarrUI

@MainActor @Suite struct WidgetPublisherTests {
  let widgets = WidgetStore(folder: FileManager.default.temporaryDirectory.appending(path: "playarr-widget-\(UUID().uuidString)"))
  /// How many times the widgets were reloaded.
  final class Reloads { var count = 0 }
  let reloads = Reloads()

  func app() -> AppModel {
    let directory = FileManager.default.temporaryDirectory.appending(path: "playarr-\(UUID().uuidString)", directoryHint: .isDirectory)
    return AppModel(
      store: ServerStore(directory: directory, secrets: InMemorySecretStore()), browser: ServerBrowser(), appVersion: AppVersion("1.0.0"),
      device: DeviceInfo(name: "Test", platform: "ios"), playback: PlaybackSettings(defaults: UserDefaults(suiteName: UUID().uuidString)!),
      widgets: WidgetPublisher(store: widgets) { [reloads] in reloads.count += 1 },
      makeSession: { record, model in try AccountSession.demo(record, model: model, offline: true) })
  }

  func account(_ id: Int, _ name: String) -> Account {
    Account(id: id, username: name.lowercased(), name: name, role: .member, canRequest: false, sources: nil, hasPassword: true)
  }

  @Test func tellsTheWidgetsWhoIsListeningAndReloadsThemOnlyWhenThatChanges() async throws {
    let app = app()
    try app.store.signedIn(SignInResponse(token: "a", account: account(1, "Nicola")), server: Demo.server, at: Demo.baseURL)
    app.syncSession()
    #expect(widgets.read()?.account == .init(key: "\(Demo.server.id):1", server: Demo.server.name, name: "Nicola"))
    #expect(reloads.count == 1)

    app.syncSession()
    #expect(reloads.count == 1)

    try app.store.signedIn(SignInResponse(token: "b", account: account(2, "Sam")), server: Demo.server, at: Demo.baseURL)
    app.syncSession()
    #expect(widgets.read()?.account?.name == "Sam")
    #expect(reloads.count == 2)

    await app.store.signOut(AccountKey(serverId: Demo.server.id, accountId: 2))
    await app.store.signOut(AccountKey(serverId: Demo.server.id, accountId: 1))
    app.syncSession()
    #expect(widgets.read() == .signedOut)
    #expect(reloads.count == 3)
  }

  @Test func theDemoWritesNothing() {
    let demo = AppModel.demo()
    #expect(demo.widgets == nil)
  }
}
