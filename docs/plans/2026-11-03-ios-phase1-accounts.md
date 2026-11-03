# Native iOS app, Phase 1: Server Accounts and Web Sign-in Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace listener profiles with server accounts (passwords, device sessions, rights, per-account library access, favorites and playlists), give the server an identity (`GET /api/server`, Bonjour), and give the web a sign-in page and account switcher, so the iOS app has every endpoint it needs and the web keeps working as it does today.

**Architecture:** A migration turns `profiles` into `accounts` (same ids) and adds sessions, setup codes and per-account sources. One Fastify `onRequest` hook resolves a Bearer token or the `playarr_session` cookie into `req.auth` (account, session, setup mode) and answers 401 once any account has a password; `requireAdmin` replaces `requireLocal` and falls back to the home-network rule while the server is in setup mode. Library access is a `LibraryView`: the same catalog built only from the copies in the account's sources, made once per snapshot per distinct source set and shared by every route (catalog, search, streams, art, transitions, levels, mixes, radio, stats, favorites, playlists).

**Tech Stack:** Node 25, TypeScript 7, Fastify 5, `node:sqlite`, `node:crypto` (scrypt, SHA-256), zod 4, vitest 5, `bonjour-service` (new, server only); React 19, react-router 7, TanStack Query 5, zustand 5, happy-dom and Testing Library for the web. pnpm via `corepack pnpm`.

**Design:** [2026-11-03-ios-app-design.md](2026-11-03-ios-app-design.md), sections 1 and 6 ("Phase 1"). Contracts (endpoints, types, cookie and header names, token and code rules, Bonjour TXT keys): [2026-11-03-ios-conventions.md](2026-11-03-ios-conventions.md). This plan covers rollout phase 1 only.

---

## Key decisions in this plan

**Library access is a view of the catalog, not a filter in each route.** `buildCatalog(rows)` already turns the stored rows into the artists, albums, tracks and files the API serves, choosing the best copy of each song among the enabled sources. Building it from the same rows with `rows.sources` narrowed to the account's sources gives exactly the rule the design asks for: a song exists when it has a copy in those sources, albums and artists only when they have such a song, search and Lidarr's album list only over them, and a song's `fileId` is the best copy the account may hear (so `/stream` never needs a second check). `LibraryView` is an abstract class holding every read method `Library` has today; `Library` extends it (the view of every source) and `library.view(sources)` returns a cached `SourceView` per distinct sorted source set that rebuilds its snapshot lazily when `library.version` changes. Every caller that already takes a `Library` keeps working, a route narrows with one call (`libraryOf(library, req)`), and accounts with the same sources share one snapshot. The cost is one extra catalog build per distinct source set after each library change (the same work a refresh already does), only when such an account asks.

Two consequences, both deliberate: loudness is measured for the full library's best copy, so an account whose only copy of a song is a different file gets that song unlevelled until it's measured (the levels route keeps comparing against the full library, so it doesn't remeasure in a loop); and Discover's "in your library" links (`artistId` on MusicBrainz results) are computed against the whole library, so a restricted account may see a link that answers 404. Discover is not one of the design's enforcement points and phase 8 revisits it.

**Setup mode keeps every install working.** Until some account has a password, the hook acts as the owner (the first admin, account 1 on every install that had profiles) for every request, and `requireAdmin` applies today's home-network rule. Nothing regresses before the owner claims the server at `/setup`. While in setup mode the server refuses to create accounts or reset passwords (409): a setup code redeemed before the owner has a password would end setup mode and lock the owner out.

**Routes run without accounts in tests.** `req.auth` is `undefined` when the hook isn't installed (existing route tests build bare Fastify apps), `null` for an unauthenticated request on an open route, and set otherwise. The rights helpers treat `undefined` like setup mode, so the existing tests (home vs. away addresses) keep passing unchanged, and `libraryOf` returns the full library.

**Cookies for the web, Bearer for the app.** The web keeps each signed-in account's token in `localStorage['playarr.accounts']` and calls `POST /api/auth/switch` to make one the HttpOnly cookie, so `<audio>`, `<img>` and the service worker work unchanged. `/api/auth/switch` authenticates by the token in its body and is therefore open (no session needed): that's how the web switches to another account after the current one's session ended. This is one addition to the conventions' list of unauthenticated exceptions.

**Bonjour through `bonjour-service`.** Pure JavaScript (on `multicast-dns`), MIT, TypeScript types included, maintained, and used by webpack-dev-server. `mdns` needs native builds against Avahi or dns_sd (not on the Alpine image); `@homebridge/ciao` is more complete (RFC probing and conflict handling) but larger than this needs. It runs only after `listen`, can be turned off with `BONJOUR=off`, and never throws into the server.

**No new dependency for passwords, sessions or rate limiting.** scrypt with a per-password salt and `timingSafeEqual` from `node:crypto`; tokens are 32 random bytes in base64url, stored as SHA-256; failed sign-ins and setup codes are counted in memory per client address only (10 per 15 minutes; Task 9b: a per-username lockout would let anyone keep the owner out by guessing at their username).

## Conventions

- Run everything from the repo root `/Users/bortignon/dev/playarr`. `pnpm` is `corepack pnpm` in Claude's shell.
- Server tests: `corepack pnpm -C apps/server test`. One file: `corepack pnpm -C apps/server exec vitest run src/accounts/accounts.test.ts`.
- Server typecheck: `corepack pnpm -C apps/server typecheck`.
- Web tests: `corepack pnpm -C apps/web test` (the smoke test skips itself without a running server). One file: `corepack pnpm -C apps/web exec vitest run src/lib/accounts.test.ts`.
- Web typecheck: `corepack pnpm -C apps/web typecheck`.
- Do not use `pnpm typecheck` at the root (it shells out to `pnpm`, not on PATH). `packages/shared` has no TypeScript of its own; its types are checked through the server and web typechecks.
- Imports use explicit `.ts` extensions on the server (`allowImportingTsExtensions`); the web imports without extensions, as it does today.
- Commit after every task, directly on `main`, only that task's files, plain-English subject, with the `Co-Authored-By` line. The pre-commit hook bumps the version and stages `package.json`; never bypass it. The user pushes.
- Test helpers: `freshDb()` and fixtures in `apps/server/src/catalog/testFixtures.ts`; this plan adds `apps/server/src/accounts/testAccess.ts` (`account()`, `actAs()`, `asAccount()`, `twoSources()`).
- Remote addresses in tests: `HOME = '192.168.1.20'`, `AWAY = '203.0.113.5'`; `inject` defaults to 127.0.0.1 with host `localhost:80`, which counts as the home network.

## Tasks

1. Accounts replace profiles in the database
2. Shared account types, password hashing and the sign-in rate limiter
3. The accounts service
4. Device sessions and setup codes
5. The auth hook and the rights helpers
6. Sign-in routes: setup, sign-in, redeem, sign-out, me, switch
7. Account admin routes
8. Wire accounts into the server; profiles go
9. Admins instead of the home network
9b. Setup-time answers: whose username it is, per-address rate limits, and setup links behind a proxy
10. Library views: each account's catalog
11. The catalog routes show each account its own library
12. Streams, artwork and transitions only for songs the account may hear
13. Mixes, radio, stats and Jump back in from the account's songs
14. Favorites per account
15. Playlists per account, private unless shared
16. Server identity: `GET /api/server`
17. Bonjour
18. Web: accounts on this device, auth API calls, 401 → sign in
19. Web: sign-in, setup-code and setup pages
20. Web: the account switcher on Home
21. Web: Settings → Accounts; profiles go
22. Web: whose playlist it is
23. Docs: README, PLAN.md, .env.example
24. Manual: claim the server and seed the App Review account

---

### Task 1: Accounts replace profiles in the database

**Files:**
- Create: `apps/server/src/accounts/username.ts`
- Test: `apps/server/src/accounts/username.test.ts` (create)
- Modify: `apps/server/src/db.ts` (lines 5-6 the list's type, append after line 246, lines 259-266 `migrate`)
- Modify: `apps/server/src/db.test.ts` (line 5-6 constants, lines 60-73, add a test)
- Modify: `apps/server/src/favorites.ts` (lines 31-39)
- Modify: `apps/server/src/catalog/store.ts` (lines 540-543)
- Modify: `apps/server/src/catalog/store.test.ts` (line 350)
- Modify (rename SQL only): `apps/server/src/profiles/profiles.ts`, `apps/server/src/profiles/profiles.test.ts`, `apps/server/src/mixes/history.ts`, `apps/server/src/mixes/mixes.ts`, `apps/server/src/mixes/stats.ts`, `apps/server/src/listenbrainz/scrobbler.ts`

The migration renames `profiles` to `accounts` keeping ids, and `profile_id` to `account_id` in `plays` and `mixes`, so history, mixes and the `listenbrainz` / `listenbrainz:<id>` settings keys stay with their owner with no data copied. Usernames need JavaScript (accents, uniqueness), so migrations may now be functions as well as SQL.

**Step 1: Write the failing tests**

```ts
// apps/server/src/accounts/username.test.ts
import { describe, expect, it } from 'vitest';
import { USERNAME, usernameFrom } from './username.ts';

describe('usernameFrom', () => {
  it('makes a lowercase username from a display name, numbered when taken', () => {
    expect(usernameFrom('Zoë B.', new Set())).toBe('zoe-b');
    expect(usernameFrom('  Nicola  ', new Set())).toBe('nicola');
    expect(usernameFrom('!!!', new Set())).toBe('listener');
    expect(usernameFrom('Home', new Set(['home', 'home-2']))).toBe('home-3');
    expect(usernameFrom('A'.repeat(50), new Set())).toHaveLength(28);
    for (const name of ['Zoë B.', 'Home', 'A'.repeat(50), '!!!']) expect(USERNAME.test(usernameFrom(name, new Set()))).toBe(true);
  });
});
```

In `apps/server/src/db.test.ts`, replace lines 5-6:

```ts
/** How many migrations ran before the one adding listener profiles. */
const PROFILES_MIGRATION = 15;
```

with:

```ts
/** How many migrations ran before the one adding listener profiles. */
const PROFILES_MIGRATION = 15;
/** How many migrations ran before the one turning profiles into accounts. */
const ACCOUNTS_MIGRATION = 18;
```

In the test `'gives the history and mixes so far to the first listener profile'`, change its second `migrate(db);` (line 65) to stop right after the profiles migration, since the tables it reads are renamed later:

```ts
    migrate(db, PROFILES_MIGRATION + 1);
```

Add this test at the end of the `describe('migrate', …)` block:

```ts
  it('turns profiles into accounts, keeping ids, history, mixes and ListenBrainz links', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, ACCOUNTS_MIGRATION);
    db.exec(`INSERT INTO profiles (id, name, created_at) VALUES (2, 'Zoë B.', 'now'), (3, 'home', 'now')`);
    db.exec(`INSERT INTO plays (recording_id, played_at, hour, weekday, seconds, profile_id) VALUES ('rec', '2026-01-01T00:00:00Z', 1, 1, 100, 2)`);
    db.exec(`INSERT INTO mixes (profile_id, key, period, data, generated_at) VALUES (2, 'vibes', 'p', '{}', 'now')`);
    db.exec(`INSERT INTO app_settings (key, value) VALUES ('listenbrainz:2', '{"enabled":true}')`);
    db.exec(`INSERT INTO favorites (recording_id, title, artist_name, album_title, created_at) VALUES ('rec', 'Angel', 'Massive Attack', 'Mezzanine', 'now')`);
    db.exec(`INSERT INTO playlists (name, created_at, updated_at) VALUES ('Road trip', 'now', 'now')`);
    migrate(db);
    expect(db.prepare('SELECT id, username, name, role, can_request, all_sources, password_hash FROM accounts ORDER BY id').all()).toEqual([
      { id: 1, username: 'home', name: 'Home', role: 'admin', can_request: 1, all_sources: 1, password_hash: null },
      { id: 2, username: 'zoe-b', name: 'Zoë B.', role: 'member', can_request: 1, all_sources: 1, password_hash: null },
      { id: 3, username: 'home-2', name: 'home', role: 'member', can_request: 1, all_sources: 1, password_hash: null },
    ]);
    expect(db.prepare('SELECT account_id FROM plays').get()).toEqual({ account_id: 2 });
    expect(db.prepare('SELECT account_id, key FROM mixes').get()).toEqual({ account_id: 2, key: 'vibes' });
    expect(db.prepare(`SELECT value FROM app_settings WHERE key = 'listenbrainz:2'`).get()).toEqual({ value: '{"enabled":true}' });
    // Favorites so far are the owner's; playlists so far stay visible to everyone.
    expect(db.prepare('SELECT account_id, recording_id FROM favorites').all()).toEqual([{ account_id: 1, recording_id: 'rec' }]);
    expect(db.prepare('SELECT account_id, shared FROM playlists').all()).toEqual([{ account_id: 1, shared: 1 }]);
    // Two accounts can favorite the same song; a username is taken once.
    expect(() =>
      db.exec(`INSERT INTO favorites (account_id, recording_id, title, artist_name, album_title, created_at) VALUES (2, 'rec', 'Angel', 'Massive Attack', 'Mezzanine', 'now')`),
    ).not.toThrow();
    expect(() => db.exec(`UPDATE accounts SET username = 'home' WHERE id = 2`)).toThrow();
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols('sessions')).toEqual(['id', 'account_id', 'token_hash', 'device', 'platform', 'created_at', 'last_seen_at']);
    expect(cols('setup_codes')).toEqual(['code_hash', 'account_id', 'expires_at', 'created_at']);
    expect(cols('account_sources')).toEqual(['account_id', 'source_id']);
  });
```

**Step 2: Run them to see them fail**

```bash
corepack pnpm -C apps/server exec vitest run src/accounts/username.test.ts src/db.test.ts
```

Expected: FAIL: `username.ts` can't be resolved; the new migration test fails with `no such table: accounts`.

**Step 3: Implement**

```ts
// apps/server/src/accounts/username.ts
/** A username: 1 to 32 lowercase letters, digits, dots, dashes or underscores, starting with a letter or digit. */
export const USERNAME = /^[a-z0-9][a-z0-9._-]{0,31}$/;

/** A free username made from a display name: "Zoë B." → "zoe-b", or "zoe-b-2" when that's taken. */
export function usernameFrom(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, '')
      .slice(0, 28)
      .replace(/-+$/, '') || 'listener';
  let candidate = base;
  for (let n = 2; taken.has(candidate); n++) candidate = `${base}-${n}`;
  return candidate;
}
```

In `apps/server/src/db.ts`, add the import after line 3 (`import { DatabaseSync } from 'node:sqlite';`):

```ts
import { usernameFrom } from './accounts/username.ts';
```

Replace lines 5-6:

```ts
/** Ordered schema migrations; each runs once, tracked with SQLite's user_version. */
const MIGRATIONS = [
```

with:

```ts
/** SQL, or a function for the steps SQL can't do alone. */
type Migration = string | ((db: DatabaseSync) => void);

/** Ordered schema migrations; each runs once, tracked with SQLite's user_version. */
const MIGRATIONS: Migration[] = [
```

After the `track_loudness` migration (the entry ending at line 246 with ``CREATE INDEX track_loudness_by_file ON track_loudness (file_id);`,``), add the new entry before the closing `];`:

```ts
  // Accounts replace listener profiles, keeping their ids (plays, mixes and ListenBrainz links stay
  // theirs). See accountsMigration.
  accountsMigration,
```

Replace `migrate` (lines 258-267) with:

```ts
/** Run the migrations this database hasn't had yet (up to `upTo`, for tests of a migration). */
export function migrate(db: DatabaseSync, upTo = MIGRATIONS.length) {
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let i = version; i < upTo; i++) {
    const step = MIGRATIONS[i]!;
    db.exec('BEGIN');
    try {
      if (typeof step === 'string') db.exec(step);
      else step(db);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

/**
 * Profiles become accounts: a username from each profile's name, a password once set up, a role (the
 * first profile is the owner, an admin), the right to request albums, and which sources it may hear
 * (all, or those in account_sources). Favorites and playlists get an owner: the owner has the favorites
 * so far, and the playlists so far stay visible to everyone by being shared. Sessions (tokens stored as
 * SHA-256) and setup codes get tables of their own.
 */
function accountsMigration(db: DatabaseSync) {
  db.exec(`
    ALTER TABLE profiles RENAME TO accounts;
    ALTER TABLE accounts ADD COLUMN username TEXT;
    ALTER TABLE accounts ADD COLUMN password_hash TEXT;
    ALTER TABLE accounts ADD COLUMN role TEXT NOT NULL DEFAULT 'member';
    ALTER TABLE accounts ADD COLUMN can_request INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE accounts ADD COLUMN all_sources INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE plays RENAME COLUMN profile_id TO account_id;
    ALTER TABLE mixes RENAME COLUMN profile_id TO account_id;
    DROP INDEX plays_by_profile;
    CREATE INDEX plays_by_account ON plays (account_id, played_at);
  `);
  // Every install has had a profile since they were added; a database without one gets the owner back.
  if (!db.prepare('SELECT 1 FROM accounts').get()) {
    db.prepare(`INSERT INTO accounts (id, name, created_at) VALUES (1, 'Home', ?)`).run(new Date().toISOString());
  }
  const rows = db.prepare('SELECT id, name FROM accounts ORDER BY id').all() as { id: number; name: string }[];
  const taken = new Set<string>();
  const setUsername = db.prepare('UPDATE accounts SET username = ? WHERE id = ?');
  for (const { id, name } of rows) {
    const username = usernameFrom(name, taken);
    taken.add(username);
    setUsername.run(username, id);
  }
  const owner = rows[0]!.id;
  db.prepare(`UPDATE accounts SET role = 'admin' WHERE id = ?`).run(owner);
  db.exec(`
    CREATE UNIQUE INDEX accounts_by_username ON accounts (username);
    CREATE TABLE favorites_by_account (
      account_id   INTEGER NOT NULL,
      recording_id TEXT NOT NULL,
      track_id     INTEGER,
      title        TEXT NOT NULL,
      artist_name  TEXT NOT NULL,
      album_title  TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      PRIMARY KEY (account_id, recording_id)
    );
  `);
  db.prepare(
    `INSERT INTO favorites_by_account (account_id, recording_id, track_id, title, artist_name, album_title, created_at)
     SELECT ?, recording_id, track_id, title, artist_name, album_title, created_at FROM favorites`,
  ).run(owner);
  db.exec(`
    DROP TABLE favorites;
    ALTER TABLE favorites_by_account RENAME TO favorites;
    ALTER TABLE playlists ADD COLUMN account_id INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE playlists ADD COLUMN shared INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE account_sources (
      account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
      source_id  INTEGER NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
      PRIMARY KEY (account_id, source_id)
    );
    CREATE TABLE sessions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id   INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
      token_hash   TEXT NOT NULL UNIQUE,
      device       TEXT NOT NULL,
      platform     TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
    CREATE INDEX sessions_by_account ON sessions (account_id);
    CREATE TABLE setup_codes (
      code_hash  TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  db.prepare('UPDATE playlists SET account_id = ?, shared = 1').run(owner);
}
```

Rename the columns and table in the SQL of the code that reads them (nothing else changes yet):

```bash
perl -pi -e 's/\bprofile_id\b/account_id/g' apps/server/src/mixes/history.ts apps/server/src/mixes/mixes.ts apps/server/src/mixes/stats.ts apps/server/src/listenbrainz/scrobbler.ts apps/server/src/profiles/profiles.ts apps/server/src/profiles/profiles.test.ts
perl -pi -e 's/\b(FROM|INTO|UPDATE) profiles\b/$1 accounts/g' apps/server/src/profiles/profiles.ts
```

In `apps/server/src/favorites.ts`, replace the body of `add` (lines 31-39):

```ts
  add(track: Track) {
    this.db
      .prepare(
        `INSERT INTO favorites (recording_id, track_id, title, artist_name, album_title, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (recording_id) DO NOTHING`,
      )
      .run(track.recordingId, track.id, track.title, track.artistName, track.albumTitle, new Date().toISOString());
  }
```

with (account 1 until task 14 makes favorites per account):

```ts
  add(track: Track) {
    this.db
      .prepare(
        `INSERT INTO favorites (account_id, recording_id, track_id, title, artist_name, album_title, created_at)
         VALUES (1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id, recording_id) DO NOTHING`,
      )
      .run(track.recordingId, track.id, track.title, track.artistName, track.albumTitle, new Date().toISOString());
  }
```

In `apps/server/src/catalog/store.ts`, the favorites follow a song that gets its real id (lines 541-542); keep each favorite's owner:

```ts
        `INSERT OR IGNORE INTO favorites (recording_id, track_id, title, artist_name, album_title, created_at)
         SELECT ?, track_id, title, artist_name, album_title, created_at FROM favorites WHERE recording_id = ?`,
```

becomes:

```ts
        `INSERT OR IGNORE INTO favorites (account_id, recording_id, track_id, title, artist_name, album_title, created_at)
         SELECT account_id, ?, track_id, title, artist_name, album_title, created_at FROM favorites WHERE recording_id = ?`,
```

In `apps/server/src/catalog/store.test.ts` line 350:

```ts
    db.prepare('INSERT INTO favorites (recording_id, title, artist_name, album_title, created_at) VALUES (?, ?, ?, ?, ?)').run('local:rec-1', 'Angel', 'Massive Attack', 'Mezzanine', now);
```

becomes:

```ts
    db.prepare('INSERT INTO favorites (account_id, recording_id, title, artist_name, album_title, created_at) VALUES (1, ?, ?, ?, ?, ?)').run('local:rec-1', 'Angel', 'Massive Attack', 'Mezzanine', now);
```

**Step 4: Run the tests again**

```bash
corepack pnpm -C apps/server exec vitest run src/accounts/username.test.ts src/db.test.ts
corepack pnpm -C apps/server test
corepack pnpm -C apps/server typecheck
```

Expected: PASS everywhere (the profiles tests still pass: profiles are now rows of `accounts`).

*As executed:* `migrate` rolls back a step that throws (a function migration does several statements, so a failure must not leave a half-migrated database). Checked on a database built with the previous `db.ts` (profiles, plays, mixes, favorites, playlists, ListenBrainz keys), copied, then opened with this one: ids, history and links kept, `foreign_key_check` empty, `integrity_check` ok, reopening a no-op. Baseline note: `src/analysis/beatModel*.test.ts` (3 tests) and the typecheck of `beatModel.ts` fail in a checkout whose `node_modules` lacks `onnxruntime-web` (declared in package.json); that's the environment, not this plan.

**Step 5: Commit**

```bash
git add apps/server/src/accounts/username.ts apps/server/src/accounts/username.test.ts apps/server/src/db.ts apps/server/src/db.test.ts apps/server/src/favorites.ts apps/server/src/catalog/store.ts apps/server/src/catalog/store.test.ts apps/server/src/profiles/profiles.ts apps/server/src/profiles/profiles.test.ts apps/server/src/mixes/history.ts apps/server/src/mixes/mixes.ts apps/server/src/mixes/stats.ts apps/server/src/listenbrainz/scrobbler.ts
git commit -m "$(cat <<'EOF'
Turn profiles into accounts in the database, keeping their ids

Usernames come from the profile names and the first profile becomes the
owner, an admin. Favorites and playlists get an owner (playlists so far
are shared with everyone), and sessions, setup codes and each account's
sources get tables of their own.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Shared account types, password hashing and the sign-in rate limiter

**Files:**
- Modify: `packages/shared/src/index.ts` (append after the `Profile` interface, line 858)
- Create: `apps/server/src/accounts/password.ts`, `apps/server/src/accounts/rateLimit.ts`
- Test: `apps/server/src/accounts/password.test.ts`, `apps/server/src/accounts/rateLimit.test.ts` (create)

**Step 1: Write the failing tests**

```ts
// apps/server/src/accounts/password.test.ts
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.ts';

describe('passwords', () => {
  it('hashes each password with a salt of its own, and checks it', async () => {
    const a = await hashPassword('correct horse');
    const b = await hashPassword('correct horse');
    expect(a).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(a).not.toBe(b);
    expect(await verifyPassword('correct horse', a)).toBe(true);
    expect(await verifyPassword('Correct horse', a)).toBe(false);
  });

  it('refuses anything it can’t read', async () => {
    const a = await hashPassword('correct horse');
    expect(await verifyPassword('correct horse', 'garbage')).toBe(false);
    expect(await verifyPassword('correct horse', a.replace('$16384$', '$3$'))).toBe(false);
    expect(await verifyPassword('correct horse', a.slice(0, -8))).toBe(false);
  });
});
```

```ts
// apps/server/src/accounts/rateLimit.test.ts
import { describe, expect, it } from 'vitest';
import { RateLimiter } from './rateLimit.ts';

describe('RateLimiter', () => {
  it('refuses a key after too many failures, until they are old enough', () => {
    let now = 0;
    const limiter = new RateLimiter(3, 1000, () => now);
    const keys = ['ip:1.2.3.4', 'user:sam'];
    for (let i = 0; i < 3; i++) {
      expect(limiter.allows(keys)).toBe(true);
      limiter.fail(keys);
      now += 100;
    }
    expect(limiter.allows(keys)).toBe(false);
    expect(limiter.allows(['user:sam'])).toBe(false);
    expect(limiter.allows(['user:zoe'])).toBe(true);
    now = 1001; // the first failure has aged out
    expect(limiter.allows(keys)).toBe(true);
  });

  it('forgets a key that is cleared', () => {
    const limiter = new RateLimiter(1, 1000, () => 0);
    limiter.fail(['user:sam']);
    expect(limiter.allows(['user:sam'])).toBe(false);
    limiter.clear('user:sam');
    expect(limiter.allows(['user:sam'])).toBe(true);
  });
});
```

**Step 2: Run them to see them fail**

```bash
corepack pnpm -C apps/server exec vitest run src/accounts/password.test.ts src/accounts/rateLimit.test.ts
```

Expected: FAIL: modules not found.

**Step 3: Implement**

Append to `packages/shared/src/index.ts`, after the `Profile` interface (it goes in task 21):

```ts
// ── Accounts ────────────────────────────────────────────────────────────────

export type AccountRole = 'admin' | 'member';

/** Someone who signs in to this server: their history, mixes, favorites and playlists are their own. */
export interface Account {
  id: number;
  username: string;
  name: string; // display name
  role: AccountRole;
  canRequest: boolean;
  sources: number[] | null; // null = every source
  hasPassword: boolean; // false until set up
}

/** A device signed in to an account. */
export interface SessionInfo {
  id: number;
  device: string;
  platform: string;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

/** GET /api/server: which server this is, for apps finding and remembering it. */
export interface ServerInfo {
  id: string;
  name: string;
  version: string;
  minAppVersion: string;
  setup: boolean;
}

export interface SignInResponse {
  token: string;
  account: Account;
}

/** A one-time code (and link) for choosing a first password. */
export interface SetupCode {
  code: string;
  link: string;
  expiresAt: string;
}

/** POST /api/accounts: the new account, with the code its person chooses a password with. */
export interface CreatedAccount {
  account: Account;
  setup: SetupCode;
}
```

*As executed:* `CreatedAccount` added here (the conventions name it; task 7's route answers with it).

```ts
// apps/server/src/accounts/password.ts
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/** scrypt's cost: 16 MiB and tens of milliseconds a try: slow for guessing, quick for signing in. */
const COST = { N: 16384, r: 8, p: 1 };
const KEY_BYTES = 64;
const SALT_BYTES = 16;

type Cost = typeof COST;

function derive(password: string, salt: Buffer, cost: Cost): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, KEY_BYTES, { ...cost, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

/** `scrypt$N$r$p$salt$hash` (base64), with a salt of its own. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, COST);
  return ['scrypt', COST.N, COST.r, COST.p, salt.toString('base64'), key.toString('base64')].join('$');
}

/** Whether `password` is the one hashed in `stored`, compared in constant time; false for anything unreadable. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const cost = { N: Number(n), r: Number(r), p: Number(p) };
  const expected = Buffer.from(hash, 'base64');
  if (![cost.N, cost.r, cost.p].every(Number.isInteger) || expected.length !== KEY_BYTES) return false;
  const key = await derive(password, Buffer.from(salt, 'base64'), cost).catch(() => null);
  return !!key && timingSafeEqual(key, expected);
}
```

```ts
// apps/server/src/accounts/rateLimit.ts
/**
 * Failed tries per key (an address, a username) within a sliding window: past `max`, a key is refused
 * until its oldest failure is `windowMs` old. In memory: a restart forgives, which is fine at home.
 */
export class RateLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly max = 10,
    private readonly windowMs = 15 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** True when none of the keys has used up its tries. */
  allows(keys: string[]): boolean {
    return keys.every((key) => this.recent(key).length < this.max);
  }

  fail(keys: string[]) {
    const at = this.now();
    for (const key of keys) this.failures.set(key, [...this.recent(key), at]);
  }

  clear(key: string) {
    this.failures.delete(key);
  }

  private recent(key: string): number[] {
    const from = this.now() - this.windowMs;
    const list = (this.failures.get(key) ?? []).filter((at) => at > from);
    if (list.length) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }
}
```

**Step 4: Run the tests again**

```bash
corepack pnpm -C apps/server exec vitest run src/accounts/password.test.ts src/accounts/rateLimit.test.ts
corepack pnpm -C apps/server typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/shared/src/index.ts apps/server/src/accounts/password.ts apps/server/src/accounts/password.test.ts apps/server/src/accounts/rateLimit.ts apps/server/src/accounts/rateLimit.test.ts
git commit -m "$(cat <<'EOF'
Add account types, scrypt password hashing and a sign-in rate limiter

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: The accounts service

**Files:**
- Create: `apps/server/src/accounts/accounts.ts`
- Test: `apps/server/src/accounts/accounts.test.ts` (create)

**Step 1: Write the failing test**

```ts
// apps/server/src/accounts/accounts.test.ts
import { describe, expect, it } from 'vitest';
import { CatalogStore } from '../catalog/store.ts';
import { freshDb } from '../catalog/testFixtures.ts';
import { Accounts, type AccountInput } from './accounts.ts';

function setup() {
  const db = freshDb();
  const store = new CatalogStore(db);
  return { db, store, accounts: new Accounts(db) };
}

const member: AccountInput = { username: 'sam', name: 'Sam', role: 'member', canRequest: false, sources: null };

describe('Accounts', () => {
  it('starts with the owner, an admin without a password: setup mode', () => {
    const { accounts } = setup();
    expect(accounts.list()).toEqual([{ id: 1, username: 'home', name: 'Home', role: 'admin', canRequest: true, sources: null, hasPassword: false }]);
    expect(accounts.owner().id).toBe(1);
    expect(accounts.ids()).toEqual([1]);
    expect(accounts.setupMode()).toBe(true);
  });

  it('creates accounts with their library access, and checks usernames, names and sources', () => {
    const { accounts, store } = setup();
    const cc = store.addSource('folder', 'Creative Commons');
    const sam = accounts.create({ ...member, username: ' Sam ', name: '  Sam   Smith ', sources: [cc] });
    expect(sam).toEqual({ id: 2, username: 'sam', name: 'Sam Smith', role: 'member', canRequest: false, sources: [cc], hasPassword: false });
    expect(() => accounts.create({ ...member, username: 'SAM' })).toThrow('That username is taken');
    expect(() => accounts.create({ ...member, username: 'no spaces' })).toThrow(/username/);
    expect(() => accounts.create({ ...member, username: 'zoe', name: ' ' })).toThrow('An account needs a name');
    expect(() => accounts.create({ ...member, username: 'zoe', sources: [999] })).toThrow('Unknown source');
    expect(accounts.update(sam.id, { sources: null }).sources).toBeNull();
    expect(accounts.update(sam.id, { sources: [cc], canRequest: true, name: 'Sam S.' })).toMatchObject({ sources: [cc], canRequest: true, name: 'Sam S.' });
    // A source removed in Settings leaves the accounts that had it.
    store.removeSource(cc);
    expect(accounts.get(sam.id)!.sources).toEqual([]);
  });

  it('always keeps an admin', () => {
    const { accounts } = setup();
    expect(() => accounts.update(1, { role: 'member' })).toThrow('There has to be an admin');
    expect(() => accounts.remove(1)).toThrow('There has to be an admin');
    const zoe = accounts.create({ ...member, username: 'zoe', role: 'admin' });
    accounts.remove(1);
    expect(accounts.list().map((a) => a.id)).toEqual([zoe.id]);
    expect(accounts.owner().id).toBe(zoe.id);
  });

  it('checks passwords, and leaves setup mode once one is set', async () => {
    const { accounts } = setup();
    await expect(accounts.setPassword(1, 'short')).rejects.toThrow('at least 8');
    await accounts.setPassword(1, 'correct horse');
    expect(accounts.setupMode()).toBe(false);
    expect(accounts.get(1)!.hasPassword).toBe(true);
    expect(await accounts.verify(' HOME ', 'correct horse')).toMatchObject({ id: 1 });
    expect(await accounts.verify('home', 'wrong horse')).toBeNull();
    expect(await accounts.verify('nobody', 'correct horse')).toBeNull();
    accounts.clearPassword(1);
    expect(accounts.setupMode()).toBe(true);
    expect(await accounts.verify('home', 'correct horse')).toBeNull();
  });

  it('removes an account with its history, mixes, favorites, playlists, ListenBrainz link and sessions', () => {
    const { db, accounts } = setup();
    const sam = accounts.create(member);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO plays (recording_id, played_at, hour, weekday, seconds, account_id) VALUES ('rec', ?, 1, 1, 100, ?)`).run(now, sam.id);
    db.prepare(`INSERT INTO mixes (account_id, key, period, data, generated_at) VALUES (?, 'vibes', 'p', '{}', ?)`).run(sam.id, now);
    db.prepare(`INSERT INTO favorites (account_id, recording_id, title, artist_name, album_title, created_at) VALUES (?, 'rec', 'A', 'B', 'C', ?)`).run(sam.id, now);
    db.prepare(`INSERT INTO playlists (name, created_at, updated_at, account_id) VALUES ('Mine', ?, ?, ?)`).run(now, now, sam.id);
    db.prepare(`INSERT INTO app_settings (key, value) VALUES (?, '{}')`).run(`listenbrainz:${sam.id}`);
    db.prepare(`INSERT INTO sessions (account_id, token_hash, device, platform, created_at, last_seen_at) VALUES (?, 'h', 'Mac', 'web', ?, ?)`).run(sam.id, now, now);
    accounts.remove(sam.id);
    for (const table of ['plays', 'mixes', 'favorites', 'playlists', 'sessions']) {
      expect((db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE account_id = ?`).get(sam.id) as { n: number }).n).toBe(0);
    }
    expect(db.prepare(`SELECT 1 FROM app_settings WHERE key = ?`).get(`listenbrainz:${sam.id}`)).toBeUndefined();
    expect(() => accounts.remove(sam.id)).toThrow('No such account');
  });
});
```

**Step 2: Run it to see it fail**

```bash
corepack pnpm -C apps/server exec vitest run src/accounts/accounts.test.ts
```

Expected: FAIL: `./accounts.ts` not found.

**Step 3: Implement**

```ts
// apps/server/src/accounts/accounts.ts
import type { Account, AccountRole } from '@playarr/shared';
import type { DatabaseSync } from 'node:sqlite';
import { listenBrainzKey } from '../listenbrainz/scrobbler.ts';
import { hashPassword, verifyPassword } from './password.ts';
import { USERNAME } from './username.ts';

export class AccountError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface AccountInput {
  username: string;
  name: string;
  role: AccountRole;
  canRequest: boolean;
  /** null: every source. */
  sources: number[] | null;
}

interface Row {
  id: number;
  username: string | null;
  name: string;
  role: AccountRole;
  can_request: number;
  all_sources: number;
  password_hash: string | null;
}

const COLUMNS = 'id, username, name, role, can_request, all_sources, password_hash';
export const MIN_PASSWORD = 8;

/** Throws unless the password is long enough (and not absurdly long). */
export function checkPassword(password: string) {
  if (password.length < MIN_PASSWORD) throw new AccountError(`A password needs at least ${MIN_PASSWORD} characters`);
  if (password.length > 200) throw new AccountError('That password is too long');
}

/** Checked against when a username doesn't exist, so a wrong username takes as long as a wrong password. */
let decoy: Promise<string> | null = null;

/** Who can sign in to this server, with their rights and library access. */
export class Accounts {
  /** Whether any account has a password; asked on every request, so remembered until one changes. */
  private passwords: boolean | null = null;

  constructor(private readonly db: DatabaseSync) {}

  list(): Account[] {
    return (this.db.prepare(`SELECT ${COLUMNS} FROM accounts ORDER BY id`).all() as unknown as Row[]).map((r) => this.toAccount(r));
  }

  ids(): number[] {
    return (this.db.prepare('SELECT id FROM accounts ORDER BY id').all() as { id: number }[]).map((r) => r.id);
  }

  get(id: number): Account | undefined {
    const row = this.row(id);
    return row && this.toAccount(row);
  }

  /** The owner: the first admin (account 1, the old "Home" profile, on every install that had profiles). */
  owner(): Account {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM accounts ORDER BY role = 'admin' DESC, id LIMIT 1`).get() as unknown as Row | undefined;
    if (!row) throw new AccountError('There are no accounts', 500);
    return this.toAccount(row);
  }

  /** Setup mode: no account has a password yet, so nobody signs in and the home network decides. */
  setupMode(): boolean {
    this.passwords ??= !!this.db.prepare('SELECT 1 FROM accounts WHERE password_hash IS NOT NULL LIMIT 1').get();
    return !this.passwords;
  }

  create(input: AccountInput): Account {
    const username = this.username(input.username);
    const name = cleanName(input.name);
    const sources = this.checkSources(input.sources);
    return this.transaction(() => {
      const { lastInsertRowid } = this.db
        .prepare('INSERT INTO accounts (username, name, role, can_request, all_sources, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(username, name, input.role, input.canRequest ? 1 : 0, sources === null ? 1 : 0, new Date().toISOString());
      const id = Number(lastInsertRowid);
      this.setSources(id, sources);
      return this.get(id)!;
    });
  }

  update(id: number, patch: Partial<AccountInput>): Account {
    const row = this.row(id);
    if (!row) throw new AccountError('No such account', 404);
    const username = patch.username === undefined ? row.username : this.username(patch.username, id);
    const name = patch.name === undefined ? row.name : cleanName(patch.name);
    const role = patch.role ?? row.role;
    if (row.role === 'admin' && role !== 'admin' && this.admins() === 1) throw new AccountError('There has to be an admin', 409);
    const canRequest = patch.canRequest === undefined ? row.can_request : patch.canRequest ? 1 : 0;
    const sources = patch.sources === undefined ? undefined : this.checkSources(patch.sources);
    return this.transaction(() => {
      this.db.prepare('UPDATE accounts SET username = ?, name = ?, role = ?, can_request = ? WHERE id = ?').run(username, name, role, canRequest, id);
      if (sources !== undefined) {
        this.db.prepare('UPDATE accounts SET all_sources = ? WHERE id = ?').run(sources === null ? 1 : 0, id);
        this.setSources(id, sources);
      }
      return this.get(id)!;
    });
  }

  /** Remove an account with everything that's only theirs; never the last admin. */
  remove(id: number) {
    const row = this.row(id);
    if (!row) throw new AccountError('No such account', 404);
    if (row.role === 'admin' && this.admins() === 1) throw new AccountError('There has to be an admin', 409);
    this.transaction(() => {
      // Playlist songs go with their playlists, sessions, setup codes and sources with the account (foreign keys).
      for (const table of ['plays', 'mixes', 'favorites', 'playlists']) this.db.prepare(`DELETE FROM ${table} WHERE account_id = ?`).run(id);
      this.db.prepare('DELETE FROM app_settings WHERE key = ?').run(listenBrainzKey(id));
      this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    });
    this.passwords = null;
  }

  async setPassword(id: number, password: string) {
    checkPassword(password);
    if (!this.row(id)) throw new AccountError('No such account', 404);
    const hash = await hashPassword(password);
    this.db.prepare('UPDATE accounts SET password_hash = ? WHERE id = ?').run(hash, id);
    this.passwords = true;
  }

  clearPassword(id: number) {
    this.db.prepare('UPDATE accounts SET password_hash = NULL WHERE id = ?').run(id);
    this.passwords = null;
  }

  /** The account these credentials sign in to, or null. */
  async verify(username: string, password: string): Promise<Account | null> {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM accounts WHERE username = ?`).get(username.trim().toLowerCase()) as unknown as Row | undefined;
    if (!row?.password_hash) {
      await verifyPassword(password, await (decoy ??= hashPassword('no such account')));
      return null;
    }
    return (await verifyPassword(password, row.password_hash)) ? this.toAccount(row) : null;
  }

  private row(id: number): Row | undefined {
    return this.db.prepare(`SELECT ${COLUMNS} FROM accounts WHERE id = ?`).get(id) as unknown as Row | undefined;
  }

  private admins(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM accounts WHERE role = 'admin'`).get() as { n: number }).n;
  }

  private username(raw: string, except?: number): string {
    const username = raw.trim().toLowerCase();
    if (!USERNAME.test(username)) throw new AccountError('A username is 1 to 32 lowercase letters, digits, dots, dashes or underscores');
    const taken = this.db.prepare('SELECT id FROM accounts WHERE username = ?').get(username) as { id: number } | undefined;
    if (taken && taken.id !== except) throw new AccountError('That username is taken', 409);
    return username;
  }

  private checkSources(sources: number[] | null): number[] | null {
    if (sources === null) return null;
    const ids = [...new Set(sources)];
    const known = new Set((this.db.prepare('SELECT id FROM sources').all() as { id: number }[]).map((r) => r.id));
    if (ids.some((id) => !known.has(id))) throw new AccountError('Unknown source');
    return ids;
  }

  private setSources(id: number, sources: number[] | null) {
    this.db.prepare('DELETE FROM account_sources WHERE account_id = ?').run(id);
    const insert = this.db.prepare('INSERT INTO account_sources (account_id, source_id) VALUES (?, ?)');
    for (const source of sources ?? []) insert.run(id, source);
  }

  private toAccount(row: Row): Account {
    const sources = row.all_sources
      ? null
      : (this.db.prepare('SELECT source_id FROM account_sources WHERE account_id = ? ORDER BY source_id').all(row.id) as { source_id: number }[]).map((r) => r.source_id);
    return {
      id: row.id,
      username: row.username ?? `account-${row.id}`,
      name: row.name,
      role: row.role,
      canRequest: !!row.can_request,
      sources,
      hasPassword: row.password_hash !== null,
    };
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}

function cleanName(name: string): string {
  const clean = name.trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!clean) throw new AccountError('An account needs a name');
  return clean;
}
```

**Step 4: Run the test again**

```bash
corepack pnpm -C apps/server exec vitest run src/accounts/accounts.test.ts
corepack pnpm -C apps/server typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/server/src/accounts/accounts.ts apps/server/src/accounts/accounts.test.ts
git commit -m "$(cat <<'EOF'
Add the accounts service: usernames, roles, library access and passwords

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Device sessions and setup codes

**Files:**
- Create: `apps/server/src/accounts/sessions.ts`, `apps/server/src/accounts/setupCodes.ts`
- Test: `apps/server/src/accounts/sessions.test.ts` (create)

**Step 1: Write the failing test**

```ts
// apps/server/src/accounts/sessions.test.ts
import { describe, expect, it } from 'vitest';
import { freshDb } from '../catalog/testFixtures.ts';
import { Accounts } from './accounts.ts';
import { hashToken, Sessions } from './sessions.ts';
import { normalizeCode, SetupCodes } from './setupCodes.ts';

const T0 = Date.parse('2026-11-03T10:00:00Z');

describe('Sessions', () => {
  it('gives each device a random token, stored only as its hash', () => {
    const db = freshDb();
    const sessions = new Sessions(db, () => T0);
    const { id, token } = sessions.create(1, '  iPhone  ', 'ios');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sessions.create(1, 'Mac', 'web').token).not.toBe(token);
    expect(db.prepare('SELECT token_hash FROM sessions WHERE id = ?').get(id)).toEqual({ token_hash: hashToken(token) });
    expect(JSON.stringify(db.prepare('SELECT * FROM sessions').all())).not.toContain(token);
    expect(sessions.resolve(token)).toEqual({ id, accountId: 1 });
    expect(sessions.resolve('nope')).toBeUndefined();
    expect(sessions.list(1, id)[0]).toMatchObject({ device: 'Mac', current: false });
    expect(sessions.list(1, id).find((s) => s.id === id)).toMatchObject({ device: 'iPhone', platform: 'ios', current: true });
    // Device and platform are optional: the web's sign-in may send neither.
    const blank = sessions.create(1, ' ', '');
    expect(sessions.list(1).find((s) => s.id === blank.id)).toMatchObject({ device: 'Unknown device', platform: 'web' });
  });

  it('writes when a session was last seen at most once a minute', () => {
    const db = freshDb();
    let now = T0;
    const sessions = new Sessions(db, () => now);
    const { id, token } = sessions.create(1, 'Mac', 'web');
    const seen = () => (db.prepare('SELECT last_seen_at FROM sessions WHERE id = ?').get(id) as { last_seen_at: string }).last_seen_at;
    now = T0 + 30_000;
    sessions.resolve(token);
    expect(seen()).toBe('2026-11-03T10:00:00.000Z');
    now = T0 + 61_000;
    sessions.resolve(token);
    expect(seen()).toBe('2026-11-03T10:01:01.000Z');
  });

  it('signs out one device, or all of an account’s', () => {
    const db = freshDb();
    const sessions = new Sessions(db);
    const a = sessions.create(1, 'Mac', 'web');
    const b = sessions.create(1, 'iPhone', 'ios');
    expect(sessions.remove(2, a.id)).toBe(false); // not account 2's
    expect(sessions.remove(1, a.id)).toBe(true);
    expect(sessions.resolve(a.token)).toBeUndefined();
    sessions.removeAll(1);
    expect(sessions.resolve(b.token)).toBeUndefined();
  });
});

describe('SetupCodes', () => {
  it('issues one code per account, valid for 7 days, used once', () => {
    const db = freshDb();
    const accounts = new Accounts(db);
    const sam = accounts.create({ username: 'sam', name: 'Sam', role: 'member', canRequest: false, sources: null });
    let now = T0;
    const codes = new SetupCodes(db, () => now);
    const first = codes.issue(sam.id, 'http://nas:4000');
    const second = codes.issue(sam.id, 'http://nas:4000');
    expect(second.code).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
    expect(second.link).toBe(`http://nas:4000/redeem?code=${second.code}`);
    expect(second.expiresAt).toBe('2026-11-10T10:00:00.000Z');
    expect(codes.accountFor(first.code)).toBeUndefined(); // replaced by the second
    expect(codes.accountFor(` ${second.code.slice(0, 4).toLowerCase()}-${second.code.slice(4)} `)).toBe(sam.id);
    now = T0 + 7 * 86_400_000;
    expect(codes.accountFor(second.code)).toBeUndefined(); // expired
    now = T0;
    codes.use(second.code);
    expect(codes.accountFor(second.code)).toBeUndefined();
    expect(normalizeCode('ab cd-2345')).toBe('ABCD2345');
  });
});
```

**Step 2: Run it to see it fail**

```bash
corepack pnpm -C apps/server exec vitest run src/accounts/sessions.test.ts
```

Expected: FAIL: modules not found.

**Step 3: Implement**

```ts
// apps/server/src/accounts/sessions.ts
import type { SessionInfo } from '@playarr/shared';
import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/** last_seen_at is written at most this often per session: sessions are read on every request. */
const TOUCH_EVERY_MS = 60_000;

/** 256 random bits. */
export const newToken = () => randomBytes(32).toString('base64url');
/** Tokens are stored as their SHA-256, so a copy of the database signs nobody in. */
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

interface Row {
  id: number;
  device: string;
  platform: string;
  created_at: string;
  last_seen_at: string;
}

/** Devices signed in to an account: the iOS app sends the token as a Bearer, the web as a cookie. */
export class Sessions {
  /** When each session was last written as seen, so most requests write nothing. */
  private readonly touched = new Map<number, number>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}

  create(accountId: number, device: string, platform: string): { id: number; token: string } {
    const token = newToken();
    const at = new Date(this.now()).toISOString();
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO sessions (account_id, token_hash, device, platform, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(accountId, hashToken(token), device.trim().slice(0, 80) || 'Unknown device', platform.trim().slice(0, 20) || 'web', at, at);
    const id = Number(lastInsertRowid);
    this.touched.set(id, this.now());
    return { id, token };
  }

  /** The session a token belongs to, noting that it was seen. */
  resolve(token: string): { id: number; accountId: number } | undefined {
    if (!token) return undefined;
    const row = this.db.prepare('SELECT id, account_id, last_seen_at FROM sessions WHERE token_hash = ?').get(hashToken(token)) as
      | { id: number; account_id: number; last_seen_at: string }
      | undefined;
    if (!row) return undefined;
    const now = this.now();
    if (now - (this.touched.get(row.id) ?? Date.parse(row.last_seen_at)) >= TOUCH_EVERY_MS) {
      this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(new Date(now).toISOString(), row.id);
      this.touched.set(row.id, now);
    }
    return { id: row.id, accountId: row.account_id };
  }

  list(accountId: number, currentId?: number): SessionInfo[] {
    const rows = this.db
      .prepare('SELECT id, device, platform, created_at, last_seen_at FROM sessions WHERE account_id = ? ORDER BY last_seen_at DESC, id DESC')
      .all(accountId) as unknown as Row[];
    return rows.map((r) => ({ id: r.id, device: r.device, platform: r.platform, createdAt: r.created_at, lastSeenAt: r.last_seen_at, current: r.id === currentId }));
  }

  /** Sign one device out; false when the account has no such session. */
  remove(accountId: number, sessionId: number): boolean {
    this.touched.delete(sessionId);
    return Number(this.db.prepare('DELETE FROM sessions WHERE id = ? AND account_id = ?').run(sessionId, accountId).changes) > 0;
  }

  removeAll(accountId: number) {
    this.db.prepare('DELETE FROM sessions WHERE account_id = ?').run(accountId);
  }
}
```

```ts
// apps/server/src/accounts/setupCodes.ts
import type { SetupCode } from '@playarr/shared';
import { createHash, randomInt } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/** No 0/O or 1/I/L: read aloud or typed on a phone without mistakes. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const LENGTH = 8;
const VALID_MS = 7 * 86_400_000;

/** A code as typed: any case, with spaces or dashes. */
export const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');
const hashCode = (code: string) => createHash('sha256').update(normalizeCode(code)).digest('hex');

/** One-time codes for choosing a first password, so admins never choose anyone's. */
export class SetupCodes {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}

  /** A new code for the account (any earlier one stops working), with its link on `origin`. */
  issue(accountId: number, origin: string): SetupCode {
    const code = Array.from({ length: LENGTH }, () => ALPHABET.charAt(randomInt(ALPHABET.length))).join('');
    const expiresAt = new Date(this.now() + VALID_MS).toISOString();
    this.db.prepare('DELETE FROM setup_codes WHERE account_id = ?').run(accountId);
    this.db
      .prepare('INSERT INTO setup_codes (code_hash, account_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run(hashCode(code), accountId, expiresAt, new Date(this.now()).toISOString());
    return { code, link: `${origin}/redeem?code=${code}`, expiresAt };
  }

  /** The account a code is for; undefined when it's wrong, used or expired. */
  accountFor(code: string): number | undefined {
    const row = this.db.prepare('SELECT account_id, expires_at FROM setup_codes WHERE code_hash = ?').get(hashCode(code)) as
      | { account_id: number; expires_at: string }
      | undefined;
    return row && Date.parse(row.expires_at) > this.now() ? row.account_id : undefined;
  }

  use(code: string) {
    this.db.prepare('DELETE FROM setup_codes WHERE code_hash = ?').run(hashCode(code));
  }
}
```

*As executed:* a blank platform defaults to `web` (the conventions: "device and platform are optional, defaults Unknown device, web"), not `unknown`; the first test checks it.

**Step 4: Run the test again**

```bash
corepack pnpm -C apps/server exec vitest run src/accounts/sessions.test.ts
corepack pnpm -C apps/server typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/server/src/accounts/sessions.ts apps/server/src/accounts/setupCodes.ts apps/server/src/accounts/sessions.test.ts
git commit -m "$(cat <<'EOF'
Add device sessions (hashed tokens) and one-time setup codes

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---
### Task 5: The auth hook and the rights helpers

**Files:**
- Create: `apps/server/src/accounts/auth.ts`, `apps/server/src/accounts/rights.ts`, `apps/server/src/accounts/testAccess.ts`
- Test: `apps/server/src/accounts/auth.test.ts`, `apps/server/src/accounts/rights.test.ts` (create)

One `onRequest` hook decides who's asking: a valid Bearer token or `playarr_session` cookie sets `req.auth` to that account and session; in setup mode every other request acts as the owner; otherwise the protected paths answer 401 except the conventions' exceptions (plus `POST /api/auth/switch`, which authenticates by its body). The `X-Playarr` rule moves in here: changes to `/api/` need it unless they carry a Bearer token.

**Step 1: Write the failing tests**

```ts
// apps/server/src/accounts/auth.test.ts
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { freshDb } from '../catalog/testFixtures.ts';
import { Accounts } from './accounts.ts';
import { authHook, readCookie } from './auth.ts';
import { Sessions } from './sessions.ts';

function setup() {
  const db = freshDb();
  const accounts = new Accounts(db);
  const sessions = new Sessions(db);
  const app = Fastify();
  app.decorateRequest('auth', null);
  app.addHook('onRequest', authHook({ accounts, sessions }));
  const who = (req: { auth?: { account: { id: number }; setup: boolean; session: { via: string } | null } | null }) => ({
    id: req.auth?.account.id ?? null,
    setup: req.auth?.setup ?? null,
    via: req.auth?.session?.via ?? null,
  });
  app.get('/api/whoami', (req) => who(req));
  app.post('/api/change', (req) => who(req));
  for (const url of ['/stream/1', '/art/album/1/cover', '/transitions/x.flac', '/api/server', '/api/health', '/']) app.get(url, () => 'ok');
  for (const url of ['/api/auth/sign-in', '/api/auth/redeem', '/api/auth/setup', '/api/auth/switch']) app.post(url, () => 'ok');
  return { accounts, sessions, app };
}

describe('authHook', () => {
  it('acts as the owner for everyone while no account has a password (setup mode)', async () => {
    const { app } = setup();
    expect((await app.inject({ url: '/api/whoami' })).json()).toEqual({ id: 1, setup: true, via: null });
    expect((await app.inject({ url: '/stream/1' })).statusCode).toBe(200);
  });

  it('once a password exists, wants a session on the API, streams, art and transitions', async () => {
    const { app, accounts } = setup();
    await accounts.setPassword(1, 'correct horse');
    for (const url of ['/api/whoami', '/stream/1', '/art/album/1/cover', '/transitions/x.flac']) {
      const res = await app.inject({ url });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'Sign in to Playarr', setup: false });
    }
  });

  it('leaves open what an app needs to find the server and sign in, and the web pages', async () => {
    const { app, accounts } = setup();
    await accounts.setPassword(1, 'correct horse');
    for (const url of ['/api/server', '/api/health', '/']) expect((await app.inject({ url })).statusCode).toBe(200);
    for (const url of ['/api/auth/sign-in', '/api/auth/redeem', '/api/auth/setup', '/api/auth/switch']) {
      expect((await app.inject({ method: 'POST', url, headers: { 'x-playarr': '1' } })).statusCode).toBe(200);
    }
  });

  it('takes the session from a Bearer token or the session cookie', async () => {
    const { app, accounts, sessions } = setup();
    await accounts.setPassword(1, 'correct horse');
    const { token } = sessions.create(1, 'iPhone', 'ios');
    expect((await app.inject({ url: '/api/whoami', headers: { authorization: `Bearer ${token}` } })).json()).toEqual({ id: 1, setup: false, via: 'bearer' });
    expect((await app.inject({ url: '/api/whoami', headers: { cookie: `theme=dark; playarr_session=${token}` } })).json()).toEqual({ id: 1, setup: false, via: 'cookie' });
    expect((await app.inject({ url: '/api/whoami', headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401);
  });

  it('wants the X-Playarr header on changes from browsers, not from Bearer tokens', async () => {
    const { app, accounts, sessions } = setup();
    await accounts.setPassword(1, 'correct horse');
    const { token } = sessions.create(1, 'Mac', 'web');
    const cookie = { cookie: `playarr_session=${token}` };
    expect((await app.inject({ method: 'POST', url: '/api/change', headers: cookie })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/change', headers: { ...cookie, 'x-playarr': '1' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/change', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
  });

  it('reads one cookie out of the header', () => {
    expect(readCookie('a=1; playarr_session=abc-_; b=2', 'playarr_session')).toBe('abc-_');
    expect(readCookie('a=1', 'playarr_session')).toBeUndefined();
    expect(readCookie(undefined, 'playarr_session')).toBeUndefined();
  });
});
```

```ts
// apps/server/src/accounts/rights.test.ts
import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { freshDb } from '../catalog/testFixtures.ts';
import { Accounts } from './accounts.ts';
import { accountId, requireAdmin, requireCanRequest, requireLocalSetup, requireOwn } from './rights.ts';
import { account, actAs, asAccount } from './testAccess.ts';

const HOME = '192.168.1.20';
const AWAY = '203.0.113.5';

function routes(app: FastifyInstance) {
  app.get('/admin', { onRequest: requireAdmin }, () => 'ok');
  app.get('/own', { onRequest: requireOwn }, () => 'ok');
  app.get('/request', { onRequest: requireCanRequest }, () => 'ok');
  app.get('/who', (req) => ({ id: accountId(req) }));
  return app;
}

describe('rights', () => {
  it('lets admins in, members only to their own settings, and nobody unsigned', async () => {
    const app = Fastify();
    actAs(app, [account(1, { role: 'admin' }), account(2)]);
    routes(app);
    expect((await app.inject({ url: '/admin', headers: asAccount(1), remoteAddress: AWAY })).statusCode).toBe(200);
    const member = await app.inject({ url: '/admin', headers: asAccount(2), remoteAddress: HOME });
    expect(member.statusCode).toBe(403);
    expect(member.json()).toEqual({ error: 'Only an admin can change this' });
    expect((await app.inject({ url: '/own', headers: asAccount(2), remoteAddress: AWAY })).statusCode).toBe(200);
    expect((await app.inject({ url: '/own', remoteAddress: HOME })).statusCode).toBe(403);
    expect((await app.inject({ url: '/who', headers: asAccount(2) })).json()).toEqual({ id: 2 });
  });

  it('goes by the home network in setup mode and for routes run without accounts, as before', async () => {
    for (const app of [routes(Fastify()), setupMode()]) {
      expect((await app.inject({ url: '/admin', remoteAddress: HOME })).statusCode).toBe(200);
      const away = await app.inject({ url: '/admin', remoteAddress: AWAY });
      expect(away.statusCode).toBe(403);
      expect(away.json()).toEqual({ error: 'Settings can only be changed from your home network' });
      expect((await app.inject({ url: '/own', remoteAddress: AWAY })).statusCode).toBe(403);
      expect((await app.inject({ url: '/request', remoteAddress: AWAY })).statusCode).toBe(200);
      expect((await app.inject({ url: '/who' })).json()).toEqual({ id: 1 });
    }
  });

  it('lets only accounts with the right request albums', async () => {
    const app = Fastify();
    actAs(app, [account(1, { canRequest: true }), account(2, { canRequest: false })]);
    routes(app);
    expect((await app.inject({ url: '/request', headers: asAccount(1) })).statusCode).toBe(200);
    expect((await app.inject({ url: '/request', headers: asAccount(2) })).json()).toEqual({ error: 'Your account can’t request albums' });
    expect((await app.inject({ url: '/request' })).statusCode).toBe(403);
  });

  it('lets the server be claimed only in setup mode, from the home network', async () => {
    const accounts = new Accounts(freshDb());
    const app = Fastify();
    app.post('/claim', { onRequest: requireLocalSetup(accounts) }, () => 'ok');
    expect((await app.inject({ method: 'POST', url: '/claim', remoteAddress: AWAY })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/claim', remoteAddress: HOME })).statusCode).toBe(200);
    await accounts.setPassword(1, 'correct horse');
    expect((await app.inject({ method: 'POST', url: '/claim', remoteAddress: HOME })).statusCode).toBe(409);
  });
});

/** An app whose requests all act as the owner in setup mode, as the auth hook makes them. */
function setupMode() {
  const app = Fastify();
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req) => {
    req.auth = { setup: true, account: account(1, { role: 'admin', canRequest: true }), session: null };
  });
  return routes(app);
}
```

**Step 2: Run them to see them fail**

```bash
corepack pnpm -C apps/server exec vitest run src/accounts/auth.test.ts src/accounts/rights.test.ts
```

Expected: FAIL: modules not found.

**Step 3: Implement**

```ts
// apps/server/src/accounts/auth.ts
import type { Account } from '@playarr/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { isFromApp } from '../net.ts';
import type { Accounts } from './accounts.ts';
import type { Sessions } from './sessions.ts';

export const SESSION_COOKIE = 'playarr_session';
/** How long the browser keeps the session cookie: its longest (the session itself lasts until signed out). */
const COOKIE_MAX_AGE = 400 * 86_400;

/** Who a request is for. */
export interface RequestAuth {
  /** No account has a password yet: everyone acts as the owner and the home network decides rights. */
  setup: boolean;
  account: Account;
  /** The session it came with; none in setup mode. */
  session: { id: number; via: 'bearer' | 'cookie' } | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Set by authHook: who's asking, or null for an unsigned request to an open route. Undefined only
     * when the routes run without accounts (their tests), which the rights helpers treat as setup mode.
     */
    auth?: RequestAuth | null;
  }
}

/** Behind sign-in once any account has a password. */
const PROTECTED = /^\/(api|stream|art|transitions)\//;
/** Open to anyone: what an app needs to find this server and sign in. Switch checks the token it's sent. */
const OPEN = new Set(['GET /api/server', 'GET /api/health', 'POST /api/auth/sign-in', 'POST /api/auth/redeem', 'POST /api/auth/setup', 'POST /api/auth/switch']);

/** One cookie's value from a Cookie header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

/** The token a request carries: `Authorization: Bearer` (the app) or the session cookie (the web). */
export function credentials(req: Pick<FastifyRequest, 'headers'>): { token: string; via: 'bearer' | 'cookie' } | undefined {
  const header = req.headers.authorization;
  if (typeof header === 'string' && /^Bearer\s+\S/i.test(header)) return { token: header.replace(/^Bearer\s+/i, '').trim(), via: 'bearer' };
  const cookie = readCookie(req.headers.cookie, SESSION_COOKIE);
  return cookie ? { token: cookie, via: 'cookie' } : undefined;
}

/** True when the visitor came over HTTPS (directly or through a proxy that says so). */
const overHttps = (req: FastifyRequest) => req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';

/** The Set-Cookie value that makes `token` this browser's session, or ends it (null). */
export function sessionCookie(req: FastifyRequest, token: string | null): string {
  const parts = [`${SESSION_COOKIE}=${token ?? ''}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${token ? COOKIE_MAX_AGE : 0}`];
  if (overHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

/** This server as the visitor reached it (for setup links). */
export function originOf(req: FastifyRequest): string {
  const forwardedHost = req.headers['x-forwarded-host'];
  const host = (typeof forwardedHost === 'string' && forwardedHost) || req.headers.host || 'localhost';
  return `${overHttps(req) ? 'https' : 'http'}://${host}`;
}

/** Decides who every request is for (req.auth), and turns away what it may not do. */
export function authHook(deps: { accounts: Pick<Accounts, 'get' | 'owner' | 'setupMode'>; sessions: Pick<Sessions, 'resolve'> }) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const path = req.url.split('?')[0]!;
    const given = credentials(req);
    // Changes must come from Playarr's own pages (see isFromApp). Other sites can't send a Bearer token.
    if (path.startsWith('/api/') && given?.via !== 'bearer' && !isFromApp(req)) {
      return reply.code(403).send({ error: 'Changes must come from Playarr itself' });
    }
    const session = given && deps.sessions.resolve(given.token);
    const account = session && deps.accounts.get(session.accountId);
    if (session && account) {
      req.auth = { setup: false, account, session: { id: session.id, via: given.via } };
      return;
    }
    if (deps.accounts.setupMode()) {
      req.auth = { setup: true, account: deps.accounts.owner(), session: null };
      return;
    }
    req.auth = null;
    const route = `${req.method === 'HEAD' ? 'GET' : req.method} ${path}`;
    if (PROTECTED.test(path) && !OPEN.has(route)) return reply.code(401).send({ error: 'Sign in to Playarr', setup: false });
  };
}
```

```ts
// apps/server/src/accounts/rights.ts
import type { FastifyReply, FastifyRequest } from 'fastify';
import { isLocalRequest } from '../net.ts';
import type { Accounts } from './accounts.ts';

