import Foundation
import Observation
import PlayarrAPI

/// Settings → Analysis: how far each analysis (beats, sound, loudness, tags) has got over the library, a
/// button for the songs each has left, one to do the entire collection again (after asking), and the
/// "Analyze every song in the library" switch. Polled every 10 s while songs wait or are analyzed.
@MainActor @Observable
public final class AnalysisModel {
  /// One analysis's section.
  public struct Row: Identifiable, Equatable {
    public let kind: AnalysisKind
    public let title: String
    public let description: String
    public let text: String
    public let done: Int
    public let of: Int
    /// Shown while not everything is done (and the analysis can run here).
    public let showsBar: Bool
    /// "Analyze the 1,200 of 5,678 songs left", while some are left.
    public let leftLabel: String?
    /// The run buttons show (the analysis can run, and there are songs).
    public let canRun: Bool
    public let againLabel: String
    public let againExplain: String
    public let meter: String

    public var id: String { kind.rawValue }
    public var againQuestion: String { "\(againLabel)?" }
  }

  public private(set) var progress: AnalysisProgress?
  public private(set) var loadError: String?
  /// "Analyze every song in the library" (a mix setting); nil until loaded.
  public private(set) var analyzeLibrary: Bool?
  public private(set) var running = false
  public private(set) var notice: String?
  public private(set) var failed = false

  @ObservationIgnored private let api: any APISending
  @ObservationIgnored private let clock: any Clock<Duration>

  public init(api: any APISending, clock: any Clock<Duration> = ContinuousClock()) {
    self.api = api
    self.clock = clock
  }

  var busy: Bool {
    guard let p = progress else { return false }
    return p.waiting > 0 || p.working > 0 || p.loudnessWaiting > 0 || p.loudnessWorking > 0 || p.tagsWaiting > 0
  }

  /// Every 10 s while songs are under way; otherwise once a minute, so a run started elsewhere shows up.
  var pollInterval: Duration { busy ? .seconds(10) : .seconds(60) }

  public func poll() async {
    await Polling.run(clock: clock, interval: { [weak self] in self?.pollInterval }) { [weak self] in await self?.load() }
  }

  public func load() async {
    do {
      progress = try await api.send(API.Analysis.progress())
      loadError = nil
    } catch {
      loadError = failureText(error)
    }
    if analyzeLibrary == nil, let mixes = try? await api.send(API.Settings.mixes()) { analyzeLibrary = mixes.analyzeLibrary }
  }

  public var queueText: String {
    progress.flatMap(AnalysisText.queue) ?? "Nothing is being analyzed right now."
  }

  /// The switch is on only when audio analysis is too.
  public var analyzeLibraryShown: Bool { (analyzeLibrary ?? false) && (progress?.enabled ?? false) }

  public func setAnalyzeLibrary(_ on: Bool) async {
    let previous = analyzeLibrary
    analyzeLibrary = on
    do {
      analyzeLibrary = try await api.send(API.Settings.saveMixes(MixSettingsPatch(analyzeLibrary: on))).analyzeLibrary
      await load()
    } catch {
      analyzeLibrary = previous
      notice = "Couldn’t save: \(failureText(error))"
      failed = true
    }
  }

  /// `kind` nil runs every analysis; `again` does every song, those done included.
  public func run(_ kind: AnalysisKind?, again: Bool = false) async {
    running = true
    defer { running = false }
    do {
      let answer = try await api.send(API.Analysis.run(kind, again: again))
      notice = AnalysisText.queued(answer.queued, kind: kind, again: again)
      failed = false
      await load()
    } catch {
      notice = failureText(error)
      failed = true
    }
  }

  public var rows: [Row] {
    guard let p = progress else { return [] }
    let audio = p.enabled
    return [
      row(
        .beats, "Beat analysis",
        "Each song’s tempo, beat grid and bars, key, intro and outro, and where its sound starts and ends: what DJ mix needs to join songs on the beat, and the tempo mixes and covers go by. The heaviest analysis: up to a minute a song on a small server.",
        text: audio ? AnalysisText.beats(p) : "DJ mix needs it. \(AnalysisText.audioOff)", done: p.beats.ready, failed: p.beats.failed, of: p.songs,
        canRun: audio, verb: "Analyze", meter: "Songs ready for DJ mix", again: "Reanalyze the entire collection",
        explain: "Beat analysis for every song, from scratch, at low priority. Each song mixes as it does now until its turn. On a small server this takes many hours: up to a minute a song."),
      row(
        .sound, "Sound analysis",
        "What each song feels like: its energy, brightness, bass and how busy it is. For Energy boost, Chill, Deep focus, Wind down, Vibes of the hour, radio and playlist covers.",
        text: audio ? AnalysisText.sound(p) : AnalysisText.audioOff, done: p.sound.ready, failed: p.sound.failed, of: p.songs,
        canRun: audio, verb: "Analyze", meter: "Songs measured for their sound", again: "Reanalyze the entire collection",
        explain: "Sound analysis for every song, from scratch, at low priority. Each song keeps what it has until its turn."),
      row(
        .loudness, "Loudness analysis",
        "How loud each song sounds (EBU R128) and its peak, for Even out the volume in Settings → Playback. A second or two a song.",
        text: audio ? AnalysisText.loudness(p) : "Even volume needs it. \(AnalysisText.audioOff)", done: p.loudness.ready, failed: p.loudness.failed,
        of: p.songs, canRun: audio, verb: "Analyze", meter: "Songs measured for their loudness", again: "Reanalyze the entire collection",
        explain: "Loudness analysis for every song, from scratch, a second or two a song. Each song keeps its level until its turn."),
      row(
        .tags, "Tag lookup",
        "Each song’s genres and year from ListenBrainz, for genre and decade mixes. Only songs matched on MusicBrainz can be looked up; tags are looked up again after a month.",
        text: AnalysisText.tags(p), done: p.tags.ready, failed: 0, of: p.tags.songs, canRun: true, verb: "Look up", meter: "Songs looked up",
        again: "Look up the entire collection again",
        explain: "A tag lookup for every song matched on MusicBrainz, from scratch. Each song keeps its tags until its turn."),
    ]
  }

  /// "Reanalyze everything" shows once there are songs.
  public var offersEverything: Bool { (progress?.songs ?? 0) > 0 }

  private func row(
    _ kind: AnalysisKind, _ title: String, _ description: String, text: String, done: Int, failed: Int, of: Int, canRun: Bool,
    verb: String, meter: String, again: String, explain: String
  ) -> Row {
    // Failed songs wait a day before another try, so they aren't left to start.
    let left = max(0, of - done - failed)
    let allowed = canRun && of > 0
    return Row(
      kind: kind, title: title, description: description, text: text, done: done, of: of, showsBar: canRun && of > 0 && done < of,
      leftLabel: allowed && left > 0 ? "\(verb) the \(AdminText.count(left)) of \(AnalysisText.songs(of)) left" : nil,
      canRun: allowed, againLabel: again, againExplain: explain, meter: meter)
  }
}
