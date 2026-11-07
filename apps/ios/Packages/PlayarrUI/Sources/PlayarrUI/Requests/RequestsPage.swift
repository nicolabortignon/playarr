import PlayarrAPI
import SwiftUI

/// Albums asked of Lidarr, with live progress (pages/Requests.tsx): a member's own, an admin's from everyone, those
/// waiting for their answer first, with Approve and Decline. What arrived or was declined since the last look is marked
/// as new, and seen once the page shows it. Swipe a row to take it off the list, with Undo (Lidarr keeps the album wanted).
public struct RequestsPage: View {
  @Environment(DiscoverContext.self) private var context: DiscoverContext?

  public init() {}

  public var body: some View {
    if let context {
      RequestsList(context: context, requests: context.requests)
    }
  }

  /// The line above the list (pages/Requests.tsx's description): whose requests they are, and how they go.
  static func description(admin: Bool, asksFirst: Bool) -> String {
    if admin {
      return "Albums anyone here asked Lidarr to find, those waiting for your approval first. Progress updates live; finished albums land in the library automatically."
    }
    if asksFirst {
      return "Albums you asked Lidarr to find. An admin approves each one first; progress updates live, and finished albums land in your library automatically."
    }
    return "Albums you asked Lidarr to find. Progress updates live; finished albums land in your library automatically."
  }
}

private struct RequestsList: View {
  let context: DiscoverContext
  let requests: RequestsModel
  @Environment(AccountSession.self) private var session

  private var admin: Bool { context.account.role == .admin }

  var body: some View {
    List {
      // Only where there's a Lidarr to ask: without one, the empty page says why there are no requests.
      if context.gate.hasLidarr {
        Section {
          Text(RequestsPage.description(admin: admin, asksFirst: context.gate.asksFirst))
            .font(.sans(.footnote)).foregroundStyle(.secondary)
        }
      }
      if let error = requests.error, requests.requests == nil {
        ErrorState(message: error) { await requests.refresh() }
          .listRowSeparator(.hidden)
      } else if let list = requests.shown {
        if list.isEmpty {
          if context.health == nil, !context.healthFailed {
            // What to say depends on what the server allows: wait to know.
            ListRowsSkeleton(count: 3, cover: 64)
          } else {
            empty(NoRequests.of(context.gate, admin: session.account.role == .admin))
              .listRowSeparator(.hidden)
          }
        }
        ForEach(list, id: \.mbid) { request in
          row(request)
            .swipeActions {
              if removable(request) {
                Button("Remove", role: .destructive) { remove(request) }
              }
            }
            .contextMenu {
              if removable(request) {
                Button("Remove from this list", systemImage: "xmark") { remove(request) }
              }
            }
        }
      } else {
        ListRowsSkeleton(count: 3, cover: 64)
      }
    }
    .pageHeader("Requests", count: requests.shown.map { Format.plural($0.count, "request") })
    .refreshable { await requests.refresh() }
    // On screen, its news has been seen (and leaves the badge); it stays marked as new until the page goes.
    .task { await requests.opened() }
    .onDisappear { requests.closed() }
  }

  /// Taking it off the list needs the right to request (the server refuses it otherwise); an admin answers a request
  /// waiting for approval rather than making it vanish from whoever asked.
  private func removable(_ request: AlbumRequest) -> Bool {
    context.gate.canRequest && !answers(request)
  }

  /// An admin's to answer.
  private func answers(_ request: AlbumRequest) -> Bool { admin && request.approval == .waiting }

  /// Off the list at once, with Undo; the server forgets it once the Undo has gone.
  private func remove(_ request: AlbumRequest) {
    requests.hide(request)
    session.toasts.removed("Removed “\(request.title)” from Requests") {
      requests.unhide(request)
    } done: {
      Task { await requests.remove(request) }
    }
  }

