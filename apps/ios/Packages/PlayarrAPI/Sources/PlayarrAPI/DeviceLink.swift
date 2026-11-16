import Foundation

/// A TV's sign-in code opened from a link: playarr://link?server=<origin>&code=<code> (plan 9 §3). The web's /link page
/// offers it on an iPhone or iPad, so the TV is signed in as an account already signed in in the app.
public struct DeviceLink: Equatable, Sendable, Identifiable {
    /// The address the TV showed, as the phone opened it.
    public let server: URL
    /// Upper case, without spaces or dashes, as the TV shows it in two groups of four.
    public let code: String

    public var id: String { "\(server.absoluteString)#\(code)" }

    /// The same code on the server's own page, for a phone that can't sign it in from the app.
    public var webPage: URL? {
        var components = URLComponents(url: server, resolvingAgainstBaseURL: false)
        components?.path = "/link"
        components?.queryItems = [URLQueryItem(name: "code", value: code)]
        return components?.url
    }

    public init(server: URL, code: String) {
        self.server = server
        self.code = Self.normalized(code)
    }

    public init?(_ url: URL) {
        guard url.scheme == "playarr", url.host() == "link",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              let raw = items.first(where: { $0.name == "code" })?.value,
              let origin = items.first(where: { $0.name == "server" })?.value,
              let server = URL(string: origin), server.scheme == "http" || server.scheme == "https", server.host() != nil
        else { return nil }
        let code = Self.normalized(raw)
        guard code.count == 8 else { return nil }
        self.server = server
        self.code = code
    }

    /// As the web's normalizeDeviceCode: letters and digits only, upper case.
    static func normalized(_ code: String) -> String {
        String(code.uppercased().unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) && $0.isASCII }.map(Character.init))
    }

    /// "ABCD 2345", as the TV shows it.
    public var shownCode: String { code.count == 8 ? "\(code.prefix(4)) \(code.suffix(4))" : code }
}
