import Foundation
import Observation
import SwiftUI

#if os(iOS)
  import CoreMotion
  import UIKit
#endif

/// Covers tilting with the phone, Now Playing's and the album page's (plan 7 §3; docs/design.md, Moments): up to 1°
/// each way, kept subtle (2° was too evident on a phone held in the hand, 2026-11-13), as a card held a little behind the glass would. The phone's turning comes from its gyroscope and is let
/// go over a second and a half, so however the phone is held the cover comes to rest flat, and turning it tips the
/// cover the other way for a moment. One for the app (`shared`), read while any cover that tilts is on screen
/// (`tiltsWithPhone`): the phone has one gyroscope, and Core Motion wants one manager reading it. The web tilts Now
/// Playing's cover toward a mouse instead.
@MainActor @Observable
final class CoverTilt {
  /// The app's: every cover that tilts leans the same way, with the same phone.
  static let shared = CoverTilt()

  /// How far the cover leans, −1…1 of `maxDegrees`: its right edge (`h`) and its top edge (`v`) toward you.
  struct Lean: Equatable, Sendable {
    var h = 0.0
    var v = 0.0

    /// How much it leans at all, 0–1: how strongly the sheen shows.
    var amount: Double { max(abs(h), abs(v)) }
  }

  /// Which way up the screen is, as the interface is turned.
  enum Orientation: Sendable {
    case portrait, upsideDown, landscapeLeft, landscapeRight
  }

  /// The most the cover tilts, in degrees: half the web's `MAX_TILT`, as a phone in the hand turns all the time and a
  /// mouse doesn't.
  nonisolated static let maxDegrees = 1.0
  /// Degrees the cover tilts for each degree the phone turns: 8° of turning tilts it all the way.
  nonisolated static let follow = 0.125
  /// How long the phone's turning takes to be let go (seconds): about how fast the cover settles back flat.
  nonisolated static let settle = 1.5
  /// A lean too small to see, a hundredth of a degree: the gyroscope never reads quite still, and a phone on a stand
  /// shouldn't redraw the cover sixty times a second for hours.
  nonisolated static let unseen = 0.01

  private(set) var lean = Lean()

  /// How far the phone has turned lately (radians, about its own axes: x to its right, y to its top, z out of the
  /// screen), each turn let go over `settle`.
  @ObservationIgnored private var turned = (x: 0.0, y: 0.0, z: 0.0)
  @ObservationIgnored private var lastUpdate: TimeInterval?
  /// Covers on screen that tilt (`start()`, `stop()`): the gyroscope reads while there's one.
  @ObservationIgnored private var holders = 0
  #if os(iOS)
    /// Made when a cover first tilts.
    @ObservationIgnored private var motion: CMMotionManager?
  #endif

  /// The cover's lean for the phone's recent turning on a screen turned `orientation`. A card behind the glass stays
  /// put as the phone turns, so it turns the other way on the screen: the phone's right edge going away brings the
  /// card's right edge toward you.
  nonisolated static func lean(turned: (x: Double, y: Double, z: Double), orientation: Orientation) -> Lean {
    // The screen's right and up, in the phone's axes.
    let (right, up): ((Double, Double, Double), (Double, Double, Double)) =
      switch orientation {
      case .portrait: ((1, 0, 0), (0, 1, 0))
      case .upsideDown: ((-1, 0, 0), (0, -1, 0))
      case .landscapeLeft: ((0, 1, 0), (-1, 0, 0))
      case .landscapeRight: ((0, -1, 0), (1, 0, 0))
      }
    func about(_ axis: (Double, Double, Double)) -> Double {
      (turned.x * axis.0 + turned.y * axis.1 + turned.z * axis.2) * 180 / .pi
    }
    let limit = { (degrees: Double) in min(1, max(-1, follow * degrees / maxDegrees)) }
    // Turning about the screen's up axis takes its right edge away; about its right axis, brings its top edge closer.
    return Lean(h: limit(about(up)), v: limit(-about(right)))
  }

  /// One reading of the gyroscope: `rate` in radians a second about the phone's axes, at `time` (seconds).
  func turn(by rate: (x: Double, y: Double, z: Double), at time: TimeInterval, orientation: Orientation) {
    let dt = lastUpdate.map { min(0.1, max(0, time - $0)) } ?? 0
    lastUpdate = time
    let keep = exp(-dt / Self.settle)
    turned = (turned.x * keep + rate.x * dt, turned.y * keep + rate.y * dt, turned.z * keep + rate.z * dt)
    var next = Self.lean(turned: turned, orientation: orientation)
    if next.amount < Self.unseen { next = Lean() }
    // Flat at once, else only a change that can be seen.
    if next == Lean() ? lean != next : max(abs(next.h - lean.h), abs(next.v - lean.v)) >= Self.unseen { lean = next }
  }

