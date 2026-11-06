import PlayarrAPI
import PlayarrPlayer
import SwiftUI

/// Library → Downloads: albums, playlists, mixes and Favorites on this device, playable without a connection
/// (apps/web/src/pages/Downloads.tsx). Each with its progress, size, Play, Remove (with Undo) and the songs that
/// couldn't download.
public struct DownloadsView<Cover: View>: View {
  let store: DownloadStore
  let play: (PinnedDownload) -> Void
  let open: (String) -> Void
  let cover: (String?) -> Cover
  /// Undo for a removal; the UI test page has none.
  @Environment(AccountSession.self) private var session: AccountSession?

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
        ScrollView {
          EmptyState(
            systemImage: "arrow.down.circle", line: PageLines.downloads,
            fill: .action(EmptyState.Action("Browse albums", systemImage: "square.stack") { open("/albums") }))
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

  /// A download in the list's one row (docs/design.md, "Rows"): the cover, name and what's on the device open its page,
  /// Play plays it, × takes it off the device. How far along it is runs along the row's foot, so a download in progress
  /// is no taller than one that's done.
  private func row(_ d: PinnedDownload) -> some View {
    let progress = store.progress(of: d.key) ?? DownloadProgress(done: 0, total: d.tracks.count, bytes: 0)
    let failed = store.failedCount(of: d.key)
    return HStack(spacing: 12) {
      // One target to open it (the row also swipes to remove).
      Button { open(d.href) } label: {
        HStack(spacing: 12) {
          cover(d.coverUrl)
            .frame(width: 44, height: 44)
            .clipShape(RoundedRectangle(cornerRadius: Radius.cover))
          VStack(alignment: .leading, spacing: 2) {
            Text(d.title).typeRole(.body).foregroundStyle(.paper).essentialLineLimit()
            // How far along it is goes under what it is when both don't fit, rather than being cut off.
            NameAndNumbers(
              name: d.subtitle.map { Text($0) },
              numbers: Text("\(OfflineWording.progress(progress))\(Text(OfflineWording.failures(failed)).foregroundStyle(.danger.opacity(0.8)))"),
              label: OfflineWording.rowDetail(d, progress) + OfflineWording.failures(failed)
            )
            .typeRole(.small)
            .foregroundStyle(.paperDim)
          }
          Spacer(minLength: 0)
        }
        // Room above and below the words once the numbers wrap, so the progress bar runs under them; as tall as a
        // song's row otherwise.
        .padding(.vertical, 8)
        .frame(minHeight: SongRow.height)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      Button { play(d) } label: {
        Image(systemName: "play.fill")
          .frame(width: 40, height: 40)
          .background(.tint, in: Circle())
          .foregroundStyle(.black)
          .frame(width: 44, height: 44)
          .contentShape(Circle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Play \(d.title)")
      Button { remove(d) } label: {
        Image(systemName: "xmark").frame(width: 44, height: 44).contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .foregroundStyle(.paperDim)
      .accessibilityLabel("Remove \(d.title) from this device")
    }
    .overlay(alignment: .bottom) {
      if !progress.isComplete {
        // The words above already say how far along it is.
        ProgressView(value: Double(progress.done), total: Double(max(1, progress.total)))
          .progressViewStyle(.linear)
          .padding(.bottom, 2)
          .accessibilityHidden(true)
      }
    }
    .listRowInsets(.vertical, 0)
    .swipeActions {
      Button("Remove", role: .destructive) { remove(d) }
    }
  }

  /// Off this device at once, with Undo.
  private func remove(_ d: PinnedDownload) {
    DownloadRemoval.remove(d, from: store, toasts: session?.toasts)
  }
}
