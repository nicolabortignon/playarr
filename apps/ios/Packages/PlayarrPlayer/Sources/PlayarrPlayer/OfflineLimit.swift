import Foundation

/// How much room songs kept as you listen may take on this device (Settings → Playback → On this device), as
/// `OFFLINE_LIMITS` in apps/web/src/player/offline.ts. Downloads (albums, playlists, mixes, Favorites) don't count.
public enum OfflineLimit {
  public static let megabyte: Int64 = 1 << 20
  public static let gigabyte: Int64 = 1 << 30
  /// The limits on offer; 0 turns keeping songs off.
  public static let options: [Int64] = [0, 512 * megabyte, gigabyte, 2 * gigabyte, 5 * gigabyte, 10 * gigabyte]
  public static let defaultLimit: Int64 = 2 * gigabyte

  /// "Off", "512 MB", "2 GB".
  public static func label(_ limit: Int64) -> String { limit == 0 ? "Off" : ByteCount.format(limit) }
}

/// Sizes in the web's words (`formatBytes` in apps/web/src/lib/format.ts): "640 MB", "1.5 GB", "12 GB".
public enum ByteCount {
  public static func format(_ bytes: Int64) -> String {
    let gb = Double(bytes) / Double(OfflineLimit.gigabyte)
    if gb >= 1 {
      return gb >= 10 || gb == gb.rounded() ? "\(Int(gb.rounded())) GB" : String(format: "%.1f GB", gb)
    }
    return "\(Int((Double(bytes) / Double(OfflineLimit.megabyte)).rounded())) MB"
  }
}
