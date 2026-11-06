import Foundation
import Observation

/// Short messages at the top of the screen, as the web's toasts (apps/web/src/lib/toast.ts): at most three at a time,
/// gone after 3.5 s (7 s for errors). The same message twice shows once; a repeat with a button replaces the one before
/// it. A toast with a button stays until the button is used or it's dismissed, unless it has a timeout: an Undo goes
/// after 6 s (`undo(_:undo:done:)`), held while VoiceOver or the pointer is on it (`hold(_:_:)`).
@MainActor @Observable
public final class ToastCenter {
  public enum Tone: Sendable { case info, error }

  public struct Action {
    public let label: String
    public let run: @MainActor () -> Void

    public init(_ label: String, run: @escaping @MainActor () -> Void) {
      self.label = label
      self.run = run
    }
  }

  public struct Toast: Identifiable {
    public let id: Int
    public let message: String
    public let tone: Tone
    public let action: Action?
    /// With a button, it still goes by itself after this long (an Undo for something small); nil: it stays.
    public let timeout: Duration?
    /// Runs once the toast goes without its button used: a removal that waits for its Undo to pass is made then.
    let done: (@MainActor () -> Void)?
  }

  public static let infoTime: Duration = .milliseconds(3500)
  public static let errorTime: Duration = .seconds(7)
  /// How long an Undo stays: long enough to change your mind, short enough not to pile up over every Play next.
  public static let undoTime: Duration = .seconds(6)
  /// At most this many at once; older ones make way.
  public static let limit = 3

  public private(set) var toasts: [Toast] = []

  @ObservationIgnored private var nextId = 1
  @ObservationIgnored private var timers: [Int: Task<Void, Never>] = [:]
  @ObservationIgnored private let clock: any Clock<Duration>

  public init(clock: any Clock<Duration> = ContinuousClock()) {
    self.clock = clock
  }

  public func push(
    _ message: String, tone: Tone = .info, action: Action? = nil, timeout: Duration? = nil, done: (@MainActor () -> Void)? = nil
  ) {
    let same = toasts.filter { $0.message == message }
    // Every song failing for the same reason says so once. A new Undo replaces the one before it, which then can't be
    // taken back: the latest change is the one to undo.
    if !same.isEmpty, action == nil {
      done?()
      return
    }
    remove(same)
    let toast = Toast(id: nextId, message: message, tone: tone, action: action, timeout: timeout, done: done)
    nextId += 1
    let all = toasts + [toast]
    toasts = Array(all.suffix(Self.limit))
    finish(Array(all.dropLast(Self.limit)), used: nil)
    expire(toast)
  }

  /// A change made at once, with a way back for a while: "Removed “Teardrop” from the queue · Undo". `done` runs when
  /// the Undo has gone unused, for a change that waits until it can no longer be taken back.
  public func undo(_ message: String, undo: @escaping @MainActor () -> Void, done: (@MainActor () -> Void)? = nil) {
    push(message, action: Action("Undo", run: undo), timeout: Self.undoTime, done: done)
  }

  /// Takes a toast away (its time is up, or it was put off): what waited on it goes ahead.
  public func dismiss(_ id: Int) {
    remove(toasts.filter { $0.id == id })
  }

  /// The toast's button: the toast goes, and what waited on it doesn't happen.
  public func perform(_ toast: Toast) {
    guard let shown = toasts.first(where: { $0.id == toast.id }) else { return }
    remove([shown], used: shown.id)
    shown.action?.run()
  }

  /// Holds a toast with a timeout while VoiceOver or the pointer is on it, so its button can still be reached; let go,
  /// its time starts over.
  public func hold(_ id: Int, _ held: Bool) {
    guard let toast = toasts.first(where: { $0.id == id }), toast.timeout != nil else { return }
    if held {
      timers.removeValue(forKey: id)?.cancel()
    } else {
      expire(toast)
    }
  }

  private func expire(_ toast: Toast) {
    timers.removeValue(forKey: toast.id)?.cancel()
    let wait = toast.action != nil ? toast.timeout : toast.timeout ?? (toast.tone == .error ? Self.errorTime : Self.infoTime)
    guard let wait else { return }
    let id = toast.id
    timers[id] = Task { [clock, weak self] in
      do { try await clock.sleep(for: wait) } catch { return }
      self?.dismiss(id)
    }
  }

  /// Takes toasts off the screen, running what waited on each unless its button was used.
  private func remove(_ gone: [Toast], used: Int? = nil) {
    guard !gone.isEmpty else { return }
    let ids = Set(gone.map(\.id))
    toasts.removeAll { ids.contains($0.id) }
    finish(gone, used: used)
  }

  /// Toasts no longer shown: their timers stop, and what waited on them goes ahead.
  private func finish(_ gone: [Toast], used: Int?) {
    for toast in gone {
      timers.removeValue(forKey: toast.id)?.cancel()
      if toast.id != used { toast.done?() }
    }
  }
}
