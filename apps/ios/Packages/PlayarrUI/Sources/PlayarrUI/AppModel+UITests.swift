import Foundation
import PlayarrAPI

extension AppModel {
  /// The dev server's address and a session token, from a UI test (XCUIApplication.launchEnvironment).
  public static let uiTestServerKey = "PLAYARR_UITEST_SERVER"
  public static let uiTestTokenKey = "PLAYARR_UITEST_TOKEN"

  /// UI tests sign in on the dev server themselves and hand the app the session's token: the account joins
  /// this model's store as if it had signed in here. With `-UITests` that store is empty and keeps nothing.
  /// Without both keys, or when the server doesn't accept the token, nothing changes (the UI test then fails
  /// on the screen it expects).
  public func signInForUITests(environment: [String: String] = ProcessInfo.processInfo.environment, session: URLSession = .shared) async {
    guard let server = environment[Self.uiTestServerKey].flatMap(URL.init(string:)), let token = environment[Self.uiTestTokenKey] else { return }
    do {
      let info = try await store.anonymousClient(for: server).send(API.Server.info())
      let me = try await APIClient(baseURL: server, token: token, session: session).send(API.Auth.me())
      try store.signedIn(SignInResponse(token: token, account: me), server: info, at: server)
    } catch {
      return
    }
  }
}
