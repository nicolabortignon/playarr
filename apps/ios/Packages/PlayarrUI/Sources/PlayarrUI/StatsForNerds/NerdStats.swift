import Foundation
import PlayarrAPI
import PlayarrPlayer

/// Everything Stats for nerds says, as groups of rows: StatsForNerds.tsx, group for group and row for row, with what's
/// different natively said so. There are no <audio> elements: the decks are shown instead, the stream is the song's
/// own file levelled on this device (or the server's transition, or a mix played live), and each changeover reports
/// the sample it was scheduled on rather than how far apart two files were found.
public enum NerdStats {
  /// The drift past which a phrase's beat "drifts" (`DRIFT_LIMIT_MS`).
  static let driftLimitMs = 25.0
  /// A rate this close to 1 shows as the next song's own tempo.
  static let sameRate = 0.0005

  public struct Row: Equatable, Sendable, Identifiable {
    public enum Value: Equatable, Sendable {
      case text(String)
      case energy(EnergyStrip)
      case error(String)
    }
    public let label: String
    public let value: Value
    public var id: String { label }
  }

  public struct Group: Equatable, Sendable, Identifiable {
    public let title: String
    public let rows: [Row]
    public var id: String { title }
  }

  /// The phrase strip: each phrase's height and whether it's played, playing or to come; the intro and outro lines.
  public struct EnergyStrip: Equatable, Sendable {
    public enum State: Sendable { case unmeasured, past, now, future }
    public var bars: [(height: Double, state: State)]
    public var introAt: Double
    public var outroAt: Double
    public var introLabel: String
    public var outroLabel: String
    public var energyNow: String

    public static func == (x: EnergyStrip, y: EnergyStrip) -> Bool {
      x.bars.map(\.height) == y.bars.map(\.height) && x.bars.map { "\($0.state)" } == y.bars.map { "\($0.state)" }
        && x.introAt == y.introAt && x.outroAt == y.outroAt && x.energyNow == y.energyNow
    }
  }

  /// Where a time falls on the song's grid, from its first bar (1.1).
  public struct GridPosition: Equatable, Sendable {
    public var bar: Int
    /// 1–4 within the bar.
    public var beat: Int
    public var phrase: Int
    /// 1–4 within the phrase.
    public var barOfPhrase: Int
  }

  /// Everything the panel reads.
  public struct Input: Sendable {
    public var track: Track
    public var time: Double
    public var duration: Double
    public var buffered: Double
    public var loading: Bool
    public var playing: Bool
    public var error: String?
    public var map: MixMapEntry?
    public var level: TrackLevel?
    public var metadata: TrackMetadata?
    /// The gain the song plays at (dB), and whether even volume is on.
    public var gainDb: Double
    public var levelVolume: Bool
    public var albumGain: Bool
    public var transitions: PlaybackSettings.Transitions
    public var crossfade: Double
    public var mixMode: MixMode
    public var next: Track?
    /// The planner's answer, when it's working on this song into the next.
    public var upcoming: TransitionPlanner.Result?
    public var djWanted: Bool
    public var mixMissed: Bool
    public var mix: AudioEngine.MixInProgress?
    public var engineNow: SampleTime
    public var reports: [MixReport.Kind: MixReport]
    public var decks: [DeckSnapshot]
    public var continuation: EngineItem.Continuation?

    public init(track: Track, time: Double, duration: Double, buffered: Double, loading: Bool, playing: Bool, error: String? = nil,
      map: MixMapEntry? = nil, level: TrackLevel? = nil, metadata: TrackMetadata? = nil, gainDb: Double = 0, levelVolume: Bool = true,
      albumGain: Bool = false, transitions: PlaybackSettings.Transitions = .dj, crossfade: Double = 0, mixMode: MixMode = .auto,
      next: Track? = nil, upcoming: TransitionPlanner.Result? = nil, djWanted: Bool = false, mixMissed: Bool = false,
      mix: AudioEngine.MixInProgress? = nil, engineNow: SampleTime = 0, reports: [MixReport.Kind: MixReport] = [:], decks: [DeckSnapshot] = [],
      continuation: EngineItem.Continuation? = nil
    ) {
      self.track = track; self.time = time; self.duration = duration; self.buffered = buffered; self.loading = loading
      self.playing = playing; self.error = error; self.map = map; self.level = level; self.metadata = metadata; self.gainDb = gainDb
      self.levelVolume = levelVolume; self.albumGain = albumGain; self.transitions = transitions; self.crossfade = crossfade
      self.mixMode = mixMode; self.next = next; self.upcoming = upcoming; self.djWanted = djWanted; self.mixMissed = mixMissed
      self.mix = mix; self.engineNow = engineNow; self.reports = reports; self.decks = decks; self.continuation = continuation
    }
  }

