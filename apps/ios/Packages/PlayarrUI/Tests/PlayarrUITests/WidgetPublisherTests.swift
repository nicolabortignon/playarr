import CoreGraphics
import Foundation
import PlayarrAPI
import PlayarrPlayer
import PlayarrWidgetData
import Testing
@testable import PlayarrUI

@MainActor @Suite struct WidgetPublisherTests {
  let widgets = WidgetStore(folder: FileManager.default.temporaryDirectory.appending(path: "playarr-widget-\(UUID().uuidString)"))
  /// How many times the widgets were reloaded.
  final class Reloads { var count = 0 }
  let reloads = Reloads()

  func app() -> AppModel {
    let directory = FileManager.default.temporaryDirectory.appending(path: "playarr-\(UUID().uuidString)", directoryHint: .isDirectory)
    return AppModel(
      store: ServerStore(directory: directory, secrets: InMemorySecretStore()), browser: ServerBrowser(), appVersion: AppVersion("1.0.0"),
      device: DeviceInfo(name: "Test", platform: "ios"), playback: PlaybackSettings(defaults: UserDefaults(suiteName: UUID().uuidString)!),
      widgets: WidgetPublisher(store: widgets) { [reloads] in reloads.count += 1 },
      makeSession: { record, model in try AccountSession.demo(record, model: model, offline: true) })
  }

  func account(_ id: Int, _ name: String) -> Account {
    Account(id: id, username: name.lowercased(), name: name, role: .member, canRequest: false, sources: nil, hasPassword: true)
  }

  @Test func tellsTheWidgetsWhoIsListeningAndReloadsThemOnlyWhenThatChanges() async throws {
    let app = app()
    try app.store.signedIn(SignInResponse(token: "a", account: account(1, "Nicola")), server: Demo.server, at: Demo.baseURL)
    app.syncSession()
    #expect(widgets.read()?.account == .init(key: "\(Demo.server.id):1", server: Demo.server.name, name: "Nicola"))
    #expect(reloads.count == 1)

    app.syncSession()
    #expect(reloads.count == 1)

    try app.store.signedIn(SignInResponse(token: "b", account: account(2, "Sam")), server: Demo.server, at: Demo.baseURL)
    app.syncSession()
    #expect(widgets.read()?.account?.name == "Sam")
    #expect(reloads.count == 2)

    await app.store.signOut(AccountKey(serverId: Demo.server.id, accountId: 2))
    await app.store.signOut(AccountKey(serverId: Demo.server.id, accountId: 1))
    app.syncSession()
    #expect(widgets.read() == .signedOut)
    #expect(reloads.count == 3)
  }

  @Test func theDemoWritesNothing() {
    let demo = AppModel.demo()
    #expect(demo.widgets == nil)
  }

  /// The covers the shelves asked for.
  final class Asked {
    var albums: [String] = []
    var mixes: [String] = []
  }

  func art(_ asked: Asked) -> WidgetPublisher.Art {
    WidgetPublisher.Art(
      albumCover: { path in
        asked.albums.append(path)
        return Data("album \(path)".utf8)
      },
      mixCover: { mix in
        asked.mixes.append(mix.key)
        return Data("mix \(mix.key)".utf8)
      })
  }

  @Test func putsTheAlbumsAndMixesOnTheShelvesMakingEachCoverOnce() async throws {
    let publisher = WidgetPublisher(store: widgets) { [reloads] in reloads.count += 1 }
    let record = AccountRecord(serverId: "srv-1", account: account(1, "Nicola"))
    publisher.listening(as: record, on: "Home")
    let albums = Array(Demo.albums.prefix(10))
    let shown = albums.prefix(WidgetSnapshot.shelfSize)
    let asked = Asked()

    await publisher.shelves(for: record.key, albums: albums, mixes: [Demo.mix], art: art(asked))

    let snapshot = try #require(widgets.read())
    #expect(snapshot.albums.map(\.id) == shown.map { String($0.id) })
    #expect(snapshot.albums.map(\.subtitle) == shown.map(\.artistName))
    #expect(snapshot.mixes.map(\.id) == [Demo.mix.key])
    let first = try #require(snapshot.albums.first?.cover)
    #expect(try Data(contentsOf: widgets.cover(first)) == Data("album \(try #require(albums[0].coverUrl))".utf8))
    #expect(asked.albums == shown.compactMap(\.coverUrl))
    #expect(asked.mixes == [Demo.mix.key])

    // Home again, nothing new: the covers are kept and the widgets aren't reloaded.
    let reloaded = reloads.count
    await publisher.shelves(for: record.key, albums: albums, mixes: [Demo.mix], art: art(asked))
    #expect(asked.albums == shown.compactMap(\.coverUrl))
    #expect(asked.mixes == [Demo.mix.key])
    #expect(reloads.count == reloaded)

    // The albums didn't come this time and the mixes are gone: the albums stay, and the mix's cover goes with it.
    let mixCover = try #require(snapshot.mixes.first?.cover)
    await publisher.shelves(for: record.key, albums: nil, mixes: [], art: art(asked))
    #expect(widgets.read()?.albums == snapshot.albums)
    #expect(widgets.read()?.mixes == [])
    #expect(!widgets.hasCover(mixCover))
    #expect(widgets.hasCover(first))
  }

