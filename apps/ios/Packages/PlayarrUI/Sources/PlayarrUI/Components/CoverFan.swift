import Foundation
import SwiftUI

/// Covers coming out from behind Feeling lucky while it picks (apps/web/src/components/LuckyButton.tsx `CoverFan`;
/// docs/design.md, Moments): each dealt a little further clockwise than the one before and on top of it, 70 ms apart,
/// the first song's last. Each turns about a point below the button's middle, so together they open like a hand of
/// cards. Once the last is out and has been seen a moment, the others turn in under it, and the stack slips back down
/// behind the button and is gone: about a second and a half in all. Nothing of it shows below the button's top edge, so
/// the cards come out from behind it even where the button is outlined. Decoration: VoiceOver doesn't see it.
struct CoverFan: View {
  let deal: FanDeal
  /// Beside a regular button (the iPad's player bar), cards 44 points wide; beside a large one, 60.
  let small: Bool
  /// The pill's height (`PillSize.height`): the fan shows only above its top edge.
  let pill: CGFloat
  let onDone: @MainActor () -> Void

  /// When the fan started, and when each card joined it: the first song's may come after its turn has passed.
  @State private var started = ContinuousClock.now
  @State private var joined: [Duration] = []
  @State private var phase = FanPhase.open

  var body: some View {
    let all = deal.all
    ZStack {
      // Each in its place, made here rather than by a ForEach: SwiftUI can make a ForEach's items while it draws an
      // animation off the main thread (iOS 26), and a closure made in `body` is the main actor's, which traps there
      // (build 684). There are five at most: four at hand and the first song's.
      card(0, of: all)
      card(1, of: all)
      card(2, of: all)
      card(3, of: all)
      card(4, of: all)
    }
    // Exactly the button's frame, however big the cards, so the clip finds the button's top edge.
    .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity)
    .clipShape(AbovePill(height: pill))
    .allowsHitTesting(false)
    .accessibilityHidden(true)
    .onChange(of: all.count, initial: true) { _, count in
      while joined.count < count { joined.append(started.duration(to: .now)) }
    }
    .task(id: deal.landing != nil || deal.done) { await goBack() }
    // A page opened over it: the moment has passed.
    .onDisappear { onDone() }
  }

  @ViewBuilder private func card(_ index: Int, of all: [FanCover]) -> some View {
    if all.indices.contains(index) {
      FanCard(
        cover: all[index], index: index, slots: deal.slots, last: all.count - 1, side: small ? 44 : 60,
        turn: started.advanced(by: .seconds(Double(index) * FanTiming.deal * Self.pace)), phase: phase)
    }
  }

  /// Back once the last card is out and has been seen a moment: the others turn in under it, then the stack slips down
  /// behind the button and is gone.
  private func goBack() async {
    guard deal.landing != nil || deal.done else { return }
    let last = deal.all.count - 1
    guard last >= 0 else { return onDone() }
    let pace = Self.pace
    let joinedLast = joined.indices.contains(last) ? joined[last] : started.duration(to: .now)
    let goesBack = started.advanced(by: FanTiming.backAt(last: last, joined: joinedLast, pace: pace))
    let half = FanTiming.back * pace / 2
    do {
      try await Task.sleep(until: goesBack, clock: .continuous)
      withAnimation(.easeInOut(duration: half)) { phase = .gathering }
      try await Task.sleep(for: .seconds(half))
      withAnimation(.easeIn(duration: half)) { phase = .gone }
      try await Task.sleep(for: .seconds(half))
      onDone()
    } catch {
      // Gone already: the next press deals afresh.
    }
  }
}

extension CoverFan {
  /// How many times slower than the web's the fan moves: 1, except in the screen tour (`make screens`), which slows it
  /// down to catch it mid-deal (`-UITestsSlowFan <times>`). Only Debug builds read that: TestFlight's and the App
  /// Store's are Release builds, where the fan always keeps the web's time.
  nonisolated static let pace = slowing(ProcessInfo.processInfo.arguments)

  /// The slowing the launch arguments ask for: never faster than the web's.
  nonisolated static func slowing(_ arguments: [String]) -> Double {
    #if DEBUG
      if let flag = arguments.firstIndex(of: "-UITestsSlowFan"), arguments.indices.contains(flag + 1),
        let times = Double(arguments[flag + 1]), times > 1
      {
        return times
      }
    #endif
    return 1
  }
}

/// The fan's timing, the web's, in seconds: between one card and the next as it opens, a card's spring into its place,
/// the fan held open once the last card is out, and its going back (the others turning in under the last card, then
/// the stack slipping down).
enum FanTiming {
  static let deal = 0.07
  static let open = 0.45
  static let hold = 0.3
  static let back = 0.46
  /// Degrees between one card and the next; five cards open to 64.
  static let step = 16.0

