import SwiftUI

/// A name and the numbers about it ("Massive Attack" and "1 h 50 min · 20 plays") on one line when both fit, else the
/// numbers on a line of their own under the name. The name is cut short only once the numbers have moved: a name never
/// loses to numbers (docs/design.md, "Headers"; apps/web/src/components/NameAndNumbers.tsx). A dot sets the numbers
/// apart; with `end` they sit at the line's far end instead (a ranking). The dot takes the style set around it.
struct NameAndNumbers: View {
  /// None (a download without a subtitle): just the numbers.
  let name: Text?
  let numbers: Text
  var end = false
  /// The line as VoiceOver reads it, as one ("Massive Attack · 11 songs · 484 MB"); else its parts.
  var label: String?

  var body: some View {
    let line = ViewThatFits(in: .horizontal) {
      HStack(alignment: .firstTextBaseline, spacing: end ? 12 : 4) {
        if let name { name.lineLimit(1) }
        if end {
          Spacer(minLength: 0)
        } else if name != nil {
          Text(verbatim: "·").accessibilityHidden(true)
        }
        numbers.lineLimit(1)
      }
      VStack(alignment: .leading, spacing: 2) {
        if let name { name.essentialLineLimit() }
        // On a line of their own the numbers may take a second rather than lose their end ("3 couldn’t download").
        numbers.essentialLineLimit(2)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    if let label {
      line.accessibilityRepresentation { Text(label) }
    } else {
      line
    }
  }
}
