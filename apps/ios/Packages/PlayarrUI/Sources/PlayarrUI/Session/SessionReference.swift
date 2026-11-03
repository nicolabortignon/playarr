/// A weak way back to a session from something made before it (the player's lock-screen like command).
@MainActor
final class SessionReference {
  weak var session: AccountSession?
}