  /// A cover that tilts came on screen: from the first, the phone is followed 60 times a second; nothing where there's
  /// no gyroscope (the simulator).
  func start() {
    holders += 1
    guard holders == 1 else { return }
    #if DEBUG
      // The screen tour's tilt, which the simulator can't give: a fixed lean to see the sheen by.
      if ProcessInfo.processInfo.arguments.contains("-UITests"), ProcessInfo.processInfo.arguments.contains("-UITestsTilt") {
        lean = Lean(h: 0.8, v: 0.5)
        return
      }
    #endif
    #if os(iOS)
      let motion = self.motion ?? CMMotionManager()
      self.motion = motion
      guard motion.isDeviceMotionAvailable, !motion.isDeviceMotionActive else { return }
      motion.deviceMotionUpdateInterval = 1.0 / 60
      motion.startDeviceMotionUpdates(to: .main, withHandler: Self.handler(for: self))
    #endif
  }

  /// A cover that tilts went: with the last, the gyroscope stops and the lean goes flat.
  func stop() {
    guard holders > 0 else { return }
    holders -= 1
    guard holders == 0 else { return }
    #if os(iOS)
      motion?.stopDeviceMotionUpdates()
    #endif
    turned = (0, 0, 0)
    lastUpdate = nil
    lean = Lean()
  }

  #if os(iOS)
    /// The readings' handler, made outside the main actor: CoreMotion keeps it, and calls it on the main queue.
    private nonisolated static func handler(for tilt: CoverTilt) -> CMDeviceMotionHandler {
      { [weak tilt] reading, _ in
        guard let reading else { return }
        let rate = (x: reading.rotationRate.x, y: reading.rotationRate.y, z: reading.rotationRate.z)
        let time = reading.timestamp
        MainActor.assumeIsolated {
          tilt?.turn(by: rate, at: time, orientation: Self.orientation)
        }
      }
    }

    /// Which way up the interface is now.
    private static var orientation: Orientation {
      let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
      switch scene?.effectiveGeometry.interfaceOrientation {
      case .portraitUpsideDown: return .upsideDown
      case .landscapeLeft: return .landscapeLeft
      case .landscapeRight: return .landscapeRight
      default: return .portrait
      }
    }
  #endif
}

extension View {
  /// Tilts with the phone (`CoverTilt`), catching a faint sheen on the edge that comes toward you: a cover whose
  /// corners are `corner`. Only while it's on screen, the app is in front and it's `active` (false where something
  /// covers it, as Now Playing does the page under it); still under Reduce Motion.
  func tiltsWithPhone(corner: CGFloat, active: Bool = true) -> some View {
    modifier(TiltsWithPhone(corner: corner, active: active))
  }
}

private struct TiltsWithPhone: ViewModifier {
  let corner: CGFloat
  let active: Bool
  @Environment(\.reducesMotion) private var reducesMotion
  @Environment(\.scenePhase) private var scenePhase
  /// Whether this cover is following the phone (`CoverTilt.start()`), so each start has its stop.
  @State private var holding = false

  func body(content: Content) -> some View {
    let wanted = active && scenePhase == .active && !reducesMotion
    let lean = holding ? CoverTilt.shared.lean : CoverTilt.Lean()
    content
      .overlay { Self.sheen(lean).clipShape(RoundedRectangle(cornerRadius: corner)) }
      .rotation3DEffect(.degrees(-lean.h * CoverTilt.maxDegrees), axis: (x: 0, y: 1, z: 0))
      .rotation3DEffect(.degrees(-lean.v * CoverTilt.maxDegrees), axis: (x: 1, y: 0, z: 0))
      // The gyroscope only while the cover can be seen: the music plays on with the screen off, and so would it.
      .onAppear { hold(wanted) }
      .onChange(of: wanted) { _, on in hold(on) }
      .onDisappear { hold(false) }
  }

  private func hold(_ on: Bool) {
    guard on != holding else { return }
    holding = on
    on ? CoverTilt.shared.start() : CoverTilt.shared.stop()
  }

  /// A soft light on the edge leaning toward you, as strong as the lean: paper at 12 % fading out (the web's is 22 %).
  private static func sheen(_ lean: CoverTilt.Lean) -> some View {
    EllipticalGradient(
      colors: [Color.paper.opacity(0.12), .clear], center: UnitPoint(x: 0.5 + 0.5 * lean.h, y: 0.5 - 0.5 * lean.v),
      startRadiusFraction: 0, endRadiusFraction: 0.75
    )
    .opacity(lean.amount)
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }
}
