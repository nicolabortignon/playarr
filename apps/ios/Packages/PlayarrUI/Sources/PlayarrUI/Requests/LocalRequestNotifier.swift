import Foundation
import PlayarrAPI
import UserNotifications

/// A request that becomes playable while the app plays in the background (it runs only then, for its audio) shows
/// as a notification; on screen, the toast says it. Permission is asked the first time the listener requests an
/// album, when the reason is plain.
@MainActor public final class LocalRequestNotifier: RequestNotifier {
  private let isActive: @MainActor () -> Bool
  private var asked = false

  /// `isActive`: the app is on screen.
  public init(isActive: @escaping @MainActor () -> Bool) {
    self.isActive = isActive
  }

  public func requested() {
    guard !asked else { return }
    asked = true
    Task { _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) }
  }

  public func landed(_ requests: [AlbumRequest]) {
    guard let text = Self.text(for: requests, active: isActive()) else { return }
    let content = UNMutableNotificationContent()
    content.body = text
    content.sound = .default
    let request = UNNotificationRequest(identifier: "requests-\(requests.map(\.mbid).joined(separator: ","))", content: content, trigger: nil)
    Task { try? await UNUserNotificationCenter.current().add(request) }
  }

  /// What the notification says, or nil when the app is on screen (the toast says it there).
  nonisolated static func text(for requests: [AlbumRequest], active: Bool) -> String? {
    active ? nil : RequestWatch.message(for: requests)
  }
}
