import Foundation
import Observation
import PlayarrAPI
import PlayarrPlayer

/// One mix's page: why these songs, when it changes, Play, Shuffle, New mix, Save as playlist, Play next and Add to
/// queue (apps/web/src/pages/Mix.tsx). Every call says the device's time zone.
@MainActor @Observable
final class MixModel {
  let key: String
  private(set) var mix: MixDetail?
  private(set) var error: String?
  /// "New mix" is being made ("Mixing…").
  private(set) var regenerating = false
  private(set) var saving = false

  @ObservationIgnored private let session: AccountSession
  @ObservationIgnored private let clock: any Clock<Duration>
  @ObservationIgnored private let timeZone: TimeZone

  init(key: String, session: AccountSession, clock: any Clock<Duration> = ContinuousClock(), timeZone: TimeZone = .current) {
    self.key = key
    self.session = session
    self.clock = clock
    self.timeZone = timeZone
  }

  var source: PlaySource { PlaySource(label: mix?.title ?? "", href: "/mixes/\(key)") }

  /// "25 songs · 1 hr 32 min · Changes in 9 h".
  func facts(now: Date = Date()) -> String {
    guard let mix else { return "" }
    var parts = [Format.plural(mix.trackCount, "song"), Format.duration(mix.duration)]
    if let due = Format.parseDate(mix.refreshesAt) { parts.append(Format.changes(at: due, now: now, timeZone: timeZone)) }
    return parts.joined(separator: " · ")
  }

  func load() async {
    do {
      mix = try await session.api.send(API.Mixes.get(key: key, timeZone: timeZone))
      error = nil
    } catch {
      if mix == nil { self.error = error.localizedDescription }
    }
  }

  /// Asks again 5 s after the mix is due to change, while the page is up.
  func poll() async {
    await Polling.run(
      clock: clock,
      interval: { [weak self] in MixesStore.recheck(due: [self?.mix?.refreshesAt].compactMap { $0.flatMap(Format.parseDate) }) },
      refresh: { [weak self] in await self?.load() })
  }

  /// "New mix": another draw for the same hour, day or week.
  func regenerate() async {
    guard !regenerating else { return }
    regenerating = true
    defer { regenerating = false }
    do {
      mix = try await session.api.send(API.Mixes.regenerate(key: key, timeZone: timeZone))
      await session.mixes.load()
    } catch {
      session.toasts.push("Couldn’t make a new mix: \(error.localizedDescription)", tone: .error)
    }
  }

  /// "Save as playlist": keeps the mix as an ordinary playlist and answers it, so the page can open it.
  func save() async -> PlaylistDetail? {
    guard !saving else { return nil }
    saving = true
    defer { saving = false }
    do {
      let playlist = try await session.api.send(API.Mixes.save(key: key, timeZone: timeZone))
      session.toasts.push("Saved as “\(playlist.name)”")
      await session.playlists.settled(playlist)
      return playlist
    } catch {
      session.toasts.push("Couldn’t save the mix: \(error.localizedDescription)", tone: .error)
      return nil
    }
  }

  func play(shuffle: Bool) {
    guard let tracks = mix?.tracks, !tracks.isEmpty else { return }
    session.player.play(tracks, source: source, shuffle: shuffle)
  }

  func queue(next: Bool) {
    guard let tracks = mix?.tracks, !tracks.isEmpty else { return }
    next ? session.actions.playNext(tracks) : session.actions.addToQueue(tracks)
  }
}
