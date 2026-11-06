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
/// songs fit on the device. An action row's outlined icon button: its ring fills as the songs arrive, and it ends in a
/// tick.
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
      Image(systemName: icon)
        .foregroundStyle(foreground)
        .contentTransition(.symbolEffect(.replace))
    }
    .buttonStyle(.outlinedIcon(progress: progress))
    .animation(Motion.standard, value: stage)
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

  private var stage: Int {
    switch phase {
    case .notDownloaded: 0
    case .downloading: 1
    case .downloaded: 2
    }
  }

  private var icon: String {
    switch phase {
    case .notDownloaded: "arrow.down.to.line"
    case .downloading: "arrow.down"
    case .downloaded: "checkmark"
    }
  }

  private var foreground: AnyShapeStyle {
    switch phase {
    case .notDownloaded: AnyShapeStyle(.paper)
    case .downloading: AnyShapeStyle(.tint)
    case .downloaded: AnyShapeStyle(.success)
    }
  }

  /// The ring, while the songs arrive.
  private var progress: Double? {
    if case .downloading = phase { return phase.fraction }
    return nil
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
