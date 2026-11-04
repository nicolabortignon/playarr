import Foundation
import Observation
import PlayarrAPI

/// Settings → Sources → Add or edit Lidarr: name, URL, API key (kept unless replaced), Test, Save (LidarrForm).
@MainActor @Observable
public final class LidarrFormModel {
  public enum TestState: Equatable {
    case idle, running
    case done(SourceTestResult)
  }

  public let source: SourceInfo?
  public var name: String
  public var url: String
  public var apiKey = ""
  /// A saved key stays unless "Replace" is tapped.
  public var replacingKey: Bool
  public var enabled: Bool
  public private(set) var test: TestState = .idle
  public private(set) var saving = false
  public var error: String?

  @ObservationIgnored private let api: any APISending

  public init(source: SourceInfo?, api: any APISending) {
    self.source = source
    self.api = api
    name = source?.name ?? "Lidarr"
    url = source?.settings?.url ?? ""
    replacingKey = !(source?.secrets.contains("apiKey") ?? false)
    enabled = source?.enabled ?? true
  }

  public var keySaved: Bool { source?.secrets.contains("apiKey") ?? false }

  /// The browser's checks on the web form: a name, a URL it accepts, and a key unless one is saved.
  public var canSave: Bool {
    !saving && !name.trimmingCharacters(in: .whitespaces).isEmpty && name.count <= 80 && Self.isURL(url) && (keySaved || !apiKey.isEmpty)
  }

  public var canTest: Bool { test != .running && !url.isEmpty }

  /// "Connected to Lidarr 2.9.6", or why not.
  public var testText: String? {
    guard case .done(let result) = test else { return nil }
    return result.ok ? "Connected to Lidarr \(result.version ?? "")" : (result.error ?? "")
  }

  public func runTest() async {
    test = .running
    do {
      test = .done(try await api.send(API.Settings.testSource(id: source?.id, url: url, apiKey: newKey)))
    } catch {
      test = .done(SourceTestResult(ok: false, error: failureText(error)))
    }
  }

  /// Adds or updates the source; true once saved.
  public func save() async -> Bool {
    guard canSave else { return false }
    saving = true
    error = nil
    defer { saving = false }
    let settings = SourceInput.Settings(url: url, apiKey: newKey)
    do {
      if let source {
        _ = try await api.send(API.Settings.updateSource(id: source.id, SourceInput(name: name, enabled: enabled, settings: settings)))
      } else {
        _ = try await api.send(API.Settings.addSource(SourceInput(kind: .lidarr, name: name, enabled: enabled, settings: settings)))
      }
      return true
    } catch {
      self.error = failureText(error)
      return false
    }
  }

  private var newKey: String? { replacingKey && !apiKey.isEmpty ? apiKey : nil }

  /// What `<input type="url">` accepts: a scheme and something after it.
  static func isURL(_ text: String) -> Bool {
    guard let url = URL(string: text.trimmingCharacters(in: .whitespaces)), let scheme = url.scheme, !scheme.isEmpty else { return false }
    return url.host() != nil || !(url.absoluteString.dropFirst(scheme.count + 1).isEmpty)
  }
}
