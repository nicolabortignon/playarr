#if os(iOS)
  import AVFAudio
  import Foundation

  /// The app's AVAudioSession: category `.playback` (mode `.default`) with the background-audio mode from Info.plist,
  /// so music plays on the lock screen; interruptions, route changes and media-server resets go to `onEvent`.
  @MainActor
  public final class AudioSessionController: AudioSessionControlling {
    private var observers: [any NSObjectProtocol] = []
    /// Read again as the output changes (AirPods, AirPlay), not on every tick.
    public private(set) var outputLatency: Double = 0

    public init(onEvent: @escaping @MainActor (SessionEvent) -> Void) {
      let center = NotificationCenter.default
      let session = AVAudioSession.sharedInstance()
      let names = [
        AVAudioSession.interruptionNotification, AVAudioSession.routeChangeNotification,
        AVAudioSession.mediaServicesWereResetNotification,
      ]
      for name in names {
        // Delivered on the main queue, as asked.
        observers.append(
          center.addObserver(forName: name, object: session, queue: .main) { [weak self] note in
            if note.name == AVAudioSession.routeChangeNotification {
              MainActor.assumeIsolated { self?.outputLatency = AVAudioSession.sharedInstance().outputLatency }
            }
            guard let event = SessionEvent(note) else { return }
            MainActor.assumeIsolated { onEvent(event) }
          })
      }
    }

    isolated deinit {
      for observer in observers { NotificationCenter.default.removeObserver(observer) }
    }

    public func activate() throws {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.playback, mode: .default)
      try session.setActive(true)
      outputLatency = session.outputLatency
    }
  }

  extension SessionEvent {
    init?(_ note: Notification) {
      let info = note.userInfo ?? [:]
      switch note.name {
      case AVAudioSession.interruptionNotification:
        guard let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt, let type = AVAudioSession.InterruptionType(rawValue: raw) else { return nil }
        if type == .began {
          self = .interruptionBegan
        } else {
          let options = AVAudioSession.InterruptionOptions(rawValue: info[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
          self = .interruptionEnded(shouldResume: options.contains(.shouldResume))
        }
      case AVAudioSession.routeChangeNotification:
        guard let raw = info[AVAudioSessionRouteChangeReasonKey] as? UInt,
          AVAudioSession.RouteChangeReason(rawValue: raw) == .oldDeviceUnavailable
        else { return nil }
        self = .oldDeviceUnavailable
      case AVAudioSession.mediaServicesWereResetNotification:
        self = .mediaServicesReset
      default:
        return nil
      }
    }
  }
#endif
