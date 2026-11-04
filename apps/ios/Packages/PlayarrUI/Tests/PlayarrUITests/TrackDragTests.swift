import Foundation
import UniformTypeIdentifiers
import PlayarrAPI
import Testing
@testable import PlayarrUI

@Suite struct TrackDragTests {
  @Test func carriesTheSongs() throws {
    let drag = TrackDrag(tracks: Array(Demo.mezzanineTracks.prefix(2)))
    let back = try JSONDecoder().decode(TrackDrag.self, from: JSONEncoder().encode(drag))
    #expect(back == drag)
    #expect(TrackDrag.tracks([drag, TrackDrag(tracks: Array(Demo.dummyTracks.prefix(2)))]).map(\.title) == ["Angel", "Risingson", "Mysterons", "Sour Times"])
    #expect(UTType.playarrTracks.identifier == "me.tracklistme.playarr.tracks")
  }

  @Test func dropsOnlyOnYourOwnPlaylists() {
    var shared = Demo.playlist
    #expect(TrackDrag.accepts(shared))
    shared.mine = false
    #expect(!TrackDrag.accepts(shared))
  }
}
