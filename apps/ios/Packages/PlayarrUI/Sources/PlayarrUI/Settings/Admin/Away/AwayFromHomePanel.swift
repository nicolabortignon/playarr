import PlayarrAPI
import SwiftUI

/// Settings → Away from home (admins only).
public struct AwayFromHomePanel: View {
  @State private var model: AwayFromHomeModel

  private let isAdmin: Bool

  /// `isAdmin`: it isn't in a member's list; opened by a link anyway, it says who can run the check.
  public init(api: any APISending, isAdmin: Bool = true) {
    _model = State(initialValue: AwayFromHomeModel(api: api))
    self.isAdmin = isAdmin
  }

  public var body: some View {
    Form {
      if isAdmin { content } else { AdminOnlyNotice(text: "Only an admin can run this check.") }
    }
    .navigationTitle(SettingsPanel.away.title)
    .task { if isAdmin { await model.load() } }
  }

  @ViewBuilder
  private var content: some View {
    Section { Text(AwayFromHomeModel.intro).font(.footnote).foregroundStyle(.secondary) }
    Section("Public address") {
      if model.addressKnown {
        Text(model.addressText)
          .foregroundStyle(model.publicUrl == nil ? .secondary : .primary)
          .textSelection(.enabled)
      } else {
        ProgressView()
      }
      Button(model.checkLabel, systemImage: "arrow.clockwise") { Task { await model.check() } }
        .disabled(model.checking)
      if let notice = model.notice { InlineMessage(text: notice) }
    }
    Section {
      if let result = model.result {
        Label(result.summary, systemImage: AwayFromHomeModel.symbol(result.verdict))
          .foregroundStyle(Self.color(result.verdict))
        ForEach(result.steps) { StepRow(step: $0) }
      } else {
        Text(AwayFromHomeModel.notChecked).foregroundStyle(.secondary)
      }
    } header: {
      Text("Reachable from outside over HTTPS?")
    } footer: {
      if let checked = model.checkedText() { Text(checked) }
    }
    Section("Setting it up") {
      Text(AwayFromHomeModel.guideIntro)
      if let guide = AwayFromHomeModel.guide { Link("Read the guide", destination: guide) }
    }
  }

  private static func color(_ verdict: ReachabilityVerdict) -> Color {
    switch verdict {
    case .reachable: .success
    case .unconfirmed: .warning
    case .unreachable, .unknown: .danger
    }
  }
}

/// One step: its status as a symbol, what it checks, what it found, and what to do.
private struct StepRow: View {
  let step: ReachabilityStep

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 12) {
      Image(systemName: AwayFromHomeModel.symbol(step.status))
        .foregroundStyle(tint)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 2) {
        Text(step.label).foregroundStyle(step.status == .skipped ? .secondary : .primary)
        if let detail = step.detail { Text(detail).font(.footnote).foregroundStyle(.secondary) }
        if let fix = step.fix { Text(fix).font(.footnote).foregroundStyle(.secondary).padding(.top, 2) }
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(step.label): \(AwayFromHomeModel.word(step.status))")
    .accessibilityValue([step.detail, step.fix].compactMap { $0 }.joined(separator: " "))
  }

  private var tint: Color {
    switch step.status {
    case .ok: .success
    case .warn: .warning
    case .fail: .danger
    case .skipped, .unknown: .secondary
    }
  }
}
