import Foundation
import Observation
import PlayarrAPI
import PlayarrPlayer

/// Everything that belongs to the signed-in account: its server connection, player (queue, plays), answer cache,
/// image cache and where the app is. Switching accounts closes this and opens another, so nothing of one account
/// stays on screen for the next.
@MainActor @Observable
public final class AccountSession {
  public let key: AccountKey
  public let account: Account
  public let serverName: String
  public let api: any APISending
  /// The real client (nil in the demo): the debug Player lab asks for albums with it.
  public let client: APIClient?
  public let player: Player
  public let queries: QueryCache
  public let images: ImageCache
  public let router = AppRouter()
  public let toasts: ToastCenter
  /// Discover, requests and the song sheets (phase 8).
  public let discover: DiscoverContext
  /// The account's own: favorites, playlists and mixes (phase 6).
  public let favorites: FavoritesStore
  public let playlists: PlaylistsStore
  public let mixes: MixesStore
  /// "Add to playlist" waiting to be shown (AccountSession.addToPlaylist).
  public var picking: PlaylistPick?
  /// What this account searched for lately on this device (Search's empty page).
  public let recentSearches: RecentSearches

  /// `recentSearches`: where the account's recent searches are kept on this device (nil: in memory only).
  public init(
    key: AccountKey, account: Account, serverName: String, api: any APISending, client: APIClient?, player: Player,
    queries: QueryCache, images: ImageCache, toasts: ToastCenter, notifier: (any RequestNotifier)? = nil, recentSearches: URL? = nil
  ) {
    self.key = key
    self.account = account
    self.serverName = serverName
    self.api = api
    self.client = client
    self.player = player
    self.queries = queries
    self.images = images
    self.toasts = toasts
    discover = DiscoverContext(
      api: api, account: account, notifier: notifier,
      toast: { text, isError in toasts.push(text, tone: isError ? .error : .info) },
      // Phase 4's pages ask again for what a request or a new match made stale.
      forward: { families in for family in families { queries.invalidate(family.rawValue) } })
    discover.sheets.settings = player.settings
    discover.sheets.cuesChanged = { [weak player] in player?.mixPointsChanged(recordingId: $0) }
    favorites = FavoritesStore(api: api, queries: queries, toasts: toasts)
    playlists = PlaylistsStore(api: api, queries: queries, toasts: toasts)
    mixes = MixesStore(api: api, queries: queries)
    self.recentSearches = RecentSearches(file: recentSearches)
  }

  /// The account's folder: Application Support/Playarr/<server id>/<account id>/ (queue, plays, stream cache, answers,
  /// recent searches).
  public static func folder(for key: AccountKey) -> URL {
    URL.applicationSupportDirectory.appending(path: "Playarr/\(key.serverId)/\(key.accountId)", directoryHint: .isDirectory)
  }

  /// Images may be thrown away by the system: Caches/Playarr/<server id>/<account id>/images/.
  public static func imageFolder(for key: AccountKey) -> URL {
    URL.cachesDirectory.appending(path: "Playarr/\(key.serverId)/\(key.accountId)/images", directoryHint: .isDirectory)
  }

  /// The session for a signed-in account of `model.store`; nil when it has no token.
  public static func live(_ record: AccountRecord, model: AppModel) throws -> AccountSession? {
    guard let server = model.store.server(record.serverId), let client = model.store.client(for: record),
      let media = model.store.mediaURLs(for: record)
    else { return nil }
    let folder = folder(for: record.key)
    // The lock screen's like button toggles the song playing in this account's favorites (the session is made below).
    let owner = SessionReference()
    let player = try Player.live(backend: APIBackend(client: client, media: media), directory: folder, settings: model.playback) { track in
      guard let session = owner.session else { return }
      Task { await session.favorites.toggle(track) }
    }
    let queries = QueryCache(directory: folder.appending(path: "queries", directoryHint: .isDirectory))
    queries.setPinned(Set(player.downloads.downloads.flatMap(\.pageKeys)))
    let images = ImageCache(directory: imageFolder(for: record.key), media: media)
    Task {
      await queries.removeExpired()
      await images.prune()
    }
    let session = AccountSession(
      key: record.key, account: record.account, serverName: server.name, api: client, client: client, player: player,
      queries: queries, images: images, toasts: model.toasts,
      notifier: LocalRequestNotifier { [weak model] in model?.isActive ?? true },
      recentSearches: folder.appending(path: "recent-searches.json"))
    owner.session = session
    return session
  }

  /// The demo library (`Demo`), playing silence: for the UI tests, and view-model tests (`offline`: an engine that
  /// renders only when asked, so no sound device is needed).
  public static func demo(_ record: AccountRecord, model: AppModel, api: any APISending = DemoAPI(), offline: Bool = false) throws -> AccountSession {
    let folder = FileManager.default.temporaryDirectory.appending(path: "playarr-demo-\(UUID().uuidString)", directoryHint: .isDirectory)
    typealias MakeEngine = @MainActor (@escaping @MainActor (EngineItem, Int64) -> any PCMSource) throws -> AudioEngine
    let rendersWhenAsked: MakeEngine = { makeSource in try AudioEngine(manualRendering: true, makeSource: makeSource) }
    let player = try Player(
      backend: DemoPlayerBackend(api: api), directory: folder, settings: model.playback,
      makeEngine: offline ? rendersWhenAsked : nil,
      makeSource: { item, frame in SilentSource(seconds: item.track.duration, from: frame) })
    if !offline { player.start() }
    return AccountSession(
      key: record.key, account: record.account, serverName: Demo.server.name, api: api, client: nil, player: player,
      queries: QueryCache(directory: nil), images: ImageCache(directory: folder.appending(path: "images"), media: MediaURLs(baseURL: Demo.baseURL, token: nil), session: DemoArt.session),
      toasts: model.toasts)
  }

  /// The account is no longer the one shown: its song so far is reported and its queue saved.
  public func close() {
    discover.stop()
    player.shutDown()
  }
}
