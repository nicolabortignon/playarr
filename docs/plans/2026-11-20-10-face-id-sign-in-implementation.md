# Face ID sign-in: implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task.

**Goal:** when an iOS account's session ends, sign in again with Face ID using the password kept in the Keychain behind biometrics ([design](2026-11-20-10-face-id-sign-in.md)).

**Architecture:**
- `PlayarrAPI` gets a `PasswordVault`, a Keychain one and an in-memory one, which `ServerStore` holds beside its `SecretStore`.
- `PlayarrUI` gets `Biometrics`, a closure saying what the device has set up, which `AppModel` holds.
- `AppModel` offers to keep the password after a typed one succeeds. `RootView` asks the question, because the sign-in screen goes away as the account signs in.
- `AddServerModel` signs in with the kept password and handles each failure.
- `SignInView` leads with the Face ID button, and the Accounts panel can forget the password.

**Tech stack:** Swift 6, SwiftUI, Security (`SecAccessControl`, `.biometryCurrentSet`), LocalAuthentication, Swift Testing. No server change.

**Read first:** [ios/conventions.md](../ios/conventions.md). Match each file's indentation: `PlayarrAPI` and the sign-in files use 4 spaces, the rest of `PlayarrUI` uses 2. `pnpm` is `corepack pnpm`. `swift test` needs `--disable-sandbox`. Run from `apps/ios`.

**Changes from the design** (fold them into the design doc in Task 10):
1. The question is asked as the app opens (`RootView`), not before it.
2. A typed sign-in for an account that already has Face ID on replaces the kept password silently, since the typed one is the one that works.
3. Only `errSecItemNotFound` counts as gone. `errSecAuthFailed` keeps the password, because a failed match can report it. A password iOS invalidated without deleting is then fixed by the next typed sign-in, which replaces it (change 2).
4. No screen-tour shot. The sign-in screen needs a reachable server first, and the demo isn't one. The device checklist covers it.

---

### Task 1: `PasswordVault` and the in-memory vault

**Files:**
- Create: `Packages/PlayarrAPI/Sources/PlayarrAPI/PasswordVault.swift`
- Create: `Packages/PlayarrAPI/Sources/PlayarrAPI/InMemoryPasswordVault.swift`
- Test: `Packages/PlayarrAPI/Tests/PlayarrAPITests/PasswordVaultTests.swift`

**Step 1: write the failing test**

```swift
import Foundation
import Testing
@testable import PlayarrAPI

@Suite struct PasswordVaultTests {
    @Test func keepsReadsAndRemovesAPassword() async throws {
        let vault = InMemoryPasswordVault()
        #expect(!vault.hasPassword(for: "srv-1:2"))
        #expect(await vault.password(for: "srv-1:2", reason: "Sign in to Home") == .gone)

        try vault.save("first", for: "srv-1:2")
        try vault.save("second", for: "srv-1:2")
        #expect(vault.hasPassword(for: "srv-1:2"))
        #expect(await vault.password(for: "srv-1:2", reason: "Sign in to Home") == .password("second"))

        vault.face = .cancels
        #expect(await vault.password(for: "srv-1:2", reason: "Sign in to Home") == .cancelled)
        #expect(vault.hasPassword(for: "srv-1:2"))

        try vault.remove(for: "srv-1:2")
        #expect(!vault.hasPassword(for: "srv-1:2"))
    }
}
```

**Step 2: run it and see it fail**

Run: `swift test --disable-sandbox --package-path Packages/PlayarrAPI --filter PasswordVaultTests`
Expected: a build failure, `cannot find 'InMemoryPasswordVault' in scope`.

**Step 3: implement**

`PasswordVault.swift`:

```swift
/// Passwords kept to sign in again with Face ID (plan 10): the Keychain behind biometrics in the app, memory in tests
/// and previews. Keyed like tokens, "<serverId>:<accountId>" (`AccountKey.keychainAccount`).
public protocol PasswordVault: Sendable {
    /// Whether a password is kept for the account, without asking for Face ID.
    func hasPassword(for key: String) -> Bool
    /// Keeps the password, replacing one kept before. Asks for nothing.
    func save(_ password: String, for key: String) throws
    /// Asks for Face ID (`reason` shows under Touch ID), then gives the password.
    func password(for key: String, reason: String) async -> PasswordRead
    func remove(for key: String) throws
}

/// What reading a kept password came to.
public enum PasswordRead: Equatable, Sendable {
    case password(String)
    /// Face ID was cancelled, didn't match or can't be asked now: the password stays.
    case cancelled
    /// Nothing is kept, or iOS dropped it (a face enrolled, the passcode removed).
    case gone
}
```

`InMemoryPasswordVault.swift`:

