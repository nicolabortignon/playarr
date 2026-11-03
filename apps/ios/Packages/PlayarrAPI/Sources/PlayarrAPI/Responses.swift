/// An answer with no body (204), or one the caller doesn't need.
public struct NoContent: Decodable, Sendable, Equatable {
    public init() {}
    public init(from decoder: any Decoder) throws {}
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

/// GET /api/tracks/:id/lyrics: null when none were found.
public struct LyricsAnswer: Codable, Sendable, Equatable {
    public var lyrics: Lyrics?
}
