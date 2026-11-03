// swift-tools-version: 6.2
// Talking to Playarr servers: models, the API client, servers and accounts. No dependencies.
import PackageDescription

let package = Package(
  name: "PlayarrAPI",
  platforms: [.iOS(.v26), .macOS(.v26)],
  products: [.library(name: "PlayarrAPI", targets: ["PlayarrAPI"])],
  targets: [
    .target(name: "PlayarrAPI"),
    .testTarget(
      name: "PlayarrAPITests",
      dependencies: ["PlayarrAPI"],
      resources: [.copy("Fixtures")]
    ),
  ]
)
