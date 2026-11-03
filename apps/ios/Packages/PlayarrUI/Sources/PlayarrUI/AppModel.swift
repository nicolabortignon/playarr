import Foundation
import Observation
import PlayarrAPI

/// The app's root state: the servers and accounts, Bonjour, and what the root view shows.
@MainActor @Observable
public final class AppModel {
    public let store: ServerStore
    public let browser: ServerBrowser
    public let appVersion: AppVersion
    public let device: DeviceInfo
    /// The active server needs a newer app.
    public private(set) var tooOld: ServerInfo?
    /// A setup-code link to open (playarr://redeem).
    public var redeemLink: RedeemLink?
    public var showingAccounts = false

    public init(store: ServerStore, browser: ServerBrowser, appVersion: AppVersion, device: DeviceInfo) {
        self.store = store
        self.browser = browser
        self.appVersion = appVersion
        self.device = device
        // A known server found at home keeps that address as its local one.
        browser.onUpdate = { [weak store] servers in store?.discovered(servers) }
    }

    public static func live() -> AppModel {
        AppModel(store: .live(), browser: ServerBrowser(), appVersion: .current, device: .current())
    }

    /// No servers, and nothing kept: for UI tests (`-UITests`) and previews.
    public static func empty() -> AppModel {
        let directory = FileManager.default.temporaryDirectory.appending(path: "playarr-\(UUID().uuidString)", directoryHint: .isDirectory)
        return AppModel(store: ServerStore(directory: directory, secrets: InMemorySecretStore()), browser: ServerBrowser(), appVersion: .current, device: .current())
    }

    /// playarr:// links: redeem a setup code.
    public func open(_ url: URL) {
        if let link = RedeemLink(url) { redeemLink = link }
    }

    /// Asks the active server who it is: its name may have changed, or it may need a newer app.
    public func checkActiveServer() async {
        guard let server = store.activeServer else { return }
        guard let info = try? await store.anonymousClient(for: server).send(API.Server.info()), info.id == server.id else { return }
        store.remember(info, at: server.baseURL)
        tooOld = info.supports(appVersion) ? nil : info
    }

    /// Someone came through a server's checks: it is new enough.
    func connected(to info: ServerInfo) {
        if info.supports(appVersion), tooOld?.id == info.id { tooOld = nil }
    }
}
