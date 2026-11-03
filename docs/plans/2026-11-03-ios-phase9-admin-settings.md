# Native iOS app, Phase 9: Admin Settings Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Settings in the app does everything the web's Settings does on the server's side. Admins manage sources (Lidarr, and folders on this server, over SSH or SFTP, or on an SMB share, chosen in a folder browser), drag them into priority order, rescan, match again, review doubtful matches, organize files and undo, and set the AcoustID key. They also choose the mixes and how they're made, run and follow the analyses, set up requests and updates, and manage accounts: create one and hand over its setup code, change its rights and library, reset it, remove it, and sign out its devices. Members see their own listening history and ListenBrainz link, and their own name and devices.

**Architecture:** Each panel is a `@MainActor @Observable` view model in `PlayarrUI/Settings/Admin/` with a thin SwiftUI view. View models talk to the server through a new one-method protocol, `APISending`, which phase 2's `APIClient` conforms to. Tests answer it from `FakeAPI`, which takes canned JSON per "METHOD path" and records every call's body as sorted JSON. Polling panels take an `any Clock<Duration>` and loop through `Polling.run`. A `TestClock` makes the loop step by step: `nextSleep()` says what the loop asked for, and `advance(by:)` wakes it. Changes are optimistic where the web's are, and are put back with the server's `{ error }` shown in the panel. `AdminPanel` lists the panels and who sees them. `AdminPanelView` builds one for the active account from phase 2's `ServerStore`. Phase 4's Settings list replaces its placeholders with them.

**Tech Stack:** Swift 6.4 (Xcode 27.2), Swift 6 language mode with strict concurrency, SwiftUI, Observation, Swift Testing, XCUITest. No third-party code.

**Design:** [2026-11-03-ios-app-design.md](2026-11-03-ios-app-design.md): section 2 "Settings" (Sources, Mixes, Analysis, Requests, Updates and Accounts are native and only shown to admins) and the Rollout table (phase 9). Names, layout and contracts: [2026-11-03-ios-conventions.md](2026-11-03-ios-conventions.md). The parity list is [2026-11-03-ios-parity-inventory.md](2026-11-03-ios-parity-inventory.md), section 2 (every Settings panel and setting, with its endpoint). The web components ported are `apps/web/src/components/SourcesPanel.tsx`, `ReviewDialog.tsx`, `OrganizeDialog.tsx`, `MixesPanel.tsx`, `ListenBrainzSection.tsx`, `AnalysisPanel.tsx`, `RequestsPanel.tsx` and `UpdatesPanel.tsx`, with polling rules from `lib/queries.ts`. `AccountsPanel.tsx` comes from phase 1, Task 21. This plan covers phase 9 only.

---

## Key decisions in this plan

**One seam for the server: `APISending`.** View models take `any APISending`, a protocol with phase 2's `send(_:)` signature. `APIClient` (an actor) conforms with an empty extension, so the views pass `store.activeClient` unchanged. A protocol was chosen over a `URLProtocol` stub (phase 2's `FakeServer`) because the tests can then assert the exact body each call sends (`#"{"ids":[2,1]}"#`) and queue answers ("syncing", then "done") without any HTTP.

**Polling on an injected clock.** The web polls with React Query's `refetchInterval`. Here every polling model has a `poll()` that a view runs in `.task`, so it stops when the panel goes away. The loop is `refresh`, then `clock.sleep(for: interval())`, where `interval()` reads the model's state. The intervals are the web's: Sources 2 s while a source syncs or matches and 30 s otherwise; the MusicBrainz queue 1.5 s while lookups wait and 15 s otherwise; review details every 2 s, at most 30 times; ListenBrainz every 30 s; Updates 5 s while a check is waiting or running and 60 s otherwise. Analysis polls every 10 s while songs wait. **Deviation:** when nothing waits, Analysis checks once a minute instead of stopping, so a run started on the web shows up. The tests use `TestClock`. A loop only sleeps again once its refresh has finished, so `await clock.nextSleep()` after `advance(by:)` is a reliable step boundary.

**Review restarts its polling.** The web asks again for edition details while the first two albums have candidates that aren't `detailed`. A search can bring new undetailed candidates after polling stopped, so `ReviewModel` bumps `pollRound`, and the view's `.task(id: model.pollRound)` starts `poll()` again.

**Who sees what.** The server decides (phase 1, Task 9): `requireAdmin` guards sources, analysis, requests, updates and `PUT /api/settings/mixes`, while `GET /api/settings/mixes`, the history and ListenBrainz are each account's own (`requireOwn`). So Sources, Analysis, Requests and Updates show to admins only. Mixes shows to everyone: members see the listening history (count and Clear history) and ListenBrainz, and admins also see the 12 kinds, time zone, lengths and counts, and "Remember what's played" (a server-wide setting). Accounts shows to everyone: members see their own name and devices, and admins also see everyone.

**Messages in place, not toasts.** The web's toasts ("Moved 3 files", "Couldn’t save: …") become an inline line in the panel (`InlineMessage`), with the web's words. A failed optimistic change is put back, as the web's `onError` does.

**Accounts.** The list, create, edit, reset and remove mirror phase 1's web panel. Creating shows the setup code, the link, Copy and the share sheet in the same sheet. Presenting a second sheet while the first one closes is unreliable on iOS, so the code replaces the form. Editing sends only the fields that changed. Phase 2's `AccountPatch` has no `username`, so Task 1 adds it (the server's PATCH accepts it). The last admin can't be removed: the action is hidden, and the server's 409 message would show anyway. **Deviation:** a new setup code asks first ("Their password stops working, every device they’re signed in on is signed out, …"). The web resets on a click, but on a phone the button sits where a stray tap lands. "Sign out everywhere" is left out: the contract has no endpoint for it (see the uncertainties at the end).

**Destructive actions confirm with the web's words:** Remove a source (`window.confirm`'s text, split into title and message), Clear history, each "Reanalyse the entire collection" / "Look up the entire collection again", "Reanalyse everything", and Remove an account. Undo of an organize batch and Disconnect from ListenBrainz don't ask on the web, and don't ask here.

**Other deviations.** The MusicBrainz queue, which the web shows in its sidebar footer, shows at the top of Sources. Reorder uses `List.onMove` with an Edit button. Updates shows the server's version (`GET /api/server`) where the web shows its own bundle's, and there's no "reload" toast (the app isn't replaced by an update). "Use this device’s" time zone is `TimeZone.current.identifier`.

**UI test against the dev server.** The XCUITest signs in as an admin through the server's API from the test runner. It then hands the token to the app through `launchEnvironment`, and `AppModel.signInForUITests()` adds the account to the empty store that `-UITests` already gives (phase 2). The test never types a password into the app. It removes the account it created and signs out afterwards. Without the three `TEST_RUNNER_PLAYARR_UITEST_*` variables it is skipped, so CI and `pnpm ios:test` without a dev server still pass.

## Conventions

- Run everything from the repo root `/Users/bortignon/dev/playarr`. `pnpm` is `corepack pnpm` in Claude's shell.
- One package's tests: `swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter SourcesModelTests`. `--disable-sandbox` is needed because SwiftPM's own sandbox can't start inside Claude's shell. Everything iOS: `make -C apps/ios test` (`corepack pnpm ios:test`).
- Build checks for views (SwiftUI screens get no unit tests; their logic is in the models):
  ```bash
  swift build --disable-sandbox --package-path apps/ios/Packages/PlayarrUI
  swift build --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --triple arm64-apple-ios26.0-simulator --sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" --scratch-path /tmp/playarr-ui-ios
  ```
