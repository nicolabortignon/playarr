import PlayarrAPI
import SwiftUI

/// What the app shows: adding a server, signing in again, an update, or the signed-in app.
public struct RootView: View {
    @Bindable var model: AppModel

    public init(model: AppModel) {
        self.model = model
    }

    public var body: some View {
        content
            .sheet(item: $model.redeemLink) { link in
                AddServerFlow(app: model, start: .redeem(link)) { model.redeemLink = nil }
            }
            .task(id: model.store.active) { await model.checkActiveServer() }
            .task(id: model.store.activeAccount) { model.syncSession() }
            .pinningDownloadedPages(model.session?.player.downloads) { model.session?.queries.setPinned($0) }
    }

    @ViewBuilder private var content: some View {
        if let info = model.tooOld {
            UpdateRequiredView(serverName: info.name, minAppVersion: info.minAppVersion, appVersion: model.appVersion.description)
        } else if let server = model.store.activeServer, let account = model.store.activeAccount {
            if account.signedIn {
                if let session = model.session, session.key == account.key {
                    AppShell(model: model, session: session)
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
