// swift-tools-version: 6.2
// Every screen and component of the app.
import PackageDescription

let package = Package(
  name: "PlayarrUI",
  platforms: [.iOS(.v26), .macOS(.v26)],
  products: [.library(name: "PlayarrUI", targets: ["PlayarrUI"])],
  dependencies: [.package(path: "../PlayarrAPI"), .package(path: "../PlayarrPlayer")],
  targets: [
    // Fonts: the web's (Schibsted Grotesk, Gloock, DM Mono), as TrueType, with their SIL Open Font Licenses.
    .target(name: "PlayarrUI", dependencies: ["PlayarrAPI", "PlayarrPlayer"], resources: [.copy("Fonts")]),
    .testTarget(name: "PlayarrUITests", dependencies: ["PlayarrUI"]),
  ]
)
