import Observation
import PlayarrAPI

/// How busy MusicBrainz is (it answers about once a second): asked every 1.5 s while lookups wait, every 15 s
/// otherwise (useMusicBrainzStatus), only while something on screen shows it (`watch()` runs in a view's `.task`).
@MainActor @Observable
public final class MusicBrainzStatusModel {
  public private(set) var status: MusicBrainzStatus?

  @ObservationIgnored private let api: any APISending
  @ObservationIgnored private let clock: any Clock<Duration>

  public init(api: any APISending, clock: any Clock<Duration> = ContinuousClock()) {
    self.api = api
    self.clock = clock
  }

  public static func interval(after status: MusicBrainzStatus?) -> Duration {
    (status?.queued ?? 0) > 0 ? .milliseconds(1500) : .seconds(15)
  }

  /// Keeps `status` fresh until the calling task is cancelled (waiting while the app is in the background).
  public func watch() async {
    await Polling.run(clock: clock, interval: { [weak self] in Self.interval(after: self?.status) }) { [weak self] in
      guard let self, let fresh = try? await api.send(API.Server.musicBrainzStatus()) else { return }
      status = fresh
    }
  }
}
