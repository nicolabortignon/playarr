import Foundation
import PlayarrAPI

/// How the next song joins the one playing with DJ mix, from what's known: the server's answer, the transition's file
/// once downloaded, and the two songs' mix maps. As `prepareBridge` and `joinInto` in the web's AudioEngine.tsx, with
/// what a native engine adds: a fade or a quick mix the server planned but hasn't made in time is played live from
/// its plan (the web could only cut), B resampled for a quick mix's stretch. A long blend needs the server's file (its
/// stretch of up to 8% over half a minute would be heard as pitch): without it, a cut on the beat.
public enum DJJoin {
  /// A mix this close to where A is now is left alone: there's no time to place it.
  public static let minLead = 0.5
  /// A ready transition survives a seek that lands this long before its mix point (`READY_LEAD_S`).
  public static let readyLead = 1.0
  /// The most a quick mix played live stretches B (the planner's 2%, with room for rounding).
  public static let liveStretch = 0.021

  public struct Context: Sendable {
    public var result: TransitionPlanner.Result?
    /// The ready transition's file on this device, once downloaded.
    public var file: URL?
    public var a: MixMapEntry?
    public var b: MixMapEntry?
    public var mode: MixMode
    public var sameAlbumInOrder: Bool
    public var aDuration: Double
    /// Where A is now (seconds).
    public var position: Double
    /// The gains (dB) the songs play at.
    public var gainA: Double
    public var gainB: Double

    public init(
      result: TransitionPlanner.Result?, file: URL?, a: MixMapEntry?, b: MixMapEntry?, mode: MixMode, sameAlbumInOrder: Bool,
      aDuration: Double, position: Double, gainA: Double, gainB: Double
    ) {
      self.result = result
      self.file = file
      self.a = a
      self.b = b
      self.mode = mode
      self.sameAlbumInOrder = sameAlbumInOrder
      self.aDuration = aDuration
      self.position = position
      self.gainA = gainA
      self.gainB = gainB
    }
  }

  /// The join, and the server's rest of B to play after a transition (an MP3's), if any.
  public static func decide(_ c: Context) -> (join: Join, continuation: EngineItem.Continuation?) {
    if case .answer(.ready(let ready))? = c.result, let file = c.file, c.position < ready.plan.aStart - readyLead {
      // Only a FLAC rest streams as it downloads; a WAV one (a server without an encoder) would have to come whole.
      let rest = ready.continuationUrl.flatMap { url -> EngineItem.Continuation? in
        guard url.lowercased().hasSuffix(".flac") else { return nil }
        return EngineItem.Continuation(url: url, from: ready.plan.bResume, gainDb: c.gainB - (ready.levels?.b ?? 0))
      }
      return (.transition(TransitionJoin(ready, file: file, gainA: c.gainA, gainB: c.gainB)), rest)
    }
    if let plan = c.result?.plan {
      switch plan.style {
      case .straight:
        // Straight on is where the server says the songs' sounds end and start: a cut there, or gapless.
        guard let cut = MixSequence.straightCut(plan, aDuration: c.aDuration), cut.aEnd > c.position + minLead else {
          return (.crossfade(seconds: 0), nil)
        }
        return (.cut(cut), nil)
      case .fade where plan.aStart > c.position + minLead:
        return (.mix(plan), nil)
      case .quick where plan.aStart > c.position + minLead && plan.bRate.allSatisfy({ abs($0.value - 1) <= liveStretch }):
        return (.mix(plan), nil)
      default:
        break
      }
    }
    return (beatCut(c).map { .cut($0) } ?? .crossfade(seconds: 0), nil)
  }

  /// No mix to play: a cut on the beat, else one that leaves out the silence between the songs (both need maps).
  static func beatCut(_ c: Context) -> BeatCut? {
    guard let a = c.a, let b = c.b else { return nil }
    let cut =
      MixSequence.beatCut(a, b, aDuration: c.aDuration, mode: c.mode, sameAlbumInOrder: c.sameAlbumInOrder)
      ?? MixSequence.silenceCut(a, b, aDuration: c.aDuration, mode: c.mode, sameAlbumInOrder: c.sameAlbumInOrder)
    guard let cut, cut.aEnd > c.position + minLead else { return nil }
    return cut
  }
}

extension DJJoin {
  /// The queue plays `a`'s album (or its artist's albums, which come whole and in order): there, songs of the album
  /// in order are heard as one. Elsewhere (a playlist, a mix) they only happen to be in order (`playsAlbum`, decks.ts).
  public static func playsAlbum(_ source: PlaySource?, _ a: Track) -> Bool {
    guard let source else { return true }
    return source.href == "/albums/\(a.albumId)" || source.href == "/artists/\(a.artistId)"
  }
}
