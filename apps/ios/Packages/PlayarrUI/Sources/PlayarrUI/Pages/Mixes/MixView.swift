import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// A mix's page: why these songs, when it changes, Play, Shuffle, New mix, the ⋯ menu (Save as playlist, Play next,
/// Add to queue), Download and the songs (apps/web/src/pages/Mix.tsx).
struct MixView: View {
  let session: AccountSession
  @State private var model: MixModel
  @Environment(Theme.self) private var theme
  @Environment(\.verticalSizeClass) private var verticalSizeClass

  init(key: String, session: AccountSession) {
    self.session = session
    _model = State(initialValue: MixModel(key: key, session: session))
  }

  var body: some View {
    Group {
      if let mix = model.mix {
        if GatefoldRule.applies(verticalSizeClass) {
          // Sideways: the cover stays on the left, the rest scrolls beside it.
          Gatefold { side in
            MixCover(mix: Self.summary(mix), width: side).shadow(color: .black.opacity(0.8), radius: 30, y: 20)
          } page: {
            ScrollView { details(mix, cover: false) }
          }
        } else {
          ScrollView { details(mix, cover: true) }
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

  /// The cover (unless it's beside the page), why these songs, the buttons and the songs.
  private func details(_ mix: MixDetail, cover: Bool) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      if cover {
        MixCover(mix: Self.summary(mix), width: 256)
          .shadow(color: .black.opacity(0.8), radius: 30, y: 20)
          .frame(maxWidth: .infinity)
      }
      Kicker(text: "Made for you")
      Text(mix.title).font(.display(.largeTitle))
      Text(mix.description).foregroundStyle(.secondary)
      TimelineView(.periodic(from: .now, by: 60)) { context in
        Text(model.facts(now: context.date)).font(.mono(.caption)).foregroundStyle(.secondary)
      }
      FlowRow {
        PlayShuffleButtons(title: mix.title, disabled: mix.tracks.isEmpty) {
          model.play(shuffle: false)
        } shuffle: {
          model.play(shuffle: true)
        }
        Button(model.regenerating ? "Mixing…" : "New mix", systemImage: "arrow.clockwise") { Task { await model.regenerate() } }
          .buttonStyle(.pill(.outlined))
          .disabled(model.regenerating)
        DownloadButton(
          store: session.player.downloads,
          item: DownloadItem(
            key: PinnedDownload.Key.mix(mix.key), title: mix.title, subtitle: "Mix", coverUrl: mix.covers.first, href: "/mixes/\(mix.key)"),
          tracks: mix.tracks)
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

  /// The mix as its cover draws it.
  static func summary(_ mix: MixDetail) -> MixSummary {
    MixSummary(
      key: mix.key, kind: mix.kind, title: mix.title, subtitle: mix.subtitle, description: mix.description, trackCount: mix.trackCount,
      duration: mix.duration, covers: mix.covers, hue: mix.hue, generatedAt: mix.generatedAt, refreshesAt: mix.refreshesAt)
  }
}
