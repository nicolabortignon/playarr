import PlayarrAPI
import SwiftUI

/// "Songs like these" under your own playlist or Favorites: Add the songs you have (to the playlist, or with a heart),
/// request the albums of the ones you don't (phase 8's Request button), and each row's artist and album lead on
/// (apps/web/src/components/SongsLikeThese.tsx). Asked for again when a request lands or an album is requested (the
/// `recommendations` family). A playlist's page is a list, where this is one of its sections; Favorites scrolls a stack,
/// where it's a block of its own under the songs.
struct RecommendationsSection: View {
  @State private var model: RecommendationsModel
  @Environment(AccountSession.self) private var session
  @Environment(DiscoverContext.self) private var discover: DiscoverContext?
  @Environment(\.horizontalSizeClass) private var sizeClass
  /// A section of a `List` (a playlist's page) rather than a block of a stack (Favorites).
  private let inList: Bool

  init(playlist: PlaylistModel) {
    _model = State(initialValue: RecommendationsModel(playlist: playlist))
    inList = true
  }

  init(favoritesOf session: AccountSession) {
    _model = State(initialValue: RecommendationsModel(favoritesOf: session))
    inList = false
  }

  var body: some View {
    Group {
      if !model.hidden {
        if inList {
          Section { content } header: { header }
            .opacity(dimmed ? 0.6 : 1)
        } else {
          VStack(alignment: .leading, spacing: 0) {
            header.padding(.bottom, 8)
            content
          }
          .opacity(dimmed ? 0.6 : 1)
        }
      }
    }
    .task(id: discover?.generation(.recommendations) ?? 0) { await model.load() }
  }

  /// The last set stays on screen, dimmed, while the next one comes.
  private var dimmed: Bool { model.loading && model.recommendations != nil }

  private var header: some View {
    HStack(alignment: .lastTextBaseline) {
      VStack(alignment: .leading, spacing: 2) {
        Kicker(text: "From ListenBrainz")
        Text("Songs like these").font(.display(.title2)).foregroundStyle(.primary).textCase(nil)
          // A list's section header is one already; in a stack it's said as one, as `SectionHeader`'s title is.
          .accessibilityAddTraits(inList ? [] : .isHeader)
      }
      Spacer()
      // "Mix" means only Made for you's mixes (docs/design.md, Words).
      Button("Other suggestions", systemImage: "dice") { Task { await model.newMix() } }
        .disabled(model.loading)
        .textCase(nil)
    }
  }

  @ViewBuilder private var content: some View {
    if model.recommendations == nil, model.loading {
      SongRowsSkeleton(count: 3)
    } else if let error = model.error, model.recommendations == nil {
      InlineError("Couldn’t reach ListenBrainz", reason: error) { await model.load() }
    } else if model.empty {
      Text(model.emptyLine)
        .foregroundStyle(.secondary)
    }
    if !model.owned.isEmpty {
      group("Already in your library")
      ForEach(model.owned, id: \.recordingId) { recommendation in
        row(recommendation) {
          Button("Add", systemImage: "plus") { Task { await model.add(recommendation) } }
            .buttonStyle(.pill(.secondary, size: .small))
            .accessibilityLabel(model.addLabel(recommendation))
        }
      }
    }
    if !model.missing.isEmpty {
      group("Not in your library yet")
      ForEach(model.shownMissing, id: \.recordingId) { recommendation in
        row(recommendation) {
          if let album = recommendation.album, let availability = recommendation.availability {
            RequestButton(album: album, availability: availability)
          }
        }
      }
      if let more = model.moreLabel {
        Button { model.showAll.toggle() } label: {
          Text(more).font(.mono(.caption)).frame(minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
      }
    }
  }

  /// A group's kicker: a row of its own in a list; in a stack, with the room above it a list row would have.
  private func group(_ title: String) -> some View {
    Kicker(text: title).padding(.top, inList ? 0 : 16).padding(.bottom, inList ? 0 : 4)
  }

  /// The cover and title play a song you have; the artist and album open their pages (or the discography). In the one
  /// row's shape (docs/design.md, "Rows"; `SongRow`), Add or Request in place of ♥ and ⋯; the song it's like shows at
  /// regular width only, as on the web's wide pages, so the title keeps its room on a phone.
  private func row(_ recommendation: RecommendedTrack, @ViewBuilder action: () -> some View) -> some View {
    HStack(spacing: 12) {
      Button { model.play(recommendation) } label: {
        Cover(path: recommendation.coverUrl, points: 44, label: recommendation.albumTitle, color: recommendation.track?.coverColor).frame(width: 44, height: 44)
      }
      .buttonStyle(.plain)
      .disabled(recommendation.track == nil)
      .accessibilityLabel(recommendation.track == nil ? recommendation.title : "Play \(recommendation.title)")
      VStack(alignment: .leading, spacing: 2) {
        Button { model.play(recommendation) } label: {
          Text(recommendation.title).typeRole(.body).foregroundStyle(.paper).essentialLineLimit()
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .disabled(recommendation.track == nil)
        // The cover says it already.
        .accessibilityHidden(true)
        HStack(spacing: 4) {
          Button(recommendation.artistName) { session.router.open(RecommendationsModel.artist(recommendation).route) }
          if !recommendation.albumTitle.isEmpty {
            Text("·").foregroundStyle(.muted)
            Button(recommendation.albumTitle) { session.router.open(RecommendationsModel.album(recommendation).route) }
          }
        }
        .typeRole(.small)
        .foregroundStyle(.paperDim)
        .lineLimit(1)
      }
      // Each button takes only its own taps in a list row.
      .buttonStyle(.plain)
      if sizeClass == .regular, !recommendation.because.isEmpty {
        HStack(spacing: 6) {
          Text("like").typeRole(.badge).foregroundStyle(.muted)
          Text(recommendation.because).typeRole(.small).foregroundStyle(.paperDim).lineLimit(1)
        }
        .frame(maxWidth: 220, alignment: .leading)
        .accessibilityElement(children: .combine)
      }
      action()
    }
    .frame(minHeight: SongRow.height)
    .listRowInsets(.vertical, 0)
  }
}
