import SwiftUI

extension View {
  /// Tints with `color`, gliding to a new one as the accent glides to a new song's (plan 7 §1; `Theme.follow`). A tint
  /// is read where it's drawn (a pill's fill, a ring, the tab bar), and SwiftUI doesn't animate it: on its own, a new
  /// accent would land there at once while everything reading the accent itself glides. This tints with the color at
  /// each step of the glide instead.
  func glidingTint(_ color: RGB) -> some View {
    modifier(GlidingTint(color: color))
  }
}

private struct GlidingTint: ViewModifier, Animatable {
  var color: RGB

  /// Outside the main actor: SwiftUI may step an animation off the main thread (build 684).
  nonisolated var animatableData: AnimatablePair<Double, AnimatablePair<Double, Double>> {
    get { AnimatablePair(color.r, AnimatablePair(color.g, color.b)) }
    set { color = RGB(r: newValue.first, g: newValue.second.first, b: newValue.second.second) }
  }

  func body(content: Content) -> some View {
    content.tint(color.color)
  }
}
