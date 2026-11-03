/// Answers kept for a while (the web's staleTime): asked again once older than `maxAge`, or after `removeAll()`.
struct TimedCache<Value: Sendable>: Sendable {
  private var entries: [String: (at: ContinuousClock.Instant, value: Value)] = [:]
  let maxAge: Duration

  init(maxAge: Duration) {
    self.maxAge = maxAge
  }

  func value(_ key: String, now: ContinuousClock.Instant = .now) -> Value? {
    guard let entry = entries[key], now - entry.at < maxAge else { return nil }
    return entry.value
  }

  mutating func store(_ value: Value, for key: String, now: ContinuousClock.Instant = .now) {
    entries[key] = (now, value)
  }

  mutating func removeAll() { entries = [:] }
}
