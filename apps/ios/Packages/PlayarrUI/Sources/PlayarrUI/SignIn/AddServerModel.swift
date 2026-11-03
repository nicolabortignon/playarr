import Foundation
import Observation
import PlayarrAPI

/// Adding a server and signing in to it: by address or Bonjour, then sign-in, a setup code, or
/// claiming a server in setup mode.
@MainActor @Observable
public final class AddServerModel {
    public enum Step: Hashable, Sendable {
        case signIn, redeem, setup, tooOld
    }

    public struct Connected: Equatable, Sendable {
        public let info: ServerInfo
        public let url: URL
    }

    public var address = ""
    public private(set) var connected: Connected?
    public private(set) var busy = false
    public var error: String?

    @ObservationIgnored private let app: AppModel

    public init(app: AppModel) {
        self.app = app
    }

    /// The servers Bonjour found, and whether each is already added.
    public var discovered: [DiscoveredServer] { app.browser.servers }
    public func isAdded(_ server: DiscoveredServer) -> Bool { app.store.server(server.id) != nil }

    /// Where to go once connected.
    public var nextStep: Step? {
        guard let connected else { return nil }
        if !connected.info.supports(app.appVersion) { return .tooOld }
        return connected.info.setup ? .setup : .signIn
    }

    public var appVersion: AppVersion { app.appVersion }

    /// Connects to what was typed in the address field.
    @discardableResult
    public func connect() async -> Bool {
        do {
            return await connect(to: try ServerAddress.url(from: address))
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }

    /// Asks the server who it is (GET /api/server).
    @discardableResult
    public func connect(to url: URL) async -> Bool {
        busy = true
        error = nil
        defer { busy = false }
        do {
            let info = try await app.store.anonymousClient(for: url).send(API.Server.info())
            connected = Connected(info: info, url: url)
            app.connected(to: info)
            return true
        } catch APIError.decoding, APIError.server(404, _) {
            error = "That address doesn’t answer like a Playarr server."
        } catch {
            self.error = error.localizedDescription
        }
        return false
    }

    public func signIn(username: String, password: String) async -> Bool {
        await finish(API.Auth.signIn(username: username.trimmingCharacters(in: .whitespaces), password: password, device: app.device))
    }

    public func redeem(code: String, password: String) async -> Bool {
        await finish(API.Auth.redeem(code: code.trimmingCharacters(in: .whitespaces).uppercased(), password: password, device: app.device))
    }

    public func claim(username: String, name: String, password: String) async -> Bool {
        await finish(API.Auth.setup(username: username.trimmingCharacters(in: .whitespaces), name: name.trimmingCharacters(in: .whitespaces), password: password, device: app.device))
    }

    private func finish(_ endpoint: Endpoint<SignInResponse>) async -> Bool {
        guard let connected else { return false }
        busy = true
        error = nil
        defer { busy = false }
        do {
            let response = try await app.store.anonymousClient(for: connected.url).send(endpoint)
            try app.store.signedIn(response, server: connected.info, at: connected.url)
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }
}
