import CryptoKit
import Foundation
import PlayarrAPI
import PlayarrWidgetData
import WidgetKit

/// Hands the widgets what they show (plan 11): writes the snapshot to the App Group's folder when it changes, then has
/// WidgetKit reload them. The live app has one; the demo and the UI tests have none, so they never write a snapshot.
@MainActor
public final class WidgetPublisher {
  /// Where the shelves' pictures come from: an album's cover as the server sends it, a mix's drawn as Home draws it
  /// (`WidgetArt`). Each is asked for once: kept in the store's covers folder under a name that changes with it.
  public struct Art {
    public var albumCover: @MainActor (_ path: String) async -> Data?
    public var mixCover: @MainActor (MixSummary) async -> Data?

    public init(albumCover: @escaping @MainActor (_ path: String) async -> Data?, mixCover: @escaping @MainActor (MixSummary) async -> Data?) {
      self.albumCover = albumCover
      self.mixCover = mixCover
    }
  }

  private let store: WidgetStore
  private let reload: @MainActor () -> Void
  /// What was written last (read back from the folder the first time).
  private var written: WidgetSnapshot?
  /// How many times what's playing was told, so a slow cover can't put an older state over a newer one.
  private var nowPlayingTold = 0

  public init(store: WidgetStore, reload: @escaping @MainActor () -> Void = { WidgetCenter.shared.reloadAllTimelines() }) {
    self.store = store
    self.reload = reload
  }

  /// The App Group's; nil in a build signed without it.
  public static func live() -> WidgetPublisher? {
    guard let store = WidgetStore.live() else {
      Log.widgets.error("No App Group folder: the widgets get nothing")
      return nil
    }
    return WidgetPublisher(store: store)
  }

  private var current: WidgetSnapshot? { written ?? store.read() }

  /// The account the app listens as now, on its server; nil once nobody is. Another account starts a snapshot of its
  /// own, so nothing of the last one's shows.
  func listening(as record: AccountRecord?, on server: String?) {
    let current = current
    guard let record else { return publish(.signedOut, over: current) }
    let account = WidgetSnapshot.Account(key: record.key.keychainAccount, server: server ?? "", name: record.account.name)
    var snapshot = current.flatMap { $0.account?.key == account.key ? $0 : nil } ?? WidgetSnapshot(account: account)
    snapshot.account = account
    publish(snapshot, over: current)
  }

  /// Jump back in (the albums heard lately) and Made for you (the mixes), for `key`'s account; nil keeps what the
  /// widgets show (that answer didn't come). Dropped when another account is listening by then.
  func shelves(for key: AccountKey, albums: [Album]?, mixes: [MixSummary]?, art: Art) async {
    guard current?.account?.key == key.keychainAccount else { return }
    var albumItems: [WidgetSnapshot.Item]?
    if let albums {
      var items: [WidgetSnapshot.Item] = []
      for album in albums.prefix(WidgetSnapshot.shelfSize) {
        var cover: String?
        if let path = album.coverUrl {
          cover = await self.cover("a-\(Self.digest(path))") { await art.albumCover(path) }
        }
        items.append(WidgetSnapshot.Item(id: String(album.id), title: album.title, subtitle: album.artistName, cover: cover))
      }
      albumItems = items
    }
    var mixItems: [WidgetSnapshot.Item]?
    if let mixes {
      var items: [WidgetSnapshot.Item] = []
      for mix in mixes.prefix(WidgetSnapshot.shelfSize) {
        // Drawn from its key, color and covers: a new name when any of them changes.
        let look = ([mix.key, String(mix.hue)] + mix.covers.prefix(4)).joined(separator: "\n")
        let cover = await self.cover("m-\(Self.digest(look))") { await art.mixCover(mix) }
        items.append(WidgetSnapshot.Item(id: mix.key, title: mix.title, subtitle: mix.subtitle, cover: cover))
      }
      mixItems = items
    }
    // The covers took a while: still the same account?
    guard let current, current.account?.key == key.keychainAccount else { return }
    var next = current
    next.albums = albumItems ?? current.albums
    next.mixes = mixItems ?? current.mixes
    publish(next, over: current)
    store.pruneCovers(keeping: written ?? current)
  }

  /// What's playing for `key`'s account, as the system's Now Playing is told it (nil: nothing). The time it would have
  /// started is kept to the second, so a song playing on doesn't rewrite the snapshot.
  func nowPlaying(for key: AccountKey, track: Track?, elapsed: Double, playing: Bool, now: Date = Date(), art: Art) async {
    nowPlayingTold += 1
    let told = nowPlayingTold
    guard current?.account?.key == key.keychainAccount else { return }
    var nowPlaying: WidgetSnapshot.NowPlaying?
    if let track {
      var cover: String?
      if let path = track.coverUrl {
        cover = await self.cover("a-\(Self.digest(path))") { await art.albumCover(path) }
      }
      let startedAt = Date(timeIntervalSince1970: (now.timeIntervalSince1970 - elapsed).rounded())
      nowPlaying = WidgetSnapshot.NowPlaying(
        title: track.title, artist: track.artistName, album: track.albumTitle, cover: cover, playing: playing,
        elapsed: playing ? 0 : elapsed, duration: track.duration, startedAt: startedAt)
    }
    guard told == nowPlayingTold, let current, current.account?.key == key.keychainAccount else { return }
    var next = current
    next.nowPlaying = nowPlaying
    publish(next, over: current)
    store.pruneCovers(keeping: written ?? current)
  }

  /// A cover kept under `name`, made now if it isn't there yet; nil when there's none to make.
  private func cover(_ name: String, make: () async -> Data?) async -> String? {
    if store.hasCover(name) { return name }
    guard let data = await make() else { return nil }
    do {
      try store.writeCover(data, named: name)
      return name
    } catch {
      Log.widgets.error("Couldn't keep a cover for the widgets: \(error.localizedDescription, privacy: .public)")
      return nil
    }
  }

  private func publish(_ snapshot: WidgetSnapshot, over current: WidgetSnapshot?) {
    guard snapshot != current else { return }
    do {
      try store.write(snapshot)
      written = snapshot
      reload()
    } catch {
      Log.widgets.error("Couldn't write the widgets' snapshot: \(error.localizedDescription, privacy: .public)")
    }
  }

  /// A file name for what a cover is drawn from.
  static func digest(_ text: String) -> String {
    SHA256.hash(data: Data(text.utf8)).prefix(12).map { String(format: "%02x", $0) }.joined()
  }
}

