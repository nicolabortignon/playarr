import { createHash, createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { freshDb } from '../catalog/testFixtures.ts';
import { Accounts } from './accounts.ts';
import { hashToken, PROOF_ANSWER, PROOF_ID, SESSION_IDLE_MS, SESSION_MAX_AGE_MS, Sessions } from './sessions.ts';
import { normalizeCode, SetupCodes } from './setupCodes.ts';

const T0 = Date.parse('2026-11-03T10:00:00Z');

// Every HMAC made, counted: the home-address proof must do the same work whether or not it knows the session.
const hmacs = vi.hoisted(() => ({ made: 0 }));
vi.mock('node:crypto', async (original) => {
  const crypto = await original<typeof import('node:crypto')>();
  return { ...crypto, createHmac: (...args: Parameters<typeof crypto.createHmac>) => (hmacs.made++, crypto.createHmac(...args)) };
});

/** What the app sends for a session: the id it names it by, as the iOS app's HomeAddress works it out. */
function idFor(token: string, nonce: string) {
  const key = createHash('sha256').update(token).digest();
  return createHmac('sha256', key).update(PROOF_ID + nonce).digest('base64url');
}

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
    expect(sessions.list(1, id).find((s) => s.id === id)).toMatchObject({ device: 'iPhone', platform: 'ios', current: true });    // Device and platform are optional: the web's sign-in may send neither.
    const blank = sessions.create(1, ' ', '');
    expect(sessions.list(1).find((s) => s.id === blank.id)).toMatchObject({ device: 'Unknown device', platform: 'web' });
  });

  it('ends a session unused for 90 days, and any after a year, however much it was used', () => {
    const db = freshDb();
    let now = T0;
    const sessions = new Sessions(db, () => now);
    const unused = sessions.create(1, 'Old iPad', 'ios');
    const daily = sessions.create(1, 'iPhone', 'ios');
    // The phone is used every day; the iPad never again.
    for (let day = 1; day < 90; day++) {
      now = T0 + day * 86_400_000;
      expect(sessions.resolve(daily.token)).toEqual({ id: daily.id, accountId: 1 });
    }
    now = T0 + SESSION_IDLE_MS;
    expect(sessions.resolve(unused.token)).toBeUndefined();
    expect(sessions.resolve(daily.token)).toEqual({ id: daily.id, accountId: 1 });
    // Gone from the list of devices too, and from the database.
    expect(sessions.list(1).map((s) => s.device)).toEqual(['iPhone']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 1 });
    // Used every day, the phone still signs in again a year after it first did.
    for (let day = 90; day < 365; day += 30) {
      now = T0 + day * 86_400_000;
      expect(sessions.resolve(daily.token)).toBeDefined();
    }
    now = T0 + SESSION_MAX_AGE_MS;
    expect(sessions.resolve(daily.token)).toBeUndefined();
  });

  it('forgets ended sessions as a device signs in, without asking for them', () => {
    const db = freshDb();
    let now = T0;
    const sessions = new Sessions(db, () => now);
    sessions.create(1, 'Old iPad', 'ios');
    now = T0 + SESSION_IDLE_MS + 1;
    sessions.create(1, 'New iPad', 'ios');
    expect((db.prepare('SELECT device FROM sessions').all() as { device: string }[]).map((r) => r.device)).toEqual(['New iPad']);
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

  it('proves it holds a session to the app that names it, keyed by the hash it stores', () => {
    const sessions = new Sessions(freshDb());
    const { token } = sessions.create(1, 'iPhone', 'ios');
    const nonce = randomBytes(32).toString('base64url');
    const key = createHash('sha256').update(token).digest();
    expect(sessions.proof(idFor(token, nonce), nonce, true)).toBe(createHmac('sha256', key).update(PROOF_ANSWER + nonce).digest('base64url'));
    // A new nonce, a new answer: one overheard can't be replayed.
    const again = randomBytes(32).toString('base64url');
    expect(sessions.proof(idFor(token, again), again, true)).not.toBe(sessions.proof(idFor(token, nonce), nonce, true));
  });

  it('does the same work for a session it holds as for one it doesn’t, or a question it won’t answer', () => {
    const sessions = new Sessions(freshDb());
    const tokens = Array.from({ length: 5 }, () => sessions.create(1, 'iPhone', 'ios').token);
    const nonce = randomBytes(32).toString('base64url');
    const work = (id: string, fromHome: boolean) => {
      hmacs.made = 0;
      sessions.proof(id, nonce, fromHome);
      return hmacs.made;
    };
    // Each session's id is worked out (none stops the search early), then the answer.
    expect(work(idFor(tokens[0]!, nonce), true)).toBe(6);
    expect(work(randomBytes(32).toString('base64url'), true)).toBe(6);
    expect(work(idFor(tokens[0]!, nonce), false)).toBe(6);
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
