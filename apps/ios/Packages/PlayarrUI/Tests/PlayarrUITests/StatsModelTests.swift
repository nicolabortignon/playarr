import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct StatsModelTests {
  let api = FakeAPI.demoLibrary()
  let english = Locale(identifier: "en_US")

  @Test func offersThePeriodsThenEachYear() async {
    api.on(.get, "/api/stats", Listening.stats())
    let model = StatsModel(session: demoSession(api: api))
    await model.load()
    #expect(model.periods.map(\.label) == ["4 weeks", "6 months", "12 months", "All time", "2026", "2025"])
    #expect(api.queries(.get, "/api/stats", "range") == ["month"])
    api.on(.get, "/api/stats", Listening.stats(range: "2025"))
    await model.select("2025")
    #expect(model.isYear)
    #expect(api.queries(.get, "/api/stats", "range").last == "2025")
    await model.select("next week")
    #expect(model.range == "2025")
  }

  @Test func readsAnUnknownRangeAsFourWeeks() {
    let session = demoSession(api: api)
    #expect(StatsModel(range: "decade", session: session).range == "month")
    #expect(StatsModel(range: "2024", session: session).range == "2024")
  }

  @Test func saysTheReportInTheWebsWords() {
    let stats = Listening.stats()
    #expect(StatsModel.summary(stats) == "37 songs by 12 artists, on 9 days.")
    #expect(StatsModel.tiles(stats, locale: english).map(\.value) == ["40", "1 day", "1,234", "11 min"])
  }

  @Test func playsTheTopSongsOfTheYear() async {
    api.on(.get, "/api/stats", Listening.stats(range: "2025"))
    let session = demoSession(api: api)
    let model = StatsModel(range: "2025", session: session)
    await model.load()
    model.playTop(all: true)
    #expect(session.player.queue.source == .init(label: "Your top songs of 2025", href: "/settings/listening?range=2025"))
    model.playTop(from: 1, all: false)
    #expect(session.player.queue.source?.label == "Your top songs")
    #expect(session.player.queue.currentTrack?.title == "Risingson")
  }

  @Test func shapesTheChartsWithTheBusiestLabelled() {
    var hours = Array(repeating: 0.0, count: 24)
    hours[21] = 125
    hours[8] = 30
    let chart = ListeningChart.hours(hours, locale: english)
    // Between the hour and AM/PM: a narrow no-break space, as browsers' toLocaleTimeString writes it.
    #expect(chart.columns.count == 24)
    #expect(chart.columns[0].label == "12\u{202F}AM")
    #expect(chart.columns[21].label == "9\u{202F}PM")
    #expect(chart.columns.filter(\.tick).map(\.id) == [0, 6, 12, 18])
    #expect(chart.caption(locale: english) == "Most: 9\u{202F}PM · 2 h 5 min")
    #expect(chart.caption(selected: 8, locale: english) == "8\u{202F}AM · 30 min")
    #expect(ListeningChart.weekdays(Array(repeating: 0, count: 7), locale: english).columns.first?.label == "Sun")
    #expect(ListeningChart.weekdays(Array(repeating: 0, count: 7), locale: english).caption() == nil)
    #expect(ListeningChart.months(Array(repeating: 1, count: 12), locale: english).columns.last?.label == "Dec")
  }

  @Test func readsTheWebsListeningLinks() {
    #expect(Route(href: "/settings/listening?range=2025") == .listeningRange("2025"))
    #expect(Route(href: "/stats") == .listening)
    #expect(Route(href: "/settings/listening") == .listening)
  }
}