```swift
import Synchronization

/// Passwords in memory, for tests and previews. `face` says whether the next read matches or is cancelled.
public final class InMemoryPasswordVault: PasswordVault {
    public enum Face: Sendable { case matches, cancels }

    private struct State {
        var passwords: [String: String]
        var face: Face
    }

    private let state: Mutex<State>

    public init(_ passwords: [String: String] = [:], face: Face = .matches) {
        state = Mutex(State(passwords: passwords, face: face))
    }

    public var face: Face {
        get { state.withLock { $0.face } }
        set { state.withLock { $0.face = newValue } }
    }

    public func hasPassword(for key: String) -> Bool {
        state.withLock { $0.passwords[key] != nil }
    }

    public func save(_ password: String, for key: String) throws {
        state.withLock { $0.passwords[key] = password }
    }

    public func password(for key: String, reason: String) async -> PasswordRead {
        state.withLock { state in
            guard let password = state.passwords[key] else { return .gone }
            return state.face == .matches ? .password(password) : .cancelled
        }
    }

    public func remove(for key: String) throws {
        _ = state.withLock { $0.passwords.removeValue(forKey: key) }
    }
}
```

**Step 4: run it and see it pass**

Run the command from Step 2. Expected: `Test run with 1 test passed`.

**Step 5: commit**

```bash
git add Packages/PlayarrAPI/Sources/PlayarrAPI/PasswordVault.swift Packages/PlayarrAPI/Sources/PlayarrAPI/InMemoryPasswordVault.swift Packages/PlayarrAPI/Tests/PlayarrAPITests/PasswordVaultTests.swift
git commit -m "iOS: PasswordVault, where passwords to sign in again with Face ID are kept (plan 10), and one in memory for tests"
```

---

### Task 2: `KeychainPasswordVault`

**Files:**
- Create: `Packages/PlayarrAPI/Sources/PlayarrAPI/KeychainPasswordVault.swift`
- Test: `Packages/PlayarrAPI/Tests/PlayarrAPITests/PasswordVaultTests.swift` (add to it)

`swift test` runs on the Mac without the data-protection Keychain's entitlement, so saving behind biometrics can't be tested there. Test what a status means, and that an unknown key has nothing kept. The real Keychain is checked on a device (Task 10).

**Step 1: write the failing test** (add to `PasswordVaultTests`)

```swift
    @Test func readsAKeychainStatusAsAPasswordACancelOrNothing() {
        #expect(KeychainPasswordVault.read(status: errSecSuccess, data: Data("pw".utf8)) == .password("pw"))
        #expect(KeychainPasswordVault.read(status: errSecSuccess, data: nil) == .gone)
        #expect(KeychainPasswordVault.read(status: errSecItemNotFound, data: nil) == .gone)
        #expect(KeychainPasswordVault.read(status: errSecUserCanceled, data: nil) == .cancelled)
        #expect(KeychainPasswordVault.read(status: errSecAuthFailed, data: nil) == .cancelled)
        #expect(KeychainPasswordVault.read(status: errSecInteractionNotAllowed, data: nil) == .cancelled)
    }

    @Test func hasNothingKeptForAnAccountItNeverSaw() {
        #expect(!KeychainPasswordVault().hasPassword(for: "test-\(UUID().uuidString):1"))
    }
```

**Step 2: run it and see it fail**

Same command. Expected: `cannot find 'KeychainPasswordVault' in scope`.

**Step 3: implement**

```swift
import Foundation
import LocalAuthentication
import Security

/// Passwords in the Keychain behind biometrics: generic passwords under `service`, one per server and account, that
/// only a match with the faces or fingers enrolled now opens, on this device only (not in backups or iCloud Keychain).
/// Enrolling another face or removing the passcode makes iOS drop them.
public struct KeychainPasswordVault: PasswordVault {
    public static let service = "me.tracklistme.playarr.password"

    public init() {}

    public func hasPassword(for key: String) -> Bool {
        // Attributes only, never a prompt: an item behind biometrics answers errSecInteractionNotAllowed then.
        let context = LAContext()
        context.interactionNotAllowed = true
        var query = Self.query(key)
        query[kSecReturnAttributes as String] = true
        query[kSecUseAuthenticationContext as String] = context
        let status = SecItemCopyMatching(query as CFDictionary, nil)
        return status == errSecSuccess || status == errSecInteractionNotAllowed
    }

    public func save(_ password: String, for key: String) throws {
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .biometryCurrentSet, nil) else {
            throw KeychainError(status: errSecParam)
        }
        // Removed and added again: updating an item behind biometrics would ask for Face ID.
        try remove(for: key)
        var item = Self.query(key)
        item[kSecValueData as String] = Data(password.utf8)
        item[kSecAttrAccessControl as String] = access
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    public func password(for key: String, reason: String) async -> PasswordRead {
        // SecItemCopyMatching waits for Face ID: off the main actor.
        await Task.detached {
            let context = LAContext()
            context.localizedReason = reason
            var query = Self.query(key)
            query[kSecReturnData as String] = true
            query[kSecMatchLimit as String] = kSecMatchLimitOne
            query[kSecUseAuthenticationContext as String] = context
            var item: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &item)
            if status != errSecSuccess { Log.auth.notice("Face ID sign-in: the Keychain answered \(status)") }
            return Self.read(status: status, data: item as? Data)
        }.value
    }

    public func remove(for key: String) throws {
        let status = SecItemDelete(Self.query(key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
    }

    /// What a read's status means. Only "not found" is gone: a failed match can answer errSecAuthFailed, and a password
    /// that's kept but can't be opened is replaced by the next typed sign-in.
    static func read(status: OSStatus, data: Data?) -> PasswordRead {
        switch status {
        case errSecSuccess: data.map { .password(String(decoding: $0, as: UTF8.self)) } ?? .gone
        case errSecItemNotFound: .gone
        default: .cancelled
        }
    }

    private static func query(_ key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecUseDataProtectionKeychain as String: true,
        ]
    }
}
```

