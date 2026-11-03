# Native iOS app: conventions shared by every phase plan

Date: 2026-11-03. Companion to [the design](2026-11-03-ios-app-design.md) and [the parity checklist](2026-11-03-ios-parity-inventory.md). Phase plans are written in parallel; this file fixes the names, contracts and commands they share. When a plan needs to change something here, it changes this file in the same commit.

## Apple identifiers

| What | Value |
|---|---|
| Team | W1T LTD (organization), Team ID `M7ME2TS45S` |
| Bundle id | `me.tracklistme.playarr` (UI tests: `me.tracklistme.playarr.uitests`) |
| App name | Playarr |
| App Store Connect API key | Team key "Playarr CI", Admin. `.p8` at `~/.appstoreconnect/private_keys/AuthKey_<ASC_KEY_ID>.p8` |
| `.env` (repo root, gitignored) | `ASC_KEY_ID`, `ASC_ISSUER_ID`, `APPLE_TEAM_ID`, `IOS_BUNDLE_ID` |
| GitHub secrets | `ASC_KEY_ID`, `ASC_ISSUER_ID`, `APPLE_TEAM_ID`, `ASC_KEY_P8_BASE64` |
| Deployment target | iOS 26.0; Swift packages also declare macOS 26 so `swift test` runs on the Mac |
| Devices | iPhone and iPad (`TARGETED_DEVICE_FAMILY = 1,2`) |
| Capabilities | Background modes: audio, fetch (background downloads). Keychain sharing not needed (one app). |
| Encryption | `ITSAppUsesNonExemptEncryption = NO` |

## Repository layout

```
apps/ios/
├── project.yml               # XcodeGen spec (the .xcodeproj is generated, gitignored)
├── Makefile                  # all entry points; pnpm ios:* scripts call it
├── .tools/                   # gitignored: pinned XcodeGen downloaded by `make bootstrap`
├── Config/                   # Base.xcconfig (versions, team, bundle id), Info.plist, entitlements
├── Playarr/                  # app target: PlayarrApp.swift, AppDelegate (background URLSession), Assets.xcassets
├── Packages/
│   ├── PlayarrAPI/           # Sources/PlayarrAPI, Tests/PlayarrAPITests (+ Fixtures/)
│   ├── PlayarrPlayer/        # Sources/PlayarrPlayer, Tests/PlayarrPlayerTests
│   └── PlayarrUI/            # Sources/PlayarrUI, Tests/PlayarrUITests (view models)
├── PlayarrUITests/           # XCUITest target: flows + App Store screenshots
├── store/                    # App Store text (en-US), review notes, keywords
└── scripts/
    ├── asc.mjs               # App Store Connect API (JWT with node:crypto, no dependencies)
    ├── release.mjs           # beta and release flows on top of asc.mjs and xcodebuild
    └── gen-models.mjs        # TypeScript types → Swift Codable
```

Package dependencies: `PlayarrUI → PlayarrPlayer → PlayarrAPI`. The app target depends on `PlayarrUI`. No third-party packages.

## Commands

| Command | What it does |
|---|---|
| `pnpm ios:bootstrap` (`make -C apps/ios bootstrap`) | Download pinned XcodeGen to `.tools/`, generate `Playarr.xcodeproj` |
| `pnpm ios:test` | `swift test` in each package, then `xcodebuild test` (app + UI tests) on the simulator |
| `pnpm ios:build` | Simulator build |
| `pnpm ios:models` | Regenerate `PlayarrAPI/Sources/PlayarrAPI/Models.generated.swift` |
| `pnpm ios:setup` | One-time and idempotent: register the bundle id and capabilities via the API |
| `pnpm ios:beta` | Test, archive, upload, wait for processing, distribute to the internal TestFlight group |
| `pnpm ios:release` | App Store version, text, screenshots, submit for review |
| `pnpm ios:device` | Build and install on a paired iPhone with `xcrun devicectl` |

Simulator destination: `platform=iOS Simulator,name=iPhone 17 Pro` (iPad: `iPad Pro 13-inch (M5)`); scripts pick the first available matching device when the exact one is missing. `pnpm` is `corepack pnpm` in Claude's shell.

Versions: `MARKETING_VERSION` in `Config/Base.xcconfig` (starts at `1.0.0`, changed only for releases); `CURRENT_PROJECT_VERSION` = `git rev-list --count HEAD`, passed by the scripts.

## Server contracts added for the app (phase 1)

Shared TypeScript types go in `packages/shared/src/index.ts`:

```ts
export type AccountRole = 'admin' | 'member';
export interface Account {
  id: number;
  username: string;
  name: string;               // display name
  role: AccountRole;
  canRequest: boolean;
  sources: number[] | null;   // null = every source
  hasPassword: boolean;       // false until set up
}
export interface SessionInfo { id: number; device: string; platform: string; createdAt: string; lastSeenAt: string; current: boolean }
export interface ServerInfo { id: string; name: string; version: string; minAppVersion: string; setup: boolean }
export interface SignInResponse { token: string; account: Account }
export interface SetupCode { code: string; link: string; expiresAt: string }
```

