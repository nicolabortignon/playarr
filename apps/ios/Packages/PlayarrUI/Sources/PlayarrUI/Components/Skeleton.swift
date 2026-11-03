import SwiftUI

/// A grey stand-in while something loads.
struct Skeleton: View {
  var aspectRatio: CGFloat? = 1
  var height: CGFloat?

  var body: some View {
    RoundedRectangle(cornerRadius: 4)
      .fill(Color.secondary.opacity(0.15))
      .aspectRatio(aspectRatio, contentMode: .fit)
      .frame(height: height)
      .accessibilityHidden(true)
  }
}