**Step 4: run it and see it pass.** Expected: 3 tests passed.

**Step 5: commit**

```bash
git add Packages/PlayarrAPI/Sources/PlayarrAPI/KeychainPasswordVault.swift Packages/PlayarrAPI/Tests/PlayarrAPITests/PasswordVaultTests.swift
git commit -m "iOS: KeychainPasswordVault keeps passwords behind Face ID, on this device only (plan 10)"
```

---

### Task 3: `ServerStore` holds the vault; Sign out forgets the password

**Files:**
- Modify: `Packages/PlayarrAPI/Sources/PlayarrAPI/ServerStore.swift` (the properties, `init`, `live()`, `signOut`)
- Test: `Packages/PlayarrAPI/Tests/PlayarrAPITests/ServerStoreTests.swift`

**Step 1: write the failing test** (in `ServerStoreTests`)

```swift
    @Test func signingOutForgetsTheFaceIDPasswordAndAnEndedSessionKeepsIt() async throws {
        let passwords = InMemoryPasswordVault()
        let store = ServerStore(directory: directory, secrets: secrets, passwords: passwords)
        let url = URL(string: "http://\(uniqueHost())")!
        try store.signedIn(SignInResponse(token: "tok-1", account: account(1, "Nicola")), server: home, at: url)
        try store.signedIn(SignInResponse(token: "tok-2", account: account(2, "Sam")), server: home, at: url)
        try passwords.save("one", for: "srv-1:1")
        try passwords.save("two", for: "srv-1:2")

        store.markSignedOut(AccountKey(serverId: "srv-1", accountId: 1))
        await store.signOut(AccountKey(serverId: "srv-1", accountId: 2))

        #expect(passwords.hasPassword(for: "srv-1:1"))
        #expect(!passwords.hasPassword(for: "srv-1:2"))
    }
```

**Step 2: run it and see it fail**

Run: `swift test --disable-sandbox --package-path Packages/PlayarrAPI --filter ServerStoreTests`
Expected: `extra argument 'passwords' in call`.

**Step 3: implement**

- Add the property beside `secrets`:
  ```swift
  /// Passwords kept to sign in again with Face ID (plan 10).
  @ObservationIgnored public let passwords: any PasswordVault
  ```
- In `init`, add `passwords: any PasswordVault = InMemoryPasswordVault()` after `secrets:`, and set `self.passwords = passwords`.
- In `live()`, add `passwords: KeychainPasswordVault()`.
- In `signOut(_:)`, after `try? secrets.removeToken(for: key.keychainAccount)`, add `try? passwords.remove(for: key.keychainAccount)`. Leave `markSignedOut` alone. Add to `signOut`'s doc comment: "and the password kept for Face ID".

**Step 4: run it and see it pass.** Expected: every `ServerStoreTests` test passes.

**Step 5: commit**

```bash
git add Packages/PlayarrAPI
git commit -m "iOS: the server store keeps passwords for Face ID in the Keychain; Sign out forgets the account's, an ended session keeps it (plan 10)"
```

---

### Task 4: `Biometrics`, held by `AppModel`

**Files:**
- Create: `Packages/PlayarrUI/Sources/PlayarrUI/Session/Biometrics.swift`
- Modify: `Packages/PlayarrUI/Sources/PlayarrUI/AppModel.swift` (properties, `init`, `live()`)

**Step 1: implement.** This is wiring only; Task 5 tests it.

```swift
import Foundation
import LocalAuthentication

/// The biometrics this device has set up: what to call them and their symbol (plan 10).
public enum Biometry: Sendable, Equatable {
  case faceID, touchID, opticID

  public var name: String {
    switch self {
    case .faceID: "Face ID"
    case .touchID: "Touch ID"
    case .opticID: "Optic ID"
    }
  }

  public var symbol: String {
    switch self {
    case .faceID: "faceid"
    case .touchID: "touchid"
    case .opticID: "opticid"
    }
  }
}

/// Asks which biometrics are set up now (that can change while the app runs). Live in the app, fixed in tests, and
/// unavailable in the demo and UI tests, so they never offer Face ID.
public struct Biometrics: Sendable {
  public let current: @Sendable () -> Biometry?

  public init(current: @escaping @Sendable () -> Biometry?) {
    self.current = current
  }

  public static let unavailable = Biometrics { nil }

  public static func fixed(_ biometry: Biometry) -> Biometrics { Biometrics { biometry } }

  public static let live = Biometrics {
    let context = LAContext()
    guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil) else { return nil }
    return switch context.biometryType {
    case .faceID: .faceID
    case .touchID: .touchID
    case .opticID: .opticID
    default: nil
    }
  }
}
```

