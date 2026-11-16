import type { Track } from '@playarr/shared';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CatalogStore } from '../catalog/store.ts';
import { freshDb } from '../catalog/testFixtures.ts';
import { History } from '../mixes/history.ts';
import { isScrobble, LastFm, LastFmError, signature } from './scrobbler.ts';

const KEY = 'a'.repeat(32);
const SECRET = 'b'.repeat(32);
const MBID = '0f3b1c2d-1111-4222-8333-444455556666';
const song = (id: number, duration = 200): Track =>
  ({ id, recordingId: id === 1 ? MBID : `track:${id}`, artistName: 'Artist', title: `Song ${id}`, albumTitle: 'Album', duration, trackNumber: id, artistId: 1, albumId: 1 }) as Track;

/** Last.fm's answer to a call, by method; `null` for a call that doesn't get through. */
type Answer = Response | null;

function setup(answers: Partial<Record<string, Answer[]>> = {}) {
  const db = freshDb();
  const store = new CatalogStore(db);
  const tracks = [song(1), song(2), song(3, 600), song(4, 25)];
  const library = {
    track: async (id: number) => tracks.find((t) => t.id === id),
    trackByRecording: async (r: string) => tracks.find((t) => t.recordingId === r),
    tracksByRecordings: async (ids: string[]) => tracks.filter((t) => ids.includes(t.recordingId)),
  };
  const history = new History(db, library);
  const calls: Record<string, string>[] = [];
  const queues = Object.fromEntries(Object.entries(answers).map(([method, list]) => [method, [...(list ?? [])]]));
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const params = Object.fromEntries(new URLSearchParams(String(init!.body)));
    calls.push(params);
    const next = queues[params.method!]?.shift();
    if (next === null) throw new Error('offline');
    if (next) return next;
    if (params.method === 'auth.getToken') return Response.json({ token: 'tok' });
    if (params.method === 'auth.getSession') return Response.json({ session: { name: 'nicola', key: 'session-key', subscriber: 0 } });
    return Response.json({ scrobbles: { '@attr': { accepted: 1, ignored: 0 }, scrobble: [] } });
  }) as unknown as typeof globalThis.fetch;
  let now = Date.parse('2026-11-16T12:00:00Z');
  const lastfm = new LastFm(db, store, library, { log: { warn: () => {} }, fetch, now: () => now });
  const play = (trackId: number, seconds: number, at: string, skipped = false) =>
    history.record([{ trackId, recordingId: tracks[trackId - 1]!.recordingId, at, hour: 1, weekday: 1, seconds, skipped }]);
  const later = (ms: number) => (now += ms);
  const of = (method: string) => calls.filter((c) => c.method === method);
  return { lastfm, calls, of, play, store, later, at: (ms: number) => new Date(now + ms).toISOString() };
}

/** Set up and connected as account 1. */
async function connected(answers: Parameters<typeof setup>[0] = {}) {
  const s = setup(answers);
  await s.lastfm.setApp(KEY, SECRET);
  const { token } = await s.lastfm.connect();
  await s.lastfm.finish(token);
  return s;
}

const refusal = (error: number, message = 'no') => Response.json({ error, message });

