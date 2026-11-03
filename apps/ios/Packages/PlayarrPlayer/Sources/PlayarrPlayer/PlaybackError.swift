import Foundation

/// Why a song couldn't play, in the web's words (`reportError` in apps/web/src/player/AudioEngine.tsx).
public enum PlaybackError: Error, Sendable, Equatable {
  /// The server said why (its `{ error }`), e.g. "Unknown track file".
  case server(String)
  case keptBreakingOff
  case undecodable
  case unsupported
  case unreachable

  public var message: String {
    switch self {
    case .server(let message): message
    case .keptBreakingOff: "The song kept stopping loading: the Playarr server or the network is too busy"
    case .undecodable: "This file couldn’t be decoded: it may be damaged"
    case .unsupported: "This file format is not supported on this device"
    case .unreachable: "Cannot reach the Playarr server"
    }
  }

  /// What went wrong on this side, before asking the server.
  public enum Cause: Sendable { case network, decoding, format }

  /// As the web does: ask for the first two bytes of the file to tell the server's refusal (its message), a file
  /// that's there but broke off or won't decode, and a server out of reach.
  public static func diagnose(_ cause: Cause, probe: URLRequest, session: URLSession) async -> PlaybackError {
    var request = probe
    request.setValue("bytes=0-1", forHTTPHeaderField: "Range")
    do {
      let (data, response) = try await session.data(for: request)
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      if !(200..<300).contains(status) { return .server(serverMessage(data) ?? "Playback failed") }
      return switch cause {
      case .network: .keptBreakingOff
      case .decoding: .undecodable
      case .format: .unsupported
      }
    } catch {
      return .unreachable
    }
  }

  /// The `error` of a server's JSON answer.
  static func serverMessage(_ data: Data) -> String? {
    struct Answer: Decodable { let error: String }
    return try? JSONDecoder().decode(Answer.self, from: data).error
  }
}
