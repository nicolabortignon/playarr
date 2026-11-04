/// How the player bar shows the app's own volume (apps/web/src/components/PlayerBar.tsx `Volume`): what the speaker
/// icon is, what the mute button says and what VoiceOver reads for the slider. It's the app's volume, under the
/// device's: Even volume and the limiter work before it.
public struct VolumeDisplay: Equatable, Sendable {
  public let volume: Double
  public let muted: Bool

  public init(volume: Double, muted: Bool) {
    self.volume = volume
    self.muted = muted
  }

  /// What the slider shows: nothing while muted.
  public var shown: Double { muted ? 0 : volume }

  public var systemImage: String {
    if muted || volume == 0 { return "speaker.slash.fill" }
    return volume < 0.5 ? "speaker.wave.1.fill" : "speaker.wave.2.fill"
  }

  public var muteLabel: String { muted ? "Unmute" : "Mute" }

  /// "40%".
  public var valueText: String { "\(Int((shown * 100).rounded()))%" }
}
