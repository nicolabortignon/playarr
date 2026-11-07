import Foundation
import PlayarrPlayer
import SwiftUI

/// The sleep timer's end (plan 7 §5; docs/design.md, Moments; the web's `SleepWell`): Now Playing dims to a moon and
/// "Sleep well" for 4 seconds, then rests dark until it's touched or the music plays again. With Now Playing closed,
/// the shell's toast says it instead (`sleepWellToast`). Without the fades under Reduce Motion.
struct SleepWell: View {
  let player: Player
  @Environment(\.reducesMotion) private var reducesMotion
  @State private var moon = false
  /// A goodnight already old when Now Playing opened: it opened long after the music stopped, and isn't told.
  @State private var stale: Date?

  /// How long the moon and the words stay before the screen rests.
  static let moonFor: Duration = .seconds(4)
  /// A goodnight older than this when Now Playing opens isn't said.
  static let sleptLately: TimeInterval = 2

  var body: some View {
    let sleptAt = player.sleep.sleptAt
    let resting = sleptAt != nil && sleptAt != stale && !player.queue.playing
    ZStack {
      if resting {
        Color.ink950.opacity(0.9)
          .ignoresSafeArea()
          .transition(.opacity)
        if moon {
          VStack(spacing: 20) {
            Image(systemName: "moon")
              .font(.sans(.title2))
              .foregroundStyle(.paperDim)
              .frame(width: 56, height: 56)
              .background(Circle().fill(Color.paper.opacity(0.06)))
              .overlay(Circle().strokeBorder(.line, lineWidth: 1))
              .accessibilityHidden(true)
            Text("Sleep well").typeRole(.sectionTitle).foregroundStyle(.paper)
          }
          .transition(.opacity)
        }
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    // A touch wakes it.
    .contentShape(Rectangle())
    .onTapGesture { player.sleep.wake() }
    .allowsHitTesting(resting)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(resting ? "Sleep well" : "")
    .accessibilityHidden(!resting)
    .animation(reducesMotion ? nil : .easeInOut(duration: 1.2), value: resting)
    .animation(reducesMotion ? nil : .easeInOut(duration: 1.5), value: moon)
    .task(id: resting ? sleptAt : nil) {
      guard resting else { return moon = false }
      moon = true
      try? await Task.sleep(for: Self.moonFor)
      if !Task.isCancelled { moon = false }
    }
    .onAppear {
      guard let sleptAt, Date().timeIntervalSince(sleptAt) > Self.sleptLately else { return }
      stale = sleptAt
      player.sleep.wake()
    }
  }
}

extension View {
  /// "Sleep timer: music stopped" when the sleep timer stops the music with Now Playing closed, where `SleepWell`
  /// isn't there to say goodnight.
  func sleepWellToast(_ player: Player, nowPlaying: Bool, toasts: ToastCenter) -> some View {
    onChange(of: player.sleep.sleptAt) { _, sleptAt in
      if sleptAt != nil, !nowPlaying { toasts.push("Sleep timer: music stopped") }
    }
  }
}
