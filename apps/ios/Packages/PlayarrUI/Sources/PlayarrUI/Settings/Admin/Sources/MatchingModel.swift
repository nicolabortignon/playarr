import Foundation
import Observation
import PlayarrAPI

/// Settings → Sources → Identifying songs: the AcoustID key (the key itself never comes back).
@MainActor @Observable
public final class MatchingModel {
  public private(set) var settings: MatchingSettings?
  public var replacing = false
  public var key = ""
  public private(set) var saving = false
  public var error: String?

  @ObservationIgnored private let api: any APISending

  public static let intro =
    "Playarr matches folder albums on MusicBrainz by their names, track titles and lengths. For songs whose names don’t help, it can identify them by their sound with AcoustID. A free key comes from acoustid.org."
  public static let noFingerprints = "Fingerprints need fpcalc (Chromaprint) on the server. The Docker image includes it."
  public static let keyPage = URL(string: "https://acoustid.org/new-application")

  public init(api: any APISending) {
    self.api = api
  }

  /// The key field shows when no key is saved, or after "Replace".
  public var editing: Bool { replacing || settings?.acoustid == false }
  public var canSave: Bool { !key.isEmpty && !saving }

  public func load() async {
    settings = try? await api.send(API.Settings.matching())
  }

  public func save() async {
    guard canSave else { return }
    saving = true
    error = nil
    defer { saving = false }
    do {
      settings = try await api.send(API.Settings.saveMatching(acoustidKey: key))
      replacing = false
      key = ""
    } catch {
      self.error = failureText(error)
    }
  }
}
