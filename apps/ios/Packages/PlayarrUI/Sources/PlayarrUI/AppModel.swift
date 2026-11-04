import Foundation
import Observation
import PlayarrAPI
import PlayarrPlayer

/// The app's root state: the servers and accounts, Bonjour, and what the root view shows.
@MainActor @Observable
public final class AppModel {
    /// Makes the session of a signed-in account (live, or the demo).
    public typealias SessionFactory = @MainActor (AccountRecord, AppModel) throws -> AccountSession?

    public let store: ServerStore
    public let browser: ServerBrowser
    public let appVersion: AppVersion
    public let device: DeviceInfo
    /// Settings → Playback and Appearance: this device's, whoever is signed in.
    public let playback: PlaybackSettings
    public let appearance: AppearanceSettings
    public let theme: Theme
    public let toasts = ToastCenter()
    /// The active account's session; nil while no account is signed in.
    public private(set) var session: AccountSession?
    /// The active server needs a newer app.
    public private(set) var tooOld: ServerInfo?
    /// A setup-code link to open (playarr://redeem).
    public var redeemLink: RedeemLink?
    public var showingAccounts = false
    /// The window comes back where it was after iOS closed the app in the background. UI tests turn it off (each
    /// test starts on Home) unless they launch with `-UITestsRestore`.
    public var restoresPlace = true
    /// The app is on screen (a request that lands in the background is a notification instead).
    public var isActive = true

    @ObservationIgnored private let makeSession: SessionFactory

    public init(
        store: ServerStore, browser: ServerBrowser, appVersion: AppVersion, device: DeviceInfo,
        playback: PlaybackSettings = PlaybackSettings(), appearance: AppearanceSettings = AppearanceSettings(),
        makeSession: @escaping SessionFactory = AccountSession.live
    ) {
        self.store = store
        self.browser = browser
        self.appVersion = appVersion
        self.device = device
        self.playback = playback
        self.appearance = appearance
        self.theme = Theme(appearance: appearance)
        self.makeSession = makeSession
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

    /// Signed in to the demo library, playing silence: for UI tests (`-UITestsDemo`). Nothing is kept. `requests`: the
    /// demo with Lidarr and an album to request, as an account that may request (`-UITestsRequests`, `DemoRequestsAPI`).
    /// `api`: another server to answer (one that can't be reached, for the error states).
    public static func demo(requests: Bool = false, api custom: (any APISending)? = nil) -> AppModel {
        let directory = FileManager.default.temporaryDirectory.appending(path: "playarr-\(UUID().uuidString)", directoryHint: .isDirectory)
        let store = ServerStore(directory: directory, secrets: InMemorySecretStore())
        let account = requests ? DemoRequestsAPI.account : Demo.account
        let api: any APISending = custom ?? (requests ? DemoRequestsAPI() : DemoAPI())
        try? store.signedIn(SignInResponse(token: "demo", account: account), server: Demo.server, at: Demo.baseURL)
        let defaults = UserDefaults(suiteName: "playarr-demo-\(UUID().uuidString)") ?? .standard
        let model = AppModel(
            store: store, browser: ServerBrowser(), appVersion: .current, device: .current(),
            playback: PlaybackSettings(defaults: defaults), appearance: AppearanceSettings(defaults: defaults),
            makeSession: { record, model in try AccountSession.demo(record, model: model, api: api) })
        model.syncSession()
        return model
    }

    /// Opens the session of the active, signed-in account, closing the one before; none while signed out.
    public func syncSession() {
        let record = store.activeAccount.flatMap { $0.signedIn ? $0 : nil }
        guard record?.key != session?.key else { return }
        session?.close()
        session = nil
        guard let record else { return }
        do {
            session = try makeSession(record, self)
        } catch {
            toasts.push(error.localizedDescription, tone: .error)
        }
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
        await refreshAccount()
    }

    /// Asks the server for the signed-in account again: an admin may have renamed it, changed its role or rights,
    /// or locked settings on its devices since it signed in here.
    public func refreshAccount() async {
        guard let record = store.activeAccount, record.signedIn, let client = store.client(for: record),
            let me = try? await client.send(API.Auth.me()), me.id == record.account.id, me != record.account
        else { return }
        store.update(me, on: record.serverId)
    }

    /// Someone came through a server's checks: it is new enough.
    func connected(to info: ServerInfo) {
        if info.supports(appVersion), tooOld?.id == info.id { tooOld = nil }
    }
}
