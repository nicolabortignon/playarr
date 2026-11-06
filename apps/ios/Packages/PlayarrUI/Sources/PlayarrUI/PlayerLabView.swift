#if DEBUG
  import PlayarrAPI
  import PlayarrPlayer
  import SwiftUI

  /// Debug builds only: play an album by id from the server and watch the engine (decks, buffer, gains), the
  /// harness phase 3 ends with, before any real screen sits on the player.
  public struct PlayerLabView: View {
    let player: Player
    let client: APIClient
    @State private var albumId = ""
    @State private var failure: String?
    @State private var scrubbing: Double?

    public init(player: Player, client: APIClient) {
      self.player = player
      self.client = client
    }

    public var body: some View {
      NavigationStack {
        Form {
          album
          nowPlaying
          playback
          sleep
          engine
          queue
        }
        .navigationTitle("Player lab")
      }
    }

    private var album: some View {
      Section("Album") {
        TextField("Album id", text: $albumId)
        #if os(iOS)
          .keyboardType(.numberPad)
        #endif
        Button("Play album") { Task { await playAlbum() } }
          .disabled(Int(albumId) == nil)
        if let failure { Text(failure).foregroundStyle(.danger) }
      }
    }

    private var nowPlaying: some View {
      Section("Now playing") {
        Text(player.queue.currentTrack.map { "\($0.title) · \($0.artistName)" } ?? "Nothing")
        TimelineView(.periodic(from: .now, by: 0.25)) { _ in
          VStack(alignment: .leading) {
            Slider(
              value: Binding(get: { scrubbing ?? player.time }, set: { scrubbing = $0 }),
              in: 0...max(1, player.duration),
              onEditingChanged: { editing in
                if !editing, let to = scrubbing { player.seek(to: to) }
                if !editing { scrubbing = nil }
              })
            Text("\(clock(player.time)) / \(clock(player.duration)) · \(Int(player.buffered)) s ahead\(player.loading ? " · loading" : "")")
              .font(.sans(.caption).monospacedDigit())
          }
        }
        HStack {
          Button("Previous", systemImage: "backward.fill") { player.previous() }
          Button(player.queue.playing ? "Pause" : "Play", systemImage: player.queue.playing ? "pause.fill" : "play.fill") { player.togglePlay() }
          Button("Next", systemImage: "forward.fill") { player.next() }
          Button("Shuffle", systemImage: player.queue.shuffle ? "shuffle.circle.fill" : "shuffle") { player.toggleShuffle() }
          Button("Repeat", systemImage: player.queue.repeatMode == .one ? "repeat.1" : "repeat") { player.cycleRepeat() }
            .foregroundStyle(player.queue.repeatMode == .off ? .secondary : .primary)
        }
        .labelStyle(.iconOnly)
        .buttonStyle(.borderless)
        if let error = player.error { Text(error).foregroundStyle(.danger) }
      }
    }

    private var playback: some View {
      Section("Playback") {
        Picker("Crossfade", selection: crossfade) {
          ForEach(PlaybackSettings.crossfades, id: \.self) { Text($0 == 0 ? "Off" : "\(Int($0)) s").tag($0) }
        }
        Toggle("Even out the volume", isOn: Bindable(player.settings).levelVolume)
        Toggle("Keep playing when the queue ends", isOn: Bindable(player.settings).autoplay)
        Toggle("Count what this device plays", isOn: Bindable(player.settings).recordPlays)
      }
    }

    private var sleep: some View {
      Section("Sleep timer") {
        HStack {
          Button("1 min") { player.sleep(minutes: 1) }
          Button("End of song") { player.sleepAtEndOfSong() }
          Button("Cancel") { player.cancelSleep() }
        }
        .buttonStyle(.borderless)
        TimelineView(.periodic(from: .now, by: 1)) { _ in
          Text(player.sleep.label() ?? "Off").foregroundStyle(.secondary)
        }
      }
    }

    private var engine: some View {
      Section("Engine") {
        TimelineView(.periodic(from: .now, by: 0.25)) { _ in
          let snapshot = player.engine.snapshot()
          VStack(alignment: .leading, spacing: 6) {
            Text("\(String(describing: snapshot.state)) · timeline \(clock(snapshot.now)) · gain \(String(format: "%.2f", player.engine.masterGain))")
            ForEach(snapshot.decks, id: \.name) { deck in
              Text(describe(deck)).font(.mono(.caption))
            }
          }
        }
      }
    }

    private var queue: some View {
      Section("Queue") {
        ForEach(player.queue.order.indices, id: \.self) { pos in
          let track = player.queue.queue[player.queue.order[pos]]
          Button {
            player.jump(to: pos)
          } label: {
            HStack {
              Text(track.title)
              Spacer()
              if pos == player.queue.pos { Image(systemName: "speaker.wave.2.fill") }
            }
          }
        }
      }
    }

    private var crossfade: Binding<Double> {
      Binding(
        get: { player.settings.crossfadeSeconds },
        set: {
          player.settings.crossfade = $0
          player.settings.transitions = $0 > 0 ? .crossfade : .off
        })
    }

    private func playAlbum() async {
      guard let id = Int(albumId) else { return }
      do {
        let album = try await client.send(API.Library.album(id: id))
        player.play(album.tracks, source: PlaySource(label: album.title, href: "/albums/\(id)"))
        failure = nil
      } catch {
        failure = error.localizedDescription
      }
    }

    private func describe(_ deck: DeckSnapshot) -> String {
      guard let title = deck.title else { return "\(deck.name): idle" }
      let start = deck.startsAt.map { "at \(clock($0))" } ?? "cued"
      let gain = 20 * log10(Double(max(deck.gain, 0.0001)))
      return "\(deck.name): \(title) \(start) · decoded \(clock(deck.decodedSeconds)) · scheduled \(clock(deck.scheduledSeconds))\(deck.finished ? " · end known" : "") · \(String(format: "%+.1f", gain)) dB"
    }

    private func clock(_ seconds: Double) -> String {
      let s = max(0, Int(seconds))
      return String(format: "%d:%02d", s / 60, s % 60)
    }
  }
#endif
