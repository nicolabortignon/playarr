/// Lets a test release a waiting task one step at a time (a request answered, a stalled download resumed).
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
