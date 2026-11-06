import PlayarrAPI
import SwiftUI

/// Your listening: the period (4 weeks, 6 months, 12 months, all time or a year), the minutes and figures, the artist of
/// the year, top artists, songs and albums, when you listen, and your sound (apps/web/src/pages/Stats.tsx).
struct StatsView: View {
  let session: AccountSession
  @State private var model: StatsModel
  @Environment(Theme.self) private var theme

  init(range: StatsRange?, session: AccountSession) {
    self.session = session
    _model = State(initialValue: StatsModel(range: range, session: session))
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 32) {
        if model.isYear { Text("Your \(model.range)").font(.display(.largeTitle)) }
        // One row that scrolls sideways, edge to edge, rather than wrapping.
        ScrollView(.horizontal) {
          HStack(spacing: 8) {
            ForEach(model.periods, id: \.self) { period in
              Button(period.label) { Task { await model.select(period.range) } }
                .buttonStyle(.choice(selected: period.range == model.range))
                .accessibilityAddTraits(period.range == model.range ? .isSelected : [])
            }
          }
        }
        .scrollIndicators(.hidden)
        .contentMargins(.horizontal, 20, for: .scrollContent)
        .padding(.horizontal, -20)
        if let stats = model.stats {
          if stats.plays == 0 {
            Text(StatsModel.nothingPlayed).foregroundStyle(.secondary)
          } else {
            report(stats).opacity(model.loading ? 0.6 : 1)
          }
        } else if let error = model.error {
          ErrorState(message: error) { await model.load() }
        } else {
          Skeleton(aspectRatio: nil, height: 96)
          Skeleton(aspectRatio: nil, height: 240)
        }
      }
      .padding(20)
    }
    .navigationTitle("Your listening")
    .task { await model.load() }
    .refreshable { await model.load() }
  }

  @ViewBuilder private func report(_ stats: ListeningStats) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      if model.isYear { Text("YEAR IN REVIEW").font(.mono(.caption2)).tracking(2).foregroundStyle(theme.accent.color) }
      HStack(alignment: .firstTextBaseline, spacing: 10) {
        Text(Format.number(Int(stats.minutes.rounded()))).font(.sans(size: 56, weight: .semibold)).monospacedDigit()
        Text("minutes").font(.sans(.title3)).foregroundStyle(.secondary)
      }
      Text(StatsModel.summary(stats)).foregroundStyle(.secondary)
      Grid(alignment: .leading, horizontalSpacing: 24, verticalSpacing: 16) {
        let tiles = StatsModel.tiles(stats)
        GridRow { tile(tiles[0]); tile(tiles[1]) }
        GridRow { tile(tiles[2]); tile(tiles[3]) }
      }
      .padding(.top, 12)
    }
    if model.isYear, let top = stats.topArtists.first {
      NavigationLink(value: Route.artist(top.artist.id)) {
        HStack(alignment: .bottom, spacing: 16) {
          Cover(path: top.artist.imageUrl, points: 120, label: top.artist.name).frame(width: 120, height: 120)
          VStack(alignment: .leading, spacing: 4) {
            Kicker(text: "Your artist of the year")
            Text(top.artist.name).font(.display(.title))
            Text(artistLine(top, first: stats.firstSong)).font(.sans(.subheadline)).foregroundStyle(.secondary)
          }
        }
      }
      .buttonStyle(.plain)
    }
    section("Top artists") {
      ForEach(Array(stats.topArtists.enumerated()), id: \.element.artist.id) { index, item in
        NavigationLink(value: Route.artist(item.artist.id)) {
          HStack(spacing: 14) {
            Text("\(index + 1)").font(.sans(.subheadline).monospacedDigit()).foregroundStyle(.secondary).frame(width: 24, alignment: .trailing)
            Cover(path: item.artist.imageUrl, points: 48, label: item.artist.name, circle: true).frame(width: 48, height: 48)
            Text(item.artist.name).lineLimit(1)
            Spacer()
            Text("\(Format.minutes(item.minutes)) · \(Format.plural(item.plays, "play"))").font(.sans(.footnote).monospacedDigit()).foregroundStyle(.secondary)
          }
        }
        .buttonStyle(.plain)
      }
    }
    section("Top songs") {
      Button("Play them", systemImage: "play.fill") { model.playTop(all: true) }
        .buttonStyle(.pill(.primary))
      ForEach(Array(stats.topTracks.enumerated()), id: \.element.track.id) { index, item in
        Button { model.playTop(from: index, all: false) } label: {
          HStack(spacing: 14) {
            Text("\(index + 1)").font(.sans(.subheadline).monospacedDigit()).foregroundStyle(.secondary).frame(width: 24, alignment: .trailing)
            Cover(path: item.track.coverUrl, points: 44, label: item.track.albumTitle).frame(width: 44, height: 44)
            VStack(alignment: .leading) {
              Text(item.track.title).lineLimit(1)
              Text(item.track.artistName).font(.sans(.footnote)).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            Text(Format.plural(item.plays, "play")).font(.sans(.footnote).monospacedDigit()).foregroundStyle(.secondary)
          }
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
      }
    }
    if !stats.topAlbums.isEmpty {
      section("Top albums") {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 16, alignment: .top)], spacing: 24) {
          ForEach(stats.topAlbums.prefix(6), id: \.album.id) { AlbumCard(album: $0.album) }
        }
      }
    }
    section("When you listen") {
      ColumnChartView(chart: .hours(stats.hours))
      ColumnChartView(chart: .weekdays(stats.weekdays))
      if let months = stats.months { ColumnChartView(chart: .months(months)) }
    }
    if !stats.topGenres.isEmpty {
      section("Your sound") {
        FlowLayout(spacing: 8) {
          ForEach(stats.topGenres, id: \.genre) { genre in
            HStack(spacing: 6) {
              Text(genre.genre)
              Text(Format.minutes(genre.minutes)).font(.sans(.caption).monospacedDigit()).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .overlay(Capsule().strokeBorder(Color.secondary.opacity(0.3)))
          }
        }
      }
    }
  }

  private func tile(_ tile: (label: String, value: String)) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(tile.label).font(.sans(.footnote)).foregroundStyle(.secondary)
      Text(tile.value).font(.sans(.title2).weight(.semibold)).monospacedDigit()
    }
  }

  private func section(_ title: String, @ViewBuilder content: () -> some View) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(title).font(.display(.title)).accessibilityAddTraits(.isHeader)
      content()
    }
  }

  /// "1 h 50 min over 20 plays · your year started with Angel".
  private func artistLine(_ top: ListeningStats.TopArtistsItem, first: ListeningStats.FirstSong?) -> String {
    "\(Format.minutes(top.minutes)) over \(Format.plural(top.plays, "play"))" + (first.map { " · your year started with \($0.track.title)" } ?? "")
  }
}