/** No accounts to go by: nobody has set up the server yet, or the routes run without accounts (tests). */
const byHomeNetwork = (req: FastifyRequest) => req.auth === undefined || req.auth?.setup === true;

/** Admins change settings, sources, analysis and accounts; before setup, anyone on the home network. */
export function isAdmin(req: FastifyRequest): boolean {
  if (byHomeNetwork(req)) return isLocalRequest(req);
  return req.auth?.account.role === 'admin';
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  if (isAdmin(req)) return;
  return reply.code(403).send({ error: byHomeNetwork(req) ? 'Settings can only be changed from your home network' : 'Only an admin can change this' });
}

/** Your own settings (ListenBrainz, your history): yours once signed in; before setup, from the home network. */
export async function requireOwn(req: FastifyRequest, reply: FastifyReply) {
  if (byHomeNetwork(req) ? isLocalRequest(req) : !!req.auth) return;
  return reply.code(403).send({ error: 'Settings can only be changed from your home network' });
}

/** Claiming the owner account: only while no account has a password, and only from the home network. */
export function requireLocalSetup(accounts: Pick<Accounts, 'setupMode'>) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!accounts.setupMode()) return reply.code(409).send({ error: 'This server is already set up: sign in instead' });
    if (!isLocalRequest(req)) return reply.code(403).send({ error: 'Setting up Playarr works from your home network' });
  };
}

/** The account a request is for: its own, the owner's in setup mode, 1 without accounts. */
export const accountId = (req: FastifyRequest): number => req.auth?.account.id ?? 1;

/** Requests need the account's right (Settings → Accounts); everyone had it before accounts. */
export function canRequest(req: FastifyRequest): boolean {
  if (req.auth === undefined) return true;
  if (!req.auth) return false;
  return req.auth.setup || req.auth.account.canRequest;
}

export async function requireCanRequest(req: FastifyRequest, reply: FastifyReply) {
  if (!canRequest(req)) return reply.code(403).send({ error: 'Your account can’t request albums' });
}
```

```ts
// apps/server/src/accounts/testAccess.ts
import type { Account } from '@playarr/shared';
import type { FastifyInstance } from 'fastify';

/** Tests: requests on an app set up with actAs act as the account whose id this header names. */
export const TEST_ACCOUNT_HEADER = 'x-test-account';

/** A signed-in account for tests: a member who may hear every source, unless `patch` says otherwise. */
export function account(id: number, patch: Partial<Account> = {}): Account {
  return { id, username: `user${id}`, name: `User ${id}`, role: 'member', canRequest: false, sources: null, hasPassword: true, ...patch };
}

/**
 * Stand in for the auth hook: a request with the test header acts as that account (with a Bearer
 * session), one without is unsigned (req.auth null), as on a server whose owner has set a password.
 */
export function actAs(app: FastifyInstance, accounts: Account[]) {
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req) => {
    const found = accounts.find((a) => a.id === Number(req.headers[TEST_ACCOUNT_HEADER]));
    req.auth = found ? { setup: false, account: found, session: { id: found.id, via: 'bearer' } } : null;
  });
}

/** Headers for a request as this account (with Playarr's own header, for changes). */
export const asAccount = (id: number) => ({ [TEST_ACCOUNT_HEADER]: String(id), 'x-playarr': '1' });
```

**Step 4: Run the tests again**

```bash
corepack pnpm -C apps/server exec vitest run src/accounts/auth.test.ts src/accounts/rights.test.ts
corepack pnpm -C apps/server typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/server/src/accounts/auth.ts apps/server/src/accounts/rights.ts apps/server/src/accounts/testAccess.ts apps/server/src/accounts/auth.test.ts apps/server/src/accounts/rights.test.ts
git commit -m "$(cat <<'EOF'
Resolve every request's account from a Bearer token or the session cookie

Setup mode acts as the owner until some account has a password; after
that the API, streams, art and transitions want a session. Admins replace
the home-network rule, which stays for setup mode.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Sign-in routes: setup, sign-in, redeem, sign-out, me, switch

**Files:**
- Create: `apps/server/src/routes/auth.ts`
- Test: `apps/server/src/routes/auth.test.ts` (create)

**Step 1: Write the failing test**

```ts
// apps/server/src/routes/auth.test.ts
import type { SignInResponse } from '@playarr/shared';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { Accounts } from '../accounts/accounts.ts';
import { authHook } from '../accounts/auth.ts';
import { Sessions } from '../accounts/sessions.ts';
import { SetupCodes } from '../accounts/setupCodes.ts';
import { freshDb } from '../catalog/testFixtures.ts';
import { authRoutes } from './auth.ts';

const AWAY = '203.0.113.5';
const H = { 'x-playarr': '1' };
const device = { device: 'Safari on Mac', platform: 'web' };

function setup() {
  const db = freshDb();
  const accounts = new Accounts(db);
  const sessions = new Sessions(db);
  const setupCodes = new SetupCodes(db);
  const app = Fastify();
  app.decorateRequest('auth', null);
  app.addHook('onRequest', authHook({ accounts, sessions }));
  authRoutes(app, { accounts, sessions, setupCodes });
  const post = (url: string, payload: object, extra: { headers?: Record<string, string>; remoteAddress?: string } = {}) =>
    app.inject({ method: 'POST', url, payload, headers: { ...H, ...extra.headers }, remoteAddress: extra.remoteAddress });
  return { accounts, sessions, setupCodes, app, post };
}

const owner = { username: 'nicola', name: 'Nicola', password: 'correct horse', ...device };

describe('auth routes', () => {
  it('claims the owner account from the home network, once', async () => {
    const { accounts, post } = setup();
    expect((await post('/api/auth/setup', owner, { remoteAddress: AWAY })).statusCode).toBe(403);
    expect((await post('/api/auth/setup', { ...owner, password: 'short' })).statusCode).toBe(400);
    expect(accounts.get(1)!.username).toBe('home'); // a refused try changes nothing
    const res = await post('/api/auth/setup', owner);
    expect(res.statusCode).toBe(200);
    const body = res.json() as SignInResponse;
    expect(body.account).toEqual({ id: 1, username: 'nicola', name: 'Nicola', role: 'admin', canRequest: true, sources: null, hasPassword: true });
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(accounts.setupMode()).toBe(false);
    expect((await post('/api/auth/setup', owner)).statusCode).toBe(409);
  });

  it('signs in with the right password, and makes the session the cookie on switch', async () => {
    const { app, accounts, post } = setup();
    await accounts.setPassword(1, 'correct horse');
    const wrong = await post('/api/auth/sign-in', { username: 'home', password: 'wrong horse', ...device });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual({ error: 'Wrong username or password', setup: false });
    const { token, account } = (await post('/api/auth/sign-in', { username: 'HOME', password: 'correct horse', ...device })).json() as SignInResponse;
    expect(account.id).toBe(1);
    const switched = await post('/api/auth/switch', { token });
    expect(switched.json()).toMatchObject({ id: 1, username: 'home' });
    expect(switched.headers['set-cookie']).toBe(`playarr_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=34560000`);
    expect((await app.inject({ url: '/api/auth/me', headers: { cookie: `playarr_session=${token}` } })).json()).toMatchObject({ id: 1 });
    expect((await app.inject({ url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } })).json()).toMatchObject({ id: 1 });
    expect((await post('/api/auth/switch', { token: 'nope' })).statusCode).toBe(401);
  });

  it('signs in without a device or platform, recording the defaults', async () => {
    const { accounts, sessions, post } = setup();
    await accounts.setPassword(1, 'correct horse');
    const res = await post('/api/auth/sign-in', { username: 'home', password: 'correct horse' });
    expect(res.statusCode).toBe(200);
    expect(sessions.list(1)).toEqual([expect.objectContaining({ device: 'Unknown device', platform: 'web' })]);
  });

  it('marks the cookie Secure when Playarr is reached over HTTPS', async () => {
    const { accounts, sessions, post } = setup();
    await accounts.setPassword(1, 'correct horse');
    const { token } = sessions.create(1, 'Mac', 'web');
    const res = await post('/api/auth/switch', { token }, { headers: { 'x-forwarded-proto': 'https' } });
    expect(res.headers['set-cookie']).toMatch(/; Secure$/);
  });

  it('turns sign-ins away after 10 failures, per address and per username', async () => {
    const { accounts, post } = setup();
    await accounts.setPassword(1, 'correct horse');
    const right = { username: 'home', password: 'correct horse', ...device };
    for (let i = 0; i < 10; i++) await post('/api/auth/sign-in', { ...right, password: 'wrong horse' }, { remoteAddress: '192.168.1.30' });
    expect((await post('/api/auth/sign-in', right, { remoteAddress: '192.168.1.30' })).statusCode).toBe(429);
    expect((await post('/api/auth/sign-in', right, { remoteAddress: '192.168.1.31' })).statusCode).toBe(429);
  });

  it('redeems a setup code once, for the account’s first password', async () => {
    const { accounts, setupCodes, post } = setup();
    await accounts.setPassword(1, 'correct horse');
    const sam = accounts.create({ username: 'sam', name: 'Sam', role: 'member', canRequest: false, sources: null });
    const { code } = setupCodes.issue(sam.id, 'http://nas:4000');
    expect((await post('/api/auth/redeem', { code, password: 'short', ...device })).statusCode).toBe(400);
    const res = await post('/api/auth/redeem', { code: code.toLowerCase(), password: 'sams password', ...device });
    expect((res.json() as SignInResponse).account).toMatchObject({ id: sam.id, hasPassword: true });
    const again = await post('/api/auth/redeem', { code, password: 'sams password', ...device });
    expect(again.json()).toEqual({ error: 'That code is wrong, used or expired. Ask for a new one.' });
    expect(await accounts.verify('sam', 'sams password')).toMatchObject({ id: sam.id });
  });

  it('signs out this device only, and clears the cookie', async () => {
    const { app, accounts, sessions, post } = setup();
    await accounts.setPassword(1, 'correct horse');
    const here = sessions.create(1, 'Mac', 'web').token;
    const phone = sessions.create(1, 'iPhone', 'ios').token;
    const res = await post('/api/auth/sign-out', {}, { headers: { cookie: `playarr_session=${here}` } });
    expect(res.statusCode).toBe(204);
    expect(res.headers['set-cookie']).toBe('playarr_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    expect((await app.inject({ url: '/api/auth/me', headers: { cookie: `playarr_session=${here}` } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/auth/me', headers: { authorization: `Bearer ${phone}` } })).statusCode).toBe(200);
  });

  it('says nobody is signed in, and that the server needs setting up, before anyone can be', async () => {
    const { app } = setup();
    const res = await app.inject({ url: '/api/auth/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Nobody is signed in', setup: true });
  });
});
```

**Step 2: Run it to see it fail**

```bash
corepack pnpm -C apps/server exec vitest run src/routes/auth.test.ts
```

Expected: FAIL: `./auth.ts` not found.

**Step 3: Implement**

