import Foundation
import Observation
import PlayarrAPI

/// What one server and account keeps on this device, as `useOffline`, downloads.ts and loadAhead.ts's keeping in
/// apps/web/src/player: the manifest (`offline.json`), songs kept as you listen within the limit (least recently
/// played make room), and downloads (albums, playlists, mixes, Favorites) pinned outside it, fetched one song at a time
/// on the background session, then the DJ transitions between their songs. The stream cache owns the files in
/// `stream/` and tells this store about each whole file and each play; this store decides what goes.
@MainActor @Observable
public final class DownloadStore {
  public struct Active: Sendable, Equatable {
    public var fileId: Int
    public var loaded: Int64
    public var total: Int64
    public var fraction: Double { total > 0 ? min(1, Double(loaded) / Double(total)) : 0 }
  }

  /// Whether songs fit on the device before a download starts.
  public enum Room: Sendable, Equatable {
    case enough
    case short(needed: Int64, free: Int64)
  }

  /// Songs started at once: one in the foreground, as the web; more when the app goes to the background, so the
  /// system works through them with the app closed (still one at a time on the wire, `httpMaximumConnectionsPerHost`).
  static let foregroundJobs = 1
  static let backgroundJobs = 25
  /// Room left free on the device, whatever downloads want.
  static let reserve: Int64 = 256 * OfflineLimit.megabyte

  public private(set) var manifest: OfflineManifest
  /// The song downloading for a download, for progress rings.
  public private(set) var active: Active?
  /// Songs that didn't download this session, and why: tried again when the network comes back or space is freed.
  public private(set) var failed: [Int: String] = [:]
  /// Transitions left out this session, by pair: none to be had, too slow, no room, an error.
  public private(set) var skippedPairs: [String: String] = [:]

  public let folder: OfflineFolder
  /// Shows a toast (the Player's notice).
  @ObservationIgnored public var announce: @MainActor (_ text: String, _ isError: Bool) -> Void = { _, _ in }
  @ObservationIgnored private let settings: PlaybackSettings
  @ObservationIgnored private let cache: StreamCache
  @ObservationIgnored private let transport: any DownloadTransport
  @ObservationIgnored private let backend: any PlayerBackend
  @ObservationIgnored private let saved: JSONFile<OfflineManifest>
  @ObservationIgnored private let capacity: @Sendable () -> Int64?
  @ObservationIgnored private let now: @Sendable () -> Date
  @ObservationIgnored private let poller: TransitionPoller
  /// Songs playing or fetched ahead: never dropped to make room.
  @ObservationIgnored private(set) var protectedSongs: Set<Int> = []
  /// Song jobs under way: job id → file id.
  @ObservationIgnored private var songJobs: [String: Int] = [:]
  /// Jobs stopped on purpose: their end is no interruption, and a file that still arrives is dropped.
  @ObservationIgnored private var stopping: Set<String> = []
  /// Songs the stream cache is fetching for the player right now: their download waits for that.
  @ObservationIgnored private var withCache: Set<Int> = []
  @ObservationIgnored private var transitionWork: TransitionWork?
  /// Nothing is fetched until the jobs the system still has (after a relaunch) are known.
  @ObservationIgnored private var opened = false
  @ObservationIgnored private var online = true
  @ObservationIgnored private var inBackground = false
  @ObservationIgnored private var pumping = false
  @ObservationIgnored private var pumpAgain = false
  @ObservationIgnored private var warnedFull = false
  @ObservationIgnored private var watchers: [Task<Void, Never>] = []

  private struct TransitionWork {
    let key: String
    let pair: String
    var kept: KeptTransition?
    var waiting: Set<String> = []
    var fetched: [String] = []
    var task: Task<Void, Never>?
  }

  public init(
    folder: OfflineFolder, settings: PlaybackSettings, cache: StreamCache, transport: any DownloadTransport,
    backend: any PlayerBackend, capacity: @escaping @Sendable () -> Int64? = { OfflineFolder.availableCapacity() },
    now: @escaping @Sendable () -> Date = { Date() }, poll: TransitionPoller.Timing = .server
  ) {
    self.folder = folder
    self.settings = settings
    self.cache = cache
    self.transport = transport
    self.backend = backend
    self.capacity = capacity
    self.now = now
    poller = TransitionPoller(timing: poll)
    folder.prepare()
    saved = JSONFile(folder.manifest)
    manifest = saved.read() ?? OfflineManifest()
    reconcile()
    transport.setHandler { [weak self] event in Task { @MainActor in self?.handle(event) } }
    watchers.append(
      Task { [weak self, cache] in
        await cache.keepBooks { event in Task { @MainActor in self?.handle(event) } }
        await self?.adoptRunningJobs()
      })
  }

