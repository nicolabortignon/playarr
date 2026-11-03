import PlayarrAPI

/// A plan's curves (gains, filters, B's rate) as packages/mix/src/automation.ts reads them: straight lines between
/// points, flat before the first and after the last; two points at one time are a step, which takes effect on time.
extension Array where Element == AutomationItem {
  /// The curve's value `t` seconds into the transition (`valueAt`). An empty curve reads 0.
  public func value(at t: Double) -> Double {
    guard let first, let last else { return 0 }
    if t < first.at { return first.value }
    if t >= last.at { return last.value }
    var index = 0
    while index + 1 < count, self[index + 1].at <= t { index += 1 }
    let from = self[index], to = self[index + 1]
    return from.value + (to.value - from.value) * (t - from.at) / (to.at - from.at)
  }

  /// The exact area under the curve from `from` to `to`, negative when `to` comes first (`integrate`): for B's rate,
  /// how many of B's own seconds play in that stretch of the transition.
  public func integral(from: Double, to: Double) -> Double {
    if to < from { return -integral(from: to, to: from) }
    let breakpoints = [from] + map(\.at).filter { $0 > from && $0 < to } + [to]
    var area = 0.0
    for (start, end) in zip(breakpoints, breakpoints.dropFirst()) where end > start {
      area += (end - start) * value(at: (start + end) / 2)
    }
    return area
  }

  /// When the curve last falls to 0 and stays there (A's gain: where A is no longer heard), at most `limit`.
  public func silentFrom(limit: Double) -> Double {
    guard let lastHeard = lastIndex(where: { $0.value > 0 }) else { return 0 }
    return Swift.min(lastHeard + 1 < count ? self[lastHeard + 1].at : limit, limit)
  }
}