  // MARK: Reading the map

  public static func gridPosition(_ map: MixMapEntry, _ time: Double) -> GridPosition? {
    guard let grid = EnergyPicture.beatGrid(map) else { return nil }
    let beats = Int(((time - grid.firstBar) / grid.beat + 1e-6).rounded(.down))
    guard beats >= 0 else { return nil }
    let bars = beats / 4
    return GridPosition(bar: bars + 1, beat: beats % 4 + 1, phrase: bars / 4 + 1, barOfPhrase: bars % 4 + 1)
  }

  public static func section(_ map: MixMapEntry, _ time: Double) -> String {
    if time < (map.soundStart ?? 0) || time >= map.soundEnd { return "silence" }
    if time < map.introEnd { return "intro" }
    if time >= map.outroStart { return "outro" }
    if let drop = map.firstDrop, time >= drop { return "main, past the drop" }
    return "main"
  }

  /// "8A" → "A minor", "8B" → "C major" (`keyName`, from camelot.ts's `toCamelot`).
  public static func keyName(_ camelot: Camelot) -> String? {
    let major = ["C", "D♭", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"]
    let minor = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "G♯", "A", "B♭", "B"]
    for pc in 0..<12 {
      if toCamelot(pc, minor: false) == camelot { return "\(major[pc]) major" }
      if toCamelot(pc, minor: true) == camelot { return "\(minor[pc]) minor" }
    }
    return nil
  }

  static func toCamelot(_ pitchClass: Int, minor: Bool) -> String {
    let majorTonic = minor ? (pitchClass + 3) % 12 : pitchClass
    let fifthsFromC = majorTonic * 7 % 12
    return "\((fifthsFromC + 7) % 12 + 1)\(minor ? "A" : "B")"
  }

  /// "+34 ms, drifts · 12 of 58 phrases drift".
  public static func drift(_ drift: [Double?], _ grid: GridPosition?) -> String {
    let drifting = drift.filter { ($0.map { abs($0) > driftLimitMs }) ?? false }.count
    var now: String?
    if let grid, drift.indices.contains(grid.phrase - 1) {
      if let d = drift[grid.phrase - 1] {
        let sign = d > 0 ? "+" : d < 0 ? "−" : "±"
        now = "\(sign)\(Int(abs(d).rounded())) ms, \(abs(d) > driftLimitMs ? "drifts" : "holds")"
      } else {
        now = "no beat to judge"
      }
    }
    return [now, "\(drifting) of \(drift.count) phrases drift"].compactMap { $0 }.joined(separator: " · ")
  }

  public static func energyStrip(_ map: MixMapEntry, _ time: Double) -> EnergyStrip? {
    guard let grid = EnergyPicture.beatGrid(map), !map.phraseEnergy.isEmpty else { return nil }
    let phrase = 16 * grid.beat
    let total = max(map.phraseEnergy.count, Int(((map.soundEnd - grid.firstBar) / phrase).rounded(.up)))
    let now = Int(((time - grid.firstBar) / phrase).rounded(.down))
    let place = { (t: Double) in min(1, max(0, (t - grid.firstBar) / (phrase * Double(total)))) }
    let bars = (0..<total).map { k -> (Double, EnergyStrip.State) in
      guard k < map.phraseEnergy.count, let e = map.phraseEnergy[k] else { return (0.08, .unmeasured) }
      return (max(0.08, EnergyPicture.heardHeight(e)), k == now ? .now : k < now ? .past : .future)
    }
    let energy = map.phraseEnergy.indices.contains(now) ? map.phraseEnergy[now] : nil
    return EnergyStrip(
      bars: bars, introAt: place(map.introEnd), outroAt: place(map.outroStart), introLabel: "intro ends \(NerdFormat.at(map.introEnd))",
      outroLabel: "outro from \(NerdFormat.at(map.outroStart))", energyNow: energy.map { NerdFormat.n2($0) } ?? "–")
  }

