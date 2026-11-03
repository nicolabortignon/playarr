// swift-tools-version: 6.2
// Every screen and component of the app.
import PackageDescription

let package = Package(
  name: "PlayarrUI",
  platforms: [.iOS(.v26), .macOS(.v26)],
  products: [.library(name: "PlayarrUI", targets: ["PlayarrUI"])],
  dependencies: [.package(path: "../PlayarrAPI"), .package(path: "../PlayarrPlayer")],
  targets: [
    .target(name: "PlayarrUI", dependencies: ["PlayarrAPI", "PlayarrPlayer"]),
    .testTarget(name: "PlayarrUITests", dependencies: ["PlayarrUI"]),
  ]
)
