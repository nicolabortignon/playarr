import SwiftUI

/// The MusicBrainz queue, while lookups wait (the desktop sidebar's footer; on the phone, the Library page's foot).
public struct MusicBrainzIndicator: View {
  @Environment(DiscoverContext.self) private var context: DiscoverContext?

  public init() {}

  public var body: some View {
    Group {
      if let status = context?.musicBrainz.status, status.queued > 0 {
        HStack(spacing: 8) {
          Circle().fill(.tint).frame(width: 6, height: 6)
          Text("MusicBrainz")
          Text(SlowLookupText.queued(status)).foregroundStyle(.secondary)
        }
        .font(.mono(size: 11))
        .foregroundStyle(.secondary)
        .accessibilityElement(children: .combine)
        .accessibilityHint(SlowLookupText.explanation(status))
      }
    }
    .task { await context?.musicBrainz.watch() }
  }
}
