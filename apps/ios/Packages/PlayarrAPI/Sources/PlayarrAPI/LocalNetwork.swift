import Foundation
import Network
import Synchronization

/// Whether the phone is on a Wi-Fi or wired network now, where a server's home address can be: not mobile data or a
/// hotspot, where a private address could be anyone's. And which network that is: `generation` moves on with every
/// change NWPathMonitor sees, so what a home address proved on one network isn't trusted on the next (`HomeAddress`).
public final class LocalNetwork: Sendable {
    public struct State: Equatable, Sendable {
        /// Moves on with every change of network.
        public var generation: Int
        /// On Wi-Fi or a wired network.
        public var isLocal: Bool
    }

    /// The app's, watched from first use for as long as it runs.
    public static let shared = LocalNetwork.watching()

    private struct Paths {
        /// Nil until the monitor's first path.
        var state: State?
        var waitingForFirst: [CheckedContinuation<State, Never>] = []
    }

    private let paths: Mutex<Paths>
    /// Kept for as long as this is.
    private let monitor: NWPathMonitor?

    /// A network that changes only through `change(isLocal:)` (tests).
    public init(isLocal: Bool) {
        paths = Mutex(Paths(state: State(generation: 0, isLocal: isLocal)))
        monitor = nil
    }

    private init(monitor: NWPathMonitor) {
        paths = Mutex(Paths())
        self.monitor = monitor
    }

    private static func watching() -> LocalNetwork {
        let monitor = NWPathMonitor()
        let network = LocalNetwork(monitor: monitor)
        monitor.pathUpdateHandler = pathHandler(for: network)
        monitor.start(queue: DispatchQueue(label: "playarr.local-network"))
        // No path at all after 2 s: not a local network, until one comes.
        DispatchQueue.global().asyncAfter(deadline: .now() + 2, execute: lateFirstPath(for: network))
        return network
    }

    /// Made outside any actor: Network calls it on its own queue.
    private nonisolated static func pathHandler(for network: LocalNetwork) -> @Sendable (NWPath) -> Void {
        { [weak network] path in network?.change(isLocal: isLocal(path)) }
    }

    private nonisolated static func lateFirstPath(for network: LocalNetwork) -> @Sendable () -> Void {
        { [weak network] in network?.settle() }
    }

    /// Wi-Fi or Ethernet, and not a network that costs (a hotspot shares mobile data over Wi-Fi).
    nonisolated static func isLocal(_ path: NWPath) -> Bool {
        path.status == .satisfied && !path.isExpensive && (path.usesInterfaceType(.wifi) || path.usesInterfaceType(.wiredEthernet))
    }

    /// The network now, without waiting: not a local one before the first path is known.
    public var now: State {
        paths.withLock { $0.state } ?? State(generation: -1, isLocal: false)
    }

    /// The network now; right after launch, once the first path is known (at most 2 s).
    public func current() async -> State {
        if let state = paths.withLock({ $0.state }) { return state }
        return await withCheckedContinuation { continuation in
            let state: State? = paths.withLock { paths in
                if paths.state == nil { paths.waitingForFirst.append(continuation) }
                return paths.state
            }
            if let state { continuation.resume(returning: state) }
        }
    }

    /// The phone moved to another network (the path monitor, or a test).
    public func change(isLocal: Bool) {
        let (state, waiting) = paths.withLock { paths in
            let state = State(generation: (paths.state?.generation ?? -1) + 1, isLocal: isLocal)
            let waiting = paths.waitingForFirst
            paths.state = state
            paths.waitingForFirst = []
            return (state, waiting)
        }
        for continuation in waiting { continuation.resume(returning: state) }
    }

    /// The first path is late: whoever waits for it hears "not local".
    private func settle() {
        let (state, waiting) = paths.withLock { paths -> (State?, [CheckedContinuation<State, Never>]) in
            guard paths.state == nil else { return (nil, []) }
            let waiting = paths.waitingForFirst
            paths.state = State(generation: 0, isLocal: false)
            paths.waitingForFirst = []
            return (paths.state, waiting)
        }
        if let state { for continuation in waiting { continuation.resume(returning: state) } }
    }
}
