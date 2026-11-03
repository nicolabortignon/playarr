import PlayarrAPI
import SwiftUI

/// Now Playing → Lyrics (apps/web/src/components/LyricsView.tsx).
struct LyricsView: View {
  @State private var model: LyricsModel
  @Environment(AccountSession.self) private var session
  @Environment(AppearanceSettings.self) private var appearance
  @Environment(\.accessibilityReduceMotion) private var systemReduceMotion

  init(trackId: Int, session: AccountSession) {
    _model = State(initialValue: LyricsModel(trackId: trackId, session: session))
  }

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
          VStack(alignment: .leading, spacing: 24) {
            Text(text).font(.title2.weight(.semibold))
            LyricsCredit(source: source)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.vertical, 24)
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
        VStack(alignment: .leading, spacing: 14) {
          ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
            Button { model.seek(to: line) } label: {
              Text(line.text.isEmpty ? "♪" : line.text)
                .font(.title2.weight(.semibold))
                .multilineTextAlignment(.leading)
                .foregroundStyle(index == current ? Color.primary : index < current ? Color.primary.opacity(0.35) : Color.primary.opacity(0.55))
            }
            .buttonStyle(.plain)
            .id(index)
            .accessibilityAddTraits(index == current ? .isSelected : [])
            .accessibilityHint("Plays from this line")
          }
          LyricsCredit(source: source).padding(.top, 24)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 120)
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
    Text(text).font(.title3).foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
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
          Link("LRCLIB", destination: site)
        }
      } else {
        Text("LYRICS FROM THE FILE")
      }
    }
    .font(.caption2.monospaced())
    .tracking(2)
    .foregroundStyle(.secondary)
  }
}
