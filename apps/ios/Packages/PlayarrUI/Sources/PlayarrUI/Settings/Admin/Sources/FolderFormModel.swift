import Foundation
import Observation
import PlayarrAPI

/// Settings → Sources → Add or edit a folder: on this server, over SSH or SFTP, or an SMB share, chosen in
/// a folder browser (FolderForm). The browser connects only when Connect is tapped, so typing opens nothing.
@MainActor @Observable
public final class FolderFormModel {
  public static let accessChoices: [(access: FolderAccessKind, label: String)] = [
    (.local, "This server"), (.ssh, "SSH"), (.sftp, "SFTP"), (.smb, "SMB share"),
  ]
  public static let smbOffText = "SMB shares need rclone on the server"
  /// The web's example for "Key file on the server".
  public static let keyPathPlaceholder = "~/.ssh/id_ed25519"

  public let source: SourceInfo?
  public private(set) var access: FolderAccessKind
  public var path: String?
  public var host: String
  public var port: Int
  public var user: String
  public var password = ""
  public var replacingPassword: Bool
  public var keyPath: String
  public var domain: String
  public var name: String
  public var enabled: Bool
  /// Without rclone on the server, SMB can't be chosen for a new folder (a saved one stays editable).
  public private(set) var smbOff = false
  /// What the browser shows: this server's folders, or the connection as it was when Connect was tapped.
  public private(set) var browsing: FolderBrowseRequest?
  /// Counts Connects, so the browser starts over each time.
  public private(set) var attempt = 0
  public private(set) var saving = false
  public var error: String?

  @ObservationIgnored private let api: any APISending
  @ObservationIgnored private let savedAccess: FolderAccessKind

  public init(source: SourceInfo?, api: any APISending) {
    self.source = source
    self.api = api
    let saved = source?.settings
    savedAccess = saved?.access ?? .local
    access = savedAccess
    path = saved?.path
    host = saved?.host ?? ""
    port = saved?.port ?? Self.defaultPort(savedAccess)
    user = saved?.user ?? ""
    replacingPassword = !(source?.secrets.contains("password") ?? false)
    keyPath = saved?.privateKeyPath ?? ""
    domain = saved?.domain ?? ""
    name = source?.name ?? ""
    enabled = source?.enabled ?? true
    if savedAccess == .local {
      browsing = FolderBrowseRequest()
    } else if source != nil {
      browsing = connectionNow()
    }
  }

  public var remote: Bool { access != .local }
  public var smb: Bool { access == .smb }
  public var passwordSaved: Bool { source?.secrets.contains("password") ?? false }

  /// SMB listens on 445, SSH and SFTP on 22.
  static func defaultPort(_ access: FolderAccessKind) -> Int { access == .smb ? 445 : 22 }

  /// Asks the server whether SMB shares can be reached (rclone).
  public func loadAccess() async {
    smbOff = (try? await api.send(API.Settings.folderAccess()))?.smb == false
  }

  /// SMB can't be picked without rclone, unless the folder already is one.
  public func isDisabled(_ choice: FolderAccessKind) -> Bool {
    choice == .smb && smbOff && savedAccess != .smb
  }

  public func choose(_ next: FolderAccessKind) {
    guard next != access else { return }
    // SMB and SSH listen on different ports: swap the default, keep a port the user chose.
    if next == .smb, port == 22 { port = 445 }
    if access == .smb, next != .smb, port == 445 { port = 22 }
    access = next
    // A path on one machine means nothing on another.
    path = next == savedAccess ? source?.settings?.path : nil
    browsing = next == .local ? FolderBrowseRequest() : nil
  }

  public var canConnect: Bool { !host.trimmingCharacters(in: .whitespaces).isEmpty && !user.trimmingCharacters(in: .whitespaces).isEmpty }

  public func connect() {
    browsing = connectionNow()
    attempt += 1
  }

  /// What "/" is called on an SMB server: its list of shares, which can't be chosen.
  public var rootLabel: String? {
    guard smb else { return nil }
    return "Shares on \(browsing?.connection?.host ?? source?.settings?.host ?? "")"
  }

  /// A folder is chosen, and it isn't an SMB server's list of shares.
  public var pathOK: Bool {
    guard let path, !path.isEmpty else { return false }
    return !(smb && path == "/")
  }

  public var canSave: Bool {
    guard pathOK, !saving, name.count <= 80 else { return false }
    guard remote else { return true }
    return canConnect && (1...65_535).contains(port)
  }

  /// The name field's hint: the folder's own name.
  public var namePlaceholder: String {
    path?.split(separator: "/").last.map(String.init) ?? "Music"
  }

  public func save() async -> Bool {
    guard canSave, let path else { return false }
    saving = true
    error = nil
    defer { saving = false }
    var settings = SourceInput.Settings(path: path, access: access)
    if remote {
      settings.host = host.trimmingCharacters(in: .whitespaces)
      settings.port = port
      settings.user = user.trimmingCharacters(in: .whitespaces)
      // An empty value clears the saved one.
      if smb { settings.domain = domain.trimmingCharacters(in: .whitespaces) } else { settings.privateKeyPath = keyPath.trimmingCharacters(in: .whitespaces) }
      if replacingPassword, !password.isEmpty { settings.password = password }
    }
    let trimmed = name.trimmingCharacters(in: .whitespaces)
    let input = SourceInput(kind: source == nil ? .folder : nil, name: trimmed.isEmpty ? nil : trimmed, enabled: enabled, settings: settings)
    do {
      if let source {
        _ = try await api.send(API.Settings.updateSource(id: source.id, input))
      } else {
        _ = try await api.send(API.Settings.addSource(input))
      }
      return true
    } catch {
      self.error = failureText(error)
      return false
    }
  }

  private func connectionNow() -> FolderBrowseRequest {
    let trimmedDomain = domain.trimmingCharacters(in: .whitespaces)
    let trimmedKey = keyPath.trimmingCharacters(in: .whitespaces)
    return FolderBrowseRequest(
      id: source?.id,
      connection: .init(
        access: access,
        host: host.trimmingCharacters(in: .whitespaces),
        port: port,
        user: user.trimmingCharacters(in: .whitespaces),
        password: replacingPassword && !password.isEmpty ? password : nil,
        privateKeyPath: access == .smb || trimmedKey.isEmpty ? nil : trimmedKey,
        domain: access == .smb && !trimmedDomain.isEmpty ? trimmedDomain : nil))
  }
}
