import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// A song's length in a list, after its tempo as Playarr measured it ("130.3  5:56"), as the web's song lists show
/// (apps/web/src/components/Tempo.tsx). The tempo shows at regular width only: on a phone the title needs the room, as
/// the web's narrow queue hides the column. A song not measured yet shows its length alone.
struct SongLength: View {
  let track: Track
  var font: Font = .sans(.footnote).monospacedDigit()

  @Environment(AccountSession.self) private var session
  @Environment(\.horizontalSizeClass) private var sizeClass

  var body: some View {
    let maps = session.player.transitions.mixMaps
    HStack(spacing: 10) {
      if sizeClass == .regular, let bpm = maps.map(track.recordingId)?.bpm, bpm > 0 {
        Text(bpm, format: .number.precision(.fractionLength(1)))
          .accessibilityLabel("\(Int(bpm.rounded())) BPM")
      }
      Text(Format.time(track.duration))
    }
    .font(font)
    .foregroundStyle(.muted)
    .task(id: sizeClass == .regular ? track.recordingId : nil) {
      if sizeClass == .regular { maps.want(track) }
    }
  }
}
