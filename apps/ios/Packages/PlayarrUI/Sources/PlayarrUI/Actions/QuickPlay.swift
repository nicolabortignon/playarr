import Foundation
import PlayarrAPI
import PlayarrPlayer

/// What the Shortcuts actions and Siri do ("Play my Favorites", "Feeling lucky", "Start radio from the current
/// song"): the same as the buttons in the app, on the signed-in account. The App Intents in the app target call
/// these and say the error's text when one fails; Home's Feeling lucky calls it too.
@MainActor
public struct QuickPlay {
  public enum Failure: Error, Equatable, LocalizedError {
    case signedOut
    case noFavorites
    case nothingPlaying
    /// The library has nothing to pick from yet.
    case emptyLibrary
    case server(String)

    public var errorDescription: String? {
      switch self {
      case .signedOut: "Open Playarr and sign in first."
      case .noFavorites: "Nothing hearted yet."
      case .nothingPlaying: "Nothing playing."
      case .emptyLibrary: "Nothing to play yet: add some music to the library first."
      case .server(let message): message
      }
    }
  }

  let session: AccountSession?

  public init(session: AccountSession?) {
    self.session = session
  }

  /// Favorites, in order, as the Favorites page's Play.
  public func playFavorites() async throws(Failure) {
    let session = try signedIn()
    let favorites = try await ask(session) { try await $0.send(API.Favorites.list()) }
    guard !favorites.isEmpty else { throw .noFavorites }
    session.player.play(favorites.map(\.track), source: PlaySource(label: "Favorites", href: "/favorites"))
  }

  /// Home's Feeling lucky: 15 songs put together on the server now, starting from one that suits the hour.
  public func feelingLucky() async throws(Failure) {
    let session = try signedIn()
    let lucky = try await ask(session) { try await $0.send(API.Mixes.lucky()) }
    guard !lucky.tracks.isEmpty else { throw .emptyLibrary }
    session.player.play(lucky.tracks, source: PlaySource(label: "Feeling lucky · \(lucky.subtitle)", href: "/"))
  }

  /// The song playing, then songs like it ("<title> radio").
  public func startRadio() async throws(Failure) {
    let session = try signedIn()
    guard let track = session.player.queue.currentTrack else { throw .nothingPlaying }
    await session.actions.startRadio(track)
  }

  private func signedIn() throws(Failure) -> AccountSession {
    guard let session else { throw .signedOut }
    return session
  }

  private func ask<T: Sendable>(_ session: AccountSession, _ call: @Sendable (any APISending) async throws -> T) async throws(Failure) -> T {
    do {
      return try await call(session.api)
    } catch {
      throw .server(error.localizedDescription)
    }
  }
}
