import Testing
@testable import PlayarrUI

@Suite struct LocalRequestNotifierTests {
  @Test func notifiesOnlyWhenTheAppIsntOnScreen() {
    let landed = [albumRequest("rg-1", "Mezzanine", .available)]
    #expect(LocalRequestNotifier.text(for: landed, active: false) == "“Mezzanine” is ready to play")
    #expect(LocalRequestNotifier.text(for: landed, active: true) == nil)
    #expect(LocalRequestNotifier.text(for: [], active: false) == nil)
  }

  @Test func tellsAnAdminWhoAskedOnlyWhenTheAppIsntOnScreen() {
    let waiting = [waitingRequest("rg-1", "Heligoland", mine: false, askedBy: ["Sam"])]
    #expect(LocalRequestNotifier.waitingText(for: waiting, active: false) == "Sam asked for “Heligoland”")
    #expect(LocalRequestNotifier.waitingText(for: waiting, active: true) == nil)
    #expect(LocalRequestNotifier.waitingText(for: [], active: false) == nil)
  }
}
