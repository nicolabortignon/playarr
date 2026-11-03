import Foundation
import PlayarrAPI
@testable import PlayarrPlayer

/// The TypeScript originals' answers (see apps/ios/scripts/mix-fixtures.mjs), decoded.
struct MixFixtures: Decodable {
  struct Curve: Decodable {
    struct Value: Decodable { let t: Double; let value: Double }
    struct Area: Decodable { let from: Double; let to: Double; let area: Double }
    let automation: Automation
    let values: [Value]
    let integrals: [Area]
  }
  struct Skip: Decodable {
    let a: String
    let b: String
    let mode: MixMode
    let sameAlbumInOrder: Bool
    let at: Double
    let plan: TransitionPlan
  }
  struct Cut: Decodable {
    let a: String
    let b: String
    let aDuration: Double
    let mode: MixMode
    let sameAlbumInOrder: Bool
    let beat: BeatCut?
    let silence: BeatCut?
  }
  struct Plan: Decodable {
    struct SongTime: Decodable { let song: MixSequence.Song; let time: Double }
    struct Moment: Decodable { let t: Double; let songTime: SongTime; let bTime: Double; let gain: Double }
    struct BMoment: Decodable { let bTime: Double; let t: Double? }
    let a: String
    let b: String
    let plan: TransitionPlan
    let aDuration: Double
    let straight: BeatCut?
    let times: [Moment]
    let bTimes: [BMoment]
  }
  let songs: [String: MixMapEntry]
  let curves: [Curve]
  let skips: [Skip]
  let cuts: [Cut]
  let plans: [Plan]

  static let all: MixFixtures = {
    do {
      return try JSONDecoder().decode(MixFixtures.self, from: Data(mixFixturesJSON.utf8))
    } catch {
      fatalError("MixFixtures.generated.swift doesn't decode: \(error)")
    }
  }()

  func song(_ name: String) -> MixMapEntry {
    guard let song = songs[name] else { fatalError("no song \(name) in the fixtures") }
    return song
  }
}

/// Two plans agree to 1e-9 in every number (the languages' floating point is the same IEEE arithmetic).
func close(_ x: TransitionPlan, _ y: TransitionPlan) -> Bool {
  let numbers: (TransitionPlan) -> [Double] = { p in
    [p.aStart, p.bStart, p.length, p.bResume, p.switchAt, p.beats]
      + [p.bRate, p.aGain, p.bGain, p.aLowDb, p.bLowDb, p.aHighPassHz].flatMap { [Double($0.count)] + $0.flatMap { [$0.at, $0.value] } }
  }
  let (a, b) = (numbers(x), numbers(y))
  return x.style == y.style && x.reason == y.reason && a.count == b.count && zip(a, b).allSatisfy { abs($0 - $1) < 1e-9 }
}
