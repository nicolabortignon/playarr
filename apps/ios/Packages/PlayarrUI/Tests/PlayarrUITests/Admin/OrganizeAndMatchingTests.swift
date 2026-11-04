import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrUI

@MainActor @Suite struct OrganizeAndMatchingTests {
  let api = FakeAPI()
  let path = "/api/settings/sources/2/organize"

  var plan: OrganizePlan {
    OrganizePlan(
      writable: true,
      moves: [
        OrganizeMove(from: "a.flac", to: "Massive Attack/Mezzanine/01 Angel.flac", artist: "Massive Attack", album: "Mezzanine", confident: true),
        OrganizeMove(from: "b.flac", to: "Massive Attack/Mezzanine/02 Risingson.flac", artist: "Massive Attack", album: "Mezzanine", confident: false),
        OrganizeMove(from: "c.flac", to: "Portishead/Dummy/01 Mysterons.flac", artist: "Portishead", album: "Dummy", confident: true),
      ],
      skipped: [OrganizeSkip(from: "d.flac", reason: "Already exists")],
      lastBatch: .init(id: 7, files: 12, at: "2026-11-03T10:00:00Z"))
  }

  @Test func ticksTheSureMovesAndGroupsThemByAlbum() async {
    let organize = OrganizeModel(sourceId: 2, api: api)
    api.on(.get, path, plan)
    await organize.load()
    #expect(organize.chosen == ["a.flac", "c.flac"])
    #expect(organize.albums.map(\.title) == ["Massive Attack · Mezzanine", "Portishead · Dummy"])
    #expect(organize.selectionText == "2 of 3 moves selected")
    #expect(organize.applyLabel == "Move 2 files")
    #expect(organize.skippedTitle == "1 file can’t move")
    organize.chooseNone()
    #expect(!organize.canApply)
    organize.chooseAll()
    #expect(organize.chosen.count == 3)
  }

  @Test func movesTheTickedFilesInTheirOrderAndSaysHowMany() async {
    var libraryChanges = 0
    let organize = OrganizeModel(sourceId: 2, api: api) { libraryChanges += 1 }
    api.on(.get, path, plan)
    await organize.load()
    organize.toggle(plan.moves[1])
    organize.toggle(plan.moves[2])
    api.on(.post, path, OrganizeResult(batchId: 8, moved: 2, skipped: [OrganizeSkip(from: "b.flac", reason: "Gone")]))
    await organize.apply()
    #expect(api.bodies(.post, path) == [#"{"moves":["a.flac","b.flac"]}"#])
    #expect(organize.notice == "Moved 2 files; 1 skipped")
    #expect(libraryChanges == 1)
  }

  @Test func undoesTheLastBatch() async {
    let organize = OrganizeModel(sourceId: 2, api: api)
    api.on(.get, path, plan)
    await organize.load()
    api.on(.post, "\(path)/undo", json: #"{"restored":12}"#)
    await organize.undo()
    #expect(api.bodies(.post, "\(path)/undo") == [#"{"batchId":7}"#])
    #expect(organize.notice == "Put 12 files back")
    api.fail(.post, "\(path)/undo", status: 409, "Those files were moved again since")
    await organize.undo()
    #expect(organize.notice == "Those files were moved again since" && organize.failed)
  }

  @Test func savesAnAcoustIDKeyAndHidesTheField() async {
    let matching = MatchingModel(api: api)
    api.on(.get, "/api/settings/matching", MatchingSettings(acoustid: false, fingerprints: true))
    await matching.load()
    #expect(matching.editing && !matching.canSave)
    matching.key = "k3y"
    api.on(.put, "/api/settings/matching", MatchingSettings(acoustid: true, fingerprints: true))
    await matching.save()
    #expect(api.bodies(.put, "/api/settings/matching") == [#"{"acoustidKey":"k3y"}"#])
    #expect(!matching.editing && matching.key.isEmpty)
    matching.replacing = true
    #expect(matching.editing)
  }
}
