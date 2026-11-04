import Foundation

extension API {
    /// Made for you. Each call says the device's time zone: mixes follow the listener's clock.
    public enum Mixes {
        public static func list(timeZone: TimeZone = .current) -> Endpoint<[MixSummary]> { Endpoint(.get, "/api/mixes", query: tz(timeZone)) }

        public static func get(key: String, timeZone: TimeZone = .current) -> Endpoint<MixDetail> {
            Endpoint(.get, "/api/mixes/\(Endpoint<MixDetail>.segment(key))", query: tz(timeZone))
        }

        public static func regenerate(key: String, timeZone: TimeZone = .current) -> Endpoint<MixDetail> {
            Endpoint(.post, "/api/mixes/\(Endpoint<MixDetail>.segment(key))/regenerate", query: tz(timeZone))
        }

        /// Saves the mix as a playlist.
        public static func save(key: String, timeZone: TimeZone = .current) -> Endpoint<PlaylistDetail> {
            Endpoint(.post, "/api/mixes/\(Endpoint<PlaylistDetail>.segment(key))/save", query: tz(timeZone))
        }

        /// Feeling lucky: 15 songs put together now, from one that suits the hour; a new set every time.
        public static func lucky(timeZone: TimeZone = .current) -> Endpoint<LuckyMix> { Endpoint(.post, "/api/lucky", query: tz(timeZone)) }

        private static func tz(_ zone: TimeZone) -> [URLQueryItem] { [URLQueryItem(name: "tz", value: zone.identifier)] }
    }
}