  /// The header when collapsed: "124.0 BPM · 8A · 17.3 · −9.0 LUFS".
  public static func summary(map: MixMapEntry?, level: TrackLevel?, time: Double) -> String {
    let grid = map.flatMap { gridPosition($0, time) }
    return [
      map.flatMap { $0.bpm > 0 ? String(format: "%.1f BPM", $0.bpm) : nil }, map?.key?.camelot, grid.map { "\($0.bar).\($0.beat)" },
      level?.lufs.map { "\(NerdFormat.signed($0)) LUFS" },
    ].compactMap { $0 }.joined(separator: " · ")
  }

  // MARK: The groups

  public static func groups(_ i: Input) -> [Group] {
    var groups = [song(i), playback(i), rhythm(i)]
    if let map = i.map { groups.append(structure(map, i.time)) }
    groups.append(Group(title: "Loudness", rows: loudness(i)))
    if let analysis = i.metadata?.analysis {
      groups.append(
        Group(title: "Sound", rows: rows([
          ("Energy", "level \(NerdFormat.n2(analysis.loudness)) · dynamics \(NerdFormat.n2(analysis.dynamics))"),
          ("Texture", "bright \(NerdFormat.n2(analysis.brightness)) · busy \(NerdFormat.n2(analysis.busyness)) · bass \(NerdFormat.n2(analysis.bass))"),
          ("Genres", i.metadata?.genres.isEmpty == false ? i.metadata?.genres.joined(separator: ", ") : nil),
        ])))
    }
    if let next = i.next { groups.append(Group(title: "Next", rows: [Row(label: "Song", value: .text("\(next.title) — \(next.artistName)"))] + upcoming(i))) }
    return groups
  }

  static func rows(_ pairs: [(String, String?)]) -> [Row] {
    pairs.compactMap { label, value in value.flatMap { $0.isEmpty ? nil : Row(label: label, value: .text($0)) } }
  }

  static func song(_ i: Input) -> Group {
    let copy = i.metadata?.copies.first { $0.playing }
    return Group(title: "Song", rows: rows([
      ("Title", "\(i.track.title) — \(i.track.artistName)"),
      ("Ids", "track \(i.track.id) · file \(i.track.fileId)"),
      ("Recording", i.track.recordingId),
      ("Source", copy.map { [$0.source.name, $0.path].compactMap { $0 }.joined(separator: " · ") }),
    ]))
  }

  static func playback(_ i: Input) -> Group {
    var list = rows([
      ("Position", "\(NerdFormat.at(i.time)) / \(NerdFormat.at(i.duration)) · \(i.loading ? "loading" : i.playing ? "playing" : "paused")"),
      ("Buffer", i.buffered > 0 ? "\(NerdFormat.fixed(i.buffered, 1)) s ahead" : "none ahead"),
      ("Stream", stream(i)),
    ])
    list += i.decks.filter { $0.title != nil }.map { Row(label: "Deck \($0.name)", value: .text(deck($0))) }
    list += rows([
      ("URL", i.continuation?.url ?? i.track.streamUrl),
      ("Format", NerdFormat.format(i.track.format)),
      ("Transitions", i.transitions == .dj ? "DJ mix · \(i.mixMode.rawValue)" : i.transitions == .crossfade ? "crossfade \(Int(i.crossfade)) s" : "gapless"),
      ("Mix in", i.reports[.mixIn].map(report) ?? "none yet"),
      ("Mix out", i.reports[.mixOut].map(report) ?? "none yet"),
    ])
    if let error = i.error { list.append(Row(label: "Error", value: .error(error))) }
    return Group(title: "Playback", rows: list)
  }

