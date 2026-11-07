import CryptoKit
import Foundation
import Synchronization

/// A server's home-network address (`ServerRecord.localURL`), tried when its public address can't be reached (a router
/// without NAT loopback), and whether this account's token may go there on the network the phone is on now: only on
/// Wi-Fi or a wired network (`LocalNetwork`), and only once whatever answers there has proven it's the server holding
/// this account's session. On a café's network, anything could be answering at 192.168.1.103.
///
/// The proof (`GET /api/auth/proof`; docs/server/accounts-and-access.md, "The home address"): the app sends a fresh
/// nonce and names its session by HMAC-SHA256(key: the token's SHA-256, "playarr-home-id:" + nonce); the server, which
/// stores only that SHA-256, finds the session it names and answers HMAC-SHA256(the same key, "playarr-home-proof:" +
/// nonce). The question carries neither the token nor its hash, nor anything to work the hash out from, so only the
/// server can answer it. It's asked once on each network the phone joins: a proof holds while the phone stays on that
/// network, an answer that doesn't prove anything for 10 minutes, no answer at all for 30 s. A server too old to know the
/// proof never proves itself, and the app keeps to the public address there.
public final class HomeAddress: Sendable {
    public let url: URL
    private let key: SymmetricKey
    private let session: URLSession
    private let network: LocalNetwork
    private let state = Mutex(State())

    enum Outcome: Sendable {
        case proven
        /// Something answered, and didn't prove it holds the session: an impostor, or a server without the proof.
        case refused
        /// Nothing answered, or not now (busy, too many asks).
        case unanswered
    }

    private struct State {
        var last: (generation: Int, outcome: Outcome, at: ContinuousClock.Instant)?
        /// The question out now, which everyone asking on that network waits for.
        var asking: (generation: Int, task: Task<Bool, Never>)?
    }

    /// `token`: the account's, only ever kept here as the key the server's answer is checked with (its SHA-256).
    public init(url: URL, token: String, session: URLSession = .shared, network: LocalNetwork = .shared) {
        self.url = url
        key = Self.key(token: token)
        self.session = session
        self.network = network
    }

    /// Proven on the network the phone is on now: what a request checks just before it goes there, without asking.
    public var isProven: Bool {
        let now = network.now
        return now.isLocal && state.withLock { $0.last.map { $0.generation == now.generation && $0.outcome == .proven } ?? false }
    }

    /// Whether the token may go to the home address on the network the phone is on now. On Wi-Fi or a wired network the
    /// server there is asked the first time (everyone asking meanwhile waits for the one answer), and its answer kept: a
    /// proof while the phone stays on the network, anything else for a while (`Outcome.holds`).
    public func verify() async -> Bool {
        let now = await network.current()
        guard now.isLocal else { return false }
        enum Step {
            case known(Bool)
            case waiting(Task<Bool, Never>)
        }
        let step: Step = state.withLock { state in
            if let last = state.last, last.generation == now.generation, last.outcome.holds(since: last.at) {
                return .known(last.outcome == .proven)
            }
            if let asking = state.asking, asking.generation == now.generation { return .waiting(asking.task) }
            let task = Task { await self.ask(on: now.generation) }
            state.asking = (now.generation, task)
            return .waiting(task)
        }
        switch step {
        case .known(let proven): return proven
        case .waiting(let task): return await task.value
        }
    }

    /// Asks the server at the home address to prove itself, and keeps its answer for the network it was asked on.
    private func ask(on generation: Int) async -> Bool {
        let outcome = await Self.prove(at: url, key: key, session: session)
        Log.network.info("The home address, asked to prove itself: \(String(describing: outcome), privacy: .public)")
        state.withLock { state in
            state.last = (generation, outcome, .now)
            if state.asking?.generation == generation { state.asking = nil }
        }
        return outcome == .proven && network.now.generation == generation
    }

    static let idMessage = "playarr-home-id:"
    static let proofMessage = "playarr-home-proof:"

    /// The key the server's answer is checked with: the token's SHA-256, which is what the server stores of it.
    static func key(token: String) -> SymmetricKey {
        SymmetricKey(data: SHA256.hash(data: Data(token.utf8)))
    }

    /// One question to the server at `url`, and whether its answer proves it holds the session whose key this is.
    static func prove(at url: URL, key: SymmetricKey, session: URLSession) async -> Outcome {
        let nonce = base64URL(SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) })
        // Without the token: the question names the session only by `id`, which gives an impostor nothing to answer from.
        let client = APIClient(baseURL: url, session: session, timeout: 5)
        do {
            let answer = try await client.send(API.Auth.proof(id: id(nonce: nonce, key: key), nonce: nonce))
            return proves(answer.proof, nonce: nonce, key: key) ? .proven : .refused
        } catch APIError.offline, is CancellationError {
            return .unanswered
        } catch APIError.server(let status, _) where status == 429 || status >= 500 {
            return .unanswered
        } catch {
            // Something answered: a server from before the proof (401, 404), or something that isn't Playarr.
            return .refused
        }
    }

    /// What the question names the session by: HMAC-SHA256(key, "playarr-home-id:" + nonce), base64url.
    static func id(nonce: String, key: SymmetricKey) -> String {
        base64URL(Data(HMAC<SHA256>.authenticationCode(for: Data((idMessage + nonce).utf8), using: key)))
    }

    /// Whether `proof` is HMAC-SHA256(key, "playarr-home-proof:" + nonce), compared in constant time.
    static func proves(_ proof: String, nonce: String, key: SymmetricKey) -> Bool {
        guard let mac = data(base64URL: proof) else { return false }
        return HMAC<SHA256>.isValidAuthenticationCode(mac, authenticating: Data((proofMessage + nonce).utf8), using: key)
    }

    static func base64URL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    static func data(base64URL text: String) -> Data? {
        let base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        return Data(base64Encoded: base64 + String(repeating: "=", count: (4 - base64.count % 4) % 4))
    }
}

extension HomeAddress.Outcome {
    /// Whether an answer still stands on the network it was given on: a proof for as long as the phone stays there.
    func holds(since: ContinuousClock.Instant) -> Bool {
        switch self {
        case .proven: true
        case .refused: .now < since + .seconds(600)
        case .unanswered: .now < since + .seconds(30)
        }
    }
}