  isolated deinit {
    for watcher in watchers { watcher.cancel() }
  }

  // MARK: Reading

  /// Downloads, the newest first (Library → Downloads).
  public var downloads: [PinnedDownload] { manifest.pins.values.sorted { ($0.addedAt, $0.key) > ($1.addedAt, $1.key) } }
  public func download(_ key: String) -> PinnedDownload? { manifest.pins[key] }
  public func progress(of key: String) -> DownloadProgress? { manifest.pins[key].map { OfflineRules.progress(of: $0, in: manifest) } }
  /// Its songs that couldn't download this session.
  public func failedCount(of key: String) -> Int { manifest.pins[key]?.tracks.filter { failed[$0.fileId] != nil }.count ?? 0 }
  /// The song's whole file is on this device (kept or downloaded): it plays with no connection.
  public func isKept(_ fileId: Int) -> Bool { manifest.songs[fileId] != nil }
  /// Songs kept as you listen: what Settings → Playback counts against the limit.
  public var keptAsYouListen: (count: Int, bytes: Int64) {
    let rest = OfflineRules.unpinned(manifest.songs, pins: manifest.pins)
    return (rest.count, OfflineRules.bytes(rest.values))
  }
  /// What downloads take, their transitions included.
  public var downloadsBytes: Int64 {
    let pinned = OfflineRules.pinnedSongs(manifest.pins)
    return OfflineRules.bytes(manifest.songs.filter { pinned.contains($0.key) }.values) + OfflineRules.bytes(manifest.transitionFiles.values)
  }
  /// Even volume for downloads' songs, for the player's level store (it can't ask the server offline).
  public var keptLevels: [String: TrackLevel] {
    manifest.pins.values.reduce(into: [:]) { all, d in all.merge(d.levels) { old, _ in old } }
  }

  /// Settings → Playback → On this device: room for songs kept as you listen. Lowering it drops the least recently
  /// played now.
  public var limit: Int64 {
    get { settings.offlineLimit }
    set {
      settings.offlineLimit = newValue
      fitLimit()
      retry()
    }
  }

  /// "Allow downloads on mobile data". The song under way starts again under the new rule.
  public var cellularDownloads: Bool {
    get { settings.cellularDownloads }
    set {
      settings.cellularDownloads = newValue
      for id in songJobs.keys { stop(id) }
      pump()
    }
  }

  /// Whether these songs fit on the device, counting songs kept as you listen as room (they'd make way).
  public func room(for tracks: [Track]) -> Room {
    var seen = Set<Int>()
    let needed = tracks.filter { $0.fileId > 0 && manifest.songs[$0.fileId] == nil && seen.insert($0.fileId).inserted }
      .reduce(Int64(0)) { $0 + Int64($1.size) }
    guard needed > 0, let free = capacity() else { return .enough }
    let freeable = keptAsYouListen.bytes
    let available = free + freeable - Self.reserve
    return needed <= available ? .enough : .short(needed: needed, free: max(0, available))
  }

  // MARK: Changing

  /// Download an album, playlist, mix or Favorites, or update the songs of one already downloaded (a playlist edited
  /// since). Transitions between songs that no longer follow each other go.
  public func add(key: String, title: String, subtitle: String? = nil, coverUrl: String? = nil, href: String, tracks: [Track]) {
    let songs = tracks.filter { $0.fileId > 0 }
    let before = manifest.pins[key]
    let pairs = OfflineRules.pairs(of: songs, mode: OfflineRules.transitionMode)
    manifest.pins[key] = PinnedDownload(
      key: key, title: title, subtitle: subtitle, coverUrl: coverUrl, href: href, tracks: songs, addedAt: before?.addedAt ?? now(),
      transitions: before?.transitions.filter { pairs.contains($0.key) } ?? [:], levels: before?.levels ?? [:])
    save()
    dropUnwantedTransitionFiles()
    // Songs come before transitions.
    if OfflineRules.nextToDownload(manifest.pins, songs: manifest.songs, skip: Set(failed.keys)) != nil { stopTransitionWork() }
    Task { await refreshLevels() }
    pump()
  }

