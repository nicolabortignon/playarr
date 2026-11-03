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
