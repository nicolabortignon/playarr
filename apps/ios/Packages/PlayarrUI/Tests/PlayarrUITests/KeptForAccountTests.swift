import Foundation
import PlayarrAPI
import PlayarrPlayer
import Testing
@testable import PlayarrUI

struct KeptForAccountTests {
  @Test func asksOnlyWhenTheAccountKeepsSomething() throws {
    let base = FileManager.default.temporaryDirectory.appending(path: "playarr-\(UUID().uuidString)")
    let key = AccountKey(serverId: "srv-1", accountId: 2)
    #expect(KeptForAccount.of(key, name: "Sam", base: base) == nil)
    let folder = OfflineFolder.of(key, base: base)
    folder.prepare()
    try Data(count: 3 * 1024 * 1024).write(to: folder.stream.appending(path: "12.flac"))
    let kept = try #require(KeptForAccount.of(key, name: "Sam", base: base))
    #expect(kept.message == "Songs kept for Sam take 3 MB on this device.")
    #expect(OfflineWording.signOutMessage(name: "Sam", downloads: 2, bytes: 3 * OfflineLimit.gigabyte)
      == "2 downloads and other songs kept for Sam take 3 GB on this device.")
  }
}