  /// Remove a download: its songs become ordinary kept songs, which make room as usual. Its transitions are only any
  /// use to downloads, so they go unless another one has them too.
  public func remove(_ key: String) {
    guard manifest.pins.removeValue(forKey: key) != nil else { return }
    save()
    let pinned = OfflineRules.pinnedSongs(manifest.pins)
    for (id, fileId) in songJobs where !pinned.contains(fileId) { stop(id) }
    if transitionWork?.key == key { stopTransitionWork() }
    dropUnwantedTransitionFiles()
    fitLimit()
    retry()
  }

  /// Remove everything from this device, downloads included.
  public func removeAll() {
    for id in songJobs.keys { stop(id) }
    stopTransitionWork()
    let ids = Set(manifest.songs.keys).union(folder.songFiles().keys)
    manifest = OfflineManifest()
    save()
    active = nil
    failed = [:]
    skippedPairs = [:]
    for (_, found) in folder.transitionFiles() { folder.remove(found.path) }
    try? FileManager.default.removeItem(at: folder.resume)
    folder.prepare()
    Task { [cache] in await cache.remove(ids) }
  }

  /// The songs playing and fetched ahead (the player's keep-ahead plan): never dropped to make room.
  public func protect(_ fileIds: Set<Int>) {
    protectedSongs = fileIds
    fitLimit()
    pump()
  }

  public func networkChanged(_ kind: NetworkKind) {
    let wasOnline = online
    online = kind != .offline
    if online && !wasOnline {
      Task { await refreshLevels() }
      retry()
    }
  }

  /// The app is going to the background: hand the system more songs, so they download with the app closed.
  public func appMovedToBackground() {
    inBackground = true
    pump()
  }

  public func appBecameActive() {
    inBackground = false
    pump()
  }

  /// Try the songs and transitions that failed again (back online, after space was freed).
  public func retry() {
    warnedFull = false
    failed = [:]
    skippedPairs = [:]
    pump()
  }

  // MARK: Fetching

  /// Fetches what downloads are missing while there's a connection: their songs, one at a time, then the transitions
  /// between them, one pair at a time (the server renders one at a time and drops older asks once a few wait).
  public func pump() {
    guard opened else { return }
    guard !pumping else {
      pumpAgain = true
      return
    }
    pumping = true
    Task {
      await pumpSongs()
      pumping = false
    }
  }

  private func pumpSongs() async {
    withCache = []
    repeat {
      pumpAgain = false
      while online, songJobs.count < (inBackground ? Self.backgroundJobs : Self.foregroundJobs) {
        let skip = Set(songJobs.values).union(failed.keys).union(withCache)
        guard let next = OfflineRules.nextToDownload(manifest.pins, songs: manifest.songs, skip: skip) else { break }
        if adopt(next) { continue }
        if await cache.isDownloading(next.fileId) {
          withCache.insert(next.fileId)  // the player is fetching it: its whole file is recorded when it lands
          continue
        }
        guard makeRoom(for: Int64(next.size)) else {
          fail(next.fileId, OfflineRules.noRoom)
          continue
        }
        start(next)
      }
    } while pumpAgain
    if songJobs.isEmpty, withCache.isEmpty, OfflineRules.nextToDownload(manifest.pins, songs: manifest.songs, skip: Set(failed.keys)) == nil {
      keepNextTransition()
    }
  }

  /// A song's whole file the stream cache already has (played before): taken on rather than downloaded again.
  private func adopt(_ track: Track) -> Bool {
    let path = folder.songPath(track)
    guard manifest.songs[track.fileId] == nil, let bytes = folder.size(of: path), bytes > 0 else { return false }
    record(track.fileId, path: path, bytes: bytes)
    return true
  }

  private func start(_ track: Track) {
    let id = folder.jobID(folder.songPath(track))
    songJobs[id] = track.fileId
    transport.start(TransportJob(id: id, request: allowed(backend.streamRequest(track)), resumeData: resumeData(id)))
  }

  /// A request with mobile data (and personal hotspots) allowed only if the setting says so.
  private func allowed(_ request: URLRequest) -> URLRequest {
    var request = request
    request.allowsCellularAccess = settings.cellularDownloads
    request.allowsExpensiveNetworkAccess = settings.cellularDownloads
    return request
  }

  private func stop(_ id: String) {
    songJobs[id] = nil
    stopping.insert(id)
    transport.cancel(id)
  }

