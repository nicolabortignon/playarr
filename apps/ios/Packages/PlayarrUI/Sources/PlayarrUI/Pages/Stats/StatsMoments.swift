import SwiftUI

/// A big number that counts up to itself as the report opens (docs/design.md, Moments; pages/Stats.tsx CountUp): over
/// 1.4 s, quick at first and settling, once for each number; at once under Reduce Motion. The number itself holds its
/// place, and is what VoiceOver reads, while the count runs over it, so nothing beside it moves.
struct CountUp: View {
  let value: Int
  /// The number shown while it counts; nil once it has landed on the real one.
  @State private var counting: Int?
  /// The number last counted up to: coming back to the page doesn't count it again.
  @State private var counted: Int?
  @Environment(\.reducesMotion) private var reducesMotion

  static let duration: Duration = .milliseconds(1400)
  /// The web's easing, cubic-bezier(0.16, 1, 0.3, 1).
  static let curve = UnitCurve.bezier(startControlPoint: UnitPoint(x: 0.16, y: 1), endControlPoint: UnitPoint(x: 0.3, y: 1))

  var body: some View {
    Text(Format.number(value))
      .opacity(counting == nil ? 1 : 0)
      .overlay(alignment: .leading) {
        // At its own width: figures differ in width, and a count wider than the number would be cut short.
        if let counting { Text(Format.number(counting)).fixedSize() }
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(Format.number(value))
      .task(id: value) { await count() }
  }

  private func count() async {
    guard counted != value else { return }
    counted = value
    guard !reducesMotion, value > 0 else { return }
    let clock = ContinuousClock()
    let start = clock.now
    // Landed as soon as it reads as the real number: the two never show at once. Put away (the page left), it lands.
    while let shown = Self.shown(value, after: clock.now - start), !Task.isCancelled {
      counting = shown
      try? await clock.sleep(for: .milliseconds(16))
    }
    counting = nil
  }

  /// What the count shows `elapsed` into it: nil once it reads as the real number.
  static func shown(_ value: Int, after elapsed: Duration) -> Int? {
    let progress = min(1, max(0, elapsed / duration))
    let shown = Int((Double(value) * curve.value(at: progress)).rounded())
    return shown >= value ? nil : shown
  }
}

/// The small flag on a longest streak that's the one going on now (docs/design.md, Moments; pages/Stats.tsx RecordFlag):
/// badge capitals in the accent, in a capsule outlined in it.
struct RecordFlag: View {
  var body: some View {
    HStack(spacing: 4) {
      Image(systemName: "flag.fill").font(.icon(.badge)).accessibilityHidden(true)
      Text("New record")
    }
    .typeRole(.badge)
    .foregroundStyle(.tint)
    .padding(.horizontal, 8)
    .padding(.vertical, 3)
    .overlay(Capsule().strokeBorder(.tint.opacity(0.4)))
  }
}

/// The year in review opens like a sleeve pulled out of a crate (docs/design.md, Moments; pages/Stats.tsx SleeveOut):
/// its first screen rises into place from below, tipping upright as it comes. Made afresh for each year (`.id`), it
/// slides out again; still under Reduce Motion.
struct SleeveOut: ViewModifier {
  @State private var out: Bool
  @Environment(\.reducesMotion) private var reducesMotion

  /// The web's spring: damping 24, stiffness 120, mass 0.9.
  static let spring = Animation.interpolatingSpring(mass: 0.9, stiffness: 120, damping: 24)

  /// `active`: a year in review; anything else is simply there.
  init(active: Bool) {
    _out = State(initialValue: !active)
  }

  func body(content: Content) -> some View {
    let tucked = !out && !reducesMotion
    content
      .opacity(tucked ? 0 : 1)
      .offset(y: tucked ? 64 : 0)
      .rotation3DEffect(.degrees(tucked ? -12 : 0), axis: (x: 1, y: 0, z: 0), anchor: .bottom, perspective: 0.6)
      .task {
        guard !out else { return }
        withAnimation(reducesMotion ? nil : Self.spring) { out = true }
      }
  }
}
