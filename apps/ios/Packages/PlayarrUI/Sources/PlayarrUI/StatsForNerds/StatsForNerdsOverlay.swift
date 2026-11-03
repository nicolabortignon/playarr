import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// Settings → Appearance → Stats for nerds: everything known about the song playing, over the app. Dragged by its
/// header, collapsed to one line (tempo, key, bar.beat, loudness), closed with an undo. As StatsForNerds.tsx.
public struct StatsForNerdsOverlay: View {
  let player: Player
  let appearance: AppearanceSettings
  let toasts: ToastCenter
  let metadata: @Sendable (Int) async -> TrackMetadata?

  /// Labels and the summary: a plain colour, as `.secondary` is vibrant over the panel's material and all but vanishes.
  static let dim = Color.primary.opacity(0.6)

  @State private var open = true
  @State private var offset: CGSize = .zero
  @State private var dragStart: CGSize?
  @State private var meta: TrackMetadata?

  public init(player: Player, appearance: AppearanceSettings, toasts: ToastCenter, metadata: @escaping @Sendable (Int) async -> TrackMetadata?) {
    self.player = player
    self.appearance = appearance
    self.toasts = toasts
    self.metadata = metadata
  }

  public var body: some View {
    if appearance.statsForNerds, let track = player.queue.currentTrack {
      GeometryReader { geo in
        let width = min(geo.size.width - 16, 360)
        TimelineView(.periodic(from: .now, by: player.queue.playing ? 0.1 : 1)) { _ in
          panel(track, width: width)
        }
        .frame(width: width)
        .offset(clamped(offset, in: geo.size, width: width))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
        .padding(.top, 60)
        .padding(.trailing, 8)
      }
      .task(id: track.id) {
        meta = nil
        meta = await metadata(track.id)
        player.transitions.mixMaps.watch([track.recordingId])
      }
    }
  }

  private func input(_ track: Track) -> NerdStats.Input {
    let maps = player.transitions.mixMaps
    let next = player.queue.upNext
    let result = next.flatMap { player.transitions.result(from: track, to: $0) }
    let level = player.levels.levels[track.recordingId]
    let item = player.engine.currentItem
    return NerdStats.Input(
      track: track, time: player.time, duration: player.duration, buffered: player.buffered, loading: player.loading,
      playing: player.queue.playing, error: player.error, map: maps.map(track.recordingId), level: level, metadata: meta,
      gainDb: item?.gainDb ?? 0, levelVolume: player.settings.levelVolume,
      albumGain: level?.album != nil && item?.gainDb == level?.album && level?.album != level?.track,
      transitions: player.settings.transitions, crossfade: player.settings.crossfade, mixMode: player.queue.mixMode, next: next,
      upcoming: result, djWanted: player.transitions.planner.upcoming.fromFileId == track.fileId, mixMissed: player.upcomingMixMissed,
      mix: player.engine.mix, engineNow: player.engine.now, reports: player.engine.mixReports, decks: player.engine.snapshot().decks,
      continuation: item?.continuation)
  }

