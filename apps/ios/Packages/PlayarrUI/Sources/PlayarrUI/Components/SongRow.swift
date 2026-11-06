import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// A song in any list (docs/design.md, "Rows, menus and toasts"; apps/web/src/components/SongRow.tsx): an album, a
/// playlist, a mix, Favorites, the queue, search, Now Playing's Up next, Your listening. Number or cover · title over
/// subtitle · time · ♥ · ⋯, in that order on both apps, and every row of a list as tall as the others (60 points, 52 in
/// Up next). The song playing has an accent title and the equalizer. Tapping the row plays from it (the song playing
/// pauses or resumes instead); ⋯, a long press, a secondary click and VoiceOver's actions offer the one song menu
/// (`SongMenu`), with the place's own actions after a line.
struct SongRow: View {
  enum Lead { case number, cover }

  static let height: CGFloat = 60
  static let compactHeight: CGFloat = 52

  let track: Track
  var lead = Lead.cover
  /// Its place in a ranking (Your listening's top songs), before the cover.
  var rank: Int?
  /// Under the title, joined by dots: by default the artist and the album beside a cover, nothing beside a number.
  var subtitle: [String]?
  /// In place of the length, the number that matters in this list: a ranking's plays ("12 plays").
  var numbers: String?
  /// Marks the song when it's the one playing: off in Up next, where it never is.
  var markCurrent = true
  /// The queue and Your listening on a phone (and the iPad's side column): no heart (it goes in the menu), and the
  /// length or `numbers` under the title after the subtitle, so the title keeps its room.
  var stacked = false
  /// Up next in Now Playing: a smaller cover and a lower row, the same type.
  var compact = false
  /// Over a blurred cover (Now Playing): quieter words in `.paperDim`, never `.muted`.
  var overArt = false
  /// Dragged onto a playlist or the queue on an iPad. Off in lists that reorder by dragging their rows.
  var drags = true
  /// What the menu offers here: the place's own actions, Go to album left out on the album's page…
  var place = SongMenu.Place()
  /// What VoiceOver says a tap does, when it isn't "Plays the song" ("Plays from this song" in Up next).
  var hint: String?
  let onPlay: () -> Void

  @Environment(AccountSession.self) private var session
  @Environment(Theme.self) private var theme

  var body: some View {
    let queue = session.player.queue
    let current = markCurrent && queue.currentTrack?.fileId == track.fileId
    let playing = current && queue.playing
    var place = self.place
    if stacked { place.favorite = true }
    let groups = SongMenu.groups(track, place: place, session: session)
    return HStack(spacing: 12) {
      Button {
        if current { session.player.togglePlay() } else { onPlay() }
      } label: {
        AdaptiveStack(spacing: 12) {
          leading(current: current, playing: playing)
          words(current: current)
          Spacer(minLength: 8)
          if !stacked {
            if let numbers {
              Text(numbers).typeRole(.meta).foregroundStyle(quiet)
            } else {
              SongLength(track: track, overArt: overArt)
            }
          }
        }
        .frame(minHeight: compact ? Self.compactHeight : Self.height)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .pointerHover()
      .accessibilityLabel(spoken)
      .accessibilityValue(playing ? "Playing" : current ? "Paused" : "")
      .accessibilityHint(hint ?? (current ? "Plays or pauses the song" : "Plays the song"))
      .accessibilityActions {
        ForEach(Self.voiceOverActions(groups, heart: stacked ? nil : SongMenu.favorite(track, session: session))) { action in
          Button(action.title, action: action.perform)
        }
      }
      .modifier(SongDrag(track: track, enabled: drags))
      if !stacked { FavoriteButton(track: track, size: .row) }
      MoreMenu(title: track.title, groups: groups)
    }
    .contextMenu { MenuButtons(groups: groups) }
    // In a List, the row is as tall as the others: no padding above and below it.
    .listRowInsets(.vertical, 0)
  }

  /// VoiceOver's actions on the row: the menu's items in its order (Move up and Move down among them where the list
  /// reorders), then the heart when it's a button of its own beside the row, so it's one swipe away with the rest.
  static func voiceOverActions(_ groups: [[MenuAction]], heart: MenuAction?) -> [MenuAction] {
    groups.flatMap(\.self) + (heart.map { [$0] } ?? [])
  }

  private var quiet: AnyShapeStyle { overArt ? AnyShapeStyle(.paperDim) : AnyShapeStyle(.muted) }

  /// The rank, then the number (the equalizer while it plays) or the cover (the equalizer over it).
  @ViewBuilder
  private func leading(current: Bool, playing: Bool) -> some View {
    HStack(spacing: 12) {
      if let rank {
        Text("\(rank)").typeRole(.meta).foregroundStyle(quiet).frame(minWidth: 24, alignment: .trailing)
      }
      switch lead {
      case .number:
        Group {
          if current {
            Equalizer(playing: playing).foregroundStyle(theme.accent.color)
          } else {
            Text("\(track.trackNumber)").typeRole(.meta).foregroundStyle(quiet)
          }
        }
        .frame(width: 32)
      case .cover:
        let side: CGFloat = compact ? 40 : 44
        Cover(path: track.coverUrl, points: side, label: track.albumTitle)
          .frame(width: side, height: side)
          .overlay {
            if current {
              Equalizer(playing: playing)
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(.black.opacity(0.55))
                .clipShape(RoundedRectangle(cornerRadius: Radius.cover))
            }
          }
      }
    }
  }

  /// The title (in the accent while it plays) with the offline mark, over the subtitle; stacked, the numbers after it.
  private func words(current: Bool) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      HStack(spacing: 6) {
        Text(track.title)
          .typeRole(.body)
          .foregroundStyle(current ? AnyShapeStyle(theme.accent.color) : AnyShapeStyle(.paper))
          .essentialLineLimit()
        OfflineMark(store: session.player.downloads, fileId: track.fileId)
      }
      let under = lines.joined(separator: " · ")
      if stacked {
        NameAndNumbers(name: under.isEmpty ? nil : Text(under), numbers: Text(numbers ?? Format.time(track.duration)).monospacedDigit())
          .typeRole(.small)
          .foregroundStyle(.paperDim)
      } else if !under.isEmpty {
        Text(under).typeRole(.small).foregroundStyle(.paperDim).essentialLineLimit()
      }
    }
  }

  /// What's under the title.
  private var lines: [String] {
    subtitle ?? (lead == .cover ? [track.artistName, track.albumTitle] : [])
  }

  /// "2. Sour Times, 4:14", "Angel, Massive Attack, Mezzanine, 6:19", "1. Angel, Massive Attack, 5 plays".
  private var spoken: String {
    let place = rank ?? (lead == .number ? track.trackNumber : nil)
    let title = place.map { "\($0). \(track.title)" } ?? track.title
    return ([title] + lines + [numbers ?? Format.time(track.duration)]).joined(separator: ", ")
  }
}

