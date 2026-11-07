import type { Account, AccountRole, DeviceSetting, ListedAccount, RequestAccess } from '@playarr/shared';
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
  /** How its requests go; when given it decides, and `canRequest` follows from it (true for `on` and `ask`). */
  requestAccess?: RequestAccess;
  /** null: every source. */
  sources: number[] | null;
  /** The device settings this account may not change (ignored for admins). */
  locked?: DeviceSetting[];
}

interface Row {
  id: number;
  username: string | null;
  name: string;
  role: AccountRole;
  can_request: number;
  /** With can_request: its requests wait for an admin's approval (ignored for admins). */
  ask_first: number;
  all_sources: number;
  password_hash: string | null;
  locked: string;
}

const COLUMNS = 'id, username, name, role, can_request, ask_first, all_sources, password_hash, locked';
const DEVICE_SETTINGS: readonly DeviceSetting[] = ['playback', 'appearance'];
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

  /** Every account with how many songs it has played (not skipped, as Your listening counts them) and playlists it made. */
  listed(): ListedAccount[] {
    const counts = new Map(
      (
        this.db
          .prepare(
            `SELECT a.id,
                    (SELECT COUNT(*) FROM plays p WHERE p.account_id = a.id AND p.skipped = 0) AS plays,
                    (SELECT COUNT(*) FROM playlists l WHERE l.account_id = a.id) AS playlists
               FROM accounts a`,
          )
          .all() as { id: number; plays: number; playlists: number }[]
      ).map((r) => [r.id, r]),
    );
    return this.list().map((a) => ({ ...a, plays: counts.get(a.id)?.plays ?? 0, playlists: counts.get(a.id)?.playlists ?? 0 }));
  }

  ids(): number[] {
    return (this.db.prepare('SELECT id FROM accounts ORDER BY id').all() as { id: number }[]).map((r) => r.id);
  }

  get(id: number): Account | undefined {
    const row = this.row(id);
    return row && this.toAccount(row);
  }

  /** The account with this username (any case), if there is one. */
  byUsername(username: string): Account | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM accounts WHERE username = ?`).get(username.trim().toLowerCase()) as unknown as Row | undefined;
    return row && this.toAccount(row);
  }

  /** The owner: the first admin (account 1, the old "Home" profile, on every install that had profiles). */
  owner(): Account {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM accounts ORDER BY role = 'admin' DESC, id LIMIT 1`).get() as unknown as Row | undefined;
    if (!row) throw new AccountError('There are no accounts', 500);
    return this.toAccount(row);
  }

  /**
   * Refuses to take away the last password: with none, the server is back in setup mode, where every request is the
   * owner's, from anywhere.
   */
  private keepAPassword(id: number) {
    const others = this.db.prepare('SELECT 1 FROM accounts WHERE password_hash IS NOT NULL AND id != ? LIMIT 1').get(id);
    const own = this.db.prepare('SELECT 1 FROM accounts WHERE password_hash IS NOT NULL AND id = ?').get(id);
    if (own && !others) throw new AccountError('This is the only account with a password: give another account one first', 409);
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
    const access = forRole(input.role, input.requestAccess ?? (input.canRequest ? 'on' : 'off'));
    return this.transaction(() => {
      const { lastInsertRowid } = this.db
        .prepare('INSERT INTO accounts (username, name, role, can_request, ask_first, all_sources, locked, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(username, name, input.role, ...accessColumns(access), sources === null ? 1 : 0, lockedColumn(input.locked), new Date().toISOString());
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
    const access = forRole(role, patch.requestAccess ?? accessAfter(storedAccess(row), patch.canRequest));
    const sources = patch.sources === undefined ? undefined : this.checkSources(patch.sources);
    const locked = patch.locked === undefined ? row.locked : lockedColumn(patch.locked);
    return this.transaction(() => {
      this.db
        .prepare('UPDATE accounts SET username = ?, name = ?, role = ?, can_request = ?, ask_first = ?, locked = ? WHERE id = ?')
        .run(username, name, role, ...accessColumns(access), locked, id);
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
    this.keepAPassword(id);
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
    this.keepAPassword(id);
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
    const access = forRole(row.role, storedAccess(row));
    return {
      id: row.id,
      username: row.username ?? `account-${row.id}`,
      name: row.name,
      role: row.role,
      canRequest: access !== 'off',
      requestAccess: access,
      sources,
      hasPassword: row.password_hash !== null,
      // An admin may change everything, whatever was ticked while they were a member.
      locked: row.role === 'admin' ? [] : DEVICE_SETTINGS.filter((setting) => row.locked.split(',').includes(setting)),
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

/** How an account's requests go, as stored. */
function storedAccess(row: Pick<Row, 'can_request' | 'ask_first'>): RequestAccess {
  if (!row.can_request) return 'off';
  return row.ask_first ? 'ask' : 'on';
}

/**
 * Asking first is a member's: an admin's requests go straight to Lidarr (they'd approve them anyway), and one made an
 * admin stops asking first for good, rather than again, unseen, once made a member.
 */
function forRole(role: AccountRole, access: RequestAccess): RequestAccess {
  return role === 'admin' && access === 'ask' ? 'on' : access;
}

/**
 * The access after a change that gives only `canRequest` (apps that predate requestAccess): false is `off`; true
 * keeps `ask` as it is, since such an app shows `ask` as allowed, and turns `off` into `on`.
 */
function accessAfter(current: RequestAccess, canRequest: boolean | undefined): RequestAccess {
  if (canRequest === undefined) return current;
  if (!canRequest) return 'off';
  return current === 'off' ? 'on' : current;
}

/** can_request and ask_first for an access. */
function accessColumns(access: RequestAccess): [canRequest: number, askFirst: number] {
  return [access === 'off' ? 0 : 1, access === 'ask' ? 1 : 0];
}

/** The locked settings as stored: known names, each once, in a fixed order, comma-separated. */
function lockedColumn(locked: readonly DeviceSetting[] | undefined): string {
  return DEVICE_SETTINGS.filter((setting) => locked?.includes(setting)).join(',');
}
