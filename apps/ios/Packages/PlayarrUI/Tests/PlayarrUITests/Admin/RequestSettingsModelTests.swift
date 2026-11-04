import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct RequestSettingsModelTests {
  let api = FakeAPI()
  let path = "/api/settings/requests"

  static func info(quality: Int? = 4, options: Bool = true) -> RequestSettingsInfo {
    RequestSettingsInfo(
      enabled: true, searchOnAdd: false, rootFolderPath: "/music", qualityProfileId: quality, lidarr: true,
      options: options
        ? .init(
          rootFolders: [.init(path: "/music", freeSpace: 1_610_612_736)],
          qualityProfiles: [.init(id: 1, name: "Lossless")],
          metadataProfiles: [.init(id: 1, name: "Standard")])
        : nil,
      error: options ? nil : "Connection refused")
  }

  @Test func listsLidarrsChoicesAfterTheDefaultKeepingAVanishedOne() async {
    let requests = RequestSettingsModel(api: api)
    api.on(.get, path, Self.info())
    await requests.load()
    #expect(requests.rootFolders.map(\.label) == ["Lidarr’s default", "/music · 1.5 GB free"])
    #expect(requests.qualityProfiles.map(\.label) == ["Lidarr’s default", "#4 (no longer in Lidarr)", "Lossless"])
    #expect(requests.metadataProfiles.map(\.value) == [nil, 1])
  }

  @Test func sendsNullToGoBackToTheDefault() async {
    var changes = 0
    let requests = RequestSettingsModel(api: api) { changes += 1 }
    api.on(.get, path, Self.info())
    await requests.load()
    api.on(.put, path, Self.info(quality: nil))
    await requests.setQualityProfile(nil)
    #expect(api.bodies(.put, path) == [#"{"qualityProfileId":null}"#])
    #expect(requests.info?.qualityProfileId == nil)
    #expect(changes == 1)
  }

  @Test func putsASwitchBackWhenSavingFails() async {
    let requests = RequestSettingsModel(api: api)
    api.on(.get, path, Self.info())
    await requests.load()
    api.fail(.put, path, "Lidarr isn’t set up")
    await requests.setEnabled(false)
    #expect(requests.info?.enabled == true)
    #expect(requests.notice == "Couldn’t save: Lidarr isn’t set up")
  }

  @Test func explainsMissingChoicesAndRetries() async {
    let requests = RequestSettingsModel(api: api)
    api.on(.get, path, Self.info(options: false))
    await requests.load()
    #expect(requests.optionsProblem == "Couldn’t get the choices from Lidarr: Connection refused")
    api.on(.get, path, Self.info())
    await requests.retry()
    #expect(requests.optionsProblem == nil)
  }
}
