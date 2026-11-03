/// Lets a test hold a fake server's answer until it says so (`FakeAPI.hold`).
actor Gate {
  private var waiting: [CheckedContinuation<Void, Never>] = []
  private var opened = 0

  func wait() async {
    if opened > 0 {
      opened -= 1
      return
    }
    await withCheckedContinuation { waiting.append($0) }
  }

  func open() {
    if waiting.isEmpty { opened += 1 } else { waiting.removeFirst().resume() }
  }
}
