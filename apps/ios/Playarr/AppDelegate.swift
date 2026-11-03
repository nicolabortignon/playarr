import PlayarrPlayer
import UIKit

/// The app's side of downloads on the background session: the session is made at launch, so a relaunch for finished
/// downloads reconnects to it, and the system's completion handler is called once it has handed over every event.
final class AppDelegate: NSObject, UIApplicationDelegate {
  private var finishBackgroundEvents: (() -> Void)?

  func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    _ = URLSessionTransport.background
    return true
  }

  func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String, completionHandler: @escaping () -> Void) {
    guard identifier == URLSessionTransport.backgroundIdentifier else { return completionHandler() }
    finishBackgroundEvents = completionHandler
    URLSessionTransport.background.whenEventsFinish {
      Task { @MainActor [weak self] in
        self?.finishBackgroundEvents?()
        self?.finishBackgroundEvents = nil
      }
    }
  }
}
