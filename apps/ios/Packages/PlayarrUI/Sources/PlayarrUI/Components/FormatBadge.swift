import PlayarrAPI
import SwiftUI

/// "FLAC 24/96" with a dot for lossless, in the accent colour for Hi-Res (apps/web/src/components/FormatBadge.tsx).
/// Hidden when Settings → Appearance turns badges off.
struct FormatBadge: View {
  let format: AudioFormat?
  @Environment(AppearanceSettings.self) private var appearance
  @Environment(Theme.self) private var theme

  var body: some View {
    if appearance.formatBadges, let text = Format.badge(format) {
      let hiRes = Format.isHiRes(format)
      let color = hiRes ? theme.accent.color : Color.secondary
      HStack(spacing: 4) {
        if format?.lossless == true { Circle().fill(color).frame(width: 4, height: 4) }
        Text(text.uppercased())
      }
      .font(.mono(.caption2))
      .foregroundStyle(color)
      .padding(.horizontal, 5)
      .padding(.vertical, 1)
      .overlay(RoundedRectangle(cornerRadius: 3).stroke(color.opacity(0.5)))
      .accessibilityLabel(hiRes ? "Hi-Res lossless, \(text)" : format?.lossless == true ? "Lossless, \(text)" : "Lossy, \(text)")
    }
  }
}
