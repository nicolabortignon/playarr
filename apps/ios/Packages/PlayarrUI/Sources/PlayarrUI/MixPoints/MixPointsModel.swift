import Observation
import PlayarrAPI
import PlayarrPlayer

/// Song menu → Edit mix points (MixPointsDialog.tsx): the song's energy over its bars with a mix-in and a mix-out
/// marker to move where the detection got them wrong, 8-second previews from each, Reset and Save (per recording, on
/// the server). Only offered with DJ mix on, the one setting that uses them.
@MainActor @Observable
public final class MixPointsModel {
  public let track: Track
  public private(set) var editor: MixPointsEditor?
  /// The strip: the song's energy per phrase and its bar lines, across the whole song (phase 5's `EnergyPicture`).
  public private(set) var phrases: [EnergyPicture.Phrase] = []
  public private(set) var bars: [EnergyPicture.Bar] = []
  /// The server answered (a song not analysed yet has no map).
  public private(set) var loaded = false
  public private(set) var error: String?
  public private(set) var saving = false
  public private(set) var saveError: String?

  @ObservationIgnored private let api: any APISending
  @ObservationIgnored private weak var player: (any MixPreviewing)?
  @ObservationIgnored private let toast: @MainActor (String, Bool) -> Void
  @ObservationIgnored private let invalidate: @MainActor ([CacheFamily]) -> Void
  @ObservationIgnored private let cuesChanged: @MainActor (String) -> Void

  /// `cuesChanged`: the player forgets the song's map and asks again for a coming transition made with the old points.
  public init(
    track: Track, api: any APISending, player: (any MixPreviewing)?, toast: @escaping @MainActor (String, Bool) -> Void,
    invalidate: @escaping @MainActor ([CacheFamily]) -> Void, cuesChanged: @escaping @MainActor (String) -> Void
  ) {
    self.track = track
    self.api = api
    self.player = player
    self.toast = toast
    self.invalidate = invalidate
    self.cuesChanged = cuesChanged
  }

  public static let notAnalyzed =
    "This song hasn’t been analyzed yet, so there are no mix points to move. Playarr measures songs in the background: try again later."

  public func load() async {
    do {
      let maps = try await api.send(API.Playback.mixMaps(ids: [track.recordingId]))
      let map = maps[track.recordingId]
      editor = map.map(MixPointsEditor.init(map:))
      if let map, map.duration > 0 {
        (phrases, bars) = EnergyPicture.phrasesAndBars(map, clock: { $0 }, from: 0, to: map.duration)
      }
      loaded = true
      error = nil
    } catch is CancellationError {
    } catch {
      self.error = error.localizedDescription
    }
  }

  public func drag(_ point: MixPointsEditor.Point, to seconds: Double) { editor?.drag(point, to: seconds) }

  public func step(_ point: MixPointsEditor.Point, forward: Bool, phrase: Bool) { editor?.step(point, forward: forward, phrase: phrase) }

  /// "Play from mix in": 8 seconds from the marker, through the player, the queue left as it is.
  public func play(from point: MixPointsEditor.Point) {
    guard let editor else { return }
    player?.preview(track, from: editor.time(point), length: Player.previewSeconds)
  }

  /// Back to the detected points; saved at once if any were saved (nothing to tell the server otherwise).
  public func reset() async {
    guard var editor else { return }
    guard editor.saved != MixPointsEditor.Points() else {
      editor.clear()
      self.editor = editor
      return
    }
    _ = await send(MixPointsEditor.Points())
  }

  /// Saves the points; true when saved ("Mix points saved", and the sheet closes).
  public func save() async -> Bool {
    guard let editor, editor.changed else { return false }
    guard await send(editor.points) else { return false }
    toast("Mix points saved", false)
    return true
  }

  /// The sheet closed: a preview still playing stops, and the queue goes on if it was playing.
  public func close() { player?.endPreviews() }

  private func send(_ points: MixPointsEditor.Points) async -> Bool {
    saving = true
    saveError = nil
    defer { saving = false }
    do {
      _ = try await api.send(API.Playback.setCues(recordingId: track.recordingId, mixIn: points.mixIn, mixOut: points.mixOut))
      editor?.didSave(points)
      // The server forgot the transitions made with the old points: a coming one is asked for afresh, and the
      // transition view and the planner's inputs both come from the mix maps.
      cuesChanged(track.recordingId)
      invalidate([.mixMaps])
      return true
    } catch {
      saveError = "Couldn’t save the mix points: \(error.localizedDescription)"
      return false
    }
  }
}
