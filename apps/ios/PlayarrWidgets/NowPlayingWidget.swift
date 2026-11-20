import AppIntents
import PlayarrWidgetData
import SwiftUI
import WidgetKit

/// Now Playing: the song playing or paused, its cover and how far along it is (the bar runs on its own while it plays,
/// from when the song would have started, so the widget isn't reloaded each second). Medium adds previous, play or
/// pause, and next. With nothing playing, Feeling lucky.
struct NowPlayingWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: WidgetKind.nowPlaying, provider: SnapshotProvider()) { entry in
      NowPlayingView(entry: entry)
        .containerBackground(Color.widgetInk, for: .widget)
    }
    .configurationDisplayName("Now Playing")
    .description("The song playing, with play, pause and skip.")
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}

struct NowPlayingView: View {
  let entry: SnapshotEntry
  @Environment(\.widgetFamily) private var family

  var body: some View {
    if entry.snapshot?.account == nil {
      SignInPrompt()
    } else if let song = entry.snapshot?.nowPlaying {
      if family == .systemSmall { small(song) } else { medium(song) }
    } else {
      VStack(alignment: .leading) {
        Text("Nothing playing")
          .font(.headline)
          .foregroundStyle(.white)
        Spacer(minLength: 0)
        QuickPlayButton(intent: FeelingLuckyIntent(), title: "Feeling lucky", symbol: "sparkles", primary: true)
          .frame(maxHeight: 64)
      }
    }
  }

  private func small(_ song: WidgetSnapshot.NowPlaying) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(alignment: .top) {
        WidgetCover(name: song.cover)
          .frame(width: 56)
        Spacer(minLength: 0)
        PlayPauseButton(playing: song.playing)
      }
      Spacer(minLength: 0)
      SongTitles(song: song)
      SongProgress(song: song)
    }
  }

  private func medium(_ song: WidgetSnapshot.NowPlaying) -> some View {
    HStack(spacing: 14) {
      WidgetCover(name: song.cover)
      VStack(alignment: .leading, spacing: 6) {
        SongTitles(song: song)
        SongProgress(song: song)
        Spacer(minLength: 0)
        HStack {
          ControlButton(intent: PreviousSongIntent(), symbol: "backward.fill", label: "Previous")
          Spacer(minLength: 0)
          PlayPauseButton(playing: song.playing)
          Spacer(minLength: 0)
          ControlButton(intent: NextSongIntent(), symbol: "forward.fill", label: "Next")
        }
      }
    }
  }
}

struct SongTitles: View {
  let song: WidgetSnapshot.NowPlaying

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(song.title)
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(.white)
        .lineLimit(1)
      Text(song.artist)
        .font(.caption)
        .foregroundStyle(.secondary)
        .lineLimit(1)
    }
  }
}

/// How far along the song is: running on its own while it plays, still while it's paused.
struct SongProgress: View {
  let song: WidgetSnapshot.NowPlaying

  var body: some View {
    Group {
      if song.playing, song.duration > 0 {
        ProgressView(timerInterval: song.startedAt...song.startedAt.addingTimeInterval(song.duration), countsDown: false) {
          EmptyView()
        } currentValueLabel: {
          EmptyView()
        }
      } else {
        ProgressView(value: min(song.elapsed, song.duration), total: max(song.duration, 1))
      }
    }
    .progressViewStyle(.linear)
    .tint(.white)
  }
}

/// Play or pause, the accent's round button.
struct PlayPauseButton: View {
  let playing: Bool

  var body: some View {
    Button(intent: PlayPauseIntent()) {
      Image(systemName: playing ? "pause.fill" : "play.fill")
        .font(.title3)
        .foregroundStyle(Color.widgetInk)
        .frame(width: 44, height: 44)
        .background(.tint, in: Circle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(playing ? "Pause" : "Play")
  }
}

struct ControlButton<Intent: AppIntent>: View {
  let intent: Intent
  let symbol: String
  let label: LocalizedStringKey

  var body: some View {
    Button(intent: intent) {
      Image(systemName: symbol)
        .font(.body)
        .foregroundStyle(.white)
        .frame(width: 44, height: 44)
    }
    .buttonStyle(.plain)
    .accessibilityLabel(Text(label))
  }
}

#Preview("Small", as: .systemSmall) {
  NowPlayingWidget()
} timeline: {
  SnapshotEntry(date: .now, snapshot: .placeholder)
  SnapshotEntry(date: .now, snapshot: WidgetSnapshot(account: WidgetSnapshot.placeholder.account))
}

#Preview("Medium", as: .systemMedium) {
  NowPlayingWidget()
} timeline: {
  SnapshotEntry(date: .now, snapshot: .placeholder)
}
