import PlayarrAPI
import SwiftUI

/// The Queue tab (apps/web/src/pages/Queue.tsx).
struct QueueView: View {
  let session: AccountSession
  @Environment(Theme.self) private var theme
  @State private var reordered = 0

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
            HStack {
              Text(model.header)
              Spacer()
              if !model.upcoming.isEmpty { Button("Clear") { model.clear() } }
            }
          }
        }
        .sensoryFeedback(.impact(weight: .light), trigger: reordered)
        #if os(iOS)
          .toolbar { EditButton() }
        #endif
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
    .navigationTitle("Queue")
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
          Text(track.title).font(.headline).lineLimit(1)
        }
        .foregroundStyle(theme.accent.color)
        Button("\(track.artistName) · \(track.albumTitle)") { session.router.open(.album(track.albumId)) }
          .font(.subheadline).foregroundStyle(.secondary).lineLimit(1).buttonStyle(.plain)
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
            Text(track.title).lineLimit(1)
            Text(track.artistName).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
          }
          Spacer()
          Text(Format.time(track.duration)).font(.footnote.monospacedDigit()).foregroundStyle(.secondary)
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
