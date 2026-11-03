/// A request on its way to the server: "Requesting", then "Looking up" once it has taken 2 s (finding an album can
/// wait on MusicBrainz, which answers about one request per second).
public enum PendingRequest: Equatable, Sendable {
  case requesting
  case lookingUp

  /// When "Requesting" becomes "Looking up".
  public static let slowAfter: Duration = .seconds(2)
}
