import Foundation
import Testing
@testable import PlayarrAPI

/// The generator's choices for the tricky TypeScript shapes.
@Suite struct GeneratedModelsTests {
    private func decode<T: Decodable>(_ type: T.Type, _ text: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(text.utf8))
    }

    private func object<T: Encodable>(_ value: T) throws -> [String: Any] {
        try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any])
    }

    @Test func readsAnUnknownEnumValueWithoutFailing() throws {
        let availability = try decode(Availability.self, #"{"state":"teleporting"}"#)
        #expect(availability.state == .unknown("teleporting"))
        #expect(try decode(Availability.self, #"{"state":"none"}"#).state == .noneValue)
        #expect(AvailabilityState.noneValue.rawValue == "none")
    }

    @Test func readsEachTransitionAnswer() throws {
        let plan = #""plan":{"style":"long","aStart":200,"bStart":0,"length":16,"bResume":16,"switchAt":8,"bRate":[],"aGain":[{"at":0,"value":1}],"bGain":[],"aLowDb":[],"bLowDb":[],"aHighPassHz":[],"reason":"phrase","beats":32}"#
        let ready = try decode(TransitionAnswer.self, #"{"status":"ready",\#(plan),"url":"/transitions/abc.flac","lead":4,"levels":{"a":-3,"b":1.5}}"#)
        guard case .ready(let answer) = ready else { Issue.record("not ready: \(ready)"); return }
        #expect(answer.url == "/transitions/abc.flac")
        #expect(answer.levels == .init(a: -3, b: 1.5))
        #expect(answer.plan.aGain == [AutomationItem(at: 0, value: 1)])

        let pending = try decode(TransitionAnswer.self, #"{"status":"pending",\#(plan),"render":{"step":"render","done":0.5}}"#)
        guard case .pending(let waiting) = pending else { Issue.record("not pending"); return }
        #expect(waiting.render?.done == 0.5)

        #expect(try decode(TransitionAnswer.self, #"{"status":"unavailable","reason":"No mix map yet"}"#) == .unavailable(.init(reason: "No mix map yet")))
        #expect(try decode(TransitionAnswer.self, #"{"status":"exploded"}"#) == .unknown("exploded"))
    }

    @Test func writesTheTagBack() throws {
        let sent = try object(TransitionAnswer.unavailable(.init(reason: "off")))
        #expect(sent["status"] as? String == "unavailable")
        #expect(sent["reason"] as? String == "off")
    }

    @Test func readsIdsAndCountsAsIntegers() throws {
        let track = try decode(Track.self, #"{"id":7,"recordingId":"rec-1","fileId":9000,"albumId":70,"artistId":7,"title":"Angel","artistName":"Massive Attack","albumTitle":"Mezzanine","trackNumber":1,"discNumber":1,"duration":379.4,"explicit":false,"format":{"codec":"FLAC","container":"flac","bits":16,"sampleRate":44100,"lossless":true},"size":40000000,"streamUrl":"/stream/9000"}"#)
        #expect(track.fileId == 9000)
        #expect(track.duration == 379.4)
        #expect(track.format.sampleRate == 44100)
    }

    @Test func keepsNullsInArrays() throws {
        let map = try decode(MixMap.self, #"{"version":8,"duration":200,"bpm":120,"firstBeat":0.1,"downbeatOffset":0,"gridStable":true,"beatConfidence":0.9,"introEnd":16,"outroStart":180,"coldStart":false,"coldEnd":false,"soundEnd":199,"phraseEnergy":[0.5,null,1]}"#)
        #expect(map.phraseEnergy == [0.5, nil, 1])
        #expect(map.version == mixMapVersion)
    }

    @Test func sendsNullOnlyWhenAPatchSaysSo() throws {
        let cleared = try object(RequestSettingsPatch(rootFolderPath: .some(nil)))
        #expect(cleared.keys.sorted() == ["rootFolderPath"])
        #expect(cleared["rootFolderPath"] is NSNull)
        #expect(try object(RequestSettingsPatch(enabled: true)).keys.sorted() == ["enabled"])
    }

    @Test func sendsARequiredNullAsNull() throws {
        let account = Account(id: 1, username: "owner", name: "Home", role: .admin, canRequest: true, sources: nil, hasPassword: true)
        #expect(try object(account)["sources"] is NSNull)
        #expect(try decode(Account.self, #"{"id":1,"username":"owner","name":"Home","role":"admin","canRequest":true,"sources":null,"hasPassword":true}"#) == account)
    }

    @Test func readsADictionary() throws {
        let levels = try decode([String: TrackLevel].self, #"{"rec-1":{"track":-6,"album":-4.2,"lufs":-8,"peak":-0.5}}"#)
        #expect(levels["rec-1"]?.album == -4.2)
    }

    @Test func readsTheOtherUnion() throws {
        #expect(try decode(RematchResult.self, #"{"kind":"folder","state":"review","trackId":12}"#) == .folder(.init(state: .review, trackId: 12)))
        #expect(try decode(RematchResult.self, #"{"kind":"lidarr","message":"Refreshing"}"#) == .lidarr(.init(message: "Refreshing")))
    }

    @Test func readsAYearAsAStatsRange() throws {
        let range: StatsRange = "2026"
        #expect(range == "2026")
    }
}