In `AppModel`:
- add `public let biometrics: Biometrics` beside `appearance`;
- add the `init` parameter `biometrics: Biometrics = .unavailable` after `appearance:` and set it;
- in `live()`, pass `biometrics: .live`.

`empty()` and `demo()` keep the default.

**Step 2: build**

Run: `swift build --disable-sandbox --package-path Packages/PlayarrUI`
Expected: `Build complete!`

**Step 3: commit**

```bash
git add Packages/PlayarrUI/Sources/PlayarrUI/Session/Biometrics.swift Packages/PlayarrUI/Sources/PlayarrUI/AppModel.swift
git commit -m "iOS: Biometrics says whether the device has Face ID, Touch ID or Optic ID set up (plan 10)"
```

---

### Task 5: offering Face ID after a typed password

**Files:**
- Modify: `Packages/PlayarrUI/Sources/PlayarrUI/AppModel.swift`: `FaceIDOffer`, `faceIDOffer`, `offerFaceID(_:for:)`, `answerFaceIDOffer(use:)`
- Modify: `Packages/PlayarrUI/Sources/PlayarrUI/SignIn/AddServerModel.swift`: `finish` takes the password
- Test: create `Packages/PlayarrUI/Tests/PlayarrUITests/FaceIDSignInTests.swift`

**Step 1: write the failing tests**

```swift
import Foundation
import PlayarrAPI
import Synchronization
import Testing
@testable import PlayarrUI

/// What the fake server answers to a sign-in, and the passwords it was sent.
final class SignInAnswers: Sendable {
  static let sam = #"{"token":"tok","account":{"id":2,"username":"sam","name":"Sam","role":"member","canRequest":false,"sources":null,"hasPassword":true}}"#
  let answer = Mutex<(Int, String)>((200, SignInAnswers.sam))
  let passwords = Mutex<[String]>([])

  func record(_ request: URLRequest) {
    var body = request.httpBody ?? Data()
    if body.isEmpty, let stream = request.httpBodyStream {
      stream.open()
      defer { stream.close() }
      var buffer = [UInt8](repeating: 0, count: 4096)
      while stream.hasBytesAvailable {
        let read = stream.read(&buffer, maxLength: buffer.count)
        if read <= 0 { break }
        body.append(buffer, count: read)
      }
    }
    if let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any], let password = json["password"] as? String {
      passwords.withLock { $0.append(password) }
    }
  }
}

@MainActor @Suite struct FaceIDSignInTests {
  let host = "test-\(UUID().uuidString.lowercased()).invalid"
  let vault = InMemoryPasswordVault()
  let answers = SignInAnswers()
  let sam = AccountKey(serverId: "srv-1", accountId: 2)

  func app(biometry: Biometry? = .faceID) -> AppModel {
    let session = FakeServer.session(host: host) { [answers] request in
      switch request.url?.path() {
      case "/api/server": return (200, #"{"id":"srv-1","name":"Home","version":"0.7.0","minAppVersion":"1.0.0","setup":false}"#)
      case "/api/auth/sign-in":
        answers.record(request)
        return answers.answer.withLock { $0 }
      case "/api/auth/redeem", "/api/auth/setup": return (200, SignInAnswers.sam)
      default: return (404, #"{"error":"Not found"}"#)
      }
    }
    let directory = FileManager.default.temporaryDirectory.appending(path: "playarr-\(UUID().uuidString)")
    let store = ServerStore(directory: directory, secrets: InMemorySecretStore(), passwords: vault, session: session, network: LocalNetwork(isLocal: true))
    return AppModel(
      store: store, browser: ServerBrowser(), appVersion: AppVersion("1.0.0"), device: DeviceInfo(name: "Test", platform: "ios"),
      biometrics: biometry.map(Biometrics.fixed) ?? .unavailable)
  }

  func connected(_ app: AppModel) async -> AddServerModel {
    let model = AddServerModel(app: app)
    await model.connect(to: URL(string: "http://\(host)")!)
    return model
  }

  @Test func offersFaceIDAfterATypedSignInAndKeepsThePasswordOnlyWhenAsked() async {
    let app = app()
    let model = await connected(app)

    #expect(await model.signIn(username: "sam", password: "secret"))
    #expect(app.faceIDOffer?.key == sam)
    #expect(app.faceIDOffer?.biometry == .faceID)
    app.answerFaceIDOffer(use: false)
    #expect(app.faceIDOffer == nil)
    #expect(!vault.hasPassword(for: sam.keychainAccount))

    #expect(await model.signIn(username: "sam", password: "secret"))
    app.answerFaceIDOffer(use: true)
    #expect(app.faceIDOffer == nil)
    #expect(await vault.password(for: sam.keychainAccount, reason: "") == .password("secret"))
  }

  @Test func offersFaceIDAfterASetupCodeAndAClaim() async {
    let app = app()
    let model = await connected(app)
    #expect(await model.redeem(code: "abcd-efgh", password: "first one"))
    #expect(app.faceIDOffer?.key == sam)
    app.answerFaceIDOffer(use: false)
    #expect(await model.claim(username: "sam", name: "Sam", password: "owner's"))
    #expect(app.faceIDOffer?.key == sam)
  }

  @Test func offersNothingWithoutBiometrics() async {
    let app = app(biometry: nil)
    let model = await connected(app)
    #expect(await model.signIn(username: "sam", password: "secret"))
    #expect(app.faceIDOffer == nil)
  }

  @Test func aTypedSignInWithFaceIDOnKeepsTheNewPasswordWithoutAsking() async throws {
    let app = app()
    try vault.save("old", for: sam.keychainAccount)
    let model = await connected(app)
    #expect(await model.signIn(username: "sam", password: "new"))
    #expect(app.faceIDOffer == nil)
    #expect(await vault.password(for: sam.keychainAccount, reason: "") == .password("new"))
  }
}
```

