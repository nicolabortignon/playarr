import Foundation

/// What the widgets show, as the app last saw it: who's signed in (nil: nobody, and the widgets say to open Playarr),
/// the albums heard lately and the mixes made for them. The app writes it (`WidgetStore`); the widgets only read it, and
/// never ask a server themselves.
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

  /// An album or a mix on a widget's shelf: `id` is the album's id or the mix's key, `cover` a file in the store's
  /// covers folder (nil: none yet, and the widget draws a stand-in).
  public struct Item: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var title: String
    public var subtitle: String
    public var cover: String?

    public init(id: String, title: String, subtitle: String, cover: String?) {
      self.id = id
      self.title = title
      self.subtitle = subtitle
      self.cover = cover
    }
  }

  public var account: Account?
  /// Jump back in: the albums heard lately, newest first, up to 8.
  public var albums: [Item]
  /// Made for you: Home's mixes, in its order, up to 8.
  public var mixes: [Item]

  public init(account: Account?, albums: [Item] = [], mixes: [Item] = []) {
    self.account = account
    self.albums = albums
    self.mixes = mixes
  }

  /// A snapshot from an older app may lack the shelves: they're empty until the app writes them.
  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    account = try container.decodeIfPresent(Account.self, forKey: .account)
    albums = try container.decodeIfPresent([Item].self, forKey: .albums) ?? []
    mixes = try container.decodeIfPresent([Item].self, forKey: .mixes) ?? []
  }

  /// How many items a shelf keeps: a large widget's two rows of four.
  public static let shelfSize = 8

  /// Nobody signed in.
  public static let signedOut = WidgetSnapshot(account: nil)

  /// What the widget gallery shows before the app has written anything.
  public static let placeholder = WidgetSnapshot(
    account: Account(key: "placeholder", server: "Playarr", name: "You"),
    albums: (1...8).map { Item(id: "\($0)", title: "Album", subtitle: "Artist", cover: nil) },
    mixes: (1...8).map { Item(id: "\($0)", title: "Mix", subtitle: "Made for you", cover: nil) })
}

/// The widgets' kinds, which the app names to reload them.
public enum WidgetKind {
  public static let quickPlay = "QuickPlay"
  public static let jumpBackIn = "JumpBackIn"
  public static let madeForYou = "MadeForYou"
  public static let luckyControl = "FeelingLuckyControl"
}
