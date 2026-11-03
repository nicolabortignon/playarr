import Foundation

/// What can go wrong talking to a Playarr server.
public enum APIError: Error, Equatable, Sendable, LocalizedError {
    /// The session ended (signed out elsewhere, password reset): sign in again.
    case unauthorized
    /// The server answered with an error status and its `{ error }` message.
    case server(status: Int, message: String)
    /// The server couldn't be reached.
    case offline
    /// The answer isn't what this version of the app expects.
    case decoding(String)

    public var errorDescription: String? {
        switch self {
        case .unauthorized: "You were signed out. Sign in again."
        case .server(_, let message): message
        case .offline: "Can’t reach the server. Check the address and your connection."
        case .decoding: "The server sent an answer this version of Playarr doesn’t understand."
        }
    }
}
