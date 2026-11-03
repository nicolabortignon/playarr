import PlayarrAPI
import SwiftUI

/// A mix's page: why these songs, when it changes, Play, Shuffle, New mix, the ⋯ menu (Save as playlist, Play next,
/// Add to queue) and the songs (apps/web/src/pages/Mix.tsx). Download joins in phase 7.
struct MixView: View {
  let session: AccountSession
  @State private var model: MixModel
  @Environment(Theme.self) private var theme

  init(key: String, session: AccountSession) {
    self.session = session
    _model = State(initialValue: MixModel(key: key, session: session))
  }

  var body: some View {
    Group {
      if let mix = model.mix {
        ScrollView {
          VStack(alignment: .leading, spacing: 16) {
            MixCover(mix: Self.summary(mix), width: 256)
              .shadow(color: .black.opacity(0.8), radius: 30, y: 20)
              .frame(maxWidth: .infinity)
            Kicker(text: "Made for you")
            Text(mix.title).font(.largeTitle.weight(.semibold))
            Text(mix.description).foregroundStyle(.secondary)
            TimelineView(.periodic(from: .now, by: 60)) { context in
              Text(model.facts(now: context.date)).font(.caption.monospaced()).foregroundStyle(.secondary)
            }
            HStack(spacing: 12) {
              Button("Play", systemImage: "play.fill") { model.play(shuffle: false) }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .tint(theme.accent.color)
                .foregroundStyle(.black)
                .disabled(mix.tracks.isEmpty)
                .accessibilityLabel("Play \(mix.title)")
              Button("Shuffle", systemImage: "shuffle") { model.play(shuffle: true) }
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .disabled(mix.tracks.isEmpty)
                .accessibilityLabel("Shuffle \(mix.title)")
              Button(model.regenerating ? "Mixing…" : "New mix", systemImage: "arrow.clockwise") { Task { await model.regenerate() } }
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .disabled(model.regenerating)
              // Phase 7: Download for this mix.
              Menu {
                Button("Save as playlist", systemImage: "bookmark") {
                  // Opens the new playlist, so it's clear what was made and where it lives.
                  Task { if let playlist = await model.save() { session.router.open(.playlist(playlist.id)) } }
                }
                Button("Play next", systemImage: "text.line.first.and.arrowtriangle.forward") { model.queue(next: true) }
                Button("Add to queue", systemImage: "text.append") { model.queue(next: false) }
              } label: {
                Image(systemName: "ellipsis").frame(width: 44, height: 44)
              }
              .accessibilityLabel("Mix actions")
            }
            LazyVStack(spacing: 0) {
              ForEach(Array(mix.tracks.enumerated()), id: \.element.id) { index, track in
                TrackRow(track: track, style: .mixed) { session.player.play(mix.tracks, startAt: index, source: model.source) }
              }
            }
          }
          .padding(20)
        }
      } else if let error = model.error {
        ErrorState(message: error) { await model.load() }
      } else {
        ProgressView()
      }
    }
    .navigationTitle(model.mix?.title ?? "")
    #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
    #endif
    .task { await model.poll() }
  }

  /// The mix as its cover draws it.
  static func summary(_ mix: MixDetail) -> MixSummary {
    MixSummary(
      key: mix.key, kind: mix.kind, title: mix.title, subtitle: mix.subtitle, description: mix.description, trackCount: mix.trackCount,
      duration: mix.duration, covers: mix.covers, hue: mix.hue, generatedAt: mix.generatedAt, refreshesAt: mix.refreshesAt)
  }
}
