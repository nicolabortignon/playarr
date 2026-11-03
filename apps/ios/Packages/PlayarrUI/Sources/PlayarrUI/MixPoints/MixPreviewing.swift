import PlayarrAPI
import PlayarrPlayer

/// What Edit mix points needs of the player: a few seconds of a song from a point, and the end of the edit.
@MainActor public protocol MixPreviewing: AnyObject {
  func preview(_ track: Track, from seconds: Double, length: Double)
  func endPreviews()
}

extension Player: MixPreviewing {}