- Swift: phase 0's two-space indentation in new files. In phase 2's four-space files (`API+Accounts.swift`), keep four. One primary type per file, named after it. No force unwraps outside tests. Swift Testing (`import Testing`) only, XCUITest for the UI test.
- User-facing text is the web's, copied from the components named in each task. Where the web names the browser, say "this device".
- New files live in `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/Admin/<Panel>/` and their tests in `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/Admin/`. Below, `UI/…` is short for `apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/…` and `UITests/…` for `apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/…` (the package's tests, not the XCUITest target `apps/ios/PlayarrUITests/`).
- Commit after every task, on `main`, only that task's files, with the message given (plain English subject, a body, a blank line, the `Co-Authored-By` line). The pre-commit hook bumps the version: never bypass it. The user pushes.

## Before you start

Phases 1 to 4 are done. Check each prerequisite:

```bash
grep -n "requireOwn\|requireAdmin" apps/server/src/routes/mixes.ts | head -3
grep -n "static func sources\|static func browseFolders\|static func organize(" apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/Endpoints/API+Settings.swift
grep -n "public struct AccountPatch" apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/Endpoints/API+Accounts.swift
grep -n "struct Enabled\|public struct Status\|struct LastBatch\|struct FoldersItem" apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/Models.generated.swift
grep -n "static func empty" apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/AppModel.swift
grep -rn "final class FakeServer" apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests
ls apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings
```

What this plan uses, by phase:

- **Phase 1 (server):** the account routes of the conventions table, `CreatedAccount`, and the settings split of its Task 9 (`requireAdmin` on settings, sources, analysis and `PUT /api/settings/mixes`; `requireOwn` on `GET /api/settings/mixes`, the history and ListenBrainz). `PATCH /api/accounts/:id` accepts `username` (`accountInput.partial()`). The web's Settings → Accounts (its Task 21) is the wording reference.
- **Phase 2 (`PlayarrAPI` and sign-in):** `Endpoint`, `APIClient`, `APIError` (its `errorDescription` is the server's message), `NoContent`, `Queued`, `Restored`, every `API.Settings.*`, `API.Analysis.progress()/run(_:again:)`, `API.Accounts.*`, `API.Auth.me()`, `API.Server.info()/musicBrainzStatus()`, and the generated models. The nested names this plan relies on are `SourceInfo.Settings`, `SourceInput.Settings`, `FolderBrowseRequest.Connection`, `FolderListing.FoldersItem`, `ReviewAction.Search/Names`, `OrganizePlan.LastBatch`, `MixSettingsInfo.Enabled` and `MixSettingsPatch.Enabled` (each a struct of 12 optional `Bool`s), `RequestSettingsInfo.Options`, `UpdateInfo.Status` (its `state` is compared by `rawValue`) and `UpdateSettingsPatch`. Also `ServerStore` (`activeClient`, `activeAccount`, `anonymousClient(for:)`, `signedIn(_:server:at:)`, `update(_:on:)`, `signOut(_:)`), `AccountRecord.key/serverId`, `InMemorySecretStore`, `AppModel.empty()` with the app's `-UITests` launch argument, and the `FakeServer` URL protocol in `PlayarrUITests` (from `AddServerModelTests.swift`). If the generator named a nested type differently, the compiler says which. Change the name in this plan's file, not the generator.
- **Phase 3:** nothing directly (`PlayarrUI` depends on `PlayarrPlayer`, so its tests build it).
- **Phase 4:** the Settings screen with Playback and Appearance and placeholders for the server panels. Its plan is written in parallel with this one, so this plan **assumes** three things. First, the Settings list is a SwiftUI view under `UI/Settings/` that has the `AppModel`. Second, the entry point to Settings can carry the accessibility identifier `settings`. Third, phase 4 has some way to drop data cached from the server (the conventions' `QueryCache`). Task 16 says what to do if any of these is named differently.
- If phase 4 already added a protocol like `APISending`, or test doubles named `FakeAPI` or `TestClock` to `PlayarrUITests`, keep one of each. Tasks 1 and 2 say how.

---

### Task 1: `APISending`, and a username in `AccountPatch`

**Files:**
- Create: `apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/APISending.swift`
- Modify: `apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/Endpoints/API+Accounts.swift` (`AccountPatch`)
- Test: `apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/AdminEndpointTests.swift`

First check that no later phase added the seam: `grep -rn "func send<T" apps/ios/Packages/PlayarrAPI/Sources apps/ios/Packages/PlayarrUI/Sources | grep -v "APIClient.swift"`. If a protocol with this method exists, use its name wherever this plan says `APISending`, make sure `APIClient` conforms, and skip Step 3's new file.

**Step 1: Write the failing test**

`apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/AdminEndpointTests.swift`:

```swift
import Foundation
import Testing
@testable import PlayarrAPI

/// What Settings → Accounts and the other admin panels need from PlayarrAPI beyond phase 2.
@Suite struct AdminEndpointTests {
  @Test func changesAUsername() throws {
    let data = try #require(try API.Accounts.update(id: 2, AccountPatch(username: "samantha")).bodyData())
    let sent = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    #expect(sent.keys.sorted() == ["username"])
    #expect(sent["username"] as? String == "samantha")
  }

  @Test func sendsThroughTheProtocol() async throws {
    let host = "admin-\(UUID().uuidString.lowercased()).invalid"
    let session = StubProtocol.session(host: host) { request in
      #expect(request.url?.path() == "/api/settings/matching")
      return (200, Data(#"{"acoustid":true,"fingerprints":false}"#.utf8))
    }
    let sender: any APISending = APIClient(baseURL: URL(string: "http://\(host)")!, token: "tok", session: session)
    let answer = try await sender.send(API.Settings.matching())
    #expect(answer == MatchingSettings(acoustid: true, fingerprints: false))
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrAPI --filter AdminEndpointTests
```

Expected: the build fails with `extra argument 'username' in call` and `cannot find type 'APISending' in scope`.

**Step 3: Implement**

`apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/APISending.swift`:

```swift
/// Sends an endpoint and decodes its answer: what screens and view models talk to, so tests can
/// answer them from a fake. `APIClient` is the real one.
public protocol APISending: Sendable {
  func send<T: Decodable & Sendable>(_ endpoint: Endpoint<T>) async throws -> T
}

extension APIClient: APISending {}
```

In `API+Accounts.swift`, `AccountPatch` gains `username` (the web's form edits it too). Replace the struct with (four spaces, like the file):

```swift
/// PATCH /api/accounts/:id: only the fields set are changed. `sources: .some(nil)` gives every source.
public struct AccountPatch: Encodable, Sendable, Equatable {
    public var username: String?
    public var name: String?
    public var role: AccountRole?
    public var canRequest: Bool?
    public var sources: [Int]??

    public init(username: String? = nil, name: String? = nil, role: AccountRole? = nil, canRequest: Bool? = nil, sources: [Int]?? = nil) {
        self.username = username
        self.name = name
        self.role = role
        self.canRequest = canRequest
        self.sources = sources
    }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrAPI
```

Expected: every PlayarrAPI suite passes, including `AdminEndpointTests` (2 tests) and phase 2's `EndpointTests` (its `leavesOutWhatAPatchDoesntChange` still sends only `name`).

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/APISending.swift apps/ios/Packages/PlayarrAPI/Sources/PlayarrAPI/Endpoints/API+Accounts.swift apps/ios/Packages/PlayarrAPI/Tests/PlayarrAPITests/AdminEndpointTests.swift
git commit -F - <<'MSG'
iOS: a protocol for sending endpoints, so view models can be tested against a fake server

APIClient conforms as it is. An account's username can now be changed
through AccountPatch, as the web's account form does.

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 2: A fake server, a test clock and the polling loop

**Files:**
- Create: `UI/Settings/Admin/Support/Polling.swift`
- Create: `UITests/Admin/FakeAPI.swift`, `UITests/Admin/TestClock.swift`
- Test: `UITests/Admin/PollingTests.swift`

First check that phase 4 didn't add these: `grep -rln "class FakeAPI\|class TestClock" apps/ios/Packages/PlayarrUI/Tests`. If one exists, keep it and add the members below that it lacks: `on(_:_:json:)`, `on(_:_:_:)`, `then(_:_:_:)`, `then(_:_:json:)`, `fail(_:_:status:_:)`, `calls`, `calls(_:_:)` and `bodies(_:_:)`, with bodies recorded as sorted JSON. For the clock, the members are `nextSleep()`, `pendingSleep` and `advance(by:)`. Don't create a second one.

**Step 1: Write the test doubles and the failing test**

`UITests/Admin/FakeAPI.swift`:

```swift
import Foundation
import PlayarrAPI
import Synchronization

/// Answers view models' calls from canned JSON and remembers every call, with its body as sorted JSON.
/// Each "METHOD /path" has a queue of answers: they're given in order and the last one repeats.
final class FakeAPI: APISending, @unchecked Sendable {
  struct Call: Equatable, CustomStringConvertible {
    var method: HTTPMethod
    var path: String
    /// The body as JSON with sorted keys; nil without one.
    var body: String?

    var description: String { "\(method.rawValue) \(path)\(body.map { " \($0)" } ?? "")" }
  }

  private enum Answer {
    case json(String)
    case failure(any Error)
  }

  private struct State {
    var answers: [String: [Answer]] = [:]
    var calls: [Call] = []
  }

  private let state = Mutex(State())

  /// From now on, `method path` answers this JSON (an empty string for 204).
  func on(_ method: HTTPMethod, _ path: String, json: String) {
    state.withLock { $0.answers[key(method, path)] = [.json(json)] }
  }

  /// From now on, `method path` answers this value.
  func on(_ method: HTTPMethod, _ path: String, _ value: some Encodable) {
    on(method, path, json: Self.json(value))
  }

  /// Answered after the answers already queued for `method path`.
  func then(_ method: HTTPMethod, _ path: String, _ value: some Encodable) {
    then(method, path, json: Self.json(value))
  }

  func then(_ method: HTTPMethod, _ path: String, json: String) {
    state.withLock { $0.answers[key(method, path), default: []].append(.json(json)) }
  }

  /// From now on, `method path` fails as the server does: a status and its `{ error }` message.
  func fail(_ method: HTTPMethod, _ path: String, status: Int = 400, _ message: String) {
    state.withLock { $0.answers[key(method, path)] = [.failure(APIError.server(status: status, message: message))] }
  }

  var calls: [Call] { state.withLock { $0.calls } }

  func calls(_ method: HTTPMethod, _ path: String) -> [Call] {
    calls.filter { $0.method == method && $0.path == path }
  }

  /// The bodies sent to `method path`, in order.
  func bodies(_ method: HTTPMethod, _ path: String) -> [String] {
    calls(method, path).compactMap(\.body)
  }

  func send<T: Decodable & Sendable>(_ endpoint: Endpoint<T>) async throws -> T {
    let body = try endpoint.bodyData().map(Self.sorted)
    let answer: Answer? = state.withLock { state in
      state.calls.append(Call(method: endpoint.method, path: endpoint.path, body: body))
      let key = key(endpoint.method, endpoint.path)
      guard var queue = state.answers[key], let first = queue.first else { return nil }
      if queue.count > 1 {
        queue.removeFirst()
        state.answers[key] = queue
      }
      return first
    }
    switch answer {
    case nil:
      throw APIError.server(status: 404, message: "No fake answer for \(endpoint.method.rawValue) \(endpoint.path)")
    case .failure(let error):
      throw error
    case .json(let text):
      return try JSONDecoder().decode(T.self, from: Data((text.isEmpty ? "{}" : text).utf8))
    }
  }

  private func key(_ method: HTTPMethod, _ path: String) -> String { "\(method.rawValue) \(path)" }

  private static func json(_ value: some Encodable) -> String {
    // swiftlint:disable:next force_try
    String(decoding: try! JSONEncoder().encode(value), as: UTF8.self)
  }

  private static func sorted(_ data: Data) -> String {
    guard let object = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]),
      let sorted = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .fragmentsAllowed, .withoutEscapingSlashes])
    else { return String(decoding: data, as: UTF8.self) }
    return String(decoding: sorted, as: UTF8.self)
  }
}
```

`UITests/Admin/TestClock.swift`:

```swift
import Synchronization

/// A clock that only moves when a test says so. `nextSleep()` waits until something sleeps on it and
/// says for how long; `advance(by:)` wakes whoever's time has come. Polling loops are then followed step
/// by step: a loop only sleeps again once its refresh has finished.
final class TestClock: Clock, @unchecked Sendable {
  struct Instant: InstantProtocol, Hashable {
    var offset: Duration

    func advanced(by duration: Duration) -> Instant { Instant(offset: offset + duration) }
    func duration(to other: Instant) -> Duration { other.offset - offset }
    static func < (lhs: Instant, rhs: Instant) -> Bool { lhs.offset < rhs.offset }
  }

  private struct Sleeper {
    let id: Int
    let deadline: Instant
    let continuation: CheckedContinuation<Void, any Error>
  }

  private struct State {
    var now = Instant(offset: .zero)
    var sleepers: [Sleeper] = []
    var watchers: [CheckedContinuation<Void, Never>] = []
    var cancelled: Set<Int> = []
    var nextId = 0
  }

  private let state = Mutex(State())

  var now: Instant { state.withLock { $0.now } }
  var minimumResolution: Duration { .zero }

  func sleep(until deadline: Instant, tolerance: Duration?) async throws {
    let id = state.withLock { state in
      state.nextId += 1
      return state.nextId
    }
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
        let (watchers, outcome): ([CheckedContinuation<Void, Never>], Result<Void, any Error>?) = state.withLock { state in
          if state.cancelled.remove(id) != nil { return ([], .failure(CancellationError())) }
          if deadline <= state.now { return ([], .success(())) }
          state.sleepers.append(Sleeper(id: id, deadline: deadline, continuation: continuation))
          defer { state.watchers = [] }
          return (state.watchers, nil)
        }
        if let outcome { continuation.resume(with: outcome) }
        for watcher in watchers { watcher.resume() }
      }
    } onCancel: {
      let sleeper: Sleeper? = state.withLock { state in
        guard let index = state.sleepers.firstIndex(where: { $0.id == id }) else {
          state.cancelled.insert(id)
          return nil
        }
        return state.sleepers.remove(at: index)
      }
      sleeper?.continuation.resume(throwing: CancellationError())
    }
  }

  /// Waits until something sleeps on this clock, and says how long it asked to sleep for.
  func nextSleep() async -> Duration {
    while true {
      if let wait = pendingSleep { return wait }
      await withCheckedContinuation { (watcher: CheckedContinuation<Void, Never>) in
        let ready = state.withLock { state in
          if state.sleepers.isEmpty {
            state.watchers.append(watcher)
            return false
          }
          return true
        }
        if ready { watcher.resume() }
      }
    }
  }

  /// How long the first sleeper still has to sleep, if something is sleeping.
  var pendingSleep: Duration? {
    state.withLock { state in state.sleepers.first.map { state.now.duration(to: $0.deadline) } }
  }

  /// Moves time on and wakes whoever's deadline has come.
  func advance(by duration: Duration) {
    let due: [Sleeper] = state.withLock { state in
      state.now = state.now.advanced(by: duration)
      let now = state.now
      let due = state.sleepers.filter { $0.deadline <= now }
      state.sleepers.removeAll { $0.deadline <= now }
      return due
    }
    for sleeper in due { sleeper.continuation.resume() }
  }
}
```

`UITests/Admin/PollingTests.swift`:

```swift
import Testing
@testable import PlayarrUI

@MainActor @Suite struct PollingTests {
  @Test func refreshesThenWaitsTheIntervalUntilItSaysStop() async {
    let clock = TestClock()
    var refreshes = 0
    var interval: Duration? = .seconds(2)
    let task = Task { await Polling.run(clock: clock, interval: { interval }, refresh: { refreshes += 1 }) }
    #expect(await clock.nextSleep() == .seconds(2))
    #expect(refreshes == 1)
    interval = .seconds(30)
    clock.advance(by: .seconds(2))
    #expect(await clock.nextSleep() == .seconds(30))
    #expect(refreshes == 2)
    interval = nil
    clock.advance(by: .seconds(30))
    await task.value
    #expect(refreshes == 3)
  }

  @Test func stopsWhenCancelled() async {
    let clock = TestClock()
    let task = Task { await Polling.run(clock: clock, interval: { .seconds(5) }, refresh: {}) }
    _ = await clock.nextSleep()
    task.cancel()
    await task.value
    #expect(clock.pendingSleep == nil)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter PollingTests
```

Expected: the build fails with `cannot find 'Polling' in scope`.

**Step 3: Implement**

`UI/Settings/Admin/Support/Polling.swift`:

```swift
/// Asks the server again and again while a panel is on screen: `refresh`, then wait `interval()` on
/// `clock`, until the task is cancelled (the panel went away) or `interval()` says nil (nothing to follow).
@MainActor
enum Polling {
  static func run(clock: any Clock<Duration>, interval: () -> Duration?, refresh: () async -> Void) async {
    while !Task.isCancelled {
      await refresh()
      guard let wait = interval() else { return }
      do {
        try await clock.sleep(for: wait)
      } catch {
        return
      }
    }
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter PollingTests
```

Expected: `Test run with 2 tests in 1 suite passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/Admin/Support/Polling.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/Admin/FakeAPI.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/Admin/TestClock.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/Admin/PollingTests.swift
git commit -F - <<'MSG'
iOS: a polling loop for Settings panels, with a fake server and a test clock to follow it step by step

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 3: The web's wording for numbers, sizes, waits and times

**Files:**
- Create: `UI/Settings/Admin/Support/AdminText.swift`, `UI/Settings/Admin/Support/AdminFailure.swift`, `UI/Settings/Admin/Support/String+Trimmed.swift`
- Test: `UITests/Admin/AdminTextTests.swift`

Ports `apps/web/src/lib/format.ts` (`plural`, `formatTime`, `formatWait`, `formatBytes`), the Analysis panel's `count` ("5,678" in English), and the Updates panel's `ago` (`Intl.RelativeTimeFormat('en', { numeric: 'auto' })` over days, hours and minutes, else "just now").

**Step 1: Write the failing test**

`UITests/Admin/AdminTextTests.swift`:

```swift
import Foundation
import Testing
@testable import PlayarrUI

@Suite struct AdminTextTests {
  @Test func saysCountsTheWebsWay() {
    #expect(AdminText.plural(1, "song") == "1 song")
    #expect(AdminText.plural(3, "album") == "3 albums")
    #expect(AdminText.count(5678) == "5,678")
  }

  @Test func saysTimesWaitsAndSizes() {
    #expect(AdminText.time(245) == "4:05")
    #expect(AdminText.time(3725) == "1:02:05")
    #expect(AdminText.wait(0.2) == "1 s")
    #expect(AdminText.wait(42) == "42 s")
    #expect(AdminText.wait(150) == "3 min")
    #expect(AdminText.bytes(356_515_840) == "340 MB")
    #expect(AdminText.bytes(1_610_612_736) == "1.5 GB")
    #expect(AdminText.bytes(12 * 1_073_741_824) == "12 GB")
  }

  @Test func saysHowLongAgo() {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    #expect(AdminText.ago(1_800_000_000 - 20, now: now) == "just now")
    #expect(AdminText.ago(1_800_000_000 - 120, now: now) == "2 minutes ago")
    #expect(AdminText.ago(1_800_000_000 - 3_600, now: now) == "1 hour ago")
    #expect(AdminText.ago(1_800_000_000 - 86_400, now: now) == "yesterday")
    #expect(AdminText.ago(1_800_000_000 - 3 * 86_400, now: now) == "3 days ago")
  }

  @Test func readsServerTimes() {
    #expect(AdminText.date("2026-11-03T10:00:00Z") == Date(timeIntervalSince1970: 1_793_700_000))
    #expect(AdminText.date("2026-11-03T10:00:00.250Z") != nil)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter AdminTextTests
```

Expected: the build fails with `cannot find 'AdminText' in scope`.

**Step 3: Implement**

`UI/Settings/Admin/Support/AdminText.swift`:

```swift
import Foundation

/// The web's number, size, wait and date wording (apps/web/src/lib/format.ts), for the Settings panels.
enum AdminText {
  /// 1 → "1 song", 3 → "3 songs".
  static func plural(_ n: Int, _ word: String, _ pluralWord: String? = nil) -> String {
    "\(n) \(n == 1 ? word : pluralWord ?? "\(word)s")"
  }

  /// 5678 → "5,678": the panels are in English, so their numbers are too.
  static func count(_ n: Int) -> String {
    n.formatted(.number.locale(Locale(identifier: "en_US")))
  }

  /// 245 → "4:05", 3725 → "1:02:05".
  static func time(_ seconds: Double) -> String {
    let total = seconds.isFinite && seconds > 0 ? Int(seconds) : 0
    let (h, m, s) = (total / 3600, total / 60 % 60, total % 60)
    let ss = s < 10 ? "0\(s)" : "\(s)"
    if h > 0 { return "\(h):\(m < 10 ? "0\(m)" : "\(m)"):\(ss)" }
    return "\(m):\(ss)"
  }

  /// A rough wait: "4 s", "2 min".
  static func wait(_ seconds: Double) -> String {
    seconds < 60 ? "\(max(1, Int(seconds.rounded()))) s" : "\(Int((seconds / 60).rounded())) min"
  }

  /// 356515840 → "340 MB", 1610612736 → "1.5 GB".
  static func bytes(_ bytes: Int) -> String {
    let gb = Double(bytes) / 1_073_741_824
    if gb >= 1 {
      let whole = gb >= 10 || gb == gb.rounded()
      return whole ? "\(Int(gb.rounded())) GB" : "\(String(format: "%.1f", gb)) GB"
    }
    return "\(Int((Double(bytes) / 1_048_576).rounded())) MB"
  }

  /// "2 minutes ago", "yesterday", "just now", for a Unix time in seconds (the web's Intl.RelativeTimeFormat, numeric "auto").
  static func ago(_ seconds: Int, now: Date = Date()) -> String {
    let diff = Int((Double(seconds) - now.timeIntervalSince1970).rounded())
    for (unit, size) in [("day", 86_400), ("hour", 3_600), ("minute", 60)] where abs(diff) >= size {
      let value = Int((Double(diff) / Double(size)).rounded())
      if unit == "day", value == -1 { return "yesterday" }
      if unit == "day", value == 1 { return "tomorrow" }
      let amount = plural(abs(value), unit)
      return value < 0 ? "\(amount) ago" : "in \(amount)"
    }
    return "just now"
  }

  /// An ISO 8601 time from the server, with or without fractions of a second.
  static func date(_ iso: String) -> Date? {
    let withFractions = ISO8601DateFormatter()
    withFractions.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return withFractions.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
  }

  /// The web's `toLocaleString()`: date and time, the device's way.
  static func dateTime(_ iso: String) -> String {
    date(iso)?.formatted(date: .numeric, time: .shortened) ?? iso
  }
}
```

`UI/Settings/Admin/Support/AdminFailure.swift`:

```swift
/// What a panel shows for a call that failed: the server's `{ error }` message (APIError's description), or the system's.
func failureText(_ error: any Error) -> String {
  error.localizedDescription
}
```

`UI/Settings/Admin/Support/String+Trimmed.swift`:

```swift
import Foundation

extension String {
  /// Without spaces and newlines at either end: what the web's forms send (`value.trim()`).
  var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
```

If phase 4 already declared a `trimmed` on `String` in `PlayarrUI`, delete this file and use that one.

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter AdminTextTests
```

Expected: `Test run with 4 tests in 1 suite passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/Admin/Support/AdminText.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/Admin/Support/AdminFailure.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/Admin/Support/String+Trimmed.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/Admin/AdminTextTests.swift
git commit -F - <<'MSG'
iOS: the web's wording for counts, sizes, waits and times, for the Settings panels

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 4: Sources: the list, its order, and each source's actions

**Files:**
- Create: `UI/Settings/Admin/Sources/SourceText.swift`, `UI/Settings/Admin/Sources/SourcesModel.swift`
- Create: `UITests/Admin/Samples.swift`
- Test: `UITests/Admin/SourcesModelTests.swift`

Ports `SourcesPanel`, `SourceRow` and `SourceStatus` (`SourcesPanel.tsx:37-215`) and `useSources`/`useSourceActions` (`queries.ts:334-500`). A drag shows at once and is saved with `PUT /api/settings/sources/order` only when the order really changed. A failed save puts the old order back. When a sync finishes, `libraryChanged` runs: the web refreshes every query then.

**Step 1: Write the samples and the failing test**

`UITests/Admin/Samples.swift`:

```swift
import PlayarrAPI

/// Server answers for the admin panels' tests.
enum Samples {
  static func lidarr(id: Int = 1, syncing: Bool = false) -> SourceInfo {
    SourceInfo(
      id: id, kind: .lidarr, name: "Lidarr", position: 0, enabled: true,
      settings: .init(url: "http://192.168.1.10:8686"), secrets: ["apiKey"], lastSyncAt: "2026-11-03T10:00:00Z",
      syncing: syncing, songs: 1200, albums: 100, review: 0, matching: 0)
  }

  static func folder(
    id: Int = 2, name: String = "Music", access: FolderAccessKind? = nil, syncing: Bool = false, matching: Int = 0,
    review: Int = 0, secrets: [String] = []
  ) -> SourceInfo {
    let remote = access != nil && access != .local
    return SourceInfo(
      id: id, kind: .folder, name: name, position: 1, enabled: true,
      settings: .init(
        path: access == .smb ? "/music/Albums" : "/music", access: access, host: remote ? "nas" : nil,
        port: access == .smb ? 445 : (remote ? 22 : nil), user: remote ? "guest" : nil),
      secrets: secrets, syncing: syncing, songs: 1, albums: 1, review: review, matching: matching, writable: true)
  }

  static func sources(_ list: [SourceInfo], canEdit: Bool = true) -> SourcesResponse {
    SourcesResponse(sources: list, canEdit: canEdit)
  }
}
```

`UITests/Admin/SourcesModelTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct SourcesModelTests {
  let api = FakeAPI()
  let clock = TestClock()

  @Test func describesEachSourceLikeTheWeb() {
    #expect(SourceText.details(Samples.lidarr()) == "http://192.168.1.10:8686 · 1200 songs · 100 albums")
    #expect(SourceText.details(Samples.folder(access: .smb)) == "smb://guest@nas/music/Albums · 1 song · 1 album")
    #expect(SourceText.details(Samples.folder(access: .ssh)) == "guest@nas:/music · 1 song · 1 album")
    #expect(SourceText.status(Samples.folder(syncing: true)) == ("Syncing…", .accent))
    #expect(SourceText.status(Samples.folder(matching: 3)) == ("Matching… 3 albums left · about 10 s", .accent))
    #expect(SourceText.status(Samples.folder()) == ("Not synced yet", .muted))
    var broken = Samples.folder()
    broken.error = "Folder not found"
    #expect(SourceText.status(broken) == ("Folder not found", .error))
    #expect(SourceText.removeTitle(Samples.lidarr()) == "Remove “Lidarr”?")
  }

  @Test func pollsQuicklyWhileASourceSyncsAndRefreshesTheLibraryAfter() async {
    var libraryChanges = 0
    let model = SourcesModel(api: api, clock: clock) { libraryChanges += 1 }
    api.on(.get, "/api/settings/sources", Samples.sources([Samples.lidarr(syncing: true)]))
    api.then(.get, "/api/settings/sources", Samples.sources([Samples.lidarr()]))
    let polling = Task { await model.poll() }
    #expect(await clock.nextSleep() == .seconds(2))
    #expect(model.sources.first?.syncing == true)
    clock.advance(by: .seconds(2))
    #expect(await clock.nextSleep() == .seconds(30))
    #expect(libraryChanges == 1)
    #expect(api.calls(.get, "/api/settings/sources").count == 2)
    polling.cancel()
  }

  @Test func savesANewOrderOnlyWhenItChanged() async {
    let model = SourcesModel(api: api, clock: clock)
    api.on(.get, "/api/settings/sources", Samples.sources([Samples.lidarr(), Samples.folder()]))
    await model.load()
    api.on(.put, "/api/settings/sources/order", Samples.sources([Samples.folder(), Samples.lidarr()]))
    await model.move(fromOffsets: IndexSet(integer: 0), toOffset: 1)
    #expect(api.calls(.put, "/api/settings/sources/order").isEmpty)
    await model.move(fromOffsets: IndexSet(integer: 0), toOffset: 2)
    #expect(api.bodies(.put, "/api/settings/sources/order") == [#"{"ids":[2,1]}"#])
    #expect(model.sources.map(\.id) == [2, 1])
  }

  @Test func putsTheOrderBackWhenSavingItFails() async {
    let model = SourcesModel(api: api, clock: clock)
    api.on(.get, "/api/settings/sources", Samples.sources([Samples.lidarr(), Samples.folder()]))
    await model.load()
    api.fail(.put, "/api/settings/sources/order", "Unknown source")
    await model.move(fromOffsets: IndexSet(integer: 1), toOffset: 0)
    #expect(model.sources.map(\.id) == [1, 2])
    #expect(model.error == "Unknown source")
  }

  @Test func removesRescansAndMatchesAgain() async {
    var libraryChanges = 0
    let model = SourcesModel(api: api, clock: clock) { libraryChanges += 1 }
    let folder = Samples.folder()
    api.on(.get, "/api/settings/sources", Samples.sources([folder]))
    api.on(.post, "/api/settings/sources/2/rescan", json: "")
    api.on(.post, "/api/settings/sources/2/rematch", json: "")
    api.on(.delete, "/api/settings/sources/2", json: "")
    await model.rescan(folder)
    await model.rematch(folder)
    #expect(model.rematching.isEmpty)
    await model.remove(folder)
    #expect(api.calls.map(\.description).filter { !$0.hasPrefix("GET") } == [
      "POST /api/settings/sources/2/rescan", "POST /api/settings/sources/2/rematch", "DELETE /api/settings/sources/2",
    ])
    #expect(libraryChanges == 1)
  }

  @Test func showsTheServersMessageWhenAChangeFails() async {
    let model = SourcesModel(api: api, clock: clock)
    api.on(.get, "/api/settings/sources", Samples.sources([Samples.lidarr()], canEdit: false))
    api.fail(.post, "/api/settings/sources/1/rescan", status: 403, "Only an admin can change this")
    await model.rescan(Samples.lidarr())
    #expect(model.error == "Only an admin can change this")
    #expect(model.canEdit == false)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter SourcesModelTests
```

Expected: the build fails with `cannot find 'SourcesModel' in scope` and `cannot find 'SourceText' in scope`.

**Step 3: Implement**

`UI/Settings/Admin/Sources/SourceText.swift`:

```swift
import Foundation
import PlayarrAPI

/// How Settings → Sources describes a source (SourcesPanel.tsx: SourceRow and SourceStatus).
enum SourceText {
  enum Tone: Equatable { case accent, error, muted }

  /// A folder on another machine (SSH, SFTP or SMB).
  static func isRemote(_ source: SourceInfo) -> Bool {
    guard source.kind == .folder, let access = source.settings?.access else { return false }
    return access != .local
  }

  /// "smb://guest@nas/music/Albums · 120 songs · 10 albums".
  static func details(_ source: SourceInfo) -> String {
    let settings = source.settings
    let place: String?
    if isRemote(source), let settings {
      let user = settings.user ?? "", host = settings.host ?? "", path = settings.path ?? ""
      place = settings.access == .smb ? "smb://\(user)@\(host)\(path)" : "\(user)@\(host):\(path)"
    } else {
      place = settings?.url ?? settings?.path
    }
    let counts = "\(AdminText.plural(source.songs, "song")) · \(AdminText.plural(source.albums, "album"))"
    return [place, counts].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " · ")
  }

  /// The status line under a source, and its colour.
  static func status(_ source: SourceInfo) -> (text: String, tone: Tone) {
    if source.syncing { return ("Syncing…", .accent) }
    if source.matching > 0 {
      // Each album takes a few MusicBrainz lookups at about one per second.
      let left = AdminText.plural(source.matching, "album")
      return ("Matching… \(left) left · about \(AdminText.wait(Double(source.matching) * 3.3))", .accent)
    }
    if let error = source.error { return (error, .error) }
    if !source.enabled { return ("Turned off", .muted) }
    if let synced = source.lastSyncAt { return ("Synced \(AdminText.dateTime(synced))", .muted) }
    return ("Not synced yet", .muted)
  }

  /// The remove question's title and message (the web's window.confirm text, split in two).
  static func removeTitle(_ source: SourceInfo) -> String { "Remove “\(source.name)”?" }
  static let removeMessage = "Its songs leave your library; favorites and playlists keep them, greyed out."
}
```

`UI/Settings/Admin/Sources/SourcesModel.swift`:

```swift
import Foundation
import Observation
import PlayarrAPI

/// Settings → Sources: where the library comes from, in priority order. Polled every 2 s while a source
/// syncs or matches, every 30 s otherwise; when a sync finishes, everything showing the library is refreshed.
@MainActor @Observable
public final class SourcesModel {
  public private(set) var sources: [SourceInfo] = []
  /// False for an account that may not change sources (the server says so).
  public private(set) var canEdit = false
  public private(set) var loaded = false
  /// Why the list couldn't be loaded (the last try).
  public private(set) var loadError: String?
  /// Why the last change failed: the server's message.
  public var error: String?
  /// Sources with a "Match again" on its way (the button waits for it).
  public private(set) var rematching: Set<Int> = []

  @ObservationIgnored let api: any APISending
  @ObservationIgnored private let clock: any Clock<Duration>
  @ObservationIgnored private let libraryChanged: @MainActor () -> Void
  @ObservationIgnored private var wasSyncing = false

  public init(api: any APISending, clock: any Clock<Duration> = ContinuousClock(), libraryChanged: @escaping @MainActor () -> Void = {}) {
    self.api = api
    self.clock = clock
    self.libraryChanged = libraryChanged
  }

  /// Playarr connects to one Lidarr.
  public var hasLidarr: Bool { sources.contains { $0.kind == .lidarr } }
  /// The AcoustID key matters only with a folder source.
  public var hasFolder: Bool { sources.contains { $0.kind == .folder } }

  var pollInterval: Duration { sources.contains { $0.syncing || $0.matching > 0 } ? .seconds(2) : .seconds(30) }

  /// Loads, then follows the sources while the panel is on screen (`.task { await model.poll() }`).
  public func poll() async {
    await Polling.run(clock: clock, interval: { [weak self] in self?.pollInterval }) { [weak self] in await self?.load() }
  }

  public func load() async {
    do {
      apply(try await api.send(API.Settings.sources()))
      loadError = nil
    } catch {
      loadError = failureText(error)
    }
  }

  /// A drag in the list: shown at once, then saved (PUT …/order) when the order really changed.
  public func move(fromOffsets offsets: IndexSet, toOffset destination: Int) async {
    let before = sources
    var list = sources
    let moving = offsets.map { list[$0] }
    for index in offsets.sorted(by: >) { list.remove(at: index) }
    list.insert(contentsOf: moving, at: destination - offsets.filter { $0 < destination }.count)
    guard list.map(\.id) != before.map(\.id) else { return }
    sources = list
    do {
      apply(try await api.send(API.Settings.reorderSources(ids: list.map(\.id))))
    } catch {
      self.error = failureText(error)
      sources = before
      await load()
    }
  }

  /// After the question; its songs leave every list, so everything is refreshed.
  public func remove(_ source: SourceInfo) async {
    await act { try await api.send(API.Settings.removeSource(id: source.id)) }
    libraryChanged()
  }

  public func rescan(_ source: SourceInfo) async {
    await act { try await api.send(API.Settings.rescanSource(id: source.id)) }
  }

  /// "Match again": every album of a folder source is matched on MusicBrainz again.
  public func rematch(_ source: SourceInfo) async {
    rematching.insert(source.id)
    defer { rematching.remove(source.id) }
    await act { try await api.send(API.Settings.rematchSource(id: source.id)) }
  }

  /// A source was added or changed in its form.
  public func saved() async {
    await load()
  }

  private func act(_ call: () async throws -> NoContent) async {
    error = nil
    do {
      _ = try await call()
    } catch {
      self.error = failureText(error)
    }
    await load()
  }

  private func apply(_ response: SourcesResponse) {
    sources = response.sources
    canEdit = response.canEdit
    loaded = true
    let syncing = response.sources.contains(where: \.syncing)
    if wasSyncing, !syncing { libraryChanged() }
    wasSyncing = syncing
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter SourcesModelTests
```

Expected: `Test run with 6 tests in 1 suite passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/Admin/Sources/SourceText.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/Admin/Sources/SourcesModel.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/Admin/Samples.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/Admin/SourcesModelTests.swift
git commit -F - <<'MSG'
iOS: Settings → Sources model: the list in priority order, polled while sources sync, reordered, rescanned, matched again and removed

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 5: Sources: the Lidarr and folder forms, and the folder browser

**Files:**
- Create: `UI/Settings/Admin/Sources/LidarrFormModel.swift`, `UI/Settings/Admin/Sources/FolderFormModel.swift`, `UI/Settings/Admin/Sources/FolderBrowserModel.swift`
- Test: `UITests/Admin/SourceFormTests.swift`

Ports `LidarrForm`, `FolderForm` and `FolderBrowser` (`SourcesPanel.tsx:372-777`). The web relies on the browser's own form checks (`required`, `type="url"`, `min`/`max` on the port). Here `canSave` makes the same checks: a name of at most 80 characters, a URL with a scheme, and a key unless one is saved. A folder form needs a chosen folder (not an SMB server's list of shares), and a remote one also needs a host, a user and a port from 1 to 65535. A saved secret stays unless "Replace" is tapped. An emptied key file or domain is sent as `""`, which clears it on the server. The folder browser connects only when Connect is tapped, and each Connect starts it over (`attempt`).

**Step 1: Write the failing test**

`UITests/Admin/SourceFormTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct SourceFormTests {
  let api = FakeAPI()

  @Test func asksForAURLAndAKeyBeforeSavingANewLidarr() async {
    let form = LidarrFormModel(source: nil, api: api)
    #expect(form.name == "Lidarr")
    #expect(!form.canSave)
    form.url = "192.168.1.10:8686x"
    form.apiKey = "abc"
    #expect(!form.canSave)
    form.url = "http://192.168.1.10:8686"
    #expect(form.canSave)
    api.on(.post, "/api/settings/sources", Samples.lidarr())
    #expect(await form.save())
    #expect(api.bodies(.post, "/api/settings/sources") == [
      #"{"enabled":true,"kind":"lidarr","name":"Lidarr","settings":{"apiKey":"abc","url":"http://192.168.1.10:8686"}}"#,
    ])
  }

  @Test func keepsASavedKeyUnlessReplaced() async {
    let form = LidarrFormModel(source: Samples.lidarr(), api: api)
    #expect(form.keySaved && !form.replacingKey && form.canSave)
    api.on(.patch, "/api/settings/sources/1", Samples.lidarr())
    #expect(await form.save())
    #expect(api.bodies(.patch, "/api/settings/sources/1") == [#"{"enabled":true,"name":"Lidarr","settings":{"url":"http://192.168.1.10:8686"}}"#])
  }

  @Test func testsTheConnectionAndSaysWhatHappened() async {
    let form = LidarrFormModel(source: Samples.lidarr(), api: api)
    api.on(.post, "/api/settings/sources/test", SourceTestResult(ok: true, version: "2.9.6"))
    await form.runTest()
    #expect(form.testText == "Connected to Lidarr 2.9.6")
    #expect(api.bodies(.post, "/api/settings/sources/test") == [#"{"id":1,"url":"http://192.168.1.10:8686"}"#])
    api.fail(.post, "/api/settings/sources/test", status: 502, "Lidarr didn’t answer")
    await form.runTest()
    #expect(form.testText == "Lidarr didn’t answer")
  }

  @Test func showsTheServersMessageWhenSavingFails() async {
    let form = LidarrFormModel(source: Samples.lidarr(), api: api)
    api.fail(.patch, "/api/settings/sources/1", "Lidarr refused the API key")
    #expect(await form.save() == false)
    #expect(form.error == "Lidarr refused the API key")
  }

  @Test func savesAFolderOnThisServer() async {
    let form = FolderFormModel(source: nil, api: api)
    #expect(form.browsing == FolderBrowseRequest())
    #expect(!form.canSave)
    form.path = "/music/Jazz"
    #expect(form.namePlaceholder == "Jazz")
    api.on(.post, "/api/settings/sources", Samples.folder())
    #expect(await form.save())
    #expect(api.bodies(.post, "/api/settings/sources") == [#"{"enabled":true,"kind":"folder","settings":{"access":"local","path":"/music/Jazz"}}"#])
  }

  @Test func connectsOnlyWhenAskedAndSwapsTheDefaultPort() {
    let form = FolderFormModel(source: nil, api: api)
    form.choose(.ssh)
    #expect(form.browsing == nil && form.port == 22 && !form.canConnect)
    form.host = " nas "
    form.user = "music"
    form.password = "secret"
    form.choose(.smb)
    #expect(form.port == 445)
    form.connect()
    #expect(form.attempt == 1)
    #expect(form.browsing?.connection == .init(access: .smb, host: "nas", port: 445, user: "music", password: "secret"))
    #expect(form.rootLabel == "Shares on nas")
    form.path = "/"
    #expect(!form.pathOK)
    form.choose(.sftp)
    #expect(form.port == 22 && form.path == nil && form.browsing == nil)
  }

  @Test func keepsTheSavedPasswordAndClearsAnEmptiedKeyFile() async {
    let saved = Samples.folder(access: .ssh, secrets: ["password"])
    let form = FolderFormModel(source: saved, api: api)
    #expect(form.browsing?.connection?.access == .ssh)
    #expect(!form.replacingPassword && form.canSave)
    api.on(.patch, "/api/settings/sources/2", saved)
    #expect(await form.save())
    #expect(api.bodies(.patch, "/api/settings/sources/2") == [
      #"{"enabled":true,"name":"Music","settings":{"access":"ssh","host":"nas","path":"/music","port":22,"privateKeyPath":"","user":"guest"}}"#,
    ])
  }

  @Test func offersSMBOnlyWithRclone() async {
    api.on(.get, "/api/settings/folders/access", FolderAccessOptions(smb: false))
    let form = FolderFormModel(source: nil, api: api)
    await form.loadAccess()
    #expect(form.isDisabled(.smb))
    let share = FolderFormModel(source: Samples.folder(access: .smb), api: api)
    await share.loadAccess()
    #expect(!share.isDisabled(.smb))
  }

  @Test func browsesFoldersOneLevelAtATime() async {
    let browser = FolderBrowserModel(request: FolderBrowseRequest(), start: nil, api: api)
    api.on(.post, "/api/settings/folders/browse", FolderListing(path: nil, parent: nil, folders: [.init(name: "music", path: "/music")], audioFiles: 0))
    await browser.load()
    #expect(browser.title == "Folders Playarr may use")
    #expect(!browser.canGoUp && browser.choosable == nil)
    api.on(.post, "/api/settings/folders/browse", FolderListing(path: "/music", parent: nil, folders: [], audioFiles: 12))
    await browser.open("/music")
    #expect(browser.canGoUp)
    #expect(browser.footer(selected: "/music") == "12 audio files here · selected")
    #expect(browser.emptyText == "No folders inside.")
    #expect(api.bodies(.post, "/api/settings/folders/browse") == ["{}", #"{"path":"/music"}"#])
  }

  @Test func listsSharesOnAnSMBServerWithoutChoosingThem() async {
    let request = FolderBrowseRequest(connection: .init(access: .smb, host: "nas", port: 445, user: "guest"))
    let browser = FolderBrowserModel(request: request, start: nil, rootLabel: "Shares on nas", api: api)
    api.on(.post, "/api/settings/folders/browse", FolderListing(path: "/", parent: nil, folders: [], audioFiles: 0))
    await browser.load()
    #expect(browser.title == "Shares on nas")
    #expect(browser.choosable == nil && !browser.canGoUp)
    #expect(browser.emptyText == "No shares found.")
  }

  @Test func explainsAnEmptyDockerRoot() async {
    let browser = FolderBrowserModel(request: FolderBrowseRequest(), start: "/host", api: api)
    api.on(.post, "/api/settings/folders/browse", FolderListing(path: "/host", parent: nil, folders: [], audioFiles: 0, emptyRoot: true))
    await browser.load()
    #expect(browser.emptyRootHelp?.title == "Nothing is shared with Playarr at /host yet.")
    #expect(browser.emptyText == nil)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter SourceFormTests
```

Expected: the build fails with `cannot find 'LidarrFormModel' in scope` (and the other two models).

**Step 3: Implement**

`UI/Settings/Admin/Sources/LidarrFormModel.swift`:

```swift
import Foundation
import Observation
import PlayarrAPI

/// Settings → Sources → Add or edit Lidarr: name, URL, API key (kept unless replaced), Test, Save (LidarrForm).
@MainActor @Observable
public final class LidarrFormModel {
  public enum TestState: Equatable {
    case idle, running
    case done(SourceTestResult)
  }

  public let source: SourceInfo?
  public var name: String
  public var url: String
  public var apiKey = ""
  /// A saved key stays unless "Replace" is tapped.
  public var replacingKey: Bool
  public var enabled: Bool
  public private(set) var test: TestState = .idle
  public private(set) var saving = false
  public var error: String?

  @ObservationIgnored private let api: any APISending

  public init(source: SourceInfo?, api: any APISending) {
    self.source = source
    self.api = api
    name = source?.name ?? "Lidarr"
    url = source?.settings?.url ?? ""
    replacingKey = !(source?.secrets.contains("apiKey") ?? false)
    enabled = source?.enabled ?? true
  }

  public var keySaved: Bool { source?.secrets.contains("apiKey") ?? false }

  /// The browser's checks on the web form: a name, a URL it accepts, and a key unless one is saved.
  public var canSave: Bool {
    !saving && !name.trimmingCharacters(in: .whitespaces).isEmpty && name.count <= 80 && Self.isURL(url) && (keySaved || !apiKey.isEmpty)
  }

  public var canTest: Bool { test != .running && !url.isEmpty }

  /// "Connected to Lidarr 2.9.6", or why not.
  public var testText: String? {
    guard case .done(let result) = test else { return nil }
    return result.ok ? "Connected to Lidarr \(result.version ?? "")" : (result.error ?? "")
  }

  public func runTest() async {
    test = .running
    do {
      test = .done(try await api.send(API.Settings.testSource(id: source?.id, url: url, apiKey: newKey)))
    } catch {
      test = .done(SourceTestResult(ok: false, error: failureText(error)))
    }
  }

  /// Adds or updates the source; true once saved.
  public func save() async -> Bool {
    guard canSave else { return false }
    saving = true
    error = nil
    defer { saving = false }
    let settings = SourceInput.Settings(url: url, apiKey: newKey)
    do {
      if let source {
        _ = try await api.send(API.Settings.updateSource(id: source.id, SourceInput(name: name, enabled: enabled, settings: settings)))
      } else {
        _ = try await api.send(API.Settings.addSource(SourceInput(kind: .lidarr, name: name, enabled: enabled, settings: settings)))
      }
      return true
    } catch {
      self.error = failureText(error)
      return false
    }
  }

  private var newKey: String? { replacingKey && !apiKey.isEmpty ? apiKey : nil }

  /// What `<input type="url">` accepts: a scheme and something after it.
  static func isURL(_ text: String) -> Bool {
    guard let url = URL(string: text.trimmingCharacters(in: .whitespaces)), let scheme = url.scheme, !scheme.isEmpty else { return false }
    return url.host() != nil || !(url.absoluteString.dropFirst(scheme.count + 1).isEmpty)
  }
}
```

`UI/Settings/Admin/Sources/FolderFormModel.swift`:

```swift
import Foundation
import Observation
import PlayarrAPI

/// Settings → Sources → Add or edit a folder: on this server, over SSH or SFTP, or an SMB share, chosen in
/// a folder browser (FolderForm). The browser connects only when Connect is tapped, so typing opens nothing.
@MainActor @Observable
public final class FolderFormModel {
  public static let accessChoices: [(access: FolderAccessKind, label: String)] = [
    (.local, "This server"), (.ssh, "SSH"), (.sftp, "SFTP"), (.smb, "SMB share"),
  ]
  public static let smbOffText = "SMB shares need rclone on the server"
  /// The web's example for "Key file on the server".
  public static let keyPathPlaceholder = "~/.ssh/id_ed25519"

  public let source: SourceInfo?
  public private(set) var access: FolderAccessKind
  public var path: String?
  public var host: String
  public var port: Int
  public var user: String
  public var password = ""
  public var replacingPassword: Bool
  public var keyPath: String
  public var domain: String
  public var name: String
  public var enabled: Bool
  /// Without rclone on the server, SMB can't be chosen for a new folder (a saved one stays editable).
  public private(set) var smbOff = false
  /// What the browser shows: this server's folders, or the connection as it was when Connect was tapped.
  public private(set) var browsing: FolderBrowseRequest?
  /// Counts Connects, so the browser starts over each time.
  public private(set) var attempt = 0
  public private(set) var saving = false
  public var error: String?

  @ObservationIgnored private let api: any APISending
  @ObservationIgnored private let savedAccess: FolderAccessKind

  public init(source: SourceInfo?, api: any APISending) {
    self.source = source
    self.api = api
    let saved = source?.settings
    savedAccess = saved?.access ?? .local
    access = savedAccess
    path = saved?.path
    host = saved?.host ?? ""
    port = saved?.port ?? Self.defaultPort(savedAccess)
    user = saved?.user ?? ""
    replacingPassword = !(source?.secrets.contains("password") ?? false)
    keyPath = saved?.privateKeyPath ?? ""
    domain = saved?.domain ?? ""
    name = source?.name ?? ""
    enabled = source?.enabled ?? true
    if savedAccess == .local {
      browsing = FolderBrowseRequest()
    } else if source != nil {
      browsing = connectionNow()
    }
  }

  public var remote: Bool { access != .local }
  public var smb: Bool { access == .smb }
  public var passwordSaved: Bool { source?.secrets.contains("password") ?? false }

  /// SMB listens on 445, SSH and SFTP on 22.
  static func defaultPort(_ access: FolderAccessKind) -> Int { access == .smb ? 445 : 22 }

  /// Asks the server whether SMB shares can be reached (rclone).
  public func loadAccess() async {
    smbOff = (try? await api.send(API.Settings.folderAccess()))?.smb == false
  }

  /// SMB can't be picked without rclone, unless the folder already is one.
  public func isDisabled(_ choice: FolderAccessKind) -> Bool {
    choice == .smb && smbOff && savedAccess != .smb
  }

  public func choose(_ next: FolderAccessKind) {
    guard next != access else { return }
    // SMB and SSH listen on different ports: swap the default, keep a port the user chose.
    if next == .smb, port == 22 { port = 445 }
    if access == .smb, next != .smb, port == 445 { port = 22 }
    access = next
    // A path on one machine means nothing on another.
    path = next == savedAccess ? source?.settings?.path : nil
    browsing = next == .local ? FolderBrowseRequest() : nil
  }

  public var canConnect: Bool { !host.trimmingCharacters(in: .whitespaces).isEmpty && !user.trimmingCharacters(in: .whitespaces).isEmpty }

  public func connect() {
    browsing = connectionNow()
    attempt += 1
  }

  /// What "/" is called on an SMB server: its list of shares, which can't be chosen.
  public var rootLabel: String? {
    guard smb else { return nil }
    return "Shares on \(browsing?.connection?.host ?? source?.settings?.host ?? "")"
  }

  /// A folder is chosen, and it isn't an SMB server's list of shares.
  public var pathOK: Bool {
    guard let path, !path.isEmpty else { return false }
    return !(smb && path == "/")
  }

  public var canSave: Bool {
    guard pathOK, !saving, name.count <= 80 else { return false }
    guard remote else { return true }
    return canConnect && (1...65_535).contains(port)
  }

  /// The name field's hint: the folder's own name.
  public var namePlaceholder: String {
    path?.split(separator: "/").last.map(String.init) ?? "Music"
  }

  public func save() async -> Bool {
    guard canSave, let path else { return false }
    saving = true
    error = nil
    defer { saving = false }
    var settings = SourceInput.Settings(path: path, access: access)
    if remote {
      settings.host = host.trimmingCharacters(in: .whitespaces)
      settings.port = port
      settings.user = user.trimmingCharacters(in: .whitespaces)
      // An empty value clears the saved one.
      if smb { settings.domain = domain.trimmingCharacters(in: .whitespaces) } else { settings.privateKeyPath = keyPath.trimmingCharacters(in: .whitespaces) }
      if replacingPassword, !password.isEmpty { settings.password = password }
    }
    let trimmed = name.trimmingCharacters(in: .whitespaces)
    let input = SourceInput(kind: source == nil ? .folder : nil, name: trimmed.isEmpty ? nil : trimmed, enabled: enabled, settings: settings)
    do {
      if let source {
        _ = try await api.send(API.Settings.updateSource(id: source.id, input))
      } else {
        _ = try await api.send(API.Settings.addSource(input))
      }
      return true
    } catch {
      self.error = failureText(error)
      return false
    }
  }

  private func connectionNow() -> FolderBrowseRequest {
    let trimmedDomain = domain.trimmingCharacters(in: .whitespaces)
    let trimmedKey = keyPath.trimmingCharacters(in: .whitespaces)
    return FolderBrowseRequest(
      id: source?.id,
      connection: .init(
        access: access,
        host: host.trimmingCharacters(in: .whitespaces),
        port: port,
        user: user.trimmingCharacters(in: .whitespaces),
        password: replacingPassword && !password.isEmpty ? password : nil,
        privateKeyPath: access == .smb || trimmedKey.isEmpty ? nil : trimmedKey,
        domain: access == .smb && !trimmedDomain.isEmpty ? trimmedDomain : nil))
  }
}
```

`UI/Settings/Admin/Sources/FolderBrowserModel.swift`:

```swift
import Foundation
import Observation
import PlayarrAPI

/// The folder browser inside the folder form (FolderBrowser): folders on this server (starting from the
/// folders sources may use) or on another machine, one level at a time, and "Use this folder".
@MainActor @Observable
public final class FolderBrowserModel {
  public private(set) var listing: FolderListing?
  public private(set) var loading = false
  public private(set) var error: String?
  /// The folder being looked at; nil: the starting point.
  public private(set) var at: String?

  @ObservationIgnored private let api: any APISending
  @ObservationIgnored private let request: FolderBrowseRequest
  @ObservationIgnored private let rootLabel: String?

  /// `request`: the connection and/or saved source to browse (no path); empty for this server.
  public init(request: FolderBrowseRequest, start: String?, rootLabel: String? = nil, api: any APISending) {
    self.request = request
    self.rootLabel = rootLabel
    self.api = api
    at = start
  }

  var remote: Bool { request.connection.map { $0.access != .local } ?? false }

  public func load() async {
    loading = true
    defer { loading = false }
    var asked = request
    asked.path = at
    do {
      listing = try await api.send(API.Settings.browseFolders(asked))
      error = nil
    } catch {
      self.error = failureText(error)
    }
  }

  public func open(_ path: String?) async {
    at = path
    await load()
  }

  /// On this server, "up" from a root goes back to the list of roots; on another machine "/" is the top.
  public var canGoUp: Bool {
    guard let listing, listing.path != nil else { return false }
    return listing.parent != nil || !remote
  }

  public func up() async {
    guard canGoUp else { return }
    await open(listing?.parent)
  }

  /// The line above the list.
  public var title: String {
    if let path = listing?.path { return path == "/" && rootLabel != nil ? rootLabel ?? path : path }
    if remote { return loading ? "Connecting…" : "" }
    return "Folders Playarr may use"
  }

  /// A folder that can be chosen is on screen (not the list of roots, not an SMB server's shares).
  public var choosable: String? {
    guard let path = listing?.path, !(rootLabel != nil && path == "/") else { return nil }
    return path
  }

  public var emptyText: String? {
    guard let listing, listing.folders.isEmpty, listing.emptyRoot != true else { return nil }
    return rootLabel != nil && listing.path == "/" ? "No shares found." : "No folders inside."
  }

  /// "12 audio files here · selected".
  public func footer(selected: String?) -> String? {
    guard let listing, let path = choosable else { return nil }
    return "\(AdminText.plural(listing.audioFiles, "audio file")) here\(selected == path ? " · selected" : "")"
  }

  /// A root with nothing in it: in Docker, nothing is mounted there yet.
  public var emptyRootHelp: (title: String, detail: String)? {
    guard let listing, listing.emptyRoot == true, let path = listing.path else { return nil }
    return (
      "Nothing is shared with Playarr at \(path) yet.",
      "In Docker, Playarr only sees the host folders you mount inside \(path). Mount them read-only in a compose.override.yaml next to compose.yaml, for example /volume2:\(path)/volume2:ro, then restart Playarr."
    )
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter SourceFormTests
```

Expected: `Test run with 11 tests in 1 suite passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/Admin/Sources/LidarrFormModel.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/Admin/Sources/FolderFormModel.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/Admin/Sources/FolderBrowserModel.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/Admin/SourceFormTests.swift
git commit -F - <<'MSG'
iOS: the source forms' models: Lidarr with a connection test, and folders on this server, over SSH or SFTP or on an SMB share, with a folder browser

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 6: Sources: reviewing doubtful matches

**Files:**
- Create: `UI/Settings/Admin/Sources/ReviewText.swift`, `UI/Settings/Admin/Sources/ReviewModel.swift`
- Modify: `UITests/Admin/Samples.swift` (append)
- Test: `UITests/Admin/ReviewModelTests.swift`

Ports `ReviewDialog.tsx` and `useReview`/`useReviewAction` (`queries.ts:560-606`). The screen shows one album at a time. Its candidates come with a summary line ("Massive Attack · 20 Apr 1998 · United Kingdom · Virgin · CD · 2 tracks") and a score. The chosen edition's details have placeholders while MusicBrainz fills them in, and your files sit beside its songs. The actions are a search with other names, "Fix names", "Leave unmatched" (`releaseId: null`) and "Use this album". A decision takes the album off the list at once, and the next one shows while it saves. The note above says "Saving: …", then "Saved: …" (gone after 4 s), or "Couldn’t save …: <error>. It’s back in the list." with the album back.

**Step 1: Write the failing test**

Append to `UITests/Admin/Samples.swift`:

```swift
extension Samples {
  static func candidate(_ id: String, title: String = "Mezzanine", score: Double = 0.92, detailed: Bool = true) -> ReviewCandidate {
    ReviewCandidate(
      releaseId: id, releaseGroupId: "rg-\(id)", title: title, artistName: "Massive Attack", year: 1998,
      date: detailed ? "1998-04-20" : nil, country: detailed ? "GB" : nil, status: "Official", format: detailed ? "CD" : nil,
      labels: detailed ? [.init(name: "Virgin", catalogNumber: "WBRCD4")] : nil, detailed: detailed, score: score,
      tracks: [.init(disc: 1, position: 1, title: "Angel", duration: 379), .init(disc: 1, position: 2, title: "Risingson", duration: 298)],
      matches: ["01 Angel.flac": 0])
  }

  static func group(_ key: String, album: String? = "Mezzanine", candidates: [ReviewCandidate]) -> ReviewGroup {
    ReviewGroup(
      groupKey: key, artistName: "Massive Attack", albumTitle: album,
      files: [
        .init(rel: "01 Angel.flac", title: "Angel", trackNumber: 1, discNumber: 1, duration: 380),
        .init(rel: "02 Risingson.flac", title: "Risingson", trackNumber: 2, discNumber: 1, duration: 299),
      ],
      candidates: candidates)
  }
}
```

`UITests/Admin/ReviewModelTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct ReviewModelTests {
  let api = FakeAPI()
  let clock = TestClock()
  let path = "/api/settings/sources/2/review"

  func model() -> ReviewModel { ReviewModel(sourceId: 2, api: api, clock: clock) }

  @Test func describesACandidateLikeTheWeb() {
    let gb = Locale(identifier: "en_GB")
    let c = Samples.candidate("r1")
    #expect(ReviewText.summary(c, locale: gb) == "Massive Attack · 20 Apr 1998 · United Kingdom · Virgin · CD · 2 tracks")
    #expect(ReviewText.releaseDate("1998-04", locale: gb) == "Apr 1998")
    #expect(ReviewText.releaseDate("1998", locale: gb) == "1998")
    #expect(ReviewText.countryName("XW") == "Worldwide")
    #expect(ReviewText.score(c) == "92%")
    let group = Samples.group("g1", candidates: [c])
    #expect(ReviewText.matched(group.files[0], in: c) == "1. Angel 6:19")
    #expect(ReviewText.matched(group.files[1], in: c) == nil)
    let loading = ReviewText.details(Samples.candidate("r2", detailed: false), locale: gb)
    #expect(loading.map(\.label) == ["Artist", "Album", "Released", "First released", "Country", "Label", "Format", "Status", "Tracks"])
    #expect(loading.first { $0.label == "Released" }?.value == nil)
  }

  @Test func startsWithTheBestCandidateAndTheFilesNames() async {
    let review = model()
    api.on(.get, path, [Samples.group("g1", candidates: [Samples.candidate("r1"), Samples.candidate("r2", score: 0.5)])])
    await review.load()
    #expect(review.chosen == "r1")
    #expect(review.artist == "Massive Attack" && review.album == "Mezzanine")
    #expect(review.titles == ["01 Angel.flac": "Angel", "02 Risingson.flac": "Risingson"])
    review.chosen = "r2"
    await review.load()
    #expect(review.chosen == "r2")
  }

  @Test func usesTheChosenAlbumAndShowsTheNextAtOnce() async {
    let review = model()
    api.on(.get, path, [Samples.group("g1", candidates: [Samples.candidate("r1")]), Samples.group("g2", album: "Protection", candidates: [])])
    await review.load()
    api.on(.post, path, json: "")
    api.on(.get, path, [Samples.group("g2", album: "Protection", candidates: [])])
    await review.useChosen()
    #expect(api.bodies(.post, path) == [#"{"groupKey":"g1","releaseId":"r1"}"#])
    #expect(review.current?.groupKey == "g2" && review.album == "Protection")
    #expect(review.saved?.line == "Saved: Mezzanine · Massive Attack")
    #expect(await clock.nextSleep() == .seconds(4))
    clock.advance(by: .seconds(4))
    await review.noteTask?.value
    #expect(review.saved == nil)
  }

  @Test func leavesAnAlbumUnmatchedWithNull() async {
    let review = model()
    api.on(.get, path, [Samples.group("g1", candidates: [])])
    await review.load()
    api.on(.post, path, json: "")
    api.on(.get, path, [ReviewGroup]())
    await review.leaveUnmatched()
    #expect(api.bodies(.post, path) == [#"{"groupKey":"g1","releaseId":null}"#])
    #expect(review.current == nil)
    #expect(review.saved?.line == "Saved: Mezzanine · Massive Attack left unmatched")
  }

  @Test func putsTheAlbumBackWhenSavingFails() async {
    let review = model()
    api.on(.get, path, [Samples.group("g1", candidates: [Samples.candidate("r1")])])
    await review.load()
    api.fail(.post, path, status: 500, "The database is locked")
    await review.useChosen()
    #expect(review.current?.groupKey == "g1")
    #expect(review.saved?.line == "Couldn’t save Mezzanine · Massive Attack: The database is locked. It’s back in the list.")
  }

  @Test func searchesWithOtherNamesAndKeepsTheAlbumOnScreen() async {
    let review = model()
    api.on(.get, path, [Samples.group("g1", candidates: [])])
    await review.load()
    review.artist = " Massive Attack "
    review.album = ""
    #expect(!review.canSearch)
    review.album = "Mezzanine (Deluxe)"
    api.on(.post, path, json: "")
    api.on(.get, path, [Samples.group("g1", candidates: [Samples.candidate("r9")])])
    await review.search()
    #expect(api.bodies(.post, path) == [#"{"groupKey":"g1","search":{"album":"Mezzanine (Deluxe)","artist":"Massive Attack"}}"#])
    #expect(review.chosen == "r9" && !review.searching)
  }

  @Test func savesNamesFixedByHand() async {
    let review = model()
    api.on(.get, path, [Samples.group("g1", candidates: [])])
    await review.load()
    review.fixing = true
    review.titles["02 Risingson.flac"] = "Risingson (Remastered)"
    api.on(.post, path, json: "")
    api.on(.get, path, [ReviewGroup]())
    await review.saveNames()
    #expect(api.bodies(.post, path) == [
      #"{"groupKey":"g1","names":{"album":"Mezzanine","artist":"Massive Attack","titles":{"01 Angel.flac":"Angel","02 Risingson.flac":"Risingson (Remastered)"}}}"#,
    ])
    #expect(review.saved?.line == "Saved: Mezzanine · Massive Attack: names saved")
  }

  @Test func pollsWhileEditionDetailsAreComing() async {
    let review = model()
    api.on(.get, path, [Samples.group("g1", candidates: [Samples.candidate("r1", detailed: false)])])
    api.then(.get, path, [Samples.group("g1", candidates: [Samples.candidate("r1")])])
    let polling = Task { await review.poll() }
    #expect(await clock.nextSleep() == .seconds(2))
    clock.advance(by: .seconds(2))
    await polling.value
    #expect(api.calls(.get, path).count == 2)
    #expect(review.candidate?.detailed == true)
  }

  @Test func asksTheViewToPollAgainWhenASearchBringsUndetailedCandidates() async {
    let review = model()
    api.on(.get, path, [Samples.group("g1", candidates: [])])
    await review.load()
    let round = review.pollRound
    review.album = "Mezzanine"
    api.on(.post, path, json: "")
    api.on(.get, path, [Samples.group("g1", candidates: [Samples.candidate("r9", detailed: false)])])
    await review.search()
    #expect(review.pollRound == round + 1)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter ReviewModelTests
```

Expected: the build fails with `cannot find 'ReviewModel' in scope` and `cannot find 'ReviewText' in scope`.

**Step 3: Implement**

`UI/Settings/Admin/Sources/ReviewText.swift`:

```swift
import Foundation
import PlayarrAPI

/// How "Review matches" describes a MusicBrainz candidate (ReviewDialog.tsx: summary, CandidateDetails).
enum ReviewText {
  /// "Mezzanine · Massive Attack": what the files say.
  static func yourAlbum(_ group: ReviewGroup) -> String { "\(group.albumTitle ?? "No album") · \(group.artistName)" }

  /// MusicBrainz country codes, including its own XE (Europe) and XW (worldwide).
  static func countryName(_ code: String?, locale: Locale = .current) -> String? {
    guard let code, !code.isEmpty else { return nil }
    switch code {
    case "XE": return "Europe"
    case "XW": return "Worldwide"
    case "XU": return nil
    default: return locale.localizedString(forRegionCode: code) ?? code
    }
  }

  /// "1998-04-20" → "20 Apr 1998", "1998-04" → "Apr 1998", "1998" stays (in the device's way).
  static func releaseDate(_ date: String?, locale: Locale = .current) -> String? {
    guard let date else { return nil }
    let parts = date.split(separator: "-").map { Int($0) ?? 0 }
    guard let year = parts.first, year > 0 else { return date }
    guard parts.count > 1, parts[1] > 0 else { return String(year) }
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt
    let day = parts.count > 2 ? parts[2] : 0
    guard let value = calendar.date(from: DateComponents(year: year, month: parts[1], day: max(day, 1))) else { return date }
    var style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone).year().month(.abbreviated)
    if day > 0 { style = style.day() }
    return value.formatted(style)
  }

  /// The second line of a candidate: who, when, where, on what.
  static func summary(_ c: ReviewCandidate, locale: Locale = .current) -> String {
    [
      c.artistName,
      releaseDate(c.date, locale: locale) ?? c.year.map(String.init),
      countryName(c.country, locale: locale),
      c.labels?.first(where: { $0.name != nil })?.name,
      c.format,
      c.type,
      AdminText.plural(c.tracks.count, "track"),
      c.status != nil && c.status != "Official" ? c.status : nil,
    ].compactMap { $0 }.joined(separator: " · ")
  }

  static func score(_ c: ReviewCandidate) -> String { "\(Int((c.score * 100).rounded()))%" }

  /// Rows that only arrive with the edition details: shown as placeholders (nil) while those load.
  static let detailRows: Set<String> = ["Released", "Country", "Label", "Format"]

  /// Everything MusicBrainz says about the chosen edition. A nil value is a placeholder while details load.
  static func details(_ c: ReviewCandidate, locale: Locale = .current) -> [(label: String, value: String?)] {
    let released = releaseDate(c.date, locale: locale)
    let firstYear = c.year.flatMap { year in released?.hasSuffix(String(year)) == false ? String(year) : nil }
    let labels = c.labels?.map { [$0.name, $0.catalogNumber].compactMap { $0 }.joined(separator: " · ") }.joined(separator: ", ")
    let edition = [c.releaseTitle, c.disambiguation].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    let rows: [(String, String?)] = [
      ("Artist", c.artistName),
      ("Album", c.title),
      ("Edition", edition.isEmpty ? nil : edition),
      ("Released", released),
      ("First released", firstYear ?? (c.date == nil ? c.year.map(String.init) : nil)),
      ("Country", countryName(c.country, locale: locale)),
      ("Label", labels?.isEmpty == false ? labels : nil),
      ("Format", c.format),
      ("Type", c.type),
      ("Status", c.status),
      ("Tracks", String(c.tracks.count)),
      ("Barcode", c.barcode),
    ]
    return rows.filter { $0.1 != nil || (!c.detailed && detailRows.contains($0.0)) }.map { (label: $0.0, value: $0.1) }
  }

  /// Each file beside the candidate's song it was matched to: "1. Angel 6:19", or nil (not on this album).
  static func matched(_ file: ReviewFile, in c: ReviewCandidate) -> String? {
    guard let index = c.matches[file.rel], c.tracks.indices.contains(index) else { return nil }
    let track = c.tracks[index]
    return "\(track.position). \(track.title) \(AdminText.time(track.duration))"
  }

  static func musicBrainzURL(_ c: ReviewCandidate) -> URL? {
    URL(string: "https://musicbrainz.org/release/\(c.releaseId.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-"))) ?? c.releaseId)")
  }
}
```

`UI/Settings/Admin/Sources/ReviewModel.swift`:

```swift
import Foundation
import Observation
import PlayarrAPI

/// Settings → Sources → "N albums to review": one doubtful album at a time; use a MusicBrainz candidate,
/// search with other names, fix the names by hand, or leave it unmatched (ReviewDialog). A decision shows
/// the next album at once while it saves above it; a failed save puts the album back.
@MainActor @Observable
public final class ReviewModel {
  /// What happened to the last album decided on, shown above the next one.
  public struct Saved: Equatable {
    public enum State: Equatable { case saving, done, failed(String) }
    let id: Int
    public let text: String
    public var state: State

    public var line: String {
      switch state {
      case .saving: "Saving: \(text)…"
      case .done: "Saved: \(text)"
      case .failed(let error): "Couldn’t save \(text): \(error). It’s back in the list."
      }
    }
  }

  public private(set) var groups: [ReviewGroup]?
  public private(set) var loadError: String?
  public private(set) var saved: Saved?
  public private(set) var searching = false
  /// Why the last search failed.
  public private(set) var error: String?

  // The album on screen: the candidate chosen, and the names typed.
  public var chosen: String?
  public var artist = ""
  public var album = ""
  public var fixing = false
  public var titles: [String: String] = [:]

  /// Bumped when details are missing again after polling stopped: the view restarts `poll()` with it.
  public private(set) var pollRound = 0

  @ObservationIgnored let sourceId: Int
  @ObservationIgnored private let api: any APISending
  @ObservationIgnored private let clock: any Clock<Duration>
  @ObservationIgnored private let sourcesChanged: @MainActor () -> Void
  @ObservationIgnored private var hidden: Set<String> = []
  @ObservationIgnored private var editing: String?
  @ObservationIgnored private var updates = 0
  @ObservationIgnored private var polling = false
  @ObservationIgnored private var counter = 0
  @ObservationIgnored var noteTask: Task<Void, Never>?

  /// How many times to ask again while MusicBrainz details are still coming (every 2 s: about a minute).
  static let detailPolls = 30

  public init(sourceId: Int, api: any APISending, clock: any Clock<Duration> = ContinuousClock(), sourcesChanged: @escaping @MainActor () -> Void = {}) {
    self.sourceId = sourceId
    self.api = api
    self.clock = clock
    self.sourcesChanged = sourcesChanged
  }

  /// The albums still to decide on: those being saved stay off the list.
  public var visible: [ReviewGroup]? { groups?.filter { !hidden.contains($0.groupKey) } }
  public var current: ReviewGroup? { visible?.first }
  public var remaining: Int { visible?.count ?? 0 }
  public var candidate: ReviewCandidate? { current?.candidates.first { $0.releaseId == chosen } }

  /// The server fetches edition details in the background for the album on screen and the next one.
  var needsDetails: Bool {
    (groups ?? []).prefix(2).contains { $0.candidates.contains { !$0.detailed } }
  }

  var pollInterval: Duration? { needsDetails && updates < Self.detailPolls ? .seconds(2) : nil }

  public func poll() async {
    polling = true
    defer { polling = false }
    await Polling.run(clock: clock, interval: { [weak self] in self?.pollInterval }) { [weak self] in await self?.load() }
  }

  public func load() async {
    do {
      apply(try await api.send(API.Settings.review(sourceId: sourceId)))
      loadError = nil
    } catch {
      loadError = failureText(error)
    }
  }

  public var canSearch: Bool { !searching && !artist.trimmed.isEmpty && !album.trimmed.isEmpty }
  public var canRename: Bool { !artist.trimmed.isEmpty && !album.trimmed.isEmpty }

  /// Look for other candidates with these names; the album stays on screen until they're in.
  public func search() async {
    guard let group = current, canSearch else { return }
    searching = true
    error = nil
    defer { searching = false }
    do {
      _ = try await api.send(API.Settings.reviewAction(sourceId: sourceId, ReviewAction(groupKey: group.groupKey, search: .init(artist: artist.trimmed, album: album.trimmed))))
      await load()
    } catch {
      self.error = failureText(error)
    }
  }

  public func useChosen() async {
    guard let group = current, let candidate else { return }
    await decide(group, ReviewAction(groupKey: group.groupKey, releaseId: .some(candidate.releaseId)), "\(candidate.title) · \(candidate.artistName)")
  }

  public func leaveUnmatched() async {
    guard let group = current else { return }
    await decide(group, ReviewAction(groupKey: group.groupKey, releaseId: .some(nil)), "\(ReviewText.yourAlbum(group)) left unmatched")
  }

  /// "Save names": the user's own artist, album and song titles, used without a MusicBrainz match.
  public func saveNames() async {
    guard let group = current, canRename else { return }
    let names = ReviewAction.Names(artist: artist.trimmed, album: album.trimmed, titles: titles)
    await decide(group, ReviewAction(groupKey: group.groupKey, names: names), "\(names.album) · \(names.artist): names saved")
  }

  private func decide(_ group: ReviewGroup, _ action: ReviewAction, _ text: String) async {
    counter += 1
    let id = counter
    saved = Saved(id: id, text: text, state: .saving)
    hidden.insert(group.groupKey)
    resetEditing()
    do {
      _ = try await api.send(API.Settings.reviewAction(sourceId: sourceId, action))
      groups?.removeAll { $0.groupKey == group.groupKey }
      hidden.remove(group.groupKey)
      if saved?.id == id { saved?.state = .done }
      dropNoteLater(id)
      sourcesChanged()
      await load()
    } catch {
      hidden.remove(group.groupKey)
      resetEditing()
      if saved?.id == id { saved?.state = .failed(failureText(error)) }
    }
  }

  /// "Saved" goes after a moment; errors stay until the next decision.
  private func dropNoteLater(_ id: Int) {
    noteTask?.cancel()
    noteTask = Task { [weak self, clock] in
      do { try await clock.sleep(for: .seconds(4)) } catch { return }
      guard let self, self.saved?.id == id, self.saved?.state == .done else { return }
      self.saved = nil
    }
  }

  private func apply(_ list: [ReviewGroup]) {
    groups = list
    updates += 1
    resetEditing()
    if needsDetails, !polling {
      updates = 0
      pollRound += 1
    }
  }

  /// A new album on screen starts with its best candidate and its own names; background refreshes keep the choice.
  private func resetEditing() {
    guard let group = current else {
      editing = nil
      return
    }
    if editing != group.groupKey {
      editing = group.groupKey
      chosen = group.candidates.first?.releaseId
      artist = group.artistName
      album = group.albumTitle ?? ""
      fixing = false
      titles = Dictionary(group.files.map { ($0.rel, $0.title) }, uniquingKeysWith: { first, _ in first })
    } else if !group.candidates.contains(where: { $0.releaseId == chosen }) {
      chosen = group.candidates.first?.releaseId
    }
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter ReviewModelTests
```

Expected: `Test run with 9 tests in 1 suite passed`. `describesACandidateLikeTheWeb` pins the `en_GB` locale: "United Kingdom" and "20 Apr 1998" come from Foundation's data for it.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/Admin/Sources/ReviewText.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/Admin/Sources/ReviewModel.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/Admin/Samples.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/Admin/ReviewModelTests.swift
git commit -F - <<'MSG'
iOS: the review model for doubtful matches: candidates, search, fix names, use an album or leave it unmatched, the next album at once

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 7: Sources: organize files, the AcoustID key and the MusicBrainz queue

**Files:**
- Create: `UI/Settings/Admin/Sources/OrganizeModel.swift`, `UI/Settings/Admin/Sources/MatchingModel.swift`, `UI/Settings/Admin/Sources/MusicBrainzQueueModel.swift`
- Test: `UITests/Admin/OrganizeAndMatchingTests.swift`

Ports `OrganizeDialog.tsx` with `useOrganizeActions` (the moves Playarr is sure of start ticked, grouped "Artist · Album" in the plan's order; Move sends the ticked `from` paths in that order; then "Moved N files; K skipped", Undo and "Put N files back"). It also ports `MatchingSection` (`SourcesPanel.tsx:218-275`) and the sidebar's MusicBrainz line (`Nav.tsx:220-232`).

**Step 1: Write the failing test**

`UITests/Admin/OrganizeAndMatchingTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct OrganizeAndMatchingTests {
  let api = FakeAPI()
  let path = "/api/settings/sources/2/organize"

  var plan: OrganizePlan {
    OrganizePlan(
      writable: true,
      moves: [
        OrganizeMove(from: "a.flac", to: "Massive Attack/Mezzanine/01 Angel.flac", artist: "Massive Attack", album: "Mezzanine", confident: true),
        OrganizeMove(from: "b.flac", to: "Massive Attack/Mezzanine/02 Risingson.flac", artist: "Massive Attack", album: "Mezzanine", confident: false),
        OrganizeMove(from: "c.flac", to: "Portishead/Dummy/01 Mysterons.flac", artist: "Portishead", album: "Dummy", confident: true),
      ],
      skipped: [OrganizeSkip(from: "d.flac", reason: "Already exists")],
      lastBatch: .init(id: 7, files: 12, at: "2026-11-03T10:00:00Z"))
  }

  @Test func ticksTheSureMovesAndGroupsThemByAlbum() async {
    let organize = OrganizeModel(sourceId: 2, api: api)
    api.on(.get, path, plan)
    await organize.load()
    #expect(organize.chosen == ["a.flac", "c.flac"])
    #expect(organize.albums.map(\.title) == ["Massive Attack · Mezzanine", "Portishead · Dummy"])
    #expect(organize.selectionText == "2 of 3 moves selected")
    #expect(organize.applyLabel == "Move 2 files")
    #expect(organize.skippedTitle == "1 file can’t move")
    organize.chooseNone()
    #expect(!organize.canApply)
    organize.chooseAll()
    #expect(organize.chosen.count == 3)
  }

  @Test func movesTheTickedFilesInTheirOrderAndSaysHowMany() async {
    var libraryChanges = 0
    let organize = OrganizeModel(sourceId: 2, api: api) { libraryChanges += 1 }
    api.on(.get, path, plan)
    await organize.load()
    organize.toggle(plan.moves[1])
    organize.toggle(plan.moves[2])
    api.on(.post, path, OrganizeResult(batchId: 8, moved: 2, skipped: [OrganizeSkip(from: "b.flac", reason: "Gone")]))
    await organize.apply()
    #expect(api.bodies(.post, path) == [#"{"moves":["a.flac","b.flac"]}"#])
    #expect(organize.notice == "Moved 2 files; 1 skipped")
    #expect(libraryChanges == 1)
  }

  @Test func undoesTheLastBatch() async {
    let organize = OrganizeModel(sourceId: 2, api: api)
    api.on(.get, path, plan)
    await organize.load()
    api.on(.post, "\(path)/undo", json: #"{"restored":12}"#)
    await organize.undo()
    #expect(api.bodies(.post, "\(path)/undo") == [#"{"batchId":7}"#])
    #expect(organize.notice == "Put 12 files back")
    api.fail(.post, "\(path)/undo", status: 409, "Those files were moved again since")
    await organize.undo()
    #expect(organize.notice == "Those files were moved again since" && organize.failed)
  }

  @Test func savesAnAcoustIDKeyAndHidesTheField() async {
    let matching = MatchingModel(api: api)
    api.on(.get, "/api/settings/matching", MatchingSettings(acoustid: false, fingerprints: true))
    await matching.load()
    #expect(matching.editing && !matching.canSave)
    matching.key = "k3y"
    api.on(.put, "/api/settings/matching", MatchingSettings(acoustid: true, fingerprints: true))
    await matching.save()
    #expect(api.bodies(.put, "/api/settings/matching") == [#"{"acoustidKey":"k3y"}"#])
    #expect(!matching.editing && matching.key.isEmpty)
    matching.replacing = true
    #expect(matching.editing)
  }

  @Test func showsTheMusicBrainzQueueOnlyWhileLookupsWait() async {
    let clock = TestClock()
    let queue = MusicBrainzQueueModel(api: api, clock: clock)
    api.on(.get, "/api/musicbrainz/status", MusicBrainzStatus(queued: 12, background: 10, etaSeconds: 14, matching: 3))
    api.then(.get, "/api/musicbrainz/status", MusicBrainzStatus(queued: 0, background: 0, etaSeconds: 0, matching: 0))
    let polling = Task { await queue.poll() }
    #expect(await clock.nextSleep() == .milliseconds(1500))
    #expect(queue.line == "MusicBrainz · 12 queued")
    #expect(queue.detail == "About 14 s of MusicBrainz lookups waiting (it answers about once a second); 10 of them identifying your folder music")
    clock.advance(by: .milliseconds(1500))
    #expect(await clock.nextSleep() == .seconds(15))
    #expect(queue.line == nil)
    polling.cancel()
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter OrganizeAndMatchingTests
```

Expected: the build fails with `cannot find 'OrganizeModel' in scope` (and the other two).

**Step 3: Implement**

`UI/Settings/Admin/Sources/OrganizeModel.swift`:

```swift
import Foundation
import Observation
import PlayarrAPI

/// Settings → Sources → Organize files: the moves Playarr proposes into Artist/Album/NN Title, which to
/// apply (the sure ones start ticked), and undo of the last batch (OrganizeDialog).
@MainActor @Observable
public final class OrganizeModel {
  public private(set) var plan: OrganizePlan?
  public private(set) var loadError: String?
  /// The moves ticked, by their `from` path.
  public private(set) var chosen: Set<String> = []
  public private(set) var working = false
  /// What the last apply or undo did, or why it failed.
  public private(set) var notice: String?
  public private(set) var failed = false

  @ObservationIgnored private let sourceId: Int
  @ObservationIgnored private let api: any APISending
  @ObservationIgnored private let libraryChanged: @MainActor () -> Void

  public static let intro =
    "Files move into Artist/Album/NN Title, inside this folder only. Nothing is overwritten, tags aren’t changed, and you can undo. Moves Playarr is less sure about start unchecked."
  public static let notWritable =
    "Playarr can’t write to this folder, so it can’t move files. In Docker, mount the folder you want organized read-write (the broad /host mount stays read-only)."

  public init(sourceId: Int, api: any APISending, libraryChanged: @escaping @MainActor () -> Void = {}) {
    self.sourceId = sourceId
    self.api = api
    self.libraryChanged = libraryChanged
  }

  public func load() async {
    do {
      let plan = try await api.send(API.Settings.organizePlan(sourceId: sourceId))
      self.plan = plan
      chosen = Set(plan.moves.filter(\.confident).map(\.from))
      loadError = nil
    } catch {
      loadError = failureText(error)
    }
  }

  /// The moves by album, in the plan's order: "Massive Attack · Mezzanine".
  public var albums: [(title: String, moves: [OrganizeMove])] {
    var order: [String] = []
    var byTitle: [String: [OrganizeMove]] = [:]
    for move in plan?.moves ?? [] {
      let title = "\(move.artist) · \(move.album ?? "No album")"
      if byTitle[title] == nil { order.append(title) }
      byTitle[title, default: []].append(move)
    }
    return order.map { (title: $0, moves: byTitle[$0] ?? []) }
  }

  public func toggle(_ move: OrganizeMove) {
    if chosen.contains(move.from) { chosen.remove(move.from) } else { chosen.insert(move.from) }
  }

  public func chooseAll() { chosen = Set(plan?.moves.map(\.from) ?? []) }
  public func chooseNone() { chosen = [] }

  /// "3 of 12 moves selected".
  public var selectionText: String {
    "\(chosen.count) of \(AdminText.plural(plan?.moves.count ?? 0, "move")) selected"
  }

  /// "Move 3 files", or "Moving…".
  public var applyLabel: String { working ? "Moving…" : "Move \(AdminText.plural(chosen.count, "file"))" }
  public var canApply: Bool { !chosen.isEmpty && !working }

  /// "Last change: 12 files moved <date>".
  public var lastBatchText: String? {
    guard let batch = plan?.lastBatch else { return nil }
    return "Last change: \(AdminText.plural(batch.files, "file")) moved \(AdminText.dateTime(batch.at))"
  }

  /// "3 files can’t move".
  public var skippedTitle: String? {
    guard let skipped = plan?.skipped, !skipped.isEmpty else { return nil }
    return "\(AdminText.plural(skipped.count, "file")) can’t move"
  }

  public func apply() async {
    guard canApply, let moves = plan?.moves else { return }
    await work {
      let result = try await api.send(API.Settings.organize(sourceId: sourceId, moves: moves.map(\.from).filter(chosen.contains)))
      return "Moved \(AdminText.plural(result.moved, "file"))\(result.skipped.isEmpty ? "" : "; \(result.skipped.count) skipped")"
    }
  }

  public func undo() async {
    guard let batch = plan?.lastBatch, !working else { return }
    await work {
      let result = try await api.send(API.Settings.undoOrganize(sourceId: sourceId, batchId: batch.id))
      return "Put \(AdminText.plural(result.restored, "file")) back"
    }
  }

  private func work(_ call: () async throws -> String) async {
    working = true
    defer { working = false }
    do {
      notice = try await call()
      failed = false
      libraryChanged()
      await load()
    } catch {
      notice = failureText(error)
      failed = true
    }
  }
}
```

`UI/Settings/Admin/Sources/MatchingModel.swift`:

```swift
import Foundation
import Observation
import PlayarrAPI

/// Settings → Sources → Identifying songs: the AcoustID key (the key itself never comes back).
@MainActor @Observable
public final class MatchingModel {
  public private(set) var settings: MatchingSettings?
  public var replacing = false
  public var key = ""
  public private(set) var saving = false
  public var error: String?

  @ObservationIgnored private let api: any APISending

  public static let intro =
    "Playarr matches folder albums on MusicBrainz by their names, track titles and lengths. For songs whose names don’t help, it can identify them by their sound with AcoustID. A free key comes from acoustid.org."
  public static let noFingerprints = "Fingerprints need fpcalc (Chromaprint) on the server. The Docker image includes it."
  public static let keyPage = URL(string: "https://acoustid.org/new-application")

  public init(api: any APISending) {
    self.api = api
  }

  /// The key field shows when no key is saved, or after "Replace".
  public var editing: Bool { replacing || settings?.acoustid == false }
  public var canSave: Bool { !key.isEmpty && !saving }

  public func load() async {
    settings = try? await api.send(API.Settings.matching())
  }

  public func save() async {
    guard canSave else { return }
    saving = true
    error = nil
    defer { saving = false }
    do {
      settings = try await api.send(API.Settings.saveMatching(acoustidKey: key))
      replacing = false
      key = ""
    } catch {
      self.error = failureText(error)
    }
  }
}
```

`UI/Settings/Admin/Sources/MusicBrainzQueueModel.swift`:

```swift
import Foundation
import Observation
import PlayarrAPI

/// The MusicBrainz queue, as the web's sidebar shows it: only while lookups wait. Polled every 1.5 s
/// while they do, every 15 s otherwise.
@MainActor @Observable
public final class MusicBrainzQueueModel {
  public private(set) var status: MusicBrainzStatus?

  @ObservationIgnored private let api: any APISending
  @ObservationIgnored private let clock: any Clock<Duration>

  public init(api: any APISending, clock: any Clock<Duration> = ContinuousClock()) {
    self.api = api
    self.clock = clock
  }

  var pollInterval: Duration { (status?.queued ?? 0) > 0 ? .milliseconds(1500) : .seconds(15) }

  public func poll() async {
    await Polling.run(clock: clock, interval: { [weak self] in self?.pollInterval }) { [weak self] in await self?.load() }
  }

  public func load() async {
    if let status = try? await api.send(API.Server.musicBrainzStatus()) { self.status = status }
  }

  /// "MusicBrainz · 12 queued", while lookups wait.
  public var line: String? {
    guard let status, status.queued > 0 else { return nil }
    return "MusicBrainz · \(status.queued) queued"
  }

  /// The web's tooltip: how long, and how much of it is identifying folder music.
  public var detail: String? {
    guard let status, status.queued > 0 else { return nil }
    let background = status.background > 0 ? "; \(status.background) of them identifying your folder music" : ""
    return "About \(AdminText.wait(status.etaSeconds)) of MusicBrainz lookups waiting (it answers about once a second)\(background)"
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter OrganizeAndMatchingTests
```

Expected: `Test run with 5 tests in 1 suite passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/Admin/Sources/OrganizeModel.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/Admin/Sources/MatchingModel.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/Admin/Sources/MusicBrainzQueueModel.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/Admin/OrganizeAndMatchingTests.swift
git commit -F - <<'MSG'
iOS: models for organizing a folder's files (pick the moves, undo), the AcoustID key and the MusicBrainz queue

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 8: The Sources screens

**Files:**
- Create: `UI/Settings/Admin/Support/AdminFields.swift`, `UI/Settings/Admin/Support/InlineMessage.swift`
- Create: `UI/Settings/Admin/Sources/SourcesPanel.swift`, `MatchingSection.swift`, `SourceFormView.swift`, `LidarrFormView.swift`, `FolderFormView.swift`, `FolderBrowserView.swift`, `ReviewView.swift`, `OrganizeView.swift` (all in `UI/Settings/Admin/Sources/`)

The list follows the web's row: icon, name, "OFF", where it is and how many songs, the status line in its colour, and "N albums to review". Actions sit in the row's context menu: Rescan, Match again, Organize files, Edit and Remove. The same actions are on swipes: Remove and Edit trailing, Rescan leading. Remove asks with the web's text. The Edit button turns on dragging. Forms are sheets: "Add source" first offers Lidarr (off once one is added, with the web's reason) or Folder. Review and Organize are sheets too. iOS-only text-field modifiers are behind `#if os(iOS)` in `AdminFields.swift`, so the package still builds for the Mac (`swift test`).

**Step 1: Write the views**

`UI/Settings/Admin/Support/AdminFields.swift`:

```swift
import SwiftUI

/// Text-field behaviour the admin forms share: no capitals or corrections for names of things, URLs and keys.
extension View {
  func adminPlainField() -> some View {
    #if os(iOS)
    textInputAutocapitalization(.never).autocorrectionDisabled()
    #else
    autocorrectionDisabled()
    #endif
  }

  func adminURLField() -> some View {
    #if os(iOS)
    adminPlainField().keyboardType(.URL).textContentType(.URL)
    #else
    adminPlainField()
    #endif
  }

  func adminNumberField() -> some View {
    #if os(iOS)
    keyboardType(.numberPad)
    #else
    self
    #endif
  }
}
```

`UI/Settings/Admin/Support/InlineMessage.swift`:

```swift
import SwiftUI

/// A panel's message in place: what a change did, or the server's `{ error }` when it failed.
struct InlineMessage: View {
  let text: String
  var isError = true

  var body: some View {
    Label(text, systemImage: isError ? "exclamationmark.triangle" : "checkmark.circle")
      .font(.footnote)
      .foregroundStyle(isError ? Color.red : Color.secondary)
      .accessibilityIdentifier(isError ? "admin.error" : "admin.notice")
  }
}
```

`UI/Settings/Admin/Sources/SourcesPanel.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// Settings → Sources: the sources in priority order (drag to reorder), each with Rescan, Match again,
/// Organize files, Edit and Remove; review of doubtful matches; the AcoustID key; the MusicBrainz queue.
public struct SourcesPanel: View {
  enum Sheet: Identifiable {
    case add, edit(SourceInfo), review(Int), organize(Int)

    var id: String {
      switch self {
      case .add: "add"
      case .edit(let source): "edit-\(source.id)"
      case .review(let id): "review-\(id)"
      case .organize(let id): "organize-\(id)"
      }
    }
  }

  @State private var model: SourcesModel
  @State private var queue: MusicBrainzQueueModel
  @State private var matching: MatchingModel
  @State private var sheet: Sheet?
  @State private var removing: SourceInfo?
  private let api: any APISending
  private let libraryChanged: @MainActor () -> Void

  public init(api: any APISending, libraryChanged: @escaping @MainActor () -> Void = {}) {
    self.api = api
    self.libraryChanged = libraryChanged
    _model = State(initialValue: SourcesModel(api: api, libraryChanged: libraryChanged))
    _queue = State(initialValue: MusicBrainzQueueModel(api: api))
    _matching = State(initialValue: MatchingModel(api: api))
  }

  public var body: some View {
    List {
      Section {
        Text("Where your music comes from. When a song is in more than one place, Playarr plays the best-quality copy; between equal copies, the source higher in this list wins.")
          .font(.footnote)
          .foregroundStyle(.secondary)
        if let line = queue.line, let detail = queue.detail {
          VStack(alignment: .leading, spacing: 2) {
            Label(line, systemImage: "circle.fill").font(.footnote.monospaced()).foregroundStyle(.tint)
            Text(detail).font(.caption).foregroundStyle(.secondary)
          }
        }
        if let error = model.error { InlineMessage(text: error) }
      }
      if !model.loaded, let error = model.loadError {
        Section { InlineMessage(text: error) }
      } else if !model.loaded {
        Section { ProgressView() }
      } else {
        Section {
          if model.sources.isEmpty {
            Text("No sources yet. Add Lidarr or a folder to start your library.").foregroundStyle(.secondary)
          }
          ForEach(model.sources) { source in
            row(source)
          }
          .onMove(perform: model.canEdit ? { from, to in Task { await model.move(fromOffsets: from, toOffset: to) } } : nil)
          if model.canEdit {
            Button("Add source", systemImage: "plus") { sheet = .add }
          }
        }
        if model.canEdit, model.hasFolder {
          MatchingSection(model: matching)
        }
      }
    }
    .navigationTitle("Sources")
    .toolbar {
      #if os(iOS)
      if model.canEdit, model.sources.count > 1 { EditButton() }
      #endif
    }
    .task { await model.poll() }
    .task { await queue.poll() }
    .task { await matching.load() }
    .refreshable { await model.load() }
    .sheet(item: $sheet) { sheet in
      switch sheet {
      case .add: SourceFormView(source: nil, hasLidarr: model.hasLidarr, api: api) { Task { await model.saved() } }
      case .edit(let source): SourceFormView(source: source, hasLidarr: model.hasLidarr, api: api) { Task { await model.saved() } }
      case .review(let id): ReviewView(sourceId: id, api: api) { Task { await model.load() } }
      case .organize(let id): OrganizeView(sourceId: id, api: api, libraryChanged: libraryChanged)
      }
    }
    .confirmationDialog(removing.map(SourceText.removeTitle) ?? "", isPresented: removingBinding, titleVisibility: .visible, presenting: removing) { source in
      Button("Remove", role: .destructive) { Task { await model.remove(source) } }
    } message: { _ in
      Text(SourceText.removeMessage)
    }
  }

  private var removingBinding: Binding<Bool> {
    Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })
  }

  private func row(_ source: SourceInfo) -> some View {
    let status = SourceText.status(source)
    return HStack(alignment: .top, spacing: 12) {
      Image(systemName: SourceText.isRemote(source) ? "network" : source.kind == .folder ? "folder" : "server.rack")
        .foregroundStyle(.tint)
        .frame(width: 28)
      VStack(alignment: .leading, spacing: 2) {
        HStack {
          Text(source.name).font(.body)
          if !source.enabled { Text("OFF").font(.caption2.monospaced()).foregroundStyle(.secondary) }
        }
        Text(SourceText.details(source)).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1)
        Text(status.text).font(.caption).foregroundStyle(color(status.tone)).lineLimit(2)
        if source.kind == .folder, source.review > 0, model.canEdit {
          Button("\(AdminText.plural(source.review, "album")) to review") { sheet = .review(source.id) }
            .font(.footnote)
            .buttonStyle(.borderless)
        }
      }
      Spacer(minLength: 0)
      if source.syncing { ProgressView() }
    }
    .contextMenu { if model.canEdit { actions(source) } }
    .swipeActions(edge: .trailing) {
      if model.canEdit {
        Button("Remove", systemImage: "trash", role: .destructive) { removing = source }
        Button("Edit", systemImage: "pencil") { sheet = .edit(source) }
      }
    }
    .swipeActions(edge: .leading) {
      if model.canEdit {
        Button("Rescan", systemImage: "arrow.clockwise") { Task { await model.rescan(source) } }.disabled(source.syncing)
      }
    }
  }

  @ViewBuilder private func actions(_ source: SourceInfo) -> some View {
    Button("Rescan", systemImage: "arrow.clockwise") { Task { await model.rescan(source) } }.disabled(source.syncing)
    if source.kind == .folder {
      Button("Match again", systemImage: "arrow.trianglehead.2.clockwise") { Task { await model.rematch(source) } }
        .disabled(model.rematching.contains(source.id))
      // Offered even when the folder isn't writable: the sheet explains why nothing can move.
      Button("Organize files", systemImage: "folder.badge.gearshape") { sheet = .organize(source.id) }
    }
    Button("Edit", systemImage: "pencil") { sheet = .edit(source) }
    Button("Remove", systemImage: "trash", role: .destructive) { removing = source }
  }

  private func color(_ tone: SourceText.Tone) -> Color {
    switch tone {
    case .accent: .accentColor
    case .error: .red
    case .muted: .secondary
    }
  }
}
```

`UI/Settings/Admin/Sources/MatchingSection.swift`:

```swift
import SwiftUI

/// Settings → Sources → Identifying songs: the AcoustID key.
struct MatchingSection: View {
  @Bindable var model: MatchingModel

  var body: some View {
    if let settings = model.settings {
      Section {
        if !settings.fingerprints {
          Text(MatchingModel.noFingerprints).font(.footnote)
        }
        if model.editing {
          SecureField("AcoustID application key", text: $model.key)
            .font(.body.monospaced())
            .adminPlainField()
            .accessibilityLabel("AcoustID key")
          Button("Save") { Task { await model.save() } }.disabled(!model.canSave)
        } else {
          HStack {
            Text("AcoustID key saved").font(.body.monospaced()).foregroundStyle(.secondary)
            Spacer()
            Button("Replace") { model.replacing = true }.buttonStyle(.borderless)
          }
        }
        if let error = model.error { InlineMessage(text: error) }
      } header: {
        Text("Identifying songs")
      } footer: {
        VStack(alignment: .leading, spacing: 4) {
          Text(MatchingModel.intro)
          if let page = MatchingModel.keyPage { Link("acoustid.org", destination: page) }
        }
      }
    }
  }
}
```

`UI/Settings/Admin/Sources/SourceFormView.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// Add source (choose Lidarr or a folder) or Edit <name>.
struct SourceFormView: View {
  let source: SourceInfo?
  let hasLidarr: Bool
  let api: any APISending
  let onSaved: () -> Void
  @State private var kind: SourceKind?
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      Group {
        switch source?.kind ?? kind {
        case .lidarr: LidarrFormView(model: LidarrFormModel(source: source, api: api), done: done)
        case .folder: FolderFormView(model: FolderFormModel(source: source, api: api), api: api, done: done)
        default: chooser
        }
      }
      .navigationTitle(source.map { "Edit \($0.name)" } ?? "Add source")
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
    }
  }

  private var chooser: some View {
    List {
      Button { kind = .lidarr } label: {
        option("server.rack", "Lidarr", hasLidarr ? "Playarr connects to one Lidarr, and it’s already added." : "Your Lidarr library, with requests.")
      }
      .disabled(hasLidarr)
      Button { kind = .folder } label: {
        option("folder", "Folder", "Music in a folder: on this server, another machine over SSH or SFTP, or an SMB share. Playarr only reads it.")
      }
    }
  }

  private func option(_ icon: String, _ title: String, _ detail: String) -> some View {
    Label {
      VStack(alignment: .leading) {
        Text(title)
        Text(detail).font(.footnote).foregroundStyle(.secondary)
      }
    } icon: {
      Image(systemName: icon)
    }
  }

  private func done() {
    onSaved()
    dismiss()
  }
}
```

`UI/Settings/Admin/Sources/LidarrFormView.swift`:

```swift
import SwiftUI

/// Lidarr's name, URL and API key, with Test and Save.
struct LidarrFormView: View {
  @State var model: LidarrFormModel
  let done: () -> Void

  var body: some View {
    Form {
      Section {
        TextField("Name", text: $model.name)
        TextField("URL", text: $model.url, prompt: Text("http://192.168.1.10:8686")).adminURLField()
      }
      Section {
        if model.replacingKey {
          TextField("API key", text: $model.apiKey, prompt: Text(model.keySaved ? "New API key" : "API key"))
            .font(.body.monospaced())
            .adminPlainField()
        } else {
          HStack {
            Text("API key")
            Spacer()
            Text("Saved").font(.body.monospaced()).foregroundStyle(.secondary)
            Button("Replace") { model.replacingKey = true }.buttonStyle(.borderless)
          }
        }
      } footer: {
        Text("In Lidarr: Settings → General → Security")
      }
      if model.source != nil {
        Toggle("Use this source", isOn: $model.enabled)
      }
      Section {
        if model.test == .running {
          Label("Connecting…", systemImage: "hourglass").foregroundStyle(.secondary)
        } else if let text = model.testText, case .done(let result) = model.test {
          Label(text, systemImage: result.ok ? "checkmark" : "exclamationmark.triangle").foregroundStyle(result.ok ? .green : .red)
        }
        if let error = model.error { InlineMessage(text: error) }
        Button("Test") { Task { await model.runTest() } }.disabled(!model.canTest)
        Button(model.saving ? "Saving…" : "Save") {
          Task { if await model.save() { done() } }
        }
        .disabled(!model.canSave)
      }
    }
  }
}
```

`UI/Settings/Admin/Sources/FolderFormView.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// Where the folder is (this server, SSH, SFTP or an SMB share), how to reach it, and the folder itself.
struct FolderFormView: View {
  @State var model: FolderFormModel
  let api: any APISending
  let done: () -> Void

  var body: some View {
    Form {
      Section {
        Picker("Where the folder is", selection: accessBinding) {
          ForEach(FolderFormModel.accessChoices, id: \.access) { choice in
            Text(choice.label).tag(choice.access).selectionDisabled(model.isDisabled(choice.access))
          }
        }
        .pickerStyle(.segmented)
        if model.smb, model.smbOff { Text("\(FolderFormModel.smbOffText).").font(.footnote).foregroundStyle(.red) }
      }
      if model.remote { connection }
      if let request = model.browsing {
        Section("Folder") {
          FolderBrowserView(
            model: FolderBrowserModel(request: request, start: model.path, rootLabel: model.rootLabel, api: api),
            selected: model.path
          ) { model.path = $0 }
          .id(model.attempt)
        }
      }
      Section {
        TextField("Name", text: $model.name, prompt: Text(model.namePlaceholder))
        if model.source != nil { Toggle("Use this source", isOn: $model.enabled) }
      } footer: {
        Text("Playarr only reads this folder. Songs appear after the first scan.")
      }
      Section {
        if let error = model.error { InlineMessage(text: error) }
        Button(model.saving ? "Saving…" : "Save") { Task { if await model.save() { done() } } }.disabled(!model.canSave)
      }
    }
    .task { await model.loadAccess() }
  }

  private var accessBinding: Binding<FolderAccessKind> {
    Binding(get: { model.access }, set: { model.choose($0) })
  }

  private var connection: some View {
    Section {
      TextField("Host", text: $model.host, prompt: Text("192.168.1.10")).adminURLField()
      TextField("Port", value: $model.port, format: .number.grouping(.never)).adminNumberField()
      TextField("User", text: $model.user).adminPlainField()
      if model.replacingPassword {
        SecureField("Password", text: $model.password, prompt: Text(model.passwordSaved ? "New password" : "Password"))
      } else {
        HStack {
          Text("Password")
          Spacer()
          Text("Saved").font(.body.monospaced()).foregroundStyle(.secondary)
          Button("Replace") { model.replacingPassword = true }.buttonStyle(.borderless)
        }
      }
      if model.smb {
        TextField("Domain", text: $model.domain, prompt: Text("WORKGROUP")).adminPlainField()
      } else {
        TextField("Key file on the server", text: $model.keyPath, prompt: Text(FolderFormModel.keyPathPlaceholder))
          .font(.body.monospaced())
          .adminPlainField()
      }
      Button("Connect") { model.connect() }.disabled(!model.canConnect)
    } footer: {
      Text(
        model.smb
          ? "User: guest for guest access, with the password left empty. Playarr reads the share with rclone. Song analysis and fingerprints run on this server."
          : "The password is optional with a key file on the Playarr server or ssh-agent. SSH also runs song analysis and fingerprints on that machine. SFTP only reads files.")
    }
  }
}
```

`UI/Settings/Admin/Sources/FolderBrowserView.swift`:

```swift
import SwiftUI

/// Folders one level at a time: ".." goes up, a folder opens, "Use this folder" chooses the one on screen.
struct FolderBrowserView: View {
  @State var model: FolderBrowserModel
  let selected: String?
  let choose: (String) -> Void

  var body: some View {
    Group {
      HStack {
        if model.canGoUp {
          Button("..") { Task { await model.up() } }
            .buttonStyle(.borderless)
            .accessibilityLabel("Up one folder")
        }
        Text(model.title).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
      }
      ForEach(model.listing?.folders ?? [], id: \.path) { folder in
        Button { Task { await model.open(folder.path) } } label: {
          Label(folder.name, systemImage: "folder").foregroundStyle(.primary)
        }
      }
      if let empty = model.emptyText { Text(empty).font(.footnote).foregroundStyle(.secondary) }
      if let help = model.emptyRootHelp {
        VStack(alignment: .leading, spacing: 4) {
          Text(help.title)
          Text(help.detail).foregroundStyle(.secondary)
        }
        .font(.footnote)
      }
      if let error = model.error { InlineMessage(text: error) }
      if let footer = model.footer(selected: selected), let path = model.choosable {
        HStack {
          Text(footer).font(.caption).foregroundStyle(.secondary)
          Spacer()
          Button("Use this folder") { choose(path) }.buttonStyle(.borderless)
        }
      }
    }
    .task { await model.load() }
  }
}
```

`UI/Settings/Admin/Sources/ReviewView.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// "Review matches": one doubtful album at a time, with its MusicBrainz candidates, the edition's details,
/// your files beside its songs, a search, "Fix names", "Leave unmatched" and "Use this album".
struct ReviewView: View {
  @State private var model: ReviewModel
  @Environment(\.dismiss) private var dismiss
  @Environment(\.openURL) private var openURL

  init(sourceId: Int, api: any APISending, sourcesChanged: @escaping @MainActor () -> Void) {
    _model = State(initialValue: ReviewModel(sourceId: sourceId, api: api, sourcesChanged: sourcesChanged))
  }

  var body: some View {
    NavigationStack {
      content
        .navigationTitle("Review matches")
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
    }
    .task(id: model.pollRound) { await model.poll() }
  }

  @ViewBuilder private var content: some View {
    if model.groups == nil, let error = model.loadError {
      ContentUnavailableView {
        Label("Couldn’t load the albums to review", systemImage: "exclamationmark.triangle")
      } description: {
        Text(error)
      } actions: {
        Button("Try again") { Task { await model.load() } }
      }
    } else if model.groups == nil {
      ProgressView()
    } else if let group = model.current {
      groupForm(group).id(group.groupKey)
    } else {
      List {
        savedNote
        Text("Nothing left to review.")
      }
    }
  }

  @ViewBuilder private var savedNote: some View {
    if let saved = model.saved {
      if case .failed = saved.state {
        InlineMessage(text: saved.line)
      } else {
        Text(saved.line).font(.footnote).foregroundStyle(.secondary)
      }
    }
  }

  private func groupForm(_ group: ReviewGroup) -> some View {
    Form {
      Section {
        savedNote
        LabeledContent("Your files say") {
          Text(ReviewText.yourAlbum(group))
        }
        Text("\(model.remaining) to review").font(.caption.monospaced()).foregroundStyle(.secondary)
        if group.notFound == true {
          Label("Not found on MusicBrainz", systemImage: "exclamationmark.circle").font(.caption).foregroundStyle(.orange)
        }
      }
      Section("Albums on MusicBrainz") {
        if group.candidates.isEmpty {
          Text("No albums found on MusicBrainz for these names. Search with other names below (the artist may go by another name there), or fix the names yourself.")
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
        ForEach(group.candidates, id: \.releaseId) { candidate in
          Button { model.chosen = candidate.releaseId } label: { candidateRow(candidate) }
            .foregroundStyle(.primary)
        }
      }
      .disabled(model.searching)
      if let candidate = model.candidate {
        Section("This edition") {
          ForEach(ReviewText.details(candidate), id: \.label) { row in
            LabeledContent(row.label) {
              if let value = row.value { Text(value) } else { ProgressView() }
            }
          }
          if !candidate.detailed {
            Text("Getting this edition’s details from MusicBrainz…").font(.caption).foregroundStyle(.secondary)
          }
          if let url = ReviewText.musicBrainzURL(candidate) {
            Button("Open on MusicBrainz", systemImage: "arrow.up.right.square") { openURL(url) }
          }
        }
        Section("Your file · On MusicBrainz") {
          ForEach(group.files, id: \.rel) { file in
            VStack(alignment: .leading, spacing: 2) {
              Text("\(file.title) \(AdminText.time(file.duration))").foregroundStyle(.secondary)
              Text(ReviewText.matched(file, in: candidate) ?? "not on this album")
                .foregroundStyle(ReviewText.matched(file, in: candidate) == nil ? .secondary : .primary)
            }
          }
        }
      }
      Section {
        TextField("Artist", text: $model.artist).disabled(model.searching)
        TextField("Album", text: $model.album).disabled(model.searching)
        Button(model.searching ? "Searching…" : "Search", systemImage: "magnifyingglass") { Task { await model.search() } }
          .disabled(!model.canSearch)
        if let error = model.error { InlineMessage(text: error) }
      }
      if model.fixing {
        Section {
          ForEach(group.files, id: \.rel) { file in
            TextField(file.rel.split(separator: "/").last.map(String.init) ?? file.rel, text: titleBinding(file.rel))
          }
          Button("Save names", systemImage: "checkmark") { Task { await model.saveNames() } }.disabled(!model.canRename)
          Button("Cancel") { model.fixing = false }
        } header: {
          Text("Songs")
        } footer: {
          Text("Used instead of what the files say, for this album only. The files themselves aren’t changed.")
        }
      }
      Section {
        if !model.fixing {
          Button("Fix names", systemImage: "pencil.line") { model.fixing = true }.disabled(model.searching)
        }
        Button("Leave unmatched") { Task { await model.leaveUnmatched() } }.disabled(model.searching)
        Button("Use this album", systemImage: "checkmark") { Task { await model.useChosen() } }
          .disabled(model.searching || model.candidate == nil)
          .bold()
      }
    }
  }

  private func candidateRow(_ candidate: ReviewCandidate) -> some View {
    HStack(alignment: .top) {
      Image(systemName: candidate.releaseId == model.chosen ? "largecircle.fill.circle" : "circle").foregroundStyle(.tint)
      VStack(alignment: .leading, spacing: 2) {
        Text(candidate.disambiguation.map { "\(candidate.title) (\($0))" } ?? candidate.title)
        Text(ReviewText.summary(candidate)).font(.footnote).foregroundStyle(.secondary)
      }
      Spacer()
      Text(ReviewText.score(candidate)).font(.caption.monospaced()).foregroundStyle(.secondary)
    }
    .accessibilityAddTraits(candidate.releaseId == model.chosen ? .isSelected : [])
  }

  private func titleBinding(_ rel: String) -> Binding<String> {
    Binding(get: { model.titles[rel] ?? "" }, set: { model.titles[rel] = $0 })
  }
}
```

`UI/Settings/Admin/Sources/OrganizeView.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// "Organize files": the proposed moves by album with a tick each, All and None, Move N files, and Undo.
struct OrganizeView: View {
  @State private var model: OrganizeModel
  @Environment(\.dismiss) private var dismiss

  init(sourceId: Int, api: any APISending, libraryChanged: @escaping @MainActor () -> Void) {
    _model = State(initialValue: OrganizeModel(sourceId: sourceId, api: api, libraryChanged: libraryChanged))
  }

  var body: some View {
    NavigationStack {
      content
        .navigationTitle("Organize files")
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
          if let plan = model.plan, plan.writable, plan.reason == nil, !plan.moves.isEmpty {
            ToolbarItem(placement: .confirmationAction) {
              Button(model.applyLabel) { Task { await model.apply() } }.disabled(!model.canApply)
            }
          }
        }
    }
    .task { await model.load() }
  }

  @ViewBuilder private var content: some View {
    if let plan = model.plan {
      if let reason = plan.reason {
        Text(reason).padding()
      } else if !plan.writable {
        Text(OrganizeModel.notWritable).padding()
      } else {
        list(plan)
      }
    } else if let error = model.loadError {
      ContentUnavailableView("Organize files", systemImage: "exclamationmark.triangle", description: Text(error))
    } else {
      ProgressView()
    }
  }

  private func list(_ plan: OrganizePlan) -> some View {
    List {
      Section {
        Text(OrganizeModel.intro).font(.footnote).foregroundStyle(.secondary)
        if let notice = model.notice { InlineMessage(text: notice, isError: model.failed) }
        if let last = model.lastBatchText {
          HStack {
            Text(last).font(.footnote)
            Spacer()
            Button("Undo", systemImage: "arrow.uturn.backward") { Task { await model.undo() } }
              .buttonStyle(.borderless)
              .disabled(model.working)
          }
        }
      }
      if plan.moves.isEmpty {
        Text("Everything is already where it belongs.")
      } else {
        Section {
          HStack {
            Text(model.selectionText).font(.footnote).foregroundStyle(.secondary)
            Spacer()
            Button("All") { model.chooseAll() }.buttonStyle(.borderless)
            Button("None") { model.chooseNone() }.buttonStyle(.borderless)
          }
        }
        ForEach(model.albums, id: \.title) { album in
          Section(album.title) {
            ForEach(album.moves, id: \.from) { move in
              Button { model.toggle(move) } label: { moveRow(move) }.foregroundStyle(.primary)
            }
          }
        }
      }
      if let title = model.skippedTitle {
        Section {
          DisclosureGroup(title) {
            ForEach(plan.skipped, id: \.from) { skip in
              Text("\(skip.from) · \(skip.reason)").font(.caption.monospaced())
            }
          }
        }
      }
    }
  }

  private func moveRow(_ move: OrganizeMove) -> some View {
    HStack(alignment: .top) {
      Image(systemName: model.chosen.contains(move.from) ? "checkmark.square.fill" : "square").foregroundStyle(.tint)
      VStack(alignment: .leading, spacing: 2) {
        Text(move.from).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
        Label(move.to, systemImage: "arrow.right").lineLimit(1).truncationMode(.middle)
      }
      .font(.caption.monospaced())
      Spacer()
      if !move.confident { Text("GUESS").font(.caption2.monospaced()).foregroundStyle(.secondary) }
    }
    .accessibilityAddTraits(model.chosen.contains(move.from) ? .isSelected : [])
  }
}
```

**Step 2: Build for the Mac and the simulator**

Run the two build commands from Conventions.

Expected: both end with `Build complete!`, with no errors or warnings from these files.

**Step 3: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/Admin/Support/AdminFields.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/Admin/Support/InlineMessage.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/Admin/Sources/SourcesPanel.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/Admin/Sources/MatchingSection.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/Admin/Sources/SourceFormView.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/Admin/Sources/LidarrFormView.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/Admin/Sources/FolderFormView.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/Admin/Sources/FolderBrowserView.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/Admin/Sources/ReviewView.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/Admin/Sources/OrganizeView.swift
git commit -F - <<'MSG'
iOS: Settings → Sources screens: the list with drag to reorder, the Lidarr and folder forms, the folder browser, review and organize

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 9: Mixes: the server's mix settings, your history and ListenBrainz

**Files:**
- Create: `UI/Settings/Admin/Mixes/MixKinds.swift`, `UI/Settings/Admin/Mixes/MixSettingsModel.swift`, `UI/Settings/Admin/Mixes/ListenBrainzModel.swift`
- Test: `UITests/Admin/MixesTests.swift`

Ports `MixesPanel.tsx` (the 12 kinds with their labels and descriptions, the time zone with "Use this device’s", songs per mix, Discovery Weekly as the choice nearest the saved value, Blast from the past, genre and decade counts, "Remember what’s played", the history line and Clear history), `ListenBrainzSection.tsx`, and `useSaveMixSettings`/`useClearHistory`/`useListenBrainz` (`queries.ts:704-775`). A kind's switch sends only that kind (`{"enabled":{"discovery":true}}`), as the server merges `enabled`. The generator made three `Enabled` structs (settings, info, patch), so `MixKinds` maps each `MixKind` to a key path in the two this needs.

**Step 1: Write the failing test**

`UITests/Admin/MixesTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct MixesTests {
  let api = FakeAPI()

  static func settings(plays: Int = 1234, timeZone: String? = nil, discovery: Bool? = nil) -> MixSettingsInfo {
    MixSettingsInfo(
      enabled: .init(discovery: discovery), length: 50, adventurous: 0.4, blastDays: 90, genreMixes: 2, decadeMixes: 2,
      recordHistory: true, analyzeLibrary: false, timeZone: timeZone, analysisAvailable: true,
      history: .init(plays: plays, since: plays > 0 ? "2026-01-05T10:00:00Z" : nil))
  }

  func model(admin: Bool = true) -> MixSettingsModel {
    MixSettingsModel(api: api, isAdmin: admin, deviceTimeZone: "Europe/London")
  }

  @Test func countsMissingKindsAsOnAndSavesOneSwitch() async {
    let mixes = model()
    api.on(.get, "/api/settings/mixes", Self.settings(discovery: false))
    await mixes.load()
    #expect(mixes.isEnabled(.vibes) && !mixes.isEnabled(.discovery))
    api.on(.put, "/api/settings/mixes", Self.settings(discovery: true))
    await mixes.setEnabled(.discovery, true)
    #expect(api.bodies(.put, "/api/settings/mixes") == [#"{"enabled":{"discovery":true}}"#])
    #expect(mixes.isEnabled(.discovery))
  }

  @Test func putsAChangeBackWhenTheServerRefusesIt() async {
    let mixes = model()
    api.on(.get, "/api/settings/mixes", Self.settings())
    await mixes.load()
    api.fail(.put, "/api/settings/mixes", status: 403, "Only an admin can change this")
    await mixes.setLength(100)
    #expect(mixes.info?.length == 50)
    #expect(mixes.notice == "Couldn’t save: Only an admin can change this" && mixes.failed)
  }

  @Test func offersThisDevicesTimeZone() async {
    let mixes = model()
    api.on(.get, "/api/settings/mixes", Self.settings())
    await mixes.load()
    #expect(mixes.timeZoneText == "The server’s")
    #expect(mixes.useDeviceZoneLabel == "Use this device’s (Europe/London)")
    api.on(.put, "/api/settings/mixes", Self.settings(timeZone: "Europe/London"))
    await mixes.useDeviceTimeZone()
    #expect(api.bodies(.put, "/api/settings/mixes") == [#"{"timeZone":"Europe/London"}"#])
    #expect(mixes.useDeviceZoneLabel == nil)
  }

  @Test func picksTheNearestAdventureAndSaysTheHistory() async {
    let mixes = model(admin: false)
    api.on(.get, "/api/settings/mixes", Self.settings())
    await mixes.load()
    #expect(mixes.adventure == 0.5)
    #expect(mixes.historyText.hasPrefix("1234 songs played since "))
    #expect(mixes.canClear)
  }

  @Test func clearsTheHistoryAfterAsking() async {
    var mixesChanged = 0
    let mixes = MixSettingsModel(api: api, isAdmin: false, deviceTimeZone: "Europe/London") { mixesChanged += 1 }
    api.on(.get, "/api/settings/mixes", Self.settings())
    await mixes.load()
    api.on(.delete, "/api/settings/mixes/history", Self.settings(plays: 0))
    await mixes.clearHistory()
    #expect(mixes.historyText == "Nothing played yet" && !mixes.canClear)
    #expect(mixes.notice == "Listening history cleared")
    #expect(mixesChanged == 1)
  }

  @Test func connectsListenBrainzAndSaysWhatIsSent() async {
    let lb = ListenBrainzModel(api: api)
    api.on(.get, "/api/settings/listenbrainz", ListenBrainzInfo(connected: false, enabled: false, pending: 0, sent: 0, earlier: 0))
    await lb.load()
    lb.token = "  "
    #expect(!lb.canConnect)
    lb.token = " tok "
    api.on(.put, "/api/settings/listenbrainz", ListenBrainzInfo(connected: true, user: "nicola", enabled: true, pending: 3, sent: 120, earlier: 1200))
    await lb.connect()
    #expect(api.bodies(.put, "/api/settings/listenbrainz") == [#"{"token":"tok"}"#])
    #expect(lb.token.isEmpty)
    #expect(lb.switchLabel == "Send plays to nicola")
    #expect(lb.switchDetail == "120 listens sent · 3 waiting")
    #expect(lb.earlierLabel == "Also send 1200 earlier plays")
  }

  @Test func pausesSendsEarlierPlaysAndDisconnects() async {
    let lb = ListenBrainzModel(api: api)
    let on = ListenBrainzInfo(connected: true, user: "nicola", enabled: true, pending: 0, sent: 1, earlier: 0, error: "The token was revoked")
    api.on(.get, "/api/settings/listenbrainz", on)
    await lb.load()
    #expect(lb.switchDetail == "The token was revoked")
    api.on(.put, "/api/settings/listenbrainz", on)
    await lb.setEnabled(false)
    #expect(api.bodies(.put, "/api/settings/listenbrainz") == [#"{"enabled":false}"#])
    api.on(.post, "/api/settings/listenbrainz/earlier", on)
    await lb.sendEarlier()
    #expect(lb.notice == "Sending your earlier plays to ListenBrainz")
    api.on(.delete, "/api/settings/listenbrainz", ListenBrainzInfo(connected: false, enabled: false, pending: 0, sent: 0, earlier: 0))
    await lb.disconnect()
    #expect(lb.notice == "ListenBrainz disconnected" && lb.info?.connected == false)
  }

  @Test func refreshesListenBrainzEvery30Seconds() async {
    let clock = TestClock()
    let lb = ListenBrainzModel(api: api, clock: clock)
    api.on(.get, "/api/settings/listenbrainz", ListenBrainzInfo(connected: true, enabled: true, pending: 0, sent: 1, earlier: 0))
    let polling = Task { await lb.poll() }
    #expect(await clock.nextSleep() == .seconds(30))
    clock.advance(by: .seconds(30))
    #expect(await clock.nextSleep() == .seconds(30))
    #expect(api.calls(.get, "/api/settings/listenbrainz").count == 2)
    polling.cancel()
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter MixesTests
```

Expected: the build fails with `cannot find 'MixSettingsModel' in scope` and `cannot find 'ListenBrainzModel' in scope`.

**Step 3: Implement**

`UI/Settings/Admin/Mixes/MixKinds.swift`:

```swift
import PlayarrAPI

/// Every kind of mix, as Settings names and explains it (MixesPanel.tsx: KINDS), and the choices for how they're made.
enum MixKinds {
  static let all: [(kind: MixKind, label: String, description: String)] = [
    (.vibes, "Vibes of the hour", "What you play around this time of day. A new one every hour."),
    (.discovery, "Discovery Weekly", "Songs in your library you haven’t played yet, picked for you. New every Monday."),
    (.repeat, "On Repeat", "Your most played songs of the last 30 days."),
    (.blast, "Blast from the past", "Songs you played a lot, then not for a while."),
    (.genre, "Genre mixes", "One for each style you listen to most."),
    (.deepcuts, "Deep cuts", "The songs you’ve barely played by the artists you love."),
    (.fresh, "Fresh arrivals", "Songs from albums added in the last 30 days."),
    (.decade, "Time machine", "One for each decade you have the most music from."),
    (.energy, "Energy boost", "Loud, fast songs, building up."),
    (.focus, "Deep focus", "Steady, mostly instrumental music to work to."),
    (.winddown, "Wind down", "Calm, soft songs, slowing down."),
    (.onthisday, "On this day", "Songs from albums released this week in years past."),
  ]

  static let lengths: [(value: Int, label: String)] = [25, 50, 75, 100].map { ($0, String($0)) }
  static let adventure: [(value: Double, label: String)] = [(0, "Familiar"), (0.5, "Balanced"), (1, "Adventurous")]
  static let blast: [(value: Int, label: String)] = [(30, "A month"), (90, "3 months"), (180, "6 months"), (365, "A year")]
  static let counts: [(value: Int, label: String)] = (0...4).map { ($0, String($0)) }

  /// Where a kind's switch lives in the settings the server sends.
  static func setting(_ kind: MixKind) -> WritableKeyPath<MixSettingsInfo.Enabled, Bool?>? {
    switch kind {
    case .vibes: \.vibes
    case .discovery: \.discovery
    case .repeat: \.repeat
    case .blast: \.blast
    case .deepcuts: \.deepcuts
    case .fresh: \.fresh
    case .decade: \.decade
    case .genre: \.genre
    case .energy: \.energy
    case .winddown: \.winddown
    case .focus: \.focus
    case .onthisday: \.onthisday
    case .unknown: nil
    }
  }

  /// Where a kind's switch goes in a change.
  static func change(_ kind: MixKind) -> WritableKeyPath<MixSettingsPatch.Enabled, Bool?>? {
    switch kind {
    case .vibes: \.vibes
    case .discovery: \.discovery
    case .repeat: \.repeat
    case .blast: \.blast
    case .deepcuts: \.deepcuts
    case .fresh: \.fresh
    case .decade: \.decade
    case .genre: \.genre
    case .energy: \.energy
    case .winddown: \.winddown
    case .focus: \.focus
    case .onthisday: \.onthisday
    case .unknown: nil
    }
  }
}
```

`UI/Settings/Admin/Mixes/MixSettingsModel.swift`:

```swift
import Foundation
import Observation
import PlayarrAPI

/// Settings → Mixes. How mixes are made is the server's, for admins (PUT /api/settings/mixes); each account
/// sees its own listening history and clears it (DELETE /api/settings/mixes/history). A change shows at
/// once and is put back if the server refuses it.
@MainActor @Observable
public final class MixSettingsModel {
  public private(set) var info: MixSettingsInfo?
  public private(set) var loadError: String?
  public private(set) var clearing = false
  /// What the last change did, or why it failed.
  public private(set) var notice: String?
  public private(set) var failed = false

  public let isAdmin: Bool
  @ObservationIgnored private let api: any APISending
  @ObservationIgnored private let deviceTimeZone: String
  @ObservationIgnored private let mixesChanged: @MainActor () -> Void

  public static let historyIntro =
    "What the mixes learn from: each song heard for 30 seconds, or skipped, and at what time of day. It stays on this server."
  public static let clearTitle = "Clear listening history?"
  public static let clearMessage = "Every song played is forgotten, and the mixes start learning again from scratch. Favorites and playlists stay."
  public static let soundText =
    "Energy boost, Wind down, Deep focus and Vibes of the hour are better once Playarr has measured how songs sound (tempo, loudness, energy); until then they go by genre. Measure every song in Settings → Analysis."

  public init(
    api: any APISending, isAdmin: Bool, deviceTimeZone: String = TimeZone.current.identifier,
    mixesChanged: @escaping @MainActor () -> Void = {}
  ) {
    self.api = api
    self.isAdmin = isAdmin
    self.deviceTimeZone = deviceTimeZone
    self.mixesChanged = mixesChanged
  }

  public func load() async {
    do {
      info = try await api.send(API.Settings.mixes())
      loadError = nil
    } catch {
      loadError = failureText(error)
    }
  }

  /// Missing kinds count as on.
  public func isEnabled(_ kind: MixKind) -> Bool {
    guard let info, let setting = MixKinds.setting(kind) else { return true }
    return info.enabled[keyPath: setting] != false
  }

  public func setEnabled(_ kind: MixKind, _ on: Bool) async {
    guard let setting = MixKinds.setting(kind), let change = MixKinds.change(kind) else { return }
    var enabled = MixSettingsPatch.Enabled()
    enabled[keyPath: change] = on
    await save(MixSettingsPatch(enabled: enabled)) { $0.enabled[keyPath: setting] = on }
  }

  /// The household's clock, or "The server’s" until a device has set it.
  public var timeZoneText: String { info?.timeZone ?? "The server’s" }

  /// "Use this device’s (Europe/London)", when this device is somewhere else.
  public var useDeviceZoneLabel: String? {
    guard info?.timeZone != deviceTimeZone, !deviceTimeZone.isEmpty else { return nil }
    return "Use this device’s (\(deviceTimeZone))"
  }

  public func useDeviceTimeZone() async {
    let zone = deviceTimeZone
    await save(MixSettingsPatch(timeZone: zone)) { $0.timeZone = zone }
  }

  public func setLength(_ length: Int) async { await save(MixSettingsPatch(length: length)) { $0.length = length } }
  public func setAdventurous(_ value: Double) async { await save(MixSettingsPatch(adventurous: value)) { $0.adventurous = value } }
  public func setBlastDays(_ days: Int) async { await save(MixSettingsPatch(blastDays: days)) { $0.blastDays = days } }
  public func setGenreMixes(_ count: Int) async { await save(MixSettingsPatch(genreMixes: count)) { $0.genreMixes = count } }
  public func setDecadeMixes(_ count: Int) async { await save(MixSettingsPatch(decadeMixes: count)) { $0.decadeMixes = count } }
  public func setRecordHistory(_ on: Bool) async { await save(MixSettingsPatch(recordHistory: on)) { $0.recordHistory = on } }

  /// The Discovery Weekly choice nearest the saved value.
  public var adventure: Double {
    let value = info?.adventurous ?? 0.5
    return MixKinds.adventure.min { abs($0.value - value) < abs($1.value - value) }?.value ?? 0.5
  }

  /// "1,234 songs played since 3 November 2026", or "Nothing played yet".
  public var historyText: String {
    guard let history = info?.history, history.plays > 0 else { return "Nothing played yet" }
    let since = history.since.flatMap(AdminText.date).map { " since \($0.formatted(.dateTime.day().month(.wide).year()))" } ?? ""
    return "\(AdminText.plural(history.plays, "song")) played\(since)"
  }

  public var canClear: Bool { (info?.history.plays ?? 0) > 0 && !clearing }

  /// After the question: every song this account played is forgotten.
  public func clearHistory() async {
    clearing = true
    defer { clearing = false }
    do {
      info = try await api.send(API.Settings.clearHistory())
      notice = "Listening history cleared"
      failed = false
      mixesChanged()
    } catch {
      notice = "Couldn’t clear the history: \(failureText(error))"
      failed = true
    }
  }

  private func save(_ patch: MixSettingsPatch, _ apply: (inout MixSettingsInfo) -> Void) async {
    guard var shown = info else { return }
    let previous = shown
    apply(&shown)
    info = shown
    do {
      info = try await api.send(API.Settings.saveMixes(patch))
      notice = nil
      mixesChanged()
    } catch {
      info = previous
      notice = "Couldn’t save: \(failureText(error))"
      failed = true
    }
  }
}
```

`UI/Settings/Admin/Mixes/ListenBrainzModel.swift`:

```swift
import Foundation
import Observation
import PlayarrAPI

/// Settings → Mixes → ListenBrainz, for the account signed in: connect with a user token, send plays on or
/// off, send earlier plays, disconnect. Refreshed every 30 s while on screen, to show plays going out.
@MainActor @Observable
public final class ListenBrainzModel {
  /// Nil until loaded, and on a server without ListenBrainz (the section isn't shown then).
  public private(set) var info: ListenBrainzInfo?
  public var token = ""
  public private(set) var busy = false
  public private(set) var notice: String?
  public private(set) var failed = false

  @ObservationIgnored private let api: any APISending
  @ObservationIgnored private let clock: any Clock<Duration>

  public static let intro =
    "Send each song heard (for half its length, or four minutes) to your ListenBrainz profile. Its recommendations, which radio and suggestions use, then learn from what you play."
  public static let tokenHelp = "Your user token, from listenbrainz.org/settings"
  public static let tokenPage = URL(string: "https://listenbrainz.org/settings/")

  public init(api: any APISending, clock: any Clock<Duration> = ContinuousClock()) {
    self.api = api
    self.clock = clock
  }

  public func poll() async {
    await Polling.run(clock: clock, interval: { .seconds(30) }) { [weak self] in await self?.load() }
  }

  public func load() async {
    if let info = try? await api.send(API.Settings.listenBrainz()) { self.info = info }
  }

  public var canConnect: Bool { !token.trimmed.isEmpty && !busy }

  public func connect() async {
    guard canConnect else { return }
    if await act(API.Settings.saveListenBrainz(token: token.trimmed)) { token = "" }
  }

  public func setEnabled(_ on: Bool) async {
    await act(API.Settings.saveListenBrainz(enabled: on))
  }

  public func disconnect() async {
    await act(API.Settings.disconnectListenBrainz(), done: "ListenBrainz disconnected")
  }

  public func sendEarlier() async {
    await act(API.Settings.sendEarlierListens(), done: "Sending your earlier plays to ListenBrainz")
  }

  public var switchLabel: String { "Send plays to \(info?.user ?? "ListenBrainz")" }

  /// "120 listens sent · 3 waiting · last 3 Nov 2026 at 10:00", or why sending stopped.
  public var switchDetail: String {
    guard let info else { return "" }
    if let error = info.error { return error }
    return [
      "\(AdminText.plural(info.sent, "listen")) sent",
      info.pending > 0 ? "\(info.pending) waiting" : nil,
      info.lastSentAt.flatMap(AdminText.date).map { "last \($0.formatted(date: .abbreviated, time: .shortened))" },
    ].compactMap { $0 }.joined(separator: " · ")
  }

  /// "Also send 1,200 earlier plays", while there are some.
  public var earlierLabel: String? {
    guard let earlier = info?.earlier, earlier > 0 else { return nil }
    return "Also send \(AdminText.plural(earlier, "earlier play"))"
  }

  @discardableResult
  private func act(_ endpoint: Endpoint<ListenBrainzInfo>, done: String? = nil) async -> Bool {
    busy = true
    defer { busy = false }
    do {
      info = try await api.send(endpoint)
      notice = done
      failed = false
      return true
    } catch {
      notice = failureText(error)
      failed = true
      return false
    }
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter MixesTests
```

Expected: `Test run with 8 tests in 1 suite passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/Admin/Mixes/MixKinds.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/Admin/Mixes/MixSettingsModel.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/Admin/Mixes/ListenBrainzModel.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/Admin/MixesTests.swift
git commit -F - <<'MSG'
iOS: Settings → Mixes models: which mixes and how they're made (admins), and each account's history and ListenBrainz

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 10: The Mixes screen

**Files:**
- Create: `UI/Settings/Admin/Mixes/MixesPanel.swift`, `UI/Settings/Admin/Mixes/ListenBrainzSection.swift`

The web's pill groups become menu pickers. Clear history asks with the web's title and text. A member sees "Listening history" (without the "Remember what’s played" switch, which is the server's) and ListenBrainz.

**Step 1: Write the views**

`UI/Settings/Admin/Mixes/MixesPanel.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// Settings → Mixes: admins choose which mixes Home shows and how they're made; everyone sees their own
/// listening history (and clears it) and their ListenBrainz link.
public struct MixesPanel: View {
  @State private var model: MixSettingsModel
  @State private var listenBrainz: ListenBrainzModel
  @State private var confirmClear = false

  public init(api: any APISending, isAdmin: Bool, mixesChanged: @escaping @MainActor () -> Void = {}) {
    _model = State(initialValue: MixSettingsModel(api: api, isAdmin: isAdmin, mixesChanged: mixesChanged))
    _listenBrainz = State(initialValue: ListenBrainzModel(api: api))
  }

  public var body: some View {
    Form {
      if let info = model.info {
        if let notice = model.notice { InlineMessage(text: notice, isError: model.failed) }
        if model.isAdmin {
          kinds
          howTheyreMade(info)
        }
        history(info)
        ListenBrainzSection(model: listenBrainz)
        if model.isAdmin {
          Section("Sound") { Text(MixSettingsModel.soundText).font(.footnote).foregroundStyle(.secondary) }
        }
      } else if let error = model.loadError {
        InlineMessage(text: error)
      } else {
        ProgressView()
      }
    }
    .navigationTitle("Mixes")
    .task { await model.load() }
    .task { await listenBrainz.poll() }
    .confirmationDialog(MixSettingsModel.clearTitle, isPresented: $confirmClear, titleVisibility: .visible) {
      Button("Clear history", role: .destructive) { Task { await model.clearHistory() } }
    } message: {
      Text(MixSettingsModel.clearMessage)
    }
  }

  private var kinds: some View {
    Section {
      ForEach(MixKinds.all, id: \.kind) { item in
        Toggle(isOn: Binding(get: { model.isEnabled(item.kind) }, set: { on in Task { await model.setEnabled(item.kind, on) } })) {
          Text(item.label)
          Text(item.description)
        }
      }
    } header: {
      Text("Your mixes")
    } footer: {
      Text("Made for you from your library and what you play, at the top of Home. These settings apply to everyone.")
    }
  }

  private func howTheyreMade(_ info: MixSettingsInfo) -> some View {
    Section("How they’re made") {
      VStack(alignment: .leading, spacing: 6) {
        LabeledContent("Time zone", value: model.timeZoneText)
        if let label = model.useDeviceZoneLabel {
          Button(label) { Task { await model.useDeviceTimeZone() } }.buttonStyle(.bordered)
        }
        Text("When hours, days and Mondays begin for everyone’s mixes.").font(.footnote).foregroundStyle(.secondary)
      }
      Picker("Songs per mix", selection: Binding(get: { info.length }, set: { value in Task { await model.setLength(value) } })) {
        ForEach(MixKinds.lengths, id: \.value) { Text($0.label).tag($0.value) }
      }
      Picker("Discovery Weekly", selection: Binding(get: { model.adventure }, set: { value in Task { await model.setAdventurous(value) } })) {
        ForEach(MixKinds.adventure, id: \.value) { Text($0.label).tag($0.value) }
      }
      Picker("Blast from the past: not heard for", selection: Binding(get: { info.blastDays }, set: { value in Task { await model.setBlastDays(value) } })) {
        ForEach(MixKinds.blast, id: \.value) { Text($0.label).tag($0.value) }
      }
      Picker("Genre mixes", selection: Binding(get: { info.genreMixes }, set: { value in Task { await model.setGenreMixes(value) } })) {
        ForEach(MixKinds.counts, id: \.value) { Text($0.label).tag($0.value) }
      }
      Picker("Decade mixes", selection: Binding(get: { info.decadeMixes }, set: { value in Task { await model.setDecadeMixes(value) } })) {
        ForEach(MixKinds.counts, id: \.value) { Text($0.label).tag($0.value) }
      }
    }
  }

  private func history(_ info: MixSettingsInfo) -> some View {
    Section {
      if model.isAdmin {
        Toggle(isOn: Binding(get: { info.recordHistory }, set: { on in Task { await model.setRecordHistory(on) } })) {
          Text("Remember what’s played")
          Text("Off stops recording; the mixes keep using what’s already there.")
        }
      }
      HStack {
        Text(model.historyText).font(.footnote)
        Spacer()
        Button("Clear history", systemImage: "trash") { confirmClear = true }
          .buttonStyle(.bordered)
          .disabled(!model.canClear)
      }
    } header: {
      Text("Listening history")
    } footer: {
      Text(MixSettingsModel.historyIntro)
    }
  }
}
```

`UI/Settings/Admin/Mixes/ListenBrainzSection.swift`:

```swift
import SwiftUI

/// Settings → Mixes → ListenBrainz: send what this account plays to its ListenBrainz profile.
struct ListenBrainzSection: View {
  @Bindable var model: ListenBrainzModel

  var body: some View {
    if let info = model.info {
      Section {
        if !info.connected {
          SecureField(ListenBrainzModel.tokenHelp, text: $model.token).adminPlainField()
          if let page = ListenBrainzModel.tokenPage { Link("listenbrainz.org/settings", destination: page).font(.footnote) }
          Button(model.busy ? "Checking…" : "Connect") { Task { await model.connect() } }.disabled(!model.canConnect)
        } else {
          Toggle(isOn: Binding(get: { info.enabled }, set: { on in Task { await model.setEnabled(on) } })) {
            Text(model.switchLabel)
            Text(model.switchDetail)
          }
          if let earlier = model.earlierLabel {
            Button(earlier) { Task { await model.sendEarlier() } }.disabled(model.busy)
          }
          Button("Disconnect") { Task { await model.disconnect() } }.disabled(model.busy)
        }
        if let notice = model.notice { InlineMessage(text: notice, isError: model.failed) }
      } header: {
        Text("ListenBrainz")
      } footer: {
        Text(ListenBrainzModel.intro)
      }
    }
  }
}
```

**Step 2: Build for the Mac and the simulator**

Run the two build commands from Conventions. Expected: `Build complete!` twice, no warnings from these files.

**Step 3: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/Admin/Mixes/MixesPanel.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/Admin/Mixes/ListenBrainzSection.swift
git commit -F - <<'MSG'
iOS: Settings → Mixes screen, with ListenBrainz and Clear history

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 11: Analysis

**Files:**
- Create: `UI/Settings/Admin/Analysis/AnalysisText.swift`, `UI/Settings/Admin/Analysis/AnalysisModel.swift`, `UI/Settings/Admin/Analysis/AnalysisPanel.swift`
- Test: `UITests/Admin/AnalysisModelTests.swift`

Ports `AnalysisPanel.tsx` and `useAnalysisProgress`/`useRunAnalysis` (`queries.ts:45-77`). There is one section per analysis: its line, a bar while not done, "Analyse the N of M songs left" (failed songs aren't counted, as they wait a day), and "Reanalyse the entire collection" (tags: "Look up the entire collection again") behind the web's question and cost text. "In the background" has the "Analyse every song in the library" switch (`analyzeLibrary`, a mix setting, off and disabled without audio analysis), the queue line, and "Reanalyse everything" (`POST /api/analysis/all {again: true}`). The toast's words become the panel's message.

**Step 1: Write the failing test**

`UITests/Admin/AnalysisModelTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct AnalysisModelTests {
  let api = FakeAPI()
  let clock = TestClock()

  static func progress(enabled: Bool = true, beats: Int = 4000, waiting: Int = 0, working: Int = 0, scan: Bool = false) -> AnalysisProgress {
    AnalysisProgress(
      enabled: enabled, songs: 5678, beats: .init(ready: beats, beatModel: beats - 10, failed: 78), sound: .init(ready: 5678, failed: 0),
      loudness: .init(ready: 5000, failed: 2), tags: .init(ready: 100, songs: 5000), waiting: waiting, working: working,
      loudnessWaiting: 0, loudnessWorking: 0, tagsWaiting: 0, libraryScan: scan)
  }

  func model() -> AnalysisModel {
    api.on(.get, "/api/settings/mixes", MixesTests.settings())
    return AnalysisModel(api: api, clock: clock)
  }

  @Test func saysHowFarEachAnalysisHasGot() async {
    let analysis = model()
    api.on(.get, "/api/analysis/progress", Self.progress())
    await analysis.load()
    let rows = analysis.rows
    #expect(rows.map(\.title) == ["Beat analysis", "Sound analysis", "Loudness analysis", "Tag lookup"])
    #expect(rows[0].text == "Ready for DJ mix: 4,000 of 5,678 songs (10 without the beat model) · 78 couldn’t be analysed. Others are analysed as they come up to play.")
    #expect(rows[0].leftLabel == "Analyse the 1,600 of 5,678 songs left")
    #expect(rows[0].showsBar)
    #expect(rows[1].text == "All 5,678 songs are measured." && rows[1].leftLabel == nil && !rows[1].showsBar)
    #expect(rows[2].text == "Measured: 5,000 of 5,678 songs · 2 couldn’t be measured. The others play at their own volume until they are.")
    #expect(rows[3].text == "Looked up: 100 of 5,000 songs matched on MusicBrainz (678 more aren’t matched on MusicBrainz).")
    #expect(rows[3].leftLabel == "Look up the 4,900 of 5,000 songs left")
    #expect(rows[3].againQuestion == "Look up the entire collection again?")
    #expect(analysis.queueText == "Nothing is being analysed right now.")
  }

  @Test func offersOnlyTagsWithoutAudioAnalysis() async {
    let analysis = model()
    api.on(.get, "/api/analysis/progress", Self.progress(enabled: false))
    await analysis.load()
    #expect(analysis.rows[0].text == "DJ mix needs it. Audio analysis is off on this server (set ANALYSIS=on in its .env).")
    #expect(!analysis.rows[0].canRun && analysis.rows[0].leftLabel == nil)
    #expect(analysis.rows[3].canRun)
    #expect(!analysis.analyzeLibraryShown)
    #expect(AnalysisText.everythingExplain(audio: false).hasPrefix("A tag lookup for every song"))
  }

  @Test func pollsEvery10SecondsWhileSongsAreUnderWay() async {
    let analysis = model()
    api.on(.get, "/api/analysis/progress", Self.progress(waiting: 12, working: 1))
    api.then(.get, "/api/analysis/progress", Self.progress())
    let polling = Task { await analysis.poll() }
    #expect(await clock.nextSleep() == .seconds(10))
    #expect(analysis.queueText == "Now: analysing 1 song · 12 waiting for beat or sound analysis.")
    clock.advance(by: .seconds(10))
    #expect(await clock.nextSleep() == .seconds(60))
    polling.cancel()
  }

  @Test func runsTheSongsLeftOrEverySongAgain() async {
    let analysis = model()
    api.on(.get, "/api/analysis/progress", Self.progress())
    await analysis.load()
    api.on(.post, "/api/analysis/beats", json: #"{"queued":1600}"#)
    await analysis.run(.beats)
    #expect(api.bodies(.post, "/api/analysis/beats") == [#"{"again":false}"#])
    #expect(analysis.notice == "Analysing 1,600 songs in the background")
    api.on(.post, "/api/analysis/all", json: #"{"queued":5678}"#)
    await analysis.run(nil, again: true)
    #expect(api.bodies(.post, "/api/analysis/all") == [#"{"again":true}"#])
    #expect(analysis.notice == "Analysing 5,678 songs again in the background")
    api.on(.post, "/api/analysis/tags", json: #"{"queued":0}"#)
    await analysis.run(.tags)
    #expect(analysis.notice == "Every song is already looked up or waiting its turn")
  }

  @Test func turnsOnAnalysingTheWholeLibrary() async {
    let analysis = model()
    api.on(.get, "/api/analysis/progress", Self.progress())
    await analysis.load()
    #expect(analysis.analyzeLibrary == false)
    var on = MixesTests.settings()
    on.analyzeLibrary = true
    api.on(.put, "/api/settings/mixes", on)
    await analysis.setAnalyzeLibrary(true)
    #expect(api.bodies(.put, "/api/settings/mixes") == [#"{"analyzeLibrary":true}"#])
    #expect(analysis.analyzeLibraryShown)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter AnalysisModelTests
```

Expected: the build fails with `cannot find 'AnalysisModel' in scope`.

**Step 3: Implement**

`UI/Settings/Admin/Analysis/AnalysisText.swift`:

```swift
import PlayarrAPI

/// Settings → Analysis's wording (AnalysisPanel.tsx), from the server's progress.
enum AnalysisText {
  static let audioOff = "Audio analysis is off on this server (set ANALYSIS=on in its .env)."

  static func songs(_ n: Int) -> String { "\(AdminText.count(n)) \(n == 1 ? "song" : "songs")" }

  /// What's under way: the songs being analysed and waiting, for each queue.
  static func queue(_ p: AnalysisProgress) -> String? {
    let working = p.working + p.loudnessWorking
    let parts = [
      working > 0 ? "analysing \(songs(working))" : nil,
      p.waiting > 0 ? "\(AdminText.count(p.waiting)) waiting for beat or sound analysis" : nil,
      p.loudnessWaiting > 0 ? "\(AdminText.count(p.loudnessWaiting)) waiting for loudness analysis" : nil,
      p.tagsWaiting > 0 ? "\(AdminText.count(p.tagsWaiting)) waiting for a tag lookup" : nil,
    ].compactMap { $0 }
    return parts.isEmpty ? nil : "Now: \(parts.joined(separator: " · "))."
  }

  static func beats(_ p: AnalysisProgress) -> String {
    let ready = p.beats.ready, beatModel = p.beats.beatModel, failed = p.beats.failed
    let withoutModel = ready > beatModel ? " (\(AdminText.count(ready - beatModel)) without the beat model)" : ""
    if ready >= p.songs {
      return p.songs == 1 ? "The library’s one song is ready for DJ mix\(withoutModel)." : "All \(songs(p.songs)) are ready for DJ mix\(withoutModel)."
    }
    let failures = failed > 0 ? " · \(AdminText.count(failed)) couldn’t be analysed" : ""
    let rest = p.libraryScan ? "" : " Others are analysed as they come up to play."
    return "Ready for DJ mix: \(AdminText.count(ready)) of \(songs(p.songs))\(withoutModel)\(failures).\(rest)"
  }

  static func sound(_ p: AnalysisProgress) -> String {
    measured(ready: p.sound.ready, failed: p.sound.failed, songs: p.songs, tail: "")
  }

  static func loudness(_ p: AnalysisProgress) -> String {
    measured(ready: p.loudness.ready, failed: p.loudness.failed, songs: p.songs, tail: " The others play at their own volume until they are.")
  }

  private static func measured(ready: Int, failed: Int, songs total: Int, tail: String) -> String {
    if ready >= total { return total == 1 ? "The library’s one song is measured." : "All \(songs(total)) are measured." }
    let failures = failed > 0 ? " · \(AdminText.count(failed)) couldn’t be measured" : ""
    return "Measured: \(AdminText.count(ready)) of \(songs(total))\(failures).\(tail)"
  }

  static func tags(_ p: AnalysisProgress) -> String {
    let ready = p.tags.ready, taggable = p.tags.songs
    if taggable == 0 { return "No song is matched on MusicBrainz yet, so there are no tags to look up." }
    let unmatched = p.songs - taggable
    let others = unmatched > 0 ? " (\(AdminText.count(unmatched)) more aren’t matched on MusicBrainz)" : ""
    if ready >= taggable { return "All \(songs(taggable)) matched on MusicBrainz are looked up\(others)." }
    return "Looked up: \(AdminText.count(ready)) of \(songs(taggable)) matched on MusicBrainz\(others)."
  }

  /// What a run queued, as the web's toast says it.
  static func queued(_ queued: Int, kind: AnalysisKind?, again: Bool) -> String {
    let tags = kind == .tags
    guard queued > 0 else { return "Every song is already \(tags ? "looked up" : "analysed") or waiting its turn" }
    return "\(tags ? "Looking up" : "Analysing") \(songs(queued))\(again ? " again" : "") in the background"
  }

  static func switchDescription(_ p: AnalysisProgress) -> String {
    p.enabled
      ? "At low priority: beat, sound and loudness analysis and a tag lookup, once for each song. Off, songs are analysed as they come up to play. Takes a while on a big library: beat analysis can take a minute a song on a small server."
      : "Tags are still looked up as songs come up. \(audioOff)"
  }

  static let everythingTitle = "Reanalyse every song with every analysis?"

  static func everythingExplain(audio: Bool) -> String {
    audio
      ? "Beat, sound and loudness analysis and a tag lookup for every song, from scratch, at low priority. Each song keeps what it has until its turn. On a small server this takes many hours: beat analysis alone can take a minute a song."
      : "A tag lookup for every song matched on MusicBrainz, from scratch. Each song keeps its tags until its turn."
  }
}
```

`UI/Settings/Admin/Analysis/AnalysisModel.swift`:

```swift
import Foundation
import Observation
import PlayarrAPI

/// Settings → Analysis: how far each analysis (beats, sound, loudness, tags) has got over the library, a
/// button for the songs each has left, one to do the entire collection again (after asking), and the
/// "Analyse every song in the library" switch. Polled every 10 s while songs wait or are analysed.
@MainActor @Observable
public final class AnalysisModel {
  /// One analysis's section.
  public struct Row: Identifiable, Equatable {
    public let kind: AnalysisKind
    public let title: String
    public let description: String
    public let text: String
    public let done: Int
    public let of: Int
    /// Shown while not everything is done (and the analysis can run here).
    public let showsBar: Bool
    /// "Analyse the 1,200 of 5,678 songs left", while some are left.
    public let leftLabel: String?
    /// The run buttons show (the analysis can run, and there are songs).
    public let canRun: Bool
    public let againLabel: String
    public let againExplain: String
    public let meter: String

    public var id: String { kind.rawValue }
    public var againQuestion: String { "\(againLabel)?" }
  }

  public private(set) var progress: AnalysisProgress?
  public private(set) var loadError: String?
  /// "Analyse every song in the library" (a mix setting); nil until loaded.
  public private(set) var analyzeLibrary: Bool?
  public private(set) var running = false
  public private(set) var notice: String?
  public private(set) var failed = false

  @ObservationIgnored private let api: any APISending
  @ObservationIgnored private let clock: any Clock<Duration>

  public init(api: any APISending, clock: any Clock<Duration> = ContinuousClock()) {
    self.api = api
    self.clock = clock
  }

  var busy: Bool {
    guard let p = progress else { return false }
    return p.waiting > 0 || p.working > 0 || p.loudnessWaiting > 0 || p.loudnessWorking > 0 || p.tagsWaiting > 0
  }

  /// Every 10 s while songs are under way; otherwise once a minute, so a run started elsewhere shows up.
  var pollInterval: Duration { busy ? .seconds(10) : .seconds(60) }

  public func poll() async {
    await Polling.run(clock: clock, interval: { [weak self] in self?.pollInterval }) { [weak self] in await self?.load() }
  }

  public func load() async {
    do {
      progress = try await api.send(API.Analysis.progress())
      loadError = nil
    } catch {
      loadError = failureText(error)
    }
    if analyzeLibrary == nil, let mixes = try? await api.send(API.Settings.mixes()) { analyzeLibrary = mixes.analyzeLibrary }
  }

  public var queueText: String {
    progress.flatMap(AnalysisText.queue) ?? "Nothing is being analysed right now."
  }

  /// The switch is on only when audio analysis is too.
  public var analyzeLibraryShown: Bool { (analyzeLibrary ?? false) && (progress?.enabled ?? false) }

  public func setAnalyzeLibrary(_ on: Bool) async {
    let previous = analyzeLibrary
    analyzeLibrary = on
    do {
      analyzeLibrary = try await api.send(API.Settings.saveMixes(MixSettingsPatch(analyzeLibrary: on))).analyzeLibrary
      await load()
    } catch {
      analyzeLibrary = previous
      notice = "Couldn’t save: \(failureText(error))"
      failed = true
    }
  }

  /// `kind` nil runs every analysis; `again` does every song, those done included.
  public func run(_ kind: AnalysisKind?, again: Bool = false) async {
    running = true
    defer { running = false }
    do {
      let answer = try await api.send(API.Analysis.run(kind, again: again))
      notice = AnalysisText.queued(answer.queued, kind: kind, again: again)
      failed = false
      await load()
    } catch {
      notice = failureText(error)
      failed = true
    }
  }

  public var rows: [Row] {
    guard let p = progress else { return [] }
    let audio = p.enabled
    return [
      row(
        .beats, "Beat analysis",
        "Each song’s tempo, beat grid and bars, key, intro and outro, and where its sound starts and ends: what DJ mix needs to join songs on the beat, and the tempo mixes and covers go by. The heaviest analysis: up to a minute a song on a small server.",
        text: audio ? AnalysisText.beats(p) : "DJ mix needs it. \(AnalysisText.audioOff)", done: p.beats.ready, failed: p.beats.failed, of: p.songs,
        canRun: audio, verb: "Analyse", meter: "Songs ready for DJ mix", again: "Reanalyse the entire collection",
        explain: "Beat analysis for every song, from scratch, at low priority. Each song mixes as it does now until its turn. On a small server this takes many hours: up to a minute a song."),
      row(
        .sound, "Sound analysis",
        "What each song feels like: its energy, brightness, bass and how busy it is. For Energy boost, Wind down, Deep focus, Vibes of the hour, radio and playlist covers.",
        text: audio ? AnalysisText.sound(p) : AnalysisText.audioOff, done: p.sound.ready, failed: p.sound.failed, of: p.songs,
        canRun: audio, verb: "Analyse", meter: "Songs measured for their sound", again: "Reanalyse the entire collection",
        explain: "Sound analysis for every song, from scratch, at low priority. Each song keeps what it has until its turn."),
      row(
        .loudness, "Loudness analysis",
        "How loud each song sounds (EBU R128) and its peak, for Even out the volume in Settings → Playback. A second or two a song.",
        text: audio ? AnalysisText.loudness(p) : "Even volume needs it. \(AnalysisText.audioOff)", done: p.loudness.ready, failed: p.loudness.failed,
        of: p.songs, canRun: audio, verb: "Analyse", meter: "Songs measured for their loudness", again: "Reanalyse the entire collection",
        explain: "Loudness analysis for every song, from scratch, a second or two a song. Each song keeps its level until its turn."),
      row(
        .tags, "Tag lookup",
        "Each song’s genres and year from ListenBrainz, for genre and decade mixes. Only songs matched on MusicBrainz can be looked up; tags are looked up again after a month.",
        text: AnalysisText.tags(p), done: p.tags.ready, failed: 0, of: p.tags.songs, canRun: true, verb: "Look up", meter: "Songs looked up",
        again: "Look up the entire collection again",
        explain: "A tag lookup for every song matched on MusicBrainz, from scratch. Each song keeps its tags until its turn."),
    ]
  }

  /// "Reanalyse everything" shows once there are songs.
  public var offersEverything: Bool { (progress?.songs ?? 0) > 0 }

  private func row(
    _ kind: AnalysisKind, _ title: String, _ description: String, text: String, done: Int, failed: Int, of: Int, canRun: Bool,
    verb: String, meter: String, again: String, explain: String
  ) -> Row {
    // Failed songs wait a day before another try, so they aren't left to start.
    let left = max(0, of - done - failed)
    let allowed = canRun && of > 0
    return Row(
      kind: kind, title: title, description: description, text: text, done: done, of: of, showsBar: canRun && of > 0 && done < of,
      leftLabel: allowed && left > 0 ? "\(verb) the \(AdminText.count(left)) of \(AnalysisText.songs(of)) left" : nil,
      canRun: allowed, againLabel: again, againExplain: explain, meter: meter)
  }
}
```

`UI/Settings/Admin/Analysis/AnalysisPanel.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// Settings → Analysis: the background switch and queue, then one section per analysis with its progress
/// bar, "Analyse the N left" and "Reanalyse the entire collection" (after asking), and "Reanalyse everything".
public struct AnalysisPanel: View {
  @State private var model: AnalysisModel
  @State private var asking: AnalysisModel.Row?
  @State private var askingEverything = false

  public init(api: any APISending) {
    _model = State(initialValue: AnalysisModel(api: api))
  }

  public var body: some View {
    Form {
      if let progress = model.progress {
        Section("In the background") {
          if model.analyzeLibrary != nil {
            Toggle(isOn: Binding(get: { model.analyzeLibraryShown }, set: { on in Task { await model.setAnalyzeLibrary(on) } })) {
              Text("Analyse every song in the library")
              Text(AnalysisText.switchDescription(progress))
            }
            .disabled(!progress.enabled)
          }
          Text(model.queueText).font(.footnote).foregroundStyle(.secondary)
          if model.offersEverything {
            Button("Reanalyse everything") { askingEverything = true }.disabled(model.running)
          }
          if let notice = model.notice { InlineMessage(text: notice, isError: model.failed) }
        }
        ForEach(model.rows) { row in
          Section {
            Text(row.text).font(.footnote)
            if row.showsBar {
              ProgressView(value: Double(row.done), total: Double(max(row.of, 1))).accessibilityLabel(row.meter)
            }
            if row.canRun {
              if let left = row.leftLabel {
                Button(left) { Task { await model.run(row.kind) } }.disabled(model.running)
              }
              Button(row.againLabel) { asking = row }.disabled(model.running)
            }
          } header: {
            Text(row.title)
          } footer: {
            Text(row.description)
          }
        }
      } else if let error = model.loadError {
        InlineMessage(text: error)
      } else {
        ProgressView()
      }
    }
    .navigationTitle("Analysis")
    .task { await model.poll() }
    .alert(asking?.againQuestion ?? "", isPresented: Binding(get: { asking != nil }, set: { if !$0 { asking = nil } }), presenting: asking) { row in
      Button("Cancel", role: .cancel) {}
      Button(row.againLabel) { Task { await model.run(row.kind, again: true) } }
    } message: { row in
      Text(row.againExplain)
    }
    .alert(AnalysisText.everythingTitle, isPresented: $askingEverything) {
      Button("Cancel", role: .cancel) {}
      Button("Reanalyse everything") { Task { await model.run(nil, again: true) } }
    } message: {
      Text(AnalysisText.everythingExplain(audio: model.progress?.enabled ?? false))
    }
  }
}
```

**Step 4: Run the test and build**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter AnalysisModelTests
```

Expected: `Test run with 5 tests in 1 suite passed`. Then run the two build commands from Conventions: `Build complete!` twice.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/Admin/Analysis apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/Admin/AnalysisModelTests.swift
git commit -F - <<'MSG'
iOS: Settings → Analysis: each analysis's progress, polled while songs wait, the songs left, every song again after asking

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 12: Requests

**Files:**
- Create: `UI/Settings/Admin/Requests/RequestSettingsModel.swift`, `UI/Settings/Admin/Requests/RequestsPanel.swift`
- Test: `UITests/Admin/RequestSettingsModelTests.swift`

Ports `RequestsPanel.tsx` and `useSaveRequestSettings` (`queries.ts:384-410`). The panel has two switches and three pickers whose first choice is "Lidarr’s default", sent as `null`. A saved choice Lidarr no longer has still shows as "#4 (no longer in Lidarr)". When the lists couldn't be fetched, the panel says "Couldn’t get the choices from Lidarr: <why>" with Retry. Without a Lidarr source it says so. Every change calls `requestsChanged`, so Request buttons can follow `GET /api/health`.

**Step 1: Write the failing test**

`UITests/Admin/RequestSettingsModelTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct RequestSettingsModelTests {
  let api = FakeAPI()
  let path = "/api/settings/requests"

  static func info(quality: Int? = 4, options: Bool = true) -> RequestSettingsInfo {
    RequestSettingsInfo(
      enabled: true, searchOnAdd: false, rootFolderPath: "/music", qualityProfileId: quality, lidarr: true,
      options: options
        ? .init(
          rootFolders: [.init(path: "/music", freeSpace: 1_610_612_736)],
          qualityProfiles: [.init(id: 1, name: "Lossless")],
          metadataProfiles: [.init(id: 1, name: "Standard")])
        : nil,
      error: options ? nil : "Connection refused")
  }

  @Test func listsLidarrsChoicesAfterTheDefaultKeepingAVanishedOne() async {
    let requests = RequestSettingsModel(api: api)
    api.on(.get, path, Self.info())
    await requests.load()
    #expect(requests.rootFolders.map(\.label) == ["Lidarr’s default", "/music · 1.5 GB free"])
    #expect(requests.qualityProfiles.map(\.label) == ["Lidarr’s default", "#4 (no longer in Lidarr)", "Lossless"])
    #expect(requests.metadataProfiles.map(\.value) == [nil, 1])
  }

  @Test func sendsNullToGoBackToTheDefault() async {
    var changes = 0
    let requests = RequestSettingsModel(api: api) { changes += 1 }
    api.on(.get, path, Self.info())
    await requests.load()
    api.on(.put, path, Self.info(quality: nil))
    await requests.setQualityProfile(nil)
    #expect(api.bodies(.put, path) == [#"{"qualityProfileId":null}"#])
    #expect(requests.info?.qualityProfileId == nil)
    #expect(changes == 1)
  }

  @Test func putsASwitchBackWhenSavingFails() async {
    let requests = RequestSettingsModel(api: api)
    api.on(.get, path, Self.info())
    await requests.load()
    api.fail(.put, path, "Lidarr isn’t set up")
    await requests.setEnabled(false)
    #expect(requests.info?.enabled == true)
    #expect(requests.notice == "Couldn’t save: Lidarr isn’t set up")
  }

  @Test func explainsMissingChoicesAndRetries() async {
    let requests = RequestSettingsModel(api: api)
    api.on(.get, path, Self.info(options: false))
    await requests.load()
    #expect(requests.optionsProblem == "Couldn’t get the choices from Lidarr: Connection refused")
    api.on(.get, path, Self.info())
    await requests.retry()
    #expect(requests.optionsProblem == nil)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter RequestSettingsModelTests
```

Expected: the build fails with `cannot find 'RequestSettingsModel' in scope`.

**Step 3: Implement**

`UI/Settings/Admin/Requests/RequestSettingsModel.swift`:

```swift
import Foundation
import Observation
import PlayarrAPI

/// Settings → Requests: whether people can request albums, whether Lidarr searches at once, and where new
/// artists go (root folder, quality and metadata profiles from Lidarr's lists; nothing chosen: Lidarr's default).
@MainActor @Observable
public final class RequestSettingsModel {
  /// One picker's choices: the default first, a saved choice Lidarr no longer has, then Lidarr's.
  public struct Choice<Value: Hashable>: Hashable {
    public let value: Value?
    public let label: String
  }

  public private(set) var info: RequestSettingsInfo?
  public private(set) var loadError: String?
  public private(set) var retrying = false
  public private(set) var notice: String?

  @ObservationIgnored private let api: any APISending
  @ObservationIgnored private let requestsChanged: @MainActor () -> Void

  public static let defaultLabel = "Lidarr’s default"
  public static let defaultHelp = "Lidarr’s default is the root folder’s own setting, or the value in Playarr’s .env file when there is one."

  public init(api: any APISending, requestsChanged: @escaping @MainActor () -> Void = {}) {
    self.api = api
    self.requestsChanged = requestsChanged
  }

  public func load() async {
    do {
      info = try await api.send(API.Settings.requests())
      loadError = nil
    } catch {
      loadError = failureText(error)
    }
  }

  /// Retry after Lidarr's choices couldn't be fetched.
  public func retry() async {
    retrying = true
    defer { retrying = false }
    await load()
  }

  /// "Couldn’t get the choices from Lidarr: <why>", when Lidarr is set up but its lists didn't come.
  public var optionsProblem: String? {
    guard let info, info.lidarr, info.options == nil else { return nil }
    return "Couldn’t get the choices from Lidarr\(info.error.map { ": \($0)" } ?? ".")"
  }

  public var rootFolders: [Choice<String>] {
    choices(
      info?.rootFolderPath, info?.options?.rootFolders.map { folder in
        (folder.path, folder.freeSpace.map { "\(folder.path) · \(AdminText.bytes($0)) free" } ?? folder.path)
      } ?? [], missing: { $0 })
  }

  public var qualityProfiles: [Choice<Int>] {
    choices(info?.qualityProfileId, info?.options?.qualityProfiles.map { ($0.id, $0.name) } ?? [], missing: { "#\($0)" })
  }

  public var metadataProfiles: [Choice<Int>] {
    choices(info?.metadataProfileId, info?.options?.metadataProfiles.map { ($0.id, $0.name) } ?? [], missing: { "#\($0)" })
  }

  public func setEnabled(_ on: Bool) async { await save(RequestSettingsPatch(enabled: on)) { $0.enabled = on } }
  public func setSearchOnAdd(_ on: Bool) async { await save(RequestSettingsPatch(searchOnAdd: on)) { $0.searchOnAdd = on } }

  /// nil goes back to Lidarr's default (sent as null).
  public func setRootFolder(_ path: String?) async {
    await save(RequestSettingsPatch(rootFolderPath: .some(path))) { $0.rootFolderPath = path }
  }

  public func setQualityProfile(_ id: Int?) async {
    await save(RequestSettingsPatch(qualityProfileId: .some(id))) { $0.qualityProfileId = id }
  }

  public func setMetadataProfile(_ id: Int?) async {
    await save(RequestSettingsPatch(metadataProfileId: .some(id))) { $0.metadataProfileId = id }
  }

  private func choices<Value: Hashable>(_ saved: Value?, _ options: [(Value, String)], missing: (Value) -> String) -> [Choice<Value>] {
    var list = [Choice<Value>(value: nil, label: Self.defaultLabel)]
    // A choice Lidarr no longer has still shows, so it's clear why the default is used.
    if let saved, !options.contains(where: { $0.0 == saved }) {
      list.append(Choice(value: saved, label: "\(missing(saved)) (no longer in Lidarr)"))
    }
    list += options.map { Choice(value: $0.0, label: $0.1) }
    return list
  }

  private func save(_ patch: RequestSettingsPatch, _ apply: (inout RequestSettingsInfo) -> Void) async {
    guard var shown = info else { return }
    let previous = shown
    apply(&shown)
    info = shown
    do {
      info = try await api.send(API.Settings.saveRequests(patch))
      notice = nil
    } catch {
      info = previous
      notice = "Couldn’t save: \(failureText(error))"
    }
    // Request buttons follow GET /api/health's `requests`.
    requestsChanged()
  }
}
```

`UI/Settings/Admin/Requests/RequestsPanel.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// Settings → Requests.
public struct RequestsPanel: View {
  @State private var model: RequestSettingsModel

  public init(api: any APISending, requestsChanged: @escaping @MainActor () -> Void = {}) {
    _model = State(initialValue: RequestSettingsModel(api: api, requestsChanged: requestsChanged))
  }

  public var body: some View {
    Form {
      if let info = model.info {
        if !info.lidarr {
          Text("Requests need a Lidarr source. You can add one in Sources.")
        } else {
          if let notice = model.notice { InlineMessage(text: notice) }
          Section("Requests") {
            Toggle(isOn: Binding(get: { info.enabled }, set: { on in Task { await model.setEnabled(on) } })) {
              Text("Let people request albums")
              Text("Off hides every Request button, for everyone, and Playarr refuses new requests.")
            }
            Toggle(isOn: Binding(get: { info.searchOnAdd }, set: { on in Task { await model.setSearchOnAdd(on) } })) {
              Text("Search for an album as soon as it’s requested")
              Text("Off only adds the album to Lidarr as wanted, and Lidarr searches for it on its own schedule.")
            }
          }
          destination(info)
        }
      } else if let error = model.loadError {
        InlineMessage(text: error)
      } else {
        ProgressView()
      }
    }
    .navigationTitle("Requests")
    .task { await model.load() }
  }

  private func destination(_ info: RequestSettingsInfo) -> some View {
    Section {
      if let problem = model.optionsProblem {
        InlineMessage(text: problem)
        Button(model.retrying ? "Retrying…" : "Retry", systemImage: "arrow.clockwise") { Task { await model.retry() } }.disabled(model.retrying)
      } else {
        Picker("Root folder", selection: Binding(get: { info.rootFolderPath }, set: { value in Task { await model.setRootFolder(value) } })) {
          ForEach(model.rootFolders, id: \.self) { Text($0.label).tag($0.value) }
        }
        Picker("Quality profile", selection: Binding(get: { info.qualityProfileId }, set: { value in Task { await model.setQualityProfile(value) } })) {
          ForEach(model.qualityProfiles, id: \.self) { Text($0.label).tag($0.value) }
        }
        Picker("Metadata profile", selection: Binding(get: { info.metadataProfileId }, set: { value in Task { await model.setMetadataProfile(value) } })) {
          ForEach(model.metadataProfiles, id: \.self) { Text($0.label).tag($0.value) }
        }
      }
    } header: {
      Text("Where new artists go")
    } footer: {
      Text(
        "When a request brings in an artist Lidarr doesn’t have yet, it’s added with these. Artists already in Lidarr keep their own. \(RequestSettingsModel.defaultHelp)")
    }
  }
}
```

**Step 4: Run the test and build**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter RequestSettingsModelTests
```

Expected: `Test run with 4 tests in 1 suite passed`. Then run the two build commands from Conventions: `Build complete!` twice.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/Admin/Requests apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/Admin/RequestSettingsModelTests.swift
git commit -F - <<'MSG'
iOS: Settings → Requests: let people request, search on add, and where new artists go from Lidarr's lists

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 13: Updates

**Files:**
- Create: `UI/Settings/Admin/Updates/UpdatesModel.swift`, `UI/Settings/Admin/Updates/UpdatesPanel.swift`
- Test: `UITests/Admin/UpdatesModelTests.swift`

Ports `UpdatesPanel.tsx` and `useUpdates`/`useSaveUpdates`/`useCheckForUpdates` (`queries.ts:412-452`). The panel has Version (the server's), the latest commit on GitHub with "Up to date" or "A newer version is available", the automatic switch and its interval ("15 minutes", "Hour", "6 hours", "Day"; disabled while off), and the last check ("2 minutes ago · Already up to date" or "· Updated to 1a2b3c4", or the failure in red). Check now reads "Checking…" while waiting, and "Show log" shows the log. When the updater isn't running, the panel explains how to start it (`sudo sh update.sh`).

**Step 1: Write the failing test**

`UITests/Admin/UpdatesModelTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct UpdatesModelTests {
  let api = FakeAPI()
  let clock = TestClock()
  let now = Date(timeIntervalSince1970: 1_800_000_000)

  func info(state: String = "idle", requested: Bool = false, lastCheck: Int = 1_800_000_000 - 120, lastUpdate: Int = 0, available: Bool = true, reason: String? = nil) -> String {
    #"{"enabled":true,"intervalMinutes":60,"available":\#(available),"requested":\#(requested),\#(reason.map { #""reason":"\#($0)","# } ?? "")"status":{"state":"\#(state)","lastCheck":\#(lastCheck),"lastUpdate":\#(lastUpdate),"deployed":"1a2b3c4d5e","latest":"9f8e7d6c5b"},"log":"Pulling main"}"#
  }

  func model() -> UpdatesModel {
    api.on(.get, "/api/server", json: #"{"id":"srv","name":"NAS","version":"0.7.3","minAppVersion":"1.0.0","setup":false}"#)
    return UpdatesModel(api: api, clock: clock)
  }

  @Test func saysTheVersionAndTheLastCheck() async {
    let updates = model()
    api.on(.get, "/api/settings/updates", json: info())
    await updates.load()
    #expect(updates.versionText == "Playarr v0.7.3 · 1a2b3c4")
    #expect(updates.latestText == "Latest on GitHub: 9f8e7d6 · A newer version is available")
    #expect(updates.lastCheck(now: now) == ("2 minutes ago · Already up to date", false))
    api.on(.get, "/api/settings/updates", json: info(lastCheck: 1_800_000_000 - 120, lastUpdate: 1_800_000_000 - 120))
    await updates.load()
    #expect(updates.lastCheck(now: now).text == "2 minutes ago · Updated to 1a2b3c4")
  }

  @Test func checksNowAndPollsQuicklyUntilTheUpdaterIsDone() async {
    let updates = model()
    api.on(.get, "/api/settings/updates", json: info())
    let polling = Task { await updates.poll() }
    #expect(await clock.nextSleep() == .seconds(60))
    api.on(.post, "/api/settings/updates/check", json: info(requested: true))
    await updates.checkNow()
    #expect(updates.busy && updates.checkLabel == "Checking…")
    polling.cancel()
    api.on(.get, "/api/settings/updates", json: info(state: "checking"))
    api.then(.get, "/api/settings/updates", json: info(state: "failed"))
    let again = Task { await updates.poll() }
    #expect(await clock.nextSleep() == .seconds(5))
    #expect(updates.lastCheck(now: now).text == "Checking for a new version…")
    clock.advance(by: .seconds(5))
    #expect(await clock.nextSleep() == .seconds(60))
    #expect(updates.lastCheck(now: now) == ("2 minutes ago · The update failed", true))
    again.cancel()
  }

  @Test func savesTheScheduleAndPutsItBackOnFailure() async {
    let updates = model()
    api.on(.get, "/api/settings/updates", json: info())
    await updates.load()
    api.fail(.put, "/api/settings/updates", status: 503, "The updater isn’t running")
    await updates.setInterval(1440)
    #expect(api.bodies(.put, "/api/settings/updates") == [#"{"intervalMinutes":1440}"#])
    #expect(updates.info?.intervalMinutes == 60)
    #expect(updates.notice == "Couldn’t save: The updater isn’t running")
  }

  @Test func explainsHowToStartTheUpdater() async {
    let updates = model()
    api.on(.get, "/api/settings/updates", json: info(available: false, reason: "Run update.sh once to start the updater"))
    await updates.load()
    #expect(updates.unavailable?.command == "sudo sh update.sh")
    api.on(.get, "/api/settings/updates", json: info(available: false, reason: "Not a Docker install"))
    await updates.load()
    #expect(updates.unavailable?.text == "Not a Docker install.")
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter UpdatesModelTests
```

Expected: the build fails with `cannot find 'UpdatesModel' in scope`.

**Step 3: Implement**

`UI/Settings/Admin/Updates/UpdatesModel.swift`:

```swift
import Foundation
import Observation
import PlayarrAPI

/// Settings → Updates (Docker installs with the updater running): update from GitHub main automatically or
/// not, how often to check, Check now, and the last run's log. Polled every 5 s while a check is waiting or
/// running, every minute otherwise.
@MainActor @Observable
public final class UpdatesModel {
  public static let intervals: [(minutes: Int, label: String)] = [(15, "15 minutes"), (60, "Hour"), (360, "6 hours"), (1440, "Day")]
  public static let intro =
    "Playarr downloads the latest version from GitHub, rebuilds itself and restarts. The music keeps playing from your device’s cache, and a failed update leaves the running version alone."
  public static let startCommand = "sudo sh update.sh"

  public private(set) var info: UpdateInfo?
  public private(set) var loadError: String?
  /// The server's version (GET /api/server).
  public private(set) var serverVersion: String?
  public private(set) var checking = false
  public private(set) var notice: String?

  @ObservationIgnored private let api: any APISending
  @ObservationIgnored private let clock: any Clock<Duration>

  public init(api: any APISending, clock: any Clock<Duration> = ContinuousClock()) {
    self.api = api
    self.clock = clock
  }

  /// A Check now is waiting for the updater, or the updater is checking.
  public var busy: Bool { info?.requested == true || info?.status?.state.rawValue == "checking" }

  var pollInterval: Duration { busy ? .seconds(5) : .seconds(60) }

  public func poll() async {
    await Polling.run(clock: clock, interval: { [weak self] in self?.pollInterval }) { [weak self] in await self?.load() }
  }

  public func load() async {
    do {
      info = try await api.send(API.Settings.updates())
      loadError = nil
    } catch {
      loadError = failureText(error)
    }
    if serverVersion == nil { serverVersion = try? await api.send(API.Server.info()).version }
  }

  public func setEnabled(_ on: Bool) async { await save(UpdateSettingsPatch(enabled: on)) { $0.enabled = on } }
  public func setInterval(_ minutes: Int) async { await save(UpdateSettingsPatch(intervalMinutes: minutes)) { $0.intervalMinutes = minutes } }

  /// The updater picks it up within half a minute.
  public func checkNow() async {
    checking = true
    defer { checking = false }
    do {
      info = try await api.send(API.Settings.checkForUpdates())
      notice = nil
    } catch {
      notice = "Couldn’t check for updates: \(failureText(error))"
    }
  }

  public var checkLabel: String { busy ? "Checking…" : "Check now" }

  /// "Playarr v0.7.3 · 1a2b3c4".
  public var versionText: String {
    let deployed = info?.status?.deployed.map { " · \(short($0))" } ?? ""
    return "Playarr v\(serverVersion ?? "?")\(deployed)"
  }

  /// "Latest on GitHub: 9f8e7d6 · A newer version is available".
  public var latestText: String? {
    guard let latest = info?.status?.latest else { return nil }
    var text = "Latest on GitHub: \(short(latest))"
    if let running = info?.status?.deployed {
      let upToDate = latest.hasPrefix(running) || running.hasPrefix(latest)
      text += upToDate ? " · Up to date" : " · A newer version is available"
    }
    return text
  }

  /// Why updates can't be managed here, and the command that starts the updater when that's the reason.
  public var unavailable: (text: String, command: String?)? {
    guard let info, !info.available else { return nil }
    if info.reason?.contains("update.sh") == true {
      return ("The updater isn’t running yet. To start it, run this once in Playarr’s folder on the server:", Self.startCommand)
    }
    return ("\(info.reason ?? "Automatic updates aren’t available here").", nil)
  }

  /// "2 minutes ago · Already up to date", and whether it's a failure.
  public func lastCheck(now: Date = Date()) -> (text: String, failed: Bool) {
    let status = info?.status
    if status?.state.rawValue == "checking" || (info?.requested == true && (status?.lastCheck ?? 0) == 0) {
      return ("Checking for a new version…", false)
    }
    guard let status, status.lastCheck > 0 else { return ("Not checked yet.", false) }
    let when = AdminText.ago(status.lastCheck, now: now)
    if status.state.rawValue == "failed" { return ("\(when) · \(status.error ?? "The update failed")", true) }
    if status.lastUpdate == status.lastCheck, let deployed = status.deployed { return ("\(when) · Updated to \(short(deployed))", false) }
    return ("\(when) · Already up to date", false)
  }

  private func short(_ sha: String) -> String { String(sha.prefix(7)) }

  private func save(_ patch: UpdateSettingsPatch, _ apply: (inout UpdateInfo) -> Void) async {
    guard var shown = info else { return }
    let previous = shown
    apply(&shown)
    info = shown
    do {
      info = try await api.send(API.Settings.saveUpdates(patch))
      notice = nil
    } catch {
      info = previous
      notice = "Couldn’t save: \(failureText(error))"
    }
  }
}
```

`UI/Settings/Admin/Updates/UpdatesPanel.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// Settings → Updates.
public struct UpdatesPanel: View {
  @State private var model: UpdatesModel

  public init(api: any APISending) {
    _model = State(initialValue: UpdatesModel(api: api))
  }

  public var body: some View {
    Form {
      if let info = model.info {
        Section { Text(UpdatesModel.intro).font(.footnote).foregroundStyle(.secondary) }
        Section("Version") {
          Text(model.versionText)
          if let latest = model.latestText { Text(latest).font(.footnote).foregroundStyle(.secondary) }
        }
        if let notice = model.notice { InlineMessage(text: notice) }
        if let unavailable = model.unavailable {
          Section("Automatic updates") {
            Text(unavailable.text)
            if let command = unavailable.command { Text(command).font(.body.monospaced()).textSelection(.enabled) }
          }
        } else {
          Section("Automatic updates") {
            Toggle(isOn: Binding(get: { info.enabled }, set: { on in Task { await model.setEnabled(on) } })) {
              Text("Update Playarr from GitHub automatically")
              Text("Only the main branch of Playarr’s repository is ever installed.")
            }
            Picker("Check every", selection: Binding(get: { info.intervalMinutes }, set: { value in Task { await model.setInterval(value) } })) {
              ForEach(UpdatesModel.intervals, id: \.minutes) { Text($0.label).tag($0.minutes) }
            }
            .disabled(!info.enabled)
          }
          Section("Last check") {
            let last = model.lastCheck()
            Text(last.text).foregroundStyle(last.failed ? .red : .primary)
            Button(model.checkLabel, systemImage: "arrow.clockwise") { Task { await model.checkNow() } }
              .disabled(model.busy || model.checking)
            if let log = info.log {
              DisclosureGroup("Show log") {
                ScrollView(.horizontal) { Text(log).font(.caption.monospaced()).textSelection(.enabled) }
              }
            }
          }
        }
      } else if let error = model.loadError {
        InlineMessage(text: error)
      } else {
        ProgressView()
      }
    }
    .navigationTitle("Updates")
    .task { await model.poll() }
  }
}
```

**Step 4: Run the test and build**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter UpdatesModelTests
```

Expected: `Test run with 4 tests in 1 suite passed`. Then run the two build commands from Conventions: `Build complete!` twice.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/Admin/Updates apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/Admin/UpdatesModelTests.swift
git commit -F - <<'MSG'
iOS: Settings → Updates: automatic updates and how often, Check now polled until the updater is done, the last log

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 14: Accounts: the models

**Files:**
- Create: `UI/Settings/Admin/Accounts/AccountFormModel.swift`, `UI/Settings/Admin/Accounts/AccountsModel.swift`
- Test: `UITests/Admin/AccountsModelTests.swift`

Ports phase 1's `AccountsPanel.tsx` (its Task 21). Everyone has "Your name" with Save, their devices with sign-out for each but this one, and "Sign out on this device". Admins also get everyone with a summary line ("reviewer · member · Creative Commons · not set up yet"), add (with a setup code), edit, a new setup code, remove (never the last admin) and anyone's devices. The form's defaults are the web's: member, can request albums, every source. "Only these sources" picks among the server's sources, sent in their priority order. The username is checked against the server's rule after lowercasing, with the server's own message, so it fails before the round trip. Every other refusal (a taken username, the last admin) shows the server's `{ error }`. `accountChanged` keeps `ServerStore`'s copy of the signed-in account current after a rename or a role change, and removing yourself signs you out here.

**Step 1: Write the failing test**

`UITests/Admin/AccountsModelTests.swift`:

```swift
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct AccountsModelTests {
  let api = FakeAPI()
  static let nicola = Account(id: 1, username: "nicola", name: "Nicola", role: .admin, canRequest: true, sources: nil, hasPassword: true)
  static let sam = Account(id: 2, username: "sam", name: "Sam", role: .member, canRequest: false, sources: nil, hasPassword: true)
  static let creativeCommons = Samples.folder(id: 2, name: "Creative Commons")
  static let setup = SetupCode(code: "ABCD2345", link: "http://nas:4000/redeem?code=ABCD2345", expiresAt: "2026-11-10T10:00:00Z")
  static let phone = SessionInfo(id: 7, device: "iPhone", platform: "ios", createdAt: "2026-11-03T10:00:00Z", lastSeenAt: "2026-11-03T11:00:00Z", current: true)
  static let ipad = SessionInfo(id: 8, device: "Playarr on iPad", platform: "ipados", createdAt: "2026-11-02T10:00:00Z", lastSeenAt: "2026-11-02T11:00:00Z", current: false)

  func signedIn(as me: Account) {
    api.on(.get, "/api/auth/me", me)
    api.on(.get, "/api/accounts/\(me.id)/sessions", [Self.phone, Self.ipad])
    api.on(.get, "/api/accounts", [Self.nicola, Self.sam])
    api.on(.get, "/api/settings/sources", Samples.sources([Samples.lidarr(), Self.creativeCommons]))
  }

  @Test func showsAMemberOnlyTheirOwnNameAndDevices() async {
    signedIn(as: Self.sam)
    let model = AccountsModel(api: api)
    await model.load()
    #expect(!model.isAdmin && model.accounts == nil)
    #expect(model.signedInText == "Signed in as sam.")
    #expect(model.sessions[2]?.map(\.device) == ["iPhone", "Playarr on iPad"])
    #expect(api.calls(.get, "/api/accounts").isEmpty)
    api.on(.delete, "/api/accounts/2/sessions/8", [Self.phone])
    await model.endSession(Self.ipad, of: 2)
    #expect(model.sessions[2]?.count == 1)
  }

  @Test func renamesYouAndTellsTheStore() async {
    signedIn(as: Self.sam)
    var stored: Account?
    let model = AccountsModel(api: api, accountChanged: { stored = $0 })
    await model.load()
    #expect(!model.canRename)
    model.name = " Samantha "
    var renamed = Self.sam
    renamed.name = "Samantha"
    api.on(.patch, "/api/accounts/2", renamed)
    await model.rename()
    #expect(api.bodies(.patch, "/api/accounts/2") == [#"{"name":"Samantha"}"#])
    #expect(stored?.name == "Samantha" && model.notice == "Name saved")
  }

  @Test func addsAnAccountAndShowsItsSetupCode() async {
    signedIn(as: Self.nicola)
    let model = AccountsModel(api: api)
    await model.load()
    let form = AccountFormModel(account: nil, sources: model.sources)
    #expect(form.canRequest && form.everySource && form.role == .member)
    form.name = "App Review"
    form.username = "Reviewer!"
    #expect(form.usernameProblem == AccountFormModel.usernameRule && !form.canSubmit)
    form.username = " Reviewer "
    form.canRequest = false
    form.everySource = false
    form.toggle(Self.creativeCommons)
    let reviewer = Account(id: 3, username: "reviewer", name: "App Review", role: .member, canRequest: false, sources: [2], hasPassword: false)
    api.on(.post, "/api/accounts", CreatedAccount(account: reviewer, setup: Self.setup))
    #expect(await model.create(form))
    #expect(api.bodies(.post, "/api/accounts") == [#"{"canRequest":false,"name":"App Review","role":"member","sources":[2],"username":"reviewer"}"#])
    #expect(model.setupShown?.setup.code == "ABCD2345")
    #expect(model.accounts?.map(\.id) == [1, 2, 3])
    #expect(model.summary(reviewer) == "reviewer · member · Creative Commons · not set up yet")
    #expect(AccountsModel.setupText(Self.setup).hasPrefix("Give them this code or link: they choose their own password with it. It works once, until "))
  }

  @Test func showsTheServersMessageWhenAUsernameIsTaken() async {
    signedIn(as: Self.nicola)
    let model = AccountsModel(api: api)
    await model.load()
    let form = AccountFormModel(account: nil, sources: [])
    form.name = "Sam"
    form.username = "sam"
    api.fail(.post, "/api/accounts", "That username is taken")
    #expect(await model.create(form) == false)
    #expect(model.error == "That username is taken" && model.setupShown == nil)
  }

  @Test func sendsOnlyWhatChangedWhenEditing() async {
    signedIn(as: Self.nicola)
    let model = AccountsModel(api: api)
    await model.load()
    let form = AccountFormModel(account: Self.sam, sources: model.sources)
    #expect(form.patch == nil)
    #expect(await model.update(form))
    #expect(api.calls(.patch, "/api/accounts/2").isEmpty)
    form.canRequest = true
    form.everySource = false
    form.toggle(Self.creativeCommons)
    var changed = Self.sam
    changed.canRequest = true
    changed.sources = [2]
    api.on(.patch, "/api/accounts/2", changed)
    #expect(await model.update(form))
    #expect(api.bodies(.patch, "/api/accounts/2") == [#"{"canRequest":true,"sources":[2]}"#])
    #expect(model.accounts?.last?.sources == [2])
  }

  @Test func givesEverySourceBackWithNull() {
    var restricted = Self.sam
    restricted.sources = [2]
    let form = AccountFormModel(account: restricted, sources: [])
    form.everySource = true
    #expect(form.patch == AccountPatch(sources: .some(nil)))
  }

  @Test func resetsAnAccountWithANewCode() async {
    signedIn(as: Self.nicola)
    let model = AccountsModel(api: api)
    await model.load()
    api.on(.post, "/api/accounts/2/reset", Self.setup)
    await model.reset(Self.sam)
    #expect(model.setupShown?.account.hasPassword == false)
    #expect(model.summary(model.accounts![1]) == "sam · member · every source · not set up yet")
    #expect(model.sessions[2] == [])
  }

  @Test func neverOffersToRemoveTheLastAdmin() async {
    signedIn(as: Self.nicola)
    let model = AccountsModel(api: api)
    await model.load()
    #expect(!model.canRemove(Self.nicola) && model.canRemove(Self.sam))
    api.on(.delete, "/api/accounts/2", [Self.nicola])
    await model.remove(Self.sam)
    #expect(model.accounts == [Self.nicola])
    #expect(model.removeTitle(Self.sam) == "Remove Sam?")
  }

  @Test func signsOutHereAfterRemovingYourself() async {
    var nicola2 = Self.nicola
    nicola2.id = 5
    signedIn(as: nicola2)
    api.on(.get, "/api/accounts", [Self.nicola, nicola2])
    var signedOut = false
    let model = AccountsModel(api: api, signOutHere: { signedOut = true })
    await model.load()
    api.on(.delete, "/api/accounts/5", [Self.nicola])
    await model.remove(nicola2)
    #expect(signedOut)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter AccountsModelTests
```

Expected: the build fails with `cannot find 'AccountsModel' in scope` and `cannot find 'AccountFormModel' in scope`.

**Step 3: Implement**

`UI/Settings/Admin/Accounts/AccountFormModel.swift`:

```swift
import Foundation
import Observation
import PlayarrAPI

/// Name, username, role, requests and library: for a new account, or to change one (AccountsPanel.tsx: AccountForm).
@MainActor @Observable
public final class AccountFormModel {
  public let account: Account?
  public var name: String
  public var username: String
  public var role: AccountRole
  public var canRequest: Bool
  public var everySource: Bool
  public private(set) var picked: [Int]
  /// The sources to pick from, in their priority order.
  public let sources: [SourceInfo]

  /// The server's rule (apps/server/src/accounts/username.ts), after lowercasing.
  static let usernamePattern = /^[a-z0-9][a-z0-9._-]{0,31}$/
  public static let usernameRule = "A username is 1 to 32 lowercase letters, digits, dots, dashes or underscores"

  public init(account: Account?, sources: [SourceInfo]) {
    self.account = account
    self.sources = sources
    name = account?.name ?? ""
    username = account?.username ?? ""
    role = account?.role ?? .member
    canRequest = account?.canRequest ?? true
    everySource = account.map { $0.sources == nil } ?? true
    picked = account?.sources ?? []
  }

  public func isPicked(_ source: SourceInfo) -> Bool { picked.contains(source.id) }

  public func toggle(_ source: SourceInfo) {
    if let index = picked.firstIndex(of: source.id) { picked.remove(at: index) } else { picked.append(source.id) }
  }

  var cleanUsername: String { username.trimmed.lowercased() }

  /// Shown under the username once it can't be one.
  public var usernameProblem: String? {
    guard !username.trimmed.isEmpty, cleanUsername.wholeMatch(of: Self.usernamePattern) == nil else { return nil }
    return Self.usernameRule
  }

  public var canSubmit: Bool {
    !name.trimmed.isEmpty && name.trimmed.count <= 40 && !username.trimmed.isEmpty && usernameProblem == nil
  }

  /// The library as the server wants it: nil for every source, else the picked ones in the list's order.
  var chosenSources: [Int]? {
    everySource ? nil : sources.map(\.id).filter(picked.contains) + picked.filter { id in !sources.contains { $0.id == id } }
  }

  /// POST /api/accounts.
  public var createEndpoint: Endpoint<CreatedAccount> {
    API.Accounts.create(username: cleanUsername, name: name.trimmed, role: role, canRequest: canRequest, sources: chosenSources)
  }

  /// PATCH /api/accounts/:id with only what changed; nil when nothing did.
  public var patch: AccountPatch? {
    guard let account else { return nil }
    var patch = AccountPatch()
    if cleanUsername != account.username { patch.username = cleanUsername }
    if name.trimmed != account.name { patch.name = name.trimmed }
    if role != account.role { patch.role = role }
    if canRequest != account.canRequest { patch.canRequest = canRequest }
    if chosenSources != account.sources { patch.sources = .some(chosenSources) }
    return patch == AccountPatch() ? nil : patch
  }
}
```

`UI/Settings/Admin/Accounts/AccountsModel.swift`:

```swift
import Foundation
import Observation
import PlayarrAPI

/// Settings → Accounts. Everyone renames themselves, sees the devices they're signed in on, signs any of
/// them out, and signs out here. Admins also list, add (a setup code to hand over), change, reset and
/// remove accounts, and sign out anyone's devices (AccountsPanel.tsx).
@MainActor @Observable
public final class AccountsModel {
  /// A new or reset account's one-time code, on screen until dismissed.
  public struct SetupShown: Identifiable, Equatable {
    public let account: Account
    public let setup: SetupCode
    public var id: String { setup.code }
  }

  public private(set) var me: Account?
  /// Every account (admins only).
  public private(set) var accounts: [Account]?
  /// For the library picker and the accounts' summaries (admins only).
  public private(set) var sources: [SourceInfo] = []
  public private(set) var sessions: [Int: [SessionInfo]] = [:]
  public private(set) var loadError: String?
  public private(set) var busy = false
  public var error: String?
  public private(set) var notice: String?
  public var setupShown: SetupShown?
  /// "Your name".
  public var name = ""

  @ObservationIgnored private let api: any APISending
  @ObservationIgnored private let signOutHere: @MainActor () async -> Void
  @ObservationIgnored private let accountChanged: @MainActor (Account) -> Void

  public static let everyoneIntro =
    "Each account has its own history, mixes, favorites and playlists, and hears every source or only the ones you pick. Admins change settings, sources and accounts. You never choose anyone’s password: a new or reset account gets a setup code."
  public static let removeMessage =
    "Their listening history, mixes, favorites and playlists are deleted, and every device they’re signed in on is signed out."
  public static let resetMessage = "Their password stops working, every device they’re signed in on is signed out, and they choose a new password with the code."

  /// `signOutHere` ends this device's session (ServerStore.signOut); `accountChanged` keeps the store's copy of
  /// the signed-in account current (ServerStore.update).
  public init(
    api: any APISending, signOutHere: @escaping @MainActor () async -> Void = {}, accountChanged: @escaping @MainActor (Account) -> Void = { _ in }
  ) {
    self.api = api
    self.signOutHere = signOutHere
    self.accountChanged = accountChanged
  }

  public var isAdmin: Bool { me?.role == .admin }

  public func load() async {
    do {
      let me = try await api.send(API.Auth.me())
      self.me = me
      name = me.name
      loadError = nil
      await loadSessions(of: me.id)
      if me.role == .admin {
        accounts = try await api.send(API.Accounts.list())
        sources = (try? await api.send(API.Settings.sources()))?.sources ?? []
      }
    } catch {
      loadError = failureText(error)
    }
  }

  public func loadSessions(of accountId: Int) async {
    if let list = try? await api.send(API.Accounts.sessions(accountId: accountId)) { sessions[accountId] = list }
  }

  /// "Signed in as sam, an admin."
  public var signedInText: String {
    guard let me else { return "" }
    return "Signed in as \(me.username)\(me.role == .admin ? ", an admin" : "")."
  }

  public var canRename: Bool { !busy && !name.trimmed.isEmpty && name.trimmed.count <= 40 && name.trimmed != me?.name }

  public func rename() async {
    guard canRename, let me else { return }
    await act {
      let renamed = try await api.send(API.Accounts.update(id: me.id, AccountPatch(name: name.trimmed)))
      self.me = renamed
      replace(renamed)
      accountChanged(renamed)
      notice = "Name saved"
    }
  }

  /// Signs out one device of an account (not this one: that's "Sign out on this device").
  public func endSession(_ session: SessionInfo, of accountId: Int) async {
    await act { sessions[accountId] = try await api.send(API.Accounts.endSession(accountId: accountId, sessionId: session.id)) }
  }

  /// "Sign out on this device".
  public func signOut() async {
    await signOutHere()
  }

  /// Adds the account and shows its setup code; true once added.
  public func create(_ form: AccountFormModel) async -> Bool {
    guard form.canSubmit else { return false }
    return await act {
      let created = try await api.send(form.createEndpoint)
      accounts = (accounts ?? []) + [created.account]
      setupShown = SetupShown(account: created.account, setup: created.setup)
    }
  }

  /// Saves what changed in the form; true once saved (or when nothing changed).
  public func update(_ form: AccountFormModel) async -> Bool {
    guard form.canSubmit, let account = form.account else { return false }
    guard let patch = form.patch else { return true }
    return await act {
      let changed = try await api.send(API.Accounts.update(id: account.id, patch))
      replace(changed)
      if changed.id == me?.id {
        me = changed
        accountChanged(changed)
      }
    }
  }

  /// After the question: a new setup code; the account is signed out everywhere.
  public func reset(_ account: Account) async {
    await act {
      let setup = try await api.send(API.Accounts.reset(id: account.id))
      sessions[account.id] = []
      var reset = account
      reset.hasPassword = false
      replace(reset)
      setupShown = SetupShown(account: reset, setup: setup)
    }
  }

  /// The server keeps at least one admin.
  public func canRemove(_ account: Account) -> Bool {
    account.role != .admin || (accounts ?? []).filter { $0.role == .admin }.count > 1
  }

  /// After the question. Removing yourself signs you out here.
  public func remove(_ account: Account) async {
    let removed = await act { accounts = try await api.send(API.Accounts.delete(id: account.id)) }
    if removed, account.id == me?.id { await signOutHere() }
  }

  public func removeTitle(_ account: Account) -> String { "Remove \(account.name)?" }
  public func resetTitle(_ account: Account) -> String { "New setup code for \(account.name)?" }

  /// "sam · member · can request albums · Creative Commons · not set up yet".
  public func summary(_ account: Account) -> String {
    let names = Dictionary(sources.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
    let library: String
    if let ids = account.sources {
      library = ids.isEmpty ? "no sources" : ids.map { names[$0] ?? "source \($0)" }.joined(separator: ", ")
    } else {
      library = "every source"
    }
    return [account.username, account.role.rawValue, account.canRequest ? "can request albums" : nil, library, account.hasPassword ? nil : "not set up yet"]
      .compactMap { $0 }
      .joined(separator: " · ")
  }

  /// "Give them this code or link: …. It works once, until 10 November."
  public static func setupText(_ setup: SetupCode) -> String {
    let until = AdminText.date(setup.expiresAt).map { $0.formatted(.dateTime.day().month(.wide)) } ?? setup.expiresAt
    return "Give them this code or link: they choose their own password with it. It works once, until \(until)."
  }

  private func replace(_ account: Account) {
    if let index = accounts?.firstIndex(where: { $0.id == account.id }) { accounts?[index] = account }
  }

  @discardableResult
  private func act(_ work: () async throws -> Void) async -> Bool {
    busy = true
    error = nil
    notice = nil
    defer { busy = false }
    do {
      try await work()
      return true
    } catch {
      self.error = failureText(error)
      return false
    }
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter AccountsModelTests
```

Expected: `Test run with 9 tests in 1 suite passed`.

**Step 5: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/Admin/Accounts/AccountFormModel.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/Admin/Accounts/AccountsModel.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/Admin/AccountsModelTests.swift
git commit -F - <<'MSG'
iOS: Settings → Accounts models: your name and devices; for admins, add with a setup code, edit, reset and remove accounts

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 15: The Accounts screens

**Files:**
- Create: `UI/Settings/Admin/Accounts/AccountsPanel.swift`, `AccountDetailView.swift`, `SessionsView.swift`, `AccountFormView.swift`, `SetupCodeView.swift` (all in `UI/Settings/Admin/Accounts/`)

The web's row of icon buttons (edit, devices, new code, remove) becomes a detail screen per account, the iOS way. After Add, the setup code replaces the form in the same sheet. It shows the web's sentence with the expiry date, the code in large monospaced type, the link, Copy (`UIPasteboard`, "Link copied") and the share sheet (`ShareLink` with the link and the code). After a reset the code shows in its own sheet. The accessibility identifiers (`accounts.add`, `account.name`, `account.username`, `account.submit`, `setup.code`, `setup.link`) are what Task 17's UI test taps.

**Step 1: Write the views**

`UI/Settings/Admin/Accounts/AccountsPanel.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// Settings → Accounts: you (name, devices, sign out here) and, for admins, everyone.
public struct AccountsPanel: View {
  @State private var model: AccountsModel
  @State private var adding = false

  public init(
    api: any APISending, signOutHere: @escaping @MainActor () async -> Void, accountChanged: @escaping @MainActor (Account) -> Void = { _ in }
  ) {
    _model = State(initialValue: AccountsModel(api: api, signOutHere: signOutHere, accountChanged: accountChanged))
  }

  public var body: some View {
    Form {
      if let me = model.me {
        you(me)
        if model.isAdmin { everyone(me) }
      } else if let error = model.loadError {
        InlineMessage(text: error)
      } else {
        ProgressView()
      }
    }
    .navigationTitle("Accounts")
    .task { await model.load() }
    .refreshable { await model.load() }
    .sheet(isPresented: $adding) {
      AccountFormView(title: "Add account", submitLabel: "Add", form: AccountFormModel(account: nil, sources: model.sources), model: model) { form in
        await model.create(form)
      }
    }
  }

  private func you(_ me: Account) -> some View {
    Section {
      HStack {
        TextField("Your name", text: $model.name)
          .accessibilityIdentifier("account.yourName")
        Button("Save") { Task { await model.rename() } }
          .buttonStyle(.borderless)
          .disabled(!model.canRename)
      }
      if let notice = model.notice { InlineMessage(text: notice, isError: false) }
      if let error = model.error, model.accounts == nil { InlineMessage(text: error) }
      NavigationLink("Signed in on") {
        SessionsView(accountId: me.id, title: "Signed in on", model: model)
      }
      Button("Sign out on this device", systemImage: "rectangle.portrait.and.arrow.right") { Task { await model.signOut() } }
    } header: {
      Text("You")
    } footer: {
      Text(model.signedInText)
    }
  }

  private func everyone(_ me: Account) -> some View {
    Section {
      if let error = model.error { InlineMessage(text: error) }
      ForEach(model.accounts ?? []) { account in
        NavigationLink {
          AccountDetailView(accountId: account.id, model: model)
        } label: {
          VStack(alignment: .leading, spacing: 2) {
            HStack {
              Text(account.name)
              if account.id == me.id { Text("you").font(.footnote).foregroundStyle(.secondary) }
            }
            Text(model.summary(account)).font(.caption).foregroundStyle(.secondary).lineLimit(2)
          }
        }
      }
      Button("Add account", systemImage: "person.badge.plus") { adding = true }
        .accessibilityIdentifier("accounts.add")
    } header: {
      Text("Everyone")
    } footer: {
      Text(AccountsModel.everyoneIntro)
    }
  }
}
```

`UI/Settings/Admin/Accounts/AccountDetailView.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// One account, for an admin: what it may do, Edit, its devices, a new setup code, Remove.
struct AccountDetailView: View {
  let accountId: Int
  @Bindable var model: AccountsModel
  @State private var editing = false
  @State private var askingReset = false
  @State private var askingRemove = false
  @Environment(\.dismiss) private var dismiss

  private var account: Account? { model.accounts?.first { $0.id == accountId } }

  var body: some View {
    Form {
      if let account {
        Section {
          Text(model.summary(account)).font(.footnote).foregroundStyle(.secondary)
          if let error = model.error { InlineMessage(text: error) }
          Button("Edit", systemImage: "pencil") { editing = true }
        }
        Section("Devices") {
          SessionRows(accountId: account.id, model: model)
        }
        Section {
          Button("New setup code", systemImage: "key") { askingReset = true }
          if model.canRemove(account) {
            Button("Remove", systemImage: "trash", role: .destructive) { askingRemove = true }
          }
        }
      }
    }
    .navigationTitle(account?.name ?? "")
    .task { await model.loadSessions(of: accountId) }
    .sheet(isPresented: $editing) {
      if let account {
        AccountFormView(title: "Edit \(account.name)", submitLabel: "Save", form: AccountFormModel(account: account, sources: model.sources), model: model) { form in
          await model.update(form)
        }
      }
    }
    .sheet(item: $model.setupShown) { shown in
      NavigationStack { SetupCodeView(shown: shown) { model.setupShown = nil } }
    }
    .confirmationDialog(account.map(model.resetTitle) ?? "", isPresented: $askingReset, titleVisibility: .visible) {
      Button("New setup code", role: .destructive) { if let account { Task { await model.reset(account) } } }
    } message: {
      Text(AccountsModel.resetMessage)
    }
    .confirmationDialog(account.map(model.removeTitle) ?? "", isPresented: $askingRemove, titleVisibility: .visible) {
      Button("Remove", role: .destructive) {
        guard let account else { return }
        Task {
          await model.remove(account)
          if model.error == nil { dismiss() }
        }
      }
    } message: {
      Text(AccountsModel.removeMessage)
    }
  }
}
```

`UI/Settings/Admin/Accounts/SessionsView.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// The devices an account is signed in on, as their own screen ("Signed in on").
struct SessionsView: View {
  let accountId: Int
  let title: String
  @Bindable var model: AccountsModel

  var body: some View {
    Form {
      if let error = model.error { InlineMessage(text: error) }
      SessionRows(accountId: accountId, model: model)
    }
    .navigationTitle(title)
    .task { await model.loadSessions(of: accountId) }
  }
}

/// Each device with when it was last used; every one but this device signs out with a tap.
struct SessionRows: View {
  let accountId: Int
  @Bindable var model: AccountsModel

  var body: some View {
    if let sessions = model.sessions[accountId] {
      if sessions.isEmpty { Text("No devices are signed in.").foregroundStyle(.secondary) }
      ForEach(sessions) { session in
        HStack {
          VStack(alignment: .leading, spacing: 2) {
            HStack {
              Text(session.device)
              if session.current { Text("this device").font(.footnote).foregroundStyle(.secondary) }
            }
            Text("Last used \(AdminText.date(session.lastSeenAt)?.formatted(.dateTime.day().month(.abbreviated).hour().minute()) ?? session.lastSeenAt)")
              .font(.caption)
              .foregroundStyle(.secondary)
          }
          Spacer()
          if !session.current {
            Button("Sign out", systemImage: "rectangle.portrait.and.arrow.right") { Task { await model.endSession(session, of: accountId) } }
              .labelStyle(.iconOnly)
              .buttonStyle(.borderless)
              .accessibilityLabel("Sign out \(session.device)")
          }
        }
      }
    } else {
      ProgressView()
    }
  }
}
```

`UI/Settings/Admin/Accounts/AccountFormView.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// Add account or Edit <name>: name, username, role, requests and library. A new account's setup code
/// then shows in the same sheet.
struct AccountFormView: View {
  let title: String
  let submitLabel: String
  @State var form: AccountFormModel
  @Bindable var model: AccountsModel
  let submit: (AccountFormModel) async -> Bool
  @State private var code: AccountsModel.SetupShown?
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      if let code {
        SetupCodeView(shown: code) { dismiss() }
      } else {
        fields
      }
    }
  }

  private var fields: some View {
    Form {
      Section {
        TextField("Name", text: $form.name).accessibilityIdentifier("account.name")
        TextField("Username", text: $form.username).adminPlainField().accessibilityIdentifier("account.username")
        if let problem = form.usernameProblem { Text(problem).font(.footnote).foregroundStyle(.red) }
      }
      Section("Role") {
        Picker("Role", selection: $form.role) {
          Text("Member: listens").tag(AccountRole.member)
          Text("Admin: also changes settings, sources and accounts").tag(AccountRole.admin)
        }
        .pickerStyle(.inline)
        .labelsHidden()
      }
      Section {
        Toggle("Can request albums", isOn: $form.canRequest).accessibilityIdentifier("account.canRequest")
      }
      Section("Library") {
        Picker("Library", selection: $form.everySource) {
          Text("Every source").tag(true)
          Text("Only these sources").tag(false)
        }
        .pickerStyle(.inline)
        .labelsHidden()
        if !form.everySource {
          ForEach(form.sources) { source in
            Button { form.toggle(source) } label: {
              Label(source.name, systemImage: form.isPicked(source) ? "checkmark.square.fill" : "square")
            }
            .accessibilityAddTraits(form.isPicked(source) ? .isSelected : [])
          }
        }
      }
      if let error = model.error { Section { InlineMessage(text: error) } }
    }
    .navigationTitle(title)
    .toolbar {
      ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
      ToolbarItem(placement: .confirmationAction) {
        Button(submitLabel) {
          Task {
            guard await submit(form) else { return }
            if let shown = model.setupShown {
              model.setupShown = nil
              code = shown
            } else {
              dismiss()
            }
          }
        }
        .disabled(!form.canSubmit || model.busy)
        .accessibilityIdentifier("account.submit")
      }
    }
  }
}
```

`UI/Settings/Admin/Accounts/SetupCodeView.swift`:

```swift
import SwiftUI
#if os(iOS)
import UIKit
#endif

/// A new or reset account's one-time code, and the link that fills it in: Copy, or the share sheet.
/// Shown inside a navigation stack: the add-account sheet's, or its own after a reset.
struct SetupCodeView: View {
  let shown: AccountsModel.SetupShown
  let done: () -> Void
  @State private var copied = false

  var body: some View {
    Form {
      Section {
        Text(AccountsModel.setupText(shown.setup))
        Text(shown.setup.code)
          .font(.system(.largeTitle, design: .monospaced))
          .tracking(6)
          .textSelection(.enabled)
          .accessibilityIdentifier("setup.code")
      }
      Section {
        Text(shown.setup.link)
          .font(.footnote.monospaced())
          .textSelection(.enabled)
          .accessibilityIdentifier("setup.link")
        Button(copied ? "Link copied" : "Copy", systemImage: "doc.on.doc") { copy() }
        if let url = URL(string: shown.setup.link) {
          ShareLink(item: url, subject: Text("Playarr"), message: Text("Your Playarr setup code: \(shown.setup.code)"))
        }
      }
    }
    .navigationTitle("Setup code for \(shown.account.name)")
    .navigationBarBackButtonHidden()
    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done", action: done) } }
  }

  private func copy() {
    #if os(iOS)
    UIPasteboard.general.string = shown.setup.link
    #endif
    copied = true
  }
}
```

**Step 2: Build for the Mac and the simulator**

Run the two build commands from Conventions. Expected: `Build complete!` twice, no warnings from these files.

**Step 3: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/Admin/Accounts/AccountsPanel.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/Admin/Accounts/AccountDetailView.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/Admin/Accounts/SessionsView.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/Admin/Accounts/AccountFormView.swift apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings/Admin/Accounts/SetupCodeView.swift
git commit -F - <<'MSG'
iOS: Settings → Accounts screens: you, everyone, each account's detail, the account form, the setup code with Copy and Share

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 16: The panels in Settings

**Files:**
- Create: `UI/Settings/Admin/AdminPanel.swift`, `UI/Settings/Admin/AdminPanelView.swift`
- Test: `UITests/Admin/AdminPanelTests.swift`
- Modify: phase 4's Settings list (found in Step 5)

**Step 1: Write the failing test**

`UITests/Admin/AdminPanelTests.swift`:

```swift
import PlayarrAPI
import Testing
@testable import PlayarrUI

@Suite struct AdminPanelTests {
  @Test func showsAdminsEveryPanelInTheWebsOrder() {
    #expect(AdminPanel.visible(to: .admin).map(\.title) == ["Sources", "Accounts", "Mixes", "Analysis", "Requests", "Updates"])
  }

  @Test func showsMembersOnlyTheirOwnBits() {
    #expect(AdminPanel.visible(to: .member) == [.accounts, .mixes])
    #expect(AdminPanel.mixes.scope(for: .member) == "Your listening history and ListenBrainz are yours alone.")
    #expect(AdminPanel.mixes.scope(for: .admin) == "These settings apply to everyone.")
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter AdminPanelTests
```

Expected: the build fails with `cannot find 'AdminPanel' in scope`.

**Step 3: Implement**

`UI/Settings/Admin/AdminPanel.swift`:

```swift
import PlayarrAPI

/// The Settings panels that talk to the server, in the web's order (pages/Settings.tsx), and who sees them.
/// Sources, Analysis, Requests and Updates are for admins. Mixes and Accounts show to everyone: a member sees
/// only their own listening history and ListenBrainz link, and their own name and devices.
public enum AdminPanel: String, CaseIterable, Identifiable, Hashable, Sendable {
  case sources, accounts, mixes, analysis, requests, updates

  public var id: String { rawValue }

  public var title: String {
    switch self {
    case .sources: "Sources"
    case .accounts: "Accounts"
    case .mixes: "Mixes"
    case .analysis: "Analysis"
    case .requests: "Requests"
    case .updates: "Updates"
    }
  }

  public var systemImage: String {
    switch self {
    case .sources: "externaldrive.connected.to.line.below"
    case .accounts: "person.2"
    case .mixes: "square.stack"
    case .analysis: "waveform.badge.magnifyingglass"
    case .requests: "tray.and.arrow.down"
    case .updates: "arrow.down.circle"
    }
  }

  /// The web's line under the panel's name.
  public func scope(for role: AccountRole) -> String? {
    switch self {
    case .accounts: "Who signs in to this server, and what each account may hear and change."
    case .mixes: role == .admin ? "These settings apply to everyone." : "Your listening history and ListenBrainz are yours alone."
    case .analysis, .requests, .updates: "These settings apply to everyone."
    case .sources: nil
    }
  }

  public func isVisible(to role: AccountRole) -> Bool {
    switch self {
    case .mixes, .accounts: true
    case .sources, .analysis, .requests, .updates: role == .admin
    }
  }

  public static func visible(to role: AccountRole) -> [AdminPanel] {
    allCases.filter { $0.isVisible(to: role) }
  }
}
```

`UI/Settings/Admin/AdminPanelView.swift`:

```swift
import PlayarrAPI
import SwiftUI

/// One server Settings panel for the active account: what phase 4's Settings list pushes for an `AdminPanel`.
/// `dataChanged` drops what the app has cached from the server (the library, mixes, health) after a change
/// that alters it: a source synced or removed, files organized, mix settings or requests changed.
public struct AdminPanelView: View {
  let panel: AdminPanel
  let store: ServerStore
  let dataChanged: @MainActor () -> Void

  public init(panel: AdminPanel, store: ServerStore, dataChanged: @escaping @MainActor () -> Void = {}) {
    self.panel = panel
    self.store = store
    self.dataChanged = dataChanged
  }

  public var body: some View {
    if let client = store.activeClient, let record = store.activeAccount {
      let role = record.account.role
      if panel.isVisible(to: role) {
        content(client, record)
          .safeAreaInset(edge: .top) {
            if let scope = panel.scope(for: role) {
              Text(scope).font(.footnote).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal)
            }
          }
      } else {
        ContentUnavailableView("Only an admin can change these settings.", systemImage: "lock")
      }
    } else {
      ContentUnavailableView("Sign in to see your account.", systemImage: "person.crop.circle.badge.questionmark")
    }
  }

  @ViewBuilder private func content(_ client: APIClient, _ record: AccountRecord) -> some View {
    switch panel {
    case .sources: SourcesPanel(api: client, libraryChanged: dataChanged)
    case .accounts:
      AccountsPanel(
        api: client,
        signOutHere: { [store] in await store.signOut(record.key) },
        accountChanged: { [store] account in store.update(account, on: record.serverId) })
    case .mixes: MixesPanel(api: client, isAdmin: record.account.role == .admin, mixesChanged: dataChanged)
    case .analysis: AnalysisPanel(api: client)
    case .requests: RequestsPanel(api: client, requestsChanged: dataChanged)
    case .updates: UpdatesPanel(api: client)
    }
  }
}
```

**Step 4: Run it to see it pass**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter AdminPanelTests
```

Expected: `Test run with 2 tests in 1 suite passed`.

**Step 5: Put the panels in phase 4's Settings list**

Find the list and its placeholders:

```bash
grep -rn "Playback\|Appearance\|placeholder\|Placeholder" apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings --include=*.swift | grep -v "/Admin/"
```

In the view that lists the Settings panels (assumed `SettingsView`, holding the `AppModel` as `model`):

1. Delete the placeholder rows for Sources, Accounts (or Profiles), Mixes, Analysis, Requests and Updates, the placeholder view they push, and its file if nothing else uses it.
2. Where those rows were, list the panels the active account may see. Put them in the web's order around Playback, "Your listening" and Appearance: Sources first; Accounts after Playback; Mixes, Analysis and Requests after "Your listening"; Updates last. If phase 4's list is one `ForEach`, a single section is fine:

   ```swift
   ForEach(AdminPanel.visible(to: model.store.activeAccount?.account.role ?? .member)) { panel in
     NavigationLink(value: panel) {
       Label(panel.title, systemImage: panel.systemImage)
     }
     .accessibilityIdentifier("settings.\(panel.rawValue)")
   }
   ```

3. On the list's `NavigationStack` content, add the destination. `dataChanged` is phase 4's way to drop data cached from the server. With the conventions' `QueryCache` that is its "forget everything" call (for example `model.cache.removeAll()`). Use whatever phase 4 named it, or leave the default `{}` if phase 4 has none:

   ```swift
   .navigationDestination(for: AdminPanel.self) { panel in
     AdminPanelView(panel: panel, store: model.store, dataChanged: { model.cache.removeAll() })
   }
   ```

4. Make sure the button or tab that opens Settings has `.accessibilityIdentifier("settings")` (add it if phase 4 didn't). Task 17's UI test taps it.

Then build the package for both platforms (the two commands in Conventions) and the app:

```bash
make -C apps/ios build
```

Expected: `Build complete!` twice, then `** BUILD SUCCEEDED **`.

**Step 6: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/Settings apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/Admin/AdminPanelTests.swift
git commit -F - <<'MSG'
iOS: the server's Settings panels in Settings: Sources, Analysis, Requests and Updates for admins; Mixes and Accounts for everyone

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 17: UI test: an admin adds an account and sees its setup code

**Files:**
- Create: `UI/AppModel+UITests.swift` (`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/AppModel+UITests.swift`)
- Test: `UITests/Admin/UITestSignInTests.swift`
- Modify: `apps/ios/Playarr/PlayarrApp.swift`
- Create: `apps/ios/PlayarrUITests/DevServer.swift`, `apps/ios/PlayarrUITests/AccountsUITests.swift`

**Step 1: Write the failing unit test for the hand-over**

`UITests/Admin/UITestSignInTests.swift` (it uses phase 2's `FakeServer` from `AddServerModelTests.swift`):

```swift
import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct UITestSignInTests {
  let host = "uitest-\(UUID().uuidString.lowercased()).invalid"

  func app(_ session: URLSession) -> AppModel {
    let directory = FileManager.default.temporaryDirectory.appending(path: "playarr-\(UUID().uuidString)")
    let store = ServerStore(directory: directory, secrets: InMemorySecretStore(), session: session)
    return AppModel(store: store, browser: ServerBrowser(), appVersion: AppVersion("1.0.0"), device: DeviceInfo(name: "Test", platform: "ios"))
  }

  @Test func signsInWithTheTokenAUITestGives() async {
    let session = FakeServer.session(host: host) { request in
      switch request.url?.path() {
      case "/api/server": (200, #"{"id":"srv-1","name":"Dev","version":"0.7.0","minAppVersion":"1.0.0","setup":false}"#)
      case "/api/auth/me":
        request.value(forHTTPHeaderField: "Authorization") == "Bearer tok"
          ? (200, #"{"id":1,"username":"nicola","name":"Nicola","role":"admin","canRequest":true,"sources":null,"hasPassword":true}"#)
          : (401, #"{"error":"Sign in","setup":false}"#)
      default: (404, #"{"error":"Not found"}"#)
      }
    }
    let model = app(session)
    await model.signInForUITests(environment: [AppModel.uiTestServerKey: "http://\(host)", AppModel.uiTestTokenKey: "tok"], session: session)
    #expect(model.store.activeAccount?.account.role == .admin)
    #expect(model.store.activeServer?.name == "Dev")
  }

  @Test func doesNothingWithoutTheKeys() async {
    let model = app(.shared)
    await model.signInForUITests(environment: [:])
    #expect(model.store.activeAccount == nil)
  }
}
```

**Step 2: Run it to see it fail**

```bash
swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter UITestSignInTests
```

Expected: the build fails with `value of type 'AppModel' has no member 'signInForUITests'`.

**Step 3: Implement the hand-over and use it in the app**

`apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/AppModel+UITests.swift`:

```swift
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
```

Replace `apps/ios/Playarr/PlayarrApp.swift` with (phase 2's file, plus the hand-over):

```swift
import Foundation
import PlayarrUI
import SwiftUI

@main
struct PlayarrApp: App {
  /// UI tests launch with `-UITests`: no servers, and nothing kept between runs.
  private static let uiTests = ProcessInfo.processInfo.arguments.contains("-UITests")
  @State private var model = Self.uiTests ? AppModel.empty() : AppModel.live()

  var body: some Scene {
    WindowGroup {
      RootView(model: model)
        .onOpenURL { model.open($0) }
        // A UI test may hand over a session it started on the dev server (AccountsUITests).
        .task { if Self.uiTests { await model.signInForUITests() } }
    }
  }
}
```

Run `swift test --disable-sandbox --package-path apps/ios/Packages/PlayarrUI --filter UITestSignInTests`. Expected: `Test run with 2 tests in 1 suite passed`.

**Step 4: Write the UI test**

`apps/ios/PlayarrUITests/DevServer.swift`:

```swift
import Foundation

/// The dev server, for UI tests that sign in and clean up after themselves through its API.
struct DevServer: Sendable {
  let url: URL

  private struct SignIn: Encodable {
    let username, password: String
    let device = "UI tests"
    let platform = "ios"
  }

  private struct Token: Decodable { let token: String }
  private struct Listed: Decodable { let id: Int; let username: String }

  /// Signs in and answers the session's token.
  func signIn(username: String, password: String) async throws -> String {
    let data = try await send("POST", "/api/auth/sign-in", body: try JSONEncoder().encode(SignIn(username: username, password: password)))
    return try JSONDecoder().decode(Token.self, from: data).token
  }

  /// Removes the account with this username, if there is one.
  func removeAccount(_ username: String, token: String) async throws {
    let accounts = try JSONDecoder().decode([Listed].self, from: try await send("GET", "/api/accounts", token: token))
    guard let account = accounts.first(where: { $0.username == username }) else { return }
    _ = try await send("DELETE", "/api/accounts/\(account.id)", token: token)
  }

  func signOut(token: String) async throws {
    _ = try await send("POST", "/api/auth/sign-out", token: token)
  }

  private func send(_ method: String, _ path: String, token: String? = nil, body: Data? = nil) async throws -> Data {
    var request = URLRequest(url: url.appending(path: path))
    request.httpMethod = method
    request.setValue("1", forHTTPHeaderField: "X-Playarr")
    if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    if let body {
      request.httpBody = body
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    let (data, response) = try await URLSession.shared.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status) else {
      throw URLError(.badServerResponse, userInfo: [NSLocalizedDescriptionKey: "\(method) \(path) answered \(status): \(String(decoding: data, as: UTF8.self))"])
    }
    return data
  }
}
```

`apps/ios/PlayarrUITests/AccountsUITests.swift`:

```swift
import XCTest

/// Settings → Accounts on the simulator, against the dev server: an admin adds an account and sees its setup
/// code. Needs the dev server and an admin's sign-in, given to the test runner (xcodebuild passes each
/// TEST_RUNNER_<NAME> variable on as <NAME>):
///
///     TEST_RUNNER_PLAYARR_UITEST_SERVER=http://localhost:4000
///     TEST_RUNNER_PLAYARR_UITEST_ADMIN=<username> TEST_RUNNER_PLAYARR_UITEST_PASSWORD=<password>
///
/// Skipped without them, so the suite still passes where no dev server runs (CI).
final class AccountsUITests: XCTestCase {
  @MainActor
  func testAddingAnAccountShowsItsSetupCode() async throws {
    let environment = ProcessInfo.processInfo.environment
    guard let server = environment["PLAYARR_UITEST_SERVER"].flatMap(URL.init(string:)),
      let admin = environment["PLAYARR_UITEST_ADMIN"], let password = environment["PLAYARR_UITEST_PASSWORD"]
    else {
      throw XCTSkip("Set TEST_RUNNER_PLAYARR_UITEST_SERVER, TEST_RUNNER_PLAYARR_UITEST_ADMIN and TEST_RUNNER_PLAYARR_UITEST_PASSWORD to run this against the dev server.")
    }
    let dev = DevServer(url: server)
    let token = try await dev.signIn(username: admin, password: password)
    let username = "uitest\(UInt32.random(in: 100_000...999_999))"
    addTeardownBlock {
      try? await dev.removeAccount(username, token: token)
      try? await dev.signOut(token: token)
    }

    let app = XCUIApplication()
    app.launchArguments = ["-UITests"]
    app.launchEnvironment = ["PLAYARR_UITEST_SERVER": server.absoluteString, "PLAYARR_UITEST_TOKEN": token]
    app.launch()

    let settings = app.buttons["settings"].firstMatch
    XCTAssertTrue(settings.waitForExistence(timeout: 15), "No Settings button: is the app signed in?")
    settings.tap()
    let accounts = app.buttons["settings.accounts"].firstMatch
    XCTAssertTrue(accounts.waitForExistence(timeout: 5))
    accounts.tap()

    let add = app.buttons["accounts.add"]
    XCTAssertTrue(add.waitForExistence(timeout: 10), "No Add account: is \(admin) an admin?")
    add.tap()
    let name = app.textFields["account.name"]
    XCTAssertTrue(name.waitForExistence(timeout: 5))
    name.tap()
    name.typeText("UI Test")
    let user = app.textFields["account.username"]
    user.tap()
    user.typeText(username)
    app.buttons["account.submit"].tap()

    let code = app.staticTexts["setup.code"]
    XCTAssertTrue(code.waitForExistence(timeout: 10))
    XCTAssertNotNil(code.label.range(of: "^[A-HJKMNP-Z2-9]{8}$", options: .regularExpression), code.label)
    XCTAssertTrue(app.staticTexts["setup.link"].label.hasSuffix("/redeem?code=\(code.label)"), app.staticTexts["setup.link"].label)
  }
}
```

**Step 5: Run it without a dev server (skipped), then against one**

```bash
make -C apps/ios test-app
```

Expected: `** TEST SUCCEEDED **`, with `testAddingAnAccountShowsItsSetupCode` skipped and phase 2's `LaunchTests` passing.

Now against a throwaway dev server (a fresh `DATA_DIR` is in setup mode; claiming it from localhost makes an admin). Start the server in the background:

```bash
DATA_DIR=$(mktemp -d) corepack pnpm dev:server
```

Wait for it to listen on port 4000, then claim it and run the UI tests:

```bash
curl -s -X POST http://localhost:4000/api/auth/setup -H 'Content-Type: application/json' -H 'X-Playarr: 1' \
  -d '{"username":"owner","name":"Owner","password":"uitest-password","device":"curl","platform":"web"}' | head -c 80; echo
TEST_RUNNER_PLAYARR_UITEST_SERVER=http://localhost:4000 TEST_RUNNER_PLAYARR_UITEST_ADMIN=owner TEST_RUNNER_PLAYARR_UITEST_PASSWORD=uitest-password \
  make -C apps/ios test-app
```

Expected: the curl prints the start of `{"token":"…","account":{…"role":"admin"…`. Then `** TEST SUCCEEDED **` with `testAddingAnAccountShowsItsSetupCode` passed. If the test can't find `settings` or `settings.accounts`, Task 16's Step 5 point 4 or point 2 is missing. Afterwards, `curl -s http://localhost:4000/api/accounts -H "Authorization: Bearer <a token from a new sign-in>"` lists only `owner` (the test removed its account). Stop the dev server.

**Step 6: Commit**

```bash
git add apps/ios/Packages/PlayarrUI/Sources/PlayarrUI/AppModel+UITests.swift apps/ios/Packages/PlayarrUI/Tests/PlayarrUITests/Admin/UITestSignInTests.swift apps/ios/Playarr/PlayarrApp.swift apps/ios/PlayarrUITests/DevServer.swift apps/ios/PlayarrUITests/AccountsUITests.swift
git commit -F - <<'MSG'
iOS: a UI test that adds an account in Settings → Accounts against the dev server and sees its setup code

The test signs in through the server's API and hands the app the token
(-UITests, PLAYARR_UITEST_SERVER and PLAYARR_UITEST_TOKEN); it is skipped
without a dev server.

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

### Task 18: Everything green, and a walk through on the simulator

No code unless something is wrong: fix it in the task that owns it and commit there.

**Step 1: Every test**

```bash
make -C apps/ios test
```

Expected: the scripts' tests, every package suite (PlayarrUI now has 71 tests more than before this phase, PlayarrAPI 2 more) and the app's tests pass. The UI test is skipped.

**Step 2: The walk through**

Start a throwaway dev server with music and claim it, as in Task 17 Step 5, but with a folder to add: `DATA_DIR=$(mktemp -d) FOLDER_ROOTS=$HOME/Music corepack pnpm dev:server`. Install the app on the simulator and sign in as `owner` (phase 2's Task 18 has the commands). Then check:

1. Settings lists Sources, Accounts, Mixes, Analysis, Requests and Updates (and phase 4's Playback and Appearance).
2. **Sources**: "No sources yet…". Add source → Folder → This server: the browser starts at "Folders Playarr may use", opens folders, ".." goes up, and "Use this folder" marks it selected. Save: the source appears with "Syncing…" and then "Synced <date>". The polling shows that without pulling to refresh.
3. Add a second folder; Edit → drag the second above the first, Done; pull to refresh: the order stayed. On the web (`corepack pnpm dev:web`), Settings → Sources shows the same order.
4. Swipe Rescan; context menu → Match again, Organize files (the sheet explains if the folder isn't writable; otherwise moves, All/None, Move N files, then Undo). Remove asks "Remove “<name>”?" with the web's text.
5. Folder form → SSH: no browser until Connect. Wrong host → the server's error in the browser. SMB with the web reporting no rclone → "SMB shares need rclone on the server." and SMB disabled.
6. Identifying songs: type a key, Save → "AcoustID key saved" and Replace.
7. If a folder has doubtful matches, "N albums to review": choose a candidate, see its details and your files beside its songs, Use this album → the next album shows at once with "Saving: …" then "Saved: …".
8. **Mixes**: turn Deep cuts off and back on; Songs per mix 75; "Use this device’s (…)". Reload the web's Settings → Mixes: the same. Clear history asks first.
9. ListenBrainz: a wrong token → the server's message; disconnect works.
10. **Analysis**: the four sections with numbers; "Analyse the N … left" → "Analysing N songs in the background" and "Now: …" updating every 10 s. "Reanalyse the entire collection" asks with the web's cost text; Cancel does nothing.
11. **Requests** without Lidarr: "Requests need a Lidarr source…". With Lidarr: the pickers list Lidarr's root folders (with free space) and profiles.
12. **Updates** on the dev server: "Automatic updates aren’t available here." or the updater's instructions.
13. **Accounts**: Add account "Sam" (username `sam`, member, no requests, only one folder) → the setup code, Copy, Share (the share sheet offers Messages and Mail). Open Sam: Edit role to admin and back. New setup code asks first and shows a new code. Remove asks with the web's text. Your own row has no Remove while you're the only admin.
14. Redeem Sam's code in the web (`/redeem?code=…`), then sign in as Sam in the app (Accounts sheet → Add account). Settings shows only Accounts and Mixes. Mixes has the history and ListenBrainz but no mix switches. Accounts shows Sam's name, devices and "Sign out on this device", and no Everyone section.
15. As the owner, Sam's detail → Devices → sign out the app's session. In the app as Sam, the next request lands on phase 2's "Signed out".

Stop the dev servers.

---

### Task 19: On the phone, through TestFlight

**Step 1: Upload a build**

```bash
corepack pnpm ios:beta
```

Run it in the background. It takes 15 to 45 minutes, mostly Apple processing the build. Expected: the script ends by adding the build to the internal "Household" group, with "What to test" from the commits of this phase.

**Step 2: Checkpoint (user): the on-device checklist**

On the iPhone, signed in to the real server as the owner:

1. Settings shows the six server panels. The real library's sources are listed in their order, with the right counts and "Synced" times.
2. Drag a source to another place and back. The web's Settings → Sources follows each time.
3. Rescan a folder source: "Syncing…", then "Synced", without leaving the screen. Lock and unlock the phone during the sync: the panel picks up where it was.
4. "N albums to review" (if any): decide one album, then leave the sheet. Its count went down by one.
5. Organize files on a writable folder, if there is one: Move one file, then Undo it.
6. Mixes: toggle one kind off. Home (phase 6's mixes) no longer shows it after a refresh. Toggle it back on.
7. Analysis: the numbers match the web's.
8. Accounts: add an account, then share its setup link by Messages to yourself. The link opens the web's redeem page (or the app through `playarr://`, phase 2). Remove the account afterwards.
9. With the iPhone on mobile data (away from home, over HTTPS): Sources and Accounts still load and change things (admins from anywhere, phase 1).
10. Larger text (Settings → Accessibility → Display & Text Size, two steps up): no panel cuts off a button. Phase 10 does the full accessibility pass.

Tell the coordinator what failed, if anything.

---

### Task 20 (coordinator decides): record this phase's names in the conventions

This plan was asked not to edit the conventions file. Whoever coordinates the phase plans decides whether to make these edits (they are listed again in the uncertainties):

- Under "Swift conventions → Key types → PlayarrAPI": `APISending` (`send(_:)`, which `APIClient` conforms to), and `AccountPatch.username`.
- Under "PlayarrUI": view models take `any APISending` and, when they poll, `any Clock<Duration>` (`Polling.run`). Package tests share `FakeAPI` and `TestClock` in `PlayarrUITests/Admin/`. `AdminPanel`/`AdminPanelView` are the server panels of Settings. `AppModel.signInForUITests()`.
- Under "Commands" or testing: UI tests against the dev server read `TEST_RUNNER_PLAYARR_UITEST_SERVER`, `…_ADMIN` and `…_PASSWORD`, and are skipped without them. The app takes `PLAYARR_UITEST_SERVER` and `PLAYARR_UITEST_TOKEN` with `-UITests`. Accessibility identifiers: `settings`, `settings.<panel>`.

```bash
git add docs/plans/2026-11-03-ios-conventions.md
git commit -F - <<'MSG'
iOS conventions: the names phase 9 added (APISending, FakeAPI and TestClock, the server's Settings panels, UI tests against the dev server)

Co-Authored-By: Claude <noreply@anthropic.com>
MSG
```

---

## What later phases can rely on

```swift
// PlayarrAPI
public protocol APISending: Sendable { func send<T: Decodable & Sendable>(_ endpoint: Endpoint<T>) async throws -> T }
extension APIClient: APISending {}
public struct AccountPatch { public var username: String?; name; role; canRequest; sources: [Int]?? }   // username added

// PlayarrUI
public enum AdminPanel: String, CaseIterable, Identifiable, Hashable, Sendable {
  case sources, accounts, mixes, analysis, requests, updates
  var title: String; var systemImage: String; func scope(for: AccountRole) -> String?
  func isVisible(to: AccountRole) -> Bool; static func visible(to: AccountRole) -> [AdminPanel]
}
public struct AdminPanelView: View { public init(panel: AdminPanel, store: ServerStore, dataChanged: @escaping @MainActor () -> Void = {}) }
public struct SourcesPanel: View { public init(api: any APISending, libraryChanged: @escaping @MainActor () -> Void = {}) }
public struct MixesPanel: View { public init(api: any APISending, isAdmin: Bool, mixesChanged: @escaping @MainActor () -> Void = {}) }
public struct AnalysisPanel: View { public init(api: any APISending) }
public struct RequestsPanel: View { public init(api: any APISending, requestsChanged: @escaping @MainActor () -> Void = {}) }
public struct UpdatesPanel: View { public init(api: any APISending) }
public struct AccountsPanel: View { public init(api: any APISending, signOutHere: @escaping @MainActor () async -> Void, accountChanged: @escaping @MainActor (Account) -> Void = { _ in }) }
// View models (all @MainActor @Observable, init(api: any APISending, …), polling ones also clock: any Clock<Duration> = ContinuousClock()):
// SourcesModel, LidarrFormModel, FolderFormModel, FolderBrowserModel, ReviewModel, OrganizeModel, MatchingModel,
// MusicBrainzQueueModel, MixSettingsModel, ListenBrainzModel, AnalysisModel, RequestSettingsModel, UpdatesModel,
// AccountsModel, AccountFormModel.
extension AppModel {
  public static let uiTestServerKey: String   // "PLAYARR_UITEST_SERVER"
  public static let uiTestTokenKey: String    // "PLAYARR_UITEST_TOKEN"
  public func signInForUITests(environment: [String: String] = ProcessInfo.processInfo.environment, session: URLSession = .shared) async
}
// PlayarrUITests (package tests): FakeAPI (on/then/fail/calls/bodies), TestClock (nextSleep/pendingSleep/advance), Samples.
```

## Uncertainties

- **Phase 4's names.** Its plan was written at the same time as this one. Task 16 Step 5 assumes a Settings list holding the `AppModel`, a Settings entry point that can carry the identifier `settings`, and a cache with a "forget everything" call. Adjust the five lines there to phase 4's real names. Nothing else in this plan touches phase 4's code.
- **"Sign out everywhere"** is left out: the contract has `DELETE /api/accounts/:id/sessions/:sessionId` and `POST /api/auth/sign-out`, but no call that ends every session at once. Ending them one by one from the app would work, but it is not atomic and isn't what the API offers. A server addition (`DELETE /api/accounts/:id/sessions`, or `POST /api/auth/sign-out { everywhere: true }`) would make it one button in `AccountsPanel`'s "You" section.
- **Generated nested names** (`MixSettingsPatch.Enabled`, `UpdateInfo.Status`, `RequestSettingsInfo.Options.RootFoldersItem`…) were checked against the generator's output in the working tree on 2026-11-03. A later change to the shared types may rename one, and the compiler would say so.
- **Swipe and drag on `List`**: `onMove` is enabled with the Edit button. Whether long-press dragging works without edit mode on iOS 26 wasn't checked on a device. The Edit button is there either way.
- **Indentation.** Phase 0's and phase 3's Swift use two spaces and phase 2's four. New files here use two, and edits to phase 2's files keep four. The conventions could pin one.

## Verification done while writing this plan

- Every Swift file in Tasks 1 to 17 was compiled and its tests run in a scratch copy of the packages at `/tmp/p9/real`. The scratch used the working tree's phase 2 `PlayarrAPI` (its generated models and endpoints, as of 2026-11-03 about 14:30 UTC, with Task 1's two changes applied) and phase 2's `AppModel.swift` and `FakeServer`. Results: `swift test --disable-sandbox` gave 61 PlayarrAPI tests passing (with `AdminEndpointTests`) and 71 new PlayarrUI tests passing in 13 suites. `swift build` for macOS and for `arm64-apple-ios26.0-simulator` gave no errors or warnings under Swift 6.4.2, Swift 6 language mode.
- `AccountsUITests.swift` and `DevServer.swift` were type-checked with `swiftc -typecheck -swift-version 6` against the iPhone simulator SDK's XCTest. They weren't run: no app target with phase 4's Settings exists yet.
- Not verified: `PlayarrApp.swift` (it needs the app target), Task 16's edit to phase 4's list, and anything on a simulator or phone (Tasks 17 Step 5, 18 and 19).
