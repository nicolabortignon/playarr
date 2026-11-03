import Foundation
import Observation
import PlayarrAPI

/// DJ mix's side of the player: asks for the transition into the next song (`TransitionPlanner`), downloads its file
/// whole into the stream cache once it's ready, and keeps the songs' mix maps (`MixMapStore`) for cuts on the beat, the
/// transition sheet and presses of Next. The Player asks it nothing directly: it reads `planner.upcoming`, `file(for:)`
/// and `mixMaps` when it picks the next song's join, and is told (`onChange`) when any of them moves.
@MainActor @Observable
public final class TransitionCoordinator {
  /// A press of Next waits for a mix into the same song starting within this long (`BRIDGE_SOON_S`).
  public static let mixSoon = 3.0

  public let planner: TransitionPlanner
  public let mixMaps: MixMapStore
  /// Transition files on this device, by the server's URL for them.
  public private(set) var files: [String: URL] = [:]
  /// Files that wouldn't download: those mixes play as if no file had come.
  public private(set) var failedFiles: Set<String> = []

  @ObservationIgnored public var onChange: (@MainActor () -> Void)?
  @ObservationIgnored private var downloading: [String: Task<Void, Never>] = [:]
  @ObservationIgnored private let download: @Sendable (String) async throws -> URL

  /// `download` fetches a transition file whole (into the stream cache) and answers where it is.
  public init(planner: TransitionPlanner, mixMaps: MixMapStore, download: @escaping @Sendable (String) async throws -> URL) {
    self.planner = planner
    self.mixMaps = mixMaps
    self.download = download
    planner.onChange = { [weak self] in self?.answerChanged() }
  }

  /// The planner's answer for `from` → `to`, if it's working on that pair.
  public func result(from: Track, to: Track) -> TransitionPlanner.Result? {
    let upcoming = planner.upcoming
    guard upcoming.fromFileId == from.fileId, upcoming.toFileId == to.fileId else { return nil }
    return upcoming.result
  }

  /// The ready answer's file, once it's all here.
  public func file(for result: TransitionPlanner.Result?) -> URL? {
    guard case .answer(.ready(let ready))? = result else { return nil }
    return files[ready.url]
  }

  /// Downloads the file of a ready answer, once: before it's needed, not as it plays.
  private func answerChanged() {
    if case .answer(.ready(let ready))? = planner.upcoming.result, files[ready.url] == nil, downloading[ready.url] == nil,
      !failedFiles.contains(ready.url)
    {
      let url = ready.url
      let download = self.download
      downloading[url] = Task { [weak self] in
        let file: URL?
        do { file = try await download(url) } catch { file = nil }
        guard let self else { return }
        if let file { self.files[url] = file } else { self.failedFiles.insert(url) }
        self.downloading[url] = nil
        self.onChange?()
      }
    }
    onChange?()
  }
}
