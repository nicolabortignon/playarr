import PlayarrAPI
import SwiftUI

/// Adding a server or an account: from the address screen, or straight to a known server's sign-in
/// (an account signed out, Add account) or to a setup code from a link.
public struct AddServerFlow: View {
    public enum Start: Equatable, Sendable {
        case address
        case server(URL, username: String?)
        case redeem(RedeemLink)
    }

    @State private var model: AddServerModel
    @State private var path: [AddServerModel.Step] = []
    private let start: Start
    private let onDone: () -> Void

    public init(app: AppModel, start: Start = .address, onDone: @escaping () -> Void = {}) {
        _model = State(initialValue: AddServerModel(app: app))
        self.start = start
        self.onDone = onDone
    }

    public var body: some View {
        NavigationStack(path: $path) {
            root
                .navigationDestination(for: AddServerModel.Step.self) { step in screen(step) }
        }
    }

    @ViewBuilder private var root: some View {
        switch start {
        case .address:
            WelcomeView(model: model) { if let step = model.nextStep { path.append(step) } }
        case .server(let url, let username):
            connecting(to: url) { step in
                if step == .signIn {
                    SignInView(model: model, username: username ?? "", onDone: onDone) { path.append(.redeem) }
                } else {
                    screen(step)
                }
            }
        case .redeem(let link):
            connecting(to: link.server) { step in
                if step == .tooOld { screen(step) } else { RedeemView(model: model, code: link.code, onDone: onDone) }
            }
        }
    }

    private func connecting<Content: View>(to url: URL, @ViewBuilder then content: @escaping (AddServerModel.Step) -> Content) -> some View {
        Group {
            if let step = model.nextStep {
                content(step)
            } else if let error = model.error {
                ContentUnavailableView {
                    Label("Can’t connect", systemImage: "wifi.exclamationmark")
                } description: {
                    Text(error)
                } actions: {
                    Button("Try again") { Task { await model.connect(to: url) } }
                }
            } else {
                ProgressView("Connecting…")
            }
        }
        .task { if model.connected == nil { await model.connect(to: url) } }
    }

    @ViewBuilder private func screen(_ step: AddServerModel.Step) -> some View {
        switch step {
        case .signIn: SignInView(model: model, username: "", onDone: onDone) { path.append(.redeem) }
        case .redeem: RedeemView(model: model, code: "", onDone: onDone)
        case .setup: SetupView(model: model, onDone: onDone)
        case .tooOld: UpdateRequiredView(serverName: model.connected?.info.name ?? "This server", minAppVersion: model.connected?.info.minAppVersion ?? "", appVersion: model.appVersion.description)
        }
    }
}
