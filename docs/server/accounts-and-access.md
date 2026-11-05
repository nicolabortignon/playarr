# Accounts and access

Who may use a Playarr server, what each account may hear and change, and how a request proves who it is. The code lives in `apps/server/src/accounts/` (accounts, passwords, sessions, setup codes, rights), `apps/server/src/routes/auth.ts` and `routes/accounts.ts` (the routes), `apps/server/src/net.ts` (the home-network rules), `apps/server/src/cli.ts` (owner recovery), and `routes/server.ts` with `bonjour.ts` (how apps find the server). The web side (sign-in pages, the account switcher) is in [../web.md](../web.md).

A server is in one of two states:

1. **Setup mode**: no account has a password yet. Nobody signs in; every request acts as the owner, and the home network decides who may change settings.
2. **Set up**: at least one account has a password. Every `/api`, `/stream`, `/art` and `/transitions` request needs a session, except the few open routes below.

---

## 1. Accounts

An account (`accounts` table; `Accounts` in `accounts/accounts.ts`) has:

| field | what it is |
|---|---|
| `username` | 1 to 32 lowercase letters, digits, dots, dashes or underscores, starting with a letter or digit (`USERNAME` in `username.ts`). Matched in any case. |
| `name` | the display name, up to 40 characters, whitespace collapsed |
| `role` | `admin` or `member` |
| `canRequest` | may request albums through Lidarr ([discover-and-requests.md](discover-and-requests.md)) |
| `sources` | `null` for every source, or a list of source ids (`account_sources`) |
| `locked` | device settings a member may not change: `playback`, `appearance` (always empty for admins) |
| `password_hash` | scrypt, or none (the account can't sign in yet) |

The **owner** is the first admin by id: account 1 on every install that once had listener profiles, since accounts took over their ids (history, mixes and the ListenBrainz link stayed put).

Rules the service enforces, each with a 409:

- **There's always an admin.** The last admin can't be removed or made a member.
- **The last password stays.** The only account with a password can't have it reset or be removed (`keepAPassword`). With no password left the server would be back in setup mode, where every request is the owner's, from anywhere. Give another account a password first.
- **The owner comes first.** While in setup mode, accounts can't be created and passwords can't be reset: a setup code redeemed before the owner has a password would end setup mode and lock the owner out.

Removing an account deletes its plays, mixes, favorites, playlists and ListenBrainz token; its sessions, setup codes and source list go with it by foreign key.

### Passwords

`accounts/password.ts`. A password is 8 to 200 characters (`MIN_PASSWORD`), normalised to NFKC and hashed with scrypt (N = 16384, r = 8, p = 1, a 16-byte salt of its own, a 64-byte key), stored as `scrypt$N$r$p$salt$hash`. Checking compares in constant time. A sign-in with an unknown username is checked against a decoy hash, so it takes as long as a wrong password. Admins never choose anyone's password: they hand out setup codes.

### Setup codes

`accounts/setupCodes.ts`. A new account, or one whose password an admin reset, gets a one-time code to choose a password with:

- 8 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no 0/O or 1/I/L), typed in any case, with or without spaces or dashes;
- valid for 7 days, one per account (a new one replaces the old), stored as its SHA-256;
- with a link, `<origin>/redeem?code=…`. The origin is `PUBLIC_URL` when set; otherwise the address the visitor used, read from `X-Forwarded-Host`/`-Proto` only when the request came through a proxy trusted with `TRUST_PROXY` (`originOf` in `auth.ts`).

Redeeming (`POST /api/auth/redeem`) sets the password and signs the device in. A password that's too short leaves the code unused.

---

## 2. Sessions and tokens

`accounts/sessions.ts`. Signing in creates a session: a 256-bit random token (base64url) that the client keeps, stored on the server only as its SHA-256, so a copy of the database signs nobody in. Each session records the device name (up to 80 characters) and platform (up to 20, `web` by default), when it was made and when it was last seen (written at most once a minute). Sessions last until signed out; there's no expiry.

