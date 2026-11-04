import PlayarrPlayer
import SwiftUI

/// Now Playing → sleep timer (apps/web/src/components/SleepTimer.tsx): stop after a while, or at the end of this song.
struct SleepTimerMenu: View {
  let player: Player
  @Environment(Theme.self) private var theme

  var body: some View {
    let sleep = player.sleep
    // The minutes left count down while it's shown; a new choice redraws at once.
    TimelineView(.periodic(from: .now, by: 15)) { context in
      let label = sleep.label(at: context.date)
      Menu {
        ForEach(NowPlayingModel.sleepMinutes, id: \.self) { minutes in
          Button(NowPlayingModel.sleepLabel(minutes: minutes), systemImage: "moon") { player.sleep(minutes: minutes) }
        }
        Button("At the end of this song", systemImage: "moon") { player.sleepAtEndOfSong() }
        if label != nil {
          Button("Turn off the timer", systemImage: "moon.zzz", role: .destructive) { player.cancelSleep() }
        }
      } label: {
        HStack(spacing: 4) {
          Image(systemName: "moon")
          if let label { Text(label.uppercased()).font(.mono(.caption2)) }
        }
        .frame(minWidth: 44, minHeight: 44)
        .foregroundStyle(label == nil ? Color.primary : theme.accent.color)
      }
      .accessibilityLabel(label.map { "Sleep timer: \($0)" } ?? "Sleep timer")
    }
    .id(sleep.endOfSong ? -1 : sleep.endsAt?.timeIntervalSince1970 ?? 0)
  }
}
