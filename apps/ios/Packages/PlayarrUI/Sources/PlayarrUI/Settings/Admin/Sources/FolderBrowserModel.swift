import Foundation
import Observation
import PlayarrAPI

/// The folder browser inside the folder form (FolderBrowser): folders on this server (starting from the
/// folders sources may use) or on another machine, one level at a time, and "Use this folder".
@MainActor @Observable
public final class FolderBrowserModel {
  public private(set) var listing: FolderListing?
  public private(set) var loading = false
  public private(set) var error: String?
  /// The folder being looked at; nil: the starting point.
  public private(set) var at: String?

  @ObservationIgnored private let api: any APISending
  @ObservationIgnored private let request: FolderBrowseRequest
  @ObservationIgnored private let rootLabel: String?

  /// `request`: the connection and/or saved source to browse (no path); empty for this server.
  public init(request: FolderBrowseRequest, start: String?, rootLabel: String? = nil, api: any APISending) {
    self.request = request
    self.rootLabel = rootLabel
    self.api = api
    at = start
  }

  var remote: Bool { request.connection.map { $0.access != .local } ?? false }

  public func load() async {
    loading = true
    defer { loading = false }
    var asked = request
    asked.path = at
    do {
      listing = try await api.send(API.Settings.browseFolders(asked))
      error = nil
    } catch {
      self.error = failureText(error)
    }
  }

  public func open(_ path: String?) async {
    at = path
    await load()
  }

  /// On this server, "up" from a root goes back to the list of roots; on another machine "/" is the top.
  public var canGoUp: Bool {
    guard let listing, listing.path != nil else { return false }
    return listing.parent != nil || !remote
  }

  public func up() async {
    guard canGoUp else { return }
    await open(listing?.parent)
  }

  /// The line above the list.
  public var title: String {
    if let path = listing?.path { return path == "/" && rootLabel != nil ? rootLabel ?? path : path }
    if remote { return loading ? "Connecting…" : "" }
    return "Folders Playarr may use"
  }

  /// A folder that can be chosen is on screen (not the list of roots, not an SMB server's shares).
  public var choosable: String? {
    guard let path = listing?.path, !(rootLabel != nil && path == "/") else { return nil }
    return path
  }

  public var emptyText: String? {
    guard let listing, listing.folders.isEmpty, listing.emptyRoot != true else { return nil }
    return rootLabel != nil && listing.path == "/" ? "No shares found." : "No folders inside."
  }

  /// "12 audio files here · selected".
  public func footer(selected: String?) -> String? {
    guard let listing, let path = choosable else { return nil }
    return "\(AdminText.plural(listing.audioFiles, "audio file")) here\(selected == path ? " · selected" : "")"
  }

  /// A root with nothing in it: in Docker, nothing is mounted there yet.
  public var emptyRootHelp: (title: String, detail: String)? {
    guard let listing, listing.emptyRoot == true, let path = listing.path else { return nil }
    return (
      "Nothing is shared with Playarr at \(path) yet.",
      "In Docker, Playarr only sees the host folders you mount inside \(path). Mount them read-only in a compose.override.yaml next to compose.yaml, for example /volume2:\(path)/volume2:ro, then restart Playarr."
    )
  }
}