**Step 2: run them and see them fail**

Run: `swift test --disable-sandbox --package-path Packages/PlayarrUI --filter FaceIDSignInTests`
Expected: `value of type 'AppModel' has no member 'faceIDOffer'`.

**Step 3: implement**

In `AppModel` (near `redeemLink`):

```swift
    /// After a typed password, "Use Face ID to sign in next time?", asked as the app opens (`RootView`): the sign-in
    /// screen goes as the account signs in.
    public struct FaceIDOffer: Identifiable, Equatable {
        public let key: AccountKey
        public let biometry: Biometry
        let password: String
        public var id: AccountKey { key }
    }

    public var faceIDOffer: FaceIDOffer?

    /// A password typed and accepted: offer to keep it for Face ID, or, kept already, keep this one (it's the one that works).
    func offerFaceID(_ password: String, for key: AccountKey) {
        guard let biometry = biometrics.current() else { return }
        if store.passwords.hasPassword(for: key.keychainAccount) {
            try? store.passwords.save(password, for: key.keychainAccount)
        } else {
            faceIDOffer = FaceIDOffer(key: key, biometry: biometry, password: password)
        }
    }

    public func answerFaceIDOffer(use: Bool) {
        guard let offer = faceIDOffer else { return }
        faceIDOffer = nil
        guard use else { return }
        do {
            try store.passwords.save(offer.password, for: offer.key.keychainAccount)
        } catch {
            toasts.push("Couldn’t turn on \(offer.biometry.name). Try again the next time you sign in.")
        }
    }
```

Match `AppModel.swift`'s indentation (4 spaces). Check `ToastCenter.push`'s signature before using it.

In `AddServerModel`:
- `signIn`, `redeem` and `claim` pass their password to `finish`: `await finish(…, password: password)`.
- `finish(_ endpoint: Endpoint<SignInResponse>, password: String)` keeps its body and, after `try app.store.signedIn(…)`, calls `app.offerFaceID(password, for: AccountKey(serverId: connected.info.id, accountId: response.account.id))`.

**Step 4: run them and see them pass.** Also run `--filter AddServerModelTests`; it must still pass.

**Step 5: commit**

```bash
git add Packages/PlayarrUI
git commit -m "iOS: after a typed password, offer to keep it for Face ID; with Face ID on, keep the one that worked (plan 10)"
```

---

### Task 6: signing in again with Face ID

**Files:**
- Modify: `Packages/PlayarrUI/Sources/PlayarrUI/SignIn/AddServerModel.swift`
- Test: `Packages/PlayarrUI/Tests/PlayarrUITests/FaceIDSignInTests.swift`

**Step 1: write the failing tests** (add to `FaceIDSignInTests`)