```ts
// apps/server/src/routes/auth.ts
import type { Account, SignInResponse } from '@playarr/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { AccountError, checkPassword, type Accounts } from '../accounts/accounts.ts';
import { sessionCookie } from '../accounts/auth.ts';
import { RateLimiter } from '../accounts/rateLimit.ts';
import { requireLocalSetup } from '../accounts/rights.ts';
import type { Sessions } from '../accounts/sessions.ts';
import type { SetupCodes } from '../accounts/setupCodes.ts';

const device = {
  device: z.string().trim().max(80).default('Unknown device'),
  platform: z.string().trim().max(20).default('web'),
};
const setupInput = z.object({ username: z.string().trim().min(1).max(64), name: z.string().trim().min(1).max(40), password: z.string().max(200), ...device });
const signInInput = z.object({ username: z.string().trim().min(1).max(64), password: z.string().min(1).max(200), ...device });
const redeemInput = z.object({ code: z.string().trim().min(1).max(32), password: z.string().max(200), ...device });
const switchInput = z.object({ token: z.string().min(1).max(200) });

const TOO_MANY = 'Too many tries. Wait a few minutes and try again.';

/** A request body as `schema` wants it, or a 400 naming what's wrong. */
export function parseInput<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) throw new AccountError(result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return result.data;
}

/** Runs a handler, answering an AccountError with its status and message. */
export async function handleAccountErrors(reply: FastifyReply, fn: () => unknown) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AccountError) return reply.code(err.status).send({ error: err.message });
    throw err;
  }
}

/** Claiming the server, signing in and out, setup codes, and who's signed in. */
export function authRoutes(
  app: FastifyInstance,
  deps: { accounts: Accounts; sessions: Sessions; setupCodes: SetupCodes; limiter?: RateLimiter },
) {
  const { accounts, sessions, setupCodes } = deps;
  const limiter = deps.limiter ?? new RateLimiter();
  const signedIn = (account: Account, input: { device: string; platform: string }): SignInResponse => ({
    token: sessions.create(account.id, input.device, input.platform).token,
    account,
  });

  // The owner sets their username and password: from the home network, while nobody has one.
  app.post('/api/auth/setup', { onRequest: requireLocalSetup(accounts) }, (req, reply) =>
    handleAccountErrors(reply, async () => {
      const input = parseInput(setupInput, req.body);
      checkPassword(input.password);
      const owner = accounts.owner();
      accounts.update(owner.id, { username: input.username, name: input.name, role: 'admin' });
      await accounts.setPassword(owner.id, input.password);
      return signedIn(accounts.get(owner.id)!, input);
    }),
  );

  app.post('/api/auth/sign-in', (req, reply) =>
    handleAccountErrors(reply, async () => {
      const input = parseInput(signInInput, req.body);
      const keys = [`ip:${req.ip}`, `user:${input.username.toLowerCase()}`];
      if (!limiter.allows(keys)) return reply.code(429).send({ error: TOO_MANY });
      const account = await accounts.verify(input.username, input.password);
      if (!account) {
        limiter.fail(keys);
        return reply.code(401).send({ error: 'Wrong username or password', setup: accounts.setupMode() });
      }
      limiter.clear(keys[1]!);
      return signedIn(account, input);
    }),
  );

  // A new or reset account chooses its password with the code an admin gave them.
  app.post('/api/auth/redeem', (req, reply) =>
    handleAccountErrors(reply, async () => {
      const input = parseInput(redeemInput, req.body);
      const keys = [`ip:${req.ip}`];
      if (!limiter.allows(keys)) return reply.code(429).send({ error: TOO_MANY });
      const id = setupCodes.accountFor(input.code);
      if (id === undefined) {
        limiter.fail(keys);
        return reply.code(400).send({ error: 'That code is wrong, used or expired. Ask for a new one.' });
      }
      await accounts.setPassword(id, input.password); // a password too short leaves the code unused
      setupCodes.use(input.code);
      return signedIn(accounts.get(id)!, input);
    }),
  );

  app.post('/api/auth/sign-out', (req, reply) => {
    const auth = req.auth;
    if (!auth?.session) return reply.code(401).send({ error: 'Nobody is signed in', setup: accounts.setupMode() });
    sessions.remove(auth.account.id, auth.session.id);
    if (auth.session.via === 'cookie') reply.header('set-cookie', sessionCookie(req, null));
    return reply.code(204).send();
  });

  app.get('/api/auth/me', (req, reply) =>
    req.auth?.session ? req.auth.account : reply.code(401).send({ error: 'Nobody is signed in', setup: accounts.setupMode() }),
  );

  // The web keeps a token per account signed in on the device; switching makes one the cookie.
  app.post('/api/auth/switch', (req, reply) => {
    const parsed = switchInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'A token is required' });
    const session = sessions.resolve(parsed.data.token);
    const account = session && accounts.get(session.accountId);
    if (!account) return reply.code(401).send({ error: 'That sign-in has ended: sign in again', setup: accounts.setupMode() });
    reply.header('set-cookie', sessionCookie(req, parsed.data.token));
    return account;
  });
}
```

