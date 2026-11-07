#if DEBUG
  import PlayarrAPI

  /// The demo library, its Feeling lucky taking its time (`-UITestsSlowLucky`, Debug builds): the screen tour catches the
  /// fan dealing the covers at hand while the songs are picked, which a demo that answers at once never shows. In the
  /// iPad's idle player bar that's the only time it shows: the bar turns to the song playing as the music starts.
  public struct SlowLuckyAPI: APISending {
    private let demo = DemoAPI()
    private let delay: Duration

    public init(delay: Duration = .seconds(8)) {
      self.delay = delay
    }

    public func send<T: Decodable & Sendable>(_ endpoint: Endpoint<T>) async throws -> T {
      if endpoint.method == .post, endpoint.path == "/api/lucky" { try await Task.sleep(for: delay) }
      return try await demo.send(endpoint)
    }
  }
#endif