The token travels one of two ways (`credentials` in `auth.ts`):

- **The iOS app** sends `Authorization: Bearer <token>`.
- **The web** uses an HttpOnly cookie, `playarr_session` (`Path=/`, `SameSite=Lax`, `Max-Age` 400 days, `Secure` when the visitor came over HTTPS directly or per `X-Forwarded-Proto`). A cookie lets `<audio>`, `<img>` and the service worker work without adding headers.

Sign-in, setup and redeem all answer `{ token, account }` in the body and set no cookie. The web keeps each signed-in account's token in `localStorage['playarr.accounts']` and calls `POST /api/auth/switch` with one: the server checks it and makes it the cookie. That's how a shared device switches between accounts ("Not X? Listen as Y") without passwords, and why `/api/auth/switch` is open: it authenticates by the token in its body.

Each account sees its own devices and can sign any of them out; admins can for every account. A password reset signs the account out everywhere.

### Sign-in limits

`accounts/rateLimit.ts`. Failed sign-ins and failed setup codes count per client address: 10 failures within a sliding 15 minutes, then 429 ("Too many tries") until the oldest ages out. Only addresses count, never usernames, so guessing at someone's username can't lock them out, and a success doesn't clear the count. The address is `req.ip`: the visitor's own behind a proxy trusted with `TRUST_PROXY`, otherwise the socket's. The counts are in memory; a restart forgives.

---

## 3. Every request: the auth hook

`authHook` in `accounts/auth.ts` runs on every request and sets `req.auth`:

1. **Playarr's own header.** A `/api/` request that isn't a GET, HEAD or OPTIONS must carry `X-Playarr: 1` (`isFromApp` in `net.ts`), unless it has a Bearer token. Other websites can't add a custom header without a CORS preflight, which Playarr never grants, so a page someone opens can't make the server rescan, rematch or update. Otherwise 403.
2. **A valid session** (Bearer or cookie) makes `req.auth` that account and session.
3. **Setup mode**: no valid session needed; `req.auth` is the owner, with no session.
4. **Otherwise** `req.auth` is null, and a request under `/api/`, `/stream/`, `/art/` or `/transitions/` gets 401 (`{ setup: false }`), unless it's one of the open routes:

`GET /api/server`, `GET /api/health`, `POST /api/auth/sign-in`, `/redeem`, `/setup` and `/switch`. `/api/health` tells an unsigned caller whether Lidarr and the music files are reachable, but not the library's size. The web app's own pages are served to anyone.

---

## 4. Setup mode and the home network

Setup mode keeps a fresh install (or one upgraded from profiles) working as before until the owner claims it. In setup mode:

