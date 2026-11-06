import SwiftUI

/// A page's actions on one line (docs/design.md, "The action row"), on the album, playlist, mix, Favorites and artist
/// pages: Play, Shuffle, the page's own action, Download and ⋯, in that order. It never wraps: where it doesn't fit,
/// Shuffle and then the page's action drop their words for icons, then the gaps close up and Play drops its icon
/// (`ActionRowCompaction`); at the largest text sizes, where even that doesn't fit, it scrolls sideways.
struct ActionRow<Action: View, More: View>: View {
  /// What's played, for VoiceOver: "Play Mezzanine", "Shuffle Mezzanine".
  let title: String
  let playState: PlayState
  let disabled: Bool
  let play: () -> Void
  let shuffle: () -> Void
  let download: DownloadButton?
  /// The ⋯ menu's name for VoiceOver ("More for Mezzanine", "Playlist actions").
  let moreLabel: String
  /// The page's own action (New mix, Request the rest): with its words, or as an icon button when `compact`.
  let action: (_ compact: Bool) -> Action
  /// The ⋯ menu's items.
  let more: () -> More

  init(
    title: String, playState: PlayState = .stopped, disabled: Bool = false, play: @escaping () -> Void,
    shuffle: @escaping () -> Void, download: DownloadButton? = nil, moreLabel: String = "",
    @ViewBuilder action: @escaping (_ compact: Bool) -> Action, @ViewBuilder more: @escaping () -> More
  ) {
    self.title = title
    self.playState = playState
    self.disabled = disabled
    self.play = play
    self.shuffle = shuffle
    self.download = download
    self.moreLabel = moreLabel
    self.action = action
    self.more = more
  }

  var body: some View {
    ViewThatFits(in: .horizontal) {
      ForEach(ActionRowCompaction.steps(hasAction: Action.self != EmptyView.self), id: \.self) { row($0) }
      // Unclipped, so Play's glow isn't cut off at the row's edges.
      ScrollView(.horizontal) { row(.all) }.scrollIndicators(.hidden).scrollClipDisabled()
    }
  }

  private func row(_ compaction: ActionRowCompaction) -> some View {
    HStack(spacing: compaction.tight ? 6 : 10) {
      Button(action: play) {
        // As wide as the widest of Play, Pause and Resume, so playing or pausing moves nothing.
        let label = SteadyLabel(
          playState.label, systemImage: playState.systemImage, among: PlayState.allCases.map { ($0.label, $0.systemImage) })
        if compaction.tight { label.labelStyle(.titleOnly) } else { label }
      }
      .buttonStyle(.pill(.primary, size: .large))
      .accessibilityLabel("\(playState.label) \(title)")
      .sensoryFeedback(.selection, trigger: playState == .playing)
      .disabled(disabled)
      shuffleButton(compact: compaction.shuffle)
        .disabled(disabled)
      action(compaction.action)
      if let download { download }
      if More.self != EmptyView.self {
        Menu(content: more) { OutlinedIcon { Image(systemName: "ellipsis") } }
          .accessibilityLabel(moreLabel)
      }
    }
  }

  @ViewBuilder private func shuffleButton(compact: Bool) -> some View {
    if compact {
      Button(action: shuffle) { Image(systemName: "shuffle") }
        .buttonStyle(.outlinedIcon)
        .accessibilityLabel("Shuffle \(title)")
    } else {
      Button(action: shuffle) { Label("Shuffle", systemImage: "shuffle") }
        .buttonStyle(.pill(.secondary, size: .large))
        .accessibilityLabel("Shuffle \(title)")
    }
  }
}

extension ActionRow where Action == EmptyView {
  /// A page with no action of its own (a playlist, Favorites, an artist).
  init(
    title: String, playState: PlayState = .stopped, disabled: Bool = false, play: @escaping () -> Void,
    shuffle: @escaping () -> Void, download: DownloadButton? = nil, moreLabel: String, @ViewBuilder more: @escaping () -> More
  ) {
    self.init(
      title: title, playState: playState, disabled: disabled, play: play, shuffle: shuffle, download: download,
      moreLabel: moreLabel, action: { _ in EmptyView() }, more: more)
  }
}

/// How far an action row has narrowed: which buttons have dropped their words for icons, and whether the gaps have
/// closed up.
struct ActionRowCompaction: Hashable, Sendable {
  var shuffle = false
  var action = false
  /// The gaps close up and Play drops its icon, keeping its word.
  var tight = false

  static let none = ActionRowCompaction()
  static let all = ActionRowCompaction(shuffle: true, action: true, tight: true)

  /// The arrangements to try, widest first: every word, then Shuffle as an icon, then the page's own action too, then
  /// the gaps closed up and Play without its icon. Play keeps its word in each.
  static func steps(hasAction: Bool) -> [ActionRowCompaction] {
    let shuffleOnly = ActionRowCompaction(shuffle: true)
    return hasAction ? [.none, shuffleOnly, ActionRowCompaction(shuffle: true, action: true), .all] : [.none, shuffleOnly, .all]
  }
}