  /// What's heard: the server's transition, a mix played live, the server's rest of a song, or its own file.
  static func stream(_ i: Input) -> String {
    if let mix = i.mix, i.engineNow < mix.end {
      return mix.way == .server ? "DJ transition, made on the server" : "mixed live on this device"
    }
    if let rest = i.continuation, i.time >= rest.from { return "the rest after the transition, from \(NerdFormat.at(rest.from))" }
    return i.gainDb != 0 ? "its own file, levelled on this device at \(NerdFormat.dB(i.gainDb))" : "its own file"
  }

  /// "Song 2 · at 3:12.0 · 9.5 s decoded, 2.5 s scheduled · +2.0 dB".
  static func deck(_ d: DeckSnapshot) -> String {
    [
      d.title, d.startsAt.map { "placed at \(NerdFormat.at($0))" } ?? "cued",
      String(format: "%.1f s decoded, %.1f s scheduled", d.decodedSeconds, d.scheduledSeconds), d.finished ? "end known" : nil,
      NerdFormat.dB(20 * log10(Double(max(d.gain, 1e-6)))),
    ].compactMap { $0 }.joined(separator: " · ")
  }

  /// "A → B · made on the server · at A's 3:27.5, sample 154 350 · scheduled 2.6 s ahead".
  static func report(_ r: MixReport) -> String {
    let whose = r.kind == .mixIn ? "A’s" : "B’s"
    let ahead = r.headroom.map { String(format: "scheduled %.1f s ahead", $0) } ?? "not scheduled yet"
    return "\(r.songs) · \(r.way.rawValue) · at \(whose) \(NerdFormat.at(r.songTime)), sample \(r.sample) · \(ahead)"
  }

  static func rhythm(_ i: Input) -> Group {
    guard let map = i.map, map.bpm > 0 else {
      var list = [Row(label: "Tempo", value: .text(i.map == nil ? "not analysed yet" : "no steady beat"))]
      if let key = i.map?.key { list.append(keyRow(key)) }
      return Group(title: "Rhythm", rows: list)
    }
    let grid = gridPosition(map, i.time)
    var list = rows([
      ("Tempo", "\(NerdFormat.n2(map.bpm)) BPM · \(Int((60_000 / map.bpm).rounded())) ms a beat"),
      ("Beat", [
        "\(NerdFormat.pct(map.beatConfidence)) sure", map.gridStable ? "steady" : "wandering",
        map.edgesStable.map { $0 ? "holds where mixed" : "drifts where mixed" }, map.beatsFrom == .onsets ? "onsets" : "beat model",
      ].compactMap { $0 }.joined(separator: " · ")),
      ("Bars", "\(NerdFormat.pct(map.downbeatConfidence ?? 1)) sure · first beat \(NerdFormat.at(map.firstBeat)) +\(Int(map.downbeatOffset))"),
      ("Now", grid.map { "bar \($0.bar).\($0.beat) · phrase \($0.phrase) (bar \($0.barOfPhrase)/4)" } ?? (i.time < map.firstBeat ? "before the first beat" : "pickup")),
      ("Drift", map.phraseDrift.map { drift($0, grid) }),
    ])
    if let key = map.key { list.append(keyRow(key)) }
    return Group(title: "Rhythm", rows: list)
  }

  static func keyRow(_ key: MixMapEntry.Key) -> Row {
    Row(label: "Key", value: .text("\(key.camelot) · \(keyName(key.camelot) ?? "?") · \(NerdFormat.pct(key.confidence)) sure"))
  }

  static func structure(_ map: MixMapEntry, _ time: Double) -> Group {
    var list = rows([
      ("Section", section(map, time)),
      ("Audible", "\(NerdFormat.at(map.soundStart ?? 0)) → \(NerdFormat.at(map.soundEnd))"),
      ("Intro", "to \(NerdFormat.at(map.introEnd)) · \(map.coldStart ? "cold start" : "eases in")"),
      ("Outro", "from \(NerdFormat.at(map.outroStart)) · \(map.coldEnd ? "cold end" : "fades out")"),
      ("First drop", map.firstDrop.map(NerdFormat.at) ?? "none"),
    ])
    if let cues = map.cues, cues.mixIn != nil || cues.mixOut != nil {
      let mixIn = cues.mixIn.map { "in \(NerdFormat.at($0))" } ?? "in: detected"
      let mixOut = cues.mixOut.map { "out \(NerdFormat.at($0))" } ?? "out: detected"
      list.append(Row(label: "Mix points", value: .text("\(mixIn) · \(mixOut) (set by hand)")))
    }
    if let strip = energyStrip(map, time) { list.append(Row(label: "Phrases", value: .energy(strip))) }
    list.append(Row(label: "Mix map", value: .text("version \(map.version)")))
    return Group(title: "Structure", rows: list)
  }

