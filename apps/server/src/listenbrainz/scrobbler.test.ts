import type { Track } from '@playarr/shared';
import { describe, expect, it, vi } from 'vitest';
import { CatalogStore } from '../catalog/store.ts';
import { freshDb } from '../catalog/testFixtures.ts';
import { History } from '../mixes/history.ts';
import { isListen, Scrobbler } from './scrobbler.ts';

const MBID = '0f3b1c2d-1111-4222-8333-444455556666';
const song = (id: number, duration = 200): Track =>
  ({ id, recordingId: id === 1 ? MBID : `track:${id}`, artistName: 'Artist', title: `Song ${id}`, albumTitle: 'Album', duration, trackNumber: id, artistId: 1, albumId: 1 }) as Track;

function setup(responses: (Response | null)[] = []) {
  const db = freshDb();
  const store = new CatalogStore(db);
  const tracks = [song(1), song(2), song(3, 600)];
  const library = {
    track: async (id: number) => tracks.find((t) => t.id === id),
    trackByRecording: async (r: string) => tracks.find((t) => t.recordingId === r),
    tracksByRecordings: async (ids: string[]) => tracks.filter((t) => ids.includes(t.recordingId)),
  };
  const history = new History(db, library);
  const calls: { url: string; init?: RequestInit }[] = [];
  const queue = [...responses];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = queue.shift();
    if (next === null) throw new Error('offline');
    return next ?? Response.json({ status: 'ok' });
  }) as unknown as typeof globalThis.fetch;
  const scrobbler = new Scrobbler(db, store, library, { log: { warn: () => {} }, fetch });
  const play = (trackId: number, seconds: number, at: string, skipped = false) =>
    history.record([{ trackId, recordingId: tracks[trackId - 1]!.recordingId, at, hour: 1, weekday: 1, seconds, skipped }]);
  return { scrobbler, calls, play, store };
}

const valid = () => Response.json({ valid: true, user_name: 'nicola' });

describe('ListenBrainz', () => {
  it('counts a listen after half the song or four minutes', () => {
    expect(isListen(100, 200)).toBe(true);
    expect(isListen(99, 200)).toBe(false);
    expect(isListen(240, 600)).toBe(true);
  });

  it('checks the token, keeps it to itself, and sends listens played from then on', async () => {
    const { scrobbler, calls, play, store } = setup([valid()]);
    await play(1, 150, '2020-01-01T10:00:00Z'); // before connecting
    const info = await scrobbler.connect('secret-token');
    expect(info).toMatchObject({ connected: true, user: 'nicola', enabled: true, earlier: 1, pending: 0 });
    expect(JSON.stringify(info)).not.toContain('secret-token');
    const now = Date.now();
    await play(1, 150, new Date(now + 1000).toISOString());
    await play(2, 20, new Date(now + 2000).toISOString()); // too short
    await play(3, 300, new Date(now + 3000).toISOString());
    await play(3, 400, new Date(now + 4000).toISOString(), true); // skipped
    await scrobbler.kick();
    const submit = calls.find((c) => c.url.endsWith('/submit-listens'))!;
    expect((submit.init!.headers as Record<string, string>).Authorization).toBe('Token secret-token');
    const body = JSON.parse(submit.init!.body as string);
    expect(body.listen_type).toBe('import');
    expect(body.payload.map((l: { track_metadata: { track_name: string } }) => l.track_metadata.track_name)).toEqual(['Song 1', 'Song 3']);
    expect(body.payload[0].track_metadata.additional_info.recording_mbid).toBe(MBID);
    expect(body.payload[1].track_metadata.additional_info.recording_mbid).toBeUndefined();
    expect(scrobbler.info()).toMatchObject({ sent: 2, pending: 0, earlier: 1 });
    expect(store.appSetting('listenbrainz')).toContain('secret-token');

    scrobbler.sendEarlier();
    await scrobbler.kick();
    expect(scrobbler.info()).toMatchObject({ sent: 3, earlier: 0 });
  });

  it('refuses a token ListenBrainz doesn’t know', async () => {
    const { scrobbler } = setup([Response.json({ valid: false })]);
    await expect(scrobbler.connect('nope')).rejects.toThrow(/doesn’t know/);
    expect(scrobbler.info().connected).toBe(false);
  });

  it('waits when ListenBrainz is busy, and stops when the token is revoked', async () => {
    const busy = new Response('', { status: 429, headers: { 'X-RateLimit-Reset-In': '30' } });
    const { scrobbler, calls, play } = setup([valid(), busy, new Response('', { status: 401 })]);
    await scrobbler.connect('t');
    await play(1, 150, new Date(Date.now() + 1000).toISOString());
    await scrobbler.kick();
    expect(scrobbler.info()).toMatchObject({ pending: 1, sent: 0 });
    await scrobbler.kick(); // still waiting: nothing sent
    expect(calls.filter((c) => c.url.endsWith('/submit-listens'))).toHaveLength(1);
    (scrobbler as unknown as { pauseUntil: number }).pauseUntil = 0;
    await scrobbler.kick();
    expect(scrobbler.info()).toMatchObject({ enabled: false, pending: 1 });
    expect(scrobbler.info().error).toMatch(/no longer accepts/);
  });
});