*As executed:* `platform` defaults to `web` (the conventions' default), checked by the "signs in without a device or platform" test.

**Step 4: Run the test again**

```bash
corepack pnpm -C apps/server exec vitest run src/routes/auth.test.ts
corepack pnpm -C apps/server typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/server/src/routes/auth.ts apps/server/src/routes/auth.test.ts
git commit -m "$(cat <<'EOF'
Add sign-in routes: claim the server, sign in and out, redeem a setup code, switch

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Account admin routes

**Files:**
- Create: `apps/server/src/routes/accounts.ts`
- Test: `apps/server/src/routes/accounts.test.ts` (create)

**Step 1: Write the failing test**

```ts
// apps/server/src/routes/accounts.test.ts
import type { Account, CreatedAccount, SessionInfo, SetupCode } from '@playarr/shared';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { Accounts } from '../accounts/accounts.ts';
import { authHook } from '../accounts/auth.ts';
import { Sessions } from '../accounts/sessions.ts';
import { SetupCodes } from '../accounts/setupCodes.ts';
import { CatalogStore } from '../catalog/store.ts';
import { freshDb } from '../catalog/testFixtures.ts';
import { accountRoutes } from './accounts.ts';

async function setup({ claimed = true } = {}) {
  const db = freshDb();
  const store = new CatalogStore(db);
  const cc = store.addSource('folder', 'Creative Commons');
  const accounts = new Accounts(db);
  const sessions = new Sessions(db);
  const setupCodes = new SetupCodes(db);
  const app = Fastify();
  app.decorateRequest('auth', null);
  app.addHook('onRequest', authHook({ accounts, sessions }));
  accountRoutes(app, { accounts, sessions, setupCodes });
  const sam = accounts.create({ username: 'sam', name: 'Sam', role: 'member', canRequest: false, sources: null });
  if (claimed) {
    await accounts.setPassword(1, 'correct horse');
    await accounts.setPassword(sam.id, 'sams password');
  }
  const admin = sessions.create(1, 'Mac', 'web').token;
  const member = sessions.create(sam.id, 'iPhone', 'ios').token;
  const as = (token: string) => ({ authorization: `Bearer ${token}`, host: 'nas:4000' });
  return { accounts, sessions, app, cc, sam, admin, member, as };
}

describe('account routes', () => {
  it('lets admins list and add accounts, each new one with a setup code and link', async () => {
    const { app, cc, admin, member, as } = await setup();
    const res = await app.inject({ method: 'POST', url: '/api/accounts', headers: as(admin), payload: { username: 'reviewer', name: 'App Review', role: 'member', canRequest: false, sources: [cc] } });
    expect(res.statusCode).toBe(201);
    const { account, setup: code } = res.json() as CreatedAccount;
    expect(account).toMatchObject({ username: 'reviewer', name: 'App Review', role: 'member', canRequest: false, sources: [cc], hasPassword: false });
    expect(code.code).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
    expect(code.link).toBe(`http://nas:4000/redeem?code=${code.code}`);
    expect((await app.inject({ url: '/api/accounts', headers: as(admin) })).json()).toHaveLength(3);
    expect((await app.inject({ url: '/api/accounts', headers: as(member) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/accounts', headers: as(member), payload: { username: 'x', name: 'X', role: 'admin', canRequest: true, sources: null } })).statusCode).toBe(403);
    const bad = await app.inject({ method: 'POST', url: '/api/accounts', headers: as(admin), payload: { username: 'sam', name: 'Sam', role: 'member', canRequest: false, sources: null } });
    expect(bad.json()).toEqual({ error: 'That username is taken' });
  });

  it('lets members change their own name, and nothing else', async () => {
    const { app, sam, member, as } = await setup();
    expect((await app.inject({ method: 'PATCH', url: `/api/accounts/${sam.id}`, headers: as(member), payload: { name: 'Samantha' } })).json()).toMatchObject({ name: 'Samantha' });
    expect((await app.inject({ method: 'PATCH', url: `/api/accounts/${sam.id}`, headers: as(member), payload: { role: 'admin' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url: '/api/accounts/1', headers: as(member), payload: { name: 'Mine' } })).statusCode).toBe(403);
  });

  it('lets admins change rights and library access', async () => {
    const { app, cc, sam, admin, as } = await setup();
    const res = await app.inject({ method: 'PATCH', url: `/api/accounts/${sam.id}`, headers: as(admin), payload: { canRequest: true, sources: [cc] } });
    expect(res.json()).toMatchObject({ canRequest: true, sources: [cc] });
    expect((await app.inject({ method: 'PATCH', url: '/api/accounts/1', headers: as(admin), payload: { role: 'member' } })).statusCode).toBe(409);
  });

  it('resets an account: signed out everywhere, password gone, a new setup code', async () => {
    const { app, accounts, sam, admin, member, as } = await setup();
    const res = await app.inject({ method: 'POST', url: `/api/accounts/${sam.id}/reset`, headers: as(admin) });
    expect((res.json() as SetupCode).code).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
    expect(accounts.get(sam.id)!.hasPassword).toBe(false);
    expect((await app.inject({ url: `/api/accounts/${sam.id}/sessions`, headers: as(member) })).statusCode).toBe(401);
  });

  it('never deletes the last admin', async () => {
    const { app, sam, admin, as } = await setup();
    expect((await app.inject({ method: 'DELETE', url: '/api/accounts/1', headers: as(admin) })).statusCode).toBe(409);
    const left = await app.inject({ method: 'DELETE', url: `/api/accounts/${sam.id}`, headers: as(admin) });
    expect((left.json() as Account[]).map((a) => a.id)).toEqual([1]);
  });

  it('lists and ends sessions, for the account itself or an admin', async () => {
    const { app, sam, admin, member, as } = await setup();
    const own = (await app.inject({ url: `/api/accounts/${sam.id}/sessions`, headers: as(member) })).json() as SessionInfo[];
    expect(own).toEqual([expect.objectContaining({ device: 'iPhone', platform: 'ios', current: true })]);
    expect(((await app.inject({ url: `/api/accounts/${sam.id}/sessions`, headers: as(admin) })).json() as SessionInfo[])[0]!.current).toBe(false);
    expect((await app.inject({ url: '/api/accounts/1/sessions', headers: as(member) })).statusCode).toBe(403);
    const ended = await app.inject({ method: 'DELETE', url: `/api/accounts/${sam.id}/sessions/${own[0]!.id}`, headers: as(admin) });
    expect(ended.json()).toEqual([]);
    expect((await app.inject({ url: `/api/accounts/${sam.id}/sessions`, headers: as(member) })).statusCode).toBe(401);
  });

  it('makes no setup codes before the owner has set up the server', async () => {
    const { app } = await setup({ claimed: false });
    const headers = { 'x-playarr': '1' };
    expect((await app.inject({ url: '/api/accounts', headers })).statusCode).toBe(200); // the home network, as before
    expect((await app.inject({ method: 'POST', url: '/api/accounts', headers, payload: { username: 'x', name: 'X', role: 'member', canRequest: false, sources: null } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/accounts/2/reset', headers })).statusCode).toBe(409);
  });
});
```

**Step 2: Run it to see it fail**

```bash
corepack pnpm -C apps/server exec vitest run src/routes/accounts.test.ts
```

Expected: FAIL: `./accounts.ts` not found.

**Step 3: Implement**

```ts
// apps/server/src/routes/accounts.ts
import type { CreatedAccount } from '@playarr/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AccountError, type Accounts } from '../accounts/accounts.ts';
import { originOf } from '../accounts/auth.ts';
import { isAdmin, requireAdmin } from '../accounts/rights.ts';
import type { Sessions } from '../accounts/sessions.ts';
import type { SetupCodes } from '../accounts/setupCodes.ts';
import { handleAccountErrors, parseInput } from './auth.ts';

const accountInput = z.object({
  username: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(40),
  role: z.enum(['admin', 'member']),
  canRequest: z.boolean(),
  sources: z.array(z.number().int().positive()).max(100).nullable(),
});
const accountPatch = accountInput.partial();

type Id = { Params: { id: string } };

/** Settings → Accounts: admins manage everyone; each account sees and signs out its own devices. */
export function accountRoutes(app: FastifyInstance, deps: { accounts: Accounts; sessions: Sessions; setupCodes: SetupCodes }) {
  const { accounts, sessions, setupCodes } = deps;
  // A code redeemed before the owner has a password would end setup mode and lock the owner out.
  const ownerFirst = async (_req: FastifyRequest, reply: FastifyReply) => {
    if (accounts.setupMode()) return reply.code(409).send({ error: 'Set up the owner’s account first (Settings → Accounts)' });
  };
  const self = (req: FastifyRequest, id: number) => !!req.auth?.session && req.auth.account.id === id;
  const known = (id: number) => {
    if (!accounts.get(id)) throw new AccountError('No such account', 404);
    return id;
  };

  app.get('/api/accounts', { onRequest: requireAdmin }, () => accounts.list());

  app.post('/api/accounts', { onRequest: [requireAdmin, ownerFirst] }, (req, reply) =>
    handleAccountErrors(reply, () => {
      const account = accounts.create(parseInput(accountInput, req.body));
      return reply.code(201).send({ account, setup: setupCodes.issue(account.id, originOf(req)) } satisfies CreatedAccount);
    }),
  );

  app.patch<Id>('/api/accounts/:id', (req, reply) =>
    handleAccountErrors(reply, () => {
      const id = Number(req.params.id);
      const patch = parseInput(accountPatch, req.body);
      const onlyName = Object.keys(patch).every((key) => key === 'name');
      if (!isAdmin(req) && !(self(req, id) && onlyName)) return reply.code(403).send({ error: 'Only an admin can change this' });
      return accounts.update(id, patch);
    }),
  );

  app.delete<Id>('/api/accounts/:id', { onRequest: requireAdmin }, (req, reply) =>
    handleAccountErrors(reply, () => {
      accounts.remove(Number(req.params.id));
      return accounts.list();
    }),
  );

  // A forgotten password: signed out everywhere, and a new code to choose another.
  app.post<Id>('/api/accounts/:id/reset', { onRequest: [requireAdmin, ownerFirst] }, (req, reply) =>
    handleAccountErrors(reply, () => {
      const id = known(Number(req.params.id));
      accounts.clearPassword(id);
      sessions.removeAll(id);
      return setupCodes.issue(id, originOf(req));
    }),
  );

  app.get<Id>('/api/accounts/:id/sessions', (req, reply) =>
    handleAccountErrors(reply, () => {
      const id = Number(req.params.id);
      if (!isAdmin(req) && !self(req, id)) return reply.code(403).send({ error: 'Only an admin can see this' });
      return sessions.list(known(id), req.auth?.session?.id);
    }),
  );

  app.delete<{ Params: { id: string; sessionId: string } }>('/api/accounts/:id/sessions/:sessionId', (req, reply) =>
    handleAccountErrors(reply, () => {
      const id = Number(req.params.id);
      if (!isAdmin(req) && !self(req, id)) return reply.code(403).send({ error: 'Only an admin can change this' });
      if (!sessions.remove(known(id), Number(req.params.sessionId))) throw new AccountError('No such session', 404);
      return sessions.list(id, req.auth?.session?.id);
    }),
  );
}
```

*As executed:* the test and the route use the shared `CreatedAccount` type (added in task 2) for `POST /api/accounts`'s answer.

**Step 4: Run the test again**

```bash
corepack pnpm -C apps/server exec vitest run src/routes/accounts.test.ts
corepack pnpm -C apps/server typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/server/src/routes/accounts.ts apps/server/src/routes/accounts.test.ts
git commit -m "$(cat <<'EOF'
Add account admin routes: create with a setup code, edit, reset, remove, sessions

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Wire accounts into the server; profiles go

**Files:**
- Modify: `apps/server/src/index.ts` (imports lines 39-41 and 54; lines 141-145; lines 156 onward: hook before the routes; lines 173-176; lines 177-188; after line 228)
- Modify: `apps/server/src/routes/mixes.ts` (lines 14-15, 17-32, 66-103, and every `who(req)`)
- Modify: `apps/server/src/mixes/history.ts`, `apps/server/src/mixes/mixes.ts`, `apps/server/src/mixes/stats.ts`, `apps/server/src/listenbrainz/scrobbler.ts` (rename `profile` to `account`)
- Delete: `apps/server/src/profiles/profiles.ts`, `apps/server/src/profiles/profiles.test.ts`, `apps/server/src/routes/profiles.ts`
- Test: `apps/server/src/accounts/listening.test.ts` (create; replaces the profiles test)

**Step 1: Write the failing test**

```ts
// apps/server/src/accounts/listening.test.ts
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Analyzer } from '../analysis/analyzer.ts';
import { CatalogStore } from '../catalog/store.ts';
import { freshDb } from '../catalog/testFixtures.ts';
import type { Library } from '../library/library.ts';
import { History } from '../mixes/history.ts';
import { Mixes } from '../mixes/mixes.ts';
import type { Playlists } from '../playlists.ts';
import { mixRoutes } from '../routes/mixes.ts';
import { Accounts } from './accounts.ts';
import { actAs, asAccount } from './testAccess.ts';

const tracks = Array.from({ length: 40 }, (_, i) => ({
  id: i + 1,
  recordingId: `rec-${i + 1}`,
  artistId: (i % 8) + 1,
  albumId: (i % 8) + 1,
  title: `Song ${i + 1}`,
  artistName: `Artist ${(i % 8) + 1}`,
  albumTitle: 'Album',
  duration: 200,
}));
const library = {
  version: 1,
  allTracks: async () => tracks,
  albums: async () => [],
  artists: async () => [],
  album: async () => undefined,
  track: async (id: number) => tracks.find((t) => t.id === id),
  trackByRecording: async (r: string) => tracks.find((t) => t.recordingId === r),
  tracksByRecordings: async (ids: string[]) => tracks.filter((t) => ids.includes(t.recordingId)),
  tracksByIds: async (ids: number[]) => tracks.filter((t) => ids.includes(t.id)),
  trackByName: async () => undefined,
} as unknown as Library;

function setup() {
  const db = freshDb();
  const store = new CatalogStore(db);
  const accounts = new Accounts(db);
  const sam = accounts.create({ username: 'sam', name: 'Sam', role: 'member', canRequest: false, sources: null });
  const history = new History(db, library);
  const analyzer = { ensure: vi.fn(), features: () => new Map(), meta: () => new Map(), mixSummaries: () => new Map(), progress: () => ({ features: 0, meta: 0, mixMaps: 0 }) } as unknown as Analyzer;
  const mixes = new Mixes({ db, store, library, analyzer, history, playlists: {} as Playlists, similar: async () => [], accounts: () => accounts.ids() });
  const app = Fastify();
  actAs(app, accounts.list());
  mixRoutes(app, { mixes, history, store, analysisAvailable: false, analyzeLibrary: vi.fn(), library, db });
  return { db, accounts, sam, history, mixes, app };
}

const play = (id: number, at = '2026-11-01T10:00:00Z') => ({ trackId: id, recordingId: `rec-${id}`, at, hour: 10, weekday: 0, seconds: 180, skipped: false });

describe('listening per account', () => {
  it('keeps each account’s plays, mixes and stats apart; the session decides, not the report', async () => {
    const { app, sam, history, mixes } = setup();
    const asSam = asAccount(sam.id);
    await app.inject({ method: 'POST', url: '/api/plays', headers: asSam, payload: { plays: tracks.slice(0, 20).flatMap((t) => [play(t.id), play(t.id, '2026-11-01T11:00:00Z')]) } });
    // An older player still names a profile: ignored.
    await app.inject({ method: 'POST', url: '/api/plays', headers: asSam, payload: { plays: [{ ...play(30), profile: 1 }] } });
    expect(history.since(3650, Date.parse('2026-11-02'), sam.id)).toHaveLength(41);
    expect(history.since(3650, Date.parse('2026-11-02'), 1)).toHaveLength(0);

    const repeat = async (account: number) => (await mixes.list('UTC', new Date('2026-11-01T12:00:00Z'), account)).find((m) => m.key === 'repeat');
    expect(await repeat(sam.id)).toBeDefined();
    expect(await repeat(1)).toBeUndefined();

    expect((await app.inject({ url: '/api/stats?range=all', headers: asSam })).json().plays).toBe(41);
    expect((await app.inject({ url: '/api/stats?range=all', headers: asAccount(1) })).json().plays).toBe(0);
  });

  it('takes an account’s history and mixes along when it’s removed', async () => {
    const { app, db, accounts, sam } = setup();
    await app.inject({ method: 'POST', url: '/api/plays', headers: asAccount(sam.id), payload: { plays: tracks.slice(0, 20).map((t) => play(t.id)) } });
    await app.inject({ url: '/api/mixes?tz=UTC', headers: asAccount(sam.id) });
    accounts.remove(sam.id);
    expect((db.prepare('SELECT COUNT(*) AS n FROM plays WHERE account_id = ?').get(sam.id) as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM mixes WHERE account_id = ?').get(sam.id) as { n: number }).n).toBe(0);
  });
});
```

**Step 2: Run it to see it fail**

```bash
corepack pnpm -C apps/server exec vitest run src/accounts/listening.test.ts
```

Expected: FAIL: `history.since(…, sam.id)` has length 0, because `mixRoutes` still decides the listener from `X-Playarr-Profile` (absent here) and records every play as account 1.

**Step 3: Implement**

Rename the profile parameters in the mixes, history, stats and ListenBrainz code (the SQL was renamed in task 1):

```bash
perl -pi -e 's/\bprofiles\b/accounts/g; s/(?<!public )\bprofile\b/account/g' apps/server/src/mixes/mixes.ts apps/server/src/mixes/history.ts apps/server/src/mixes/stats.ts apps/server/src/listenbrainz/scrobbler.ts
```

In `apps/server/src/listenbrainz/scrobbler.ts`, the comment on line 6 now reads "Each account's ListenBrainz account (the first account's under the plain key)"; replace it with:

```ts
/** Each account's ListenBrainz link (account 1's under the plain key, as before accounts). */
```

In `apps/server/src/mixes/history.ts`, `record` now reads `r.account ?? account,` (from `r.profile ?? profile,`). A report's own field no longer decides; replace that line with:

```ts
          account,
```

and its doc comment line `async record(reports: PlayReport[], account = 1)` stays as renamed.

In `apps/server/src/routes/mixes.ts`:

Replace lines 14-15:

```ts
import type { Profiles } from '../profiles/profiles.ts';
import { requireLocal } from './settings.ts';
```

with:

```ts
import { accountId } from '../accounts/rights.ts';
import { requireLocal } from './settings.ts';
```

Delete line 28 (`profile: z.number().int().positive().optional(),`) from `playsInput`: zod drops the field an older player still sends.

Delete the `profiles` dependency (line 81, `profiles?: Pick<Profiles, 'of' | 'ids'>;`) and replace lines 88-89:

```ts
  /** The listener a request is for (Settings → Profiles); 1 when there are no profiles. */
  const who = (req: FastifyRequest) => deps.profiles?.of(req) ?? 1;
```

with:

```ts
  /** The account a request is for (the session's; the owner's before setup). */
  const who = accountId;
```

Replace the body of `POST /api/plays` lines 96-100:

```ts
    // Each report says who was listening when it was played; a profile removed since counts as the device's now.
    const ids = new Set(deps.profiles?.ids() ?? [1]);
    const now = who(req);
    const plays = parsed.data.plays.map((p) => ({ ...p, profile: p.profile && ids.has(p.profile) ? p.profile : now }));
    const recorded = await history.record(plays, now);
```

with:

```ts
    // Whoever is signed in listened: the session decides.
    const recorded = await history.record(parsed.data.plays, who(req));
```

In `apps/server/src/index.ts`:

Replace lines 40-41:

```ts
import { Profiles } from './profiles/profiles.ts';
import { profileRoutes } from './routes/profiles.ts';
```

with:

```ts
import { Accounts } from './accounts/accounts.ts';
import { authHook } from './accounts/auth.ts';
import { Sessions } from './accounts/sessions.ts';
import { SetupCodes } from './accounts/setupCodes.ts';
import { accountRoutes } from './routes/accounts.ts';
import { authRoutes } from './routes/auth.ts';
```

Delete line 54 (`import { isFromApp } from './net.ts';`).

Replace lines 141-145:

```ts
const profiles = new Profiles(db);
const mixes = new Mixes({ db, store, library, analyzer, history, playlists, log: app.log, profiles: () => profiles.ids() });
mixes.start();
const scrobbler = new Scrobbler(db, store, library, { log: app.log, profiles: () => profiles.ids() });
scrobbler.start();
```

with:

```ts
// Who signs in: accounts with device sessions, and setup codes for first passwords.
const accounts = new Accounts(db);
const sessions = new Sessions(db);
const setupCodes = new SetupCodes(db);
const mixes = new Mixes({ db, store, library, analyzer, history, playlists, log: app.log, accounts: () => accounts.ids() });
mixes.start();
const scrobbler = new Scrobbler(db, store, library, { log: app.log, accounts: () => accounts.ids() });
scrobbler.start();
```

Insert before `apiRoutes(app, { config, lidarr, library, media, requestSettings });` (line 156):

```ts
// Every request's account (req.auth), from a Bearer token or the session cookie; 401 once set up.
app.decorateRequest('auth', null);
app.addHook('onRequest', authHook({ accounts, sessions }));
authRoutes(app, { accounts, sessions, setupCodes });
accountRoutes(app, { accounts, sessions, setupCodes });
```

Delete the old cross-site hook, lines 173-176 (the `X-Playarr` rule now lives in `authHook`):

```ts
// Changes only from Playarr's own pages (see isFromApp).
app.addHook('onRequest', async (req, reply) => {
  if (req.url.startsWith('/api/') && !isFromApp(req)) return reply.code(403).send({ error: 'Changes must come from Playarr itself' });
});
```

In the `mixRoutes(app, { … })` call delete the `profiles,` line, and delete `profileRoutes(app, { profiles });`.

After `app.log.info(\`Sources: …\`);` (line 228) add:

```ts
if (accounts.setupMode()) app.log.info('Nobody has set up Playarr yet: open Settings → Accounts from your home network to set the owner’s password');
```

Remove the profile files:

```bash
git rm apps/server/src/profiles/profiles.ts apps/server/src/profiles/profiles.test.ts apps/server/src/routes/profiles.ts
```

**Step 4: Run the tests again**

```bash
corepack pnpm -C apps/server exec vitest run src/accounts/listening.test.ts
corepack pnpm -C apps/server test
corepack pnpm -C apps/server typecheck
grep -rn "PROFILE_HEADER\|profileRoutes\|\bProfiles\b\|profile_id\|x-playarr-profile\|profiles/" apps/server/src --include='*.ts' | grep -v "^apps/server/src/db\(\.test\)\?\.ts:"
```

Expected: tests and typecheck PASS; the grep prints nothing (no listener profile is left on the server).

*As executed:* the grep needed `\bProfiles\b` (plain `Profiles\b` matches Lidarr's `qualityProfiles`/`metadataProfiles`) and to leave out `db.ts`/`db.test.ts`, whose old migrations and their tests name `profile_id` for good. The rename turned a comment in `mixes.ts` into "without a account"; fixed by hand. Between this task and task 21 the web's Settings → Profiles (and its `X-Playarr-Profile` header) talk to routes that no longer exist: `/api/profiles` answers 404 and plays count for the session's account. Checked live: the server started on a copy of a pre-accounts database, logged the setup-mode hint, kept Home's history for the owner, claimed from the home network only, then answered 401 `{ setup: false }` unsigned and took Bearer and cookie sessions.

**Step 5: Commit**

```bash
git add apps/server/src/index.ts apps/server/src/routes/mixes.ts apps/server/src/mixes/history.ts apps/server/src/mixes/mixes.ts apps/server/src/mixes/stats.ts apps/server/src/listenbrainz/scrobbler.ts apps/server/src/accounts/listening.test.ts
git commit -m "$(cat <<'EOF'
Wire accounts into the server and drop profiles

Every request now has an account: its session's, or the owner's while
nobody has a password. Plays, mixes, stats and ListenBrainz follow it;
the X-Playarr-Profile header and a report's profile are ignored.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Admins instead of the home network

**Files:**
- Modify: `apps/server/src/routes/settings.ts` (line 16, lines 116-121, line 162, line 165)
- Modify: `apps/server/src/routes/api.ts` (line 7, line 63, line 68)
- Modify: `apps/server/src/routes/mixMaps.ts` (line 7, line 69)
- Modify: `apps/server/src/routes/metadata.ts` (line 9, lines 24-27, line 76)
- Modify: `apps/server/src/routes/mixes.ts` (the import from task 8, lines 156-195)
- Modify: `apps/server/src/routes/discover.ts` (lines 68 and 84)
- Test: `apps/server/src/routes/settings.test.ts`, `apps/server/src/mixes/mixes.test.ts`, `apps/server/src/library/trackMetadata.test.ts` (add tests), `apps/server/src/routes/discover.test.ts` (create)

`requireLocal` becomes `requireAdmin` everywhere; Mixes splits into the server-wide settings (admin) and your own history and ListenBrainz (`requireOwn`); requests need `canRequest`, and `/api/health` tells each account whether to show Request buttons.

**Step 1: Write the failing tests**

Add to `apps/server/src/routes/settings.test.ts` (import `account`, `actAs`, `asAccount` from `'../accounts/testAccess.ts'`), inside `describe('settings routes', …)`:

```ts
  it('lets admin accounts change settings from anywhere, and members from nowhere', async () => {
    const { app } = setup();
    actAs(app, [account(1, { role: 'admin' }), account(2)]);
    expect((await app.inject({ method: 'GET', url: '/api/settings/folders', headers: asAccount(2), remoteAddress: HOME })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/settings/folders', headers: asAccount(1), remoteAddress: AWAY })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/settings/sources', headers: asAccount(2), remoteAddress: HOME })).json().canEdit).toBe(false);
    expect((await app.inject({ method: 'GET', url: '/api/settings/sources', headers: asAccount(1), remoteAddress: AWAY })).json().canEdit).toBe(true);
  });
```

Add to `apps/server/src/mixes/mixes.test.ts` (same imports), inside `describe('Mixes', …)`:

```ts
  it('lets every account see and clear its own history, and only admins change the mixes', async () => {
    const { app } = setup();
    actAs(app, [account(1, { role: 'admin' }), account(2)]);
    expect((await app.inject({ url: '/api/settings/mixes', headers: asAccount(2), remoteAddress: AWAY })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url: '/api/settings/mixes', headers: asAccount(2), payload: { length: 75 } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: '/api/settings/mixes', headers: asAccount(1), payload: { length: 75 }, remoteAddress: AWAY })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: '/api/settings/mixes/history', headers: asAccount(2), remoteAddress: AWAY })).statusCode).toBe(200);
  });
```

Add to `apps/server/src/library/trackMetadata.test.ts` (same imports), inside `describe('POST /api/files/:fileId/rematch', …)`:

```ts
  it('is for admins once there are accounts, and shows them paths from anywhere', async () => {
    const { app, folderCopy } = withRoutes();
    actAs(app, [account(1, { role: 'admin' }), account(2)]);
    expect((await app.inject({ method: 'POST', url: `/api/files/${folderCopy.id}/rematch`, headers: asAccount(2), remoteAddress: '192.168.1.20' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/files/${folderCopy.id}/rematch`, headers: asAccount(1), remoteAddress: '203.0.113.9' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/tracks/700/metadata', headers: asAccount(1), remoteAddress: '203.0.113.9' })).json().pathsHidden).toBe(false);
    expect((await app.inject({ url: '/api/tracks/700/metadata', headers: asAccount(2), remoteAddress: '192.168.1.20' })).json().pathsHidden).toBe(true);
  });
```

```ts
// apps/server/src/routes/discover.test.ts
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { account, actAs, asAccount } from '../accounts/testAccess.ts';
import type { Discover } from '../discover/discover.ts';
import type { Requests } from '../discover/requests.ts';
import { discoverRoutes } from './discover.ts';

const MBID = '11111111-1111-1111-1111-111111111111';

describe('requests', () => {
  it('are made and withdrawn only by accounts with the right', async () => {
    const requests = { list: () => [], request: vi.fn(async () => ({ mbid: MBID })), remove: vi.fn(async () => {}) } as unknown as Requests;
    const app = Fastify();
    actAs(app, [account(1, { canRequest: true }), account(2, { canRequest: false })]);
    discoverRoutes(app, { discover: {} as Discover, requests });
    const body = { artistName: 'Massive Attack', albumTitle: 'Mezzanine' };
    expect((await app.inject({ method: 'POST', url: '/api/requests', headers: asAccount(2), payload: body })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/requests/${MBID}`, headers: asAccount(2) })).statusCode).toBe(403);
    expect(requests.request).not.toHaveBeenCalled();
    expect((await app.inject({ method: 'POST', url: '/api/requests', headers: asAccount(1), payload: body })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/requests', headers: asAccount(2) })).statusCode).toBe(200);
  });
});
```

**Step 2: Run them to see them fail**

```bash
corepack pnpm -C apps/server exec vitest run src/routes/settings.test.ts src/mixes/mixes.test.ts src/library/trackMetadata.test.ts src/routes/discover.test.ts
```

Expected: FAIL: members get through (or admins away get 403) because every guard still checks the address.

**Step 3: Implement**

`apps/server/src/routes/settings.ts`: replace line 16 (`import { isLocalRequest } from '../net.ts';`) with:

```ts
import { isAdmin, requireAdmin } from '../accounts/rights.ts';
```

Delete lines 116-121 (`const isLocal = …` and `requireLocal`). Line 162 becomes `const editable = { onRequest: requireAdmin };` and line 165 becomes `const canEdit = isAdmin(req);`. Drop `FastifyRequest` from the `fastify` type import (nothing else in the file uses it; the typecheck doesn't flag unused imports).

`apps/server/src/routes/api.ts`: line 7 becomes:

```ts
import { canRequest, requireAdmin } from '../accounts/rights.ts';
```

`app.get('/api/health', async (): Promise<HealthStatus> => {` takes the request: `app.get('/api/health', async (req): Promise<HealthStatus> => {`, and its `requests:` line becomes:

```ts
      // Request buttons show only to accounts that may use them.
      requests: lidarr.configured && deps.requestSettings().enabled && canRequest(req),
```

Line 68: `app.post('/api/library/refresh', { onRequest: requireAdmin }, async () => {` and its comment `// A full rescan is heavy (every folder and Lidarr): for admins, like settings.`

`apps/server/src/routes/mixMaps.ts`: line 7 becomes `import { requireAdmin } from '../accounts/rights.ts';` and line 69 uses `{ onRequest: requireAdmin }`.

`apps/server/src/routes/metadata.ts`: line 9 becomes `import { isAdmin, requireAdmin } from '../accounts/rights.ts';`. Lines 23-27:

```ts
  // Show metadata → Match again. Changes the catalog, so the home network only, like Settings.
  app.post<{ Params: { fileId: string } }>('/api/files/:fileId/rematch', async (req, reply): Promise<RematchResult | void> => {
    if (!isLocalRequest(req)) {
      return reply.code(403).send({ error: 'Matching songs again works from your home network' });
    }
```

become:

```ts
  // Show metadata → Match again. Changes the catalog, so for admins, like Settings.
  app.post<{ Params: { fileId: string } }>('/api/files/:fileId/rematch', { onRequest: requireAdmin }, async (req, reply): Promise<RematchResult | void> => {
```

and line 76 (`isLocalRequest(req),`) becomes `isAdmin(req),`. Update the file's doc comment: `/** Track menu → Show metadata. File paths and source locations only for admins. */`.

`apps/server/src/routes/mixes.ts`: the import becomes:

```ts
import { accountId, requireAdmin, requireOwn } from '../accounts/rights.ts';
```

(remove `import { requireLocal } from './settings.ts';`). Replace lines 156-157:

```ts
  // Settings → Mixes: for everyone, changed from the home network like every setting.
  const editable = { onRequest: requireLocal };
```

with:

```ts
  // Settings → Mixes: how mixes are made is the server's (admins); the history and ListenBrainz are each account's.
  const adminOnly = { onRequest: requireAdmin };
  const own = { onRequest: requireOwn };
```

Then: `app.get('/api/settings/mixes', own, …)`, `app.put('/api/settings/mixes', adminOnly, …)`, and `own` for the four ListenBrainz routes and `app.delete('/api/settings/mixes/history', own, …)`.

`apps/server/src/routes/discover.ts`: add `import { requireCanRequest } from '../accounts/rights.ts';` and give the two changing routes the guard:

```ts
  app.post<{ Body: Partial<AlbumRef> }>('/api/requests', { onRequest: requireCanRequest }, async (req, reply) => {
```

```ts
  app.delete<{ Params: { mbid: string } }>('/api/requests/:mbid', { onRequest: requireCanRequest }, async (req, reply) => {
```

**Step 4: Run the tests again**

```bash
corepack pnpm -C apps/server test
corepack pnpm -C apps/server typecheck
grep -rn "requireLocal\|isLocalRequest" apps/server/src --include='*.ts' | grep -v "\.test\.ts"
```

Expected: PASS; the grep lists only `net.ts` (the definition), `accounts/rights.ts`, and `routes/auth.ts` (whose `requireLocalSetup` contains the string).

*As executed:* the plan's tests and guards fitted the code as written (helpers `setup()` and `withRoutes()`, `HOME`/`AWAY`, and `actAs` added after the routes all work: Fastify applies root hooks added before `ready`). Only the unused `FastifyRequest` import and the grep's third line differed.

**Step 5: Commit**

```bash
git add apps/server/src/routes/settings.ts apps/server/src/routes/api.ts apps/server/src/routes/mixMaps.ts apps/server/src/routes/metadata.ts apps/server/src/routes/mixes.ts apps/server/src/routes/discover.ts apps/server/src/routes/settings.test.ts apps/server/src/mixes/mixes.test.ts apps/server/src/library/trackMetadata.test.ts apps/server/src/routes/discover.test.ts
git commit -m "$(cat <<'EOF'
Let admins change settings, and accounts with the right request albums

The home-network rule stays for setup mode. Every account sees and clears
its own history and ListenBrainz link; only admins change how mixes are
made.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 9b: Setup-time answers: whose username it is, per-address rate limits, and setup links behind a proxy

Added by the coordinator after Tasks 1-9 ran, deciding three open questions.

**Files:**
- Modify: `apps/server/src/accounts/rateLimit.ts` (one key: the client address), `apps/server/src/routes/auth.ts` (sign-in and redeem count `req.ip` only; setup says whose username it is), `apps/server/src/accounts/accounts.ts` (`byUsername`)
- Modify: `apps/server/src/config.ts` (`PUBLIC_URL`, `TRUST_PROXY` → `trustProxy`), `apps/server/src/accounts/auth.ts` (`originOf(req, publicUrl?)`), `apps/server/src/routes/accounts.ts` (`publicUrl` dependency), `apps/server/src/index.ts` (`Fastify({ trustProxy })`, `publicUrl: config.PUBLIC_URL`)
- Modify: `.env.example` (two commented lines each for `TRUST_PROXY` and `PUBLIC_URL`, after `LOCAL_HOSTNAMES`; Task 23 does the rest)
- Test: `apps/server/src/accounts/rateLimit.test.ts` (rewritten), `apps/server/src/routes/auth.test.ts`, `apps/server/src/routes/accounts.test.ts`, `apps/server/src/config.test.ts` (create)

**a. The owner's username clashes with another account's.** Profiles became accounts with usernames (Task 1), so the name the owner picks at `/setup` may be someone else's. `POST /api/auth/setup` answers 409 `That username belongs to <display name>. Pick another; you can rename them later.` (`accounts.byUsername(username)`, any case; the owner's own current username is fine). So the setup page can pre-fill the owner's current username, `ServerInfo` gains `ownerUsername?: string`, present only while `setup` is true: that part lands with `GET /api/server` in Task 16 (shared type, conventions line and test in that commit), since the route doesn't exist before it.

**b. Rate limiting per client address only.** `RateLimiter` takes one key (`allows(address)`, `fail(address)`; `clear` goes: clearing on a success would let anyone with one account reset their budget and keep guessing others). Sign-in and redeem use `req.ip`. Fastify's `trustProxy` comes from `TRUST_PROXY`: unset/empty/`false` → off; `true` → any proxy; otherwise a comma-separated list of addresses, CIDRs or proxy-addr's range names (`loopback`, `linklocal`, `uniquelocal`) → `string[]`, anything else a configuration error. *Deviation:* hop counts are refused with a clear configuration error: Fastify 5.12 dropped `number` from `trustProxy`'s type and treats a number as trusting nobody (a visitor reaching the server directly could forge enough hops), so passing one through would silently do nothing.

**c. Setup-code links.** Origin = `PUBLIC_URL` when set (validated as an `http(s)` URL, trailing slashes removed); otherwise `${req.protocol}://${req.host}`, which Fastify computes from `X-Forwarded-Proto`/`-Host` only when the socket is a proxy trusted by `trustProxy`, and from the Host header and the socket's own protocol otherwise (`localhost` when there's no Host). The session cookie's `Secure` flag still follows `X-Forwarded-Proto` regardless (a forged header only makes the forger's own cookie stricter).

**Tests (written first, seen failing):**
- `rateLimit.test.ts`: an address is refused after `max` failures until they age out; two addresses don't share a budget.
- `auth.test.ts`: 10 failed sign-ins from one address → 429 there, 200 from another (the username isn't locked); redeem likewise (429 there, 400 elsewhere); with `Fastify({ trustProxy: true })`, failures count per `X-Forwarded-For` visitor; setup with another account's username (any case) → 409 with the message above and setup mode unchanged, then the owner's own username → 200.
- `accounts.test.ts` (`setup({ trustProxy, publicUrl })`, reset with `X-Forwarded-Host: music.example.com` and `-Proto: https`, Host `nas:4000`): `PUBLIC_URL` wins → `https://playarr.example.org/redeem`; trusted proxy → `https://music.example.com/redeem`; neither → `http://nas:4000/redeem`.
- `config.test.ts`: `TRUST_PROXY` parsing (off, `true`, list, bad entry and hop count rejected); `PUBLIC_URL` trailing slash removed, `ftp://` and scheme-less values rejected.

**Commit:** "Say whose username it is at setup, rate-limit sign-ins per address, and make setup links right behind a proxy".

---

### Task 10: Library views: each account's catalog

**Files:**
- Modify: `apps/server/src/library/library.ts` (whole file: the read methods move into `LibraryView`)
- Modify: `apps/server/src/catalog/testFixtures.ts` (append after `mezzanine()`, line 53)
- Modify: `apps/server/src/accounts/testAccess.ts` (append `twoSources`)
- Modify: `apps/server/src/accounts/rights.ts` (append `sourcesOf`, `libraryOf`, `visibleRecordings`)
- Test: `apps/server/src/library/library.test.ts`, `apps/server/src/accounts/rights.test.ts` (add tests)

See "Key decisions": a view is the catalog built from the same rows with only the account's sources, one per distinct source set, rebuilt when the library's version moves.

**Step 1: Write the failing tests**

Append to `apps/server/src/catalog/testFixtures.ts`:

```ts
/** The Creative Commons song's recording id (a folder song MusicBrainz doesn't know). */
export const CC_REC = 'local:00000000000000cc';

/** A folder with one Creative Commons album: one artist, one song, one MP3 copy. */
export function creativeCommons(): SourceSync {
  return {
    artists: [{ key: 'name:kevin macleod', preferredId: 8, name: 'Kevin MacLeod', sortName: 'MacLeod, Kevin', genres: [] }],
    albums: [
      { key: 'name:kevin macleod|royalty free', preferredId: 80, artistKey: 'name:kevin macleod', title: 'Royalty Free', albumType: 'Album', secondaryTypes: [], genres: [] },
    ],
    tracks: [
      { key: 'name:kevin macleod|royalty free#1', preferredId: 800, albumKey: 'name:kevin macleod|royalty free', recordingId: CC_REC, title: 'Sneaky Snitch', trackNumber: 1, discNumber: 1, duration: 136, explicit: false },
    ],
    copies: [
      { ref: 'Kevin MacLeod/Royalty Free/01.mp3', preferredId: 9100, trackKey: 'name:kevin macleod|royalty free#1', path: '/cc/Kevin MacLeod/Royalty Free/01.mp3', size: 5_000_000, format: MP3, addedAt: '2026-10-05T10:00:00Z' },
    ],
  };
}
```

Append to `apps/server/src/accounts/testAccess.ts` (and add its imports at the top):

```ts
import { CatalogStore } from '../catalog/store.ts';
import { creativeCommons, freshDb, mezzanine } from '../catalog/testFixtures.ts';
import { Library } from '../library/library.ts';
```

```ts
/**
 * A library of two sources: Lidarr with Mezzanine (album 70, songs 700 and 701, files 9000 and 9001,
 * cover /art/album/70/cover) and a folder of Creative Commons music (one song, CC_REC).
 */
export async function twoSources() {
  const db = freshDb();
  const store = new CatalogStore(db);
  const lidarr = store.addSource('lidarr', 'Lidarr');
  const cc = store.addSource('folder', 'Creative Commons');
  const mezz = mezzanine();
  const withCover = { ...mezz, albums: mezz.albums.map((a) => ({ ...a, coverUrl: '/art/album/70/cover' })) };
  const library = new Library(
    store,
    () => [
      { id: lidarr, source: { kind: 'lidarr', sync: async () => withCover } },
      { id: cc, source: { kind: 'folder', sync: async () => creativeCommons() } },
    ],
    { info: () => {}, error: () => {} },
  );
  await library.refresh();
  return { db, store, library, lidarr, cc };
}
```

Add to `apps/server/src/library/library.test.ts` (imports: `MP3, CC_REC` from `'../catalog/testFixtures.ts'`, `type SourceSync` from `'../catalog/types.ts'`, `twoSources` from `'../accounts/testAccess.ts'`):

```ts
describe('library views', () => {
  it('shows only the songs with a copy in the view’s sources, and their albums and artists', async () => {
    const { library, lidarr, cc } = await twoSources();
    const ccOnly = library.view([cc]);
    expect((await ccOnly.artists()).map((a) => a.name)).toEqual(['Kevin MacLeod']);
    expect((await ccOnly.albums()).map((a) => a.title)).toEqual(['Royalty Free']);
    expect((await ccOnly.allTracks()).map((t) => t.recordingId)).toEqual([CC_REC]);
    expect(await ccOnly.album(70)).toBeUndefined();
    expect(await ccOnly.artist(7)).toBeUndefined();
    expect(await ccOnly.track(700)).toBeUndefined();
    expect(await ccOnly.trackByRecording('rec-1')).toBeUndefined();
    expect(await ccOnly.file(9000)).toBeUndefined();
    expect(await ccOnly.search('angel')).toEqual({ artists: [], albums: [], tracks: [] });
    expect((await ccOnly.stats())?.tracks).toBe(1);
    expect(await ccOnly.hasArtwork('album', 70)).toBe(false);
    expect(await library.hasArtwork('album', 70)).toBe(true);
    expect((await library.view([lidarr]).albums()).map((a) => a.title)).toEqual(['Mezzanine']);
    expect(library.view(null)).toBe(library);
    expect(await library.allTracks()).toHaveLength(3);
  });

  it('builds a view once per snapshot, shared by every account with the same sources', async () => {
    const { library, lidarr, cc } = await twoSources();
    expect(library.view([cc, lidarr])).toBe(library.view([lidarr, cc]));
    const view = library.view([cc]);
    const first = await view.allTracks();
    expect(await view.allTracks()).toBe(first);
    library.reload();
    expect(await view.allTracks()).not.toBe(first);
    expect(view.version).toBe(library.version);
    expect(view.sources).toEqual([cc]);
  });

  it('plays the best copy the view’s sources have', async () => {
    const store = new CatalogStore(freshDb());
    const lidarr = store.addSource('lidarr', 'Lidarr');
    const cc = store.addSource('folder', 'Creative Commons');
    const mezz = mezzanine();
    const angel = mezz.tracks.find((t) => t.recordingId === 'rec-1')!;
    const alsoHere: SourceSync = {
      artists: mezz.artists,
      albums: mezz.albums,
      tracks: [angel],
      copies: [{ ref: 'angel.mp3', trackKey: angel.key, path: '/cc/angel.mp3', size: 9_000_000, format: MP3 }],
    };
    const library = new Library(
      store,
      () => [
        { id: lidarr, source: { kind: 'lidarr', sync: async () => mezz } },
        { id: cc, source: { kind: 'folder', sync: async () => alsoHere } },
      ],
      log,
    );
    await library.refresh();
    expect((await library.track(700))?.fileId).toBe(9000); // lossless wins
    const mp3 = (await library.view([cc]).track(700))!;
    expect(mp3.format.codec).toBe('MP3');
    expect(await library.view([cc]).file(9000)).toBeUndefined();
    expect(await library.view([cc]).file(mp3.fileId)).toMatchObject({ sourceId: cc });
  });
});
```

Add to `apps/server/src/accounts/rights.test.ts` (imports: `type FastifyRequest` from `'fastify'`, `libraryOf, visibleRecordings` from `'./rights.ts'`, `twoSources` from `'./testAccess.ts'`, `CC_REC` from `'../catalog/testFixtures.ts'`):

```ts
describe('libraryOf', () => {
  it('narrows the library to the account’s sources, and leaves it whole otherwise', async () => {
    const { library, cc } = await twoSources();
    const as = (sources: number[] | null) => ({ auth: { setup: false, account: account(2, { sources }), session: null } }) as unknown as FastifyRequest;
    expect(libraryOf(library, as(null))).toBe(library);
    expect(libraryOf(library, {} as FastifyRequest)).toBe(library);
    expect(libraryOf(library, as([cc])).sources).toEqual([cc]);
    expect(await visibleRecordings(library, as([cc]), ['rec-1', CC_REC])).toEqual([CC_REC]);
    expect(await visibleRecordings(library, as(null), ['rec-1', 'gone'])).toEqual(['rec-1', 'gone']);
    expect(() => libraryOf({ track: async () => undefined }, as([cc]))).toThrow(/narrowed/);
  });
});
```

**Step 2: Run them to see them fail**

```bash
corepack pnpm -C apps/server exec vitest run src/library/library.test.ts src/accounts/rights.test.ts
```

Expected: FAIL: `library.view is not a function`, `libraryOf` not exported.

**Step 3: Implement**

Replace `apps/server/src/library/library.ts` with:

```ts
import type { Album, AlbumDetail, AlbumSort, Artist, ArtistDetail, LibraryStats, SearchResults, Track } from '@playarr/shared';
import { buildCatalog, type Catalog, type FileRecord, type LidarrAlbumRef } from '../catalog/build.ts';
import type { CatalogRows, CatalogStore } from '../catalog/store.ts';
import type { CatalogSource } from '../catalog/types.ts';
import { albumKey, normalize, primaryArtist, scoreMatch } from './search.ts';

export type { FileRecord, LidarrAlbumRef };

/** The sources a view shows (Settings → Accounts), or null for every source. */
export type SourceFilter = readonly number[] | null;

export interface Snapshot extends Catalog {
  albumIdByKey: Map<string, number>;
  trackById: Map<number, Track>;
  trackByRecording: Map<string, Track>;
  trackByName: Map<string, Track>;
  /** `album/<id>` and `artist/<id>` of every /art/… URL the snapshot's albums and artists use. */
  artwork: Set<string>;
}

/**
 * The library as someone may see it. The Library itself shows every source; `library.view(sources)`
 * shows only the songs with a copy in those sources, built from those copies alone, so albums, artists,
 * search, files and artwork outside them don't exist for whoever reads it (an account's library access).
 */
export abstract class LibraryView {
  /** Goes up with every new snapshot, so others can tell when what they derived from it is out of date. */
  abstract readonly version: number;
  /** The sources shown, in id order; null for every source. */
  abstract readonly sources: SourceFilter;
  /** The snapshot, waiting for the first one if need be. */
  protected abstract ready(): Promise<Snapshot>;
  /** The snapshot, if there is one yet, without waiting. */
  protected abstract current(): Snapshot | null;

  /** Every artwork URL the library references (for cache warming). */
  artworkUrls(): string[] {
    const snap = this.current();
    if (!snap) return [];
    const urls = [
      ...[...snap.albums.values()].map((a) => a.coverUrl),
      ...[...snap.artists.values()].flatMap((a) => [a.imageUrl, a.fanartUrl, a.logoUrl]),
    ];
    return [...new Set(urls.filter((u): u is string => !!u))];
  }

  /** Whether an album or artist of this view uses /art/<kind>/<id>/… artwork. */
  async hasArtwork(kind: 'album' | 'artist', id: number): Promise<boolean> {
    return (await this.ready()).artwork.has(`${kind}/${id}`);
  }

  async albumByMbid(mbid: string): Promise<LidarrAlbumRef | undefined> {
    return (await this.ready()).albumsByMbid.get(mbid);
  }

  async trackByRecording(recordingId: string): Promise<Track | undefined> {
    return (await this.ready()).trackByRecording.get(recordingId);
  }

  /** A library track for this song by name, e.g. a different recording (single vs. album version). */
  async trackByName(artistName: string, title: string): Promise<Track | undefined> {
    const index = (await this.ready()).trackByName;
    return index.get(songKey(artistName, title)) ?? index.get(songKey(primaryArtist(artistName), title));
  }

  /** Playable album matching an artist + title from another source (e.g. Deezer). */
  async albumIdByName(artistName: string, albumTitle: string): Promise<number | undefined> {
    return (await this.ready()).albumIdByKey.get(albumKey(artistName, albumTitle));
  }

  async artistIdByMbid(mbid: string): Promise<number | undefined> {
    return (await this.ready()).artistIdByMbid.get(mbid);
  }

  /** Library artist by name (ignoring case and accents), with its MusicBrainz id. */
  async artistByName(name: string): Promise<{ id: number; mbid: string } | undefined> {
    const snap = await this.ready();
    const want = normalize(name);
    for (const [mbid, id] of snap.artistIdByMbid) {
      if (normalize(snap.artists.get(id)?.name ?? '') === want) return { id, mbid };
    }
    return undefined;
  }

  async stats(): Promise<LibraryStats | undefined> {
    return this.current()?.stats;
  }

  async artists(): Promise<Artist[]> {
    const snap = await this.ready();
    return [...snap.artists.values()].sort(bySortName);
  }

  async artist(id: number): Promise<ArtistDetail | undefined> {
    const snap = await this.ready();
    const artist = snap.artists.get(id);
    if (!artist) return undefined;
    const albums = [...snap.albums.values()]
      .filter((a) => a.artistId === id)
      .map(stripAlbum)
      .sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? ''));
    return { ...artist, albums };
  }

  async artistTracks(id: number): Promise<Track[]> {
    const snap = await this.ready();
    return [...snap.albums.values()]
      .filter((a) => a.artistId === id)
      .sort((a, b) => (a.releaseDate ?? '').localeCompare(b.releaseDate ?? ''))
      .flatMap((a) => a.tracks);
  }

  async albums(sort: AlbumSort = 'artist', limit?: number): Promise<Album[]> {
    const snap = await this.ready();
    const list = [...snap.albums.values()].map(stripAlbum);
    const cmp: Record<AlbumSort, (a: Album, b: Album) => number> = {
      title: (a, b) => a.title.localeCompare(b.title),
      artist: (a, b) => {
        const aa = snap.artists.get(a.artistId);
        const ba = snap.artists.get(b.artistId);
        return (aa && ba ? bySortName(aa, ba) : 0) || (a.releaseDate ?? '').localeCompare(b.releaseDate ?? '');
      },
      year: (a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? ''),
      added: (a, b) => (b.addedAt ?? '').localeCompare(a.addedAt ?? ''),
    };
    list.sort(cmp[sort]);
    return limit ? list.slice(0, limit) : list;
  }

  async randomAlbums(count: number): Promise<Album[]> {
    const snap = await this.ready();
    return shuffle([...snap.albums.values()]).slice(0, count).map(stripAlbum);
  }

  async randomTracks(count: number): Promise<Track[]> {
    const snap = await this.ready();
    return shuffle([...snap.tracks]).slice(0, count);
  }

  async track(id: number): Promise<Track | undefined> {
    return (await this.ready()).trackById.get(id);
  }

  /** Every song in the library, album by album. */
  async allTracks(): Promise<Track[]> {
    return (await this.ready()).tracks;
  }

  /** The library's song for each recording, in this order, leaving out those no longer in the library. */
  async tracksByRecordings(ids: string[]): Promise<Track[]> {
    const index = (await this.ready()).trackByRecording;
    return ids.flatMap((id) => index.get(id) ?? []);
  }

  /** These songs, in this order, leaving out any no longer in the library. */
  async tracksByIds(ids: number[]): Promise<Track[]> {
    const index = (await this.ready()).trackById;
    return ids.flatMap((id) => index.get(id) ?? []);
  }

  async album(id: number): Promise<AlbumDetail | undefined> {
    const snap = await this.ready();
    return snap.albums.get(id);
  }

  async file(fileId: number): Promise<FileRecord | undefined> {
    const snap = await this.ready();
    return snap.files.get(fileId);
  }

  async search(query: string, limit = 20): Promise<SearchResults> {
    const snap = await this.ready();
    const q = normalize(query);
    if (!q) return { artists: [], albums: [], tracks: [] };

    const rank = <T>(items: Iterable<T>, fields: (item: T) => string[]) =>
      [...items]
        .map((item) => ({ item, score: Math.max(...fields(item).map((f) => scoreMatch(q, f))) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((r) => r.item);

    return {
      artists: rank(snap.artists.values(), (a) => [a.name]),
      albums: rank(snap.albums.values(), (a) => [a.title, `${a.artistName} ${a.title}`]).map(stripAlbum),
      tracks: rank(snap.tracks, (t) => [t.title, `${t.artistName} ${t.title}`]),
    };
  }
}

/** The whole library: every enabled source, synced into the catalog and served from memory. */
export class Library extends LibraryView {
  readonly sources = null;
  version = 0;
  lastError: string | null = null;
  private snapshot: Snapshot | null = null;
  /** The rows the snapshot was built from: views build theirs from the same rows. */
  private rows: CatalogRows | null = null;
  /** One view per distinct set of sources, shared by every account with that set. */
  private readonly views = new Map<string, LibraryView>();
  private inflight: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private rebuildTimer: NodeJS.Timeout | null = null;
  private listeners: ((library: Library) => void)[] = [];

  constructor(
    private readonly store: CatalogStore,
    /** The sources to sync, read on every refresh (Settings can change them). */
    private readonly syncSources: () => { id: number; source: CatalogSource }[],
    private readonly log: { info: (msg: string) => void; error: (msg: string) => void },
  ) {
    super();
  }

  /** The library as an account with these sources sees it; the whole library for null. */
  view(sources: SourceFilter): LibraryView {
    if (sources === null) return this;
    const ids = [...new Set(sources)].sort((a, b) => a - b);
    const key = ids.join(',');
    let view = this.views.get(key);
    if (!view) {
      view = new SourceView(ids, { version: () => this.version, rows: () => this.rows, ready: () => this.ready() });
      this.views.set(key, view);
    }
    return view;
  }

  protected current(): Snapshot | null {
    return this.snapshot;
  }

  protected async ready(): Promise<Snapshot> {
    if (!this.snapshot) await this.refresh();
    return this.snapshot!;
  }

  private setSnapshot(rows: CatalogRows) {
    this.rows = rows;
    this.snapshot = toSnapshot(buildCatalog(rows));
    this.version++;
  }

  /** Called after every successful refresh. */
  onRefresh(listener: (library: Library) => void) {
    this.listeners.push(listener);
  }

  /** Serve the catalog saved by a previous run, so a restart doesn't wait on the sources. */
  loadStored(): boolean {
    if (!this.store.hasData()) return false;
    this.setSnapshot(this.store.load());
    this.log.info(`Library loaded from the database: ${this.snapshot!.stats.albums} albums`);
    return true;
  }

  /** True while the sources are syncing. */
  get refreshing(): boolean {
    return this.inflight !== null;
  }

  /** Rebuild from the stored catalog without syncing, e.g. after a source was removed or reordered. */
  reload() {
    this.setSnapshot(this.store.load());
    for (const listener of this.listeners) listener(this);
  }

  startAutoRefresh(minutes: number) {
    this.timer = setInterval(() => void this.refresh().catch(() => {}), minutes * 60_000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Sync every source (or just `only`; the others keep their last sync) into the catalog and rebuild.
   * Concurrent callers share one refresh.
   */
  refresh(only?: number): Promise<void> {
    const started = Date.now();
    this.inflight ??= this.build(only)
      .then((rows) => {
        this.setSnapshot(rows);
        this.lastError = null;
        const s = this.snapshot!.stats;
        this.log.info(
          `Library refreshed: ${s.artists} artists, ${s.albums} albums, ${s.tracks} tracks in ${((Date.now() - started) / 1000).toFixed(1)}s`,
        );
        for (const listener of this.listeners) listener(this);
      })
      .catch((err: Error) => {
        this.lastError = err.message;
        this.log.error(`Library refresh failed: ${err.message}`);
        throw err;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async build(only?: number): Promise<CatalogRows> {
    const sources = this.syncSources().filter((s) => only === undefined || s.id === only);
    const failures: Error[] = [];
    // In Settings order: later sources match their files against what earlier ones reported.
    for (const { id, source } of sources) {
      try {
        this.store.applySync(id, await source.sync());
        this.store.setSyncError(id, null);
      } catch (err) {
        this.store.setSyncError(id, (err as Error).message);
        failures.push(err as Error);
      }
    }
    // One unreachable source shouldn't hide the others: its last sync stays in the catalog.
    if (failures.length && failures.length === sources.length) throw failures[0];
    for (const err of failures) this.log.error(`A source failed to sync: ${err.message}`);
    return this.store.load();
  }

  /**
   * Rebuild from what the sources reported last, without scanning folders or asking Lidarr again: for
   * when only matches changed. Runs after any refresh in progress.
   */
  async rebuild(): Promise<void> {
    await this.inflight?.catch(() => {});
    const started = Date.now();
    for (const { id, source } of this.syncSources()) {
      if (!source.cached) continue;
      try {
        this.store.applySync(id, source.cached());
      } catch (err) {
        this.log.error(`Rebuilding a source failed: ${(err as Error).message}`);
      }
    }
    this.setSnapshot(this.store.load());
    this.log.info(`Library rebuilt from the last scan in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    for (const listener of this.listeners) listener(this);
  }

  /** Rebuild soon (see rebuild), coalescing bursts such as matches landing album after album. */
  rebuildSoon(delayMs = 10_000) {
    if (this.rebuildTimer) return;
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      void this.rebuild().catch(() => {});
    }, delayMs);
    this.rebuildTimer.unref?.();
  }

  /** Refresh soon, coalescing bursts (e.g. several downloads finishing together). */
  refreshSoon(delayMs = 3000) {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh().catch(() => {});
    }, delayMs);
  }
}

/** Some sources only: the catalog built from their copies, made once per library snapshot. */
class SourceView extends LibraryView {
  private built: { version: number; snap: Snapshot } | null = null;

  constructor(
    readonly sources: readonly number[],
    private readonly library: { version: () => number; rows: () => CatalogRows | null; ready: () => Promise<unknown> },
  ) {
    super();
  }

  get version(): number {
    return this.library.version();
  }

  protected current(): Snapshot | null {
    const rows = this.library.rows();
    if (!rows) return null;
    const version = this.library.version();
    if (this.built?.version !== version) {
      const keep = new Set(this.sources);
      this.built = { version, snap: toSnapshot(buildCatalog({ ...rows, sources: rows.sources.filter((s) => keep.has(s.id)) })) };
    }
    return this.built.snap;
  }

  protected async ready(): Promise<Snapshot> {
    await this.library.ready();
    return this.current()!;
  }
}

function toSnapshot(catalog: Catalog): Snapshot {
  return {
    ...catalog,
    albumIdByKey: new Map([...catalog.albums.values()].map((a) => [albumKey(a.artistName, a.title), a.id])),
    trackById: new Map(catalog.tracks.map((t) => [t.id, t])),
    trackByRecording: indexByRecording(catalog.tracks),
    trackByName: indexByName(catalog.tracks),
    artwork: artworkKeys(catalog),
  };
}

const ART_URL = /^\/art\/(artist|album)\/(\d+)\//;

/** `album/<id>` and `artist/<id>` for the /art/… URLs the catalog's albums and artists use. */
function artworkKeys(catalog: Catalog): Set<string> {
  const keys = new Set<string>();
  const add = (url: string | undefined) => {
    const m = url?.match(ART_URL);
    if (m) keys.add(`${m[1]}/${m[2]}`);
  };
  for (const a of catalog.albums.values()) add(a.coverUrl);
  for (const a of catalog.artists.values()) for (const url of [a.imageUrl, a.fanartUrl, a.logoUrl]) add(url);
  return keys;
}

/** An album as lists show it: no tracks, text or missing songs (those are on its own page, and lists are big). */
export function stripAlbum({ tracks: _t, overview: _o, discCount: _d, missingTracks: _m, ...album }: AlbumDetail): Album {
  return album;
}

function bySortName(a: Artist, b: Artist) {
  return a.sortName.localeCompare(b.sortName, undefined, { sensitivity: 'base' });
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

export const songKey = (artistName: string, title: string) => `${normalize(artistName)}|${normalize(title)}`;

function indexByName(tracks: Track[]): Map<string, Track> {
  const map = new Map<string, Track>();
  for (const t of tracks) {
    for (const key of new Set([songKey(t.artistName, t.title), songKey(primaryArtist(t.artistName), t.title)])) {
      if (!map.has(key)) map.set(key, t);
    }
  }
  return map;
}

/** First (album-ordered) track for each recording; the same song can sit on several albums. */
function indexByRecording(tracks: Track[]): Map<string, Track> {
  const map = new Map<string, Track>();
  for (const t of tracks) if (!map.has(t.recordingId)) map.set(t.recordingId, t);
  return map;
}
```

Append to `apps/server/src/accounts/rights.ts` (and add `import type { LibraryView, SourceFilter } from '../library/library.ts';` at the top):

```ts
/** The sources the request's account may hear, or null for all of them (and without accounts). */
export const sourcesOf = (req: FastifyRequest): readonly number[] | null => req.auth?.account.sources ?? null;

type Narrowable = { view?: (sources: SourceFilter) => LibraryView };

/**
 * The library as the request's account may see it: the library itself when it may hear every source,
 * otherwise the view of its sources. A library that can't be narrowed is refused rather than shown whole.
 */
export function libraryOf<L extends object>(library: L & Narrowable, req: FastifyRequest): L | LibraryView {
  const sources = sourcesOf(req);
  if (sources === null) return library;
  if (!library.view) throw new Error('This library can’t be narrowed to an account’s sources');
  return library.view(sources);
}

/** Those of these recordings the request's account may hear (all of them when it hears every source). */
export async function visibleRecordings(
  library: Pick<LibraryView, 'trackByRecording'> & Narrowable,
  req: FastifyRequest,
  ids: string[],
): Promise<string[]> {
  if (sourcesOf(req) === null) return ids;
  const view = libraryOf(library, req);
  const found = await Promise.all(ids.map((id) => view.trackByRecording(id)));
  return ids.filter((_, i) => found[i]);
}
```

**Step 4: Run the tests again**

```bash
corepack pnpm -C apps/server exec vitest run src/library/library.test.ts src/accounts/rights.test.ts
corepack pnpm -C apps/server test
corepack pnpm -C apps/server typecheck
```

Expected: PASS (every existing caller of `Library` is unchanged).

*As executed:* fitted the code as written (the constructor's `sources` parameter is renamed `syncSources`, since `sources` is now the view's filter). Measured (vitest, M-series Mac): on the two-source fixture a view builds in about 0.1 ms the first time and 0.04 ms after a reload; on synthetic libraries of 6,000 / 30,000 / 60,000 songs (two sources, 80/20), a full `reload()` (load the rows and build) takes 34 / 188 / 355 ms, a view of the small source 3 / 15 / 32 ms, a view of the big one 11 / 51 / 113 ms, and a cached view about 0.02 ms. The cost is linear in the rows (every copy is looked at) plus the songs kept, and is paid once per library change per distinct source set, on the first request that needs it.

**Step 5: Commit**

```bash
git add apps/server/src/library/library.ts apps/server/src/library/library.test.ts apps/server/src/catalog/testFixtures.ts apps/server/src/accounts/testAccess.ts apps/server/src/accounts/rights.ts apps/server/src/accounts/rights.test.ts
git commit -m "$(cat <<'EOF'
Add library views: the catalog built from only an account's sources

A view shows the songs with a copy in those sources, their albums and
artists, and plays the best copy among them. Views are built once per
snapshot and shared by accounts with the same sources.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: The catalog routes show each account its own library

**Files:**
- Modify: `apps/server/src/routes/api.ts` (lines 48-103)
- Modify: `apps/server/src/routes/metadata.ts` (lines 52-79)
- Modify: `apps/server/src/routes/lyrics.ts` (whole file)
- Modify: `apps/server/src/routes/levels.ts` (lines 46-86)
- Modify: `apps/server/src/routes/mixMaps.ts` (lines 25, 36-50, 79-87)
- Modify: `apps/server/src/index.ts` (the `lyricsRoutes(…)` call, line 169)
- Test: `apps/server/src/accounts/access.test.ts` (create; tasks 12 and 13 add to it)

**Step 1: Write the failing test**

```ts
// apps/server/src/accounts/access.test.ts
import type { Album, Artist, Track } from '@playarr/shared';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Analyzer } from '../analysis/analyzer.ts';
import { CatalogStore } from '../catalog/store.ts';
import { CC_REC, freshDb, mezzanine, MP3 } from '../catalog/testFixtures.ts';
import type { Config } from '../config.ts';
import type { LidarrClient } from '../lidarr/client.ts';
import { Library } from '../library/library.ts';
import type { MediaSource } from '../media/index.ts';
import { apiRoutes } from '../routes/api.ts';
import { levelRoutes } from '../routes/levels.ts';
import { lyricsRoutes } from '../routes/lyrics.ts';
import { metadataRoutes } from '../routes/metadata.ts';
import { mixMapRoutes } from '../routes/mixMaps.ts';
import { account, actAs, asAccount, twoSources } from './testAccess.ts';

/** Account 1 is an admin hearing everything; 2 hears only the Creative Commons folder; 3 only Lidarr. */
async function setup() {
  const lib = await twoSources();
  const app = Fastify();
  actAs(app, [account(1, { role: 'admin', canRequest: true }), account(2, { sources: [lib.cc] }), account(3, { sources: [lib.lidarr] })]);
  const get = (url: string, id: number) => app.inject({ url, headers: asAccount(id) });
  const post = (url: string, id: number, payload: object) => app.inject({ method: 'POST', url, headers: asAccount(id), payload });
  return { ...lib, app, get, post };
}

describe('library access: the catalog', () => {
  async function catalog() {
    const s = await setup();
    apiRoutes(s.app, {
      config: { pathMap: [] } as unknown as Config,
      lidarr: { configured: true, systemStatus: async () => ({ version: '2' }) } as unknown as LidarrClient,
      library: s.library,
      media: { kind: 'none', check: async () => {} } as unknown as MediaSource,
      requestSettings: () => ({ enabled: true, searchOnAdd: true }),
    });
    return s;
  }

  it('lists only the artists, albums and songs the account may hear', async () => {
    const { get } = await catalog();
    expect(((await get('/api/artists', 2)).json() as Artist[]).map((a) => a.name)).toEqual(['Kevin MacLeod']);
    expect((await get('/api/artists', 1)).json()).toHaveLength(2);
    expect(((await get('/api/albums', 2)).json() as Album[]).map((a) => a.title)).toEqual(['Royalty Free']);
    expect(((await get('/api/albums/random', 3)).json() as Album[]).map((a) => a.title)).toEqual(['Mezzanine']);
    expect(((await get('/api/tracks/random', 2)).json() as Track[]).map((t) => t.recordingId)).toEqual([CC_REC]);
  });

  it('answers 404 for an artist or album outside the account’s sources', async () => {
    const { get } = await catalog();
    expect((await get('/api/albums/70', 2)).statusCode).toBe(404);
    expect((await get('/api/albums/70', 3)).statusCode).toBe(200);
    expect((await get('/api/artists/7', 2)).statusCode).toBe(404);
    expect((await get('/api/artists/7/tracks', 2)).json()).toEqual([]);
  });

  it('searches only what the account may hear', async () => {
    const { get } = await catalog();
    expect((await get('/api/search?q=angel', 2)).json()).toEqual({ artists: [], albums: [], tracks: [] });
    expect(((await get('/api/search?q=angel', 3)).json().tracks as Track[]).map((t) => t.title)).toEqual(['Angel']);
  });

  it('counts the account’s own library in health, none before signing in, and shows Request buttons to those who may', async () => {
    const { app, get } = await catalog();
    expect((await get('/api/health', 2)).json()).toMatchObject({ library: { tracks: 1 }, requests: false });
    expect((await get('/api/health', 1)).json()).toMatchObject({ library: { tracks: 3 }, requests: true });
    expect((await app.inject({ url: '/api/health' })).json().library).toBeUndefined();
  });

  it('shows a song’s metadata only to accounts that may hear it, with only their copies', async () => {
    const store = new CatalogStore(freshDb());
    const lidarr = store.addSource('lidarr', 'Lidarr');
    const cc = store.addSource('folder', 'Creative Commons');
    const mezz = mezzanine();
    const angel = mezz.tracks.find((t) => t.recordingId === 'rec-1')!;
    const library = new Library(
      store,
      () => [
        { id: lidarr, source: { kind: 'lidarr', sync: async () => mezz } },
        { id: cc, source: { kind: 'folder', sync: async () => ({ artists: mezz.artists, albums: mezz.albums, tracks: [angel], copies: [{ ref: 'angel.mp3', trackKey: angel.key, path: '/cc/angel.mp3', size: 9_000_000, format: MP3 }] }) } },
      ],
      { info: () => {}, error: () => {} },
    );
    await library.refresh();
    const app = Fastify();
    actAs(app, [account(1), account(2, { sources: [cc] })]);
    metadataRoutes(app, { store, library, pathMap: [], features: () => new Map() });
    const all = (await app.inject({ url: '/api/tracks/700/metadata', headers: asAccount(1) })).json();
    expect(all.copies).toHaveLength(2);
    const theirs = (await app.inject({ url: '/api/tracks/700/metadata', headers: asAccount(2) })).json();
    expect(theirs.copies).toEqual([expect.objectContaining({ playing: true, source: expect.objectContaining({ id: cc }) })]);
    expect((await app.inject({ url: '/api/tracks/701/metadata', headers: asAccount(2) })).statusCode).toBe(404);
  });

  it('finds lyrics only for songs the account may hear', async () => {
    const s = await setup();
    const forTrack = vi.fn(async () => null);
    lyricsRoutes(s.app, { lyrics: { forTrack }, library: s.library });
    expect((await s.get('/api/tracks/700/lyrics', 2)).statusCode).toBe(404);
    expect(forTrack).not.toHaveBeenCalled();
    expect((await s.get('/api/tracks/700/lyrics', 3)).json()).toEqual({ lyrics: null });
  });

  it('levels only songs the account may hear, and measures nothing else for it', async () => {
    const s = await setup();
    const ensure = vi.fn();
    const measured = { recordingId: 'rec-1', fileId: 9000, lufs: -8, peak: -0.5, samples: 1, size: 1, mtimeMs: 1 };
    levelRoutes(s.app, { analyzer: { loudness: (ids) => new Map(ids.flatMap((id) => (id === 'rec-1' ? [[id, measured]] : []))), ensure, remeasureLoudness: vi.fn() }, library: s.library });
    expect((await s.post('/api/levels', 2, { ids: ['rec-1'] })).json()).toEqual({});
    expect(ensure).toHaveBeenCalledWith([], expect.objectContaining({ urgent: true }));
    expect((await s.post('/api/levels', 3, { ids: ['rec-1'] })).json()).toHaveProperty('rec-1');
  });

  it('gives mix maps and mix points only of songs the account may hear', async () => {
    const s = await setup();
    const ensure = vi.fn();
    const analyzer = {
      canAnalyzeAudio: true,
      mixMaps: (ids: string[]) => new Map(ids.map((id) => [id, { version: 1, duration: 200, bpm: 120 }])),
      cues: (ids: string[]) => new Map(ids.map((id) => [id, { mixIn: 1 }])),
      setCues: vi.fn(),
      ensure,
      analysisProgress: () => ({}),
      analyzeLibrary: vi.fn(),
      reanalyzeLibrary: vi.fn(),
    } as unknown as Analyzer;
    mixMapRoutes(s.app, { analyzer, library: s.library });
    expect(Object.keys((await s.post('/api/mix-maps', 2, { ids: ['rec-1', CC_REC] })).json())).toEqual([CC_REC]);
    expect(ensure).toHaveBeenCalledWith([CC_REC], expect.anything());
    // Account 3 hears only Lidarr: the Creative Commons song's mix points aren't there for it.
    const cues = `/api/recordings/${encodeURIComponent(CC_REC)}/cues`;
    expect((await s.get(cues, 3)).json()).toEqual({});
    expect((await s.get(cues, 2)).json()).toEqual({ mixIn: 1 });
    expect((await s.app.inject({ method: 'PUT', url: cues, headers: asAccount(3), payload: { mixIn: 2 } })).statusCode).toBe(404);
  });
});
```

**Step 2: Run it to see it fail**

```bash
corepack pnpm -C apps/server exec vitest run src/accounts/access.test.ts
```

Expected: FAIL: account 2 gets Mezzanine back everywhere; `lyricsRoutes` ignores `library`.

**Step 3: Implement**

`apps/server/src/routes/api.ts`: the import from task 9 becomes:

```ts
import { canRequest, libraryOf, requireAdmin } from '../accounts/rights.ts';
```

In `/api/health`, the `library:` line becomes:

```ts
      // What the asker may hear; nothing before signing in.
      library: req.auth === null ? undefined : await libraryOf(library, req).stats(),
```

Replace the catalog routes (lines 73-103) with:

```ts
  app.get('/api/artists', (req) => libraryOf(library, req).artists());

  app.get<{ Params: { id: string } }>('/api/artists/:id', async (req, reply) => {
    return (await libraryOf(library, req).artist(Number(req.params.id))) ?? notFound(reply, 'Artist');
  });

  app.get<{ Params: { id: string } }>('/api/artists/:id/tracks', (req) =>
    libraryOf(library, req).artistTracks(Number(req.params.id)),
  );

  app.get<{ Querystring: { sort?: string; limit?: string } }>('/api/albums', (req) => {
    const sort = ALBUM_SORTS.includes(req.query.sort as AlbumSort) ? (req.query.sort as AlbumSort) : 'artist';
    const limit = req.query.limit ? clampInt(req.query.limit, 50, 10_000) : undefined;
    return libraryOf(library, req).albums(sort, limit);
  });

  app.get<{ Querystring: { limit?: string } }>('/api/albums/random', (req) =>
    libraryOf(library, req).randomAlbums(clampInt(req.query.limit, 12, 100)),
  );

  app.get<{ Params: { id: string } }>('/api/albums/:id', async (req, reply) => {
    return (await libraryOf(library, req).album(Number(req.params.id))) ?? notFound(reply, 'Album');
  });

  app.get<{ Querystring: { limit?: string } }>('/api/tracks/random', (req) =>
    libraryOf(library, req).randomTracks(clampInt(req.query.limit, 50, 500)),
  );

  app.get<{ Querystring: { q?: string; limit?: string } }>('/api/search', (req) =>
    libraryOf(library, req).search(req.query.q ?? '', clampInt(req.query.limit, 20, 100)),
  );
```

`apps/server/src/routes/metadata.ts`: the import becomes `import { isAdmin, libraryOf, requireAdmin, sourcesOf } from '../accounts/rights.ts';`. Replace the metadata route (lines 52-79) with:

```ts
  app.get<{ Params: { id: string } }>('/api/tracks/:id/metadata', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'Bad track id' });
    const library = libraryOf(deps.library, req);
    const sources = sourcesOf(req);
    if (sources !== null && !(await library.track(id))) return reply.code(404).send({ error: 'Track not found' });
    const meta = await trackMetadata(
      {
        store: deps.store,
        library,
        pathMap: deps.pathMap,
        features: (recordingId) => {
          const f = deps.features([recordingId]).get(recordingId);
          return f
            ? {
                // Tempo and beat from beat analysis, once the song has one.
                ...(f.bpm > 0 ? { bpm: f.bpm, pulse: f.pulse } : {}),
                loudness: f.loudness,
                dynamics: f.dynamics,
                brightness: f.brightness,
                busyness: f.busyness,
                bass: f.bass,
              }
            : undefined;
        },
      },
      id,
      isAdmin(req),
    );
    if (!meta) return reply.code(404).send({ error: 'Track not found' });
    // Only the copies in the sources this account may hear.
    return sources === null ? meta : { ...meta, copies: meta.copies.filter((c) => sources.includes(c.source.id)) };
  });
```

Replace `apps/server/src/routes/lyrics.ts` with:

```ts
import type { FastifyInstance } from 'fastify';
import { libraryOf, sourcesOf } from '../accounts/rights.ts';
import type { Library } from '../library/library.ts';
import type { LyricsService } from '../lyrics/lyrics.ts';

/** Now Playing → Lyrics, for songs the account may hear. */
export function lyricsRoutes(
  app: FastifyInstance,
  deps: { lyrics: Pick<LyricsService, 'forTrack'>; library?: Pick<Library, 'track'> & Partial<Pick<Library, 'view'>> },
) {
  app.get<{ Params: { id: string } }>('/api/tracks/:id/lyrics', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(404).send({ error: 'Unknown song' });
    if (deps.library && sourcesOf(req) !== null && !(await libraryOf(deps.library, req).track(id))) {
      return reply.code(404).send({ error: 'Unknown song' });
    }
    try {
      const found = await deps.lyrics.forTrack(id);
      if (found === undefined) return reply.code(404).send({ error: 'Unknown song' });
      return reply.header('Cache-Control', 'private, max-age=3600').send({ lyrics: found });
    } catch (err) {
      req.log.warn({ err }, 'lyrics lookup failed');
      return reply.code(502).send({ error: 'Lyrics are unavailable right now' });
    }
  });
}
```

In `apps/server/src/index.ts`, the lyrics line becomes:

```ts
lyricsRoutes(app, { lyrics: new LyricsService(db, library, files, { log: app.log }), library });
```

`apps/server/src/routes/levels.ts`: add `import { libraryOf, visibleRecordings } from '../accounts/rights.ts';`; the deps' library type becomes `library: Pick<Library, 'trackByRecording' | 'album'> & Partial<Pick<Library, 'view'>>`; replace lines 53-60:

```ts
    const out: Record<string, TrackLevel> = {};
    const asked = [...new Set(parsed.data.ids)];
    const albumMates = new Set<string>();
    for (const id of asked) {
      const track = await deps.library.trackByRecording(id);
      if (!track) continue;
      const album = await deps.library.album(track.albumId);
```

with:

```ts
    const out: Record<string, TrackLevel> = {};
    // Songs outside the account's sources aren't there for it: neither levelled nor measured.
    const asked = await visibleRecordings(deps.library, req, [...new Set(parsed.data.ids)]);
    const albums = libraryOf(deps.library, req);
    const albumMates = new Set<string>();
    for (const id of asked) {
      // The whole library's copy: the one loudness analysis measures (see the remeasure check below).
      const track = await deps.library.trackByRecording(id);
      if (!track) continue;
      const album = await albums.album(track.albumId);
```

`apps/server/src/routes/mixMaps.ts`: add `import { visibleRecordings } from '../accounts/rights.ts';`; line 25's type becomes `library: Pick<Library, 'trackByRecording'> & Partial<Pick<Library, 'view'>>;`. In `POST /api/mix-maps`, `const ids = [...new Set(parsed.data.ids)];` becomes:

```ts
    // Only songs the account may hear: their maps, and their analysis.
    const ids = await visibleRecordings(library, req, [...new Set(parsed.data.ids)]);
```

`GET /api/recordings/:id/cues` becomes:

```ts
  app.get<{ Params: { id: string } }>('/api/recordings/:id/cues', async (req, reply) => {
    if (!RECORDING_ID.test(req.params.id)) return reply.code(400).send({ error: 'Invalid recording id' });
    if (!(await visibleRecordings(library, req, [req.params.id])).length) return {};
    return analyzer.cues([req.params.id]).get(req.params.id) ?? {};
  });
```

and in `PUT /api/recordings/:id/cues`, right after the `RECORDING_ID` check add:

```ts
    if (!(await visibleRecordings(library, req, [id])).length) return reply.code(404).send({ error: 'Song not found in the library' });
```

**Step 4: Run the tests again**

```bash
corepack pnpm -C apps/server exec vitest run src/accounts/access.test.ts
corepack pnpm -C apps/server test
corepack pnpm -C apps/server typecheck
```

Expected: PASS.

*As executed:* the code fitted as written once found by content (the cited line numbers were stale after Tasks 8-9).

**Step 5: Commit**

```bash
git add apps/server/src/routes/api.ts apps/server/src/routes/metadata.ts apps/server/src/routes/lyrics.ts apps/server/src/routes/levels.ts apps/server/src/routes/mixMaps.ts apps/server/src/index.ts apps/server/src/accounts/access.test.ts
git commit -m "$(cat <<'EOF'
Show each account only its own library: catalog, search, metadata, lyrics, levels

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---
### Task 12: Streams, artwork and transitions only for songs the account may hear

**Files:**
- Modify: `apps/server/src/routes/stream.ts` (lines 18-27)
- Modify: `apps/server/src/routes/art.ts` (lines 134, 196-198, 231-240)
- Modify: `apps/server/src/routes/transitions.ts` (lines 29-52, 63-70)
- Modify: `apps/server/src/transitions/transitions.ts` (`TransitionRequest` lines 141-170, `request` lines 305-306, add `recordingsOf` after `filePath` line 381)
- Modify: `apps/server/src/index.ts` (the `transitionRoutes(…)` call, line 168)
- Test: `apps/server/src/accounts/access.test.ts` (add), `apps/server/src/transitions/access.test.ts` (create)

`/stream/:fileId` (and its levelled WAV) and `/art/copy/:id` look the file up in the account's view, which has only the copies of its sources. `/art/:kind/:id/:type` serves only artwork a visible album or artist uses. A transition is planned from the account's view (its songs and their files) and its file is served only when both songs are visible.

**Step 1: Write the failing tests**

Add these imports to `apps/server/src/accounts/access.test.ts`:

```ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { FileResolver } from '../catalog/files.ts';
import { tempDir } from '../catalog/testFixtures.ts';
import { artRoutes, type LocalArt } from '../routes/art.ts';
import { streamRoutes } from '../routes/stream.ts';
import { transitionRoutes } from '../routes/transitions.ts';
import type { TransitionAnswer } from '../transitions/transitions.ts';
```

(`tempDir` joins the existing import from `'../catalog/testFixtures.ts'`.) Then add:

```ts
describe('library access: files', () => {
  const media = {
    kind: 'local',
    stat: async () => ({ size: 4, mtimeMs: 1 }),
    open: async () => Readable.from([Buffer.from('flac')]),
    pcmStream: () => Readable.from([Buffer.alloc(8)]),
  } as unknown as MediaSource;
  const files = { resolve: () => ({ media, path: '/music/song.flac' }) } as unknown as FileResolver;

  it('streams only files of songs the account may hear, levelled or not', async () => {
    const s = await setup();
    const measured = { recordingId: 'rec-1', fileId: 9000, lufs: -9, peak: -1, samples: 2, size: 4, mtimeMs: 1 };
    streamRoutes(s.app, { library: s.library, files, loudness: { loudnessOfFile: () => measured, remeasureLoudness: vi.fn() } });
    expect((await s.get('/stream/9000', 2)).json()).toEqual({ error: 'Unknown track file' });
    expect((await s.get('/stream/9000', 3)).statusCode).toBe(200);
    expect((await s.get('/stream/9000/levelled.wav?gain=0', 2)).json()).toEqual({ error: 'Unknown track file' });
    expect((await s.get('/stream/9000/levelled.wav?gain=0', 3)).statusCode).toBe(200);
  });

  it('serves artwork only of albums, artists and files the account may see', async () => {
    const s = await setup();
    const { dir, cleanup } = tempDir();
    try {
      const original = vi.fn(async () => ({ body: Buffer.from('jpeg'), mime: 'image/jpeg' }));
      artRoutes(s.app, { art: { original } as unknown as LocalArt, cacheDir: dir, library: s.library, files, folders: { get: () => undefined } });
      expect((await s.get('/art/album/70/cover', 2)).statusCode).toBe(404);
      expect(original).not.toHaveBeenCalled();
      expect((await s.get('/art/album/70/cover', 3)).body).toBe('jpeg');
      expect((await s.get('/art/copy/9000', 2)).json()).toEqual({ error: 'Unknown file' });
      // Account 3 may: the file is found, and only then turns out to have no folder to draw from.
      expect((await s.get('/art/copy/9000', 3)).json()).toEqual({ error: 'No artwork' });
    } finally {
      cleanup();
    }
  });

  it('plans transitions from the account’s songs, and serves a transition file only when it may hear both', async () => {
    const s = await setup();
    const { dir, cleanup } = tempDir();
    try {
      const both = 'a'.repeat(40);
      const ccOnly = 'c'.repeat(40);
      for (const key of [both, ccOnly]) writeFileSync(join(dir, `${key}.flac`), 'audio');
      const request = vi.fn(async (): Promise<TransitionAnswer> => ({ status: 'unavailable', reason: 'Unknown song' }));
      transitionRoutes(s.app, {
        transitions: {
          request,
          filePath: (name) => join(dir, name),
          recordingsOf: (name) => (name.startsWith('a') ? ['rec-1', CC_REC] : [CC_REC, CC_REC]),
        },
        library: s.library,
      });
      expect((await s.get(`/transitions/${both}.flac`, 2)).statusCode).toBe(404);
      expect((await s.get(`/transitions/${ccOnly}.flac`, 2)).statusCode).toBe(200);
      expect((await s.get(`/transitions/${both}.flac`, 1)).statusCode).toBe(200);
      await s.post('/api/transitions', 2, { from: 700, to: 701, mode: 'auto' });
      expect((request.mock.calls[0] as unknown as [{ library?: { sources: number[] } }])[0].library?.sources).toEqual([s.cc]);
      await s.post('/api/transitions', 1, { from: 700, to: 701, mode: 'auto' });
      expect(request.mock.calls[1]).toEqual([{ fromTrackId: 700, toTrackId: 701, mode: 'auto' }]);
    } finally {
      cleanup();
    }
  });
});
```

```ts
// apps/server/src/transitions/access.test.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../catalog/testFixtures.ts';
import { Transitions, type TransitionsOptions } from './transitions.ts';

const options = (cacheDir: string, track: (id: number) => object | undefined): TransitionsOptions => ({
  library: { track: async (id: number) => track(id) as never, file: async () => undefined },
  files: {
    resolve: () => {
      throw new Error('no files here');
    },
  },
  maps: { mixMaps: () => new Map(), cues: () => new Map() },
  dsp: {
    render: async () => {
      throw new Error('no renderer here');
    },
  },
  cacheDir,
  ffmpegPath: 'ffmpeg',
  log: { info: () => {}, warn: () => {} },
});

describe('who may hear a transition', () => {
  it('names the two songs a cached transition joins, for any of its files', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const key = 'b'.repeat(40);
      mkdirSync(join(dir, 'transitions'), { recursive: true });
      writeFileSync(join(dir, 'transitions', `${key}.flac`), 'audio');
      writeFileSync(join(dir, 'transitions', `${key}.rest.flac`), 'audio');
      writeFileSync(join(dir, 'transitions', `${key}.json`), JSON.stringify({ aRecording: 'rec-a', bRecording: 'rec-b', plan: { style: 'blend' }, audio: 'flac', continuation: 'flac', createdAt: 1 }));
      const transitions = new Transitions(options(dir, () => undefined));
      await transitions.load();
      expect(transitions.recordingsOf(`${key}.flac`)).toEqual(['rec-a', 'rec-b']);
      expect(transitions.recordingsOf(`${key}.rest.flac`)).toEqual(['rec-a', 'rec-b']);
      expect(transitions.recordingsOf(`${'d'.repeat(40)}.flac`)).toBeUndefined();
      expect(transitions.recordingsOf('../playarr.db')).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('looks the songs up in the library it’s given: the account’s view', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const transitions = new Transitions(options(dir, (id) => ({ id, recordingId: `rec-${id}`, fileId: id, title: 'Song' })));
      const answer = await transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto', library: { track: async () => undefined } });
      expect(answer).toEqual({ status: 'unavailable', reason: 'Unknown song' });
      const whole = await transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto' });
      expect(whole).toEqual({ status: 'unavailable', reason: 'No mix map yet for the song playing (“Song”)' });
    } finally {
      cleanup();
    }
  });
});
```

**Step 2: Run them to see them fail**

```bash
corepack pnpm -C apps/server exec vitest run src/accounts/access.test.ts src/transitions/access.test.ts
```

Expected: FAIL: account 2 streams file 9000 and gets album 70's cover; `recordingsOf` is not a function.

**Step 3: Implement**

`apps/server/src/routes/stream.ts`: add `import { libraryOf } from '../accounts/rights.ts';`; the deps become `deps: { library: Pick<Library, 'file'> & Partial<Pick<Library, 'view'>>; files: FileResolver; loudness?: Pick<Analyzer, 'loudnessOfFile' | 'remeasureLoudness'> }`; in `open`, lines 25-26 become:

```ts
    // Only files of songs the account may hear, as the catalog knows them: the client never supplies a path.
    const file = Number.isInteger(fileId) ? await libraryOf(library, req).file(fileId) : undefined;
```

`apps/server/src/routes/art.ts`: add `import { libraryOf, sourcesOf } from '../accounts/rights.ts';`; line 134 becomes `library: Pick<Library, 'file' | 'hasArtwork'> & Partial<Pick<Library, 'view'>>;`; in `/art/copy/:id`, line 198 becomes:

```ts
    const file = Number.isInteger(id) ? await libraryOf(deps.library, req).file(id) : undefined;
```

In `/art/:kind/:id/:type`, right after the `Unknown artwork` validation (after line 240) add:

```ts
      // Artwork of albums and artists outside the account's sources isn't there for it.
      if (sourcesOf(req) !== null && !(await libraryOf(deps.library, req).hasArtwork(kind, id))) {
        return reply.code(404).send({ error: 'Unknown artwork' });
      }
```

`apps/server/src/transitions/transitions.ts`: add `import type { LibraryView } from '../library/library.ts';` next to the `Library` import, and add to `TransitionRequest` (after `levels`):

```ts
  /** Where to look the two songs up: the asking account's view of the library; the whole library otherwise. */
  library?: Pick<LibraryView, 'track'>;
```

In `request`, add `library` to the destructured parameter list and replace line 306:

```ts
    const [a, b] = await Promise.all([this.opts.library.track(fromTrackId), this.opts.library.track(toTrackId)]);
```

with:

```ts
    const songs = library ?? this.opts.library;
    const [a, b] = await Promise.all([songs.track(fromTrackId), songs.track(toTrackId)]);
```

(Rendering keeps using `this.opts.library.file(…)`: the whole library has every copy, including the account's.) After `filePath`, add:

```ts
  /** The two songs (recordings) a transition file joins, for checking who may hear it. */
  recordingsOf(name: string): [string, string] | undefined {
    const sidecar = CACHE_FILE.test(name) ? this.index.get(name.slice(0, 40)) : undefined;
    return sidecar && [sidecar.aRecording, sidecar.bRecording];
  }
```

`apps/server/src/routes/transitions.ts`: add

```ts
import { libraryOf, sourcesOf } from '../accounts/rights.ts';
import type { Library } from '../library/library.ts';
```

The deps become:

```ts
  deps: {
    transitions?: Pick<Transitions, 'request' | 'filePath'> & Partial<Pick<Transitions, 'recordingsOf'>>;
    /** The library, narrowed to each account's sources for planning and serving. */
    library?: Pick<Library, 'track' | 'trackByRecording'> & Partial<Pick<Library, 'view'>>;
    unavailableReason?: string;
  },
```

In `POST /api/transitions`, before `try {` add:

```ts
    // An account that hears only some sources plans from its own songs and files.
    const view = deps.library && sourcesOf(req) !== null ? libraryOf(deps.library, req) : undefined;
```

and add `...(view ? { library: view } : {}),` as the last entry of the object passed to `transitions.request`. In `GET /transitions/:file`, after the 404 for an unknown name (line 70) add:

```ts
      // Only when the account may hear both songs.
      if (sourcesOf(req) !== null) {
        const pair = transitions?.recordingsOf?.(req.params.file);
        const view = pair && deps.library ? libraryOf(deps.library, req) : undefined;
        const hearable = !!view && !!pair && !!(await view.trackByRecording(pair[0])) && !!(await view.trackByRecording(pair[1]));
        if (!hearable) return reply.code(404).send({ error: 'Unknown transition' });
      }
```

`apps/server/src/index.ts` line 168 becomes:

```ts
transitionRoutes(app, { transitions, library, unavailableReason: 'DJ mixing needs audio analysis, which is off on this server' });
```

**Step 4: Run the tests again**

```bash
corepack pnpm -C apps/server exec vitest run src/accounts/access.test.ts src/transitions/access.test.ts
corepack pnpm -C apps/server test
corepack pnpm -C apps/server typecheck
```

Expected: PASS (the existing stream and transition route tests run without accounts and are unchanged).

*As executed:* the transition routes' `library` needs `track` as well as `trackByRecording` (the view handed to `transitions.request` is typed from it); the plan's snippet above is corrected. Everything else fitted as written once found by content.

**Step 5: Commit**

```bash
git add apps/server/src/routes/stream.ts apps/server/src/routes/art.ts apps/server/src/routes/transitions.ts apps/server/src/transitions/transitions.ts apps/server/src/transitions/access.test.ts apps/server/src/index.ts apps/server/src/accounts/access.test.ts
git commit -m "$(cat <<'EOF'
Stream, draw and mix only songs the account may hear

/stream, its levelled WAV and /art/copy find files in the account's view;
album and artist artwork only for what it can see; transitions are
planned from its songs and served only when it may hear both.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Mixes, radio, stats and Jump back in from the account's songs

**Files:**
- Modify: `apps/server/src/mixes/mixes.ts` (deps lines 80-94, `songCache` line 78, `list`/`get` lines 125 and 137, `radio` lines 162-174, `context` lines 299-320, `refresh` line 279, `songs` lines 327-362, `neighbours`/`neighboursOf` lines 365-392, `tracksOf` lines 395-397)
- Modify: `apps/server/src/routes/mixes.ts` (deps `library` type line 77; `/api/plays/recent-albums`, `/api/stats`, `/api/radio`)
- Modify: `apps/server/src/index.ts` (the `new Mixes({ … })` line from task 8)
- Test: `apps/server/src/mixes/mixes.test.ts` (refactor `fakeLibrary`, extend `setup`, add a test), `apps/server/src/accounts/access.test.ts` (add)

**Step 1: Write the failing tests**

In `apps/server/src/mixes/mixes.test.ts`, let `fakeLibrary` narrow its songs like a view. Change its signature and the loop's target:

```ts
/** 12 artists × 6 songs, tagged rock (half) or jazz, from the 90s; `keep` narrows it, as an account's view would. */
function fakeLibrary(keep: (t: Track) => boolean = () => true, sources: number[] | null = null) {
  const all: Track[] = [];
```

then `tracks.push({…})` becomes `all.push({…})`, and right after the loops add:

```ts
  const tracks = all.filter(keep);
```

and add `sources,` to the returned `library` object (next to `version: 1,`).

Extend `setup` with the views each account sees:

```ts
function setup(mixMaps = new Map<string, MixMapSummary>(), views: Record<number, Library> = {}) {
```

and pass `libraryFor: (account: number) => views[account] ?? library,` in `new Mixes({ … })`. Then add, inside `describe('Mixes', …)`:

```ts
  it('makes each account’s mixes and radio from the songs it may hear', async () => {
    const evenOnly = fakeLibrary((t) => t.artistId % 2 === 0, [2]).library;
    const { mixes } = setup(new Map(), { 2: evenOnly });
    const now = at('2026-11-01T10:05:00Z');
    const theirs = await mixes.list('UTC', now, 2);
    expect(theirs.length).toBeGreaterThan(0);
    for (const m of theirs) for (const t of (await mixes.get(m.key, 'UTC', now, 2)).tracks) expect(t.artistId % 2).toBe(0);
    const mine = await Promise.all((await mixes.list('UTC', now, 1)).map((m) => mixes.get(m.key, 'UTC', now, 1)));
    expect(mine.flatMap((m) => m.tracks).some((t) => t.artistId % 2 === 1)).toBe(true);
    const radio = await mixes.radio(['rec-200'], [], 25, 2);
    expect(radio.length).toBeGreaterThan(0);
    expect(radio.every((t) => t.artistId % 2 === 0)).toBe(true);
  });
```

Add to `apps/server/src/accounts/access.test.ts` (imports: `History` from `'../mixes/history.ts'`, `Mixes` from `'../mixes/mixes.ts'`, `type Playlists` from `'../playlists.ts'`, `mixRoutes` from `'../routes/mixes.ts'`):

```ts
describe('library access: listening', () => {
  async function listening() {
    const s = await setup();
    const history = new History(s.db, s.library);
    const analyzer = { ensure: vi.fn(), features: () => new Map(), meta: () => new Map(), mixSummaries: () => new Map(), progress: () => ({ features: 0, meta: 0, mixMaps: 0 }) } as unknown as Analyzer;
    const sources: Record<number, number[] | null> = { 1: null, 2: [s.cc], 3: [s.lidarr] };
    const mixes = new Mixes({ db: s.db, store: s.store, library: s.library, analyzer, history, playlists: {} as Playlists, similar: async () => [], libraryFor: (id) => s.library.view(sources[id] ?? null) });
    mixRoutes(s.app, { mixes, history, store: s.store, analysisAvailable: false, analyzeLibrary: vi.fn(), library: s.library, db: s.db });
    const cc = (await s.library.trackByRecording(CC_REC))!;
    // Account 2 heard all three songs, back when it could hear Lidarr too.
    const heard = [
      { trackId: 700, recordingId: 'rec-1' },
      { trackId: 701, recordingId: 'rec-2' },
      { trackId: cc.id, recordingId: CC_REC },
    ];
    await history.record(heard.map((h, i) => ({ ...h, at: `2026-11-01T1${i}:00:00Z`, hour: 10 + i, weekday: 0, seconds: 200, skipped: false })), 2);
    return { ...s, cc };
  }

  it('plays radio only from the account’s songs', async () => {
    const { post } = await listening();
    const radio = async (id: number) => ((await post('/api/radio', id, { seeds: [CC_REC] })).json() as Track[]).map((t) => t.recordingId);
    expect(await radio(2)).toEqual([]);
    const all = await radio(1);
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((r) => r === 'rec-1' || r === 'rec-2')).toBe(true);
  });

  it('counts only the account’s songs in its stats and Jump back in', async () => {
    const { get, cc } = await listening();
    const stats = (await get('/api/stats?range=all', 2)).json();
    expect((stats.topTracks as { track: Track }[]).map((t) => t.track.recordingId)).toEqual([CC_REC]);
    expect(stats.firstSong).toBeUndefined(); // Angel came first, and is out of reach now
    expect(((await get('/api/plays/recent-albums', 2)).json() as Album[]).map((a) => a.id)).toEqual([cc.albumId]);
  });
});
```

**Step 2: Run them to see them fail**

```bash
corepack pnpm -C apps/server exec vitest run src/mixes/mixes.test.ts src/accounts/access.test.ts
```

Expected: FAIL: account 2's mixes and radio include odd artists / Lidarr songs; its stats list Angel.

**Step 3: Implement**

In `apps/server/src/mixes/mixes.ts`:

- The import becomes `import type { Library, LibraryView } from '../library/library.ts';`.
- Add to the deps (after `accounts?: () => number[];`):

```ts
      /** The library as each account may hear it (its sources); the whole library without it. */
      libraryFor?: (account: number) => LibraryView;
```

- Replace the `songCache` field:

```ts
  /** Songs as the mixes see them, per set of sources, until the library or what's known about its songs changes. */
  private songCache = new Map<string, { key: string; songs: Song[] }>();
```

- Add a private method after `stop()`:

```ts
  /** The songs an account's mixes and radio come from. */
  private view(account: number): LibraryView {
    return this.deps.libraryFor?.(account) ?? this.deps.library;
  }
```

- In `list` and `get`: `const tracks = await this.tracksOf(mix);` becomes `const tracks = await this.tracksOf(mix, this.view(account));`.
- `radio` gets the account and reads from its view:

```ts
  async radio(seeds: string[], exclude: string[], count = 25, account = 1): Promise<Track[]> {
    const library = this.view(account);
    const songs = await this.songs(readMixSettings(this.deps.store), library);
```

  and further down `const neighbours = await this.neighboursOf(seeds.filter((id) => MBID.test(id)).slice(0, 5));` becomes `const neighbours = await this.neighboursOf(seeds.filter((id) => MBID.test(id)).slice(0, 5), library);`.
- In `refresh`, `ctx = { ...ctx, neighbours: await this.neighbours(ctx.taste) };` becomes `ctx = { ...ctx, neighbours: await this.neighbours(ctx.taste, this.view(account)) };`.
- In `context`: `const songs = await this.songs(settings);` becomes

```ts
    const library = this.view(account);
    const songs = await this.songs(settings, library);
```

  and `neighbours: neighbours ? await this.neighbours(taste) : new Map(),` becomes `neighbours: neighbours ? await this.neighbours(taste, library) : new Map(),`.
- Replace the head of `songs` (its signature through the cache check) and its last two lines:

```ts
  private async songs(settings: MixSettings, library: LibraryView): Promise<Song[]> {
    const { analyzer } = this.deps;
    const progress = analyzer.progress();
    const sources = library.sources?.join(',') ?? 'all';
    const key = `${library.version}:${progress.features}:${progress.meta}:${progress.mixMaps}:${settings.analyzeLibrary}`;
    const cached = this.songCache.get(sources);
    if (cached?.key === key) return cached.songs;
```

  and at its end `this.songCache = { key, songs };` becomes `this.songCache.set(sources, { key, songs });`.
- `neighbours`, `neighboursOf` and `tracksOf` take the library:

```ts
  /** Library songs ListenBrainz finds alike to the most played (or loved) ones, for Discovery Weekly. */
  private neighbours(taste: Taste, library: LibraryView): Promise<Map<number, number>> {
    return this.neighboursOf(
      [...taste.songAffinity]
        .filter(([id]) => MBID.test(id))
        .sort((a, b) => b[1] - a[1])
        .slice(0, NEIGHBOUR_SEEDS)
        .map(([id]) => id),
      library,
    );
  }

  /** Library songs ListenBrainz finds alike to these recordings (track id → 0 … 1). */
  private async neighboursOf(seeds: string[], library: LibraryView): Promise<Map<number, number>> {
```

  with the two lookups inside reading `(await library.trackByRecording(rec.recording_mbid)) ?? (await library.trackByName(rec.artist_credit_name, rec.recording_name));`, and

```ts
  /** A stored mix's songs as the account's library has them now (by recording, which survives matching). */
  private tracksOf(mix: GeneratedMix, library: LibraryView): Promise<Track[]> {
    return mix.recordingIds ? library.tracksByRecordings(mix.recordingIds) : library.tracksByIds(mix.trackIds);
  }
```

In `apps/server/src/routes/mixes.ts`: the rights import becomes `import { accountId, libraryOf, requireAdmin, requireOwn } from '../accounts/rights.ts';`; the deps' library type becomes `library: Pick<Library, 'album' | 'artists' | 'tracksByRecordings'> & Partial<Pick<Library, 'view'>>;`; and:

```ts
  /** Jump back in: albums heard lately that the account can still play. */
  app.get('/api/plays/recent-albums', async (req) => {
    const library = libraryOf(deps.library, req);
    const albums = await Promise.all(history.recentAlbums(24, who(req)).map((id) => library.album(id)));
    return albums.flatMap((a) => (a ? [stripAlbum(a)] : [])).slice(0, 12);
  });
```

`listeningStats(deps.db, deps.library, range, Date.now(), who(req))` becomes `listeningStats(deps.db, libraryOf(deps.library, req), range, Date.now(), who(req))`, and the radio route's last line becomes:

```ts
    return mixes.radio(parsed.data.seeds, parsed.data.exclude ?? [], parsed.data.count ?? 25, who(req));
```

In `apps/server/src/index.ts`, the `new Mixes({ … })` line becomes:

```ts
const mixes = new Mixes({
  db,
  store,
  library,
  analyzer,
  history,
  playlists,
  log: app.log,
  accounts: () => accounts.ids(),
  // Each account's mixes and radio come from the sources it may hear.
  libraryFor: (id) => library.view(accounts.get(id)?.sources ?? null),
});
```

**Step 4: Run the tests again**

```bash
corepack pnpm -C apps/server exec vitest run src/mixes/mixes.test.ts src/accounts/access.test.ts
corepack pnpm -C apps/server test
corepack pnpm -C apps/server typecheck
```

Expected: PASS.

*As executed:* fitted as written once found by content (stale line numbers). Mixes still read favorites and playlist songs server-wide for taste (`context`); Task 14 makes favorites per account.

**Step 5: Commit**

```bash
git add apps/server/src/mixes/mixes.ts apps/server/src/mixes/mixes.test.ts apps/server/src/routes/mixes.ts apps/server/src/index.ts apps/server/src/accounts/access.test.ts
git commit -m "$(cat <<'EOF'
Make each account's mixes, radio, stats and Jump back in from its own songs

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: Favorites per account

**Files:**
- Modify: `apps/server/src/favorites.ts` (whole file)
- Modify: `apps/server/src/routes/favorites.ts` (whole file)
- Modify: `apps/server/src/mixes/mixes.ts` (`context`, the favorites query)
- Modify: `apps/server/src/index.ts` (`new Favorites(db, library)` line 113)
- Test: `apps/server/src/accounts/access.test.ts` (add)

**Step 1: Write the failing test**

Add to `apps/server/src/accounts/access.test.ts` (imports: `Favorites` from `'../favorites.ts'`, `favoriteRoutes` from `'../routes/favorites.ts'`):

```ts
describe('favorites per account', () => {
  it('keeps each account’s favorites, of songs it may hear', async () => {
    const s = await setup();
    const favorites = new Favorites(s.db);
    favoriteRoutes(s.app, { favorites, library: s.library });
    const put = (id: number) => s.app.inject({ method: 'PUT', url: `/api/favorites/${encodeURIComponent(CC_REC)}`, headers: asAccount(id) });
    expect((await put(3)).statusCode).toBe(404); // Lidarr only: not a song it has
    expect((await put(2)).statusCode).toBe(204);
    expect(((await s.get('/api/favorites', 2)).json() as Track[]).map((t) => t.recordingId)).toEqual([CC_REC]);
    expect((await s.get('/api/favorites', 1)).json()).toEqual([]);
    // A favorite of a song the account can no longer hear is kept, but not listed.
    favorites.add(3, (await s.library.trackByRecording(CC_REC))!);
    expect((await s.get('/api/favorites', 3)).json()).toEqual([]);
    await s.app.inject({ method: 'DELETE', url: `/api/favorites/${encodeURIComponent(CC_REC)}`, headers: asAccount(2) });
    expect((await s.get('/api/favorites', 2)).json()).toEqual([]);
    expect(favorites.recordingIds(3)).toEqual([CC_REC]);
  });
});
```

**Step 2: Run it to see it fail**

```bash
corepack pnpm -C apps/server exec vitest run src/accounts/access.test.ts
```

Expected: FAIL: `new Favorites(db)` has no library, `recordingIds` missing; favorites are shared.

**Step 3: Implement**

Replace `apps/server/src/favorites.ts` with:

```ts
import type { FavoriteTrack, Track } from '@playarr/shared';
import type { DatabaseSync } from 'node:sqlite';
import type { LibraryView } from './library/library.ts';

interface FavoriteRow {
  recording_id: string;
  created_at: string;
}

/** Each account's favorite songs, keyed by recording id so they survive re-imports and quality upgrades. */
export class Favorites {
  constructor(private readonly db: DatabaseSync) {}

  /** The account's favorites it can play now (in its library), newest first. */
  async list(account: number, library: Pick<LibraryView, 'trackByRecording'>): Promise<FavoriteTrack[]> {
    const rows = this.db
      .prepare('SELECT recording_id, created_at FROM favorites WHERE account_id = ? ORDER BY created_at DESC')
      .all(account) as unknown as FavoriteRow[];
    const tracks = await Promise.all(
      rows.map(async (r) => {
        const track = await library.trackByRecording(r.recording_id);
        return track ? { ...track, favoritedAt: r.created_at } : undefined;
      }),
    );
    return tracks.filter((t): t is FavoriteTrack => !!t);
  }

  /** Every song the account has favorited, playable or not (what the mixes learn from). */
  recordingIds(account: number): string[] {
    return (this.db.prepare('SELECT recording_id FROM favorites WHERE account_id = ?').all(account) as { recording_id: string }[]).map((r) => r.recording_id);
  }

  add(account: number, track: Track) {
    this.db
      .prepare(
        `INSERT INTO favorites (account_id, recording_id, track_id, title, artist_name, album_title, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id, recording_id) DO NOTHING`,
      )
      .run(account, track.recordingId, track.id, track.title, track.artistName, track.albumTitle, new Date().toISOString());
  }

  remove(account: number, recordingId: string) {
    this.db.prepare('DELETE FROM favorites WHERE account_id = ? AND recording_id = ?').run(account, recordingId);
  }
}
```

Replace `apps/server/src/routes/favorites.ts` with:

```ts
import type { FastifyInstance } from 'fastify';
import { accountId, libraryOf } from '../accounts/rights.ts';
import type { Favorites } from '../favorites.ts';
import type { Library } from '../library/library.ts';
import { RECORDING_ID } from './recordingId.ts';

/** Each account's favorites, of songs it may hear. */
export function favoriteRoutes(app: FastifyInstance, deps: { favorites: Favorites; library: Library }) {
  const { favorites, library } = deps;

  app.get('/api/favorites', (req) => favorites.list(accountId(req), libraryOf(library, req)));

  app.put<{ Params: { recordingId: string } }>('/api/favorites/:recordingId', async (req, reply) => {
    const { recordingId } = req.params;
    if (!RECORDING_ID.test(recordingId)) return reply.code(400).send({ error: 'Invalid recording id' });
    const track = await libraryOf(library, req).trackByRecording(recordingId);
    if (!track) return reply.code(404).send({ error: 'Song not found in the library' });
    favorites.add(accountId(req), track);
    return reply.code(204).send();
  });

  app.delete<{ Params: { recordingId: string } }>('/api/favorites/:recordingId', async (req, reply) => {
    if (!RECORDING_ID.test(req.params.recordingId)) return reply.code(400).send({ error: 'Invalid recording id' });
    favorites.remove(accountId(req), req.params.recordingId);
    return reply.code(204).send();
  });
}
```

In `apps/server/src/index.ts`, `const favorites = new Favorites(db, library);` becomes `const favorites = new Favorites(db);`.

In `apps/server/src/mixes/mixes.ts` `context`, the account's favorites shape its taste:

```ts
    const favorites = new Set(
      (db.prepare('SELECT recording_id FROM favorites').all() as { recording_id: string }[]).map((r) => r.recording_id),
    );
```

becomes:

```ts
    const favorites = new Set(
      (db.prepare('SELECT recording_id FROM favorites WHERE account_id = ?').all(account) as { recording_id: string }[]).map((r) => r.recording_id),
    );
```

**Step 4: Run the tests again**

```bash
corepack pnpm -C apps/server exec vitest run src/accounts/access.test.ts
corepack pnpm -C apps/server test
corepack pnpm -C apps/server typecheck
```

Expected: PASS.

*As executed:* fitted as written (the old `add` already wrote `account_id` 1, and `CatalogStore`'s merge already moved favorites per account).

**Step 5: Commit**

```bash
git add apps/server/src/favorites.ts apps/server/src/routes/favorites.ts apps/server/src/mixes/mixes.ts apps/server/src/index.ts apps/server/src/accounts/access.test.ts
git commit -m "$(cat <<'EOF'
Give each account its own favorites

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---
### Task 15: Playlists per account, private unless shared

**Files:**
- Modify: `packages/shared/src/index.ts` (`PlaylistSummary`, lines 287-295)
- Modify: `apps/server/src/playlists.ts` (whole file)
- Modify: `apps/server/src/routes/playlists.ts` (whole file)
- Modify: `apps/server/src/discover/recommendations.ts` (constructor lines 26-32, `forPlaylist` lines 51-52, the three `this.library` lookups lines 101-103 and 138)
- Modify: `apps/server/src/discover/recommendations.test.ts` (lines 1-3, 37-41)
- Modify: `apps/server/src/mixes/mixes.ts` (`saveAsPlaylist` lines 206-211, `context`'s playlist query)
- Modify: `apps/server/src/mixes/mixes.test.ts` (lines 77 and 122)
- Modify: `apps/server/src/index.ts` (`new Recommendations(…)` line 154, `playlistRoutes(…)` line 172)
- Test: `apps/server/src/playlists.test.ts` (create)

A playlist belongs to the account that made it. Private playlists are its own; shared ones are visible to every account on the server and changed only by their owner. Each viewer sees the songs as their library has them (others are listed as unavailable), while the cover stays the playlist's own, drawn from all its songs.

**Step 1: Write the failing test**

```ts
// apps/server/src/playlists.test.ts
import type { PlaylistDetail, PlaylistSummary } from '@playarr/shared';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { Accounts } from './accounts/accounts.ts';
import { actAs, asAccount, twoSources } from './accounts/testAccess.ts';
import { CC_REC } from './catalog/testFixtures.ts';
import type { PlaylistCovers } from './cover/index.ts';
import type { Recommendations } from './discover/recommendations.ts';
import { Playlists } from './playlists.ts';
import { playlistRoutes } from './routes/playlists.ts';

async function setup() {
  const s = await twoSources();
  const accounts = new Accounts(s.db);
  const sam = accounts.create({ username: 'sam', name: 'Sam', role: 'member', canRequest: false, sources: [s.lidarr] });
  const covers = {
    describe: vi.fn(async () => ({ info: { url: '/art/playlist/1' } as never, art: {} as never, version: 'v1' })),
    liveDna: vi.fn(async () => ({}) as never),
    snapshot: vi.fn(() => ({}) as never),
    svg: vi.fn(async () => '<svg/>'),
    image: vi.fn(async () => Buffer.from('webp')),
  } as unknown as PlaylistCovers;
  const playlists = new Playlists(s.db, s.library, covers);
  const app = Fastify();
  actAs(app, accounts.list());
  playlistRoutes(app, { playlists, recommendations: {} as Recommendations, covers, library: s.library });
  const as = (id: number, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, headers: asAccount(id), ...(payload ? { payload } : {}) });
  return { ...s, sam, covers, app, as };
}

describe('playlists per account', () => {
  it('keeps a new playlist to its owner until it’s shared', async () => {
    const { sam, as } = await setup();
    const made = await as(1, 'POST', '/api/playlists', { name: 'Mine', recordingIds: [CC_REC] });
    expect(made.statusCode).toBe(201);
    const { id } = made.json() as PlaylistDetail;
    expect(made.json()).toMatchObject({ owner: 'Home', shared: false, mine: true, trackCount: 1 });
    expect((await as(sam.id, 'GET', '/api/playlists')).json()).toEqual([]);
    expect((await as(sam.id, 'GET', `/api/playlists/${id}`)).statusCode).toBe(404);
    expect((await as(sam.id, 'GET', `/art/playlist/${id}`)).statusCode).toBe(404);
    await as(1, 'PATCH', `/api/playlists/${id}`, { shared: true });
    expect((await as(sam.id, 'GET', '/api/playlists')).json() as PlaylistSummary[]).toEqual([expect.objectContaining({ id, owner: 'Home', shared: true, mine: false })]);
    expect((await as(sam.id, 'GET', `/art/playlist/${id}`)).statusCode).toBe(200);
  });

  it('lets only the owner change a shared playlist', async () => {
    const { sam, as } = await setup();
    const { id } = (await as(1, 'POST', '/api/playlists', { name: 'Ours', shared: true })).json() as PlaylistDetail;
    expect((await as(sam.id, 'PATCH', `/api/playlists/${id}`, { name: 'Mine now' })).statusCode).toBe(403);
    expect((await as(sam.id, 'POST', `/api/playlists/${id}/items`, { recordingIds: ['track:701'] })).statusCode).toBe(403);
    expect((await as(sam.id, 'PUT', `/api/playlists/${id}/order`, { itemIds: [] })).statusCode).toBe(403);
    expect((await as(sam.id, 'PUT', `/api/playlists/${id}/cover`, { layout: 'currents', variant: 0 })).statusCode).toBe(403);
    expect((await as(sam.id, 'DELETE', `/api/playlists/${id}`)).statusCode).toBe(403);
    expect((await as(1, 'DELETE', `/api/playlists/${id}`)).statusCode).toBe(204);
  });

  it('lists songs outside the viewer’s sources as unavailable, and draws the cover from all of them', async () => {
    const { sam, covers, as } = await setup();
    const { id } = (await as(1, 'POST', '/api/playlists', { name: 'Mixed', recordingIds: [CC_REC], shared: true })).json() as PlaylistDetail;
    const seen = (await as(sam.id, 'GET', `/api/playlists/${id}`)).json() as PlaylistDetail;
    expect(seen.items).toEqual([expect.objectContaining({ recordingId: CC_REC, title: 'Sneaky Snitch' })]);
    expect(seen.items[0]!.track).toBeUndefined();
    expect(seen.duration).toBe(0);
    const drawn = vi.mocked(covers.describe).mock.calls.at(-1)![0] as { items: { track?: object }[] };
    expect(drawn.items[0]!.track).toBeDefined();
  });

  it('adds only songs the owner may hear', async () => {
    const { sam, as } = await setup();
    const { id } = (await as(sam.id, 'POST', '/api/playlists', { name: 'Sam’s' })).json() as PlaylistDetail;
    expect((await as(sam.id, 'POST', `/api/playlists/${id}/items`, { recordingIds: [CC_REC] })).statusCode).toBe(404);
    expect((await as(sam.id, 'POST', '/api/playlists', { name: 'Again', recordingIds: [CC_REC] })).statusCode).toBe(404);
  });
});
```

**Step 2: Run it to see it fail**

```bash
corepack pnpm -C apps/server exec vitest run src/playlists.test.ts
```

Expected: FAIL: `playlistRoutes` has no `library`; every playlist is visible to everyone; no `owner`/`shared`/`mine`.

**Step 3: Implement**

In `packages/shared/src/index.ts`, `PlaylistSummary` gains three fields (after `updatedAt: string;`):

```ts
  /** The display name of the account it belongs to. */
  owner: string;
  /** Visible to every account on this server (only its owner changes it). */
  shared: boolean;
  /** It belongs to the account asking. */
  mine: boolean;
```

Replace `apps/server/src/playlists.ts` with:

```ts
import type { CoverLayout, PlaylistDetail, PlaylistItem, PlaylistSummary, Track } from '@playarr/shared';
import type { DatabaseSync } from 'node:sqlite';
import type { CoverArt, CoverSnapshot, PlaylistCovers } from './cover/index.ts';
import type { Library, LibraryView } from './library/library.ts';

/** Who's looking: their account, and the library as they may hear it. */
export interface Viewer {
  account: number;
  library: LibraryView;
}

interface PlaylistRow {
  id: number;
  name: string;
  description: string;
  updated_at: string;
  cover_snapshot: string | null;
  account_id: number;
  shared: number;
  owner: string | null;
}

interface ItemRow {
  id: number;
  playlist_id: number;
  recording_id: string;
  title: string;
  artist_name: string;
  album_title: string;
  added_at: string;
}

export class PlaylistError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const PLAYLIST = `SELECT p.id, p.name, p.description, p.updated_at, p.cover_snapshot, p.account_id, p.shared, a.name AS owner
                  FROM playlists p LEFT JOIN accounts a ON a.id = p.account_id`;

/**
 * Playlists of songs keyed by recording id (like favorites), with a title/artist/album snapshot so songs
 * that leave the library still show up, marked unavailable. Each belongs to an account: private, or
 * shared with everyone on this server, who can play it while only its owner changes it.
 */
export class Playlists {
  constructor(
    private readonly db: DatabaseSync,
    /** The whole library: covers are drawn from every song, whoever looks. */
    private readonly library: Library,
    private readonly covers: PlaylistCovers,
  ) {}

  /** The viewer's own playlists and those shared with everyone, most recently changed first. */
  async list(viewer: Viewer): Promise<PlaylistSummary[]> {
    const playlists = this.db
      .prepare(`${PLAYLIST} WHERE p.account_id = ? OR p.shared = 1 ORDER BY p.updated_at DESC`)
      .all(viewer.account) as unknown as PlaylistRow[];
    const items = this.db.prepare('SELECT * FROM playlist_items ORDER BY playlist_id, position').all() as unknown as ItemRow[];
    return Promise.all(
      playlists.map(async (p) => {
        const { items: _items, ...summary } = await this.present(p, items.filter((i) => i.playlist_id === p.id), viewer);
        return summary;
      }),
    );
  }

  async get(id: number, viewer: Viewer): Promise<PlaylistDetail> {
    return this.present(this.row(id, viewer), this.itemRows(id), viewer);
  }

  /** The cover to draw (frozen art, or provisional while songs are still being heard) and the title. */
  async cover(id: number, viewer: Viewer): Promise<{ art: CoverArt; name: string; version: string }> {
    const p = this.row(id, viewer);
    const { art, freeze, version } = await this.covers.describe(this.coverInput(p, await this.resolve(this.itemRows(id), this.library)));
    if (freeze) this.saveCover(id, freeze);
    return { art, name: p.name, version };
  }

  /** Candidate art from the songs as they are now, for the cover picker. */
  async coverCandidate(id: number, layout: CoverLayout, variant: number, viewer: Viewer): Promise<{ art: CoverArt; name: string }> {
    const p = this.row(id, viewer);
    return { art: { dna: await this.covers.liveDna(id, await this.resolve(this.itemRows(id), this.library)), layout, variant }, name: p.name };
  }

  /** Give the playlist a new cover, drawn from its current songs. */
  async setCover(id: number, layout: CoverLayout, variant: number, viewer: Viewer): Promise<PlaylistDetail> {
    this.row(id, viewer, 'own');
    const dna = await this.covers.liveDna(id, await this.resolve(this.itemRows(id), this.library));
    this.saveCover(id, this.covers.snapshot(dna, layout, variant));
    return this.get(id, viewer);
  }

  async create(viewer: Viewer, name: string, description = '', recordingIds: string[] = [], shared = false): Promise<PlaylistDetail> {
    const now = new Date().toISOString();
    const tracks = await this.tracks(recordingIds, viewer);
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO playlists (name, description, created_at, updated_at, account_id, shared) VALUES (?, ?, ?, ?, ?, ?)')
      .run(cleanName(name), cleanDescription(description), now, now, viewer.account, shared ? 1 : 0);
    const id = Number(lastInsertRowid);
    if (tracks.length) this.append(id, tracks);
    return this.get(id, viewer);
  }

  async update(id: number, patch: { name?: string; description?: string; shared?: boolean }, viewer: Viewer): Promise<PlaylistDetail> {
    const p = this.row(id, viewer, 'own');
    this.db
      .prepare('UPDATE playlists SET name = ?, description = ?, shared = ?, updated_at = ? WHERE id = ?')
      .run(
        patch.name !== undefined ? cleanName(patch.name) : p.name,
        patch.description !== undefined ? cleanDescription(patch.description) : p.description,
        patch.shared !== undefined ? (patch.shared ? 1 : 0) : p.shared,
        new Date().toISOString(),
        id,
      );
    return this.get(id, viewer);
  }

  remove(id: number, viewer: Viewer) {
    this.row(id, viewer, 'own');
    this.db.prepare('DELETE FROM playlists WHERE id = ?').run(id);
  }

  /** Append songs the owner may hear (duplicates allowed, like most players). Unknown ids are rejected. */
  async addItems(id: number, recordingIds: string[], viewer: Viewer): Promise<PlaylistDetail> {
    this.row(id, viewer, 'own');
    this.append(id, await this.tracks(recordingIds, viewer));
    return this.get(id, viewer);
  }

  async removeItem(id: number, itemId: number, viewer: Viewer): Promise<PlaylistDetail> {
    this.row(id, viewer, 'own');
    const { changes } = this.db.prepare('DELETE FROM playlist_items WHERE id = ? AND playlist_id = ?').run(itemId, id);
    if (!changes) throw new PlaylistError('Song not found in this playlist', 404);
    this.touch(id);
    return this.get(id, viewer);
  }

  /** Set the full order; `itemIds` must be exactly the playlist's items. */
  async reorder(id: number, itemIds: number[], viewer: Viewer): Promise<PlaylistDetail> {
    this.row(id, viewer, 'own');
    const current = (this.db.prepare('SELECT id FROM playlist_items WHERE playlist_id = ?').all(id) as { id: number }[]).map((r) => r.id);
    const same = current.length === itemIds.length && new Set(itemIds).size === itemIds.length && itemIds.every((i) => current.includes(i));
    if (!same) throw new PlaylistError('Order must list every item in the playlist exactly once');
    const update = this.db.prepare('UPDATE playlist_items SET position = ? WHERE id = ?');
    this.transaction(() => {
      itemIds.forEach((itemId, position) => update.run(position, itemId));
      this.touch(id);
    });
    return this.get(id, viewer);
  }

  /** A playlist as this viewer sees it: the songs as their library has them; the cover from all of them. */
  private async present(p: PlaylistRow, rows: ItemRow[], viewer: Viewer): Promise<PlaylistDetail> {
    const items = await this.resolve(rows, viewer.library);
    const all = viewer.library === this.library ? items : await this.resolve(rows, this.library);
    const { info, freeze } = await this.covers.describe(this.coverInput(p, all));
    if (freeze) this.saveCover(p.id, freeze);
    const duration = items.reduce((s, { track }) => s + (track?.duration ?? 0), 0);
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      trackCount: items.length,
      duration,
      cover: info,
      updatedAt: p.updated_at,
      owner: p.owner ?? 'Removed account',
      shared: p.shared === 1,
      mine: p.account_id === viewer.account,
      items,
    };
  }

  /** The playlist if the viewer may see it (theirs, or shared), and change it ('own': theirs only). */
  private row(id: number, viewer: Viewer, need: 'see' | 'own' = 'see'): PlaylistRow {
    const row = this.db.prepare(`${PLAYLIST} WHERE p.id = ?`).get(id) as unknown as PlaylistRow | undefined;
    if (!row || (row.account_id !== viewer.account && row.shared !== 1)) throw new PlaylistError('Playlist not found', 404);
    if (need === 'own' && row.account_id !== viewer.account) throw new PlaylistError('Only its owner can change this playlist', 403);
    return row;
  }

  private itemRows(id: number): ItemRow[] {
    return this.db.prepare('SELECT * FROM playlist_items WHERE playlist_id = ? ORDER BY position').all(id) as unknown as ItemRow[];
  }

  /** The songs for these recordings in the viewer's library, or a 404 naming the first it doesn't have. */
  private async tracks(recordingIds: string[], viewer: Viewer): Promise<Track[]> {
    const tracks: Track[] = [];
    for (const rid of recordingIds) {
      const track = await viewer.library.trackByRecording(rid);
      if (!track) throw new PlaylistError(`Song ${rid} is not in the library`, 404);
      tracks.push(track);
    }
    return tracks;
  }

  private append(id: number, tracks: Track[]) {
    const { next } = this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM playlist_items WHERE playlist_id = ?').get(id) as { next: number };
    const now = new Date().toISOString();
    const insert = this.db.prepare(
      `INSERT INTO playlist_items (playlist_id, position, recording_id, title, artist_name, album_title, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.transaction(() => {
      tracks.forEach((t, i) => insert.run(id, next + i, t.recordingId, t.title, t.artistName, t.albumTitle, now));
      this.touch(id);
    });
  }

  private saveCover(id: number, snapshot: CoverSnapshot) {
    this.db.prepare('UPDATE playlists SET cover_snapshot = ? WHERE id = ?').run(JSON.stringify(snapshot), id);
  }

  private coverInput(p: PlaylistRow, items: PlaylistItem[]) {
    const snapshot = p.cover_snapshot ? (JSON.parse(p.cover_snapshot) as CoverSnapshot) : undefined;
    return { id: p.id, name: p.name, items, snapshot };
  }

  private touch(id: number) {
    this.db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  }

  private transaction(fn: () => void) {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private resolve(rows: ItemRow[], library: Pick<LibraryView, 'trackByRecording'>): Promise<PlaylistItem[]> {
    return Promise.all(
      rows.map(async (r) => ({
        itemId: r.id,
        recordingId: r.recording_id,
        title: r.title,
        artistName: r.artist_name,
        albumTitle: r.album_title,
        addedAt: r.added_at,
        track: await library.trackByRecording(r.recording_id),
      })),
    );
  }
}

function cleanName(name: string): string {
  const n = name.trim().replace(/\s+/g, ' ');
  if (!n) throw new PlaylistError('Playlist name is required');
  if (n.length > 100) throw new PlaylistError('Playlist name is too long (max 100 characters)');
  return n;
}

function cleanDescription(d: string): string {
  const v = d.trim();
  if (v.length > 300) throw new PlaylistError('Description is too long (max 300 characters)');
  return v;
}
```

Replace `apps/server/src/routes/playlists.ts` with:

```ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { CoverLayout } from '@playarr/shared';
import { accountId, libraryOf } from '../accounts/rights.ts';
import type { CoverArt, PlaylistCovers } from '../cover/index.ts';
import type { Recommendations } from '../discover/recommendations.ts';
import type { Library } from '../library/library.ts';
import { PlaylistError, type Playlists, type Viewer } from '../playlists.ts';
import { RECORDING_ID } from './recordingId.ts';

function recordingIds(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1000) return null;
  return value.every((v) => typeof v === 'string' && RECORDING_ID.test(v)) ? (value as string[]) : null;
}

const LAYOUTS: CoverLayout[] = ['currents', 'colonies', 'horizon', 'ridges', 'grooves', 'blocks'];
const coverLayout = (value: unknown) => LAYOUTS.find((l) => l === value);

async function handle<T>(reply: FastifyReply, fn: () => T | Promise<T>) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PlaylistError) return reply.code(err.status).send({ error: err.message });
    throw err;
  }
}

/** Each account's playlists and those shared with everyone; only an owner changes theirs. */
export function playlistRoutes(
  app: FastifyInstance,
  deps: { playlists: Playlists; recommendations: Recommendations; covers: PlaylistCovers; library: Library },
) {
  const { playlists, recommendations, covers } = deps;
  type Id = { Params: { id: string } };
  const id = (raw: string) => Number.parseInt(raw, 10);
  const viewer = (req: FastifyRequest): Viewer => ({ account: accountId(req), library: libraryOf(deps.library, req) });

  type ArtQuery = { size?: string; v?: string; format?: string; title?: string };
  // Snap to a few sizes so the image cache stays small.
  const snap = (raw?: string) => [64, 96, 128, 192, 256, 384, 512, 768, 1024].find((b) => b >= (Number(raw) || 600)) ?? 1024;
  const sendCover = async (reply: FastifyReply, cover: { art: CoverArt; name: string }, query: ArtQuery, immutable: boolean) => {
    const title = query.title === '0' ? undefined : cover.name;
    // Versioned URLs never change (the version covers art and title); the bare URL revalidates.
    reply.header('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    if (query.format === 'svg') return reply.type('image/svg+xml').send(await covers.svg(cover.art, title));
    return reply.type('image/webp').send(await covers.image(cover.art, title, snap(query.size)));
  };

  /** The playlist's cover: WebP at `size` (default 600), `title=0` without the title, `format=svg` for the source. */
  app.get<Id & { Querystring: ArtQuery }>('/art/playlist/:id', (req, reply) =>
    handle(reply, async () => {
      const cover = await playlists.cover(id(req.params.id), viewer(req));
      return sendCover(reply, cover, req.query, req.query.v === cover.version);
    }),
  );

  /** A candidate cover from the playlist's current songs, for the picker. */
  app.get<Id & { Querystring: ArtQuery & { layout?: string; variant?: string } }>('/art/playlist/:id/preview', (req, reply) =>
    handle(reply, async () => {
      const layout = coverLayout(req.query.layout);
      if (!layout) return reply.code(400).send({ error: 'Unknown layout' });
      const variant = Math.max(0, Math.min(1_000_000, Number.parseInt(req.query.variant ?? '0', 10) || 0));
      return sendCover(reply, await playlists.coverCandidate(id(req.params.id), layout, variant, viewer(req)), req.query, false);
    }),
  );

  app.put<Id & { Body: { layout?: string; variant?: number } }>('/api/playlists/:id/cover', (req, reply) => {
    const layout = coverLayout(req.body?.layout);
    const variant = req.body?.variant ?? 0;
    if (!layout || !Number.isInteger(variant) || variant < 0) return reply.code(400).send({ error: 'layout and variant are required' });
    return handle(reply, () => playlists.setCover(id(req.params.id), layout, variant, viewer(req)));
  });

  app.get('/api/playlists', (req) => playlists.list(viewer(req)));

  app.post<{ Body: { name?: string; description?: string; recordingIds?: string[]; shared?: boolean } }>('/api/playlists', (req, reply) => {
    const ids = recordingIds(req.body?.recordingIds);
    if (!ids) return reply.code(400).send({ error: 'recordingIds must be a list of song ids' });
    return handle(reply, async () =>
      reply.code(201).send(await playlists.create(viewer(req), req.body?.name ?? '', req.body?.description, ids, req.body?.shared === true)),
    );
  });

  app.get<Id>('/api/playlists/:id', (req, reply) => handle(reply, () => playlists.get(id(req.params.id), viewer(req))));

  app.patch<Id & { Body: { name?: string; description?: string; shared?: boolean } }>('/api/playlists/:id', (req, reply) => {
    const body = req.body ?? {};
    if (body.shared !== undefined && typeof body.shared !== 'boolean') return reply.code(400).send({ error: 'shared must be true or false' });
    return handle(reply, () => playlists.update(id(req.params.id), body, viewer(req)));
  });

  app.delete<Id>('/api/playlists/:id', (req, reply) =>
    handle(reply, () => {
      playlists.remove(id(req.params.id), viewer(req));
      return reply.code(204).send();
    }),
  );

  app.post<Id & { Body: { recordingIds?: string[] } }>('/api/playlists/:id/items', (req, reply) => {
    const ids = recordingIds(req.body?.recordingIds);
    if (!ids?.length) return reply.code(400).send({ error: 'recordingIds must be a non-empty list of song ids' });
    return handle(reply, () => playlists.addItems(id(req.params.id), ids, viewer(req)));
  });

  app.delete<{ Params: { id: string; itemId: string } }>('/api/playlists/:id/items/:itemId', (req, reply) =>
    handle(reply, () => playlists.removeItem(id(req.params.id), id(req.params.itemId), viewer(req))),
  );

  app.get<Id & { Querystring: { variant?: string } }>('/api/playlists/:id/recommendations', async (req, reply) => {
    const ctrl = new AbortController();
    reply.raw.once('close', () => !reply.raw.writableFinished && ctrl.abort());
    try {
      return await handle(reply, () => recommendations.forPlaylist(viewer(req), id(req.params.id), Number(req.query.variant) || 0, ctrl.signal));
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.put<Id & { Body: { itemIds?: number[] } }>('/api/playlists/:id/order', (req, reply) => {
    const itemIds = req.body?.itemIds;
    if (!Array.isArray(itemIds) || !itemIds.every(Number.isInteger)) {
      return reply.code(400).send({ error: 'itemIds must be a list of item ids' });
    }
    return handle(reply, () => playlists.reorder(id(req.params.id), itemIds, viewer(req)));
  });
}
```

`apps/server/src/discover/recommendations.ts`: the imports lose `import type { Library } from '../library/library.ts';` (keep `songKey`) and gain `import type { Playlists, Viewer } from '../playlists.ts';` (replacing the `Playlists` type import). The constructor drops the library:

```ts
  constructor(
    private readonly playlists: Playlists,
    private readonly requests: Requests,
    /** Finds a song's MusicBrainz recording by name, for songs known only from their tags. */
    private readonly mb?: { searchRecordings(artistName: string, title: string, signal?: AbortSignal): Promise<{ id: string; score: number }[]> },
  ) {}
```

`forPlaylist` takes the viewer first and finds songs in their library:

```ts
  /** `variant` picks a different random set of seeds (0 = evenly spread through the playlist). */
  async forPlaylist(viewer: Viewer, playlistId: number, variant = 0, signal?: AbortSignal): Promise<RecommendationsResult> {
    const playlist = await this.playlists.get(playlistId, viewer);
    const library = viewer.library;
```

and its three lookups `this.library.trackByRecording(…)`, `this.library.trackByName(…)` and `this.library.artistIdByMbid(…)` become `library.trackByRecording(…)`, `library.trackByName(…)` and `library.artistIdByMbid(…)`.

`apps/server/src/discover/recommendations.test.ts`: replace the import `import type { Library } from '../library/library.ts';` with `import type { LibraryView } from '../library/library.ts';`, the construction with `const recs = new Recommendations(playlists, {} as Requests, { searchRecordings });`, and the two calls with:

```ts
    const viewer = { account: 1, library: {} as LibraryView };
    const result = await recs.forPlaylist(viewer, 76);
```

and `await recs.forPlaylist(viewer, 76, 0);`.

`apps/server/src/mixes/mixes.ts`: `saveAsPlaylist`'s last line becomes:

```ts
    return this.deps.playlists.create({ account, library: this.view(account) }, `${mix.title} · ${day}`, mix.description.slice(0, 300), mix.tracks.map((t) => t.recordingId));
```

and `context`'s playlist query counts only the playlists the account sees:

```ts
    const inPlaylists = new Map(
      (db.prepare('SELECT recording_id, COUNT(*) AS n FROM playlist_items GROUP BY recording_id').all() as { recording_id: string; n: number }[]).map(
        (r) => [r.recording_id, r.n],
      ),
    );
```

becomes:

```ts
    const inPlaylists = new Map(
      (
        db
          .prepare(
            'SELECT recording_id, COUNT(*) AS n FROM playlist_items WHERE playlist_id IN (SELECT id FROM playlists WHERE account_id = ? OR shared = 1) GROUP BY recording_id',
          )
          .all(account) as { recording_id: string; n: number }[]
      ).map((r) => [r.recording_id, r.n]),
    );
```

`apps/server/src/mixes/mixes.test.ts`: line 77 becomes

```ts
  const playlists = { create: vi.fn(async (_viewer: unknown, name: string) => ({ id: 1, name })) } as unknown as Playlists;
```

and line 122 becomes

```ts
    expect(playlists.create).toHaveBeenCalledWith(expect.objectContaining({ account: 1 }), 'Rock mix · 1 Nov', expect.any(String), after.tracks.map((t) => t.recordingId));
```

`apps/server/src/index.ts`: `new Recommendations(playlists, library, requests, musicbrainz)` becomes `new Recommendations(playlists, requests, musicbrainz)`, and `playlistRoutes(app, { playlists, recommendations, covers });` becomes `playlistRoutes(app, { playlists, recommendations, covers, library });`.

**Step 4: Run the tests again**

```bash
corepack pnpm -C apps/server exec vitest run src/playlists.test.ts src/discover/recommendations.test.ts src/mixes/mixes.test.ts
corepack pnpm -C apps/server test
corepack pnpm -C apps/server typecheck
```

Expected: PASS. (The web typecheck fails on nothing: it only reads playlists; task 22 uses the new fields.)

*As executed:* fitted as written (stale line numbers aside). Web typecheck passes; the web suite's 452 tests pass but vitest exits 1 on 22 unhandled `AbortError: The animation was canceled` rejections (motion-dom under happy-dom, from `AnalysisPanel.test.tsx` and others), which happen on the commit before this one too: not caused by this task.

**Step 5: Commit**

```bash
git add packages/shared/src/index.ts apps/server/src/playlists.ts apps/server/src/playlists.test.ts apps/server/src/routes/playlists.ts apps/server/src/discover/recommendations.ts apps/server/src/discover/recommendations.test.ts apps/server/src/mixes/mixes.ts apps/server/src/mixes/mixes.test.ts apps/server/src/index.ts
git commit -m "$(cat <<'EOF'
Give playlists an owner: private unless shared with everyone on the server

Shared playlists are visible to every account and changed only by their
owner. Each viewer sees the songs as their library has them; the cover
stays drawn from all of them.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 16: Server identity: `GET /api/server`

**Files:**
- Create: `apps/server/src/version.ts`, `apps/server/src/routes/server.ts`
- Modify: `apps/server/tsup.config.ts` (whole file)
- Modify: `apps/server/src/config.ts` (schema, after `UPDATE_DIR` line 22)
- Modify: `apps/server/src/index.ts` (imports; register the route after `accountRoutes(…)`)
- Test: `apps/server/src/routes/server.test.ts` (create)

**Step 1: Write the failing test**

```ts
// apps/server/src/routes/server.test.ts
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import type { ServerInfo } from '@playarr/shared';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { CatalogStore } from '../catalog/store.ts';
import { freshDb } from '../catalog/testFixtures.ts';
import { loadConfig } from '../config.ts';
import { VERSION } from '../version.ts';
import { MIN_APP_VERSION, serverId, serverInfo, serverRoutes } from './server.ts';

describe('server identity', () => {
  it('keeps one id for good, made the first time it’s asked for', () => {
    const store = new CatalogStore(freshDb());
    const id = serverId(store);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(serverId(store)).toBe(id);
    expect(serverId(new CatalogStore(freshDb()))).not.toBe(id);
  });

  it('answers who it is, by SERVER_NAME or the machine’s name, and whether it’s set up', async () => {
    const store = new CatalogStore(freshDb());
    let setup = true;
    const app = Fastify();
    serverRoutes(app, { info: () => serverInfo({ store, name: undefined, setupMode: () => setup }) });
    const body = (await app.inject({ url: '/api/server' })).json() as ServerInfo;
    expect(body).toEqual({ id: serverId(store), name: hostname(), version: VERSION, minAppVersion: MIN_APP_VERSION, setup: true });
    setup = false;
    expect(((await app.inject({ url: '/api/server' })).json() as ServerInfo).setup).toBe(false);
    expect(serverInfo({ store, name: ' Living room ', setupMode: () => false }).name).toBe('Living room');
  });

  it('knows its version from the repository’s package.json', () => {
    const root = JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(VERSION).toBe(root.version);
  });

  it('reads SERVER_NAME and BONJOUR from the environment', () => {
    expect(loadConfig({ SERVER_NAME: 'NAS', BONJOUR: 'off' })).toMatchObject({ SERVER_NAME: 'NAS', BONJOUR: 'off' });
    expect(loadConfig({}).BONJOUR).toBe('on');
  });
});
```

**Step 2: Run it to see it fail**

```bash
corepack pnpm -C apps/server exec vitest run src/routes/server.test.ts
```

Expected: FAIL: modules not found.

**Step 3: Implement**

```ts
// apps/server/src/version.ts
import { readFileSync } from 'node:fs';

/** Put in by tsup at build time (tsup.config.ts); undefined when run from source (dev, tests). */
declare const __APP_VERSION__: string | undefined;

/** Playarr's version: the repository's package.json version, which every commit raises. */
export const VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : readVersion();

function readVersion(): string {
  try {
    return (JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
```

```ts
// apps/server/src/routes/server.ts
import type { ServerInfo } from '@playarr/shared';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { CatalogStore } from '../catalog/store.ts';
import { VERSION } from '../version.ts';

/** The oldest iOS app this server works with: raised when an API change would break older apps. */
export const MIN_APP_VERSION = '1.0.0';
const SERVER_ID_KEY = 'server.id';

/** This server's id: made once and kept, so apps know it under any address. */
export function serverId(store: Pick<CatalogStore, 'appSetting' | 'setAppSetting'>): string {
  let id = store.appSetting(SERVER_ID_KEY);
  if (!id) {
    id = randomUUID();
    store.setAppSetting(SERVER_ID_KEY, id);
  }
  return id;
}

/** Which server this is (GET /api/server, and what Bonjour advertises). */
export function serverInfo(deps: { store: Pick<CatalogStore, 'appSetting' | 'setAppSetting'>; name: string | undefined; setupMode: () => boolean }): ServerInfo {
  return {
    id: serverId(deps.store),
    name: deps.name?.trim() || hostname(),
    version: VERSION,
    minAppVersion: MIN_APP_VERSION,
    setup: deps.setupMode(),
  };
}

/** Open to anyone: how an app recognises a server before signing in. */
export function serverRoutes(app: FastifyInstance, deps: { info: () => ServerInfo }) {
  app.get('/api/server', (): ServerInfo => deps.info());
}
```

Replace `apps/server/tsup.config.ts` with:

```ts
import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

/** The repository's version (raised by every commit), built into the server for GET /api/server and Bonjour. */
const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  // The analysis workers are their own files next to index.js (see analysis/dspThread.ts, beatModelThread.ts).
  entry: { index: 'src/index.ts', dspWorker: 'src/analysis/dspWorker.ts', beatModelWorker: 'src/analysis/beatModelWorker.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  // Keep `node:` prefixes: node:sqlite only exists under its prefixed name.
  removeNodeProtocol: false,
  // Bundle the workspace packages (shipped as TypeScript source); keep real npm deps external.
  noExternal: ['@playarr/shared', '@playarr/mix'],
  define: { __APP_VERSION__: JSON.stringify(version) },
});
```

In `apps/server/src/config.ts`, add after the `UPDATE_DIR` entry:

```ts
  // What apps call this server (GET /api/server, Bonjour); the machine's name when unset.
  SERVER_NAME: z.string().trim().max(63).optional(),
  // Advertise the server on the home network (_playarr._tcp) so the iOS app finds it.
  BONJOUR: z.enum(['on', 'off']).default('on'),
```

In `apps/server/src/index.ts`, add `import { serverInfo, serverRoutes } from './routes/server.ts';` and, after `accountRoutes(app, { accounts, sessions, setupCodes });`:

```ts
const info = () => serverInfo({ store, name: config.SERVER_NAME, setupMode: () => accounts.setupMode() });
serverRoutes(app, { info });
```

**Step 4: Run the test again**

```bash
corepack pnpm -C apps/server exec vitest run src/routes/server.test.ts
corepack pnpm -C apps/server test
corepack pnpm -C apps/server typecheck
corepack pnpm -C apps/server build && grep -c "$(node -p "require('./package.json').version")" apps/server/dist/index.js
```

Expected: PASS; the build contains the version (count ≥ 1).

**Step 5: Commit**

```bash
git add apps/server/src/version.ts apps/server/src/routes/server.ts apps/server/src/routes/server.test.ts apps/server/tsup.config.ts apps/server/src/config.ts apps/server/src/index.ts
git commit -m "$(cat <<'EOF'
Add GET /api/server: a stable server id, its name, version and setup state

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 17: Bonjour

**Files:**
- Modify: `apps/server/package.json` (dependency, through pnpm)
- Create: `apps/server/src/bonjour.ts`
- Modify: `apps/server/src/index.ts` (after `app.listen`, and `shutdown`)
- Test: `apps/server/src/bonjour.test.ts` (create)

**Step 1: Add the dependency and check its API**

```bash
corepack pnpm -C apps/server add bonjour-service
sed -n '1,80p' apps/server/node_modules/bonjour-service/dist/index.d.ts
```

Expected: the declarations show `export declare class Bonjour` with `constructor(opts?: Partial<ServiceConfig>, errorCallback?: Function)`, `publish(opts: ServiceConfig): Service`, `unpublishAll(callback?: CallableFunction): void` and `destroy(callback?: CallableFunction): void`, and `Service` emitting `'error'`. If a name differs in the installed version, use the installed one in step 3 (the behaviour stays the same).

**Step 2: Write the failing test**

```ts
// apps/server/src/bonjour.test.ts
import { describe, expect, it } from 'vitest';
import { txtRecord } from './bonjour.ts';

describe('txtRecord', () => {
  it('advertises the server’s id, version, name and where the API is', () => {
    expect(txtRecord({ id: '2b1c9f0e-1111-4222-8333-444455556666', version: '0.6.175', name: 'NAS' })).toEqual({
      id: '2b1c9f0e-1111-4222-8333-444455556666',
      v: '0.6.175',
      name: 'NAS',
      path: '/',
    });
  });

  it('shortens a name to fit a TXT string (255 bytes with its key)', () => {
    const { name } = txtRecord({ id: 'x', version: '1', name: 'é'.repeat(200) });
    expect(Buffer.byteLength(`name=${name}`)).toBeLessThanOrEqual(255);
    expect(name.startsWith('éééé')).toBe(true);
  });
});
```

```bash
corepack pnpm -C apps/server exec vitest run src/bonjour.test.ts
```

Expected: FAIL: `./bonjour.ts` not found.

**Step 3: Implement**

```ts
// apps/server/src/bonjour.ts
import { Bonjour } from 'bonjour-service';

/** What apps on the home network learn about this server before connecting. */
export interface Advertised {
  id: string;
  version: string;
  name: string;
}

/** A TXT string holds at most 255 bytes, its key and "=" included. */
function fit(key: string, value: string): string {
  let v = value;
  while (Buffer.byteLength(`${key}=${v}`) > 255) v = v.slice(0, -1);
  return v;
}

/** The TXT record of `_playarr._tcp`: which server (id), its version, its name, and where the API is. */
export function txtRecord(info: Advertised): Record<string, string> {
  return { id: info.id, v: info.version, name: fit('name', info.name), path: '/' };
}

/**
 * Advertise this server as `_playarr._tcp` on the home network, so the iOS app lists it. Works for
 * native installs and host-network Docker; elsewhere the app takes an address. Never throws: a network
 * without multicast just means apps type the address.
 */
export function advertise(opts: {
  port: number;
  info: Advertised;
  log: { info: (msg: string) => void; warn: (obj: object, msg: string) => void };
}): { stop: () => Promise<void> } {
  let bonjour: Bonjour | undefined;
  try {
    bonjour = new Bonjour({}, (err: unknown) => opts.log.warn({ err }, 'Bonjour stopped advertising this server'));
    const service = bonjour.publish({ name: opts.info.name, type: 'playarr', port: opts.port, txt: txtRecord(opts.info) });
    service.on('error', (err: unknown) => opts.log.warn({ err }, 'Bonjour couldn’t advertise this server'));
    opts.log.info(`Advertised on the home network as “${opts.info.name}” (_playarr._tcp)`);
  } catch (err) {
    opts.log.warn({ err }, 'Bonjour couldn’t start: apps can still connect by address');
  }
  return {
    stop: () =>
      new Promise<void>((resolve) => {
        const running = bonjour;
        if (!running) return resolve();
        running.unpublishAll(() => {
          running.destroy();
          resolve();
        });
      }),
  };
}
```

In `apps/server/src/index.ts`, add `import { advertise } from './bonjour.ts';`. After `await app.listen({ port: config.PORT, host: config.HOST });` add:

```ts
// Apps on the home network find the server by Bonjour (BONJOUR=off to stop).
const bonjour = config.BONJOUR === 'on' ? advertise({ port: config.PORT, info: info(), log: app.log }) : undefined;
```

and in `shutdown`, before `await app.close();`, add `await bonjour?.stop();`. (`shutdown` only runs on a signal, after `bonjour` is set.)

**Step 4: Run the tests again, and see it advertise**

```bash
corepack pnpm -C apps/server exec vitest run src/bonjour.test.ts
corepack pnpm -C apps/server test
corepack pnpm -C apps/server typecheck
```

Expected: PASS. Then start the server (`corepack pnpm -C apps/server dev`, in the background) and in another shell:

```bash
dns-sd -B _playarr._tcp local. & sleep 3; kill %1
```

Expected: one line for the server's name. Stop the server.

**Step 5: Commit**

```bash
git add apps/server/package.json pnpm-lock.yaml apps/server/src/bonjour.ts apps/server/src/bonjour.test.ts apps/server/src/index.ts
git commit -m "$(cat <<'EOF'
Advertise the server on the home network as _playarr._tcp

Through bonjour-service (pure JavaScript, works on the Alpine image), with
the server id, version, name and API path in the TXT record. BONJOUR=off
turns it off.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---
### Task 18: Web: accounts on this device, auth API calls, 401 → sign in

**Files:**
- Modify: `apps/web/src/lib/api.ts` (type imports lines 2-52, `request` lines 118-135, the `api` object after `deleteProfile`)
- Create: `apps/web/src/lib/accounts.ts`
- Modify: `apps/web/src/lib/queries.ts` (append after `useProfileAction`, line 799)
- Test: `apps/web/src/lib/accounts.test.ts`, `apps/web/src/lib/api.test.ts` (create)

The web keeps each signed-in account as `{ accountId, name, username, token }` in `localStorage['playarr.accounts']`; listening as one calls `POST /api/auth/switch`, which sets the HttpOnly cookie that `<audio>`, images and the service worker carry. Switching resets every query (the library itself differs between accounts) and drops the service worker's API fallback cache. Any 401 outside `/api/auth/` sends the page to `/sign-in?next=…`.

**Step 1: Write the failing tests**

```ts
// apps/web/src/lib/accounts.test.ts
import type { Account } from '@playarr/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNTS_KEY, deviceName, remember, signedIn, switchTo, useAccounts } from './accounts';
import { api, ApiError } from './api';
import { queryClient } from './queryClient';

const SAM: Account = { id: 2, username: 'sam', name: 'Sam', role: 'member', canRequest: false, sources: null, hasPassword: true };

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  useAccounts.setState({ accounts: [] });
  queryClient.clear();
});

describe('accounts on this device', () => {
  it('keeps each signed-in account’s token, and makes it the session cookie', async () => {
    const swap = vi.spyOn(api, 'switchAccount').mockResolvedValue(SAM);
    await signedIn({ token: 'tok-2', account: SAM });
    expect(JSON.parse(localStorage.getItem(ACCOUNTS_KEY)!)).toEqual([{ accountId: 2, name: 'Sam', username: 'sam', token: 'tok-2' }]);
    expect(swap).toHaveBeenCalledWith('tok-2');
    // Signing in again replaces the old token rather than adding a second entry.
    await signedIn({ token: 'tok-3', account: SAM });
    expect(useAccounts.getState().accounts).toEqual([{ accountId: 2, name: 'Sam', username: 'sam', token: 'tok-3' }]);
  });

  it('forgets an account whose sign-in has ended', async () => {
    remember({ token: 'old', account: SAM });
    vi.spyOn(api, 'switchAccount').mockRejectedValue(new ApiError('That sign-in has ended: sign in again', 401));
    await expect(switchTo(2)).rejects.toThrow('That sign-in has ended');
    expect(useAccounts.getState().accounts).toEqual([]);
    expect(localStorage.getItem(ACCOUNTS_KEY)).toBe('[]');
  });

  it('reads back what an earlier visit kept, ignoring anything malformed', async () => {
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify([{ accountId: 2, name: 'Sam', username: 'sam', token: 't' }, { accountId: 'x' }, 'junk']));
    vi.resetModules();
    const fresh = await import('./accounts');
    expect(fresh.useAccounts.getState().accounts).toEqual([{ accountId: 2, name: 'Sam', username: 'sam', token: 't' }]);
  });

  it('names the device from its browser', () => {
    expect(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1')).toBe('Safari on iPhone');
    expect(deviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36')).toBe('Chrome on Mac');
    expect(deviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0')).toBe('Firefox on Windows');
    expect(deviceName('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0')).toBe('Edge on Linux');
  });
});
```

```ts
// apps/web/src/lib/api.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, signInRedirect } from './api';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('request', () => {
  it('sends the page to sign in when the server wants a session, but not for the sign-in calls themselves', async () => {
    const go = vi.spyOn(signInRedirect, 'go').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Sign in to Playarr', setup: false }), { status: 401 })));
    await expect(api.favorites()).rejects.toMatchObject({ status: 401, message: 'Sign in to Playarr' });
    expect(go).toHaveBeenCalledTimes(1);
    await expect(api.me()).rejects.toMatchObject({ status: 401 });
    expect(go).toHaveBeenCalledTimes(1);
  });
});
```

**Step 2: Run them to see them fail**

```bash
corepack pnpm -C apps/web exec vitest run src/lib/accounts.test.ts src/lib/api.test.ts
```

Expected: FAIL: `./accounts` not found; `signInRedirect` and `api.me` don't exist.

**Step 3: Implement**

In `apps/web/src/lib/api.ts`, add to the type import from `'@playarr/shared'`: `Account`, `AccountRole`, `ServerInfo`, `SessionInfo`, `SetupCode`, `SignInResponse`. Below the `ApiError` class add:

```ts
/** What an admin sets for an account (Settings → Accounts). */
export interface AccountInput {
  username: string;
  name: string;
  role: AccountRole;
  canRequest: boolean;
  sources: number[] | null;
}

/** Where a 401 sends the page: to sign in, then back. Replaceable in tests. */
export const signInRedirect = {
  go() {
    if (/^\/(sign-in|redeem|setup)(\/|$)/.test(location.pathname)) return;
    location.assign(`/sign-in?next=${encodeURIComponent(location.pathname + location.search)}`);
  },
};
```

In `request`, replace

```ts
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
```

with

```ts
  if (!res.ok) {
    // Signed out (or never signed in) on a server with accounts. The sign-in calls answer 401 themselves.
    if (res.status === 401 && !path.startsWith('/api/auth/')) signInRedirect.go();
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
```

Add to the `api` object, after `deleteProfile`:

```ts
  // Accounts (Settings → Accounts) and signing in.
  server: () => get<ServerInfo>('/api/server'),
  me: () => get<Account>('/api/auth/me'),
  setup: (body: { username: string; name: string; password: string; device: string; platform: string }) =>
    request<SignInResponse>('/api/auth/setup', { method: 'POST', body: JSON.stringify(body) }),
  signIn: (body: { username: string; password: string; device: string; platform: string }) =>
    request<SignInResponse>('/api/auth/sign-in', { method: 'POST', body: JSON.stringify(body) }),
  redeem: (body: { code: string; password: string; device: string; platform: string }) =>
    request<SignInResponse>('/api/auth/redeem', { method: 'POST', body: JSON.stringify(body) }),
  signOut: () => request<void>('/api/auth/sign-out', { method: 'POST' }),
  switchAccount: (token: string) => request<Account>('/api/auth/switch', { method: 'POST', body: JSON.stringify({ token }) }),
  accounts: () => get<Account[]>('/api/accounts'),
  createAccount: (body: AccountInput) => request<{ account: Account; setup: SetupCode }>('/api/accounts', { method: 'POST', body: JSON.stringify(body) }),
  updateAccount: (id: number, patch: Partial<AccountInput>) => request<Account>(`/api/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteAccount: (id: number) => request<Account[]>(`/api/accounts/${id}`, { method: 'DELETE' }),
  resetAccount: (id: number) => request<SetupCode>(`/api/accounts/${id}/reset`, { method: 'POST' }),
  sessions: (id: number) => get<SessionInfo[]>(`/api/accounts/${id}/sessions`),
  endSession: (id: number, sessionId: number) => request<SessionInfo[]>(`/api/accounts/${id}/sessions/${sessionId}`, { method: 'DELETE' }),
```

```ts
// apps/web/src/lib/accounts.ts
import type { Account, SignInResponse } from '@playarr/shared';
import { create } from 'zustand';
import { api, ApiError } from './api';
import { API_CACHE } from './cacheNames';
import { queryClient } from './queryClient';

/** An account signed in on this device: its session token, which the cookie is set to when it listens. */
export interface StoredAccount {
  accountId: number;
  name: string;
  username: string;
  token: string;
}

export const ACCOUNTS_KEY = 'playarr.accounts';

const isStored = (v: unknown): v is StoredAccount => {
  const a = v as Partial<StoredAccount> | null;
  return !!a && typeof a === 'object' && Number.isInteger(a.accountId) && typeof a.name === 'string' && typeof a.username === 'string' && typeof a.token === 'string';
};

function read(): StoredAccount[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(ACCOUNTS_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter(isStored) : [];
  } catch {
    return [];
  }
}

/** The accounts signed in on this device. */
export const useAccounts = create<{ accounts: StoredAccount[] }>(() => ({ accounts: read() }));

function save(accounts: StoredAccount[]) {
  try {
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
  } catch {
    // Storage full or blocked: this visit still works, the next asks to sign in again.
  }
  useAccounts.setState({ accounts });
}

/** Keep a fresh sign-in on this device (replacing that account's earlier one). */
export function remember({ token, account }: SignInResponse) {
  const others = useAccounts.getState().accounts.filter((a) => a.accountId !== account.id);
  save([...others, { accountId: account.id, name: account.name, username: account.username, token }]);
}

export function forget(accountId: number) {
  save(useAccounts.getState().accounts.filter((a) => a.accountId !== accountId));
}

/**
 * Listen as this account on this device: its session becomes the cookie, and nothing of the last
 * account stays on screen or in the offline fallback. An ended session is forgotten.
 */
export async function switchTo(accountId: number): Promise<Account> {
  const stored = useAccounts.getState().accounts.find((a) => a.accountId === accountId);
  if (!stored) throw new Error('That account isn’t signed in on this device');
  try {
    const account = await api.switchAccount(stored.token);
    save(useAccounts.getState().accounts.map((a) => (a.accountId === accountId ? { ...a, name: account.name, username: account.username } : a)));
    // The service worker's offline copies of API answers were the last account's.
    if (typeof caches !== 'undefined') await caches.delete(API_CACHE).catch(() => false);
    await queryClient.resetQueries();
    return account;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) forget(accountId);
    throw err;
  }
}

/** After signing in, redeeming a code or setting up the server: keep the account and listen as it. */
export async function signedIn(response: SignInResponse): Promise<Account> {
  remember(response);
  return switchTo(response.account.id);
}

/** Sign this device out of the account it listens as. */
export async function signOut() {
  const me = queryClient.getQueryData<Account>(['me']);
  await api.signOut().catch(() => {});
  if (me) forget(me.id);
  queryClient.clear();
}

/** "Safari on iPhone": how this device is listed under an account's sessions. */
export function deviceName(ua = navigator.userAgent): string {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\/|FxiOS/.test(ua) ? 'Firefox' : /Chrome\/|CriOS/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'A browser';
  const device = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Macintosh|Mac OS X/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'a computer';
  return `${browser} on ${device}`;
}
```

Append to `apps/web/src/lib/queries.ts` (after `useProfileAction`):

```ts
/** Which server this is, and whether it's set up (sign-in is on). */
export const useServerInfo = () => useQuery({ queryKey: ['server'], queryFn: api.server, staleTime: 60_000 });

/** Who listens on this device; an error (401) before setup or when signed out. */
export const useMe = () => useQuery({ queryKey: ['me'], queryFn: api.me, retry: false, staleTime: 5 * 60_000 });

/** Settings → Accounts, for admins. */
export const useAccountList = (enabled = true) => useQuery({ queryKey: ['accounts'], queryFn: api.accounts, enabled });

export const useAccountSessions = (id: number) => useQuery({ queryKey: ['sessions', id], queryFn: () => api.sessions(id) });

/** A change in Settings → Accounts: the lists show what the server answers. */
export function useAccountAction<T, R>(fn: (arg: T) => Promise<R>, onDone?: (result: R) => void) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (arg: T) => fn(arg),
    onSuccess: (result) => {
      for (const key of ['accounts', 'me', 'sessions']) void client.invalidateQueries({ queryKey: [key] });
      onDone?.(result);
    },
    onError: (err: Error) => toast(err.message, 'error'),
  });
}
```

**Step 4: Run the tests again**

```bash
corepack pnpm -C apps/web exec vitest run src/lib/accounts.test.ts src/lib/api.test.ts
corepack pnpm -C apps/web test
corepack pnpm -C apps/web typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/web/src/lib/api.ts apps/web/src/lib/accounts.ts apps/web/src/lib/queries.ts apps/web/src/lib/accounts.test.ts apps/web/src/lib/api.test.ts
git commit -m "$(cat <<'EOF'
Web: keep signed-in accounts on the device and switch the session cookie

A 401 sends the page to sign in, then back where it was.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 19: Web: sign-in, setup-code and setup pages

**Files:**
- Create: `apps/web/src/pages/SignIn.tsx`
- Modify: `apps/web/src/routes.tsx` (lines 17-19: three routes before the app shell)
- Test: `apps/web/src/pages/SignIn.test.tsx` (create)

The three pages stand outside the app shell (no player chrome, no polling). Setup is offered when the server says it's in setup mode; whether the visitor is on the home network is the server's call, and its 403 is shown as it comes.

**Step 1: Write the failing test**

```tsx
// apps/web/src/pages/SignIn.test.tsx
import type { Account, ServerInfo } from '@playarr/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { remember, useAccounts } from '../lib/accounts';
import { api, ApiError } from '../lib/api';
import { queryClient } from '../lib/queryClient';
import { RedeemPage, SetupPage, SignInPage } from './SignIn';

const SERVER: ServerInfo = { id: 'u', name: 'NAS', version: '0.7.0', minAppVersion: '1.0.0', setup: false };
const NICOLA: Account = { id: 1, username: 'nicola', name: 'Nicola', role: 'admin', canRequest: true, sources: null, hasPassword: true };
const SAM: Account = { id: 2, username: 'sam', name: 'Sam', role: 'member', canRequest: false, sources: null, hasPassword: true };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  useAccounts.setState({ accounts: [] });
  queryClient.clear();
});

function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      { path: '/sign-in', element: <SignInPage /> },
      { path: '/redeem', element: <RedeemPage /> },
      { path: '/setup', element: <SetupPage /> },
      { path: '/albums', element: <p>Albums page</p> },
      { path: '/settings/accounts', element: <p>Accounts settings</p> },
      { path: '/', element: <p>Home page</p> },
    ],
    { initialEntries: [path] },
  );
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('sign-in pages', () => {
  it('signs in, keeps the account on this device and goes back where it was', async () => {
    vi.spyOn(api, 'server').mockResolvedValue(SERVER);
    const signIn = vi.spyOn(api, 'signIn').mockResolvedValue({ token: 'tok-1', account: NICOLA });
    const swap = vi.spyOn(api, 'switchAccount').mockResolvedValue(NICOLA);
    renderAt('/sign-in?next=%2Falbums');
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'nicola' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct horse' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Albums page')).toBeTruthy();
    expect(signIn).toHaveBeenCalledWith(expect.objectContaining({ username: 'nicola', password: 'correct horse', platform: 'web' }));
    expect(swap).toHaveBeenCalledWith('tok-1');
    expect(useAccounts.getState().accounts.map((a) => a.accountId)).toEqual([1]);
  });

  it('says what went wrong', async () => {
    vi.spyOn(api, 'server').mockResolvedValue(SERVER);
    vi.spyOn(api, 'signIn').mockRejectedValue(new ApiError('Wrong username or password', 401));
    renderAt('/sign-in');
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'nicola' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'nope nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Wrong username or password');
  });

  it('continues as an account already signed in on this device', async () => {
    vi.spyOn(api, 'server').mockResolvedValue(SERVER);
    remember({ token: 'tok-2', account: SAM });
    const swap = vi.spyOn(api, 'switchAccount').mockResolvedValue(SAM);
    renderAt('/sign-in');
    fireEvent.click(await screen.findByRole('button', { name: 'Continue as Sam' }));
    expect(await screen.findByText('Home page')).toBeTruthy();
    expect(swap).toHaveBeenCalledWith('tok-2');
  });

  it('sends visitors of a server nobody has set up to set it up', async () => {
    vi.spyOn(api, 'server').mockResolvedValue({ ...SERVER, setup: true });
    renderAt('/sign-in');
    expect((await screen.findByRole('link', { name: 'Set up the owner’s account' })).getAttribute('href')).toBe('/setup');
  });

  it('chooses a first password with the code from a setup link', async () => {
    vi.spyOn(api, 'server').mockResolvedValue(SERVER);
    const redeem = vi.spyOn(api, 'redeem').mockResolvedValue({ token: 'tok-3', account: SAM });
    vi.spyOn(api, 'switchAccount').mockResolvedValue(SAM);
    renderAt('/redeem?code=ABCD2345');
    expect(((await screen.findByLabelText('Setup code')) as HTMLInputElement).value).toBe('ABCD2345');
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'sams password' } });
    fireEvent.change(screen.getByLabelText('Repeat it'), { target: { value: 'sams passwrod' } });
    fireEvent.click(screen.getByRole('button', { name: 'Choose password' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The passwords don’t match');
    fireEvent.change(screen.getByLabelText('Repeat it'), { target: { value: 'sams password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Choose password' }));
    expect(await screen.findByText('Home page')).toBeTruthy();
    expect(redeem).toHaveBeenCalledWith(expect.objectContaining({ code: 'ABCD2345', password: 'sams password', platform: 'web' }));
  });

  it('sets up the owner’s account, then opens Settings → Accounts', async () => {
    vi.spyOn(api, 'server').mockResolvedValue({ ...SERVER, setup: true });
    const setup = vi.spyOn(api, 'setup').mockResolvedValue({ token: 'tok-1', account: NICOLA });
    vi.spyOn(api, 'switchAccount').mockResolvedValue(NICOLA);
    renderAt('/setup');
    fireEvent.change(await screen.findByLabelText('Your name'), { target: { value: 'Nicola' } });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'nicola' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct horse' } });
    fireEvent.change(screen.getByLabelText('Repeat it'), { target: { value: 'correct horse' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set up Playarr' }));
    expect(await screen.findByText('Accounts settings')).toBeTruthy();
    expect(setup).toHaveBeenCalledWith(expect.objectContaining({ username: 'nicola', name: 'Nicola', password: 'correct horse' }));
  });
});
```

**Step 2: Run it to see it fail**

```bash
corepack pnpm -C apps/web exec vitest run src/pages/SignIn.test.tsx
```

Expected: FAIL: `./SignIn` not found.

**Step 3: Implement**

```tsx
// apps/web/src/pages/SignIn.tsx
import { useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Wordmark } from '../components/Nav';
import { deviceName, signedIn, switchTo, useAccounts } from '../lib/accounts';
import { api } from '../lib/api';
import { useServerInfo } from '../lib/queries';

const INPUT =
  'mt-1 h-11 w-full rounded-lg border border-line bg-ink-900 px-3 text-[15px] text-paper outline-none transition placeholder:text-muted focus:border-accent';
const PRIMARY =
  'inline-flex h-11 w-full items-center justify-center rounded-full bg-accent px-5 font-medium text-accent-ink transition hover:brightness-110 disabled:opacity-40';
const SECONDARY =
  'inline-flex h-11 w-full items-center justify-center rounded-full border border-line px-5 text-[15px] text-paper transition hover:bg-paper/5 disabled:opacity-40';

/** Where to go after signing in: a page of this app, never another site. */
const safeNext = (raw: string | null) => (raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/');

function AuthLayout({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center px-5 py-10">
      <div className="w-full max-w-sm">
        <Wordmark />
        <h1 className="mt-8 font-display text-4xl text-paper">{title}</h1>
        {subtitle && <p className="mt-2 text-[15px] text-muted">{subtitle}</p>}
        <div className="mt-8">{children}</div>
      </div>
    </main>
  );
}

function Field({ label, ...input }: { label: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block text-[13px] text-muted">
      {label}
      <input {...input} className={INPUT} />
    </label>
  );
}

/** Runs a step of signing in, keeping what went wrong to show. */
function useStep() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (step: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await step();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, run };
}

const Problem = ({ error }: { error: string | null }) =>
  error ? (
    <p role="alert" className="text-sm text-red-300/90">
      {error}
    </p>
  ) : null;

/** Sign in: or continue as an account already signed in on this device. `?add=1` adds another. */
export function SignInPage() {
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const adding = params.has('add');
  const navigate = useNavigate();
  const { data: server } = useServerInfo();
  const stored = useAccounts((s) => s.accounts);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const { error, busy, run } = useStep();
  const done = () => navigate(next, { replace: true });

  if (server?.setup) {
    return (
      <AuthLayout title="Set up Playarr" subtitle={server.name}>
        <p className="text-[15px] text-paper-dim">
          Nobody has set up this server yet. Choose the owner’s username and password, from your home network, to turn sign-in on.
        </p>
        <Link to="/setup" className={`${PRIMARY} mt-6`}>
          Set up the owner’s account
        </Link>
      </AuthLayout>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await signedIn(await api.signIn({ username: username.trim(), password, device: deviceName(), platform: 'web' }));
      done();
    });
  };

  return (
    <AuthLayout title={adding ? 'Add an account' : 'Sign in'} subtitle={server?.name}>
      {!adding && stored.length > 0 && (
        <div className="mb-8 space-y-2">
          {stored.map((a) => (
            <button
              key={a.accountId}
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await switchTo(a.accountId);
                  done();
                })
              }
              className={SECONDARY}
            >
              Continue as {a.name}
            </button>
          ))}
          <p className="pt-2 text-center text-[13px] text-muted">or sign in to another account</p>
        </div>
      )}
      <form onSubmit={submit} className="space-y-4">
        <Field label="Username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} required />
        <Field label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        <Problem error={error} />
        <button type="submit" disabled={busy || !username.trim() || !password} className={PRIMARY}>
          Sign in
        </button>
      </form>
      <p className="mt-6 text-[13px] text-muted">
        Got a setup code?{' '}
        <Link to="/redeem" className="text-paper-dim underline underline-offset-2 hover:text-paper">
          Choose your password
        </Link>
      </p>
    </AuthLayout>
  );
}

/** A new or reset account chooses its password with the code (or link) an admin gave them. */
export function RedeemPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { data: server } = useServerInfo();
  const [code, setCode] = useState(params.get('code') ?? '');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const { error, busy, run } = useStep();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      if (password !== again) throw new Error('The passwords don’t match');
      await signedIn(await api.redeem({ code: code.trim(), password, device: deviceName(), platform: 'web' }));
      navigate('/', { replace: true });
    });
  };

  return (
    <AuthLayout title="Choose your password" subtitle={server?.name}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Setup code" value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="characters" autoComplete="one-time-code" spellCheck={false} required />
        <Field label="New password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
        <Field label="Repeat it" type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" required />
        <Problem error={error} />
        <button type="submit" disabled={busy || !code.trim() || !password} className={PRIMARY}>
          Choose password
        </button>
      </form>
      <p className="mt-6 text-[13px] text-muted">
        At least 8 characters. Already chosen one?{' '}
        <Link to="/sign-in" className="text-paper-dim underline underline-offset-2 hover:text-paper">
          Sign in
        </Link>
      </p>
    </AuthLayout>
  );
}

/** The owner claims the server: their username and password, from the home network, once. */
export function SetupPage() {
  const navigate = useNavigate();
  const { data: server } = useServerInfo();
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const { error, busy, run } = useStep();

  if (server && !server.setup) {
    return (
      <AuthLayout title="Already set up" subtitle={server.name}>
        <p className="text-[15px] text-paper-dim">This server has an owner. Sign in, or ask an admin for a setup code.</p>
        <Link to="/sign-in" className={`${PRIMARY} mt-6`}>
          Sign in
        </Link>
      </AuthLayout>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      if (password !== again) throw new Error('The passwords don’t match');
      await signedIn(await api.setup({ username: username.trim(), name: name.trim(), password, device: deviceName(), platform: 'web' }));
      navigate('/settings/accounts', { replace: true });
    });
  };

  return (
    <AuthLayout title="Set up Playarr" subtitle={server?.name}>
      <p className="mb-6 text-[15px] text-paper-dim">
        You’re the owner: your listening so far stays yours, and you can add an account for everyone else afterwards.
      </p>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Your name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required />
        <Field label="Username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={32} required />
        <Field label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
        <Field label="Repeat it" type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" required />
        <Problem error={error} />
        <button type="submit" disabled={busy || !name.trim() || !username.trim() || !password} className={PRIMARY}>
          Set up Playarr
        </button>
      </form>
    </AuthLayout>
  );
}
```

In `apps/web/src/routes.tsx`, make these the first entries of `routes`:

```tsx
export const routes: RouteObject[] = [
  // Signing in, choosing a password from a setup code, and claiming the server: pages of their own, without the player.
  { path: 'sign-in', lazy: () => import('./pages/SignIn').then((m) => ({ Component: m.SignInPage })) },
  { path: 'redeem', lazy: () => import('./pages/SignIn').then((m) => ({ Component: m.RedeemPage })) },
  { path: 'setup', lazy: () => import('./pages/SignIn').then((m) => ({ Component: m.SetupPage })) },
  {
    element: <AppShell />,
```

(the rest of the array is unchanged).

**Step 4: Run the tests again**

```bash
corepack pnpm -C apps/web exec vitest run src/pages/SignIn.test.tsx
corepack pnpm -C apps/web test
corepack pnpm -C apps/web typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/web/src/pages/SignIn.tsx apps/web/src/pages/SignIn.test.tsx apps/web/src/routes.tsx
git commit -m "$(cat <<'EOF'
Web: sign-in, setup-code and server setup pages

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 20: Web: the account switcher on Home

**Files:**
- Create: `apps/web/src/components/AccountSwitcher.tsx`
- Modify: `apps/web/src/pages/Home.tsx` (imports lines 11-14, lines 22-23, lines 38-42, delete lines 160-199 `WhoIsListening`)
- Test: `apps/web/src/components/AccountSwitcher.test.tsx` (create)

"Not X? Listen as Y" now switches between the accounts signed in on this device, or adds one.

**Step 1: Write the failing test**

```tsx
// apps/web/src/components/AccountSwitcher.test.tsx
import type { Account } from '@playarr/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { remember, useAccounts } from '../lib/accounts';
import { api, ApiError } from '../lib/api';
import { queryClient } from '../lib/queryClient';
import { AccountSwitcher } from './AccountSwitcher';

const NICOLA: Account = { id: 1, username: 'nicola', name: 'Nicola', role: 'admin', canRequest: true, sources: null, hasPassword: true };
const SAM: Account = { id: 2, username: 'sam', name: 'Sam', role: 'member', canRequest: false, sources: null, hasPassword: true };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  useAccounts.setState({ accounts: [] });
  queryClient.clear();
});

const view = () =>
  render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <AccountSwitcher />
      </QueryClientProvider>
    </MemoryRouter>,
  );

describe('AccountSwitcher', () => {
  it('switches between the accounts signed in on this device, or adds one', async () => {
    vi.spyOn(api, 'me').mockResolvedValue(NICOLA);
    remember({ token: 'tok-1', account: NICOLA });
    remember({ token: 'tok-2', account: SAM });
    const swap = vi.spyOn(api, 'switchAccount').mockResolvedValue(SAM);
    view();
    expect(await screen.findByText('Not Nicola?')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Add account' }).getAttribute('href')).toBe('/sign-in?add=1');
    expect(screen.queryByRole('button', { name: 'Listen as Nicola' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Listen as Sam' }));
    await waitFor(() => expect(swap).toHaveBeenCalledWith('tok-2'));
  });

  it('stays out of sight while nobody is signed in (setup mode)', async () => {
    const me = vi.spyOn(api, 'me').mockRejectedValue(new ApiError('Nobody is signed in', 401));
    const { container } = view();
    await waitFor(() => expect(me).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});
```

**Step 2: Run it to see it fail**

```bash
corepack pnpm -C apps/web exec vitest run src/components/AccountSwitcher.test.tsx
```

Expected: FAIL: `./AccountSwitcher` not found.

**Step 3: Implement**

```tsx
// apps/web/src/components/AccountSwitcher.tsx
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { switchTo, useAccounts } from '../lib/accounts';
import { ApiError } from '../lib/api';
import { cn } from '../lib/cn';
import { useMe } from '../lib/queries';
import { toast } from '../lib/toast';

const LINK = 'text-paper-dim underline-offset-2 hover:text-paper hover:underline disabled:opacity-50';

/** Top of Home: who listens on this device, and the other accounts signed in on it, a tap away. */
export function AccountSwitcher({ className }: { className?: string }) {
  const { data: me } = useMe();
  const stored = useAccounts((s) => s.accounts);
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  if (!me) return null;

  const listenAs = async (accountId: number) => {
    setBusy(true);
    try {
      await switchTo(accountId);
    } catch (err) {
      toast((err as Error).message, 'error');
      if (err instanceof ApiError && err.status === 401) navigate('/sign-in?add=1');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cn('flex flex-wrap gap-x-3 gap-y-1 text-[13px] text-muted', className)}>
      <span>Not {me.name}?</span>
      {stored
        .filter((a) => a.accountId !== me.id)
        .map((a) => (
          <button key={a.accountId} type="button" disabled={busy} onClick={() => void listenAs(a.accountId)} className={LINK}>
            Listen as {a.name}
          </button>
        ))}
      <Link to="/sign-in?add=1" className={LINK}>
        Add account
      </Link>
    </div>
  );
}
```

`Not {me.name}?` renders the text nodes "Not ", "Nicola" and "?" inside one `<span>`; `findByText('Not Nicola?')` matches the span's joined text.

In `apps/web/src/pages/Home.tsx`:

- line 11 loses `switchProfile` and `useProfiles` from the import;
- delete lines 12-14 (`usePrefs`, `useCurrentProfile`, `Profile` imports) and add `import { AccountSwitcher } from '../components/AccountSwitcher';`;
- delete lines 22-23 (`const { data: profiles } = useProfiles();` and `const current = useCurrentProfile();`);
- replace lines 38-42:

```tsx
      {profiles && profiles.length > 1 && (
        <div className="mb-8 animate-rise">
          <WhoIsListening profiles={profiles} current={current} />
        </div>
      )}
```

with:

```tsx
      <AccountSwitcher className="mb-8 animate-rise" />
```

- delete `WhoIsListening` and its comment (lines 160-199).

**Step 4: Run the tests again**

```bash
corepack pnpm -C apps/web exec vitest run src/components/AccountSwitcher.test.tsx
corepack pnpm -C apps/web test
corepack pnpm -C apps/web typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/web/src/components/AccountSwitcher.tsx apps/web/src/components/AccountSwitcher.test.tsx apps/web/src/pages/Home.tsx
git commit -m "$(cat <<'EOF'
Web: switch between accounts signed in on this device from Home

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---
### Task 21: Web: Settings → Accounts; profiles go

**Files:**
- Create: `apps/web/src/components/AccountsPanel.tsx`
- Delete: `apps/web/src/components/ProfilesPanel.tsx`, `apps/web/src/components/ProfilesPanel.test.tsx`
- Modify: `apps/web/src/pages/Settings.tsx` (line 7, line 17)
- Modify: `apps/web/src/lib/api.ts` (the `Profile` type import, lines 126-127 the profile header, the four profile endpoints)
- Modify: `apps/web/src/lib/queries.ts` (delete lines 780-799: `useProfiles`, `PERSONAL`, `switchProfile`, `useProfileAction`)
- Modify: `apps/web/src/lib/prefs.ts` (lines 40-41, 52, 56, 59, 80, 102, 108, 117), `apps/web/src/lib/prefs.test.ts` (lines 4, 20, 29, 31)
- Modify: `apps/web/src/player/playTracker.ts` (line 68)
- Modify: `packages/shared/src/index.ts` (`PlayReport.profile` lines 710-711; the `Profile` interface lines 854-858)
- Modify (copy only): `apps/web/src/components/SettingsControls.tsx` (lines 28-32), `MixesPanel.tsx` (line 74), `RequestsPanel.tsx` (line 20), `UpdatesPanel.tsx` (line 36), `AnalysisPanel.tsx` (line 231), `TrackMetadataDialog.tsx` (lines 59, 84), `AnalysisPanel.test.tsx` (line 243), `TrackMetadataDialog.test.tsx` (lines 87-91)
- Test: `apps/web/src/components/AccountsPanel.test.tsx` (create)

Admins list, add (setup code shown as code, link and Copy), edit (name, username, role, requests, library), reset, remove and see each account's devices; everyone renames themselves, sees and signs out their own devices, and signs out here. Before setup the panel offers to set up the owner. The "home network" notices become "only an admin".

**Step 1: Write the failing test**

```tsx
// apps/web/src/components/AccountsPanel.test.tsx
import type { Account, ServerInfo, SourceInfo } from '@playarr/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { queryClient } from '../lib/queryClient';
import { AccountsPanel } from './AccountsPanel';

const SERVER: ServerInfo = { id: 'u', name: 'NAS', version: '0.7.0', minAppVersion: '1.0.0', setup: false };
const NICOLA: Account = { id: 1, username: 'nicola', name: 'Nicola', role: 'admin', canRequest: true, sources: null, hasPassword: true };
const SAM: Account = { id: 2, username: 'sam', name: 'Sam', role: 'member', canRequest: false, sources: null, hasPassword: true };
const CC = { id: 2, kind: 'folder', name: 'Creative Commons', position: 1, enabled: true } as SourceInfo;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  queryClient.clear();
});

const view = () =>
  render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <AccountsPanel />
      </QueryClientProvider>
    </MemoryRouter>,
  );

describe('AccountsPanel', () => {
  it('lets an admin add an account and shows its setup code and link', async () => {
    vi.spyOn(api, 'server').mockResolvedValue(SERVER);
    vi.spyOn(api, 'me').mockResolvedValue(NICOLA);
    vi.spyOn(api, 'accounts').mockResolvedValue([NICOLA, SAM]);
    vi.spyOn(api, 'sessions').mockResolvedValue([]);
    vi.spyOn(api, 'sources').mockResolvedValue({ sources: [CC], canEdit: true });
    const reviewer: Account = { id: 3, username: 'reviewer', name: 'App Review', role: 'member', canRequest: false, sources: [2], hasPassword: false };
    const create = vi.spyOn(api, 'createAccount').mockResolvedValue({
      account: reviewer,
      setup: { code: 'ABCD2345', link: 'http://nas:4000/redeem?code=ABCD2345', expiresAt: '2026-11-10T10:00:00Z' },
    });
    view();
    expect(await screen.findByText('Sam')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Add account/ }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'App Review' } });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'reviewer' } });
    fireEvent.click(screen.getByLabelText('Can request albums')); // on by default for new accounts: off
    fireEvent.click(screen.getByLabelText('Only these sources'));
    fireEvent.click(await screen.findByLabelText('Creative Commons'));
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ username: 'reviewer', name: 'App Review', role: 'member', canRequest: false, sources: [2] }));
    expect(await screen.findByText('ABCD2345')).toBeTruthy();
    expect((screen.getByLabelText('Setup link') as HTMLInputElement).value).toBe('http://nas:4000/redeem?code=ABCD2345');
  });

  it('shows a member their own name and devices, not everyone', async () => {
    vi.spyOn(api, 'server').mockResolvedValue(SERVER);
    vi.spyOn(api, 'me').mockResolvedValue(SAM);
    const accounts = vi.spyOn(api, 'accounts');
    vi.spyOn(api, 'sessions').mockResolvedValue([
      { id: 7, device: 'Safari on iPhone', platform: 'web', createdAt: '2026-11-03T10:00:00Z', lastSeenAt: '2026-11-03T11:00:00Z', current: true },
      { id: 8, device: 'Playarr on iPad', platform: 'ios', createdAt: '2026-11-02T10:00:00Z', lastSeenAt: '2026-11-02T11:00:00Z', current: false },
    ]);
    const end = vi.spyOn(api, 'endSession').mockResolvedValue([]);
    const rename = vi.spyOn(api, 'updateAccount').mockResolvedValue({ ...SAM, name: 'Samantha' });
    view();
    expect(await screen.findByText('Safari on iPhone')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Add account/ })).toBeNull();
    expect(accounts).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out Playarr on iPad' }));
    await waitFor(() => expect(end).toHaveBeenCalledWith(2, 8));
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Samantha' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(rename).toHaveBeenCalledWith(2, { name: 'Samantha' }));
  });

  it('offers to set up a server nobody has set up', async () => {
    vi.spyOn(api, 'server').mockResolvedValue({ ...SERVER, setup: true });
    vi.spyOn(api, 'me').mockRejectedValue(new Error('Nobody is signed in'));
    view();
    expect((await screen.findByRole('link', { name: 'Set up the owner’s account' })).getAttribute('href')).toBe('/setup');
  });
});
```

**Step 2: Run it to see it fail**

```bash
corepack pnpm -C apps/web exec vitest run src/components/AccountsPanel.test.tsx
```

Expected: FAIL: `./AccountsPanel` not found.

**Step 3: Implement**

```tsx
// apps/web/src/components/AccountsPanel.tsx
import type { Account, AccountRole, SetupCode } from '@playarr/shared';
import { Copy, KeyRound, LogOut, Pencil, Smartphone, Trash2, UserPlus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { signOut } from '../lib/accounts';
import { api, type AccountInput } from '../lib/api';
import { cn } from '../lib/cn';
import { useAccountAction, useAccountList, useAccountSessions, useMe, useServerInfo, useSources } from '../lib/queries';
import { toast } from '../lib/toast';
import { Dialog } from './Dialog';
import { SettingsSection } from './SettingsControls';

const INPUT =
  'h-10 w-full rounded-lg border border-line bg-ink-900 px-3 text-[15px] text-paper outline-none transition focus:border-accent';
const BUTTON =
  'inline-flex h-10 items-center gap-2 rounded-full border border-line px-4 text-[14px] text-paper transition hover:bg-paper/5 disabled:opacity-40';
const ICON = 'grid size-9 shrink-0 place-items-center rounded-full text-muted transition hover:bg-paper/8 hover:text-paper';
const LOADING = <div aria-busy="true" className="h-40 max-w-prose animate-pulse rounded-lg bg-paper/5" />;

/** Settings → Accounts: who signs in to this server and what each may hear and change; your name and devices. */
export function AccountsPanel() {
  const { data: server } = useServerInfo();
  const { data: me, error, isPending } = useMe();
  if (!server) return LOADING;
  if (server.setup) return <ClaimServer />;
  if (isPending) return LOADING;
  if (!me) return <p className="text-sm text-red-300/80">{error?.message ?? 'Sign in to see your account.'}</p>;
  return (
    <div>
      <You me={me} />
      {me.role === 'admin' && <Everyone me={me} />}
    </div>
  );
}

function ClaimServer() {
  return (
    <SettingsSection
      title="Set up this server"
      description="Nobody has a password here yet, so anyone on your home network can listen and change settings. Choose the owner’s username and password to turn sign-in on; then add an account for everyone else."
    >
      <Link to="/setup" className={BUTTON}>
        Set up the owner’s account
      </Link>
    </SettingsSection>
  );
}

function You({ me }: { me: Account }) {
  const navigate = useNavigate();
  const [name, setName] = useState(me.name);
  const rename = useAccountAction((n: string) => api.updateAccount(me.id, { name: n }), () => toast('Name saved'));
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() && name.trim() !== me.name) rename.mutate(name.trim());
  };
  return (
    <SettingsSection title="You" description={`Signed in as ${me.username}${me.role === 'admin' ? ', an admin' : ''}.`}>
      <form onSubmit={save} className="flex max-w-md gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Your name" maxLength={40} className={INPUT} />
        <button type="submit" disabled={!name.trim() || name.trim() === me.name || rename.isPending} className={cn(BUTTON, 'shrink-0')}>
          Save
        </button>
      </form>
      <h3 className="mt-6 mb-1 text-[13px] text-muted">Signed in on</h3>
      <Devices accountId={me.id} />
      <button type="button" onClick={() => void signOut().then(() => navigate('/sign-in', { replace: true }))} className={cn(BUTTON, 'mt-5')}>
        <LogOut className="size-4" /> Sign out on this device
      </button>
    </SettingsSection>
  );
}

/** An account's signed-in devices, each but this one signed out with a tap. */
function Devices({ accountId }: { accountId: number }) {
  const { data: sessions } = useAccountSessions(accountId);
  const end = useAccountAction((sessionId: number) => api.endSession(accountId, sessionId));
  if (!sessions) return <div aria-busy="true" className="h-16 animate-pulse rounded-lg bg-paper/5" />;
  if (!sessions.length) return <p className="text-sm text-muted">No devices are signed in.</p>;
  return (
    <ul className="divide-y divide-line">
      {sessions.map((s) => (
        <li key={s.id} className="flex items-center gap-3 py-2">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15px] text-paper">
              {s.device}
              {s.current && <span className="ml-2 text-[13px] text-muted">this device</span>}
            </span>
            <span className="block text-[12px] text-muted">Last used {new Date(s.lastSeenAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
          </span>
          {!s.current && (
            <button type="button" aria-label={`Sign out ${s.device}`} onClick={() => end.mutate(s.id)} className={ICON}>
              <LogOut className="size-4" />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** "sam · member · can request albums · Creative Commons" */
function summary(a: Account, sourceNames: Map<number, string>): string {
  const library = a.sources === null ? 'every source' : a.sources.length ? a.sources.map((id) => sourceNames.get(id) ?? `source ${id}`).join(', ') : 'no sources';
  return [a.username, a.role, a.canRequest ? 'can request albums' : '', library, a.hasPassword ? '' : 'not set up yet'].filter(Boolean).join(' · ');
}

function Everyone({ me }: { me: Account }) {
  const navigate = useNavigate();
  const { data: accounts, error } = useAccountList();
  const { data: sourceList } = useSources();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [devices, setDevices] = useState<Account | null>(null);
  const [removing, setRemoving] = useState<Account | null>(null);
  const [code, setCode] = useState<{ account: Account; setup: SetupCode } | null>(null);
  const create = useAccountAction((input: AccountInput) => api.createAccount(input), (created) => {
    setAdding(false);
    setCode(created);
  });
  const update = useAccountAction(({ id, input }: { id: number; input: AccountInput }) => api.updateAccount(id, input), () => setEditing(null));
  const reset = useAccountAction((a: Account) => api.resetAccount(a.id).then((setup) => ({ account: a, setup })), setCode);
  const remove = useAccountAction(
    (a: Account) => api.deleteAccount(a.id),
    () => {
      if (removing?.id === me.id) void signOut().then(() => navigate('/sign-in', { replace: true }));
      setRemoving(null);
    },
  );

  if (error) return <p className="mt-12 text-sm text-red-300/80">{error.message}</p>;
  if (!accounts) return LOADING;
  const sourceNames = new Map((sourceList?.sources ?? []).map((s) => [s.id, s.name]));

  return (
    <SettingsSection
      title="Everyone"
      description="Each account has its own history, mixes, favorites and playlists, and hears every source or only the ones you pick. Admins change settings, sources and accounts. You never choose anyone’s password: a new or reset account gets a setup code."
    >
      <ul className="divide-y divide-line">
        {accounts.map((a) => (
          <li key={a.id} className="flex items-center gap-1 py-2">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] text-paper">
                {a.name}
                {a.id === me.id && <span className="ml-2 text-[13px] text-muted">you</span>}
              </span>
              <span className="block truncate text-[12px] text-muted">{summary(a, sourceNames)}</span>
            </span>
            <button type="button" aria-label={`Edit ${a.name}`} onClick={() => setEditing(a)} className={ICON}>
              <Pencil className="size-4" />
            </button>
            <button type="button" aria-label={`Devices of ${a.name}`} onClick={() => setDevices(a)} className={ICON}>
              <Smartphone className="size-4" />
            </button>
            <button type="button" aria-label={`New setup code for ${a.name}`} onClick={() => reset.mutate(a)} className={ICON}>
              <KeyRound className="size-4" />
            </button>
            <button type="button" aria-label={`Remove ${a.name}`} onClick={() => setRemoving(a)} className={ICON}>
              <Trash2 className="size-4" />
            </button>
          </li>
        ))}
      </ul>
      <button type="button" onClick={() => setAdding(true)} className={cn(BUTTON, 'mt-5')}>
        <UserPlus className="size-4" /> Add account
      </button>

      <Dialog open={adding} onClose={() => setAdding(false)} title="Add account">
        {adding && <AccountForm submitLabel="Add" busy={create.isPending} onSubmit={(input) => create.mutate(input)} />}
      </Dialog>
      <Dialog open={!!editing} onClose={() => setEditing(null)} title={`Edit ${editing?.name ?? ''}`}>
        {editing && <AccountForm account={editing} submitLabel="Save" busy={update.isPending} onSubmit={(input) => update.mutate({ id: editing.id, input })} />}
      </Dialog>
      <Dialog open={!!devices} onClose={() => setDevices(null)} title={`${devices?.name ?? ''}’s devices`}>
        {devices && (
          <div className="p-5">
            <Devices accountId={devices.id} />
          </div>
        )}
      </Dialog>
      <Dialog open={!!code} onClose={() => setCode(null)} title={`Setup code for ${code?.account.name ?? ''}`}>
        {code && <SetupCodeView setup={code.setup} />}
      </Dialog>
      <Dialog open={!!removing} onClose={() => setRemoving(null)} title={`Remove ${removing?.name ?? ''}?`}>
        <div className="space-y-5 p-5">
          <p className="text-[15px] text-paper-dim">Their listening history, mixes, favorites and playlists are deleted, and every device they’re signed in on is signed out.</p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setRemoving(null)} className={BUTTON}>
              Cancel
            </button>
            <button
              type="button"
              disabled={remove.isPending}
              onClick={() => removing && remove.mutate(removing)}
              className="inline-flex h-10 items-center rounded-full bg-red-400/90 px-5 text-[14px] font-medium text-ink-950 transition hover:bg-red-400 disabled:opacity-40"
            >
              Remove
            </button>
          </div>
        </div>
      </Dialog>
    </SettingsSection>
  );
}

/** Name, username, role, requests and library: for a new account, or to change one. */
function AccountForm({ account, submitLabel, busy, onSubmit }: { account?: Account; submitLabel: string; busy: boolean; onSubmit: (input: AccountInput) => void }) {
  const { data: sourceList } = useSources();
  const [name, setName] = useState(account?.name ?? '');
  const [username, setUsername] = useState(account?.username ?? '');
  const [role, setRole] = useState<AccountRole>(account?.role ?? 'member');
  const [canRequest, setCanRequest] = useState(account?.canRequest ?? true);
  const [everySource, setEverySource] = useState(account ? account.sources === null : true);
  const [picked, setPicked] = useState<number[]>(account?.sources ?? []);
  const toggle = (id: number) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit({ username: username.trim(), name: name.trim(), role, canRequest, sources: everySource ? null : picked });
  };
  const check = 'size-4 accent-[var(--accent)]';
  return (
    <form onSubmit={submit} className="space-y-5 p-5">
      <label className="block text-[13px] text-muted">
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required className={cn(INPUT, 'mt-1')} />
      </label>
      <label className="block text-[13px] text-muted">
        Username
        <input value={username} onChange={(e) => setUsername(e.target.value)} maxLength={32} required autoCapitalize="none" autoCorrect="off" spellCheck={false} className={cn(INPUT, 'mt-1')} />
      </label>
      <fieldset className="space-y-2">
        <legend className="mb-1 text-[13px] text-muted">Role</legend>
        <label className="flex items-center gap-2 text-[15px] text-paper">
          <input type="radio" name="role" checked={role === 'member'} onChange={() => setRole('member')} className={check} />
          Member: listens
        </label>
        <label className="flex items-center gap-2 text-[15px] text-paper">
          <input type="radio" name="role" checked={role === 'admin'} onChange={() => setRole('admin')} className={check} />
          Admin: also changes settings, sources and accounts
        </label>
      </fieldset>
      <label className="flex items-center gap-2 text-[15px] text-paper">
        <input type="checkbox" checked={canRequest} onChange={(e) => setCanRequest(e.target.checked)} className={check} />
        Can request albums
      </label>
      <fieldset className="space-y-2">
        <legend className="mb-1 text-[13px] text-muted">Library</legend>
        <label className="flex items-center gap-2 text-[15px] text-paper">
          <input type="radio" name="library" checked={everySource} onChange={() => setEverySource(true)} className={check} />
          Every source
        </label>
        <label className="flex items-center gap-2 text-[15px] text-paper">
          <input type="radio" name="library" checked={!everySource} onChange={() => setEverySource(false)} className={check} />
          Only these sources
        </label>
        {!everySource && (
          <div className="ml-6 space-y-2">
            {(sourceList?.sources ?? []).map((s) => (
              <label key={s.id} className="flex items-center gap-2 text-[15px] text-paper">
                <input type="checkbox" checked={picked.includes(s.id)} onChange={() => toggle(s.id)} className={check} />
                {s.name}
              </label>
            ))}
          </div>
        )}
      </fieldset>
      <div className="flex justify-end">
        <button type="submit" disabled={busy || !name.trim() || !username.trim()} className="inline-flex h-10 items-center rounded-full bg-accent px-5 text-[14px] font-medium text-accent-ink transition hover:brightness-110 disabled:opacity-40">
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

/** A new or reset account's one-time code, and the link that fills it in. */
function SetupCodeView({ setup }: { setup: SetupCode }) {
  const copy = () =>
    void navigator.clipboard?.writeText(setup.link).then(
      () => toast('Link copied'),
      () => toast('Couldn’t copy: select the link instead', 'error'),
    );
  return (
    <div className="space-y-4 p-5">
      <p className="text-[15px] text-paper-dim">
        Give them this code or link: they choose their own password with it. It works once, until{' '}
        {new Date(setup.expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}.
      </p>
      <p className="font-mono text-3xl tracking-[0.3em] text-paper">{setup.code}</p>
      <div className="flex gap-2">
        <input readOnly value={setup.link} aria-label="Setup link" onFocus={(e) => e.target.select()} className={INPUT} />
        <button type="button" onClick={copy} className={cn(BUTTON, 'shrink-0')}>
          <Copy className="size-4" /> Copy
        </button>
      </div>
    </div>
  );
}
```

`apps/web/src/pages/Settings.tsx`: line 7 becomes `import { AccountsPanel } from '../components/AccountsPanel';` and line 17 becomes:

```tsx
  { id: 'accounts', label: 'Accounts', scope: 'Who signs in to this server, and what each account may hear and change.', Panel: AccountsPanel },
```

Remove the profiles from the web:

```bash
git rm apps/web/src/components/ProfilesPanel.tsx apps/web/src/components/ProfilesPanel.test.tsx
```

- `apps/web/src/lib/api.ts`: drop `Profile,` from the type import; delete the two lines that send `X-Playarr-Profile` (the comment `// Who's listening on this device: their mixes, stats and history.` and the spread after it); delete `profiles`, `createProfile`, `renameProfile`, `deleteProfile` from `api`. The `usePrefs` import is now unused there: delete it.
- `apps/web/src/lib/queries.ts`: delete `useProfiles`, the `PERSONAL` constant and its comment, `switchProfile` and `useProfileAction` (lines 780-799), and the import `import { usePrefs } from './prefs';` (line 29), which nothing else there uses.
- `apps/web/src/lib/prefs.ts`: delete the `profileId` field and its comment (lines 40-41), `setProfileId(id: number | null): void;` (line 52), `| 'profileId'` from `Saved` (line 56), `profileId: null, ` from `DEFAULTS` (line 59), the `profileId:` line in `clean` (line 80), `setProfileId: (profileId) => set({ profileId }),` (line 102), and `profileId` from `partialize`'s parameter list and object (lines 108 and 117).
- `apps/web/src/lib/prefs.test.ts`: delete `profileId: null, ` from `defaults` (line 4), `setProfileId, ` from the destructuring (line 20), the line `setProfileId(2);` (line 29), and `profileId: 2, ` from `saved` (line 31).
- `apps/web/src/player/playTracker.ts`: delete line 68 (`...(usePrefs.getState().profileId ? { profile: usePrefs.getState().profileId! } : {}),`).
- `packages/shared/src/index.ts`: delete `PlayReport`'s last field and its comment (lines 710-711: `/** Who was listening … */` and `profile?: number;`), and delete the `Profile` interface with its comment (lines 854-858).

The "home network" notices name admins now (before setup the server still goes by the home network, and says so in its own 403 messages):

- `SettingsControls.tsx` lines 28-32: the comment becomes `/** Shown in place of settings only an admin can see and change. */` and the default text `'Only an admin can change these settings.'`.
- `MixesPanel.tsx` line 74, `RequestsPanel.tsx` line 20, `UpdatesPanel.tsx` line 36: `<AwayNotice>Settings can be changed from your home network.</AwayNotice>` becomes `<AwayNotice />`.
- `AnalysisPanel.tsx` line 231: `Analyses can be started from your home network.` becomes `Analyses can be started by an admin.`; `AnalysisPanel.test.tsx` line 243 expects `'Analyses can be started by an admin.'`.
- `TrackMetadataDialog.tsx` line 59: `Matching a song again on MusicBrainz is for admins.`; line 84: `File paths and where sources live are shown to admins only.`. In `TrackMetadataDialog.test.tsx` line 87 expects `/shown to admins only/`, line 89's comment reads `// Matching again changes the catalog: offered to admins only, and the dialog says so.`, line 91 expects `/Matching a song again on MusicBrainz is for admins/`.

**Step 4: Run the tests again**

```bash
corepack pnpm -C apps/web exec vitest run src/components/AccountsPanel.test.tsx
corepack pnpm -C apps/web test
corepack pnpm -C apps/web typecheck
corepack pnpm -C apps/server typecheck
grep -rn "profileId\|X-Playarr-Profile\|useProfiles\|ProfilesPanel\|switchProfile" apps/web/src packages/shared/src
```

Expected: PASS everywhere; the grep prints nothing.

**Step 5: Commit**

```bash
git add apps/web/src/components/AccountsPanel.tsx apps/web/src/components/AccountsPanel.test.tsx apps/web/src/pages/Settings.tsx apps/web/src/lib/api.ts apps/web/src/lib/queries.ts apps/web/src/lib/prefs.ts apps/web/src/lib/prefs.test.ts apps/web/src/player/playTracker.ts packages/shared/src/index.ts apps/web/src/components/SettingsControls.tsx apps/web/src/components/MixesPanel.tsx apps/web/src/components/RequestsPanel.tsx apps/web/src/components/UpdatesPanel.tsx apps/web/src/components/AnalysisPanel.tsx apps/web/src/components/AnalysisPanel.test.tsx apps/web/src/components/TrackMetadataDialog.tsx apps/web/src/components/TrackMetadataDialog.test.tsx
git commit -m "$(cat <<'EOF'
Web: Settings → Accounts replaces Profiles

Admins add accounts (with a setup code and link), change their rights
and library, reset and remove them, and sign out their devices; everyone
renames themselves and signs out their own devices. The profile header
and a play report's profile are gone.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 22: Web: whose playlist it is

**Files:**
- Modify: `apps/web/src/pages/Playlist.tsx` (imports line 2; header lines 66-114; menu lines 143-157; rows lines 165-178; recommendations line 180; `PlaylistRow` lines 215-295)
- Modify: `apps/web/src/pages/Playlists.tsx` (line 61)
- Modify: `apps/web/src/components/AddToPlaylistDialog.tsx` (line 80)
- Modify: `apps/web/src/lib/api.ts` (`updatePlaylist`, line 172), `apps/web/src/lib/queries.ts` (`update` mutation, line 296)
- Test: `apps/web/src/pages/Playlist.test.tsx` (create)

Another account's shared playlist plays like any other but offers no way to change it; the owner can share or stop sharing from the playlist's menu; "Add to playlist" lists only your own.

**Step 1: Write the failing test**

```tsx
// apps/web/src/pages/Playlist.test.tsx
import type { PlaylistCoverInfo, PlaylistDetail } from '@playarr/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { queryClient } from '../lib/queryClient';
import { PlaylistPage } from './Playlist';

// happy-dom's Animation.cancel() throws where browsers reject a promise; make motion use JS animations.
Reflect.deleteProperty(Element.prototype, 'animate');

const COVER: PlaylistCoverInfo = { url: '/art/playlist/5?v=1', layout: 'ridges', variant: 0, frozen: true, stale: false, energy: 0.5, styles: [], analyzed: 1, total: 1, pending: false };
const SHARED: PlaylistDetail = {
  id: 5,
  name: 'Road trip',
  description: '',
  trackCount: 1,
  duration: 0,
  cover: COVER,
  updatedAt: '2026-11-03T10:00:00Z',
  owner: 'Nicola',
  shared: true,
  mine: false,
  items: [{ itemId: 1, recordingId: 'local:00000000000000cc', title: 'Sneaky Snitch', artistName: 'Kevin MacLeod', albumTitle: 'Royalty Free', addedAt: '2026-11-03T10:00:00Z' }],
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  queryClient.clear();
});

function view(playlist: PlaylistDetail) {
  vi.spyOn(api, 'playlist').mockResolvedValue(playlist);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json([])));
  const router = createMemoryRouter([{ path: '/playlists/:id', element: <PlaylistPage /> }], { initialEntries: ['/playlists/5'] });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('PlaylistPage', () => {
  it('shows another account’s shared playlist without ways to change it', async () => {
    view(SHARED);
    expect(await screen.findByText('Shared by Nicola')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Drag to reorder/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Playlist actions' }));
    expect(screen.queryByRole('menuitem', { name: 'Rename' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Delete playlist' })).toBeNull();
  });

  it('lets the owner share it with everyone on the server', async () => {
    const update = vi.spyOn(api, 'updatePlaylist').mockResolvedValue({ ...SHARED, mine: true, shared: true });
    view({ ...SHARED, mine: true, shared: false });
    expect(await screen.findByRole('button', { name: 'Drag to reorder Sneaky Snitch' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Playlist actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Share with everyone' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(5, { shared: true }));
  });
});
```

**Step 2: Run it to see it fail**

```bash
corepack pnpm -C apps/web exec vitest run src/pages/Playlist.test.tsx
```

Expected: FAIL: no "Shared by Nicola", drag handles shown, no "Share with everyone".

**Step 3: Implement**

`apps/web/src/lib/api.ts` line 172: `updatePlaylist: (id: number, patch: { name?: string; description?: string; shared?: boolean }) =>`. `apps/web/src/lib/queries.ts` line 296: `mutationFn: ({ id, ...patch }: { id: number; name?: string; description?: string; shared?: boolean }) => api.updatePlaylist(id, patch),`.

`apps/web/src/pages/Playlist.tsx`:

- Line 2 adds `Lock` and `Users` to the lucide import.
- After `const unavailable = items.length - playable.length;` add:

```tsx
  // Another account's shared playlist plays here; only its owner changes it.
  const mine = playlist.mine;
```

- The cover button: `onClick={() => mine && items.length > 0 && setPickingCover(true)}`, `disabled={!mine || !items.length}`, and its "New cover" chip renders under `{mine && items.length > 0 && (`.
- The title: `className={cn('mt-2 font-display text-[2.5rem] leading-[1.02] tracking-tight text-balance text-paper md:text-6xl lg:text-7xl', mine && 'cursor-text')}`, `onClick={() => mine && setEditing(true)}`, `title={mine ? 'Click to rename' : undefined}`; the description's `onClick={() => mine && setEditing(true)}`.
- After the songs-and-duration line (the `<div className="mt-4 font-mono text-[12px] text-muted">…</div>`) add:

```tsx
          {(!mine || playlist.shared) && (
            <div className="mt-1 font-mono text-[12px] text-muted">{mine ? 'Shared with everyone on this server' : `Shared by ${playlist.owner}`}</div>
          )}
```

- `{items.length > 0 && <CoverNote … />}` becomes `{mine && items.length > 0 && <CoverNote … />}`.
- The menu's `items` become:

```tsx
          items={[
            ...(mine ? [{ label: 'Rename', icon: Pencil, onSelect: () => setEditing(true) }] : []),
            ...(playable.length
              ? [
                  { label: 'Play next', icon: ListPlus, onSelect: () => queueTracks(playable, 'next') },
                  { label: 'Add to queue', icon: ListEnd, onSelect: () => queueTracks(playable, 'end') },
                ]
              : []),
            ...(mine && items.length ? [{ label: 'New cover…', icon: Palette, onSelect: () => setPickingCover(true) }] : []),
            ...(mine
              ? [
                  playlist.shared
                    ? { label: 'Stop sharing', icon: Lock, onSelect: () => mutations.update.mutate({ id, shared: false }) }
                    : { label: 'Share with everyone', icon: Users, onSelect: () => mutations.update.mutate({ id, shared: true }) },
                  { label: 'Delete playlist', icon: Trash2, onSelect: () => setConfirmDelete(true) },
                ]
              : []),
          ]}
```

- Each `<PlaylistRow … />` gets `editable={mine}`.
- `<PlaylistRecommendations playlistId={id} enabled={items.length > 0} />` becomes `{mine && <PlaylistRecommendations playlistId={id} enabled={items.length > 0} />}` (its Add buttons change the playlist).
- `PlaylistRow` takes `editable: boolean` (add `editable,` to the destructured props and `/** The viewer owns the playlist: drag to reorder, remove songs. */ editable: boolean;` to the props type). Its drag handle renders only when editable, keeping the grid's first column otherwise:

```tsx
      {editable ? (
        <span
          role="button"
          aria-label={`Drag to reorder ${item.title}`}
          onPointerDown={(e) => controls.start(e)}
          onClick={(e) => e.stopPropagation()}
          className="grid h-9 cursor-grab touch-none place-items-center text-muted active:cursor-grabbing md:opacity-0 md:group-hover:opacity-100"
        >
          <GripVertical className="size-4" />
        </span>
      ) : (
        <span />
      )}
```

  and its menu's last item becomes `...(editable ? [{ label: 'Remove from playlist', icon: X, onSelect: onRemove }] : []),`.

`apps/web/src/pages/Playlists.tsx` line 61: `<div className="truncate font-mono text-[12px] text-muted">{plural(p.trackCount, 'song')}{p.mine ? '' : ` · ${p.owner}`}</div>`.

`apps/web/src/components/AddToPlaylistDialog.tsx` line 80: `playlists?.map((p) => (` becomes `playlists?.filter((p) => p.mine).map((p) => (`.

**Step 4: Run the tests again**

```bash
corepack pnpm -C apps/web exec vitest run src/pages/Playlist.test.tsx
corepack pnpm -C apps/web test
corepack pnpm -C apps/web typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add apps/web/src/pages/Playlist.tsx apps/web/src/pages/Playlist.test.tsx apps/web/src/pages/Playlists.tsx apps/web/src/components/AddToPlaylistDialog.tsx apps/web/src/lib/api.ts apps/web/src/lib/queries.ts
git commit -m "$(cat <<'EOF'
Web: share a playlist with everyone; others' shared playlists are read-only

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 22b: Owner recovery from the server host (`reset-password`)

Added by the coordinator after the plan was written (conventions, "Owner recovery"). A sole admin who forgets their password has no other way back in. Recovery runs on the server host only, so nobody on the network can use it.

**Files:**
- Create: `apps/server/src/cli.ts`, `apps/server/src/cli.test.ts`
- Modify: `apps/server/tsup.config.ts` (add `cli: 'src/cli.ts'` to `entry`), `apps/server/package.json` (script `"reset-password": "tsx --env-file-if-exists=../../.env --disable-warning=ExperimentalWarning src/cli.ts reset-password"`)

**Behaviour:** `node dist/cli.js reset-password <username>` opens the database in `DATA_DIR` the same way `index.ts` does (reuse its `openDatabase`/migrations helper; don't start the HTTP server), finds the account by username (exit 1 with "No account named <username>" otherwise), ends every session of that account, creates a setup code with Task 4's `SetupCodes` (origin from `PUBLIC_URL` when set, else `http://localhost:<PORT>`), and prints:

```
Signed <name> out everywhere. Set a new password within 7 days:
  code: ABCD2345
  link: https://.../redeem?code=ABCD2345
```

Export a `resetPassword(db, username, origin): { name, code, link }` function and test it TDD-style: the failing test creates an account with a password and a session (Task 3/4 helpers), calls `resetPassword`, and expects the session gone, a valid unused setup code returned, and redeeming it (Task 4's `redeem`) to set a new password; plus the unknown-username error. The `main()` wrapper (argv parsing, printing, exit codes) stays untested and tiny.

**Steps:** failing test → run (`corepack pnpm -C apps/server exec vitest run src/cli.test.ts`, expect "resetPassword is not a function") → implement → run (PASS) → `corepack pnpm -C apps/server build` and check `dist/cli.js` exists → commit `git add apps/server/src/cli.ts apps/server/src/cli.test.ts apps/server/tsup.config.ts apps/server/package.json` with "Accounts: reset a forgotten password from the server host with reset-password" and the Co-Authored-By line. Task 23 documents it in the README (Running it → Docker: `docker exec playarr node dist/cli.js reset-password <username>`).

### Task 23: Docs: README, PLAN.md, .env.example

**Files:**
- Modify: `README.md` (lines 59, 60, 129-134)
- Modify: `PLAN.md` (§5 lines 114-137, §17 line 361 and 363, open question 3 line 233, decisions log: append a row)
- Modify: `.env.example` (lines 54-57, append)

No tests: documentation only.

**Step 1: README.md**

Line 59: replace `Listening history (per profile, kept on the server)` with `Listening history (per account, kept on the server)`, and its last sentence `Each person in the household can have a profile, picked per device; favorites and playlists stay shared.` with `Each person signs in with their own account; favorites and playlists are theirs, and a playlist can be shared with everyone on the server.`

Line 60: replace `Profiles and Mixes are covered above.` with `Accounts: who signs in (admins add accounts and hand out a one-time setup code; nobody chooses another person's password), what each may hear (every source or only some) and whether they may request albums, and the devices each is signed in on. Mixes is covered above.`, and `Sources and Requests apply to everyone and, until there's a login, can only be changed from the home network.` with `Sources, Requests, Analysis and Updates apply to everyone and are changed by admins (before the owner has set a password, from the home network).`

Replace lines 129-134:

```
Playarr has no login yet, so don't expose it to the internet without something in front of it: anyone who can reach it can stream the library and request albums through Lidarr. Planned next:

- Login and HTTPS
- ffmpeg transcoding for formats browsers can't play, and for mobile data (even volume's levelled streams are uncompressed WAV for now)
- ReplayGain tags (levelling uses Playarr's own loudness measurement for now) and EQ
- Per-profile favorites and playlists
```

with:

```
Playarr asks everyone to sign in once its owner has set a password (open Playarr on the home network: Settings → Accounts → Set up the owner's account). Reach it from outside over HTTPS through a reverse proxy; the session cookie is marked Secure when the proxy says the visit is HTTPS. Planned next:

- The native iOS app (docs/plans/2026-11-03-ios-app-design.md)
- ffmpeg transcoding for formats browsers can't play, and for mobile data (even volume's levelled streams are uncompressed WAV for now)
- ReplayGain tags (levelling uses Playarr's own loudness measurement for now) and EQ
```

**Step 2: PLAN.md**

In §5, replace the line `CRUD /api/profiles` with:

```
GET  /api/server                         → server id, name, version, lowest app version, setup mode (open)
POST /api/auth/setup|sign-in|redeem|switch|sign-out; GET /api/auth/me
CRUD /api/accounts (+ :id/reset, :id/sessions)  → admins; each account its own name and sessions
```

and the last line of the block `     /api/settings/{sources,folders,matching,requests,mixes,listenbrainz,updates}  (changes: home network only)` with `     /api/settings/{sources,folders,matching,requests,mixes,listenbrainz,updates}  (changes: admins; ListenBrainz and history: each account)`.

Replace the **Security** paragraph's last sentence `Playarr's own login is still to come (Phase 5).` and the sentence before it about local-only actions with: `Once the owner has set a password, every /api, /stream, /art and /transitions request needs a session (Bearer token from the app, HttpOnly cookie from the web; tokens stored as SHA-256), except finding the server and signing in; sign-ins are rate-limited per client address (the visitor's, behind a proxy trusted with TRUST_PROXY). Admins change settings; before setup, local-only actions need a home address, no proxy in between, and the server addressed by IP or a local name (no DNS rebinding). Each account hears every source or a chosen list, enforced in the catalog, search, streams, art, transitions, mixes, radio and stats through a per-account view of the catalog.`

In §17, replace the **Profiles** bullet (line 361) with:

```
- **Accounts** (Settings → Accounts; `apps/server/src/accounts/`): each listener signs in; history, mixes, stats, the ListenBrainz account, favorites and playlists follow the account (playlists private unless shared with the server). Accounts are admins or members, may request or not, and hear every source or a chosen list. The web keeps a token per signed-in account on the device and switches between them from Home ("Not X? Listen as Y").
```

and in the **ListenBrainz** bullet `the profile's ListenBrainz account` becomes `the account's ListenBrainz account`.

Open question 3 (line 233) gets a second resolution appended: ` **Superseded 2026-11-03:** server accounts with passwords and device sessions replace profiles (iOS app, phase 1); favorites and playlists are per account.`

Append to the decisions log table:

```
| 2026-11-03 | **Accounts replace profiles** (`docs/plans/2026-11-03-ios-phase1-accounts.md`, for the iOS app): same ids, so history, mixes and ListenBrainz stay put; scrypt passwords, 256-bit session tokens stored as SHA-256 (Bearer for the app, an HttpOnly cookie the web switches between accounts), one-time setup codes so admins never choose passwords, in-memory sign-in rate limits. Setup mode (no password yet) keeps every install working as before until the owner claims it from the home network. Admins replace the home-network rule. Library access per account is a view of the catalog built from only its sources, cached per source set. Favorites per account; playlists private unless shared. `GET /api/server` (stable UUID) and Bonjour `_playarr._tcp` through `bonjour-service`. |
```

**Step 3: .env.example**

Replace lines 54-57 (the `LOCAL_HOSTNAMES` comment block) with:

```
# Before the owner's account has a password, settings can only be changed from the home network, by IP or a local
# name (nas, *.local, *.lan); afterwards admins change them from anywhere. Other host names you open Playarr by
# on the home network (comma-separated), e.g. music.example.com. Requests through a reverse proxy always count as from outside.
LOCAL_HOSTNAMES=
```

(`TRUST_PROXY` and `PUBLIC_URL` were added after it by Task 9b) and append:

```

# What apps call this server (default: the machine's name).
# SERVER_NAME=Living room
# Advertise the server on the home network (Bonjour, _playarr._tcp) so the iOS app finds it: on | off.
# Works for native installs and Docker with host networking.
# BONJOUR=on
```

**Step 4: Check**

```bash
grep -n "profile" README.md PLAN.md .env.example | grep -iv "quality profile\|metadata profile\|qualityprofile\|metadataprofile\|public profile\|profiles new artists\|QUALITY_PROFILE\|METADATA_PROFILE\|style profile"
```

Expected: only historical decisions-log rows mention profiles.

**Step 5: Commit**

```bash
git add README.md PLAN.md .env.example
git commit -m "$(cat <<'EOF'
Docs: accounts, sign-in, GET /api/server and Bonjour

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 24: Manual: claim the server and seed the App Review account

No code and no commit: the owner does this on the real server once tasks 1-23 are deployed (`pnpm deploy:nas`, or the updater). Claude can't reach the NAS from its shell (macOS Local Network blocks it): hand these steps to the user and wait for them to confirm.

**Step 1: Claim the server.** On the home network, open Playarr by its IP or local name (not through the reverse proxy). Settings → Accounts shows "Set up this server" → **Set up the owner's account**: your name, a username, a password (8+ characters). You land in Settings → Accounts signed in as the owner (an admin); your history, mixes, favorites and ListenBrainz link are still yours.

**Step 2: Check the lock.** In a private window, open Playarr: it goes to /sign-in. `curl -s -o /dev/null -w '%{http_code}\n' http://<server>:4000/api/albums` answers 401; `curl -s http://<server>:4000/api/server` answers the id, name, version and `"setup":false`.

**Step 3: Make sure the Creative Commons folder is a source of its own.** Settings → Sources → Add source → a folder holding only Creative Commons music (e.g. albums from the Free Music Archive with CC BY licences), named "Creative Commons". Wait for its sync and matching to finish.

**Step 4: Create the reviewer.** Settings → Accounts → **Add account**: Name `App Review`, Username `reviewer`, Role **Member**, **Can request albums** off, Library **Only these sources** → tick only **Creative Commons**. Add. Copy the setup link.

**Step 5: Choose the reviewer's password.** Open the setup link in a private window and choose a strong password. Store the username and password in your password manager under "Playarr App Review": phase 11 puts them in App Store Connect's review notes.

**Step 6: Verify what the reviewer sees.** Still in that private window (signed in as `reviewer`):
- Home and Library show only the Creative Commons albums; Search finds nothing else.
- No Request buttons anywhere; Settings shows Accounts (their own name and devices) but no admin controls.
- Open an album URL from your own account (e.g. `/albums/<id of a non-CC album>`): "not found".
- `curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer <token>" http://<server>:4000/stream/<fileId of a non-CC song>` answers 404 (get a token with `curl -s -X POST -H 'Content-Type: application/json' -H 'X-Playarr: 1' -d '{"username":"reviewer","password":"…","device":"curl","platform":"test"}' http://<server>:4000/api/auth/sign-in`). Sign that session out afterwards from Settings → Accounts → reviewer → Devices.

**Step 7: Home devices.** Everyone else in the household gets an account the same way (Add account, their name, Member, every source, requests as you like), and opens their setup link on their own phone. On a shared device, Home → "Add account" signs in a second person; "Not X? Listen as Y" switches without a password.

---

## Contract note for the conventions file

`POST /api/auth/switch` must work without a session (it authenticates by the token in its body), so this plan adds it to the unauthenticated exceptions. The conventions file lists only `GET /api/server`, `/api/auth/sign-in|redeem|setup` and `GET /api/health`; it should add `/api/auth/switch` in the same commit that lands task 5, or with this plan.
