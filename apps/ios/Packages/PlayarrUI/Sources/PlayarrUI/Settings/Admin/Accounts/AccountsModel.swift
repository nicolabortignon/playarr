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
