import SwiftUI
#if canImport(UIKit)
  import UIKit
#endif

/// Settings → Appearance, for this device (apps/web/src/components/AppearancePanel.tsx); read-only when an admin has
/// locked it for this account.
struct AppearancePanel: View {
  @Bindable var appearance: AppearanceSettings
  var locked = false

  var body: some View {
    Form {
      if locked { LockedNotice(panel: "Appearance") }
      Group { settings }.disabled(locked)
    }
    .navigationTitle("Appearance")
  }

  @ViewBuilder private var settings: some View {
      Section {
        HStack(spacing: 12) {
          ForEach(AppearanceSettings.Accent.all, id: \.self) { accent in
            swatch(accent)
          }
        }
        .padding(.vertical, 4)
      } header: {
        Text("Accent color")
      } footer: {
        Text(appearance.accent == .album ? "From the album art: the color follows the song playing." : "\(appearance.accent.name), whatever is playing.")
      }
      Section {
        Picker("Motion", selection: $appearance.motion) {
          ForEach(AppearanceSettings.Motion.allCases, id: \.self) { Text($0.label).tag($0) }
        }
        .pickerStyle(.segmented)
      } header: {
        Text("Motion")
      } footer: {
        Text("System follows this device’s setting for reduced motion. Reduced keeps animations to a minimum; Full always plays them.")
      }
      Section("Audio format") {
        Toggle(isOn: $appearance.formatBadges) {
          Text("Show audio format badges")
          Text("The FLAC, MP3 and Hi-Res labels in the player, Now Playing, the queue and on albums.")
        }
      }
      #if os(iOS)
        if UIDevice.current.userInterfaceIdiom == .phone {
          Section("Held sideways") {
            Toggle(isOn: $appearance.turnToOpen) {
              Text("Turn to open Now Playing")
              Text("Turning the phone on its side with a song queued opens Now Playing, with the cover beside the songs, rather than turning the page you’re on.")
            }
            Toggle(isOn: $appearance.keepScreenOnSideways) {
              Text("Keep the screen on while charging")
              Text("While Now Playing is sideways and the phone charges, as in a stand on a desk or in the car.")
            }
          }
        }
      #endif
      Section("For the curious") {
        Toggle(isOn: $appearance.statsForNerds) {
          Text("Stats for nerds")
          Text("An overlay with everything Playarr knows about the song playing: its tempo, key and beat grid as it plays, intro, outro and drop, loudness and the gain applied, the stream and its buffer, and the next transition.")
        }
      }
  }

  private func swatch(_ accent: AppearanceSettings.Accent) -> some View {
    let chosen = appearance.accent == accent
    return Button { appearance.accent = accent } label: {
      Group {
        switch accent {
        case .album:
          RoundedRectangle(cornerRadius: Radius.tile).fill(
            LinearGradient(colors: [RGB(hex: 0xff7a1a).color, RGB(hex: 0xf43f5e).color, RGB(hex: 0xa78bfa).color, RGB(hex: 0x38bdf8).color], startPoint: .topLeading, endPoint: .bottomTrailing))
        case .fixed(let color):
          Circle().fill(color.rgb.color)
        }
      }
      .frame(width: 36, height: 36)
      .overlay { if chosen { Image(systemName: "checkmark").font(.footnote.weight(.bold)).foregroundStyle(.black) } }
    }
    .buttonStyle(.plain)
    .accessibilityLabel(accent.name)
    .accessibilityAddTraits(chosen ? [.isButton, .isSelected] : .isButton)
  }
}
