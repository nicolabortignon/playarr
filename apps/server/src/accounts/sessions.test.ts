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
    expect(sessions.list(1, id).find((s) => s.id === id)).toMatchObject({ device: 'iPhone', platform: 'ios', current: true });    // Device and platform are optional: the web's sign-in may send neither.
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