```swift
  /// Sam signed in once with Face ID on, then the session ended.
  func signedOutWithFaceID(_ app: AppModel) throws {
    let account = Account(id: 2, username: "sam", name: "Sam", role: .member, canRequest: false, sources: nil, hasPassword: true)
    let home = ServerInfo(id: "srv-1", name: "Home", version: "0.7.0", minAppVersion: "1.0.0", setup: false)
    try app.store.signedIn(SignInResponse(token: "old", account: account), server: home, at: URL(string: "http://\(host)")!)
    try vault.save("secret", for: sam.keychainAccount)
    app.store.markSignedOut(sam)
  }

  @Test func signsInAgainWithFaceIDUsingTheKeptPassword() async throws {
    let app = app()
    try signedOutWithFaceID(app)
    let model = await connected(app)

    let faceID = try #require(model.faceID(for: "sam"))
    #expect(faceID == AddServerModel.FaceIDAccount(key: sam, biometry: .faceID))
    #expect(await model.signInWithFaceID(faceID, username: "sam"))
    #expect(answers.passwords.withLock { $0 } == ["secret"])
    #expect(app.store.activeAccount?.signedIn == true)
    #expect(app.faceIDOffer == nil)
  }

  @Test func offersNoFaceIDWithoutAKeptPasswordOrBiometrics() async throws {
    let app = app()
    let model = await connected(app)
    #expect(model.faceID(for: "sam") == nil)

    let noBiometrics = self.app(biometry: nil)
    try signedOutWithFaceID(noBiometrics)
    #expect(await connected(noBiometrics).faceID(for: "sam") == nil)
  }

  @Test func aChangedPasswordForgetsTheKeptOneAndOpensTheField() async throws {
    let app = app()
    try signedOutWithFaceID(app)
    answers.answer.withLock { $0 = (401, #"{"error":"Wrong username or password","setup":false}"#) }
    let model = await connected(app)
    let faceID = try #require(model.faceID(for: "sam"))

    #expect(await model.signInWithFaceID(faceID, username: "sam") == false)
    #expect(model.error == "Your password has changed. Type the new one.")
    #expect(!vault.hasPassword(for: sam.keychainAccount))
    #expect(model.faceID(for: "sam") == nil)
  }

  @Test func aPasswordIOSDroppedOpensTheField() async throws {
    let app = app()
    try signedOutWithFaceID(app)
    let model = await connected(app)
    let faceID = try #require(model.faceID(for: "sam"))
    try vault.remove(for: sam.keychainAccount)  // a face enrolled since

    #expect(await model.signInWithFaceID(faceID, username: "sam") == false)
    #expect(model.error == "Face ID changed on this \(OfflineWording.device). Type your password.")
    #expect(model.faceID(for: "sam") == nil)
    #expect(answers.passwords.withLock { $0 }.isEmpty)
  }

  @Test func aCancelKeepsThePasswordAndSaysNothing() async throws {
    let app = app()
    try signedOutWithFaceID(app)
    vault.face = .cancels
    let model = await connected(app)
    let faceID = try #require(model.faceID(for: "sam"))

    #expect(await model.signInWithFaceID(faceID, username: "sam") == false)
    #expect(model.error == nil)
    #expect(model.faceID(for: "sam") != nil)
  }

  @Test func tooManyTriesKeepsThePasswordAndSaysSo() async throws {
    let app = app()
    try signedOutWithFaceID(app)
    answers.answer.withLock { $0 = (429, #"{"error":"Too many tries. Wait a few minutes and try again."}"#) }
    let model = await connected(app)
    let faceID = try #require(model.faceID(for: "sam"))

    #expect(await model.signInWithFaceID(faceID, username: "sam") == false)
    #expect(model.error == "Too many tries. Wait a few minutes and try again.")
    #expect(vault.hasPassword(for: sam.keychainAccount))
  }
```

**Step 2: run them and see them fail.** Expected: `value of type 'AddServerModel' has no member 'faceID'`.

**Step 3: implement** (in `AddServerModel`)

```swift
    /// An account to sign in again with Face ID: it has a password kept and the device has biometrics set up.
    public struct FaceIDAccount: Equatable, Sendable {
        public let key: AccountKey
        public let biometry: Biometry
    }

    /// Set once Face ID can't sign this account in (its password changed, or iOS dropped it): the field opens.
    public private(set) var faceIDDropped = false

    public func faceID(for username: String) -> FaceIDAccount? {
        guard !faceIDDropped, let connected, let biometry = app.biometrics.current(),
              let record = app.store.server(connected.info.id)?.accounts.first(where: { $0.account.username == username }),
              app.store.passwords.hasPassword(for: record.key.keychainAccount) else { return nil }
        return FaceIDAccount(key: record.key, biometry: biometry)
    }

    /// Asks for Face ID and signs in with the kept password, as if it had been typed. A 401 or a password iOS dropped
    /// forgets it and opens the field; a cancel, offline or Too many tries keep it.
    public func signInWithFaceID(_ account: FaceIDAccount, username: String) async -> Bool {
        guard let connected, !busy else { return false }
        error = nil
        let key = account.key.keychainAccount
        switch await app.store.passwords.password(for: key, reason: "Sign in to \(connected.info.name)") {
        case .cancelled:
            return false
        case .gone:
            drop(key, because: "\(account.biometry.name) changed on this \(OfflineWording.device). Type your password.")
            return false
        case .password(let password):
            busy = true
            defer { busy = false }
            do {
                try await signedIn(API.Auth.signIn(username: username, password: password, device: app.device), at: connected)
                return true
            } catch APIError.server(status: 401, _) {
                drop(key, because: "Your password has changed. Type the new one.")
            } catch {
                self.error = error.localizedDescription
            }
            return false
        }
    }

    private func drop(_ key: String, because reason: String) {
        try? app.store.passwords.remove(for: key)
        faceIDDropped = true
        error = reason
    }

    /// Sends a sign-in, a setup code or a claim, and keeps the session it answers.
    @discardableResult
    private func signedIn(_ endpoint: Endpoint<SignInResponse>, at connected: Connected) async throws -> SignInResponse {
        let response = try await app.store.anonymousClient(for: connected.url).send(endpoint)
        try app.store.signedIn(response, server: connected.info, at: connected.url)
        return response
    }
```

Rewrite `finish` to use `signedIn(_:at:)`:

```swift
    private func finish(_ endpoint: Endpoint<SignInResponse>, password: String) async -> Bool {
        guard let connected else { return false }
        busy = true
        error = nil
        defer { busy = false }
        do {
            let response = try await signedIn(endpoint, at: connected)
            app.offerFaceID(password, for: AccountKey(serverId: connected.info.id, accountId: response.account.id))
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }
```

`OfflineWording.device` is `@MainActor` and internal, and `AddServerModel` is `@MainActor` in the same module. If its home in `Downloads/` feels wrong, move it to `Format` as `Format.device` and update `OfflineWording`'s callers in the same commit.