describe('Last.fm', () => {
  it('signs a call as Last.fm asks: names in ASCII order, name then value, the secret, MD5; without format', () => {
    const params = { method: 'auth.getSession', api_key: 'xxxxxxxx', token: 'yyyyyyy', format: 'json' };
    expect(signature(params, 'mysecret')).toBe(createHash('md5').update('api_keyxxxxxxxxmethodauth.getSessiontokenyyyyyyymysecret').digest('hex'));
    // artist[10] comes before artist[1].
    expect(signature({ 'artist[1]': 'b', 'artist[10]': 'a' }, 's')).toBe(createHash('md5').update('artist[10]aartist[1]bs').digest('hex'));
  });

  it('counts a scrobble for a song longer than 30 seconds, heard for half its length or four minutes', () => {
    expect(isScrobble(100, 200)).toBe(true);
    expect(isScrobble(99, 200)).toBe(false);
    expect(isScrobble(240, 600)).toBe(true);
    expect(isScrobble(25, 25)).toBe(false);
  });

  it('has nothing to connect to until an admin adds the server’s API account, checked with Last.fm', async () => {
    const { lastfm, of } = setup({ 'auth.getToken': [refusal(13, 'Invalid method signature supplied')] });
    expect(lastfm.info()).toMatchObject({ available: false, connected: false });
    await expect(lastfm.connect()).rejects.toMatchObject({ status: 409 });
    await expect(lastfm.setApp(KEY, 'c'.repeat(32))).rejects.toThrow('That shared secret isn’t this API key’s');
    const info = await lastfm.setApp(KEY, SECRET);
    expect(info).toMatchObject({ available: true, apiKey: KEY });
    expect(JSON.stringify(info)).not.toContain(SECRET);
    // The check is signed with the key and secret being added.
    const check = of('auth.getToken').at(-1)!;
    expect(check.api_key).toBe(KEY);
    expect(check.api_sig).toBe(signature({ method: 'auth.getToken', api_key: KEY }, SECRET));
    // Only an admin sees the key.
    expect(lastfm.info(1, false)).not.toHaveProperty('apiKey');
  });

  it('connects in two halves: the page where the account allows Playarr, then its session once it has', async () => {
    const { lastfm, store } = setup({ 'auth.getSession': [refusal(14, 'This token has not been authorized')] });
    await lastfm.setApp(KEY, SECRET);
    const { url, token } = await lastfm.connect();
    expect(url).toBe(`https://www.last.fm/api/auth/?api_key=${KEY}&token=tok`);
    // Not allowed yet: try again after.
    await expect(lastfm.finish(token)).rejects.toMatchObject({ status: 409, message: 'Allow Playarr on Last.fm first, then come back here' });
    const info = await lastfm.finish(token);
    expect(info).toMatchObject({ connected: true, user: 'nicola', enabled: true });
    expect(JSON.stringify(info)).not.toContain('session-key');
    expect(store.appSetting('lastfm:1')).toContain('session-key');
  });

  it('sends songs heard from then on, 50 at a time, signed with the session, and earlier ones from the last two weeks when asked', async () => {
    const { lastfm, of, play, at } = await connected();
    await play(1, 150, at(-20 * 24 * 3600_000)); // three weeks ago: too old for Last.fm
    await play(2, 150, at(-3 * 24 * 3600_000)); // before connecting
    expect(lastfm.info()).toMatchObject({ earlier: 1, pending: 0 });
    await play(1, 150, at(1000));
    await play(2, 20, at(2000)); // too short a listen
    await play(3, 300, at(3000));
    await play(3, 400, at(4000), true); // skipped
    await play(4, 25, at(5000)); // too short a song
    await lastfm.kick();
    const sent = of('track.scrobble');
    expect(sent).toHaveLength(1);
    const call = sent[0]!;
    expect(call).toMatchObject({ sk: 'session-key', api_key: KEY, format: 'json', 'track[0]': 'Song 1', 'mbid[0]': MBID, 'track[1]': 'Song 3', 'duration[1]': '600' });
    expect(call['timestamp[0]']).toBe(String(Math.floor(Date.parse(at(1000)) / 1000)));
    expect(call).not.toHaveProperty('mbid[1]');
    expect(call).not.toHaveProperty('track[2]');
    const { api_sig, format: _format, ...signed } = call;
    expect(api_sig).toBe(signature(signed, SECRET));
    expect(lastfm.info()).toMatchObject({ sent: 2, pending: 0, earlier: 1 });

    lastfm.sendEarlier();
    await lastfm.kick();
    expect(of('track.scrobble').at(-1)).toMatchObject({ 'track[0]': 'Song 2' });
    expect(lastfm.info()).toMatchObject({ sent: 3, earlier: 0 });
  });

  it('doesn’t send again what Last.fm ignored', async () => {
    const ignored = Response.json({ scrobbles: { scrobble: { ignoredMessage: { code: '1', '#text': 'Artist was ignored' } } } });
    const { lastfm, of, play, at } = await connected({ 'track.scrobble': [ignored] });
    await play(1, 150, at(1000));
    await lastfm.kick();
    await lastfm.kick();
    expect(of('track.scrobble')).toHaveLength(1);
    expect(lastfm.info()).toMatchObject({ sent: 0, pending: 0 });
  });

  it('stops for an account whose access was taken back, and says so', async () => {
    const { lastfm, play, at } = await connected({ 'track.scrobble': [refusal(9, 'Invalid session key')] });
    await play(1, 150, at(1000));
    await lastfm.kick();
    expect(lastfm.info()).toMatchObject({ enabled: false, pending: 1, error: 'Last.fm no longer accepts Playarr for this account: connect again.' });
  });

  it('waits when Last.fm is busy or out of reach, then sends', async () => {
    const { lastfm, of, play, at, later } = await connected({ 'track.scrobble': [refusal(29, 'Rate limit exceeded'), null] });
    await play(1, 150, at(1000));
    await lastfm.kick();
    await lastfm.kick();
    expect(of('track.scrobble')).toHaveLength(1);
    later(10 * 60_000);
    await lastfm.kick(); // out of reach
    expect(lastfm.info()).toMatchObject({ pending: 1 });
    later(5 * 60_000);
    await lastfm.kick();
    expect(lastfm.info()).toMatchObject({ sent: 1, pending: 0 });
  });

  it('forgets every session when the server’s API account is removed or replaced', async () => {
    const { lastfm } = await connected();
    await lastfm.setApp('d'.repeat(32), SECRET);
    expect(lastfm.info()).toMatchObject({ connected: false, enabled: false, error: 'The server’s Last.fm API account changed: connect again.' });
    const { token } = await lastfm.connect();
    await lastfm.finish(token);
    expect(lastfm.removeApp()).toMatchObject({ available: false, connected: false });
  });

  it('says when Last.fm can’t be reached', async () => {
    const { lastfm } = setup({ 'auth.getToken': [null] });
    const err = await lastfm.setApp(KEY, SECRET).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LastFmError);
    expect(err).toMatchObject({ status: 502, message: 'Couldn’t reach Last.fm' });
  });
});
