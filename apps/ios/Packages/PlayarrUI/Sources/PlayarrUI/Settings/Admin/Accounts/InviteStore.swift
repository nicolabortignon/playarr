import Foundation
import PlayarrAPI

/// Invites made on this device (apps/web/src/lib/invites.ts), so Settings → Accounts can copy one again. The server
/// keeps only a fingerprint of a setup code (it's a password until it's used), so a link made on another device, or
/// forgotten here, can't be copied: the only way to another is a new code, which stops the old one working. Kept for
/// each account of the server until it expires, in the server's folder on this device.
@MainActor
public final class InviteStore {
  private let file: URL?
  private let now: () -> Date
  /// Without a file (the demo), what this run of the app made.
  private var inMemory: [String: SetupCode] = [:]

  /// `file`: where the server's invites are kept on this device; nil keeps them in memory only.
  public init(file: URL? = nil, now: @escaping () -> Date = Date.init) {
    self.file = file
    self.now = now
  }

  /// Where a server's invites are kept: Application Support/Playarr/<server id>/invites.json.
  public static func file(serverId: String) -> URL {
    URL.applicationSupportDirectory.appending(path: "Playarr/\(serverId)/invites.json")
  }

  /// Keeps the setup code just made for an account (added, or given a new code), until it expires.
  public func remember(_ setup: SetupCode, for accountId: Int) {
    var invites = read()
    invites[String(accountId)] = setup
    write(invites)
  }

  /// The account's invite made on this device, while it still works.
  public func invite(for accountId: Int) -> SetupCode? {
    read()[String(accountId)]
  }

  /// An account set up or removed: its invite is no use any more.
  public func forget(_ accountId: Int) {
    var invites = read()
    guard invites.removeValue(forKey: String(accountId)) != nil else { return }
    write(invites)
  }

  /// The invites that still work.
  private func read() -> [String: SetupCode] {
    let saved: [String: SetupCode]
    if let file {
      guard let data = try? Data(contentsOf: file), let decoded = try? JSONDecoder().decode([String: SetupCode].self, from: data) else {
        return [:]
      }
      saved = decoded
    } else {
      saved = inMemory
    }
    let at = now()
    return saved.filter { _, setup in (Format.parseDate(setup.expiresAt) ?? .distantPast) > at }
  }

  private func write(_ invites: [String: SetupCode]) {
    guard let file else {
      inMemory = invites
      return
    }
    do {
      try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
      try JSONEncoder().encode(invites).write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    } catch {
      // Not kept: Copy invite link will offer a new link instead.
    }
  }
}
