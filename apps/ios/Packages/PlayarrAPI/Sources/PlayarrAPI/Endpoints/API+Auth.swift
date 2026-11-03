extension API {
    /// Signing in and out. Sign-in, redeem and setup are sent without a token.
    public enum Auth {
        /// POST /api/auth/setup: claims a server in setup mode as its owner (home network only).
        public static func setup(username: String, name: String, password: String, device: DeviceInfo) -> Endpoint<SignInResponse> {
            Endpoint(.post, "/api/auth/setup", body: SetupBody(username: username, name: name, password: password, device: device.name, platform: device.platform))
        }

        /// POST /api/auth/sign-in.
        public static func signIn(username: String, password: String, device: DeviceInfo) -> Endpoint<SignInResponse> {
            Endpoint(.post, "/api/auth/sign-in", body: SignInBody(username: username, password: password, device: device.name, platform: device.platform))
        }

        /// POST /api/auth/redeem: a setup code from an admin, and the account's first password.
        public static func redeem(code: String, password: String, device: DeviceInfo) -> Endpoint<SignInResponse> {
            Endpoint(.post, "/api/auth/redeem", body: RedeemBody(code: code, password: password, device: device.name, platform: device.platform))
        }

        /// POST /api/auth/sign-out: ends this session.
        public static func signOut() -> Endpoint<NoContent> { Endpoint(.post, "/api/auth/sign-out") }

        /// GET /api/auth/me: the signed-in account.
        public static func me() -> Endpoint<Account> { Endpoint(.get, "/api/auth/me") }

        private struct SetupBody: Encodable, Sendable {
            let username, name, password, device, platform: String
        }

        private struct SignInBody: Encodable, Sendable {
            let username, password, device, platform: String
        }

        private struct RedeemBody: Encodable, Sendable {
            let code, password, device, platform: String
        }
    }
}
