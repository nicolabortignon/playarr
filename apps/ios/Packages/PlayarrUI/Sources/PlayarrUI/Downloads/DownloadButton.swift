import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// What a page downloads: an album, playlist, mix or Favorites, with the keys the web uses (`PinnedDownload.Key`).
public struct DownloadItem: Sendable, Equatable {
  public var key: String
  public var title: String
  public var subtitle: String?
  public var coverUrl: String?
  public var href: String

  public init(key: String, title: String, subtitle: String? = nil, coverUrl: String? = nil, href: String) {
    self.key = key
    self.title = title
    self.subtitle = subtitle
    self.coverUrl = coverUrl
    self.href = href
  }
}

/// Download an album, playlist, mix or Favorites to this device, to play without a connection; shows how far along it
/// is, and removes it when tapped again (apps/web/src/components/DownloadButton.tsx). Before starting, it checks the
/// songs fit on the device.
public struct DownloadButton: View {
  let store: DownloadStore
  let item: DownloadItem
  let tracks: [Track]
  @State private var shortOfRoom: (needed: Int64, free: Int64)?

  public init(store: DownloadStore, item: DownloadItem, tracks: [Track]) {
    self.store = store
    self.item = item
    self.tracks = tracks
  }

  private var songs: [Track] { tracks.filter { $0.fileId > 0 } }
  private var phase: OfflineWording.ButtonPhase { OfflineWording.phase(store.progress(of: item.key)) }
  /// The page's songs: a playlist edited (or an album changed) since it was downloaded downloads what it has now.
  private var signature: [Int] { songs.map(\.fileId) }

  public var body: some View {
    Button(action: toggle) {
      Group {
        switch phase {
        case .notDownloaded: Image(systemName: "arrow.down.to.line")
        case .downloaded: Image(systemName: "checkmark.circle")
        case .downloading: ProgressRing(fraction: phase.fraction).frame(width: 20, height: 20)
        }
      }
      .font(.title3)
      .frame(width: 48, height: 48)
      .overlay(Circle().stroke(.secondary.opacity(0.3)))
      .foregroundStyle(phase == .notDownloaded ? AnyShapeStyle(.primary) : AnyShapeStyle(.tint))
    }
    .buttonStyle(.plain)
    .disabled(songs.isEmpty)
    .accessibilityLabel(OfflineWording.buttonLabel(phase, title: item.title))
    .accessibilityAddTraits(phase == .notDownloaded ? [] : .isSelected)
    .task(id: signature) {
      if let pinned = store.download(item.key), pinned.tracks.map(\.fileId) != signature { add() }
    }
    .alert(
      OfflineRules.noRoom, isPresented: Binding(get: { shortOfRoom != nil }, set: { if !$0 { shortOfRoom = nil } }),
      presenting: shortOfRoom
    ) { _ in
      Button("OK", role: .cancel) {}
    } message: { room in
      Text(OfflineWording.noRoomMessage(item.title, needed: room.needed, free: room.free))
    }
  }

  private func toggle() {
    if store.download(item.key) != nil {
      store.remove(item.key)
      store.announce(OfflineWording.removed(item.title), false)
      return
    }
    if case .short(let needed, let free) = store.room(for: songs) {
      shortOfRoom = (needed, free)
      return
    }
    add()
    store.announce(OfflineWording.started(item.title), false)
  }

  private func add() {
    store.add(key: item.key, title: item.title, subtitle: item.subtitle, coverUrl: item.coverUrl, href: item.href, tracks: songs)
  }
}
