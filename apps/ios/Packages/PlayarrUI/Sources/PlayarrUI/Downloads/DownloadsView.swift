import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// Library → Downloads: albums, playlists, mixes and Favorites on this device, playable without a connection
/// (apps/web/src/pages/Downloads.tsx). Each with its progress, size, Play, Remove and the songs that couldn't download.
public struct DownloadsView<Cover: View>: View {
  let store: DownloadStore
  let play: (PinnedDownload) -> Void
  let open: (String) -> Void
  let cover: (String?) -> Cover

  /// `play` plays a download's songs (from its page's source); `open` goes to its page by href; `cover` draws a cover
  /// from its server path (phase 4's artwork view).
  public init(
    store: DownloadStore, play: @escaping (PinnedDownload) -> Void, open: @escaping (String) -> Void,
    @ViewBuilder cover: @escaping (String?) -> Cover
  ) {
    self.store = store
    self.play = play
    self.open = open
    self.cover = cover
  }

  public var body: some View {
    let downloads = store.downloads
    Group {
      if downloads.isEmpty {
        ContentUnavailableView {
          Label("Nothing downloaded yet", systemImage: "arrow.down.circle")
        } description: {
          Text(OfflineWording.emptyDownloads)
        }
      } else {
        List(downloads) { d in
          row(d)
        }
        .listStyle(.plain)
      }
    }
    .pageHeader("Downloads", count: downloads.isEmpty ? nil : Format.plural(downloads.count, "download"))
  }

  private func row(_ d: PinnedDownload) -> some View {
    let progress = store.progress(of: d.key) ?? DownloadProgress(done: 0, total: d.tracks.count, bytes: 0)
    let failed = store.failedCount(of: d.key)
    return HStack(spacing: 14) {
      Button { open(d.href) } label: {
        cover(d.coverUrl)
          .frame(width: 56, height: 56)
          .clipShape(RoundedRectangle(cornerRadius: 4))
      }
      .buttonStyle(.plain)
      .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 4) {
        // The name and what's on the device, one target to open it (the row also swipes to remove).
        Button { open(d.href) } label: {
          VStack(alignment: .leading, spacing: 4) {
            Text(d.title).essentialLineLimit()
            // How far along it is goes under what it is when both don't fit, rather than being cut off.
            NameAndNumbers(
              name: d.subtitle.map { Text($0) },
              numbers: Text("\(OfflineWording.progress(progress))\(Text(OfflineWording.failures(failed)).foregroundStyle(.danger.opacity(0.8)))"),
              label: OfflineWording.rowDetail(d, progress) + OfflineWording.failures(failed)
            )
            .font(.sans(.footnote))
            .foregroundStyle(.paperDim)
          }
          .frame(minHeight: 44, alignment: .leading)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        if !progress.isComplete {
          // The words above already say how far along it is.
          ProgressView(value: Double(progress.done), total: Double(max(1, progress.total)))
            .frame(maxWidth: 192)
            .accessibilityHidden(true)
        }
      }
      Spacer(minLength: 0)
      Button { play(d) } label: {
        Image(systemName: "play.fill").frame(width: 44, height: 44).background(.tint, in: Circle()).foregroundStyle(.white)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Play \(d.title)")
      Button { store.remove(d.key) } label: {
        Image(systemName: "trash").frame(width: 44, height: 44).contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .foregroundStyle(.secondary)
      .accessibilityLabel("Remove \(d.title) from this device")
    }
    .swipeActions {
      Button("Remove", role: .destructive) { store.remove(d.key) }
    }
  }
}