  /// Room on the device for `need` more bytes, dropping songs kept as you listen (least recently played first) if
  /// it's short. False when even that isn't enough.
  private func makeRoom(for need: Int64) -> Bool {
    guard let free = capacity() else { return true }
    let short = need + Self.reserve - free
    guard short > 0 else { return true }
    guard let drop = OfflineRules.freeUp(OfflineRules.unpinned(manifest.songs, pins: manifest.pins), bytes: short, protect: protectedSongs) else {
      return false
    }
    dropSongs(drop)
    return true
  }

  private func fail(_ fileId: Int, _ reason: String) {
    failed[fileId] = reason
    if reason == OfflineRules.noRoom && !warnedFull {
      warnedFull = true
      announce("This device is out of space for downloads: remove some in Library → Downloads", true)
    }
  }

  /// Songs kept as you listen beyond the limit go, least recently played first (never those of downloads, nor what's
  /// playing or fetched ahead). Off: all of them.
  private func fitLimit() {
    let rest = OfflineRules.unpinned(manifest.songs, pins: manifest.pins)
    let unprotected = rest.keys.filter { !protectedSongs.contains($0) }
    let limit = settings.offlineLimit
    dropSongs(limit > 0 ? OfflineRules.evictions(rest, need: 0, limit: limit, protect: protectedSongs) ?? unprotected : unprotected)
  }

  private func dropSongs(_ ids: [Int]) {
    guard !ids.isEmpty else { return }
    for id in ids { manifest.songs[id] = nil }
    save()
    let set = Set(ids)
    Task { [cache] in await cache.remove(set) }
  }

  private func record(_ fileId: Int, path: String, bytes: Int64) {
    manifest.songs[fileId] = KeptFile(file: path, bytes: bytes, usedAt: now())
    save()
  }

  private func touch(_ fileId: Int) {
    guard manifest.songs[fileId] != nil else { return }
    manifest.songs[fileId]?.usedAt = now()
    save()
  }

  // MARK: Events

  private func handle(_ event: StreamCache.Event) {
    switch event {
    case .completed(let fileId, let file, let bytes):
      withCache.remove(fileId)
      record(fileId, path: "stream/\(file.lastPathComponent)", bytes: bytes)
      fitLimit()
      pump()
    case .used(let fileId):
      touch(fileId)
    }
  }

  private func handle(_ event: TransportEvent) {
    guard let path = folder.path(ofJob: event.id) else { return }  // another account's: its file is in place already
    switch event {
    case .progress(let id, let written, let expected):
      guard let fileId = songJobs[id] else { return }
      let size = manifest.pins.values.lazy.flatMap(\.tracks).first { $0.fileId == fileId }?.size ?? 0
      active = Active(fileId: fileId, loaded: written, total: expected > 0 ? expected : Int64(size))

    case .finished(let id, let bytes):
      clearResumeData(id)
      let fileId = songJobs.removeValue(forKey: id)
      if active?.fileId == fileId { active = nil }
      if stopping.remove(id) != nil {
        if fileId == nil || !OfflineRules.pinnedSongs(manifest.pins).contains(fileId ?? 0) { folder.remove(path) }
      } else if path.hasPrefix("offline/transitions/") {
        transitionFileArrived(id, path: path, bytes: bytes)
      } else if let fileId = fileId ?? Self.songId(path) {
        record(fileId, path: path, bytes: bytes)
        fitLimit()
      }
      pump()

    case .failed(let id, let failure, let resume):
      if let resume { saveResumeData(resume, id) }
      let fileId = songJobs.removeValue(forKey: id)
      if active?.fileId == fileId { active = nil }
      let onPurpose = stopping.remove(id) != nil
      if path.hasPrefix("offline/transitions/") {
        if !onPurpose { transitionFileFailed(id, failure) }
      } else if let fileId, !onPurpose {
        // Cancelled without us: the system stopped it (the app closed from the switcher), picked up again from its
        // resume data.
        if failure != .cancelled { fail(fileId, failure.reason) }
      }
      pump()
    }
  }

  /// "stream/12.flac" → 12.
  static func songId(_ path: String) -> Int? {
    guard path.hasPrefix("stream/") else { return nil }
    return Int(path.dropFirst("stream/".count).prefix { $0 != "." })
  }

  /// After a relaunch: the songs the system is still fetching aren't asked for again.
  private func adoptRunningJobs() async {
    for id in await transport.running() {
      guard let path = folder.path(ofJob: id), let fileId = Self.songId(path), manifest.songs[fileId] == nil else { continue }
      songJobs[id] = fileId
    }
    opened = true
    pump()
  }

