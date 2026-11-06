import PlayarrAPI
import SwiftUI

/// The devices an account is signed in on, as their own screen ("Signed in on").
struct SessionsView: View {
  let accountId: Int
  let title: String
  @Bindable var model: AccountsModel

  var body: some View {
    Form {
      if let error = model.error { InlineMessage(text: error) }
      SessionRows(accountId: accountId, model: model)
    }
    .navigationTitle(title)
    .task { await model.loadSessions(of: accountId) }
  }
}

/// Each device with when it was last used; every one but this device signs out, after asking.
struct SessionRows: View {
  let accountId: Int
  @Bindable var model: AccountsModel
  @State private var ending: SessionInfo?

  var body: some View {
    if let sessions = model.sessions[accountId] {
      if sessions.isEmpty { Text("No devices are signed in.").foregroundStyle(.secondary) }
      ForEach(sessions) { session in
        HStack {
          VStack(alignment: .leading, spacing: 2) {
            HStack {
              Text(session.device)
              if session.current { Text("this device").font(.footnote).foregroundStyle(.secondary) }
            }
            Text("Last used \(AdminText.date(session.lastSeenAt)?.formatted(.dateTime.day().month(.abbreviated).hour().minute()) ?? session.lastSeenAt)")
              .font(.caption)
              .foregroundStyle(.secondary)
          }
          Spacer()
          if !session.current {
            Button("Sign out", systemImage: "rectangle.portrait.and.arrow.right") { ending = session }
              .labelStyle(.iconOnly)
              .buttonStyle(.borderless)
              .accessibilityLabel("Sign out \(session.device)")
              // Asked from its own button, so on an iPad the question points at the device it's about.
              .confirmLoss(
                Binding(get: { ending?.id == session.id ? ending : nil }, set: { ending = $0 }), question: AccountsModel.signOutQuestion
              ) { session in
                Task { await model.endSession(session, of: accountId) }
              }
          }
        }
      }
    } else {
      ProgressView()
    }
  }
}
