import Foundation
import PlayarrAPI

/// One song's part of a mix the engine plays itself (a fade, a quick mix, a press of Next): the plan's gain curve, and
/// its low shelf and high-pass, applied to the deck's PCM by timeline sample as blocks are scheduled, after the song's
/// own gain. Transition time 0 is timeline sample `start`; past the plan the curves hold their last values.
final class DeckAutomation {
  let start: SampleTime
  let gain: Automation
  let lowShelfDb: Automation
  let highPassHz: Automation
  private let filters: [(MixFilter.Kind, [MixFilter])]

  init(start: SampleTime, gain: Automation, lowShelfDb: Automation, highPassHz: Automation) {
    self.start = start
    self.gain = gain
    self.lowShelfDb = lowShelfDb
    self.highPassHz = highPassHz
    var filters: [(MixFilter.Kind, [MixFilter])] = []
    if lowShelfDb.contains(where: { abs($0.value) >= 0.01 }) { filters.append((.lowShelf, [MixFilter(.lowShelf), MixFilter(.lowShelf)])) }
    if highPassHz.contains(where: { $0.value > MixFilter.highPassOffHz }) { filters.append((.highPass, [MixFilter(.highPass), MixFilter(.highPass)])) }
    self.filters = filters
  }

  /// A's side of `plan` (gain, bass swap, sweep), from timeline sample `start`.
  static func a(_ plan: TransitionPlan, start: SampleTime) -> DeckAutomation {
    DeckAutomation(start: start, gain: plan.aGain, lowShelfDb: plan.aLowDb, highPassHz: plan.aHighPassHz)
  }

  /// B's side (gain, bass swap).
  static func b(_ plan: TransitionPlan, start: SampleTime) -> DeckAutomation {
    DeckAutomation(start: start, gain: plan.bGain, lowShelfDb: plan.bLowDb, highPassHz: [AutomationItem(at: 0, value: MixFilter.highPassOffHz)])
  }

  func apply(to block: inout PCMBlock, at sample: SampleTime) {
    let first = sample - start
    for (kind, channels) in filters {
      let curve = kind == .lowShelf ? lowShelfDb : highPassHz
      channels[0].process(&block.left, firstIndex: first) { curve.value(at: $0) }
      channels[1].process(&block.right, firstIndex: first) { curve.value(at: $0) }
    }
    let gains = (0..<block.frames).map { Float(gain.value(at: Double(first + Int64($0)) / EngineFormat.sampleRate)) }
    block.scale(by: gains)
  }
}
