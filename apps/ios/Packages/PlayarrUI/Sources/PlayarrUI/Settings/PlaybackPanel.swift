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

  private var onPad: Bool {
    #if os(iOS)
      UIDevice.current.userInterfaceIdiom == .pad
    #else
      false
    #endif
  }
}
