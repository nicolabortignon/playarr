// swift-tools-version: 6.2
// Playback: queue, audio engine, levels, transitions, plays, Now Playing, downloads.
import PackageDescription

let package = Package(
  name: "PlayarrPlayer",
  platforms: [.iOS(.v26), .macOS(.v26)],
  products: [.library(name: "PlayarrPlayer", targets: ["PlayarrPlayer"])],
  dependencies: [.package(path: "../PlayarrAPI")],
  targets: [
    .target(name: "PlayarrPlayer", dependencies: ["PlayarrAPI"]),
    .testTarget(name: "PlayarrPlayerTests", dependencies: ["PlayarrPlayer"]),
  ]
)
