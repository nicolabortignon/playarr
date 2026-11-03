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
    expect(() => loadConfig({ TRUST_PROXY: 'my-proxy' })).toThrow(/TRUST_PROXY/);
    // Hop counts are refused, so the message doesn't offer them.
    expect(() => loadConfig({ TRUST_PROXY: 'my-proxy' })).toThrow('"my-proxy" is not true, an address, a CIDR, loopback, linklocal or uniquelocal');
  });

  it('takes PUBLIC_URL as an http(s) origin without the trailing slash', () => {
    expect(loadConfig({}).PUBLIC_URL).toBeUndefined();
    expect(loadConfig({ PUBLIC_URL: 'https://music.example.com/' }).PUBLIC_URL).toBe('https://music.example.com');
    expect(loadConfig({ PUBLIC_URL: 'http://nas:4000' }).PUBLIC_URL).toBe('http://nas:4000');
    expect(() => loadConfig({ PUBLIC_URL: 'ftp://nas' })).toThrow(/PUBLIC_URL/);
    expect(() => loadConfig({ PUBLIC_URL: 'nas:4000' })).toThrow(/PUBLIC_URL/);
  });
});
