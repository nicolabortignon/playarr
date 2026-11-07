import Foundation
import PlayarrAPI
import Testing
@testable import PlayarrPlayer

struct OfflineFolderTests {
  @Test func laysOutAnAccountsFolderAndNamesJobsByTheirPath() {
    let folder = OfflineFolder.of(AccountKey(serverId: "srv-1", accountId: 2), base: URL(filePath: "/tmp/Playarr/"))
    #expect(folder.root.path() == "/tmp/Playarr/srv-1/2/")
    #expect(folder.songPath(song(12)) == "stream/12.flac")
    #expect(folder.jobID("stream/12.flac") == "srv-1/2/stream/12.flac")
    #expect(folder.path(ofJob: "srv-1/2/stream/12.flac") == "stream/12.flac")
    #expect(folder.path(ofJob: "srv-1/3/stream/12.flac") == nil)
    #expect(OfflineFolder(root: folder.root) == folder)
  }

  @Test func keepsItsAudioOutOfBackupsAndFindsWholeFiles() throws {
    let folder = OfflineFolder(root: temporaryDirectory().appending(path: "srv/1"))
    folder.prepare()
    #expect(try folder.stream.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
    let offline = folder.root.appending(path: "offline")
    #expect(try offline.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
    try Data(count: 10).write(to: folder.stream.appending(path: "12.flac"))
    try Data(count: 5).write(to: folder.stream.appending(path: "13.mp3.part"))
    try Data(count: 5).write(to: folder.stream.appending(path: "levelled-AB.wav"))
    try Data(count: 7).write(to: folder.transitions.appending(path: "ab.flac"))
    #expect(folder.songFiles().mapValues(\.bytes) == [12: 10])
    #expect(folder.songFiles()[12]?.path == "stream/12.flac")
    #expect(folder.transitionFiles().mapValues(\.path) == ["ab.flac": "offline/transitions/ab.flac"])
    folder.removeAll()
    #expect(folder.songFiles().isEmpty)
  }

  @Test func namesASongsEncodedStreamByItsQualityAndReadsItBack() {
    #expect(OfflineFolder.songFileName(song(12), quality: .normal) == "12.normal.m4a")
    #expect(OfflineFolder.songFileName(song(12), quality: .high) == "12.high.m4a")
    #expect(OfflineFolder.songFileName(song(12), quality: .original) == "12.flac")
    #expect(OfflineFolder.quality(ofSongPath: "stream/12.normal.m4a") == .normal)
    #expect(OfflineFolder.quality(ofSongPath: "stream/12.high.m4a") == .high)
    #expect(OfflineFolder.quality(ofSongPath: "stream/12.m4a") == .original)
    #expect(OfflineFolder.quality(ofSongPath: "stream/12.flac") == .original)
    #expect(OfflineFolder.fileId(ofName: "12.normal.m4a") == 12)
  }

  @Test func aSongOnDiskAtTwoQualitiesKeepsTheBetter() throws {
    let folder = OfflineFolder(root: temporaryDirectory().appending(path: "srv/1"))
    folder.prepare()
    try Data(count: 10).write(to: folder.stream.appending(path: "12.flac"))
    try Data(count: 4).write(to: folder.stream.appending(path: "12.normal.m4a"))
    try Data(count: 6).write(to: folder.stream.appending(path: "13.high.m4a"))
    try Data(count: 4).write(to: folder.stream.appending(path: "13.normal.m4a"))
    #expect(folder.songFiles().mapValues(\.path) == [12: "stream/12.flac", 13: "stream/13.high.m4a"])
    #expect(folder.size(of: "stream/12.normal.m4a") == nil)
    #expect(folder.size(of: "stream/13.normal.m4a") == nil)
  }
}
