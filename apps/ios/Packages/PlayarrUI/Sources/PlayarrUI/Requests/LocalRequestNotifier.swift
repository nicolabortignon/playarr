import Foundation
import PlayarrAPI
import UserNotifications

/// A request of the listener's own that becomes playable while the app plays in the background (it runs only then, for
/// its audio) shows as a notification, and so, for an admin, does someone's request that starts waiting for their answer;
/// on screen, the toast says it. `RequestsModel` tells it only of the account's own arrivals: an admin sees everyone's
/// requests, but hears only of theirs. Permission is asked the first time the listener requests an album, or an admin
/// answers one, when the reason is plain.
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
    post(Self.text(for: requests, active: isActive()), id: "requests-\(requests.map(\.mbid).joined(separator: ","))")
  }

  public func waiting(_ requests: [AlbumRequest]) {
    post(Self.waitingText(for: requests, active: isActive()), id: "waiting-\(requests.map(\.mbid).joined(separator: ","))")
  }

  private func post(_ text: String?, id: String) {
    guard let text else { return }
    let content = UNMutableNotificationContent()
    content.body = text
    content.sound = .default
    let request = UNNotificationRequest(identifier: id, content: content, trigger: nil)
    Task { try? await UNUserNotificationCenter.current().add(request) }
  }

  /// What the notification says of requests that landed, or nil when the app is on screen (the toast says it there).
  nonisolated static func text(for requests: [AlbumRequest], active: Bool) -> String? {
    active ? nil : RequestWatch.message(for: requests)
  }

  /// What it says of requests waiting for an admin's answer ("Sam asked for “Heligoland”"), or nil on screen.
  nonisolated static func waitingText(for requests: [AlbumRequest], active: Bool) -> String? {
    active ? nil : RequestWatch.waitingMessage(for: requests)
  }
}
