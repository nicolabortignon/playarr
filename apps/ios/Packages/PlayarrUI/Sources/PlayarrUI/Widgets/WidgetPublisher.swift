import Foundation
import PlayarrAPI
import PlayarrWidgetData
import WidgetKit

/// Hands the widgets what they show (plan 11): writes the snapshot to the App Group's folder when it changes, then has
/// WidgetKit reload them. The live app has one; the demo and the UI tests have none, so they never write a snapshot.
@MainActor
public final class WidgetPublisher {
  private let store: WidgetStore
  private let reload: @MainActor () -> Void
  /// What was written last (read back from the folder the first time).
  private var written: WidgetSnapshot?

  public init(store: WidgetStore, reload: @escaping @MainActor () -> Void = { WidgetCenter.shared.reloadAllTimelines() }) {
    self.store = store
    self.reload = reload
  }

  /// The App Group's; nil in a build signed without it.
  public static func live() -> WidgetPublisher? {
    guard let store = WidgetStore.live() else {
      Log.widgets.error("No App Group folder: the widgets get nothing")
      return nil
    }
    return WidgetPublisher(store: store)
  }

  /// The account the app listens as now, on its server; nil once nobody is. Another account starts a snapshot of its
  /// own, so nothing of the last one's shows.
  func listening(as record: AccountRecord?, on server: String?) {
    let current = written ?? store.read()
    guard let record else { return publish(.signedOut, over: current) }
    let account = WidgetSnapshot.Account(key: record.key.keychainAccount, server: server ?? "", name: record.account.name)
    var snapshot = current.flatMap { $0.account?.key == account.key ? $0 : nil } ?? WidgetSnapshot(account: account)
    snapshot.account = account
    publish(snapshot, over: current)
  }

  private func publish(_ snapshot: WidgetSnapshot, over current: WidgetSnapshot?) {
    guard snapshot != current else { return }
    do {
      try store.write(snapshot)
      written = snapshot
      reload()
    } catch {
      Log.widgets.error("Couldn't write the widgets' snapshot: \(error.localizedDescription, privacy: .public)")
    }
  }
}
