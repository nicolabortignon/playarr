import Foundation
import PlayarrAPI
import PlayarrPlayer

/// What an account keeps on this device, for the question signing out asks: nil when it keeps nothing.
struct KeptForAccount: Equatable, Identifiable {
  let key: AccountKey
  let name: String
  let downloads: Int
  let bytes: Int64

  var id: AccountKey { key }
  var message: String { OfflineWording.signOutMessage(name: name, downloads: downloads, bytes: bytes) }

  static func of(_ key: AccountKey, name: String, base: URL = OfflineFolder.applicationBase) -> KeptForAccount? {
    let kept = DownloadStore.summary(of: .of(key, base: base))
    return kept.bytes > 0 ? KeptForAccount(key: key, name: name, downloads: kept.downloads, bytes: kept.bytes) : nil
  }

  /// Signs out, then removes what the account kept (in that order, so its player is gone before its files).
  @MainActor func signOutRemovingDownloads(_ signOut: @MainActor (AccountKey) async -> Void) async {
    await signOut(key)
    await DownloadStore.removeEverything(in: .of(key), transport: URLSessionTransport.background)
  }
}
