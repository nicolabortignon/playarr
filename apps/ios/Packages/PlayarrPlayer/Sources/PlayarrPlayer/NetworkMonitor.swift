import Foundation
import Network
import Observation

public enum NetworkKind: Sendable, Equatable {
  case wifi
  /// Mobile data or a hotspot.
  case cellular
  /// Low Data Mode (the web's data saver).
  case constrained
  case offline
}

/// How many songs after the current one to fetch ahead (`loadAhead.ts` on the web): 3 on Wi-Fi, 1 on mobile data,
/// none in Low Data Mode or offline.
public enum PrefetchPolicy {
  public static func songsAhead(on network: NetworkKind) -> Int {
    switch network {
    case .wifi: 3
    case .cellular: 1
    case .constrained, .offline: 0
    }
  }
}

/// The network the phone is on, from NWPathMonitor.
@MainActor @Observable
public final class NetworkMonitor {
  public private(set) var kind: NetworkKind = .wifi
  /// Called on the main actor when the kind changes.
  @ObservationIgnored public var onChange: (@MainActor (NetworkKind) -> Void)?
  @ObservationIgnored private let monitor = NWPathMonitor()

  public init() {
    monitor.pathUpdateHandler = { [weak self] path in
      let kind = NetworkKind(path)
      Task { @MainActor in
        guard let self, self.kind != kind else { return }
        self.kind = kind
        self.onChange?(kind)
      }
    }
    monitor.start(queue: DispatchQueue(label: "playarr.network"))
  }

  isolated deinit { monitor.cancel() }
}

extension NetworkKind {
  init(_ path: NWPath) {
    if path.status != .satisfied {
      self = .offline
    } else if path.isConstrained {
      self = .constrained
    } else if path.isExpensive {
      self = .cellular
    } else {
      self = .wifi
    }
  }
}
