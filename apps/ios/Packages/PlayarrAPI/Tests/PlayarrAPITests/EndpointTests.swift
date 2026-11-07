import Foundation
import Testing
@testable import PlayarrAPI

@Suite struct EndpointTests {
    private func body<T>(_ endpoint: Endpoint<T>) throws -> [String: Any] {
        let data = try #require(try endpoint.bodyData())
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test func clearsCuePointsWithNull() throws {
        let sent = try body(API.Playback.setCues(recordingId: "rec-1", mixIn: 12.5, mixOut: nil))
        #expect(sent["mixIn"] as? Double == 12.5)
        #expect(sent["mixOut"] is NSNull)
    }

    @Test func sendsEverySourceAsNull() throws {
        let sent = try body(API.Accounts.create(username: "sam", name: "Sam", role: .member, canRequest: false, sources: nil))
        #expect(sent["sources"] is NSNull)
        #expect(sent["role"] as? String == "member")
    }

    @Test func leavesOutWhatAPatchDoesntChange() throws {
        #expect(try body(API.Accounts.update(id: 2, AccountPatch(name: "Sam"))).keys.sorted() == ["name"])
        let everySource = try body(API.Accounts.update(id: 2, AccountPatch(sources: .some(nil))))
        #expect(everySource["sources"] is NSNull)
        #expect(try body(API.Accounts.update(id: 2, AccountPatch(requestAccess: .ask))) as? [String: String] == ["requestAccess": "ask"])
    }

    @Test func sendsWhetherANewAccountAsksFirstBesideWhetherItMayRequest() throws {
        let sent = try body(API.Accounts.create(username: "sam", name: "Sam", role: .member, canRequest: true, requestAccess: .ask, sources: nil))
        #expect(sent["canRequest"] as? Bool == true)
        #expect(sent["requestAccess"] as? String == "ask")
        // Without it, servers go by canRequest alone.
        #expect(try body(API.Accounts.create(username: "sam", name: "Sam", role: .member, canRequest: false, sources: nil))["requestAccess"] == nil)
    }

    @Test func answersAndMarksRequestsByTheirReleaseGroup() throws {
        #expect(API.Requests.approve(mbid: "rg-1").method == .post)
        #expect(API.Requests.approve(mbid: "rg-1").path == "/api/requests/rg-1/approve")
        #expect(API.Requests.decline(mbid: "rg-1").path == "/api/requests/rg-1/decline")
        let seen = API.Requests.seen(mbids: ["rg-1", "rg-2"])
        #expect(seen.path == "/api/requests/seen")
        #expect(try body(seen)["mbids"] as? [String] == ["rg-1", "rg-2"])
    }

    @Test func leavesOutOptionalTransitionFields() throws {
        let sent = try body(API.Playback.transition(TransitionRequest(from: 3, to: 4, mode: .party, position: 61.5)))
        #expect(sent.keys.sorted() == ["from", "mode", "position", "to"])
        #expect(sent["mode"] as? String == "party")
    }

    @Test func sendsWhenAFavoriteTakenBackWasFirstMade() throws {
        #expect(try API.Favorites.add(recordingId: "rec-1").bodyData() == nil)
        let sent = try body(API.Favorites.add(recordingId: "rec-1", favoritedAt: "2026-01-02T03:04:05.000Z"))
        #expect(sent as? [String: String] == ["favoritedAt": "2026-01-02T03:04:05.000Z"])
    }

    @Test func runsEveryAnalysisAsAll() {
        #expect(API.Analysis.run(nil).path == "/api/analysis/all")
        #expect(API.Analysis.run(.beats).path == "/api/analysis/beats")
    }

    @Test func saysTheTimeZoneForMixes() {
        let endpoint = API.Mixes.get(key: "genre-electronic", timeZone: TimeZone(identifier: "Europe/London")!)
        #expect(endpoint.path == "/api/mixes/genre-electronic")
        #expect(endpoint.query == [URLQueryItem(name: "tz", value: "Europe/London")])
    }
}
