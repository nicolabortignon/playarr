import Foundation

/// What the widgets show, as the app last saw it: who's signed in (nil: nobody, and the widgets say to open Playarr).
/// The app writes it (`WidgetStore`); the widgets only read it, and never ask a server themselves.
public struct WidgetSnapshot: Codable, Equatable, Sendable {
  /// Who's signed in and where. `key` tells accounts apart ("<serverId>:<accountId>").
  public struct Account: Codable, Equatable, Sendable {
    public var key: String
    public var server: String
    public var name: String

    public init(key: String, server: String, name: String) {
      self.key = key
      self.server = server
      self.name = name
    }
  }

  public var account: Account?

  public init(account: Account?) {
    self.account = account
  }

  /// Nobody signed in.
  public static let signedOut = WidgetSnapshot(account: nil)

  /// What the widget gallery shows before the app has written anything.
  public static let placeholder = WidgetSnapshot(account: Account(key: "placeholder", server: "Playarr", name: "You"))
}

/// The widgets' kinds, which the app names to reload them.
public enum WidgetKind {
  public static let quickPlay = "QuickPlay"
  public static let luckyControl = "FeelingLuckyControl"
}
