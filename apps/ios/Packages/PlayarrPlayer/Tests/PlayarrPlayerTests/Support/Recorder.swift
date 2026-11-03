import Synchronization

/// Values another task hands over, kept in order (events, requests).
final class Recorder<Value: Sendable>: Sendable {
  private let values = Mutex<[Value]>([])
  var all: [Value] { values.withLock { $0 } }
  func append(_ value: Value) { values.withLock { $0.append(value) } }
  func removeAll() { values.withLock { $0 = [] } }
}

/// A value tests change while another task reads it (the room left on the device).
final class Shared<Value: Sendable>: Sendable {
  private let storage: Mutex<Value>
  init(_ value: Value) { storage = Mutex(value) }
  var value: Value {
    get { storage.withLock { $0 } }
    set { storage.withLock { $0 = newValue } }
  }
}
