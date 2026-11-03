import PlayarrAPI

/// Edit mix points' state for one song (MixPointsDialog.tsx Editor): the points set by hand (nil: the detected one),
/// where each marker shows, how far it may go, and what changed since it was saved.
public struct MixPointsEditor: Equatable, Sendable {
  public enum Point: Sendable, CaseIterable { case mixIn, mixOut }

  public struct Points: Equatable, Sendable {
    public var mixIn: Double?
    public var mixOut: Double?

    public init(mixIn: Double? = nil, mixOut: Double? = nil) {
      self.mixIn = mixIn
      self.mixOut = mixOut
    }

    subscript(point: Point) -> Double? {
      get { point == .mixIn ? mixIn : mixOut }
      set { if point == .mixIn { mixIn = newValue } else { mixOut = newValue } }
    }
  }

  public let duration: Double
  public let grid: MixGrid
  public let bpm: Double
  /// What the planner falls back to without points set by hand: the detected intro end and outro start.
  public let detected: (mixIn: Double, mixOut: Double)
  public private(set) var saved: Points
  public private(set) var points: Points

  public init(map: MixMapEntry) {
    duration = map.duration
    grid = MixGrid(map: map)
    bpm = map.bpm
    let finite = { (value: Double, fallback: Double) in value.isFinite ? value : fallback }
    let soundEnd = MixGrid.clamp(finite(map.soundEnd, map.duration), 0, map.duration)
    detected = (MixGrid.clamp(finite(map.introEnd, 0), 0, map.duration), MixGrid.clamp(finite(map.outroStart, soundEnd), 0, map.duration))
    saved = Points(mixIn: map.cues?.mixIn, mixOut: map.cues?.mixOut)
    points = saved
  }

  public static func == (a: Self, b: Self) -> Bool {
    a.duration == b.duration && a.grid == b.grid && a.saved == b.saved && a.points == b.points
  }

  /// Where the markers show: in order, mix in at least one line before mix out (the server wants it strictly
  /// before), even when the detection (or an old point) has them the wrong way round.
  public var shown: (mixIn: Double, mixOut: Double) {
    let mixOut = MixGrid.clamp(points.mixOut ?? detected.mixOut, min(grid.step, duration), duration)
    return (MixGrid.clamp(points.mixIn ?? detected.mixIn, 0, max(0, mixOut - grid.step)), mixOut)
  }

  public func time(_ point: Point) -> Double { point == .mixIn ? shown.mixIn : shown.mixOut }

  /// How far a marker may go: mix in up to a line before mix out, mix out from a line after mix in.
  public func bounds(_ point: Point) -> (min: Double, max: Double) {
    let s = shown
    return point == .mixIn ? (0, s.mixOut - grid.step) : (s.mixIn + grid.step, duration)
  }

  public func setByHand(_ point: Point) -> Bool { points[point] != nil }

  /// Something differs from what's saved.
  public var changed: Bool { points != saved }
  /// Reset has something to undo.
  public var anySet: Bool { [points.mixIn, points.mixOut, saved.mixIn, saved.mixOut].contains { $0 != nil } }

  /// Moves a marker to `t`; back on the detected point is no point set by hand.
  public mutating func move(_ point: Point, to t: Double) {
    let target = point == .mixIn ? detected.mixIn : detected.mixOut
    points[point] = abs(t - target) < 0.001 ? nil : t
  }

  /// A drag to `t` seconds: the nearest line within the marker's bounds.
  public mutating func drag(_ point: Point, to t: Double) {
    let (lo, hi) = bounds(point)
    let to = grid.snap(t, min: lo, max: hi)
    if to != time(point) { move(point, to: to) }
  }

  /// A bar (`phrase` false) or a phrase on (`forward`) or back: the marker's step buttons.
  public mutating func step(_ point: Point, forward: Bool, phrase: Bool) {
    let (lo, hi) = bounds(point)
    let n = (phrase ? grid.big : 1) * (forward ? 1 : -1)
    move(point, to: grid.step(from: time(point), by: n, min: lo, max: hi))
  }

  /// Back to the detected points (not saved yet).
  public mutating func clear() { points = Points() }

  /// The server has these now.
  public mutating func didSave(_ sent: Points) {
    saved = sent
    points = sent
  }

  /// "120 BPM. The markers snap to bars: …", or why they move by seconds.
  public var hint: String {
    bpm > 0
      ? "\(Int(Format.jsRound(bpm))) BPM. The markers snap to bars: drag one, or step it a bar or a phrase with its buttons."
      : "No steady beat was found in this song, so the markers move by whole seconds (the outer buttons, \(MixGrid.secondsWithoutBeat))."
  }
}
