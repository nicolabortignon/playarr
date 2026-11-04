import SwiftUI

/// The keyboard shortcuts as menu commands (the app's `WindowGroup` gets `.commands { PlayarrCommands(model:) }`):
/// they show in the iPad's menu bar and in the list that appears while ⌘ is held. Text fields keep the keys they
/// use (typing "s" in Search types an s), because UIKit gives text input priority over key commands.
public struct PlayarrCommands: Commands {
  let model: AppModel

  public init(model: AppModel) {
    self.model = model
  }

  public var body: some Commands {
    CommandMenu("Playback") {
      ForEach(KeyCommand.playback, id: \.self) { command in
        button(command)
      }
    }
    CommandMenu("Go") {
      button(.search)
    }
  }

  private func button(_ command: KeyCommand) -> some View {
    Button(command.title) { perform(command) }
      .keyboardShortcut(command.key, modifiers: command.modifiers)
  }

  private func perform(_ command: KeyCommand) {
    guard let session = model.session else { return }
    KeyCommandHandler(session: session).perform(command)
  }
}
