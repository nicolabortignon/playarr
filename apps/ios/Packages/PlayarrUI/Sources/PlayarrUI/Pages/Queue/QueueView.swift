import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// The Queue tab (apps/web/src/pages/Queue.tsx).
struct QueueView: View {
  let session: AccountSession
  @Environment(Theme.self) private var theme
  @State private var reordered = 0
  #if os(iOS)
    @State private var editMode: EditMode = .inactive
  #endif

  var body: some View {
    let model = QueueModel(session: session)
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
            if model.upcoming.isEmpty {
              Text("The queue ends after this track.").foregroundStyle(.secondary)
            }
            ForEach(Array(model.upcoming.enumerated()), id: \.element.id) { offset, song in
              upNextRow(song, offset: offset, model: model)
            }
            .onMove { model.move(from: $0, to: $1); reordered += 1 }
            .onDelete { model.remove($0) }
          } header: {
            // Edit and Clear as plain words in the header, just under the playing song, rather than in the bar.
            HStack(spacing: 16) {
              Text(model.header)
              Spacer()
              if !model.upcoming.isEmpty {
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
        .sensoryFeedback(.impact(weight: .light), trigger: reordered)
        #if os(iOS)
          .environment(\.editMode, $editMode)
          .onChange(of: model.upcoming.isEmpty) { _, empty in if empty { editMode = .inactive } }
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
          Image(systemName: "waveform").symbolEffect(.variableColor.iterative, isActive: session.player.queue.playing)
          Text(track.title).font(.sans(.headline)).lineLimit(1)
          OfflineMark(store: session.player.downloads, fileId: track.fileId)
        }
        .foregroundStyle(theme.accent.color)
        Button("\(track.artistName) · \(track.albumTitle)") { session.router.open(.album(track.albumId)) }
          .font(.sans(.subheadline)).foregroundStyle(.secondary).lineLimit(1).buttonStyle(.plain)
        FormatBadge(format: track.format)
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Now playing: \(track.title), \(track.artistName)")
  }

  private func upNextRow(_ song: QueueModel.Upcoming, offset: Int, model: QueueModel) -> some View {
    let track = song.track
    return HStack(spacing: 12) {
      Button { model.play(offset) } label: {
        HStack(spacing: 12) {
          Cover(path: track.coverUrl, points: 44, label: track.albumTitle).frame(width: 44, height: 44)
          VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
              Text(track.title).lineLimit(1)
              OfflineMark(store: session.player.downloads, fileId: track.fileId)
            }
            Text(track.artistName).font(.sans(.footnote)).foregroundStyle(.secondary).lineLimit(1)
          }
          Spacer()
          Text(Format.time(track.duration)).font(.sans(.footnote).monospacedDigit()).foregroundStyle(.secondary)
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("\(track.title), \(track.artistName), \(Format.time(track.duration))")
      .accessibilityHint("Plays from this song")
      Menu {
        if offset > 0 { Button("Play next", systemImage: "text.line.first.and.arrowtriangle.forward") { model.playNext(song) } }
        Button("Go to album", systemImage: "square.stack") { session.router.open(.album(track.albumId)) }
        Button("Go to artist", systemImage: "music.mic") { session.router.open(.artist(track.artistId)) }
        Button("Remove from queue", systemImage: "xmark", role: .destructive) { model.remove([offset]) }
      } label: {
        Image(systemName: "ellipsis").frame(width: 44, height: 44).contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .foregroundStyle(.secondary)
      .accessibilityLabel("More for \(track.title)")
    }
  }
}