**Step 4: run them and see them pass.** Run `--filter FaceIDSignInTests` and `--filter AddServerModelTests`.

**Step 5: commit**

```bash
git add Packages/PlayarrUI
git commit -m "iOS: sign in again with Face ID; a changed password or a face enrolled since forgets the kept one and opens the field (plan 10)"
```

---

### Task 7: the screens: Sign in with Face ID, and the question

**Files:**
- Modify: `Packages/PlayarrUI/Sources/PlayarrUI/SignIn/SignInView.swift`
- Modify: `Packages/PlayarrUI/Sources/PlayarrUI/RootView.swift` (the modifier chain where `.sheet(item: $model.deviceLink)` sits)

**Step 1: `SignInView`.** Replace `body` with the following. `typing` and `askedOnce` are new `@State` properties, both `false` to start.

```swift
    var body: some View {
        Form {
            if let faceID = model.faceID(for: username), !typing {
                Section {
                    LabeledContent("Username", value: username)
                } footer: {
                    if let error = model.error { Text(error).foregroundStyle(.danger) }
                }
                Section {
                    Button(model.busy ? "Signing in…" : "Sign in with \(faceID.biometry.name)", systemImage: faceID.biometry.symbol) {
                        Task { await signIn(with: faceID) }
                    }
                    .disabled(model.busy)
                    Button("Use password instead") {
                        model.error = nil
                        typing = true
                    }
                    setupCode
                }
            } else {
                Section {
                    TextField("Username", text: $username).playarrUsernameField()
                    SecureField("Password", text: $password).playarrPasswordField(new: false)
                } footer: {
                    if let error = model.error { Text(error).foregroundStyle(.danger) }
                }
                Section {
                    Button(model.busy ? "Signing in…" : "Sign in") { Task { if await model.signIn(username: username, password: password) { onDone() } } }
                        .disabled(model.busy || username.isEmpty || password.isEmpty)
                    setupCode
                }
            }
        }
        .navigationTitle("Sign in to \(model.connected?.info.name ?? "Playarr")")
        // Face ID asked once, on its own, as the screen opens; the button asks again.
        .task {
            guard !askedOnce, let faceID = model.faceID(for: username) else { return }
            askedOnce = true
            await signIn(with: faceID)
        }
    }

    @ViewBuilder private var setupCode: some View {
        if let onSetupCode { Button("I have a setup code", action: onSetupCode) }
    }

    private func signIn(with faceID: AddServerModel.FaceIDAccount) async {
        if await model.signInWithFaceID(faceID, username: username) { onDone() }
    }
```

**Step 2: the question in `RootView`.** Add it after `.sheet(item: $model.deviceLink) { … }`:

```swift
            .alert(
                model.faceIDOffer.map { "Use \($0.biometry.name) to sign in next time?" } ?? "",
                isPresented: Binding(get: { model.faceIDOffer != nil }, set: { if !$0 { model.answerFaceIDOffer(use: false) } }),
                presenting: model.faceIDOffer
            ) { offer in
                Button("Not now", role: .cancel) { model.answerFaceIDOffer(use: false) }
                Button("Use \(offer.biometry.name)") { model.answerFaceIDOffer(use: true) }
            } message: { offer in
                Text("When a session ends, \(offer.biometry.name) signs you in again. Your password stays on this \(OfflineWording.device), behind \(offer.biometry.name).")
            }
```

**Step 3: build and run every package test**

Run: `make -C apps/ios build` from the repo root, then `swift test --disable-sandbox --package-path Packages/PlayarrUI`.
Expected: `** BUILD SUCCEEDED **` with the design check passing, and every test passing.

**Step 4: see it in the simulator.** Run `corepack pnpm dev:server` at the repo root and the app in the iPhone 17 Pro simulator, with Features → Face ID → Enrolled.
1. Sign in by typing. The question appears over the app; choose Use Face ID.
2. In Settings → Accounts → Signed in on, sign out this iPhone (or do it from the web). Sign in again shows Sign in with Face ID and asks on its own. Features → Face ID → Matching Face signs in; Non-matching Face stays.
3. From the account switcher, Add account with a sheet. The question must appear once the sheet has gone. If it doesn't (an alert presented while a sheet is being dismissed), delay setting `faceIDOffer` until the sheet's `onDismiss`, and note why in a comment.

**Step 5: commit**

```bash
git add Packages/PlayarrUI
git commit -m "iOS: Sign in leads with Sign in with Face ID when a password is kept, asking on its own once; the app asks Use Face ID to sign in next time? after a typed one (plan 10)"
```

---

### Task 8: Forget Face ID sign-in in Settings → Accounts

**Files:**
- Modify: `Packages/PlayarrUI/Sources/PlayarrUI/AppModel.swift`: `faceIDSignIn(for:)` and `forgetFaceID(for:)`
- Modify: `Packages/PlayarrUI/Sources/PlayarrUI/Settings/Admin/Accounts/AccountsPanel.swift`: `FaceIDSignIn`, the `init` parameter, and the button in `you(_:)`
- Modify: `Packages/PlayarrUI/Sources/PlayarrUI/Settings/SettingsView.swift` (`case .accounts`)
- Test: `FaceIDSignInTests.swift`

