import Foundation

/// A setup code opened from a link: playarr://redeem?server=<origin>&code=<code>.
public struct RedeemLink: Equatable, Sendable, Identifiable {
    public let server: URL
    public let code: String

    public var id: String { "\(server.absoluteString)#\(code)" }

    public init(server: URL, code: String) {
        self.server = server
        self.code = code
    }

    public init?(_ url: URL) {
        guard url.scheme == "playarr", url.host() == "redeem",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              let code = items.first(where: { $0.name == "code" })?.value, !code.isEmpty,
              let origin = items.first(where: { $0.name == "server" })?.value,
              let server = URL(string: origin), server.scheme == "http" || server.scheme == "https", server.host() != nil
        else { return nil }
        self.server = server
        self.code = code
    }
}
