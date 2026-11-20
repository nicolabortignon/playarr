import Foundation
import Testing
@testable import PlayarrWidgetData

@Suite struct WidgetStoreTests {
  let store = WidgetStore(folder: FileManager.default.temporaryDirectory.appending(path: "playarr-widget-\(UUID().uuidString)"))

  @Test func readsWhatWasWrittenLast() throws {
    #expect(store.read() == nil)
    try store.write(WidgetSnapshot(account: .init(key: "srv-1:2", server: "Home", name: "Sam")))
    try store.write(WidgetSnapshot(account: .init(key: "srv-1:1", server: "Home", name: "Nicola")))
    #expect(store.read() == WidgetSnapshot(account: .init(key: "srv-1:1", server: "Home", name: "Nicola")))
    try store.write(.signedOut)
    #expect(store.read() == .signedOut)
  }

  @Test func readsNothingFromAFileItCantUnderstand() throws {
    try FileManager.default.createDirectory(at: store.folder, withIntermediateDirectories: true)
    try Data("not json".utf8).write(to: store.file)
    #expect(store.read() == nil)
  }

  @Test func readsASnapshotFromBeforeTheShelvesWithEmptyOnes() throws {
    try FileManager.default.createDirectory(at: store.folder, withIntermediateDirectories: true)
    try Data(#"{"account":{"key":"srv-1:1","server":"Home","name":"Nicola"}}"#.utf8).write(to: store.file)
    #expect(store.read() == WidgetSnapshot(account: .init(key: "srv-1:1", server: "Home", name: "Nicola")))
  }

  @Test func keepsTheCoversASnapshotNamesAndDeletesTheRest() throws {
    try store.writeCover(Data("a".utf8), named: "a-1.jpg")
    try store.writeCover(Data("m".utf8), named: "m-1.jpg")
    try store.writeCover(Data("old".utf8), named: "a-old.jpg")
    let snapshot = WidgetSnapshot(
      account: .init(key: "srv-1:1", server: "Home", name: "Nicola"),
      albums: [.init(id: "7", title: "Moon Safari", subtitle: "Air", cover: "a-1.jpg"), .init(id: "8", title: "Dummy", subtitle: "Portishead", cover: nil)],
      mixes: [.init(id: "vibes", title: "Vibes of the hour", subtitle: "Late night", cover: "m-1.jpg")])

    store.pruneCovers(keeping: snapshot)

    #expect(store.hasCover("a-1.jpg"))
    #expect(store.hasCover("m-1.jpg"))
    #expect(!store.hasCover("a-old.jpg"))
    #expect(try Data(contentsOf: store.cover("a-1.jpg")) == Data("a".utf8))
  }
}