**Step 1: write the failing test**

```swift
  @Test func settingsOffersToForgetAKeptPasswordAndForgetsIt() async throws {
    let app = app()
    #expect(app.faceIDSignIn(for: sam) == nil)
    try vault.save("secret", for: sam.keychainAccount)
    #expect(app.faceIDSignIn(for: sam) == .faceID)
    app.forgetFaceID(for: sam)
    #expect(!vault.hasPassword(for: sam.keychainAccount))
    #expect(app.faceIDSignIn(for: sam) == nil)
  }
```

**Step 2: run it and see it fail.**

**Step 3: implement**

In `AppModel`:

```swift
    /// Settings → Accounts' Forget Face ID sign-in: the biometrics' name while a password is kept for the account.
    public func faceIDSignIn(for key: AccountKey) -> Biometry? {
        guard let biometry = biometrics.current(), store.passwords.hasPassword(for: key.keychainAccount) else { return nil }
        return biometry
    }

    public func forgetFaceID(for key: AccountKey) {
        try? store.passwords.remove(for: key.keychainAccount)
    }
```

In `AccountsPanel` (2-space indentation):

```swift
  /// Forget Face ID sign-in: the biometrics' name, and forgetting the kept password once the toast's Undo has gone
  /// (`putBack` shows the button again).
  public struct FaceIDSignIn {
    public let biometry: Biometry
    public let forget: @MainActor (_ putBack: @escaping @MainActor () -> Void) -> Void

    public init(biometry: Biometry, forget: @escaping @MainActor (_ putBack: @escaping @MainActor () -> Void) -> Void) {
      self.biometry = biometry
      self.forget = forget
    }
  }
```

- Add `private let faceID: FaceIDSignIn?` and `@State private var faceIDForgotten = false`.
- Add the `init` parameter `faceID: FaceIDSignIn? = nil` before `firstStep:`.
- In `you(_:)`, after the Sign out on this device button:

```swift
      if let faceID, !faceIDForgotten {
        Button("Forget \(faceID.biometry.name) sign-in", systemImage: faceID.biometry.symbol) {
          faceIDForgotten = true
          faceID.forget { faceIDForgotten = false }
        }
      }
```

In `SettingsView`'s `case .accounts`, pass the following. The demo's in-memory vault is always empty, so the demo shows nothing.

```swift
        faceID: app.faceIDSignIn(for: session.key).map { biometry in
          AccountsPanel.FaceIDSignIn(biometry: biometry) { [app, toasts = session.toasts, key = session.key] putBack in
            toasts.removed("\(biometry.name) sign-in forgotten", undo: putBack, done: { app.forgetFaceID(for: key) })
          }
        },
```

**Step 4: run the tests and build.** Run `--filter FaceIDSignInTests`, then `make -C apps/ios build`.

**Step 5: commit**

```bash
git add Packages/PlayarrUI
git commit -m "iOS: Settings → Accounts can forget the password kept for Face ID, with Undo (plan 10)"
```

---

### Task 9: the Face ID usage text

**Files:**
- Modify: `apps/ios/Config/Info.plist`, after `NSLocalNetworkUsageDescription`

**Step 1:** add the key.

```xml
	<key>NSFaceIDUsageDescription</key>
	<string>Playarr uses Face ID to sign you in again when a session ends.</string>
```

**Step 2:** run `plutil -lint Config/Info.plist`. Expected: `OK`.

**Step 3: commit**

```bash
git add Config/Info.plist
git commit -m "iOS: the Face ID usage text (plan 10)"
```

---

### Task 10: docs, the whole suite and the push

**Files:**
- `docs/ios/README.md`: in "Finding servers and signing in", item 5 (Keeping the session), a paragraph on Face ID: when it's offered, `KeychainPasswordVault`'s protection, signing in again, what forgets it, and where `Biometrics` comes from.
- `docs/ios/conventions.md` §5, Folders/Settings list: the Keychain now holds a second kind of item, `me.tracklistme.playarr.password`.
- `docs/decisions.md`, "Accounts and the iOS app": a dated line for 2026-11-20 (the password behind Face ID over a device key or AutoFill, and why).
- `docs/plans/2026-11-05-ios-device-checklist.md`: the checks in the design's §6, plus the question after Add account from the switcher's sheet.
- `docs/plans/2026-11-20-10-face-id-sign-in.md`: fold in this plan's "Changes from the design" and add a **Progress** line.
- `docs/plans/open-items.md` and `docs/README.md`: plan 10 is built; only the device checks are left.

**Step 1:** run everything: `make -C apps/ios test` from the repo root. Expected: the design check, the scripts, every package and the UI tests pass. The UI tests use `Biometrics.unavailable`, so no Face ID question can get in their way.

**Step 2:** commit the docs, then `git pull --ff-only` and `git push origin main` (unsandboxed). These are iOS changes only; the NAS deploys the server, which hasn't changed.

**Step 3:** tell the owner it's ready for a TestFlight build (`make -C apps/ios beta-upload`, which they run) and for the device checks.
