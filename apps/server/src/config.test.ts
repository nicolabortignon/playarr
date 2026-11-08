import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';

describe('config', () => {
  it('trusts no proxy unless TRUST_PROXY says which', () => {
    expect(loadConfig({}).trustProxy).toBe(false);
    expect(loadConfig({ TRUST_PROXY: '' }).trustProxy).toBe(false);
    expect(loadConfig({ TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(loadConfig({ TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(() => loadConfig({ TRUST_PROXY: '2' })).toThrow(/hop count/);
    expect(loadConfig({ TRUST_PROXY: '172.17.0.1, 10.0.0.0/8,loopback' }).trustProxy).toEqual(['172.17.0.1', '10.0.0.0/8', 'loopback']);
    expect(() => loadConfig({ TRUST_PROXY: 'http://proxy' })).toThrow(/TRUST_PROXY/);
    // Hop counts are refused, so the message doesn't offer them.
    expect(() => loadConfig({ TRUST_PROXY: 'my proxy' })).toThrow('"my proxy" is not true, an address, a CIDR, loopback, linklocal, uniquelocal or a name');
    expect(() => loadConfig({ TRUST_PROXY: '10.0.0' })).toThrow(/"10\.0\.0" is not/);
  });

  it('takes proxies by name (a container on the compose network), but not mixed with addresses', () => {
    expect(loadConfig({ TRUST_PROXY: 'caddy' }).trustProxy).toEqual(['caddy']);
    expect(loadConfig({ TRUST_PROXY: 'caddy, proxy.lan' }).trustProxy).toEqual(['caddy', 'proxy.lan']);
    expect(() => loadConfig({ TRUST_PROXY: 'caddy, 172.18.0.1' })).toThrow('give the proxies’ addresses or their names, not both');
  });

  it('serves Caddy’s domain: PLAYARR_DOMAIN makes the public address https://<domain> and Caddy the proxy believed', () => {
    const behindCaddy = loadConfig({ PLAYARR_DOMAIN: 'Music.Example.com' });
    expect(behindCaddy.PUBLIC_URL).toBe('https://music.example.com');
    expect(behindCaddy.trustProxy).toEqual(['playarr-caddy']);
    expect(loadConfig({ PLAYARR_DOMAIN: 'https://music.example.com/' }).PLAYARR_DOMAIN).toBe('music.example.com');
    // What's set wins.
    const own = loadConfig({ PLAYARR_DOMAIN: 'music.example.com', PUBLIC_URL: 'https://tracklist.me', TRUST_PROXY: '172.18.0.1' });
    expect([own.PUBLIC_URL, own.trustProxy]).toEqual(['https://tracklist.me', ['172.18.0.1']]);
    expect(loadConfig({ PLAYARR_DOMAIN: 'music.example.com', TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    // Without it, nothing changes.
    expect([loadConfig({}).PUBLIC_URL, loadConfig({}).trustProxy]).toEqual([undefined, false]);
    for (const bad of ['music', 'music.example.com:8443', 'http://music.example.com', 'music.example.com/playarr']) {
      expect(() => loadConfig({ PLAYARR_DOMAIN: bad }), bad).toThrow(/PLAYARR_DOMAIN: the name only/);
    }
  });

  it('takes PUBLIC_URL as an http(s) origin without the trailing slash', () => {
    expect(loadConfig({}).PUBLIC_URL).toBeUndefined();
    expect(loadConfig({ PUBLIC_URL: 'https://music.example.com/' }).PUBLIC_URL).toBe('https://music.example.com');
    expect(loadConfig({ PUBLIC_URL: 'http://nas:4000' }).PUBLIC_URL).toBe('http://nas:4000');
    expect(() => loadConfig({ PUBLIC_URL: 'ftp://nas' })).toThrow(/PUBLIC_URL/);
    expect(() => loadConfig({ PUBLIC_URL: 'nas:4000' })).toThrow(/PUBLIC_URL/);
  });
});
