// swift-tools-version: 6.2
// What the app hands its widgets: the snapshot they show, kept in the App Group's folder (plan 11). No dependencies,
// so the widget extension links this and not PlayarrUI.
import PackageDescription

let package = Package(
  name: "PlayarrWidgetData",
  platforms: [.iOS(.v26), .macOS(.v26)],
  products: [.library(name: "PlayarrWidgetData", targets: ["PlayarrWidgetData"])],
  targets: [
    .target(name: "PlayarrWidgetData"),
    .testTarget(name: "PlayarrWidgetDataTests", dependencies: ["PlayarrWidgetData"]),
  ]
)
