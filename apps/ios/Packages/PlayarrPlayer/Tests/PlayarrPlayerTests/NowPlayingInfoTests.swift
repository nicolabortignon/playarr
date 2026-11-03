import MediaPlayer
import Testing
@testable import PlayarrPlayer

struct NowPlayingInfoTests {
  @Test func showsTheSongWhereItIsAndWhetherItPlays() {
    let info = NowPlayingInfo(track: song(3, duration: 245), elapsed: 12.5, playing: true).dictionary
    #expect(info[MPMediaItemPropertyTitle] as? String == "Song 3")
    #expect(info[MPMediaItemPropertyArtist] as? String == "Artist")
    #expect(info[MPMediaItemPropertyAlbumTitle] as? String == "Album 1")
    #expect(info[MPMediaItemPropertyPlaybackDuration] as? Double == 245)
    #expect(info[MPNowPlayingInfoPropertyElapsedPlaybackTime] as? Double == 12.5)
    #expect(info[MPNowPlayingInfoPropertyPlaybackRate] as? Double == 1)
    #expect(NowPlayingInfo(track: song(3), elapsed: 0, playing: false).dictionary[MPNowPlayingInfoPropertyPlaybackRate] as? Double == 0)
  }
}
