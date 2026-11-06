import Foundation
import PlayarrAPI
import PlayarrPlayer
import Testing
@testable import PlayarrUI

/// The one song menu and the menus of everything you can play (docs/design.md, "Rows, menus and toasts"): what each
/// place offers, in order, and what the place's own items do.
@MainActor @Suite struct SongMenuTests {
  let angel = Demo.mezzanineTracks[0]

  private func titles(_ groups: [[MenuAction]]) -> [[String]] { groups.map { $0.map(\.title) } }

  private func item(_ title: String, in groups: [[MenuAction]]) throws -> MenuAction {
    try #require(groups.flatMap(\.self).first { $0.title == title })
  }

  @Test func aSongOffersTheWholeMenuInOneOrder() {
    let session = demoSession()
    #expect(
      titles(SongMenu.groups(angel, session: session)) == [
        ["Play next", "Add to queue", "Add to playlist…", "Start radio", "Go to album", "Go to artist", "Show metadata"], [],
      ])
  }

  @Test func onItsAlbumsPageGoToAlbumIsLeftOut() {
    let session = demoSession()
    let groups = SongMenu.groups(angel, place: SongMenu.Place(inAlbum: true), session: session)
    #expect(titles(groups)[0] == ["Play next", "Add to queue", "Add to playlist…", "Start radio", "Go to artist", "Show metadata"])
  }

  @Test func theSongPlayingIsntQueuedAgainAndOpensTheQueue() {
    let session = demoSession()
    let place = SongMenu.Place(playing: true, own: [MenuAction(.openQueue) {}])
    #expect(
      titles(SongMenu.groups(angel, place: place, session: session)) == [
        ["Add to playlist…", "Start radio", "Go to album", "Go to artist", "Show metadata"], ["Open queue"],
      ])
  }

  @Test func withDJMixOnEditMixPointsFollowsShowMetadata() {
    let session = demoSession()
    session.player.settings.transitions = .dj
    #expect(titles(SongMenu.groups(angel, session: session))[0].suffix(2) == ["Show metadata", "Edit mix points"])
  }

  @Test func aSongNoLongerInTheLibraryHasOnlyThePlacesOwn() {
    let session = demoSession()
    let groups = SongMenu.groups(nil, place: SongMenu.Place(own: [MenuAction(.remove, title: "Remove from playlist") {}]), session: session)
    #expect(titles(groups) == [["Remove from playlist"]])
    #expect(groups[0][0].destructive)
  }

  @Test func aRowWithoutItsHeartPutsItInTheMenu() async {
    let session = demoSession()
    await session.favorites.load()  // Risingson is a favorite
    let place = SongMenu.Place(favorite: true)
    let add = SongMenu.groups(angel, place: place, session: session)[0].last
    #expect(add?.title == "Add to Favorites")
    #expect(add?.systemImage == "heart")
    let remove = SongMenu.groups(Demo.mezzanineTracks[1], place: place, session: session)[0].last
    #expect(remove?.title == "Remove from Favorites")
    #expect(remove?.systemImage == "heart.slash")
    // A row with its heart beside it keeps it out of the menu.
    #expect(!SongMenu.groups(angel, session: session).flatMap(\.self).contains { $0.kind == .favorite })
  }

  @Test func upNextMovesTheSongAndRemovesItAfterALine() throws {
    let session = demoSession()
    session.player.play(Demo.mezzanineTracks + Demo.protectionTracks)
    let queue = QueueModel(session: session)
    // Risingson, Inertia Creeps, Protection, Karmacoma: the second of four.
    let groups = SongMenu.groups(Demo.mezzanineTracks[2], place: SongMenu.upNext(1, of: 4, session: session), session: session)
    #expect(
      titles(groups) == [
        ["Play next", "Add to queue", "Add to playlist…", "Start radio", "Go to album", "Go to artist", "Show metadata"],
        ["Move up", "Move down", "Remove from queue"],
      ])
    #expect(groups[1].map(\.systemImage) == ["arrow.up", "arrow.down", "xmark"])
    try item("Move down", in: groups).perform()
    #expect(queue.upcoming.map(\.track.title) == ["Risingson", "Protection", "Inertia Creeps", "Karmacoma"])
    // Play next moves a song further down up, rather than queueing it again.
    try item("Play next", in: SongMenu.groups(Demo.protectionTracks[1], place: SongMenu.upNext(3, of: 4, session: session), session: session))
      .perform()
    #expect(queue.upcoming.map(\.track.title) == ["Karmacoma", "Risingson", "Protection", "Inertia Creeps"])
    try item("Remove from queue", in: SongMenu.groups(Demo.protectionTracks[1], place: SongMenu.upNext(0, of: 4, session: session), session: session))
      .perform()
    #expect(queue.upcoming.map(\.track.title) == ["Risingson", "Protection", "Inertia Creeps"])
    #expect(session.toasts.toasts.last?.message == "Removed “Karmacoma” from the queue")
  }

  @Test func upNextsEndsCantMovePastThemAndTheNextSongIsntPlayedNextAgain() {
    let session = demoSession()
    session.player.play(Demo.mezzanineTracks)
    let first = SongMenu.groups(Demo.mezzanineTracks[1], place: SongMenu.upNext(0, of: 2, session: session), session: session)
    #expect(titles(first)[0].first == "Add to queue")
    #expect(titles(first)[1] == ["Move down", "Remove from queue"])
    let last = SongMenu.groups(Demo.mezzanineTracks[2], place: SongMenu.upNext(1, of: 2, session: session), session: session)
    #expect(titles(last)[1] == ["Move up", "Remove from queue"])
  }

  @Test func voiceOverOffersTheMenuAndTheHeart() {
    let session = demoSession()
    session.player.play(Demo.mezzanineTracks)
    let groups = SongMenu.groups(Demo.mezzanineTracks[2], place: SongMenu.upNext(1, of: 2, session: session), session: session)
    let actions = SongRow.voiceOverActions(groups, heart: SongMenu.favorite(Demo.mezzanineTracks[2], session: session))
    #expect(actions.map(\.title).suffix(3) == ["Move up", "Remove from queue", "Add to Favorites"])
    #expect(actions.count == groups.flatMap(\.self).count + 1)
  }

  // MARK: Everything you can play

  @Test func anAlbumsMenuOnItsPageAndOnItsCard() {
    let session = demoSession()
    #expect(
      titles(PlayableMenu.album(70, artistId: 7, tracks: Demo.mezzanineTracks, session: session)) == [
        ["Play next", "Add to queue", "Add to playlist…", "Go to artist"]
      ])
    #expect(
      titles(PlayableMenu.album(70, artistId: 7, card: true, session: session)) == [
        ["Play", "Shuffle", "Play next", "Add to queue", "Add to playlist…", "Go to artist"]
      ])
  }

  @Test func anAlbumCardFetchesItsSongsForAddToPlaylist() async throws {
    let session = demoSession()
    try item("Add to playlist…", in: PlayableMenu.album(70, artistId: 7, card: true, session: session)).perform()
    while session.picking == nil { await Task.yield() }
    #expect(session.picking?.tracks.map(\.title) == ["Angel", "Risingson", "Inertia Creeps"])
  }

  @Test func aPlaylistsMenuHasItsOwnersActionsAfterALine() {
    let session = demoSession()
    let own = [MenuAction(.rename) {}, MenuAction(.delete) {}]
    #expect(
      titles(PlayableMenu.playlist(5, tracks: [angel], own: own, session: session)) == [
        ["Play next", "Add to queue", "Add to playlist…"], ["Rename", "Delete playlist"],
      ])
    #expect(titles(PlayableMenu.playlist(5, card: true, session: session)) == [["Play", "Shuffle", "Play next", "Add to queue", "Add to playlist…"], []])
    // Nothing in it to play: only what its owner can do.
    #expect(titles(PlayableMenu.playlist(5, tracks: [], own: own, session: session)) == [[], ["Rename", "Delete playlist"]])
  }
}
