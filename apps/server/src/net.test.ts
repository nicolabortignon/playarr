import { describe, expect, it } from 'vitest';
import { isFromApp, isLocalAddress, isLocalHost, isLocalRequest } from './net.ts';

describe('isLocalAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.20',
    '169.254.10.1',
    '::1',
    'fd12:3456::1',
    'fe80::1',
    '::ffff:192.168.1.20',
  ])('%s is local', (address) => {
    expect(isLocalAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '172.32.0.1', '203.0.113.5', '2001:db8::1', '::ffff:8.8.8.8', 'garbage', '', undefined])(
    '%s is not local',
    (address) => {
      expect(isLocalAddress(address)).toBe(false);
    },
  );
});

describe('isLocalRequest', () => {
  const req = (headers: Record<string, string>, remoteAddress = '192.168.1.20') => ({ socket: { remoteAddress }, headers });

  it('accepts a home device asking by IP or local name', () => {
    expect(isLocalRequest(req({ host: '192.168.1.103:4000' }))).toBe(true);
    expect(isLocalRequest(req({ host: 'nas:4000' }))).toBe(true);
    expect(isLocalRequest(req({ host: 'playarr.local' }))).toBe(true);
    expect(isLocalRequest(req({ host: '[fd00::5]:4000' }))).toBe(true);
  });

  it('refuses requests through a proxy, or addressed to an outside name (DNS rebinding)', () => {
    expect(isLocalRequest(req({ host: '192.168.1.103:4000', 'x-forwarded-for': '203.0.113.5' }))).toBe(false);
    expect(isLocalRequest(req({ host: 'evil.example.com:4000' }))).toBe(false);
    expect(isLocalRequest(req({ host: '192.168.1.103:4000' }, '203.0.113.5'))).toBe(false);
  });

  it('accepts names listed in LOCAL_HOSTNAMES', () => {
    expect(isLocalHost('music.example.com', ['music.example.com'])).toBe(true);
    expect(isLocalHost(undefined)).toBe(false);
  });
});

describe('isFromApp', () => {
  it('lets reads through and wants the app header on changes', () => {
    expect(isFromApp({ method: 'GET', headers: {} })).toBe(true);
    expect(isFromApp({ method: 'POST', headers: {} })).toBe(false);
    expect(isFromApp({ method: 'POST', headers: { 'x-playarr': '1' } })).toBe(true);
  });
});