  /// A card's spring into its place (the web's: stiffness 380, damping 24), `pace` times slower.
  static func spring(pace: Double) -> Animation {
    .interpolatingSpring(mass: 1, stiffness: 380 / (pace * pace), damping: 24 / pace)
  }

  /// When the fan goes back, from its start: once the last card (`last`, which joined the fan at `joined`) has opened
  /// and been seen a moment.
  static func backAt(last: Int, joined: Duration, pace: Double) -> Duration {
    max(joined, .seconds(Double(last) * deal * pace)) + .seconds((open + hold) * pace)
  }
}

/// Where the fan is in going back: open, the others turned in under the last card, then down behind the button.
enum FanPhase: Sendable {
  case open, gathering, gone
}

/// Where a card of the fan is: turned about a point below its middle (the web's `transform-origin: 50% 160%`), then
/// raised (`y`, up being negative) and, the top one as the others gather under it, grown a little.
struct FanPose: Equatable, Sendable {
  var angle: Double
  var y: CGFloat
  var scale: CGFloat = 1

  /// The point each card turns about: below its middle, so together they open like a hand of cards.
  static let pivot = UnitPoint(x: 0.5, y: 1.6)

  /// Card `index` of `slots` places, the top one `last`, `side` points wide: behind the button, turned as the first,
  /// until it's `out`; then in its own place in the fan; going back, turned in under the top card, then down behind the
  /// button again.
  init(card index: Int, slots: Int, last: Int, out: Bool, phase: FanPhase, side: CGFloat) {
    let angle = { (place: Int) in (Double(place) - Double(slots - 1) / 2) * FanTiming.step }
    let up = -side * 0.95
    // Below the edge, out of sight.
    let down = side / 4
    switch phase {
    case .open: self.init(angle: angle(out ? index : 0), y: out ? up : down)
    case .gathering: self.init(angle: angle(last), y: up, scale: index == last ? 1.05 : 1)
    case .gone: self.init(angle: angle(last), y: down)
    }
  }

  init(angle: Double, y: CGFloat, scale: CGFloat = 1) {
    self.angle = angle
    self.y = y
    self.scale = scale
  }
}

/// Everything above a pill's top edge, however far up and out to the sides (the web's `clip-path: inset(…)` on the
/// fan): what's clipped by it comes out from behind the button, even where the button is see-through.
struct AbovePill: Shape {
  /// The pill's height (`PillSize.height`): a regular one is 40, in its 44 points of taps.
  let height: CGFloat

  nonisolated func path(in rect: CGRect) -> Path {
    // Grown taller with the text, the pill fills its frame.
    let pill = rect.height > 44 ? rect.height : min(height, rect.height)
    let edge = rect.midY - pill / 2
    let reach: CGFloat = 1000
    return Path(CGRect(x: rect.minX - reach, y: edge - reach, width: rect.width + 2 * reach, height: reach))
  }
}

/// A card of the fan: the cover's picture, in its own color until that's in.
private struct FanCard: View {
  let cover: FanCover
  let index: Int
  let slots: Int
  /// The top card, which the others turn in under going back.
  let last: Int
  let side: CGFloat
  /// Its turn: then it springs out from behind the button.
  let turn: ContinuousClock.Instant
  let phase: FanPhase

  @Environment(AccountSession.self) private var session
  @State private var out = false
  @State private var picture: Image?

  var body: some View {
    let pose = FanPose(card: index, slots: slots, last: last, out: out, phase: phase, side: side)
    ZStack {
      Rectangle().fill(Color.ink950)
      Rectangle().fill(color ?? Skeleton.fill)
      if let picture { picture.resizable().scaledToFill() }
    }
    .frame(width: side, height: side)
    .clipShape(RoundedRectangle(cornerRadius: Radius.cover))
    .coverShadow(.shelf)
    .rotationEffect(.degrees(pose.angle), anchor: FanPose.pivot)
    .scaleEffect(pose.scale, anchor: FanPose.pivot)
    .offset(y: pose.y)
    .task(id: cover.key) {
      picture = await session.images.data(cover.path, size: NextLucky.fanArt).flatMap(Image.decoded)
    }
    .task {
      do {
        try await Task.sleep(until: turn, clock: .continuous)
      } catch {
        return
      }
      withAnimation(FanTiming.spring(pace: CoverFan.pace)) { out = true }
    }
  }

  /// The cover's own color (`coverColor`, `#rrggbb`), when the server has read it.
  private var color: Color? {
    guard let hex = cover.color, hex.count == 7, hex.hasPrefix("#"), let value = UInt32(hex.dropFirst(), radix: 16) else {
      return nil
    }
    return RGB(hex: value).color
  }
}
