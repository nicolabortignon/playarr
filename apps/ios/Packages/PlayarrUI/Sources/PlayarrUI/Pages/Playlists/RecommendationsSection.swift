import PlayarrAPI
import SwiftUI

/// "Songs like these" under your own playlist: Add the songs you have, request the albums of the ones you don't (phase
/// 8's Request button), and each row's artist and album lead on (apps/web/src/components/PlaylistRecommendations.tsx).
/// Asked for again when a request lands or an album is requested (the `recommendations` family).
struct RecommendationsSection: View {
  @State private var model: RecommendationsModel
  @Environment(AccountSession.self) private var session
  @Environment(DiscoverContext.self) private var discover: DiscoverContext?
  @Environment(\.horizontalSizeClass) private var sizeClass

  init(playlist: PlaylistModel) {
    _model = State(initialValue: RecommendationsModel(playlist: playlist))
  }

  var body: some View {
    Group {
      if !model.hidden {
        Section {
          if model.recommendations == nil, model.loading {
            SongRowsSkeleton(count: 3)
          } else if let error = model.error, model.recommendations == nil {
            InlineError("Couldn’t reach ListenBrainz", reason: error) { await model.load() }
          } else if model.empty {
            Text("ListenBrainz doesn’t know these songs well enough to suggest anything yet. Try other suggestions, or add a few more songs.")
              .foregroundStyle(.secondary)
          }
          if !model.owned.isEmpty {
            Kicker(text: "Already in your library")
            ForEach(model.owned, id: \.recordingId) { recommendation in
              row(recommendation) {
                Button("Add", systemImage: "plus") { Task { await model.add(recommendation) } }
                  .buttonStyle(.pill(.secondary, size: .small))
                  .accessibilityLabel("Add \(recommendation.title) to playlist")
              }
            }
          }
          if !model.missing.isEmpty {
            Kicker(text: "Not in your library yet")
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
        } header: {
          HStack(alignment: .lastTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
              Kicker(text: "From ListenBrainz")
              Text("Songs like these").font(.display(.title2)).foregroundStyle(.primary).textCase(nil)
            }
            Spacer()
            // "Mix" means only Made for you's mixes (docs/design.md, Words).
            Button("Other suggestions", systemImage: "dice") { Task { await model.newMix() } }
              .disabled(model.loading)
              .textCase(nil)
          }
        }
        .opacity(model.loading && model.recommendations != nil ? 0.6 : 1)
      }
    }
    .task(id: discover?.generation(.recommendations) ?? 0) { await model.load() }
  }

  /// The cover and title play a song you have; the artist and album open their pages (or the discography). In the one
  /// row's shape (docs/design.md, "Rows"; `SongRow`), Add or Request in place of ♥ and ⋯; the song it's like shows at
  /// regular width only, as on the web's wide pages, so the title keeps its room on a phone.
  private func row(_ recommendation: RecommendedTrack, @ViewBuilder action: () -> some View) -> some View {
    HStack(spacing: 12) {
      Button { model.play(recommendation) } label: {
        Cover(path: recommendation.coverUrl, points: 44, label: recommendation.albumTitle).frame(width: 44, height: 44)
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
