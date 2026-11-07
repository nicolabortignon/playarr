/// An answer with no body (204), or one the caller doesn't need.
public struct NoContent: Decodable, Sendable, Equatable {
    public init() {}
    public init(from decoder: any Decoder) throws {}
}

/// GET /api/albums with `offset`: a page of the albums (plan 3 §1), or, from a server older than pages (before 0.6.564,
/// which leaves `offset` out), all of them at once.
public enum AlbumsAnswer: Decodable, Sendable, Equatable {
    case page(AlbumPage)
    case whole([Album])

    public init(from decoder: any Decoder) throws {
        if let page = try? AlbumPage(from: decoder) {
            self = .page(page)
        } else {
            self = .whole(try [Album](from: decoder))
        }
    }

    /// As a page: the whole list is one page holding every album.
    public var page: AlbumPage {
        switch self {
        case .page(let page): page
        case .whole(let albums): AlbumPage(albums: albums, total: albums.count, version: "")
        }
    }
}

/// POST /api/plays.
public struct Recorded: Codable, Sendable, Equatable {
    public var recorded: Int
}

/// POST /api/analysis/:kind.
public struct Queued: Codable, Sendable, Equatable {
    public var queued: Int
}

/// POST /api/settings/sources/:id/organize/undo.
public struct Restored: Codable, Sendable, Equatable {
    public var restored: Int
}

/// POST /api/playlists/holding: how many of the songs asked about each of the account's own playlists holds, each song
/// counted once, by playlist id (a JSON object's keys are strings). Playlists holding none are left out.
public struct PlaylistsHolding: Codable, Sendable, Equatable {
    public var holding: [String: Int]

    public init(holding: [String: Int]) {
        self.holding = holding
    }

    /// How many of the songs the playlist `id` holds: 0 when it holds none.
    public func count(_ id: Int) -> Int { holding[String(id)] ?? 0 }
}

/// GET /api/tracks/:id/lyrics: null when none were found.
public struct LyricsAnswer: Codable, Sendable, Equatable {
    public var lyrics: Lyrics?
}
