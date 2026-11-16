import PlayarrAPI
import SwiftUI

/// Sign in a TV (plan 9 §3), opened from the code the TV shows (`playarr://link`): which device it is, the account to
/// sign it in as, and Sign in. The web's /link page in the app, for someone signed in here rather than in Safari.
struct SignInTVView: View {
  @State private var model: SignInTVModel
  @Environment(\.openURL) private var openURL
  let done: () -> Void

  init(app: AppModel, link: DeviceLink, done: @escaping () -> Void) {
    _model = State(initialValue: SignInTVModel(app: app, link: link))
    self.done = done
  }

  var body: some View {
    NavigationStack {
      Form { content }
        .navigationTitle(title)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button(role: .close, action: done) }
        }
    }
    .task { await model.start() }
  }

  private var title: String {
    if case .done = model.phase, let device = model.device { return "\(device) is signed in" }
    return "Sign in a TV"
  }

  private var device: String { model.device ?? "the TV" }

  @ViewBuilder private var content: some View {
    switch model.phase {
    case .finding, .looking:
      Section {
        HStack(spacing: 12) {
          ProgressView()
          Text("Looking up the code…").foregroundStyle(.paperDim)
        }
        code
      }
    case .notSignedIn:
      Section {
        Text("To sign in the TV from here, sign in to \(model.serverName ?? "its server") in Playarr first. Or sign it in on the server’s page in Safari.")
        safari
      }
    case .ready, .approving:
      Section {
        Label(device, systemImage: "tv")
        code
      }
      if model.accounts.count > 1 {
        Section {
          Picker("Listen as", selection: $model.chosen) {
            ForEach(model.accounts) { Text($0.account.name).tag(Optional($0.key)) }
          }
        } footer: {
          Text("Each account has its own history, favorites and mixes.")
        }
      }
      Section {
        Button(model.phase == .approving ? "Signing in…" : "Sign in \(device) as \(model.chosenAccount?.account.name ?? "you")", systemImage: "checkmark") {
          Task { await model.approve() }
        }
        .disabled(model.phase == .approving)
        .accessibilityIdentifier("signInTV.approve")
      } footer: {
        if let server = model.serverName { Text("On \(server).") }
      }
    case let .done(account):
      Section {
        Label("It listens as \(account) from now on. You can sign it out in Settings → Accounts, under your devices.", systemImage: "checkmark.circle")
          .foregroundStyle(.paperDim)
        Button("Done", systemImage: "checkmark", action: done)
      }
    case let .failed(message):
      Section {
        InlineMessage(text: message)
        code
      }
    }
  }

  private var code: some View {
    Text(model.link.shownCode)
      .font(.mono(.title3))
      .tracking(4)
      .foregroundStyle(.muted)
      .accessibilityLabel("Code \(model.link.shownCode)")
  }

  @ViewBuilder private var safari: some View {
    if let page = model.link.webPage {
      Button("Open in Safari", systemImage: "safari") { openURL(page) }
    }
  }
}
