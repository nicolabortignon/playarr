import PlayarrAPI
import Testing

@Test func labelShowsTheMarketingVersionAndTheBuild() {
  let version = AppVersion(infoDictionary: ["CFBundleShortVersionString": "1.0.0", "CFBundleVersion": "812"])
  #expect(version.label == "1.0.0 (812)")
}

@Test func missingKeysReadAsZero() {
  #expect(AppVersion(infoDictionary: [:]).label == "0.0.0 (0)")
}
