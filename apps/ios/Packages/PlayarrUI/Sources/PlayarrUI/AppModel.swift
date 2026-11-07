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
    /// Why the active account's session couldn't open (its player's audio engine wouldn't start, or the Keychain
    /// couldn't be read): RootView says so with Try again, where it would otherwise wait for ever.
    public private(set) var sessionFailure: String?
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
    /// Trying Playarr without a server (plan 4 §1): the demo library's own model, shown instead of this one until
    /// it's left (`leaveTrial()`). Nothing of it is kept: its servers, settings and files are its own, thrown away then.
    public private(set) var trial: AppModel?
    /// On the demo tried from the welcome screen: the way back to it (the account button's "Leave the demo").
    public private(set) var leavesTrial: (@MainActor () -> Void)?
    /// This is the demo tried from the welcome screen, marked as one wherever the account button is.
    public var isTrial: Bool { leavesTrial != nil }
    /// Where someone without a server reads how to set one up: the repository's Getting started.
    public static let setUpURL = URL(string: "https://github.com/nicolabortignon/playarr#getting-started")!
    public typealias Scratch = (folder: URL, defaults: String)
    /// The demo's folder and settings suite (`demo()`), thrown away once the demo tried from the welcome screen is left.
    @ObservationIgnored private(set) var scratch: Scratch?
    /// "Try it without a server"'s: one folder and suite, emptied each time it starts and is left, so a demo the system
    /// closed midway leaves nothing behind either.
    static let trialScratch: Scratch = (FileManager.default.temporaryDirectory.appending(path: "playarr-trial", directoryHint: .isDirectory), "playarr.trial")

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
        // A known server found at home keeps that address as its local one, once the server there proves itself.
        browser.onUpdate = { [weak store] servers in _ = store?.discovered(servers) }
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
    /// `api`: another server to answer (one that can't be reached, for the error states). `scratch`: where its files and
    /// settings go (a new temporary folder and suite when nil).
    public static func demo(requests: Bool = false, api custom: (any APISending)? = nil, scratch: Scratch? = nil) -> AppModel {
        let id = UUID().uuidString
        let (folder, suite) = scratch ?? (FileManager.default.temporaryDirectory.appending(path: "playarr-demo-\(id)", directoryHint: .isDirectory), "playarr-demo-\(id)")
        let store = ServerStore(directory: folder.appending(path: "store", directoryHint: .isDirectory), secrets: InMemorySecretStore())
        let account = requests ? DemoRequestsAPI.account : Demo.account
        let api: any APISending = custom ?? (requests ? DemoRequestsAPI() : DemoAPI())
        try? store.signedIn(SignInResponse(token: "demo", account: account), server: Demo.server, at: Demo.baseURL)
        let defaults = UserDefaults(suiteName: suite) ?? .standard
        let model = AppModel(
            store: store, browser: ServerBrowser(), appVersion: .current, device: .current(),
            playback: PlaybackSettings(defaults: defaults), appearance: AppearanceSettings(defaults: defaults),
            makeSession: { record, model in
                try AccountSession.demo(record, model: model, api: api, folder: folder.appending(path: "session", directoryHint: .isDirectory))
            })
        model.scratch = (folder, suite)
        model.syncSession()
        return model
    }

    /// "Try it without a server": the demo library, signed in and playing silence, until `leaveTrial()`.
    public func tryWithoutServer() {
        guard trial == nil else { return }
        Self.forget(Self.trialScratch)
        let demo = AppModel.demo(scratch: Self.trialScratch)
        demo.leavesTrial = { [weak self] in self?.leaveTrial() }
        trial = demo
    }

    /// Back from the demo to the welcome screen, its session closed and nothing of it kept.
    public func leaveTrial() {
        guard let trial else { return }
        trial.session?.close()
        if let scratch = trial.scratch { Self.forget(scratch) }
        self.trial = nil
    }

    /// Throws away a demo's folder (its queue, downloads and covers) and the settings changed in it.
    private static func forget(_ scratch: Scratch) {
        try? FileManager.default.removeItem(at: scratch.folder)
        UserDefaults.standard.removePersistentDomain(forName: scratch.defaults)
    }

    /// Opens the session of the active, signed-in account, closing the one before; none while signed out. An account
    /// whose token isn't on this device is signed out, to sign in again; one whose session fails to open says why
    /// (`sessionFailure`) until this is called again (Try again).
    public func syncSession() {
        let record = store.activeAccount.flatMap { $0.signedIn ? $0 : nil }
        guard record?.key != session?.key else { return }
        session?.close()
        session = nil
        sessionFailure = nil
        guard let record else { return }
        do {
            guard let opened = try makeSession(record, self) else {
                // No token for it here: an unencrypted backup brings the server list back but leaves the Keychain out.
                store.markSignedOut(record.key)
                return
            }
            session = opened
        } catch {
            sessionFailure = Self.reason(error)
        }
    }

    /// What a session that couldn't open says under "The needle skipped.".
    static func reason(_ error: any Error) -> String {
        if error is KeychainError { return "This account’s sign-in couldn’t be read from the Keychain. Unlock the device and try again." }
        return "Playarr couldn’t get playback ready on this device: \(error.localizedDescription)"
    }

    /// playarr:// links: redeem a setup code, leaving the demo for it.
    public func open(_ url: URL) {
        guard let link = RedeemLink(url) else { return }
        leaveTrial()
        redeemLink = link
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
