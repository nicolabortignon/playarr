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
    expect(accounts.list()).toEqual([{ id: 1, username: 'home', name: 'Home', role: 'admin', canRequest: true, requestAccess: 'on', sources: null, hasPassword: false, locked: [] }]);
    expect(accounts.owner().id).toBe(1);
    expect(accounts.ids()).toEqual([1]);
    expect(accounts.setupMode()).toBe(true);
  });

  it('creates accounts with their library access, and checks usernames, names and sources', () => {
    const { accounts, store } = setup();
    const cc = store.addSource('folder', 'Creative Commons');
    const sam = accounts.create({ ...member, username: ' Sam ', name: '  Sam   Smith ', sources: [cc] });
    expect(sam).toEqual({ id: 2, username: 'sam', name: 'Sam Smith', role: 'member', canRequest: false, requestAccess: 'off', sources: [cc], hasPassword: false, locked: [] });
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

  it('locks the device settings an admin picks, never for an admin', () => {
    const { accounts } = setup();
    const sam = accounts.create({ ...member, username: 'sam', locked: ['appearance', 'playback', 'playback'] });
    expect(sam.locked).toEqual(['playback', 'appearance']);
    expect(accounts.update(sam.id, { name: 'Sam' }).locked).toEqual(['playback', 'appearance']);
    expect(accounts.update(sam.id, { locked: ['appearance'] }).locked).toEqual(['appearance']);
    // Made an admin, nothing is locked; made a member again, the ticks are back.
    expect(accounts.update(sam.id, { role: 'admin' }).locked).toEqual([]);
    expect(accounts.update(sam.id, { role: 'member' }).locked).toEqual(['appearance']);
    expect(accounts.update(sam.id, { locked: [] }).locked).toEqual([]);
  });

  it('makes a member ask an admin first, never an admin, and keeps that for apps that only know canRequest', () => {
    const { accounts } = setup();
    const sam = accounts.create({ ...member, canRequest: true, requestAccess: 'ask' });
    // May ask, so apps that predate requestAccess still offer Request.
    expect(sam).toMatchObject({ canRequest: true, requestAccess: 'ask' });
    // Made an admin, their requests go straight to Lidarr, and stay so made a member again: nothing they can't see changes.
    expect(accounts.update(sam.id, { role: 'admin' })).toMatchObject({ canRequest: true, requestAccess: 'on' });
    expect(accounts.update(sam.id, { role: 'member' })).toMatchObject({ canRequest: true, requestAccess: 'on' });
    expect(accounts.create({ ...member, username: 'ada', role: 'admin', canRequest: true, requestAccess: 'ask' })).toMatchObject({ requestAccess: 'on' });
    expect(accounts.update(sam.id, { requestAccess: 'ask' })).toMatchObject({ canRequest: true, requestAccess: 'ask' });
    // An app that only knows canRequest: still allowed keeps asking first, not allowed is off, allowed again is on.
    expect(accounts.update(sam.id, { canRequest: true, name: 'Sam S.' })).toMatchObject({ requestAccess: 'ask' });
    expect(accounts.update(sam.id, { canRequest: false })).toMatchObject({ canRequest: false, requestAccess: 'off' });
    expect(accounts.update(sam.id, { canRequest: true })).toMatchObject({ canRequest: true, requestAccess: 'on' });
    // requestAccess decides when both are sent.
    expect(accounts.update(sam.id, { canRequest: true, requestAccess: 'off' })).toMatchObject({ canRequest: false, requestAccess: 'off' });
    expect(accounts.create({ ...member, username: 'zoe', canRequest: true })).toMatchObject({ requestAccess: 'on' });
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
    // The only password can't be taken away: setup mode lets every request in as the owner.
    expect(() => accounts.clearPassword(1)).toThrow('only account with a password');
    expect(accounts.setupMode()).toBe(false);
    const sam = accounts.create({ username: 'sam', name: 'Sam', role: 'member', canRequest: false, sources: null });
    await accounts.setPassword(sam.id, 'another horse');
    accounts.clearPassword(1);
    expect(accounts.setupMode()).toBe(false);
    expect(await accounts.verify('home', 'correct horse')).toBeNull();
    expect(() => accounts.remove(sam.id)).toThrow('only account with a password');
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