  /// The phone applies every gain itself, up as well as down, on any file.
  static func loudness(_ i: Input) -> [Row] {
    guard let level = i.level else { return [Row(label: "Measured", value: .text("not measured yet"))] }
    let applied: String
    if !i.levelVolume {
      applied = "none: even volume is off"
    } else {
      applied = "\(NerdFormat.dB(i.gainDb)) on this device (\(i.albumGain ? "album gain" : "track gain"))"
    }
    return rows([
      ("Measured", level.lufs.map { lufs in "\(NerdFormat.signed(lufs)) LUFS" + (level.peak.map { " · peak \(NerdFormat.signed($0)) dBFS" } ?? "") }),
      ("Gains", "track \(NerdFormat.dB(level.track))" + (level.album.map { " · album \(NerdFormat.dB($0))" } ?? "")),
      ("Applied", applied),
      ("Heard at", i.levelVolume ? level.lufs.map { "≈ \(NerdFormat.signed($0 + i.gainDb)) LUFS" } : nil),
    ])
  }

  static func upcoming(_ i: Input) -> [Row] {
    guard i.transitions == .dj, i.mixMode != .off, i.djWanted else {
      return [Row(label: "How", value: .text(i.transitions == .crossfade ? "crossfade \(Int(i.crossfade)) s" : "straight on, gapless"))]
    }
    guard let result = i.upcoming else { return [Row(label: "Mix", value: .text("planning"))] }
    let status: String
    switch result {
    case .answer(.ready): status = i.mixMissed ? "ready, but placed too late: straight on" : "ready"
    case .answer(.pending): status = "being made"
    case .answer(.straight): status = "straight on"
    case .answer(.unavailable), .answer(.unknown): status = "unavailable"
    case .gaveUp: status = "gave up: not ready in time"
    }
    let plan = result.plan
    var list = [Row(label: "Mix", value: .text(plan.map { "\(status) · \($0.style.rawValue)\($0.beats > 0 ? ", \(Int($0.beats)) beats" : "")" } ?? status))]
    if case .answer(.pending(let p)) = result, let render = p.render { list.append(Row(label: "Making", value: .text(NerdFormat.making(render)))) }
    if let plan {
      let soon = plan.aStart > i.time ? " (in \(NerdFormat.time(plan.aStart - i.time)))" : ""
      list += rows([
        ("Mix at", "\(NerdFormat.at(plan.aStart))\(soon) → \(NerdFormat.at(plan.bStart)) of the next"),
        ("Length", "\(NerdFormat.fixed(plan.length, 1)) s · next takes over at +\(NerdFormat.fixed(plan.switchAt, 1)) s · on from \(NerdFormat.at(plan.bResume))"),
      ])
      let rates = plan.bRate.map(\.value)
      if let slowest = rates.min(), let fastest = rates.max(), rates.contains(where: { abs($0 - 1) >= sameRate }) {
        list.append(Row(label: "Next’s rate", value: .text(slowest == fastest ? String(format: "×%.3f", slowest) : String(format: "×%.3f – ×%.3f", slowest, fastest))))
      }
    }
    if case .answer(.ready(let r)) = result, let levels = r.levels {
      list.append(Row(label: "Levels", value: .text("\(NerdFormat.dB(levels.a)) → \(NerdFormat.dB(levels.b))")))
    }
    let why: String? = switch result {
    case .answer(.unavailable(let u)): u.reason
    default: plan?.reason
    }
    if let why { list.append(Row(label: "Why", value: .text(why))) }
    return list
  }
}
