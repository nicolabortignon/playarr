import Foundation
import PlayarrAPI

extension Demo {
  /// The demo songs' tempos and keys, near enough the records'.
  static let rhythms: [Int: (bpm: Double, key: String)] = [
    700: (80, "4A"), 701: (93, "6A"), 703: (98, "11A"), 710: (87, "8A"), 711: (85, "1A"), 800: (93, "6A"),
    801: (88, "5A"), 810: (81, "10A"),
  ]

  /// A demo song's analysis, so what keeps time with the music has a beat to keep (the accent's glide, the end of a
  /// song's last bar): a steady grid from its first beat, and its phrases' energy rising from a quiet intro to the
  /// loudest choruses, with a bridge between and an outro falling away, as songs go.
  public static func mixMap(_ track: Track) -> MixMapEntry? {
    guard let rhythm = rhythms[track.id] else { return nil }
    let beat = 60 / rhythm.bpm
    let firstBeat = 0.4
    let phrase = 16 * beat
    let phrases = Int(((track.duration - firstBeat) / phrase).rounded(.up))
    let energy = (0..<phrases).map { k -> Double? in
      let way = Double(k) / Double(max(1, phrases - 1))
      switch way {
      case ..<0.12: return 0.25 + way
      case 0.55..<0.68: return 0.4
      case 0.9...: return max(0.2, 1 - (way - 0.9) * 6)
      default: return k % 4 == 3 ? 1 : 0.7 + 0.05 * Double(k % 4)
      }
    }
    return MixMapEntry(
      version: mixMapVersion, duration: track.duration, bpm: rhythm.bpm, firstBeat: firstBeat, downbeatOffset: 0,
      downbeatConfidence: 0.9, gridStable: true, beatConfidence: 0.9, key: .init(camelot: rhythm.key, confidence: 0.8),
      introEnd: firstBeat + 2 * phrase, outroStart: track.duration - 2 * phrase, firstDrop: firstBeat + 2 * phrase,
      coldStart: false, coldEnd: false, soundStart: 0, soundEnd: track.duration - 0.5, beatsFrom: .model, phraseEnergy: energy,
      edgesStable: true)
  }

  /// The mix maps of the demo songs recorded as `recordingIds`, keyed by recording: the player's and Edit mix points'.
  public static func mixMaps(_ recordingIds: [String]) -> [String: MixMapEntry] {
    var maps: [String: MixMapEntry] = [:]
    for track in tracks where recordingIds.contains(track.recordingId) { maps[track.recordingId] = mixMap(track) }
    return maps
  }
}
