import PlayarrAPI
import PlayarrPlayer

/// The next transition in words, for the "Next: …" line and its sheet: `describe`, `styleName`, `plainReason` and
/// `pairFacts` of apps/web/src/components/TransitionView.tsx, word for word.
public enum TransitionWords {
  /// Keys this unsure aren't worth showing: they'd be a guess.
  static let minKeyConfidence = 0.3

  public struct Mode: Identifiable, Sendable {
    public let value: MixMode
    public let label: String
    public let hint: String
    public var id: String { value.rawValue }
  }

  public static let modes: [Mode] = [
    Mode(value: .auto, label: "Auto", hint: "Songs are blended when they suit it, and mixed quickly when they don’t."),
    Mode(value: .party, label: "Party", hint: "Longer blends, more often: for a party that shouldn’t stop."),
    Mode(value: .off, label: "No mixing", hint: "Songs follow each other straight on, without a gap."),
  ]

  /// What's known of the next transition: "32-beat blend" (lower case: it follows "Next:"), why, and the plan.
  public struct Upcoming: Equatable, Sendable {
    public var style: String
    public var why: String
    public var plan: TransitionPlan?
    /// Planned, but the mix is still being made.
    public var preparing = false
  }

  public static func styleName(_ plan: TransitionPlan) -> String {
    let beats = Int(plan.beats.rounded())
    switch plan.style {
    case .long: return beats > 0 ? "\(beats)-beat blend" : "blend"
    case .quick: return beats > 0 ? "\(beats)-beat quick mix" : "quick mix"
    case .fade: return "crossfade"
    case .straight, .unknown: return "straight on"
    }
  }

  /// The server's reasons for having no mix, in the listener's words (they're written for the logs).
  public static func plainReason(_ reason: String) -> String {
    if reason.hasPrefix("No mix map yet for the song playing") { return "This song hasn’t been analysed yet" }
    if reason.hasPrefix("No mix map yet for the next song") { return "The next song hasn’t been analysed yet" }
    if reason == "Mixed transitions need audio analysis" { return "Mixing needs audio analysis, which is off on this server" }
    if reason.hasPrefix("The transition couldn’t be") { return "The mix couldn’t be made" }
    return "There’s no mix for these two songs"
  }

  /// Without a mix (unavailable, too late, mixing off) DJ mix plays the next song straight on, without a gap.
  public static func describe(_ result: TransitionPlanner.Result?, mixMode: MixMode) -> Upcoming {
    if mixMode == .off { return Upcoming(style: "no mixing", why: "Mixing is off for this queue, so the next song follows straight on.") }
    switch result {
    case nil:
      return Upcoming(style: "planning the mix", why: "Working out how these two songs go together…")
    case .answer(.ready(let r))?:
      return Upcoming(style: styleName(r.plan), why: r.plan.reason, plan: r.plan)
    case .answer(.straight(let s))?:
      return Upcoming(style: styleName(s.plan), why: s.plan.reason, plan: s.plan)
    case .answer(.pending(let p))?:
      return Upcoming(style: styleName(p.plan), why: p.plan.reason, plan: p.plan, preparing: true)
    case .answer(.unavailable(let u))?:
      return Upcoming(style: "straight on", why: "\(plainReason(u.reason)), so the next song follows straight on.")
    case .answer(.unknown)?:
      return Upcoming(style: "straight on", why: "There’s no mix for these two songs, so the next song follows straight on.")
    case .gaveUp?:
      return Upcoming(style: "straight on", why: "The mix wasn’t ready in time, so the next song follows straight on.")
    }
  }

  public static func bpm(_ map: MixMapEntry?) -> Int? {
    guard let map, map.bpm > 0 else { return nil }
    return Int(map.bpm.rounded())
  }

  public static func key(_ map: MixMapEntry?) -> String? {
    guard let key = map?.key, key.confidence >= minKeyConfidence else { return nil }
    return key.camelot
  }

  /// "124 → 126 BPM" and "8A → 9A", each only when known for both songs.
  public static func pairFacts(_ a: MixMapEntry?, _ b: MixMapEntry?) -> [String] {
    var facts: [String] = []
    if let x = bpm(a), let y = bpm(b) { facts.append("\(x) → \(y) BPM") }
    if let x = key(a), let y = key(b) { facts.append("\(x) → \(y)") }
    return facts
  }

  /// "Next: 32-beat blend · 124 → 126 BPM · 8A → 9A".
  public static func line(_ upcoming: Upcoming, _ a: MixMapEntry?, _ b: MixMapEntry?) -> String {
    (["Next: " + upcoming.style] + pairFacts(a, b)).joined(separator: " · ")
  }

  /// The line as VoiceOver should say it: "124 to 126 BPM", pauses for the dots.
  public static func spoken(_ text: String) -> String {
    text.replacingOccurrences(of: " → ", with: " to ").replacingOccurrences(of: " · ", with: ", ")
  }

  /// "Song 1 BPM · 8A" for the sheet's Now and Next rows.
  public static func songFacts(_ map: MixMapEntry?) -> String? {
    let facts = [bpm(map).map { "\($0) BPM" }, key(map)].compactMap { $0 }
    return facts.isEmpty ? nil : facts.joined(separator: " · ")
  }
}
