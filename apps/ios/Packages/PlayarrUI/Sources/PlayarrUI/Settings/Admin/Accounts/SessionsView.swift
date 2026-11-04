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

/// Each device with when it was last used; every one but this device signs out with a tap.
struct SessionRows: View {
  let accountId: Int
  @Bindable var model: AccountsModel

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
            Button("Sign out", systemImage: "rectangle.portrait.and.arrow.right") { Task { await model.endSession(session, of: accountId) } }
              .labelStyle(.iconOnly)
              .buttonStyle(.borderless)
              .accessibilityLabel("Sign out \(session.device)")
          }
        }
      }
    } else {
      ProgressView()
    }
  }
}
