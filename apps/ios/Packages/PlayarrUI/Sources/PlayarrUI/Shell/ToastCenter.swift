import Foundation
import Observation

/// Short messages at the top of the screen, as the web's toasts (apps/web/src/lib/toast.ts): the same message twice
/// shows once, at most three at a time, gone after 3.5 s (7 s for errors). A toast with a button (Undo) stays until
/// the button is used or it's dismissed.
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
  }

  public static let infoTime: Duration = .milliseconds(3500)
  public static let errorTime: Duration = .seconds(7)

  public private(set) var toasts: [Toast] = []

  @ObservationIgnored private var nextId = 1
  @ObservationIgnored private let clock: any Clock<Duration>

  public init(clock: any Clock<Duration> = ContinuousClock()) {
    self.clock = clock
  }

  public func push(_ message: String, tone: Tone = .info, action: Action? = nil) {
    // Every song failing for the same reason says so once.
    guard !toasts.contains(where: { $0.message == message }) else { return }
    let id = nextId
    nextId += 1
    toasts = Array((toasts + [Toast(id: id, message: message, tone: tone, action: action)]).suffix(3))
    guard action == nil else { return }
    let wait = tone == .error ? Self.errorTime : Self.infoTime
    Task { [clock, weak self] in
      try? await clock.sleep(for: wait)
      self?.dismiss(id)
    }
  }

  public func dismiss(_ id: Int) {
    toasts.removeAll { $0.id == id }
  }

  /// The toast's button: dismiss it and do what it says.
  public func perform(_ toast: Toast) {
    dismiss(toast.id)
    toast.action?.run()
  }
}