  @Test func dropsTheShelvesOfAnAccountNoLongerListening() async {
    let publisher = WidgetPublisher(store: widgets) {}
    let nicola = AccountRecord(serverId: "srv-1", account: account(1, "Nicola"))
    publisher.listening(as: AccountRecord(serverId: "srv-1", account: account(2, "Sam")), on: "Home")

    await publisher.shelves(for: nicola.key, albums: Demo.albums, mixes: [Demo.mix], art: art(Asked()))

    #expect(widgets.read()?.account?.name == "Sam")
    #expect(widgets.read()?.albums == [])
    #expect(widgets.read()?.mixes == [])
  }

  @Test func drawsAMixCoverAsHomeDoesAtTwiceTheWidgetsTileSize() async throws {
    let app = AppModel.demo()
    let session = try #require(app.session)

    let data = try #require(await WidgetPublisher.Art.live(session: session, theme: app.theme).mixCover(Demo.mix))

    let picture = try #require(CGImage.decoded(data))
    #expect(picture.width == Int(WidgetPublisher.Art.points * 2))
    #expect(picture.height == picture.width)
  }

  @Test func followsTheSongPlayingAndPausedWithoutRewritingWhileItPlaysOn() async throws {
    let publisher = WidgetPublisher(store: widgets) { [reloads] in reloads.count += 1 }
    let record = AccountRecord(serverId: "srv-1", account: account(1, "Nicola"))
    publisher.listening(as: record, on: "Home")
    let track = try #require(Demo.tracks.first { $0.coverUrl != nil })
    let start = Date(timeIntervalSince1970: 1_000_000)

    await publisher.nowPlaying(for: record.key, track: track, elapsed: 30.4, playing: true, now: start, art: art(Asked()))
    let playing = try #require(widgets.read()?.nowPlaying)
    #expect(playing.title == track.title)
    #expect(playing.artist == track.artistName)
    #expect(playing.playing)
    #expect(playing.startedAt == Date(timeIntervalSince1970: 1_000_000 - 30))
    #expect(playing.duration == track.duration)
    let cover = try #require(playing.cover)
    #expect(widgets.hasCover(cover))

    // Told again ten seconds on, still playing: the same moment it started, nothing rewritten.
    let reloaded = reloads.count
    await publisher.nowPlaying(for: record.key, track: track, elapsed: 40.4, playing: true, now: start.addingTimeInterval(10), art: art(Asked()))
    #expect(reloads.count == reloaded)

    await publisher.nowPlaying(for: record.key, track: track, elapsed: 41, playing: false, now: start.addingTimeInterval(11), art: art(Asked()))
    #expect(widgets.read()?.nowPlaying?.playing == false)
    #expect(widgets.read()?.nowPlaying?.elapsed == 41)

    await publisher.nowPlaying(for: record.key, track: nil, elapsed: 0, playing: false, art: art(Asked()))
    #expect(widgets.read()?.nowPlaying == nil)
    #expect(!widgets.hasCover(cover))
  }

  @Test func aSlowCoverDoesntPutAnOlderSongOverANewerOne() async throws {
    let publisher = WidgetPublisher(store: widgets) {}
    let record = AccountRecord(serverId: "srv-1", account: account(1, "Nicola"))
    publisher.listening(as: record, on: "Home")
    let first = try #require(Demo.tracks.first { $0.coverUrl != nil })
    var second = try #require(Demo.tracks.last)
    second.coverUrl = nil
    let asking = Gate()
    let gate = Gate()
    let slow = WidgetPublisher.Art(
      albumCover: { _ in
        await asking.open()
        await gate.wait()
        return Data("cover".utf8)
      },
      mixCover: { _ in nil })

    let older = Task { await publisher.nowPlaying(for: record.key, track: first, elapsed: 0, playing: true, art: slow) }
    await asking.wait()  // the first song's cover is on its way
    await publisher.nowPlaying(for: record.key, track: second, elapsed: 0, playing: true, art: art(Asked()))
    await gate.open()
    await older.value

    #expect(widgets.read()?.nowPlaying?.title == second.title)
  }

  @Test func theWidgetsButtonsSayWhenNothingIsPlaying() throws {
    let app = AppModel.demo()
    #expect(throws: QuickPlay.Failure.nothingPlaying) { try QuickPlay(session: app.session).togglePlay() }
    #expect(throws: QuickPlay.Failure.signedOut) { try QuickPlay(session: nil).next() }
  }
}
