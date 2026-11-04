import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// The Queue tab (apps/web/src/pages/Queue.tsx).
struct QueueView: View {
  let session: AccountSession
  @Environment(Theme.self) private var theme
  @State private var reordered = 0
  @Environment(\.reducesMotion) private var reducesMotion
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
              Text("The queue ends after this track.").foregroundStyle(.muted)
            }
            ForEach(Array(upcoming.enumerated()), id: \.element.id) { offset, song in
              upNextRow(song, offset: offset, model: model)
            }
            .onMove { model.move(from: $0, to: $1); reordered += 1 }
            .onDelete { model.remove($0) }
          } header: {
            // Edit and Clear as plain words in the header, just under the playing song, rather than in the bar.
            HStack(spacing: 16) {
              Text(model.header)
              Spacer()
              if !upcoming.isEmpty {
                #if os(iOS)
                  Button(editMode.isEditing ? "Done" : "Edit") {
                    withAnimation { editMode = editMode.isEditing ? .inactive : .active }
                  }
                #endif
                Button("Clear") { model.clear() }
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
          ToolbarItem(placement: .secondaryAction) {
            Button("Save as playlist", systemImage: "text.badge.plus") {
              session.addToPlaylist(AccountSession.queueToSave(session.player.queue))
            }
          }
        }
      } else {
        ContentUnavailableView {
          Label("Nothing queued", systemImage: "list.bullet")
        } description: {
          Text("Pick an album to start listening.")
        } actions: {
          NavigationLink("Albums", value: Route.albums(.artist))
        }
      }
    }
    // No title: the tab bar already says where you are.
    .navigationTitle("")
    .inlineTitle()
  }

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
          .font(.sans(.subheadline)).foregroundStyle(.muted).essentialLineLimit().buttonStyle(.plain)
          .accessibilityHint("Opens the album")
        FormatBadge(format: track.format)
      }
    }
  }

  private func upNextRow(_ song: QueueModel.Upcoming, offset: Int, model: QueueModel) -> some View {
    let track = song.track
    return HStack(spacing: 12) {
      Button { model.play(offset) } label: {
        AdaptiveStack(spacing: 12) {
          Cover(path: track.coverUrl, points: 44, label: track.albumTitle).frame(width: 44, height: 44)
          VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
              Text(track.title).essentialLineLimit()
              OfflineMark(store: session.player.downloads, fileId: track.fileId)
            }
            Text(track.artistName).font(.sans(.footnote)).foregroundStyle(.muted).essentialLineLimit()
          }
          Spacer(minLength: 8)
          Text(Format.time(track.duration)).font(.sans(.footnote).monospacedDigit()).foregroundStyle(.muted)
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .pointerHover()
      .accessibilityLabel("\(track.title), \(track.artistName), \(Format.time(track.duration))")
      .accessibilityHint("Plays from this song")
      .accessibilityActions { upNextItems(song, offset: offset, model: model) }
      Menu {
        upNextItems(song, offset: offset, model: model)
      } label: {
        Image(systemName: "ellipsis").frame(width: 44, height: 44).contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .foregroundStyle(.muted)
      .pointerHover()
      .accessibilityLabel("More for \(track.title)")
    }
    .contextMenu { upNextItems(song, offset: offset, model: model) }
  }

  /// A song in Up next: its ⋯ menu, its long-press (or secondary-click) menu and its VoiceOver actions.
  @ViewBuilder
  private func upNextItems(_ song: QueueModel.Upcoming, offset: Int, model: QueueModel) -> some View {
    let track = song.track
    if offset > 0 { Button("Play next", systemImage: "text.line.first.and.arrowtriangle.forward") { model.playNext(song) } }
    Button("Go to album", systemImage: "square.stack") { session.router.open(.album(track.albumId)) }
    Button("Go to artist", systemImage: "music.mic") { session.router.open(.artist(track.artistId)) }
    Button("Remove from queue", systemImage: "xmark", role: .destructive) { model.remove([offset]) }
  }
}