  private func panel(_ track: Track, width: CGFloat) -> some View {
    let input = input(track)
    let grid = input.map.flatMap { NerdStats.gridPosition($0, input.time) }
    return VStack(spacing: 0) {
      header(summary: NerdStats.summary(map: input.map, level: input.level, time: input.time), beat: grid?.beat)
      if open {
        Divider()
        ScrollView {
          VStack(alignment: .leading, spacing: 8) {
            ForEach(NerdStats.groups(input)) { group in
              VStack(alignment: .leading, spacing: 2) {
                Text(group.title.uppercased())
                  .font(.system(size: 9.5, design: .monospaced))
                  .tracking(2)
                  .foregroundStyle(Color.accentColor)
                Grid(alignment: .topLeading, horizontalSpacing: 8, verticalSpacing: 1) {
                  ForEach(group.rows) { row in
                    GridRow {
                      Text(row.label).foregroundStyle(Self.dim).frame(width: 92, alignment: .leading)
                      value(row.value)
                    }
                  }
                }
              }
            }
          }
          .padding(10)
        }
        .frame(maxHeight: 520)
      }
    }
    .font(.system(size: 11, design: .monospaced).monospacedDigit())
    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 10))
    .overlay(RoundedRectangle(cornerRadius: 10).stroke(.primary.opacity(0.1)))
    .shadow(radius: 20)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Stats for nerds")
  }

  private func header(summary: String, beat: Int?) -> some View {
    HStack(spacing: 8) {
      Text("Stats for nerds".uppercased())
        .font(.system(size: 10, design: .monospaced))
        .tracking(2)
        .lineLimit(1)
        .fixedSize()
      if let beat {
        HStack(spacing: 4) {
          ForEach(1...4, id: \.self) { b in
            Circle()
              .fill(b != beat ? Color.primary.opacity(0.15) : b == 1 ? Color.accentColor : Color.primary)
              .frame(width: 6, height: 6)
          }
        }
        .accessibilityHidden(true)
      }
      Text(open ? "" : summary)
        .lineLimit(1)
        .foregroundStyle(Self.dim)
        .frame(maxWidth: .infinity, alignment: .trailing)
      Button(open ? "Collapse" : "Expand", systemImage: open ? "minus" : "plus") { open.toggle() }
        .labelStyle(.iconOnly)
        .frame(width: 44, height: 32)
      Button("Turn off stats for nerds", systemImage: "xmark") { turnOff() }
        .labelStyle(.iconOnly)
        .frame(width: 44, height: 32)
    }
    .buttonStyle(.plain)
    .padding(.leading, 10)
    .frame(height: 36)
    .contentShape(Rectangle())
    .gesture(
      DragGesture()
        .onChanged { drag in
          let start = dragStart ?? offset
          dragStart = start
          offset = CGSize(width: start.width + drag.translation.width, height: start.height + drag.translation.height)
        }
        .onEnded { _ in dragStart = nil })
  }

  @ViewBuilder private func value(_ value: NerdStats.Row.Value) -> some View {
    switch value {
    case .text(let text): Text(text).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
    case .error(let text): Text(text).foregroundStyle(.red)
    case .energy(let strip): PhraseEnergyStrip(strip: strip)
    }
  }

  /// Kept inside the screen: at most to the left edge and the bottom.
  private func clamped(_ offset: CGSize, in size: CGSize, width: CGFloat) -> CGSize {
    CGSize(width: min(0, max(-(size.width - width - 16), offset.width)), height: min(max(-60, offset.height), size.height - 120))
  }

  private func turnOff() {
    appearance.statsForNerds = false
    let appearance = self.appearance
    toasts.push("Stats for nerds is off: it’s in Settings → Appearance.", action: ToastCenter.Action("Undo") { appearance.statsForNerds = true })
  }
}

/// Each phrase's energy over the whole song, the one playing in the accent colour, with lines where the intro ends
/// (sky) and the outro starts (rose).
struct PhraseEnergyStrip: View {
  let strip: NerdStats.EnergyStrip

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      HStack(spacing: 8) {
        GeometryReader { geo in
          ZStack(alignment: .bottomLeading) {
            HStack(alignment: .bottom, spacing: 1) {
              ForEach(strip.bars.indices, id: \.self) { k in
                let bar = strip.bars[k]
                RoundedRectangle(cornerRadius: 1)
                  .fill(color(bar.state))
                  .frame(height: geo.size.height * bar.height)
              }
            }
            marker(.cyan, at: strip.introAt, width: geo.size.width)
            marker(.pink, at: strip.outroAt, width: geo.size.width)
          }
        }
        .frame(height: 20)
        Text(strip.energyNow)
      }
      HStack(spacing: 12) {
        Label(strip.introLabel, systemImage: "line.diagonal").labelStyle(.titleOnly).foregroundStyle(.cyan)
        Label(strip.outroLabel, systemImage: "line.diagonal").labelStyle(.titleOnly).foregroundStyle(.pink)
      }
      .font(.system(size: 10, design: .monospaced))
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Phrase energy, now \(strip.energyNow); \(strip.introLabel); \(strip.outroLabel)")
  }

  private func color(_ state: NerdStats.EnergyStrip.State) -> Color {
    switch state {
    case .unmeasured: .primary.opacity(0.05)
    case .now: .accentColor
    case .past: .primary.opacity(0.35)
    case .future: .primary.opacity(0.15)
    }
  }

  private func marker(_ color: Color, at x: Double, width: CGFloat) -> some View {
    Rectangle().fill(color).frame(width: 1).offset(x: x * width).padding(.vertical, -2)
  }
}
