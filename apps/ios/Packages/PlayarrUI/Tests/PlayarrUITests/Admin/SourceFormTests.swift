import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct SourceFormTests {
  let api = FakeAPI()

  @Test func asksForAURLAndAKeyBeforeSavingANewLidarr() async {
    let form = LidarrFormModel(source: nil, api: api)
    #expect(form.name == "Lidarr")
    #expect(!form.canSave)
    form.url = "192.168.1.10:8686x"
    form.apiKey = "abc"
    #expect(!form.canSave)
    form.url = "http://192.168.1.10:8686"
    #expect(form.canSave)
    api.on(.post, "/api/settings/sources", Samples.lidarr())
    #expect(await form.save())
    #expect(api.bodies(.post, "/api/settings/sources") == [
      #"{"enabled":true,"kind":"lidarr","name":"Lidarr","settings":{"apiKey":"abc","url":"http://192.168.1.10:8686"}}"#,
    ])
  }

  @Test func keepsASavedKeyUnlessReplaced() async {
    let form = LidarrFormModel(source: Samples.lidarr(), api: api)
    #expect(form.keySaved && !form.replacingKey && form.canSave)
    api.on(.patch, "/api/settings/sources/1", Samples.lidarr())
    #expect(await form.save())
    #expect(api.bodies(.patch, "/api/settings/sources/1") == [#"{"enabled":true,"name":"Lidarr","settings":{"url":"http://192.168.1.10:8686"}}"#])
  }

  @Test func testsTheConnectionAndSaysWhatHappened() async {
    let form = LidarrFormModel(source: Samples.lidarr(), api: api)
    api.on(.post, "/api/settings/sources/test", SourceTestResult(ok: true, version: "2.9.6"))
    await form.runTest()
    #expect(form.testText == "Connected to Lidarr 2.9.6")
    #expect(api.bodies(.post, "/api/settings/sources/test") == [#"{"id":1,"url":"http://192.168.1.10:8686"}"#])
    api.fail(.post, "/api/settings/sources/test", status: 502, "Lidarr didn’t answer")
    await form.runTest()
    #expect(form.testText == "Lidarr didn’t answer")
  }

  @Test func showsTheServersMessageWhenSavingFails() async {
    let form = LidarrFormModel(source: Samples.lidarr(), api: api)
    api.fail(.patch, "/api/settings/sources/1", "Lidarr refused the API key")
    #expect(await form.save() == false)
    #expect(form.error == "Lidarr refused the API key")
  }

  @Test func savesAFolderOnThisServer() async {
    let form = FolderFormModel(source: nil, api: api)
    #expect(form.browsing == FolderBrowseRequest())
    #expect(!form.canSave)
    form.path = "/music/Jazz"
    #expect(form.namePlaceholder == "Jazz")
    api.on(.post, "/api/settings/sources", Samples.folder())
    #expect(await form.save())
    #expect(api.bodies(.post, "/api/settings/sources") == [#"{"enabled":true,"kind":"folder","settings":{"access":"local","path":"/music/Jazz"}}"#])
  }

  @Test func connectsOnlyWhenAskedAndSwapsTheDefaultPort() {
    let form = FolderFormModel(source: nil, api: api)
    form.choose(.ssh)
    #expect(form.browsing == nil && form.port == 22 && !form.canConnect)
    form.host = " nas "
    form.user = "music"
    form.password = "secret"
    form.choose(.smb)
    #expect(form.port == 445)
    form.connect()
    #expect(form.attempt == 1)
    #expect(form.browsing?.connection == .init(access: .smb, host: "nas", port: 445, user: "music", password: "secret"))
    #expect(form.rootLabel == "Shares on nas")
    form.path = "/"
    #expect(!form.pathOK)
    form.choose(.sftp)
    #expect(form.port == 22 && form.path == nil && form.browsing == nil)
  }

  @Test func keepsTheSavedPasswordAndClearsAnEmptiedKeyFile() async {
    let saved = Samples.folder(access: .ssh, secrets: ["password"])
    let form = FolderFormModel(source: saved, api: api)
    #expect(form.browsing?.connection?.access == .ssh)
    #expect(!form.replacingPassword && form.canSave)
    api.on(.patch, "/api/settings/sources/2", saved)
    #expect(await form.save())
    #expect(api.bodies(.patch, "/api/settings/sources/2") == [
      #"{"enabled":true,"name":"Music","settings":{"access":"ssh","host":"nas","path":"/music","port":22,"privateKeyPath":"","user":"guest"}}"#,
    ])
  }

  @Test func offersSMBOnlyWithRclone() async {
    api.on(.get, "/api/settings/folders/access", FolderAccessOptions(smb: false))
    let form = FolderFormModel(source: nil, api: api)
    await form.loadAccess()
    #expect(form.isDisabled(.smb))
    let share = FolderFormModel(source: Samples.folder(access: .smb), api: api)
    await share.loadAccess()
    #expect(!share.isDisabled(.smb))
  }

  @Test func browsesFoldersOneLevelAtATime() async {
    let browser = FolderBrowserModel(request: FolderBrowseRequest(), start: nil, api: api)
    api.on(.post, "/api/settings/folders/browse", FolderListing(path: nil, parent: nil, folders: [.init(name: "music", path: "/music")], audioFiles: 0))
    await browser.load()
    #expect(browser.title == "Folders Playarr may use")
    #expect(!browser.canGoUp && browser.choosable == nil)
    api.on(.post, "/api/settings/folders/browse", FolderListing(path: "/music", parent: nil, folders: [], audioFiles: 12))
    await browser.open("/music")
    #expect(browser.canGoUp)
    #expect(browser.footer(selected: "/music") == "12 audio files here · selected")
    #expect(browser.emptyText == "No folders inside.")
    #expect(api.bodies(.post, "/api/settings/folders/browse") == ["{}", #"{"path":"/music"}"#])
  }

  @Test func listsSharesOnAnSMBServerWithoutChoosingThem() async {
    let request = FolderBrowseRequest(connection: .init(access: .smb, host: "nas", port: 445, user: "guest"))
    let browser = FolderBrowserModel(request: request, start: nil, rootLabel: "Shares on nas", api: api)
    api.on(.post, "/api/settings/folders/browse", FolderListing(path: "/", parent: nil, folders: [], audioFiles: 0))
    await browser.load()
    #expect(browser.title == "Shares on nas")
    #expect(browser.choosable == nil && !browser.canGoUp)
    #expect(browser.emptyText == "No shares found.")
  }

  @Test func explainsAnEmptyDockerRoot() async {
    let browser = FolderBrowserModel(request: FolderBrowseRequest(), start: "/host", api: api)
    api.on(.post, "/api/settings/folders/browse", FolderListing(path: "/host", parent: nil, folders: [], audioFiles: 0, emptyRoot: true))
    await browser.load()
    #expect(browser.emptyRootHelp?.title == "Nothing is shared with Playarr at /host yet.")
    #expect(browser.emptyText == nil)
  }
}
