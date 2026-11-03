import Foundation
import PlayarrAPI

/// A rendered DJ transition kept with a download, so the pair mixes offline: the server's ready answer (plan, files,
/// lead and tail) and whether it was asked at the gains even volume plays the two songs at.
public struct KeptTransition: Codable, Sendable, Equatable {
  public var answer: TransitionAnswer.Ready
  public var levelled: Bool

  public init(answer: TransitionAnswer.Ready, levelled: Bool) {
    self.answer = answer
    self.levelled = levelled
  }

  /// The server paths of its files: the transition, and B's remainder when it has one.
  public var urls: [String] { [answer.url] + (answer.continuationUrl.map { [$0] } ?? []) }

  /// Its files' names on this device, in `offline/transitions/`.
  public var fileNames: [String] { urls.map(Self.fileName) }

  /// "/transitions/ab12.flac" → "ab12.flac". The server's names are content keys (another plan, file or gain makes
  /// another name), so one name is one rendering wherever it's used.
  public static func fileName(_ url: String) -> String {
    let path = url.split(separator: "?", maxSplits: 1).first.map(String.init) ?? url
    return path.split(separator: "/").last.map(String.init) ?? path
  }
}