  // MARK: Transitions

  private func stopTransitionWork() {
    guard let work = transitionWork else { return }
    transitionWork = nil
    work.task?.cancel()
    for id in work.waiting { stop(id) }
    dropUnwantedTransitionFiles()
  }

  /// Transition files no download has any more go.
  private func dropUnwantedTransitionFiles() {
    let wanted = OfflineRules.pinnedTransitionFiles(manifest.pins).union(transitionWork?.kept?.fileNames ?? [])
    let unwanted = manifest.transitionFiles.filter { !wanted.contains($0.key) }
    guard !unwanted.isEmpty else { return }
    for (name, file) in unwanted {
      folder.remove(file.file)
      manifest.transitionFiles[name] = nil
    }
    save()
  }

  // MARK: Asking for transitions (Task 8)

  private func keepNextTransition() {}
  private func transitionFileArrived(_ id: String, path: String, bytes: Int64) { dropUnwantedTransitionFiles() }
  private func transitionFileFailed(_ id: String, _ failure: TransportFailure) {}

  // MARK: Levels

  /// Even volume for downloads' songs, asked once while online (50 to a request) and kept with the download.
  private func refreshLevels() async {
    let missing = Set(manifest.pins.values.flatMap { d in d.tracks.map(\.recordingId).filter { d.levels[$0] == nil } })
    guard online, !missing.isEmpty else { return }
    let ids = missing.sorted()
    var found: [String: TrackLevel] = [:]
    for start in stride(from: 0, to: ids.count, by: LevelStore.batchSize) {
      guard let batch = try? await backend.levels(Array(ids[start..<min(start + LevelStore.batchSize, ids.count)])) else { return }
      found.merge(batch) { _, new in new }
    }
    for key in manifest.pins.keys {
      guard let tracks = manifest.pins[key]?.tracks else { continue }
      for t in tracks { if let level = found[t.recordingId] { manifest.pins[key]?.levels[t.recordingId] = level } }
    }
    save()
  }

  // MARK: Disk

  /// Forget files that are gone, and take on what's on disk that the manifest doesn't know: whole songs the stream
  /// cache kept before it had a ledger, or the background session finished while another account was active.
  private func reconcile() {
    let songs = folder.songFiles()
    let transitions = folder.transitionFiles()
    manifest.songs = manifest.songs.filter { songs[$0.key] != nil }
    for (id, found) in songs where manifest.songs[id] == nil {
      manifest.songs[id] = KeptFile(file: found.path, bytes: found.bytes, usedAt: found.modified)
    }
    let wanted = OfflineRules.pinnedTransitionFiles(manifest.pins)
    manifest.transitionFiles = manifest.transitionFiles.filter { transitions[$0.key] != nil }
    for (name, found) in transitions {
      if !wanted.contains(name) {
        folder.remove(found.path)
        manifest.transitionFiles[name] = nil
      } else if manifest.transitionFiles[name] == nil {
        manifest.transitionFiles[name] = KeptFile(file: found.path, bytes: found.bytes, usedAt: found.modified)
      }
    }
    save()
    fitLimit()
  }

  private func save() { saved.write(manifest) }

  private func resumeURL(_ id: String) -> URL { folder.resume.appending(path: id.replacingOccurrences(of: "/", with: "_")) }
  private func resumeData(_ id: String) -> Data? { try? Data(contentsOf: resumeURL(id)) }
  private func saveResumeData(_ data: Data, _ id: String) { try? data.write(to: resumeURL(id)) }
  private func clearResumeData(_ id: String) { try? FileManager.default.removeItem(at: resumeURL(id)) }

  // MARK: Another account's

  /// What an account keeps on this device, without opening its store: sign-out asks before removing it.
  nonisolated public static func summary(of folder: OfflineFolder) -> (downloads: Int, bytes: Int64) {
    let manifest = JSONFile<OfflineManifest>(folder.manifest).read() ?? OfflineManifest()
    let bytes = folder.songFiles().values.reduce(Int64(0)) { $0 + $1.bytes } + folder.transitionFiles().values.reduce(Int64(0)) { $0 + $1.bytes }
    return (manifest.pins.count, bytes)
  }

  /// Removes everything an account keeps here: its jobs stop, its files go.
  nonisolated public static func removeEverything(in folder: OfflineFolder, transport: any DownloadTransport) async {
    for id in await transport.running() where folder.path(ofJob: id) != nil { transport.cancel(id) }
    folder.removeAll()
  }
}
