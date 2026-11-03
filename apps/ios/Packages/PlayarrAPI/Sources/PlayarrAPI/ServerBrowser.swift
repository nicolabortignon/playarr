import Foundation
import Network
import Observation
import Synchronization

/// Finds Playarr servers on the home network: browses `_playarr._tcp`, reads each TXT record and
/// resolves its address (IPv4). Starting it shows the Local Network permission prompt.
@MainActor @Observable
public final class ServerBrowser {
    public private(set) var servers: [DiscoveredServer] = []

    @ObservationIgnored private var browser: NWBrowser?

    public init() {}

    public func start() {
        guard browser == nil else { return }
        let browser = NWBrowser(for: .bonjourWithTXTRecord(type: "_playarr._tcp", domain: nil), using: NWParameters())
        browser.browseResultsChangedHandler = { [weak self] results, _ in
            let services = results.compactMap { result -> (NWEndpoint, [String: String])? in
                guard case .bonjour(let record) = result.metadata else { return nil }
                return (result.endpoint, record.dictionary)
            }
            Task { @MainActor in await self?.update(services) }
        }
        browser.start(queue: .main)
        self.browser = browser
    }

    public func stop() {
        browser?.cancel()
        browser = nil
        servers = []
    }

    private func update(_ services: [(NWEndpoint, [String: String])]) async {
        var found: [DiscoveredServer] = []
        for (endpoint, txt) in services {
            guard let (host, port) = await Self.resolve(endpoint),
                  let server = DiscoveredServer(txt: txt, host: host, port: port)
            else { continue }
            found = DiscoveredServer.merge(found, server)
        }
        servers = found
    }

    /// The service's IPv4 address and port, by connecting to it; nil after 5 s.
    nonisolated static func resolve(_ endpoint: NWEndpoint) async -> (String, Int)? {
        let parameters = NWParameters.tcp
        if let ip = parameters.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options { ip.version = .v4 }
        let connection = NWConnection(to: endpoint, using: parameters)
        let result = await withCheckedContinuation { (continuation: CheckedContinuation<(String, Int)?, Never>) in
            let once = ResumeOnce(continuation)
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    if case .hostPort(let host, let port) = connection.currentPath?.remoteEndpoint, let address = Self.address(host) {
                        once.resume((address, Int(port.rawValue)))
                    } else {
                        once.resume(nil)
                    }
                case .failed, .cancelled, .waiting:
                    once.resume(nil)
                default:
                    break
                }
            }
            connection.start(queue: .global())
            DispatchQueue.global().asyncAfter(deadline: .now() + 5) { once.resume(nil) }
        }
        connection.cancel()
        return result
    }

    nonisolated private static func address(_ host: NWEndpoint.Host) -> String? {
        switch host {
        case .ipv4(let address): "\(address)"
        case .ipv6(let address): "\(address)"
        case .name(let name, _): name
        @unknown default: nil
        }
    }
}

/// Resumes a continuation once, whichever callback comes first.
private final class ResumeOnce<T: Sendable>: Sendable {
    private let continuation: Mutex<CheckedContinuation<T, Never>?>

    init(_ continuation: CheckedContinuation<T, Never>) {
        self.continuation = Mutex(continuation)
    }

    func resume(_ value: T) {
        continuation.withLock { $0.take() }?.resume(returning: value)
    }
}
