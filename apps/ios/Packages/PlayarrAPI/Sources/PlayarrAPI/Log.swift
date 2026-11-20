import os

/// The app's logs, by category (plan 3 §6): Console.app or `log stream --predicate 'subsystem == "playarr"'` on a Mac
/// with the device attached, and the recent ones in Settings → Copy diagnostics. Ids, statuses and paths are public;
/// anything someone typed or named (titles, searches, addresses, tokens) stays out, or private.
public enum Log {
  public static let subsystem = "playarr"
  public static let player = Logger(subsystem: subsystem, category: "player")
  public static let engine = Logger(subsystem: subsystem, category: "engine")
  public static let downloads = Logger(subsystem: subsystem, category: "downloads")
  public static let network = Logger(subsystem: subsystem, category: "network")
  public static let auth = Logger(subsystem: subsystem, category: "auth")
  public static let widgets = Logger(subsystem: subsystem, category: "widgets")
}
