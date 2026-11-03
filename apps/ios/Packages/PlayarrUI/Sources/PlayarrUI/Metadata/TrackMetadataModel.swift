import Observation
import PlayarrAPI

/// Show metadata: everything Playarr knows about a song and where each file of it is; admins can match a file
/// again on MusicBrainz, or ask Lidarr to refresh it (TrackMetadataDialog.tsx, useTrackMetadata, useRematchFile).
@MainActor @Observable
public final class TrackMetadataModel {
  /// What a "Match again" said, under its button.
  public struct Outcome: Equatable, Sendable {
    public let text: String
    public let isError: Bool
  }

  /// The song shown; a match can move the file to another song, and the sheet follows it.
  public private(set) var trackId: Int
  public private(set) var metadata: TrackMetadata?
  public private(set) var error: String?
  /// The file being matched again.
  public private(set) var rematching: Int?
  public private(set) var outcomes: [Int: Outcome] = [:]

  @ObservationIgnored private let api: any APISending
  @ObservationIgnored private let toast: @MainActor (String, Bool) -> Void
  @ObservationIgnored private let invalidate: @MainActor ([CacheFamily]) -> Void

  public init(
    trackId: Int, api: any APISending, toast: @escaping @MainActor (String, Bool) -> Void, invalidate: @escaping @MainActor ([CacheFamily]) -> Void
  ) {
    self.trackId = trackId
    self.api = api
    self.toast = toast
    self.invalidate = invalidate
  }

  /// The file the main "Match again" acts on; none when paths are hidden (the account isn't an admin).
  public var primary: TrackCopyMetadata? {
    guard let metadata, !metadata.pathsHidden else { return nil }
    return MetadataFormat.primaryCopy(metadata.copies)
  }

  /// With several files, each other file can be matched again on its own (admins only: they see paths).
  public func offersRematch(for copy: TrackCopyMetadata) -> Bool {
    guard let metadata else { return false }
    return metadata.copies.count > 1 && copy.fileId != primary?.fileId && copy.path != nil
  }

  /// Always fresh: files and matches change.
  public func load() async {
    do {
      metadata = try await api.send(API.Library.trackMetadata(id: trackId))
      error = nil
    } catch is CancellationError {
    } catch {
      self.error = error.localizedDescription
    }
  }

  public func rematch(_ copy: TrackCopyMetadata) async {
    guard rematching == nil else { return }
    rematching = copy.fileId
    outcomes[copy.fileId] = nil
    defer { rematching = nil }
    do {
      let result = try await api.send(API.Library.rematchFile(fileId: copy.fileId))
      // Everything showing songs may change.
      invalidate(CacheFamily.allCases)
      switch result {
      case .lidarr(let lidarr):
        outcomes[copy.fileId] = Outcome(text: lidarr.message, isError: false)
      case .folder(let folder):
        let text = MetadataFormat.outcome(folder.state)
        // A match can give the song its real MusicBrainz id, and with it another place in the catalog: follow it
        // there (this sheet reloads, so the outcome goes to a toast).
        if let moved = folder.trackId, moved != trackId {
          toast(text, false)
          trackId = moved
          outcomes = [:]
          metadata = nil
          await load()
        } else {
          outcomes[copy.fileId] = Outcome(text: text, isError: false)
          await load()
        }
      case .unknown:
        outcomes[copy.fileId] = Outcome(text: "Done.", isError: false)
      }
    } catch {
      outcomes[copy.fileId] = Outcome(text: error.localizedDescription, isError: true)
    }
  }
}
