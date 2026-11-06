import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// The Queue tab (apps/web/src/pages/Queue.tsx): its large title, with Edit and Save as playlist in the bar, the song
/// playing and where it's from, then Up next with Clear.
struct QueueView: View {
  let session: AccountSession
  /// In the iPad's side column, under its Queue and Lyrics switch: no title of its own.
  var narrow = false
  @Environment(Theme.self) private var theme
  @State private var reordered = 0
  @Environment(\.reducesMotion) private var reducesMotion
  @Environment(\.horizontalSizeClass) private var sizeClass
  #if os(iOS)
    @State private var editMode: EditMode = .inactive
  #endif

  var body: some View {
    let model = QueueModel(session: session)
    // Worked out once per change: a queue can hold thousands of songs.
    let upcoming = model.upcoming
    Group {
      if let track = model.current {
        List {
          Section {
            nowPlaying(track)
            TransitionLine(player: session.player)
          } header: {
            nowPlayingHeader(model)
          }
          Section {
            if upcoming.isEmpty {
              Text("The queue ends after this song.").foregroundStyle(.paperDim)
            }
            ForEach(Array(upcoming.enumerated()), id: \.element.id) { offset, song in
              upNextRow(song, offset: offset, count: upcoming.count, model: model)
            }
            .onMove { model.move(from: $0, to: $1); reordered += 1 }
            .onDelete { model.remove($0) }
          } header: {
            // Clear as a plain word beside what's coming, 44 points to tap (as the web's Up next).
            HStack(spacing: 8) {
              Text(model.header)
              Spacer()
              if !upcoming.isEmpty {
                Button { model.clear() } label: {
                  Text("Clear").frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                }
              }
            }
          }
        }
        .sensoryFeedback(Haptic.reorder, trigger: reordered)
        #if os(iOS)
          .environment(\.editMode, $editMode)
          .onChange(of: upcoming.isEmpty) { _, empty in if empty { editMode = .inactive } }
        #endif
        .toolbar {
          #if os(iOS)
            // The page's own controls, in the bar on the right (docs/design.md, "Headers").
            if !upcoming.isEmpty {
              ToolbarItem(placement: .primaryAction) {
                Button(editMode.isEditing ? "Done" : "Edit") {
                  withAnimation { editMode = editMode.isEditing ? .inactive : .active }
                }
              }
            }
          #endif
          ToolbarItem(placement: .secondaryAction) {
            Button("Save as playlist", systemImage: "text.badge.plus") {
              session.addToPlaylist(AccountSession.queueToSave(session.player.queue))
            }
          }
        }
      } else {
        // Scrolls, so the iPad's side column and the larger text sizes reach its buttons.
        ScrollView {
          ListeningEmptyState(systemImage: AppTab.queue.systemImage, line: PageLines.queue, luckyFirst: true)
        }
      }
    }
    .navigationTitle(narrow ? "" : "Queue")
    #if os(iOS)
      .navigationBarTitleDisplayMode(narrow ? .inline : .large)
    #endif
  }

  /// Up next's rows on a phone and in the side column leave out the heart (it's in their ⋯ menu) and put the length
  /// under the title, after the artist, so the titles keep their room (`SongRow.stacked`).
  private var compactRows: Bool { narrow || sizeClass == .compact }

  private func nowPlayingHeader(_ model: QueueModel) -> some View {
    HStack(spacing: 4) {
      Text("Now playing")
      if let source = model.source {
        Text("· from")
        Button(source.label) { session.router.open(href: source.href) }
      }
    }
  }

  private func nowPlaying(_ track: Track) -> some View {
    HStack(spacing: 14) {
      Cover(path: track.coverUrl, points: 72, label: track.albumTitle).frame(width: 72, height: 72)
      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 8) {
          Image(systemName: "waveform")
            .symbolEffect(.variableColor.iterative, isActive: session.player.queue.playing && !reducesMotion)
            .accessibilityHidden(true)
          Text(track.title).font(.sans(.headline)).essentialLineLimit()
            .accessibilityLabel("Now playing: \(track.title)")
          OfflineMark(store: session.player.downloads, fileId: track.fileId)
        }
        .foregroundStyle(theme.accent.color)
        // A button of its own (not merged into the row), so VoiceOver can open the album.
        Button("\(track.artistName) · \(track.albumTitle)") { session.router.open(.album(track.albumId)) }
          .font(.sans(.subheadline)).foregroundStyle(.paperDim).essentialLineLimit().buttonStyle(.plain)
          .frame(minHeight: 44, alignment: .leading)
          .contentShape(Rectangle())
          .accessibilityHint("Opens the album")
        FormatBadge(format: track.format)
      }
      Spacer(minLength: 8)
      FavoriteButton(track: track, size: .row)
    }
  }

  /// A song of Up next: the one song row, the artist under the title (on a phone with the length, the heart in its
  /// menu), with Move up, Move down and Remove from queue after a line, in its menu and as VoiceOver's actions.
  private func upNextRow(_ song: QueueModel.Upcoming, offset: Int, count: Int, model: QueueModel) -> some View {
    SongRow(
      track: song.track, subtitle: [song.track.artistName], markCurrent: false, stacked: compactRows, drags: false,
      place: SongMenu.upNext(offset, of: count, session: session), hint: "Plays from this song"
    ) {
      model.play(offset)
    }
  }
}