/// A song not in the library, grayed in its place (docs/design.md, "Rows"): an album's missing songs and a playlist's
/// songs the library no longer has. Nothing to play; only its place's own actions, behind ⋯. Its length (when known)
/// stays in line with the other rows'.
struct MissingSongRow: View {
  enum Lead {
    case number(Int)
    /// The stand-in cover, with the album's initials.
    case cover(album: String)
  }

  let title: String
  let lead: Lead
  var subtitle: [String] = []
  var duration: Double?
  var own: [MenuAction] = []

  var body: some View {
    HStack(spacing: 12) {
      HStack(spacing: 12) {
        switch lead {
        case .number(let number):
          Text("\(number)").typeRole(.meta).frame(width: 32)
        case .cover(let album):
          Cover(path: nil, points: 44, label: album).frame(width: 44, height: 44).opacity(0.4)
        }
        VStack(alignment: .leading, spacing: 2) {
          Text(title).typeRole(.body).essentialLineLimit()
          if !subtitle.isEmpty {
            HStack(spacing: 8) {
              Text(subtitle.joined(separator: " · ")).typeRole(.small).essentialLineLimit()
              Text("Not in library").typeRole(.badge)
            }
          }
        }
        Spacer(minLength: 8)
        if let duration { Text(Format.time(duration)).typeRole(.meta) }
      }
      .frame(minHeight: SongRow.height)
      // Grayed, as the web's, but still readable: white at 50 % passes 4.5:1 on Playarr's dark.
      .foregroundStyle(.muted)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(spoken)
      // VoiceOver's frame is the whole row, as tall as the others: left to itself it's only its words' (19 points),
      // which the accessibility audit took for a control too small to tap.
      .contentShape(.accessibility, Rectangle())
      if duration != nil { ControlGap() }
      if !own.isEmpty {
        MoreMenu(title: title, groups: [own])
      } else if duration != nil {
        ControlGap()
      }
    }
    // A menu only where there's something in it: an album's missing song has nothing to do, so nothing to press.
    .modifier(OwnMenu(own: own))
    .listRowInsets(.vertical, 0)
  }

  /// "3. Teardrop, not in your library", "Teardrop, Massive Attack, not in your library".
  private var spoken: String {
    switch lead {
    case .number(let number): "\(number). \(title), not in your library"
    case .cover: ([title] + subtitle.prefix(1) + ["not in your library"]).joined(separator: ", ")
    }
  }
}

/// A missing song's long press: its place's own actions, when it has some.
private struct OwnMenu: ViewModifier {
  let own: [MenuAction]

  func body(content: Content) -> some View {
    if own.isEmpty {
      content
    } else {
      content.contextMenu { MenuButtons(groups: [own]) }
    }
  }
}

/// As wide as a row's ♥ or ⋯: keeps a missing song's length in line with the others'.
struct ControlGap: View {
  var body: some View {
    Color.clear.frame(width: 44, height: 44).accessibilityHidden(true)
  }
}

/// The song playing: its waveform, moving while it plays (still with Reduce Motion).
private struct Equalizer: View {
  let playing: Bool
  @Environment(\.reducesMotion) private var reducesMotion

  var body: some View {
    Image(systemName: "waveform")
      .symbolEffect(.variableColor.iterative, isActive: playing && !reducesMotion)
      .accessibilityHidden(true)
  }
}

/// A song row dragged onto one of your playlists or the queue (iPad).
private struct SongDrag: ViewModifier {
  let track: Track
  let enabled: Bool

  func body(content: Content) -> some View {
    if enabled {
      content.draggable(TrackDrag(tracks: [track])) {
        Label(track.title, systemImage: "music.note").padding(10).background(.regularMaterial, in: Capsule())
      }
    } else {
      content
    }
  }
}
