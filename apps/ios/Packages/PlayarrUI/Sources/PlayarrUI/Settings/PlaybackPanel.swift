import PlayarrPlayer
import SwiftUI
#if canImport(UIKit)
  import UIKit
#endif

/// Settings → Playback, for this device (apps/web/src/components/PlaybackPanel.tsx); read-only when an admin has locked
/// it for this account. The engine can fade on a phone, so Crossfade is offered here, unlike the web on an iPhone.
struct PlaybackPanel: View {
  @Bindable var settings: PlaybackSettings
  var downloads: DownloadStore?
  var openDownloads: () -> Void = {}
  /// An admin has stopped this account from changing Playback: read-only.
  var locked = false
  /// Keyboard shortcuts are listed only while a keyboard is attached.
  @State private var keyboard = HardwareKeyboard()

  var body: some View {
    let panel = PlaybackPanelModel(settings: settings)
    Form {
      if locked { LockedNotice(panel: "Playback") }
      // This device's space and downloads stay the listener's to manage.
      Group {
        Section("Playing") {
          Toggle(isOn: $settings.autoplay) {
            Text("Keep playing when the queue ends")
            Text("Carries on with songs from your library like the last ones you heard.")
          }
          Toggle(isOn: $settings.recordPlays) {
            Text("Count what this device plays")
            Text("Off for a party speaker or a guest’s phone: what plays here won’t shape everyone’s mixes.")
          }
        }
        Section {
          Toggle(isOn: $settings.levelVolume) {
            Text("Even out the volume")
            Text("Every song plays as loud as the next (−14 LUFS, as streaming services do): loud ones turned down, quiet ones up as far as they can go. An album played in order keeps its own quiet and loud songs. Songs are leveled once Settings → Analysis has measured their loudness.")
          }
          Picker("Transitions", selection: Binding(get: { settings.transitions }, set: { panel.choose($0) })) {
            Text("Off").tag(PlaybackSettings.Transitions.off)
            Text("Crossfade").tag(PlaybackSettings.Transitions.crossfade)
            Text("DJ mix").tag(PlaybackSettings.Transitions.dj)
          }
          .pickerStyle(.segmented)
          if settings.transitions != .off {
            Picker(settings.transitions == .crossfade ? "Crossfade length" : "Fade length", selection: $settings.crossfade) {
              ForEach(PlaybackPanelModel.lengths, id: \.self) { Text("\(Int($0)) s").tag($0) }
            }
            .pickerStyle(.segmented)
          }
        } header: {
          Text("Sound")
        } footer: {
          switch settings.transitions {
          case .off: Text("Songs always follow each other without a gap.")
          case .crossfade: Text("Fades each song into the next. Never between songs of an album played in order.")
          case .dj: Text("Songs are mixed like a DJ would, when their beats allow: long blends, quick mixes or straight on. Songs that can’t be mixed on the beat fade into each other for this long. How many songs are ready for DJ mix: Settings → Analysis.")
          }
        }
        Section {
          Picker("Streaming", selection: $settings.streaming) {
            Text("Automatic").tag(StreamingChoice.automatic)
            Text("Original").tag(StreamingChoice.original)
            Text("High").tag(StreamingChoice.high)
            Text("Normal").tag(StreamingChoice.normal)
            Text("Low").tag(StreamingChoice.low)
          }
          Picker("Downloads", selection: downloadQuality) { qualities }
        } header: {
          Text("Quality")
        } footer: {
          Text("Automatic plays each song at the best quality your connection keeps up with, measured as songs arrive, on Wi-Fi or mobile data alike: when the music stops to wait for a song, it goes on a quality lower. In Low Data Mode it goes no higher than Normal. Original streams each song’s own file as it is: lossless takes 300 MB an hour or more. The others stream it made smaller on the server as it plays: High at 256 kbps, about 120 MB an hour and hard to tell from the original; Normal at 128 kbps, about 60 MB; Low at 64 kbps, about 30 MB, for a poor connection. A file already that small plays as it is. Choose a better quality for downloads and those downloaded below it are fetched again.")
        }
      }
      .disabled(locked)
      if let downloads {
        OfflineStorageSection(store: downloads, openDownloads: openDownloads)
      }
      if HardwareKeyboard.showsShortcuts(onPad: onPad, attached: keyboard.attached) { KeyboardShortcutsSection() }
    }
    .navigationTitle("Playback")
    .onReceive(NotificationCenter.default.publisher(for: HardwareKeyboard.changes[0])) { _ in keyboard.recheck() }
    .onReceive(NotificationCenter.default.publisher(for: HardwareKeyboard.changes[1])) { _ in keyboard.recheck() }
  }

  @ViewBuilder private var qualities: some View {
    Text("Original").tag(StreamQuality.original)
    Text("High").tag(StreamQuality.high)
    Text("Normal").tag(StreamQuality.normal)
  }

  /// Downloads' quality goes through the store, which fetches again the songs kept below a better one.
  private var downloadQuality: Binding<StreamQuality> {
    Binding(
      get: { settings.downloadQuality },
      set: { quality in
        if let downloads { downloads.downloadQuality = quality } else { settings.downloadQuality = quality }
      })
  }

  private var onPad: Bool {
    #if os(iOS)
      UIDevice.current.userInterfaceIdiom == .pad
    #else
      false
    #endif
  }
}
