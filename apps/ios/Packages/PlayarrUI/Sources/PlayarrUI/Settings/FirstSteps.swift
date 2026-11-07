import SwiftUI

/// The owner's first steps after claiming the server (plan 4 §3, the web's `FirstSteps`): add their music, then invite
/// the household, then listen. Settings → Sources and Accounts opened as one (`Route.firstStep`) start with
/// `FirstStepSection`.
public enum FirstStep: String, Hashable, Sendable, Codable {
  case music, household

  /// The panel the step is done in.
  var panel: SettingsPanel { self == .music ? .sources : .accounts }
}

/// Atop Settings → Sources or Accounts opened as a first step: which step it is, what to do, and the way on.
struct FirstStepSection: View {
  let step: FirstStep
  /// The step is done (the music step: a source added): its button leads on, rather than skipping it.
  var ready = true
  @Environment(AccountSession.self) private var session

  var body: some View {
    Section {
      VStack(alignment: .leading, spacing: 6) {
        Kicker(text: "First steps · \(step == .music ? 1 : 2) of 2")
        Text(step == .music ? "Add your music" : "Invite your household").typeRole(.sectionTitle)
        Text(step == .music ? Self.music : Self.household).foregroundStyle(.paperDim)
      }
      .accessibilityElement(children: .combine)
      switch step {
      case .music:
        Button(ready ? "Next: invite your household" : "Skip for now") { session.router.open(.firstStep(.household)) }
      case .household:
        Button("Start listening") { session.router.goHome() }
      }
    }
  }

  static let music =
    "Point Playarr at Lidarr or a folder of music, here or on another computer; the library fills in as it reads them. More places can come later."
  static let household = "Add an account for each person. Each gets a setup link to choose a password with, here or in the Playarr app."
}
