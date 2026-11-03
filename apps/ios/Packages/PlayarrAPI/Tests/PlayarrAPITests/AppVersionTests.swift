import PlayarrAPI
import Testing

@Test func labelShowsTheMarketingVersionAndTheBuild() {
  let version = AppVersion(infoDictionary: ["CFBundleShortVersionString": "1.0.0", "CFBundleVersion": "812"])
  #expect(version.label == "1.0.0 (812)")
}

@Test func missingKeysReadAsZero() {
  #expect(AppVersion(infoDictionary: [:]).label == "0.0.0 (0)")
}

@Suite struct AppVersionTests {
  @Test func comparesPartByPart() {
    #expect(AppVersion("1.10.0") > AppVersion("1.9.3"))
    #expect(AppVersion("1.0") == AppVersion("1.0.0"))
    #expect(AppVersion("2") > AppVersion("1.99"))
  }

  @Test func comparesTheMarketingVersionOnly() {
    #expect(AppVersion(marketing: "1.2.0", build: "812") == AppVersion("1.2.0"))
  }

  @Test func knowsWhenTheAppIsTooOld() {
    let server = ServerInfo(id: "s", name: "Home", version: "0.9.0", minAppVersion: "1.2.0", setup: false)
    #expect(!server.supports(AppVersion("1.1.9")))
    #expect(server.supports(AppVersion("1.2.0")))
  }
}
