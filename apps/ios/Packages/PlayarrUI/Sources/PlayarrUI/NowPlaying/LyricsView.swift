import PlayarrAPI
import SwiftUI

/// Now Playing → Lyrics (apps/web/src/components/LyricsView.tsx), left-aligned as there. `centred`: in the iPad's
/// narrow side column, where everything else is centred, the lines are too, with a margin either side.
struct LyricsView: View {
  var centred = false
  @State private var model: LyricsModel
  @Environment(AccountSession.self) private var session
  @Environment(AppearanceSettings.self) private var appearance
  @Environment(\.accessibilityReduceMotion) private var systemReduceMotion

  init(trackId: Int, session: AccountSession, centred: Bool = false) {
    self.centred = centred
    _model = State(initialValue: LyricsModel(trackId: trackId, session: session))
  }

  private var alignment: HorizontalAlignment { centred ? .center : .leading }
  private var textAlignment: TextAlignment { centred ? .center : .leading }
  private var frameAlignment: Alignment { centred ? .center : .leading }
  private var margin: CGFloat { centred ? 20 : 0 }

  var body: some View {
    Group {
      switch model.state {
      case .loading:
        VStack(alignment: .leading, spacing: 16) {
          ForEach([0.7, 0.85, 0.55, 0.78], id: \.self) { width in
            GeometryReader { geometry in Skeleton(aspectRatio: nil, height: 28).frame(width: geometry.size.width * width) }.frame(height: 28)
          }
        }
        .accessibilityLabel("Loading lyrics")
      case .unavailable: notice("Lyrics are unavailable right now.")
      case .none: notice("No lyrics found for this song.")
      case .instrumental: notice("Instrumental")
      case .plain(let text, let source):
        ScrollView {
          VStack(alignment: alignment, spacing: 24) {
            Text(text).font(.display(.title2)).multilineTextAlignment(textAlignment)
            LyricsCredit(source: source)
          }
          .frame(maxWidth: .infinity, alignment: frameAlignment)
          .padding(.vertical, 24)
          .padding(.horizontal, margin)
        }
      case .synced(let lines, let source):
        synced(lines, source: source)
      }
    }
    .task { await model.load() }
  }

  private func synced(_ lines: [Lyrics.SyncedItem], source: Lyrics.Source) -> some View {
    let times = lines.map(\.at)
    let current = LyricsModel.lineAt(times, time: session.player.time)
    return ScrollViewReader { proxy in
      ScrollView {
        VStack(alignment: alignment, spacing: 14) {
          ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
            Button { model.seek(to: line) } label: {
              Text(line.text.isEmpty ? "♪" : line.text)
                .font(.display(.title2))
                .multilineTextAlignment(textAlignment)
                // Sung lines and those to come are dimmed, but still readable (4.5:1 over the dark backdrop).
                .foregroundStyle(index == current ? Color.primary : index < current ? Color.primary.opacity(0.5) : Color.primary.opacity(0.7))
            }
            .buttonStyle(.plain)
            .id(index)
            .accessibilityAddTraits(index == current ? .isSelected : [])
            .accessibilityHint("Plays from this line")
          }
          LyricsCredit(source: source).padding(.top, 24)
        }
        .frame(maxWidth: .infinity, alignment: frameAlignment)
        .padding(.vertical, 120)
        .padding(.horizontal, margin)
      }
      .scrollIndicators(.hidden)
      .onScrollPhaseChange { _, phase in
        if phase == .interacting { model.touched() }
      }
      .onChange(of: current) { _, line in
        guard model.follows() else { return }
        let reduce = appearance.reduceMotion(system: systemReduceMotion)
        withAnimation(reduce ? nil : .smooth) { proxy.scrollTo(max(0, line), anchor: .center) }
      }
    }
  }

  private func notice(_ text: String) -> some View {
    Text(text).font(.sans(.title3)).foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

/// "Lyrics from LRCLIB" (a link) or "Lyrics from the file".
struct LyricsCredit: View {
  let source: Lyrics.Source

  var body: some View {
    Group {
      if source == .lrclib, let site = URL(string: "https://lrclib.net") {
        HStack(spacing: 4) {
          Text("LYRICS FROM")
          Link("LRCLIB", destination: site).frame(minHeight: 44).contentShape(Rectangle())
        }
      } else {
        Text("LYRICS FROM THE FILE")
      }
    }
    .font(.mono(.caption2))
    .tracking(2)
    .foregroundStyle(.secondary)
  }
}
