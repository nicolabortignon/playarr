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

  /// An account as the admin list answers it, with its counts.
  static func listed(_ account: Account, plays: Int = 0, playlists: Int = 0) -> ListedAccount {
    ListedAccount(
      id: account.id, username: account.username, name: account.name, role: account.role, canRequest: account.canRequest,
      sources: account.sources, hasPassword: account.hasPassword, plays: plays, playlists: playlists)
  }

  func signedIn(as me: Account) {
    api.on(.get, "/api/auth/me", me)
    api.on(.get, "/api/accounts/\(me.id)/sessions", [Self.phone, Self.ipad])
    api.on(.get, "/api/accounts", [Self.listed(Self.nicola, plays: 1234, playlists: 3), Self.listed(Self.sam, plays: 1)])
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
    #expect(api.bodies(.post, "/api/accounts") == [#"{"canRequest":false,"locked":[],"name":"App Review","role":"member","sources":[2],"username":"reviewer"}"#])
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

  @Test func locksWhatAMemberMayChangeOnTheirDevices() {
    let form = AccountFormModel(account: Self.sam, sources: [])
    #expect(form.mayChange(.playback) && form.mayChange(.appearance))
    form.setMayChange(.appearance, false)
    form.setMayChange(.playback, false)
    // Sent in the form's order, and only once changed.
    #expect(form.patch == AccountPatch(locked: [.playback, .appearance]))
    form.setMayChange(.playback, true)
    #expect(form.patch == AccountPatch(locked: [.appearance]))
    var locked = Self.sam
    locked.locked = [.appearance]
    #expect(AccountFormModel(account: locked, sources: []).patch == nil)
    let model = AccountsModel(api: api)
    #expect(model.summary(locked) == "sam · member · every source · Appearance locked")
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
    #expect(model.activityText(Self.nicola) == "1,234 songs played · 3 playlists")
    #expect(model.activityText(Self.sam) == "1 song played · 0 playlists")
    api.on(.delete, "/api/accounts/2", [Self.listed(Self.nicola)])
    await model.remove(Self.sam)
    #expect(model.accounts == [Self.nicola])
    #expect(model.removeTitle(Self.sam) == "Remove Sam?")
  }

  @Test func signsOutHereAfterRemovingYourself() async {
    var nicola2 = Self.nicola
    nicola2.id = 5
    signedIn(as: nicola2)
    api.on(.get, "/api/accounts", [Self.listed(Self.nicola), Self.listed(nicola2)])
    var signedOut = false
    let model = AccountsModel(api: api, signOutHere: { signedOut = true })
    await model.load()
    api.on(.delete, "/api/accounts/5", [Self.listed(Self.nicola)])
    await model.remove(nicola2)
    #expect(signedOut)
  }
}
