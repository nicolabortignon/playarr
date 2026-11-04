import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct SourcesModelTests {
  let api = FakeAPI()
  let clock = TestClock()

  @Test func describesEachSourceLikeTheWeb() {
    #expect(SourceText.details(Samples.lidarr()) == "http://192.168.1.10:8686 · 1200 songs · 100 albums")
    #expect(SourceText.details(Samples.folder(access: .smb)) == "smb://guest@nas/music/Albums · 1 song · 1 album")
    #expect(SourceText.details(Samples.folder(access: .ssh)) == "guest@nas:/music · 1 song · 1 album")
    #expect(SourceText.status(Samples.folder(syncing: true)) == ("Syncing…", .accent))
    #expect(SourceText.status(Samples.folder(matching: 3)) == ("Matching… 3 albums left · about 10 s", .accent))
    #expect(SourceText.status(Samples.folder()) == ("Not synced yet", .muted))
    var broken = Samples.folder()
    broken.error = "Folder not found"
    #expect(SourceText.status(broken) == ("Folder not found", .error))
    #expect(SourceText.removeTitle(Samples.lidarr()) == "Remove “Lidarr”?")
  }

  @Test func pollsQuicklyWhileASourceSyncsAndRefreshesTheLibraryAfter() async {
    var libraryChanges = 0
    let model = SourcesModel(api: api, clock: clock) { libraryChanges += 1 }
    api.on(.get, "/api/settings/sources", Samples.sources([Samples.lidarr(syncing: true)]))
    api.then(.get, "/api/settings/sources", Samples.sources([Samples.lidarr()]))
    let polling = Task { await model.poll() }
    #expect(await clock.nextSleep() == .seconds(2))
    #expect(model.sources.first?.syncing == true)
    clock.advance(by: .seconds(2))
    #expect(await clock.nextSleep() == .seconds(30))
    #expect(libraryChanges == 1)
    #expect(api.calls(.get, "/api/settings/sources").count == 2)
    polling.cancel()
  }

  @Test func savesANewOrderOnlyWhenItChanged() async {
    let model = SourcesModel(api: api, clock: clock)
    api.on(.get, "/api/settings/sources", Samples.sources([Samples.lidarr(), Samples.folder()]))
    await model.load()
    api.on(.put, "/api/settings/sources/order", Samples.sources([Samples.folder(), Samples.lidarr()]))
    await model.move(fromOffsets: IndexSet(integer: 0), toOffset: 1)
    #expect(api.calls(.put, "/api/settings/sources/order").isEmpty)
    await model.move(fromOffsets: IndexSet(integer: 0), toOffset: 2)
    #expect(api.bodies(.put, "/api/settings/sources/order") == [#"{"ids":[2,1]}"#])
    #expect(model.sources.map(\.id) == [2, 1])
  }

  @Test func putsTheOrderBackWhenSavingItFails() async {
    let model = SourcesModel(api: api, clock: clock)
    api.on(.get, "/api/settings/sources", Samples.sources([Samples.lidarr(), Samples.folder()]))
    await model.load()
    api.fail(.put, "/api/settings/sources/order", "Unknown source")
    await model.move(fromOffsets: IndexSet(integer: 1), toOffset: 0)
    #expect(model.sources.map(\.id) == [1, 2])
    #expect(model.error == "Unknown source")
  }

  @Test func removesRescansAndMatchesAgain() async {
    var libraryChanges = 0
    let model = SourcesModel(api: api, clock: clock) { libraryChanges += 1 }
    let folder = Samples.folder()
    api.on(.get, "/api/settings/sources", Samples.sources([folder]))
    api.on(.post, "/api/settings/sources/2/rescan", json: "")
    api.on(.post, "/api/settings/sources/2/rematch", json: "")
    api.on(.delete, "/api/settings/sources/2", json: "")
    await model.rescan(folder)
    await model.rematch(folder)
    #expect(model.rematching.isEmpty)
    await model.remove(folder)
    #expect(api.calls.map(\.description).filter { !$0.hasPrefix("GET") } == [
      "POST /api/settings/sources/2/rescan", "POST /api/settings/sources/2/rematch", "DELETE /api/settings/sources/2",
    ])
    #expect(libraryChanges == 1)
  }

  @Test func showsTheServersMessageWhenAChangeFails() async {
    let model = SourcesModel(api: api, clock: clock)
    api.on(.get, "/api/settings/sources", Samples.sources([Samples.lidarr()], canEdit: false))
    api.fail(.post, "/api/settings/sources/1/rescan", status: 403, "Only an admin can change this")
    await model.rescan(Samples.lidarr())
    #expect(model.error == "Only an admin can change this")
    #expect(model.canEdit == false)
  }
}
