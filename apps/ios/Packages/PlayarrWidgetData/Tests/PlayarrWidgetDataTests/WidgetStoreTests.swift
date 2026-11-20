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
}
