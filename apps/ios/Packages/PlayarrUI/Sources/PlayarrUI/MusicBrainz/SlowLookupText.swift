import PlayarrAPI

/// The words that explain a MusicBrainz wait (SlowLookup, and the sidebar's queue indicator).
public enum SlowLookupText {
  /// A lookup is only explained once it has taken this long.
  public static let after: Duration = .milliseconds(1500)

  /// "Asking MusicBrainz for this artist’s albums. It answers about one request per second."
  public static func waiting(for what: String, status: MusicBrainzStatus?) -> String {
    let start = "Asking MusicBrainz for \(what). It answers about one request per second"
    guard let status, status.background > 0, status.queued > 1 else { return start + "." }
    return start + ", and Playarr is also identifying your folder music, so there’s a line: about \(Format.wait(status.etaSeconds)) to go."
  }

  /// The indicator's detail: "3 queued".
  public static func queued(_ status: MusicBrainzStatus) -> String { "\(status.queued) queued" }

  /// The indicator's longer explanation (the web's tooltip, here its accessibility hint).
  public static func explanation(_ status: MusicBrainzStatus) -> String {
    let start = "About \(Format.wait(status.etaSeconds)) of MusicBrainz lookups waiting (it answers about once a second)"
    return status.background > 0 ? start + "; \(status.background) of them identifying your folder music" : start
  }
}
