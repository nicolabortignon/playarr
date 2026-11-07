import Foundation
import PlayarrAPI

/// What the player's second line says as a song ends (plan 7 §5; apps/web/src/player/endOfSong.ts): from ten seconds
/// before the next song takes over, "Next: Teardrop". With DJ mix blending the two: "Mixing into Teardrop on the next
/// bar" through the last bar before the blend, then "Mixing into Teardrop" while it plays, until the next song takes
/// over the player. The web guesses from the transition it was given; here it's the join the engine plays.
public enum EndOfSong {
  /// How long before a song gives way the second line says what comes next.
  public static let lead: Double = 10
  /// A bar of the song playing when its tempo isn't known: four beats at 120 BPM.
  public static let unknownBar: Double = 2

  /// How the song playing gives way to the next one.
  public struct Handoff: Equatable, Sendable {
    /// The next song's title.
    public var next: String
    /// Where in the song playing (seconds) it gives way: the mix's start, a cut, or its end less a crossfade.
    public var at: Double
    /// The two are heard together there: a blend or a quick mix (a fade, a cut or straight on isn't one to show).
    public var blends: Bool
    /// Seconds a bar of the song playing lasts (four beats at its tempo), when its tempo is known.
    public var bar: Double?

    public init(next: String, at: Double, blends: Bool, bar: Double? = nil) {
      self.next = next
      self.at = at
      self.blends = blends
      self.bar = bar
    }
  }

  /// The line, and what it says where it's short of room.
  public struct Words: Hashable, Sendable {
    /// The whole line: "Mixing into Teardrop on the next bar".
    public var text: String
    /// The last bar's line where the whole one won't fit (the mini player): "Mixing on the next bar", the title said
    /// by "Next: Teardrop" a moment before. nil for a line that can be cut short at its end, the title going first.
    public var short: String?
  }

  /// The line at `time` seconds into the song playing, with its short form, else nil.
  public static func words(_ handoff: Handoff?, time: Double) -> Words? {
    guard let handoff else { return nil }
    let left = handoff.at - time
    if handoff.blends && left <= 0 { return Words(text: "Mixing into \(handoff.next)") }
    if handoff.blends && left <= (handoff.bar.flatMap { $0 > 0 ? $0 : nil } ?? unknownBar) {
      return Words(text: "Mixing into \(handoff.next) on the next bar", short: "Mixing on the next bar")
    }
    return left <= lead ? Words(text: "Next: \(handoff.next)") : nil
  }

  /// The line at `time` seconds into the song playing, else nil.
  public static func line(_ handoff: Handoff?, time: Double) -> String? {
    words(handoff, time: time)?.text
  }

  /// Where the song playing (`duration` seconds long) gives way to `next` by `join`, and whether they blend there.
  /// `mix` is the mix the engine has placed into it, which goes by whatever the join has become since.
  public static func handoff(next: Track, join: Join, mix: TransitionPlan?, duration: Double, bpm: Double?) -> Handoff {
    let bar = bpm.flatMap { $0 > 0 ? 4 * 60 / $0 : nil }
    if let mix { return Handoff(next: next.title, at: min(mix.aStart, duration), blends: mix.blends, bar: bar) }
    switch join {
    case .crossfade(let seconds):
      return Handoff(next: next.title, at: duration - seconds, blends: false, bar: bar)
    case .transition(let transition):
      return Handoff(next: next.title, at: min(transition.plan.aStart, duration), blends: transition.plan.blends, bar: bar)
    case .mix(let plan):
      return Handoff(next: next.title, at: min(plan.aStart, duration), blends: plan.blends, bar: bar)
    case .cut(let cut):
      return Handoff(next: next.title, at: min(cut.aEnd, duration), blends: false, bar: bar)
    }
  }
}

extension TransitionPlan {
  /// Both songs sound together: a long blend or a quick mix (apps/web/src/player/blend.ts `isBlend`).
  public var blends: Bool { style == .long || style == .quick }
}