Endpoints (JSON; errors are `{ error: string }` with a status code, as today):

| Method and path | Who | Body → answer |
|---|---|---|
| `GET /api/server` | anyone | → `ServerInfo` |
| `POST /api/auth/setup` | home network, setup mode only | `{ username, name, password, device, platform }` → `SignInResponse` (claims account 1 as admin) |
| `POST /api/auth/sign-in` | anyone (rate-limited) | `{ username, password, device, platform }` → `SignInResponse` |
| `POST /api/auth/redeem` | anyone (rate-limited) | `{ code, password, device, platform }` → `SignInResponse` (first password from a setup code) |
| `POST /api/auth/sign-out` | signed in | → 204 (ends this session) |
| `GET /api/auth/me` | signed in | → `Account` |
| `POST /api/auth/switch` | web only | `{ token }` → `Account`, sets the cookie to that session |
| `GET /api/accounts` | admin | → `Account[]` |
| `POST /api/accounts` | admin | `{ username, name, role, canRequest, sources }` → `{ account: Account, setup: SetupCode }` |
| `PATCH /api/accounts/:id` | admin (or self for `name`) | partial `Account` fields → `Account` |
| `DELETE /api/accounts/:id` | admin | → `Account[]` (never the last admin) |
| `POST /api/accounts/:id/reset` | admin | → `SetupCode` (signs out every session) |
| `GET /api/accounts/:id/sessions` | admin or self | → `SessionInfo[]` |
| `DELETE /api/accounts/:id/sessions/:sessionId` | admin or self | → `SessionInfo[]` |

- **Credentials**: `Authorization: Bearer <token>` (the app) or cookie `playarr_session` (the web, HttpOnly, SameSite=Lax, Secure when served over HTTPS). Both accepted on every route, including `/stream`, `/art`, `/transitions`.
- **Unauthenticated**: once any account has a password, every `/api`, `/stream`, `/art`, `/transitions` request without a valid session is answered 401 `{ error, setup: false }`, except `GET /api/server`, `/api/auth/sign-in|redeem|setup`, and `GET /api/health`. In setup mode, requests keep working as today (no sign-in yet) so an existing install isn't locked out before the owner claims it.
- **`X-Playarr: 1`** stays required on changes for cookie sessions; Bearer requests are exempt (no cookie, no cross-site risk). The app sends it anyway.
- **`X-Playarr-Profile`** is ignored once accounts exist; the session decides.
- **Tokens**: 32 random bytes, base64url; stored as SHA-256. Setup codes: 8 characters from an unambiguous alphabet, valid 7 days, single use; `link` is `<origin>/redeem?code=...` (the app also opens `playarr://redeem?server=<origin>&code=...`).
- **Bonjour**: `_playarr._tcp`, TXT `id=<server uuid>`, `v=<version>`, `name=<server name>`, `path=/`. Turned off with `BONJOUR=off`.

## Swift conventions

- Swift 6 language mode, strict concurrency. UI state is `@MainActor @Observable` classes; networking and audio I/O are actors or `Sendable` types.
- Naming mirrors the web where a thing exists there: `Track`, `Album`, `PlaylistDetail`, `TransitionPlan`, `MixMap`. Swift types generated from TypeScript keep the TypeScript names.
- Key types the phases build on (defined in the phase named):
  - `PlayarrAPI` (phase 2): `ServerRecord` (id, name, baseURL, accounts), `AccountRecord` (server id, account, token in Keychain), `ServerStore` (`@Observable`, the list and the active server and account), `APIClient` (actor; one per server and account; `func send<T: Decodable>(_ endpoint: Endpoint<T>) async throws -> T`), `Endpoint<T>` (method, path, query, body), `APIError` (`.unauthorized`, `.server(status, message)`, `.offline`, `.decoding`), `ServerBrowser` (Bonjour), `MediaURLs` (stream, art, transition URLs with sizes).
  - `PlayarrPlayer` (phase 3): `Player` (`@MainActor @Observable`: queue state, `play(_:startAt:source:)`, `next()`, `previous()`, `seek(to:)`, shuffle, repeat), `QueueState` (queue, order, pos, as in `apps/web/src/player/store.ts`), `AudioEngine` (owns AVAudioEngine and nodes), `Deck`, `TrackSource` (progressive download + decode), `LevelStore`, `PlayTracker`, `NowPlayingBridge`, `SleepTimer`.
  - `PlayarrUI` (phase 4 on): `AppModel` (root state), `QueryCache` (stale-while-revalidate on disk), `ImageCache`, `Theme` (accent colour).
- Tests: XCTest-free Swift Testing (`import Testing`, `@Test`, `#expect`) in packages; XCUITest for UI tests.
- Files: one primary type per file, named after it. No force unwraps outside tests.
- User-facing text follows the web's wording (copy it from the web component cited in the parity checklist).

## Commits

Each task commits on `main`, only that task's files, with a plain-English subject in the style of the history (no `feat:` prefixes) and the `Co-Authored-By: Claude <noreply@anthropic.com>` line. The pre-commit hook bumps the version; never bypass it. The user pushes.
