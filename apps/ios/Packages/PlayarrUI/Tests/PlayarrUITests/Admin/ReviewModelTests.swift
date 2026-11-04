import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct ReviewModelTests {
  let api = FakeAPI()
  let clock = TestClock()
  let path = "/api/settings/sources/2/review"

  func model() -> ReviewModel { ReviewModel(sourceId: 2, api: api, clock: clock) }

  @Test func describesACandidateLikeTheWeb() {
    let gb = Locale(identifier: "en_GB")
    let c = Samples.candidate("r1")
    #expect(ReviewText.summary(c, locale: gb) == "Massive Attack · 20 Apr 1998 · United Kingdom · Virgin · CD · 2 tracks")
    #expect(ReviewText.releaseDate("1998-04", locale: gb) == "Apr 1998")
    #expect(ReviewText.releaseDate("1998", locale: gb) == "1998")
    #expect(ReviewText.countryName("XW") == "Worldwide")
    #expect(ReviewText.score(c) == "92%")
    let group = Samples.group("g1", candidates: [c])
    #expect(ReviewText.matched(group.files[0], in: c) == "1. Angel 6:19")
    #expect(ReviewText.matched(group.files[1], in: c) == nil)
    let loading = ReviewText.details(Samples.candidate("r2", detailed: false), locale: gb)
    #expect(loading.map(\.label) == ["Artist", "Album", "Released", "First released", "Country", "Label", "Format", "Status", "Tracks"])
    #expect(loading.first { $0.label == "Released" }?.value == nil)
  }

  @Test func startsWithTheBestCandidateAndTheFilesNames() async {
    let review = model()
    api.on(.get, path, [Samples.group("g1", candidates: [Samples.candidate("r1"), Samples.candidate("r2", score: 0.5)])])
    await review.load()
    #expect(review.chosen == "r1")
    #expect(review.artist == "Massive Attack" && review.album == "Mezzanine")
    #expect(review.titles == ["01 Angel.flac": "Angel", "02 Risingson.flac": "Risingson"])
    review.chosen = "r2"
    await review.load()
    #expect(review.chosen == "r2")
  }

  @Test func usesTheChosenAlbumAndShowsTheNextAtOnce() async {
    let review = model()
    api.on(.get, path, [Samples.group("g1", candidates: [Samples.candidate("r1")]), Samples.group("g2", album: "Protection", candidates: [])])
    await review.load()
    api.on(.post, path, json: "")
    api.on(.get, path, [Samples.group("g2", album: "Protection", candidates: [])])
    await review.useChosen()
    #expect(api.bodies(.post, path) == [#"{"groupKey":"g1","releaseId":"r1"}"#])
    #expect(review.current?.groupKey == "g2" && review.album == "Protection")
    #expect(review.saved?.line == "Saved: Mezzanine · Massive Attack")
    #expect(await clock.nextSleep() == .seconds(4))
    clock.advance(by: .seconds(4))
    await review.noteTask?.value
    #expect(review.saved == nil)
  }

  @Test func leavesAnAlbumUnmatchedWithNull() async {
    let review = model()
    api.on(.get, path, [Samples.group("g1", candidates: [])])
    await review.load()
    api.on(.post, path, json: "")
    api.on(.get, path, [ReviewGroup]())
    await review.leaveUnmatched()
    #expect(api.bodies(.post, path) == [#"{"groupKey":"g1","releaseId":null}"#])
    #expect(review.current == nil)
    #expect(review.saved?.line == "Saved: Mezzanine · Massive Attack left unmatched")
  }

  @Test func putsTheAlbumBackWhenSavingFails() async {
    let review = model()
    api.on(.get, path, [Samples.group("g1", candidates: [Samples.candidate("r1")])])
    await review.load()
    api.fail(.post, path, status: 500, "The database is locked")
    await review.useChosen()
    #expect(review.current?.groupKey == "g1")
    #expect(review.saved?.line == "Couldn’t save Mezzanine · Massive Attack: The database is locked. It’s back in the list.")
  }

  @Test func searchesWithOtherNamesAndKeepsTheAlbumOnScreen() async {
    let review = model()
    api.on(.get, path, [Samples.group("g1", candidates: [])])
    await review.load()
    review.artist = " Massive Attack "
    review.album = ""
    #expect(!review.canSearch)
    review.album = "Mezzanine (Deluxe)"
    api.on(.post, path, json: "")
    api.on(.get, path, [Samples.group("g1", candidates: [Samples.candidate("r9")])])
    await review.search()
    #expect(api.bodies(.post, path) == [#"{"groupKey":"g1","search":{"album":"Mezzanine (Deluxe)","artist":"Massive Attack"}}"#])
    #expect(review.chosen == "r9" && !review.searching)
  }

  @Test func savesNamesFixedByHand() async {
    let review = model()
    api.on(.get, path, [Samples.group("g1", candidates: [])])
    await review.load()
    review.fixing = true
    review.titles["02 Risingson.flac"] = "Risingson (Remastered)"
    api.on(.post, path, json: "")
    api.on(.get, path, [ReviewGroup]())
    await review.saveNames()
    #expect(api.bodies(.post, path) == [
      #"{"groupKey":"g1","names":{"album":"Mezzanine","artist":"Massive Attack","titles":{"01 Angel.flac":"Angel","02 Risingson.flac":"Risingson (Remastered)"}}}"#,
    ])
    #expect(review.saved?.line == "Saved: Mezzanine · Massive Attack: names saved")
  }

  @Test func pollsWhileEditionDetailsAreComing() async {
    let review = model()
    api.on(.get, path, [Samples.group("g1", candidates: [Samples.candidate("r1", detailed: false)])])
    api.then(.get, path, [Samples.group("g1", candidates: [Samples.candidate("r1")])])
    let polling = Task { await review.poll() }
    #expect(await clock.nextSleep() == .seconds(2))
    clock.advance(by: .seconds(2))
    await polling.value
    #expect(api.calls(.get, path).count == 2)
    #expect(review.candidate?.detailed == true)
  }

  @Test func asksTheViewToPollAgainWhenASearchBringsUndetailedCandidates() async {
    let review = model()
    api.on(.get, path, [Samples.group("g1", candidates: [])])
    await review.load()
    let round = review.pollRound
    review.album = "Mezzanine"
    api.on(.post, path, json: "")
    api.on(.get, path, [Samples.group("g1", candidates: [Samples.candidate("r9", detailed: false)])])
    await review.search()
    #expect(review.pollRound == round + 1)
  }
}
