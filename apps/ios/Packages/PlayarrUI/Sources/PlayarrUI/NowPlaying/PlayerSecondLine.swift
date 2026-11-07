import PlayarrPlayer
import SwiftUI

/// The player's second line, under the song's title in the mini player, the iPad bar and the sideways tracklist (plan 7
/// §5; docs/design.md, Moments): what it usually says (the artist), or from ten seconds before the next song takes
/// over, "Next: Teardrop", and with DJ mix about to blend them "Mixing into Teardrop on the next bar", then "Mixing into
/// Teardrop" while they do (`Player.endOfSongLine`). Each new line fades in, at once under Reduce Motion. A view of its
/// own, so the clock moving redraws only it; the caller sets the type. Upright Now Playing's is `endOfSongLine(_:)`.
struct PlayerSecondLine<Usual: View>: View {
  let player: Player
  let usual: Usual
  @Environment(\.reducesMotion) private var reducesMotion
  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    let words = player.endOfSongWords
    ZStack(alignment: .leading) {
      if let words {
        EndOfSongText(words: words, wraps: typeSize.isAccessibilitySize).id(words).transition(.opacity)
      } else {
        usual.transition(.opacity)
      }
    }
    .animation(reducesMotion ? nil : .easeOut(duration: 0.4), value: words)
  }
}

/// What comes next, on one line: short of room, the last bar's "Mixing into Teardrop on the next bar" says "Mixing on
/// the next bar" (the title was said a moment before), and the others are cut short at their end. Where lines wrap
/// (the accessibility sizes), the whole line.
struct EndOfSongText: View {
  let words: EndOfSong.Words
  var wraps = false

  var body: some View {
    if wraps {
      Text(words.text)
    } else if let short = words.short {
      // Plain texts made here, not by a ForEach: nothing SwiftUI could call off the main thread as it measures (build 684).
      ViewThatFits(in: .horizontal) {
        Text(words.text)
        Text(short)
      }
      .lineLimit(1)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(words.text)
    } else {
      Text(words.text).lineLimit(1)
    }
  }
}

extension View {
  /// Now Playing's second line (the artist and the format), saying what comes next as the song ends, as
  /// `PlayerSecondLine` does: on one line across the line's whole width, over it, the line keeping its room. In its
  /// place, an artist's name that wraps would leave room for one line of words where there were two, and words that
  /// wrapped would push the cover smaller for the song's last bar. At the accessibility sizes, where everything stacks
  /// and wraps already, the words take the line's place.
  func endOfSongLine(_ player: Player) -> some View {
    modifier(EndOfSongLine(player: player))
  }
}

private struct EndOfSongLine: ViewModifier {
  let player: Player
  @Environment(\.reducesMotion) private var reducesMotion
  @Environment(\.dynamicTypeSize) private var typeSize

  func body(content: Content) -> some View {
    let words = player.endOfSongWords
    Group {
      if typeSize.isAccessibilitySize {
        ZStack(alignment: .leading) {
          if let words {
            EndOfSongText(words: words, wraps: true).id(words).transition(.opacity)
          } else {
            content.transition(.opacity)
          }
        }
      } else {
        content
          .opacity(words == nil ? 1 : 0)
          .allowsHitTesting(words == nil)
          .accessibilityHidden(words != nil)
          .frame(maxWidth: .infinity, alignment: .leading)
          .overlay(alignment: .topLeading) {
            if let words { EndOfSongText(words: words).id(words).transition(.opacity) }
          }
      }
    }
    .animation(reducesMotion ? nil : .easeOut(duration: 0.4), value: words)
  }
}
