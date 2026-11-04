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
/// songs fit on the device. Drawn like the Request button (`Pill`): "Download" filled with the accent; once pressed it
/// draws in to a circle of the same height, its icon inside and its outline filling as the songs arrive; a green tick
/// once they're all here.
public struct DownloadButton: View {
  let store: DownloadStore
  let item: DownloadItem
  let tracks: [Track]
  /// The Request button's small size, for a row of small pills.
  var small: Bool
  @State private var shortOfRoom: (needed: Int64, free: Int64)?

  public init(store: DownloadStore, item: DownloadItem, tracks: [Track], small: Bool = false) {
    self.store = store
    self.item = item
    self.tracks = tracks
    self.small = small
  }

  private var songs: [Track] { tracks.filter { $0.fileId > 0 } }
  private var phase: OfflineWording.ButtonPhase { OfflineWording.phase(store.progress(of: item.key)) }
  /// The page's songs: a playlist edited (or an album changed) since it was downloaded downloads what it has now.
  private var signature: [Int] { songs.map(\.fileId) }

  /// The letter spacing grows with the text, as `em` does on the web.
  @ScaledMetric(relativeTo: .caption2) private var textScale: CGFloat = 1
  @Environment(\.dynamicTypeSize) private var typeSize

  public var body: some View {
    Button(action: toggle) {
      HStack(spacing: 6) {
        Image(systemName: icon)
        if phase == .notDownloaded { Text("Download") }
      }
      // Regular at the accessibility sizes, where a weight on the font reads to the audit as text that doesn't fully grow.
      .font(.mono(size: small ? 10 : 11, relativeTo: .caption2, weight: typeSize.isAccessibilitySize ? .regular : .medium))
      .textCase(.uppercase)
      .tracking(0.8 * textScale)
      .lineLimit(1)
      .padding(.horizontal, phase == .notDownloaded ? (small ? 10 : 14) : 0)
      .frame(minWidth: height, minHeight: height)
      .foregroundStyle(foreground)
      .background { outline }
      .contentShape(Capsule())
      .animation(.snappy, value: stage)
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

  private var height: CGFloat { small ? 28 : 32 }

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
    case .notDownloaded: AnyShapeStyle(.background)
    case .downloading: AnyShapeStyle(.tint)
    case .downloaded: AnyShapeStyle(.green)
    }
  }

  /// The pill filled with the accent, then a circle whose outline is the progress, then a green one.
  @ViewBuilder private var outline: some View {
    switch phase {
    case .notDownloaded: Capsule().fill(.tint)
    case .downloading: ProgressRing(fraction: phase.fraction, lineWidth: 2).padding(1)
    case .downloaded: Capsule().strokeBorder(.green.opacity(0.35), lineWidth: 1)
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
