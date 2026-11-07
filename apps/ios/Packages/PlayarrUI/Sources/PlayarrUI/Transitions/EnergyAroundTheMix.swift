import PlayarrPlayer
import SwiftUI

/// Both songs' energy per phrase around the mix, on one clock: the shaded mix is the same stretch in both. One colour
/// (the accent), bar ticks underneath, a phrase's time and energy on a tap, and the numbers under "Numbers". Each strip
/// is drawn by a function outside the main actor and measured with `onGeometryChange`, not by closures made here:
/// SwiftUI can draw a sheet's frames off the main thread as it comes up (iOS 26), where those would trap (build 684).
struct EnergyAroundTheMix: View {
  let strips: [EnergyPicture.Strip]
  @State private var picked: (strip: Int, phrase: Int)?
  /// How wide the strips are, for where a tap falls.
  @State private var width: CGFloat = 0

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .firstTextBaseline) {
        Text("Energy around the mix".uppercased())
          .font(.mono(.caption2))
          .tracking(2)
          .foregroundStyle(.secondary)
        Spacer()
        if let picked, strips.indices.contains(picked.strip), strips[picked.strip].phrases.indices.contains(picked.phrase) {
          let phrase = strips[picked.strip].phrases[picked.phrase]
          Text("\(NerdFormat.time(phrase.at)) · \(Int((phrase.energy * 100).rounded()))%")
            .font(.sans(.footnote).monospacedDigit())
        }
      }
      ForEach(strips.indices, id: \.self) { i in
        let strip = strips[i]
        VStack(alignment: .leading, spacing: 4) {
          HStack {
            Text(strip.title).lineLimit(1).foregroundStyle(.secondary)
            Spacer()
            Text(strip.note).monospacedDigit().foregroundStyle(.tertiary)
          }
          .font(.sans(.caption))
          Canvas(renderer: Self.drawing(strip, dimming: picked != nil, picked: picked?.strip == i ? picked?.phrase : nil))
            .frame(maxWidth: .infinity)
            .frame(height: 54)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
            .contentShape(Rectangle())
            .onTapGesture { location in
              let x = location.x / max(width, 1)
              if let k = strip.phrases.firstIndex(where: { x >= $0.left && x <= $0.left + $0.width }) { picked = (i, k) }
            }
            .accessibilityHidden(true)
        }
      }
      DisclosureGroup("Numbers") {
        Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 4) {
          GridRow {
            Text("Song")
            Text("From").gridColumnAlignment(.trailing)
            Text("Energy").gridColumnAlignment(.trailing)
            Text("In the mix").gridColumnAlignment(.trailing)
          }
          .font(.mono(.caption2))
          .foregroundStyle(.secondary)
          ForEach(strips.indices, id: \.self) { i in
            ForEach(strips[i].phrases.indices, id: \.self) { k in
              let p = strips[i].phrases[k]
              GridRow {
                Text(strips[i].title).lineLimit(1)
                Text(NerdFormat.time(p.at))
                Text("\(Int((p.energy * 100).rounded()))%")
                Text(p.inMix ? "Yes" : "")
              }
              .font(.sans(.footnote).monospacedDigit())
            }
          }
        }
      }
      .font(.mono(.caption2))
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Energy around the mix")
  }

  /// One strip: the mix shaded, each phrase's energy (all but `picked` dimmed while `dimming`: a phrase is picked, here
  /// or in the other strip), the bars' ticks underneath.
  nonisolated static func drawing(_ strip: EnergyPicture.Strip, dimming: Bool, picked: Int?) -> (inout GraphicsContext, CGSize) -> Void {
    { context, size in
      let w = size.width, h = size.height - 8
      // The mix: shaded with edges strong enough to see, or a line for a straight cut.
      let mix = CGRect(x: strip.mixLeft * w, y: 0, width: max(1, strip.mixWidth * w), height: h)
      context.fill(Path(mix), with: .color(.primary.opacity(strip.mixWidth > 0 ? 0.08 : 0.5)))
      if strip.mixWidth > 0 {
        context.stroke(Path { $0.move(to: CGPoint(x: mix.minX, y: 0)); $0.addLine(to: CGPoint(x: mix.minX, y: h)) }, with: .color(.primary.opacity(0.45)))
        context.stroke(Path { $0.move(to: CGPoint(x: mix.maxX, y: 0)); $0.addLine(to: CGPoint(x: mix.maxX, y: h)) }, with: .color(.primary.opacity(0.45)))
      }
      for (k, p) in strip.phrases.enumerated() {
        let height = max(2, EnergyPicture.heardHeight(p.energy) * h)
        let rect = CGRect(x: p.left * w, y: h - height, width: max(1, p.width * w - 2), height: height)
        let dimmed = dimming && picked != k
        context.fill(Path(roundedRect: rect, cornerRadius: 3), with: .color(.accentColor.opacity(dimmed ? 0.45 : 1)))
      }
      context.fill(Path(CGRect(x: 0, y: h - 0.5, width: w, height: 0.5)), with: .color(.secondary))
      for bar in strip.bars {
        let tick = CGRect(x: bar.left * w, y: h + 2, width: 1, height: bar.phrase ? 6 : 4)
        context.fill(Path(tick), with: .color(.primary.opacity(bar.phrase ? 0.4 : 0.15)))
      }
    }
  }
}