- **Listening is open from anywhere**: the catalog, streams, art, history, favorites, playlists and requests, all as the owner.
- **Admin actions** (settings, sources, analysis, accounts) and **your own settings** (ListenBrainz, history) need a request from the home network.
- **Claiming the server** (`POST /api/auth/setup`, the web's `/setup` page) needs the home network too: the owner picks a name, a username (409 if it's another account's, naming whose) and a password, becomes an admin, and is signed in. Once any account has a password, setup answers 409.

`isLocalRequest` in `net.ts` decides "the home network". All three must hold:

1. **A local address**: loopback, private (RFC 1918), link-local or unique-local, read from the socket, never from a header.
2. **No proxy in between**: any `X-Forwarded-For`, `Forwarded` or `X-Real-IP` header fails it, because behind a proxy the socket is the proxy's and the visitor could be anywhere.
3. **Addressed by IP or a local name**: the `Host` is an IP address, `localhost`, a bare name (`nas`), or ends in `.local`, `.lan`, `.home.arpa` or `.internal`. This stops DNS rebinding: a web page can't reach the server through a domain of its own pointed at a home address. Other names the household uses go in `LOCAL_HOSTNAMES` (comma-separated).

Once set up, the home network gives no rights: admins change settings from anywhere and members can't, wherever they are.

### Behind a reverse proxy

`TRUST_PROXY` (`trustProxyOf` in `config.ts`) tells Fastify which proxies to believe about the visitor's address, host and protocol: `true` (any; only when nothing else can reach the port), or comma-separated addresses, CIDRs, or `loopback`, `linklocal`, `uniquelocal`. A hop count is refused as a configuration error, since Fastify 5 would silently trust nobody. It affects sign-in limits, setup-code links and the cookie's `Secure` flag; it never makes a proxied request count as the home network. `PUBLIC_URL` is the address clients should use (setup links, `GET /api/server`).

---

## 5. Rights per route

`accounts/rights.ts` holds the helpers routes use:

| helper | set up | setup mode |
|---|---|---|
| `requireAdmin` | admins | home network |
| `requireOwn` | any signed-in account | home network |
| `requireCanRequest` | accounts that may request | everyone |
| `requireLocalSetup` | refused (409) | home network |

What that means in practice ([api.md](api.md) lists every route):

- **Admins** change settings: sources and folders, matching, requests, updates, how mixes are made, analysis, library refresh, rematching a file, and accounts. Members can read the source list (without connection settings) and Settings → Mixes, and get "Only an admin can change this".
- **Each account** has its own ListenBrainz link and listening history (`requireOwn`), favorites, playlists (private unless shared with the server), mixes, radio and stats.
- **Members** may rename themselves (only the name) and see and sign out their own devices.
- **Requests** need the account's "can request" right; Discover itself is open to every signed-in account.
- **File paths** in a song's metadata (Show metadata) appear only for admins.

### Each account's catalog

An account that hears only some sources gets a `LibraryView` of the catalog: the same catalog built from only the copies in those sources (`library.view(sources)` in `library/library.ts`). A song exists for it when it has a copy there, an album or artist when it has such a song, and a song's `fileId` is the best copy the account may hear. One view is made per distinct set of sources and shared by every account with that set; it rebuilds when the library changes. Routes narrow with `libraryOf(library, req)`, or `visibleRecordings` for lists of recording ids.

This covers the catalog and search, `/stream`, `/art`, `/transitions`, levels, mix maps and cue points, lyrics, metadata, favorites, playlists, mixes, radio, stats and Jump back in. Discover's search and its "in your library" links, and the list of requests, are the whole server's. How the catalog itself is built is in [sources-and-catalog.md](sources-and-catalog.md).

---

## 6. Owner recovery: `reset-password`

A forgotten password is reset on the server host, never over the network (`apps/server/src/cli.ts`):

```
docker exec playarr node server/dist/cli.js reset-password <username>   # Docker
node dist/cli.js reset-password <username>                               # native, in apps/server
pnpm -C apps/server reset-password <username>                            # development
```

It signs the account out everywhere and prints a setup code and link (on `PUBLIC_URL`, else `http://localhost:<PORT>`), valid for 7 days. The old password is cleared too, unless it's the only one on the server: clearing it would put the server back in setup mode until the code is used. It waits up to 5 s for a running server's writes rather than failing.

---

## 7. Finding the server

**`GET /api/server`** (open; `routes/server.ts`) answers which server this is: a UUID made once and kept in the database (`server.id`), so apps know it under any address; its name (`SERVER_NAME`, else the machine's name); the server version; `minAppVersion`, the oldest iOS app it works with (`MIN_APP_VERSION`, 1.0.0); `setup`; `publicUrl` when set; and, only while in setup mode, `ownerUsername` for the setup page to pre-fill.

**Bonjour** (`bonjour.ts`, through `bonjour-service`): after it starts listening, the server advertises itself on the home network as `_playarr._tcp` on its port, with TXT keys `id`, `v` (version), `name` (cut to fit 255 bytes) and `path` (`/`), so the iOS app lists it. It works for native installs and host-networked Docker; elsewhere the app takes an address. `BONJOUR=off` turns it off; a network without multicast only logs a warning.
