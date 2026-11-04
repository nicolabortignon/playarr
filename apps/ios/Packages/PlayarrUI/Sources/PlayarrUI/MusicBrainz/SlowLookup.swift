import SwiftUI

/// Explains a MusicBrainz wait instead of leaving a bare spinner (components/SlowLookup.tsx). Put it on screen while a
/// lookup runs: it appears after 1.5 s, and says when Playarr's own background matching is ahead in the line.
public struct SlowLookup: View {
  let what: String

  @Environment(DiscoverContext.self) private var context: DiscoverContext?
  @State private var shown = false

  /// `what`: "this artist’s albums", "“Air”".
  public init(what: String) {
    self.what = what
  }

  public var body: some View {
    Group {
      if shown {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
          Circle().fill(.tint).frame(width: 6, height: 6)
          Text(SlowLookupText.waiting(for: what, status: context?.musicBrainz.status))
            .font(.sans(.footnote)).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
      }
    }
    .task {
      do { try await Task.sleep(for: SlowLookupText.after) } catch { return }
      shown = true
      await context?.musicBrainz.watch()
    }
  }
}