  /// Nothing requested: how to ask, or why asking isn't possible here and who can change that.
  private func empty(_ state: NoRequests) -> some View {
    EmptyState(
      systemImage: "binoculars", line: state.line,
      fill: state.action.map { action in
        .action(
          EmptyState.Action(action.title, systemImage: action.systemImage) {
            switch action.destination {
            case .search: session.router.search("")
            case .settings(let panel): session.router.open(.settingsPanel(panel))
            }
          })
      })
  }

  @ViewBuilder private func row(_ request: AlbumRequest) -> some View {
    if answers(request) {
      // Approve and Decline go under the album where the two don't fit beside it.
      ViewThatFits(in: .horizontal) {
        HStack(spacing: 12) {
          summary(request)
          answerButtons(request)
        }
        VStack(alignment: .leading, spacing: 8) {
          summary(request)
          answerButtons(request).padding(.leading, 76)
        }
      }
      .accessibilityElement(children: .contain)
    } else {
      HStack(spacing: 12) {
        if request.availability.state == .available, let id = request.availability.albumId {
          NavigationLink(value: DiscoverDestination.libraryAlbum(id: id).route) { summary(request) }
        } else {
          summary(request)
        }
        if request.approval == .declined {
          // Declined: nothing more will happen to it, so taking it off the list is the thing to do.
          if context.gate.canRequest {
            Button { remove(request) } label: { Label("Remove", systemImage: "xmark") }
              .buttonStyle(.pill(.secondary, size: .small))
              .accessibilityLabel("Remove \(request.title) from this list")
              .accessibilityInputLabels(["Remove", "Remove \(request.title) from this list"])
          }
        } else {
          RequestButton(album: AlbumRef(mbid: request.mbid, artistName: request.artistName, albumTitle: request.title), availability: request.availability)
        }
      }
      .accessibilityElement(children: .contain)
    }
  }

  /// An admin's answer: Approve sends it to Lidarr, Decline tells whoever asked. Pending, the verb with an ellipsis.
  private func answerButtons(_ request: AlbumRequest) -> some View {
    let answering = requests.answering[request.mbid]
    return HStack(spacing: 8) {
      Button { Task { await requests.approve(request) } } label: {
        Label(answering == true ? "Approving…" : "Approve", systemImage: "checkmark")
      }
      .buttonStyle(.pill(.primary, size: .small))
      .accessibilityLabel("Approve \(request.title)")
      .accessibilityInputLabels(["Approve", "Approve \(request.title)"])
      Button { Task { await requests.decline(request) } } label: {
        Label(answering == false ? "Declining…" : "Decline", systemImage: "xmark")
      }
      .buttonStyle(.pill(.secondary, size: .small))
      .accessibilityLabel("Decline \(request.title)")
      .accessibilityInputLabels(["Decline", "Decline \(request.title)"])
    }
    .disabled(answering != nil)
    .fixedSize()
  }

  private func summary(_ request: AlbumRequest) -> some View {
    HStack(spacing: 12) {
      Cover(path: request.coverUrl, points: 64, label: request.title).frame(width: 64, height: 64)
      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 6) {
          // News since the last look: arrived, or declined.
          if request.unseen == true || requests.fresh.contains(request.mbid) {
            Circle().fill(.tint).frame(width: 8, height: 8).accessibilityLabel("New")
          }
          Text(request.title).lineLimit(1)
        }
        Text(request.artistName).font(.sans(.footnote)).foregroundStyle(.secondary).lineLimit(1)
        TimelineView(.periodic(from: .now, by: 60)) { clock in
          // On one line where it fits; else the state over who asked and when, rather than cutting a name short.
          ViewThatFits(in: .horizontal) {
            Text(RequestRowText.status(request, now: clock.date)).lineLimit(1)
            VStack(alignment: .leading, spacing: 1) {
              Text(RequestRowText.state(request))
              Text(RequestRowText.requested(request, now: clock.date))
            }
            .accessibilityElement(children: .combine)
          }
          .font(.mono(.caption2))
          .foregroundStyle(.secondary)
        }
        if request.availability.state == .downloading {
          ProgressView(value: min(max(request.availability.progress ?? 0, 0), 1)).frame(maxWidth: 240)
        }
      }
    }
  }
}
