import Foundation
import PlayarrAPI

/// Where a mix cover's circles go ("orbit"): one album cover as a big circle bleeding off the top right, a thin ring
/// round it, and up to three small covers on the ring, tinted towards the mix's colour. Everything is in fractions of
/// the cover's side, and comes from the mix's key alone, so a mix keeps its look as its songs change, and looks the same
/// on the web (apps/web/src/lib/mixOrbit.ts has this same arithmetic; their tests share expected numbers).
/// The circles keep out of the bottom-left corner, where the title is.
enum MixOrbit {
  struct Circle: Equatable {
    /// Centre and diameter, as fractions of the side.
    var x: Double
    var y: Double
    var d: Double
  }

  struct Layout: Equatable {
    var hero: Circle
    /// The ring round the hero: its radius, as a fraction of the side (centred on the hero).
    var ring: Double
    /// One per cover after the first, at most three.
    var satellites: [Circle]
    /// With a single cover: a small dot in the mix's colour on the ring, so the ring doesn't look empty.
    var dot: Circle?
  }

  static let hero = 0.62
  static let ring = hero / 2 + 0.12
  /// Places on the ring to try (degrees, clockwise from three o'clock); each is kept only if it `fits`.
  static let slots: [Double] = [160, 192, 215, 30, 44, 140]
  static let sizes = [0.19, 0.15, 0.12]
  /// Where the words can reach: "Made for you", then the title at its longest (two lines, nearly the cover's width).
  struct Box {
    var left, right, top, bottom: Double
  }
  static let label = Box(left: 0.07, right: 0.5, top: 0.61, bottom: 0.67)
  static let title = Box(left: 0.07, right: 0.93, top: 0.69, bottom: 0.93)

  /// How far a circle's centre is from a box.
  static func away(_ c: Circle, _ b: Box) -> Double {
    hypot(c.x - min(max(c.x, b.left), b.right), c.y - min(max(c.y, b.top), b.bottom))
  }

  /// At least a quarter of the circle is on the cover (those at an edge bleed off it), it keeps a little clear of "Made
  /// for you", and no more than grazes the title's box (a title is rarely that long).
  static func fits(_ c: Circle) -> Bool {
    let r = c.d / 2
    let q = c.d / 4
    if c.x + r < q || c.x - r > 1 - q || c.y + r < q || c.y - r > 1 - q { return false }
    return away(c, label) >= r + 0.02 && away(c, title) >= r - 0.02
  }

  /// Two satellites don't touch: a small gap between them.
  static func apart(_ a: Circle, _ b: Circle) -> Bool {
    hypot(a.x - b.x, a.y - b.y) >= (a.d + b.d) / 2 + 0.02
  }

  /// FNV-1a, 32 bits, over UTF-16 code units (JavaScript's `charCodeAt`).
  static func hash32(_ text: String) -> UInt32 {
    var h: UInt32 = 0x811c_9dc5
    for unit in text.utf16 {
      h ^= UInt32(unit)
      h = h &* 0x0100_0193
    }
    return h
  }

  /// mulberry32: small, fast, and the same sequence as the web's.
  static func random(_ seed: UInt32) -> () -> Double {
    var state = seed
    return {
      state = state &+ 0x6d2b_79f5
      var t = state
      t = (t ^ (t >> 15)) &* (t | 1)
      t = t ^ (t &+ ((t ^ (t >> 7)) &* (t | 61)))
      return Double(t ^ (t >> 14)) / 4_294_967_296
    }
  }

  /// JavaScript's `Math.round(n * 10000) / 10000`: halves go up.
  private static func round(_ n: Double) -> Double {
    (n * 10000 + 0.5).rounded(.down) / 10000
  }

  static func layout(key: String, covers: Int) -> Layout {
    let next = random(hash32(key))
    let hero = Circle(x: round(0.66 + next() * 0.06), y: round(0.27 + next() * 0.05), d: Self.hero)
    // The slots in an order of this mix's own: a Fisher–Yates shuffle.
    var order = slots
    for i in stride(from: order.count - 1, to: 0, by: -1) {
      let j = Int((next() * Double(i + 1)).rounded(.down))
      order.swapAt(i, j)
    }
    func at(_ slot: Double, _ d: Double) -> Circle {
      let angle = (slot + (next() - 0.5) * 12) * .pi / 180
      return Circle(x: round(hero.x + cos(angle) * ring), y: round(hero.y + sin(angle) * ring), d: d)
    }
    let count = max(0, min(3, covers - 1))
    var satellites: [Circle] = []
    var dot: Circle?
    for slot in order {
      if covers == 1 {
        let c = at(slot, 0.05)
        if fits(c) {
          dot = c
          break
        }
      } else {
        if satellites.count == count { break }
        let c = at(slot, sizes[satellites.count])
        if fits(c), satellites.allSatisfy({ apart($0, c) }) { satellites.append(c) }
      }
    }
    return Layout(hero: hero, ring: round(ring), satellites: satellites, dot: dot)
  }

  /// Vibes, Discovery and On Repeat change with what's played: their wash runs between the colours of their first two
  /// covers.
  static func toneFromCovers(_ kind: MixKind) -> Bool {
    kind == .vibes || kind == .discovery || kind == .repeat
  }

  struct WashStop: Equatable {
    /// Where along the gradient (0–1), and the colour there as OKLCH.
    var at: Double
    var l: Double
    var c: Double
    var h: Double
  }

  /// Lightness and chroma down the wash, the same for every mix so none stands out on a shelf.
  static let washSteps: [(at: Double, l: Double, c: Double)] = [(0, 0.5, 0.15), (0.225, 0.42, 0.13), (0.45, 0.34, 0.11), (0.725, 0.26, 0.085), (1, 0.18, 0.06)]

  /// A mix cover's wash, top to bottom: from hue `from` to hue `to` the short way round the wheel (one hue when they're
  /// the same), as the web works it out.
  static func wash(from: Double, to: Double? = nil) -> [WashStop] {
    let to = to ?? from
    let turn = ((to - from).truncatingRemainder(dividingBy: 360) + 540).truncatingRemainder(dividingBy: 360) - 180
    return washSteps.map { step in
      let h = ((from + turn * step.at).truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360)
      return WashStop(at: step.at, l: step.l, c: step.c, h: round(h))
    }
  }
}
