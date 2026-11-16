import Foundation
import Observation
import PlayarrAPI

/// Signing in a TV from the app (plan 9 §3): a `playarr://link` link, offered by the web's /link page on an iPhone or
/// iPad, carries the address the TV showed and its code. The model finds that server among the app's (by the address,
/// else by asking the address which server it is, so the TV's home address finds a server added by its public one),
/// asks which device the code is for, and signs it in as an account signed in here. The token only ever goes to the
/// server as the app knows it, never to the link's address.
@MainActor @Observable
public final class SignInTVModel {
  public enum Phase: Equatable {
    case finding
    /// No account signed in here on that server: the page in Safari instead.
    case notSignedIn
    case looking
    case ready
    case approving
    /// Signed in, as that account.
    case done(account: String)
    case failed(String)
  }

  public let link: DeviceLink
  public private(set) var phase: Phase = .finding
  /// The server's name, once it's known.
  public private(set) var serverName: String?
  /// Which device the code is for ("Living room TV").
  public private(set) var device: String?
  /// The accounts signed in here on that server, to sign the TV in as.
  public private(set) var accounts: [AccountRecord] = []
  public var chosen: AccountKey?

  @ObservationIgnored private let app: AppModel

  public init(app: AppModel, link: DeviceLink) {
    self.app = app
    self.link = link
  }

  public var chosenAccount: AccountRecord? { accounts.first { $0.key == chosen } }

  public func start() async {
    phase = .finding
    let store = app.store
    var server = store.servers.first { Self.sameOrigin($0.baseURL, link.server) || $0.localURL.map { Self.sameOrigin($0, link.server) } == true }
    if server == nil, let info = try? await store.anonymousClient(for: link.server).send(API.Server.info()) {
      serverName = info.name
      server = store.server(info.id)
    }
    guard let server else {
      phase = .notSignedIn
      return
    }
    serverName = server.name
    accounts = server.accounts.filter(\.signedIn)
    guard let first = accounts.first else {
      phase = .notSignedIn
      return
    }
    chosen = accounts.first { $0.key == store.active }?.key ?? first.key
    await lookUp()
  }

  public func approve() async {
    guard phase == .ready, let account = chosenAccount, let client = app.store.client(for: account) else { return }
    phase = .approving
    do {
      _ = try await client.send(API.Auth.deviceApprove(code: link.code))
      phase = .done(account: account.account.name)
    } catch {
      phase = .failed(failureText(error))
    }
  }

  private func lookUp() async {
    guard let account = chosenAccount, let client = app.store.client(for: account) else {
      phase = .notSignedIn
      return
    }
    phase = .looking
    do {
      device = try await client.send(API.Auth.deviceLookup(code: link.code)).device
      phase = .ready
    } catch {
      phase = .failed(failureText(error))
    }
  }

  /// The same scheme, host and port (a missing port is the scheme's own).
  static func sameOrigin(_ a: URL, _ b: URL) -> Bool {
    func port(_ url: URL) -> Int? { url.port ?? (url.scheme == "https" ? 443 : url.scheme == "http" ? 80 : nil) }
    return a.scheme?.lowercased() == b.scheme?.lowercased() && a.host()?.lowercased() == b.host()?.lowercased() && port(a) == port(b)
  }
}
