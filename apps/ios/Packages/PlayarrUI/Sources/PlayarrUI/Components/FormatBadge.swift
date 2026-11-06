import PlayarrAPI
import SwiftUI

/// A song's or an album's format, saying only what's worth saying (docs/design.md, Words): "MP3", "MP3 · 128 kbps",
/// "FLAC", "FLAC · 24/96" (apps/web/src/components/FormatBadge.tsx). A dot for lossless, the accent for Hi-Res; the
/// full details are its accessibility value. Hidden when Settings → Appearance turns badges off.
struct FormatBadge: View {
  let format: AudioFormat?
  @Environment(AppearanceSettings.self) private var appearance
  @Environment(Theme.self) private var theme

  var body: some View {
    if appearance.formatBadges, let format, let parts = Format.badgeParts(format) {
      let hiRes = Format.isHiRes(format)
      let color = hiRes ? AnyShapeStyle(theme.accent.color) : AnyShapeStyle(.muted)
      HStack(spacing: 4) {
        if format.lossless { Circle().fill(color).frame(width: 4, height: 4) }
        // The codec in the badge's capitals; units read as written ("kbps").
        Text(parts.detail.map { "\(parts.codec.uppercased()) · \($0)" } ?? parts.codec.uppercased())
          .textCase(nil)
      }
      .typeRole(.badge)
      .lineLimit(1)
      .foregroundStyle(color)
      .padding(.horizontal, 5)
      .padding(.vertical, 1)
      .overlay(RoundedRectangle(cornerRadius: Radius.cover).strokeBorder(hiRes ? AnyShapeStyle(theme.accent.color.opacity(0.5)) : AnyShapeStyle(.line)))
      .accessibilityElement(children: .ignore)
      // Text, not something to tap: an element with no traits is audited as a control too small to hit.
      .accessibilityAddTraits(.isStaticText)
      .accessibilityLabel(Format.badge(format) ?? format.codec)
      .accessibilityValue(Format.details(format))
    }
  }
}
