#if DEBUG
  import PlayarrAPI
  import PlayarrPlayer
  import SwiftUI

  /// Debug builds only: a "Player lab" button over the app that opens `PlayerLabView`. The player is made once, on
  /// the first tap, and kept for the app's life (the lock screen and audio session belong to one player).
  public struct PlayerLabEntry: ViewModifier {
    public typealias Lab = (player: Player, client: APIClient)
    let make: @MainActor () throws -> Lab
    @State private var lab: Lab?
    @State private var shown = false
    @State private var failure: String?

    public init(make: @escaping @MainActor () throws -> Lab) { self.make = make }

    public func body(content: Content) -> some View {
      content
        .overlay(alignment: .bottomTrailing) {
          Button("Player lab", systemImage: "waveform") { open() }
            .buttonStyle(.borderedProminent)
            .padding()
        }
        .sheet(isPresented: $shown) {
          if let lab {
            PlayerLabView(player: lab.player, client: lab.client)
          } else {
            Text(failure ?? "No account signed in")
          }
        }
    }

    private func open() {
      do {
        if lab == nil { lab = try make() }
      } catch {
        failure = error.localizedDescription
      }
      shown = true
    }
  }

  extension View {
    /// Debug builds only: the Player lab, with a player `make` builds.
    public func playerLab(_ make: @escaping @MainActor () throws -> PlayerLabEntry.Lab) -> some View {
      modifier(PlayerLabEntry(make: make))
    }

    /// Debug builds only: the Player lab, playing through the active account. Its queue, unsent plays and stream
    /// cache go in Application Support/Playarr/<server id>/<account id>/.
    public func playerLab(for model: AppModel) -> some View {
      playerLab {
        guard let account = model.store.activeAccount, let client = model.store.client(for: account),
          let media = model.store.mediaURLs(for: account)
        else { throw URLError(.userAuthenticationRequired) }
        let folder = URL.applicationSupportDirectory.appending(
          path: "Playarr/\(account.key.serverId)/\(account.key.accountId)", directoryHint: .isDirectory)
        return (try Player.live(backend: APIBackend(client: client, media: media), directory: folder), client)
      }
    }
  }
#endif
