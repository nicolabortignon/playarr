import Testing
@testable import PlayarrUI

@Suite struct LocalRequestNotifierTests {
  @Test func notifiesOnlyWhenTheAppIsntOnScreen() {
    let landed = [albumRequest("rg-1", "Mezzanine", .available)]
    #expect(LocalRequestNotifier.text(for: landed, active: false) == "“Mezzanine” is ready to play")
    #expect(LocalRequestNotifier.text(for: landed, active: true) == nil)
    #expect(LocalRequestNotifier.text(for: [], active: false) == nil)
  }
}
