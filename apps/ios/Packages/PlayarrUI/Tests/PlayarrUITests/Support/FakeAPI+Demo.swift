import PlayarrAPI
@testable import PlayarrUI

extension FakeAPI {
  /// A fake server that answers with the demo library (`Demo.routes`); tests change the answers they need.
  static func demoLibrary() -> FakeAPI {
    let api = FakeAPI()
    for route in Demo.routes { api.on(route.method, route.path, route.answer) }
    return api
  }
}
