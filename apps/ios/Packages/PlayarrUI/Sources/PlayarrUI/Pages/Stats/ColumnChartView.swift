import Charts
import SwiftUI

/// One measure across hours, weekdays or months as columns in the accent colour: the busiest named above, any other
/// under the finger, and the numbers for VoiceOver (apps/web/src/components/ColumnChart.tsx).
struct ColumnChartView: View {
  let chart: ListeningChart
  var height: CGFloat = 140
  @State private var selected: Int?
  @Environment(Theme.self) private var theme

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .firstTextBaseline) {
        Kicker(text: chart.title)
        Spacer()
        if let caption = chart.caption(selected: selected) {
          Text(caption).font(.footnote.monospacedDigit()).foregroundStyle(.secondary)
        }
      }
      Chart(chart.columns) { column in
        BarMark(x: .value("When", column.id), y: .value("Minutes", column.minutes))
          .foregroundStyle(theme.accent.color.opacity(selected == nil || selected == column.id ? 1 : 0.45))
          .cornerRadius(4)
      }
      .chartXScale(domain: -0.5...(Double(chart.columns.count) - 0.5))
      .chartXAxis {
        AxisMarks(values: chart.columns.filter(\.tick).map(\.id)) { value in
          AxisValueLabel {
            if let id = value.as(Int.self) { Text(chart.columns[id].label).font(.caption2.monospaced()) }
          }
        }
      }
      .chartYAxis(.hidden)
      .chartXSelection(value: $selected)
      .frame(height: height)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(chart.title)
      .accessibilityValue(chart.columns.map { "\($0.label): \(Format.minutes($0.minutes))" }.joined(separator: ", "))
    }
  }
}
