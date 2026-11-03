import type { Profile } from '@playarr/shared';
import type { FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';

/** The header a device names its listener with (Settings → Profiles). */
export const PROFILE_HEADER = 'x-playarr-profile';

export class ProfileError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** Who listens: each profile has its own history, mixes, stats and ListenBrainz account. */
export class Profiles {
  constructor(private readonly db: DatabaseSync) {}

  list(): Profile[] {
    return this.db.prepare('SELECT id, name FROM accounts ORDER BY id').all() as unknown as Profile[];
  }

  ids(): number[] {
    return this.list().map((p) => p.id);
  }

  /** The profile a request is for: the one its device picked, else the first. */
  of(req: Pick<FastifyRequest, 'headers'>): number {
    const asked = Number(req.headers[PROFILE_HEADER]);
    const ids = this.ids();
    return Number.isInteger(asked) && ids.includes(asked) ? asked : (ids[0] ?? 1);
  }

  create(name: string): Profile {
    const clean = this.name(name);
    const { lastInsertRowid } = this.db.prepare('INSERT INTO accounts (name, created_at) VALUES (?, ?)').run(clean, new Date().toISOString());
    return { id: Number(lastInsertRowid), name: clean };
  }

  rename(id: number, name: string): Profile {
    const clean = this.name(name, id);
    if (!this.db.prepare('UPDATE accounts SET name = ? WHERE id = ?').run(clean, id).changes) throw new ProfileError('No such profile', 404);
    return { id, name: clean };
  }

  /** Remove a profile with its history and mixes; there's always one left. */
  remove(id: number) {
    const ids = this.ids();
    if (!ids.includes(id)) throw new ProfileError('No such profile', 404);
    if (ids.length === 1) throw new ProfileError('There has to be one profile', 409);
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM plays WHERE account_id = ?').run(id);
      this.db.prepare('DELETE FROM mixes WHERE account_id = ?').run(id);
      this.db.prepare(`DELETE FROM app_settings WHERE key = ?`).run(`listenbrainz:${id}`);
      this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private name(name: string, except?: number): string {
    const clean = name.trim().replace(/\s+/g, ' ').slice(0, 40);
    if (!clean) throw new ProfileError('A profile needs a name');
    if (this.list().some((p) => p.id !== except && p.name.toLowerCase() === clean.toLowerCase())) throw new ProfileError('There’s already a profile with that name', 409);
    return clean;
  }
}
