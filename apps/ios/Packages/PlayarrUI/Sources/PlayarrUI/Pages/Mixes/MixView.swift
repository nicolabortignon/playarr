import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// A mix's page: why these songs, when it changes, the action row (Play, Shuffle, New mix, Download and ⋯: Play next,
/// Add to queue, Add to playlist…, then Save as playlist) and the songs (apps/web/src/pages/Mix.tsx).
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
            MixCover(mix: Self.summary(mix), width: side, titled: false).coverShadow(.hero)
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
    .titleInBar(model.mix?.title ?? "")
    .task { await model.poll() }
  }

  /// The header (the cover unless it's beside the page), why these songs, and the songs.
  private func details(_ mix: MixDetail, cover: Bool) -> some View {
    VStack(alignment: .leading, spacing: 24) {
      DetailHeader(kicker: "Made for you", showsCover: cover) {
        // The page's own cover leaves its name off: it's beside it.
        GeometryReader { box in MixCover(mix: Self.summary(mix), width: box.size.width, titled: false) }
      } title: {
        DetailTitle(mix.title)
      } meta: {
        TimelineView(.periodic(from: .now, by: 60)) { context in MetaLine(model.facts(now: context.date)) }
      } actions: {
        buttons(mix)
      }
      // Why these songs: after the row, so Play comes first on a phone.
      if !mix.description.isEmpty {
        Text(mix.description).typeRole(.body).foregroundStyle(.paperDim)
      }
      LazyVStack(spacing: 0) {
        ForEach(Array(mix.tracks.enumerated()), id: \.element.id) { index, track in
          SongRow(track: track) { session.player.play(mix.tracks, startAt: index, source: model.source) }
        }
      }
    }
    .padding(.horizontal, 20)
    .padding(.top, 12)
    .padding(.bottom, 20)
  }

  /// Play, Shuffle, New mix, Download and ⋯ (Play next, Add to queue, Add to playlist…, then Save as playlist).
  private func buttons(_ mix: MixDetail) -> some View {
    ActionRow(
      title: mix.title, playState: model.playState, disabled: mix.tracks.isEmpty, play: model.playOrPause,
      shuffle: { model.play(shuffle: true) },
      download: DownloadButton(
        store: session.player.downloads,
        item: DownloadItem(
          key: PinnedDownload.Key.mix(mix.key), title: mix.title, subtitle: "Mix", coverUrl: mix.covers.first, href: "/mixes/\(mix.key)"),
        tracks: mix.tracks),
      moreLabel: "Mix actions"
    ) { compact in
      newMix(compact: compact)
    } more: {
      // What everything you can play offers, then the mix's own action.
      MenuButtons(groups: [
        PlayableMenu.queueItems(.tracks(mix.tracks), session: session),
        [
          MenuAction(.saveAsPlaylist) {
            // Opens the new playlist, so it's clear what was made and where it lives.
            Task { if let playlist = await model.save() { session.router.open(.playlist(playlist.id)) } }
          }
        ],
      ])
    }
  }

  /// Another draw of the mix ("Mixing…" while it's made), as an icon when the row has no room for its words.
  @ViewBuilder private func newMix(compact: Bool) -> some View {
    let title = model.regenerating ? "Mixing…" : "New mix"
    Group {
      if compact {
        Button { Task { await model.regenerate() } } label: { Image(systemName: "arrow.clockwise") }
          .buttonStyle(.outlinedIcon)
          .accessibilityLabel(title)
      } else {
        Button { Task { await model.regenerate() } } label: {
          SteadyLabel(title, systemImage: "arrow.clockwise", among: [("New mix", "arrow.clockwise"), ("Mixing…", "arrow.clockwise")])
        }
        .buttonStyle(.pill(.secondary, size: .large))
      }
    }
    .disabled(model.regenerating)
  }

  /// The mix as its cover draws it.
  static func summary(_ mix: MixDetail) -> MixSummary {
    MixSummary(
      key: mix.key, kind: mix.kind, title: mix.title, subtitle: mix.subtitle, description: mix.description, trackCount: mix.trackCount,
      duration: mix.duration, covers: mix.covers, hue: mix.hue, generatedAt: mix.generatedAt, refreshesAt: mix.refreshesAt)
  }
}
