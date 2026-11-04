import PlayarrAPI

/// Settings → Analysis's wording (AnalysisPanel.tsx), from the server's progress.
enum AnalysisText {
  static let audioOff = "Audio analysis is off on this server (set ANALYSIS=on in its .env)."

  static func songs(_ n: Int) -> String { "\(AdminText.count(n)) \(n == 1 ? "song" : "songs")" }

  /// What's under way: the songs being analysed and waiting, for each queue.
  static func queue(_ p: AnalysisProgress) -> String? {
    let working = p.working + p.loudnessWorking
    let parts = [
      working > 0 ? "analysing \(songs(working))" : nil,
      p.waiting > 0 ? "\(AdminText.count(p.waiting)) waiting for beat or sound analysis" : nil,
      p.loudnessWaiting > 0 ? "\(AdminText.count(p.loudnessWaiting)) waiting for loudness analysis" : nil,
      p.tagsWaiting > 0 ? "\(AdminText.count(p.tagsWaiting)) waiting for a tag lookup" : nil,
    ].compactMap { $0 }
    return parts.isEmpty ? nil : "Now: \(parts.joined(separator: " · "))."
  }

  static func beats(_ p: AnalysisProgress) -> String {
    let ready = p.beats.ready, beatModel = p.beats.beatModel, failed = p.beats.failed
    let withoutModel = ready > beatModel ? " (\(AdminText.count(ready - beatModel)) without the beat model)" : ""
    if ready >= p.songs {
      return p.songs == 1 ? "The library’s one song is ready for DJ mix\(withoutModel)." : "All \(songs(p.songs)) are ready for DJ mix\(withoutModel)."
    }
    let failures = failed > 0 ? " · \(AdminText.count(failed)) couldn’t be analysed" : ""
    let rest = p.libraryScan ? "" : " Others are analysed as they come up to play."
    return "Ready for DJ mix: \(AdminText.count(ready)) of \(songs(p.songs))\(withoutModel)\(failures).\(rest)"
  }

  static func sound(_ p: AnalysisProgress) -> String {
    measured(ready: p.sound.ready, failed: p.sound.failed, songs: p.songs, tail: "")
  }

  static func loudness(_ p: AnalysisProgress) -> String {
    measured(ready: p.loudness.ready, failed: p.loudness.failed, songs: p.songs, tail: " The others play at their own volume until they are.")
  }

  private static func measured(ready: Int, failed: Int, songs total: Int, tail: String) -> String {
    if ready >= total { return total == 1 ? "The library’s one song is measured." : "All \(songs(total)) are measured." }
    let failures = failed > 0 ? " · \(AdminText.count(failed)) couldn’t be measured" : ""
    return "Measured: \(AdminText.count(ready)) of \(songs(total))\(failures).\(tail)"
  }

  static func tags(_ p: AnalysisProgress) -> String {
    let ready = p.tags.ready, taggable = p.tags.songs
    if taggable == 0 { return "No song is matched on MusicBrainz yet, so there are no tags to look up." }
    let unmatched = p.songs - taggable
    let others = unmatched > 0 ? " (\(AdminText.count(unmatched)) more aren’t matched on MusicBrainz)" : ""
    if ready >= taggable { return "All \(songs(taggable)) matched on MusicBrainz are looked up\(others)." }
    return "Looked up: \(AdminText.count(ready)) of \(songs(taggable)) matched on MusicBrainz\(others)."
  }

  /// What a run queued, as the web's toast says it.
  static func queued(_ queued: Int, kind: AnalysisKind?, again: Bool) -> String {
    let tags = kind == .tags
    guard queued > 0 else { return "Every song is already \(tags ? "looked up" : "analysed") or waiting its turn" }
    return "\(tags ? "Looking up" : "Analysing") \(songs(queued))\(again ? " again" : "") in the background"
  }

  static func switchDescription(_ p: AnalysisProgress) -> String {
    p.enabled
      ? "At low priority: beat, sound and loudness analysis and a tag lookup, once for each song. Off, songs are analysed as they come up to play. Takes a while on a big library: beat analysis can take a minute a song on a small server."
      : "Tags are still looked up as songs come up. \(audioOff)"
  }

  static let everythingTitle = "Reanalyse every song with every analysis?"

  static func everythingExplain(audio: Bool) -> String {
    audio
      ? "Beat, sound and loudness analysis and a tag lookup for every song, from scratch, at low priority. Each song keeps what it has until its turn. On a small server this takes many hours: beat analysis alone can take a minute a song."
      : "A tag lookup for every song matched on MusicBrainz, from scratch. Each song keeps its tags until its turn."
  }
}
