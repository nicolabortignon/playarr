extension API {
    /// What the player asks for: plays, levels, transitions, radio, mix maps and cue points.
    public enum Playback {
        public static func reportPlays(_ plays: [PlayReport]) -> Endpoint<Recorded> { Endpoint(.post, "/api/plays", body: ["plays": plays]) }

        /// Even volume: gains for up to 50 recordings.
        public static func levels(ids: [String]) -> Endpoint<[String: TrackLevel]> { Endpoint(.post, "/api/levels", body: ["ids": ids]) }

        public static func transition(_ request: TransitionRequest) -> Endpoint<TransitionAnswer> { Endpoint(.post, "/api/transitions", body: request) }

        /// Songs like the seeds, from the library.
        public static func radio(seeds: [String], exclude: [String] = [], count: Int = 25) -> Endpoint<[Track]> {
            Endpoint(.post, "/api/radio", body: RadioBody(seeds: seeds, exclude: exclude, count: count))
        }

        /// Mix maps for up to 50 recordings, with any cue points set by hand.
        public static func mixMaps(ids: [String]) -> Endpoint<[String: MixMapEntry]> { Endpoint(.post, "/api/mix-maps", body: ["ids": ids]) }

        public static func cues(recordingId: String) -> Endpoint<CuePoints> {
            Endpoint(.get, "/api/recordings/\(Endpoint<CuePoints>.segment(recordingId))/cues")
        }

        /// Replaces both mix points; nil clears one (the detected point is used again).
        public static func setCues(recordingId: String, mixIn: Double?, mixOut: Double?) -> Endpoint<CuePoints> {
            Endpoint(.put, "/api/recordings/\(Endpoint<CuePoints>.segment(recordingId))/cues", body: CuesBody(mixIn: mixIn, mixOut: mixOut))
        }

        private struct RadioBody: Encodable, Sendable {
            let seeds: [String]
            let exclude: [String]
            let count: Int
        }

        private struct CuesBody: Encodable, Sendable {
            let mixIn: Double?
            let mixOut: Double?

            func encode(to encoder: any Encoder) throws {
                var container = encoder.container(keyedBy: CodingKeys.self)
                try container.encode(mixIn, forKey: .mixIn) // null clears the point
                try container.encode(mixOut, forKey: .mixOut)
            }

            private enum CodingKeys: String, CodingKey { case mixIn, mixOut }
        }
    }
}

/// POST /api/transitions: `from` into `to` (catalog song ids).
public struct TransitionRequest: Encodable, Sendable, Equatable {
    public var from: Int
    public var to: Int
    public var mode: MixMode
    /// Where `from` is now, so the plan doesn't start in the past.
    public var position: Double?
    /// The files the player has, so the server never renders from another one.
    public var fromFileId: Int?
    public var toFileId: Int?
    /// The listener's fade length, for songs that can't be mixed on the beat.
    public var fade: Double?
    /// The queue plays the songs' album (songs of one album in order go straight on).
    public var albumQueue: Bool?
    /// The gains (dB) the player plays each song at.
    public var levels: TransitionAnswer.Ready.Levels?

    public init(from: Int, to: Int, mode: MixMode, position: Double? = nil, fromFileId: Int? = nil, toFileId: Int? = nil, fade: Double? = nil, albumQueue: Bool? = nil, levels: TransitionAnswer.Ready.Levels? = nil) {
        self.from = from
        self.to = to
        self.mode = mode
        self.position = position
        self.fromFileId = fromFileId
        self.toFileId = toFileId
        self.fade = fade
        self.albumQueue = albumQueue
        self.levels = levels
    }
}
