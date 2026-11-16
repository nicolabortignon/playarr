import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { account, actAs, asAccount } from '../accounts/testAccess.ts';
import { mixRoutes } from '../routes/mixes.ts';
import type { LastFm } from './scrobbler.ts';

/** Settings → Mixes → Last.fm's routes over a stand-in for LastFm, as an admin (1) and a member (2). */
function setup() {
  const lastfm = {
    info: vi.fn((account: number, admin: boolean) => ({ available: true, account, admin })),
    setApp: vi.fn(async () => ({ available: true })),
    removeApp: vi.fn(() => ({ available: false })),
    connect: vi.fn(async () => ({ url: 'https://www.last.fm/api/auth/?api_key=k&token=t', token: 't' })),
    finish: vi.fn(async () => ({})),
    disconnect: vi.fn(),
    setEnabled: vi.fn(),
    sendEarlier: vi.fn(),
    kick: vi.fn(async () => {}),
  };
  const app = Fastify();
  actAs(app, [account(1, { role: 'admin' }), account(2)]);
  mixRoutes(app, {
    mixes: {} as never,
    history: {} as never,
    store: { appSetting: () => undefined, setAppSetting: () => {} },
    analysisAvailable: false,
    analyzeLibrary: () => {},
    library: {} as never,
    lastfm: lastfm as unknown as LastFm,
  });
  const send = (method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, as: number, payload?: object) =>
    app.inject({ method, url, headers: asAccount(as), ...(payload ? { payload } : {}) });
  return { lastfm, send };
}

const KEY = 'A'.repeat(32);
const SECRET = 'b'.repeat(32);

describe('the Last.fm routes', () => {
  it('let only an admin set the server’s API account, checking it looks like one', async () => {
    const { lastfm, send } = setup();
    expect((await send('PUT', '/api/settings/lastfm/app', 2, { apiKey: KEY, secret: SECRET })).statusCode).toBe(403);
    expect((await send('DELETE', '/api/settings/lastfm/app', 2)).statusCode).toBe(403);
    const bad = await send('PUT', '/api/settings/lastfm/app', 1, { apiKey: 'short', secret: SECRET });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('An API key is 32 letters and digits');
    expect(lastfm.setApp).not.toHaveBeenCalled();
    expect((await send('PUT', '/api/settings/lastfm/app', 1, { apiKey: KEY, secret: SECRET })).statusCode).toBe(200);
    expect(lastfm.setApp).toHaveBeenCalledWith('a'.repeat(32), SECRET, 1);
  });

  it('give each account its own link, and only an admin the API key', async () => {
    const { lastfm, send } = setup();
    expect((await send('GET', '/api/settings/lastfm', 2)).json()).toEqual({ available: true, account: 2, admin: false });
    expect((await send('GET', '/api/settings/lastfm', 1)).json()).toEqual({ available: true, account: 1, admin: true });
    expect((await send('POST', '/api/settings/lastfm/connect', 2)).json()).toEqual({ url: 'https://www.last.fm/api/auth/?api_key=k&token=t', token: 't' });
    await send('POST', '/api/settings/lastfm/finish', 2, { token: 't' });
    expect(lastfm.finish).toHaveBeenCalledWith('t', 2);
    await send('PUT', '/api/settings/lastfm', 2, { enabled: false });
    expect(lastfm.setEnabled).toHaveBeenCalledWith(false, 2);
    await send('DELETE', '/api/settings/lastfm', 2);
    expect(lastfm.disconnect).toHaveBeenCalledWith(2);
  });
});
