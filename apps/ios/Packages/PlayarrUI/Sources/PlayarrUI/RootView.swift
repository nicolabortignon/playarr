import PlayarrAPI
import SwiftUI

/// What the app shows: adding a server, signing in again, an update, the signed-in app, or why its session couldn't open.
public struct RootView: View {
    @Bindable var model: AppModel

    public init(model: AppModel) {
        self.model = model
    }

    public var body: some View {
        Group {
            if let trial = model.trial {
                // Trying it without a server: the demo's own app, until it's left.
                RootView(model: trial)
            } else {
                app
            }
        }
        // Outside every sheet, so they follow it too.
        .followsBoldText()
    }

    private var app: some View {
        content
            // Text without a font of its own is in the web's (Typography).
            .font(.sans(.body))
            .sheet(item: $model.redeemLink) { link in
                AddServerFlow(app: model, start: .redeem(link), onCancel: { model.redeemLink = nil }) { model.redeemLink = nil }
            }
            .sheet(item: $model.deviceLink) { link in
                SignInTVView(app: model, link: link) { model.deviceLink = nil }
            }
            .task(id: model.store.active) { await model.checkActiveServer() }
            .task(id: model.store.activeAccount) { model.syncSession() }
            .pinningDownloadedPages(model.session?.player.downloads) { model.session?.queries.setPinned($0) }
            .keepingDownloadedCovers(model.session?.player.downloads, images: model.session?.images)
    }

    @ViewBuilder private var content: some View {
        if let info = model.tooOld {
            UpdateRequiredView(serverName: info.name, minAppVersion: info.minAppVersion, appVersion: model.appVersion.description)
        } else if let server = model.store.activeServer, let account = model.store.activeAccount {
            if account.signedIn {
                if let session = model.session, session.key == account.key {
                    AppShell(model: model, session: session)
                } else if let reason = model.sessionFailure {
                    SessionFailedView(model: model, reason: reason)
                } else {
                    ProgressView()
                }
            } else {
                AddServerFlow(app: model, start: .server(server.baseURL, username: account.account.username))
                    .id(account.key)
            }
        } else {
            AddServerFlow(app: model)
                .onAppear { model.browser.start() }
                .onDisappear { model.browser.stop() }
        }
    }
}
