import { describe, expect, it } from 'vitest';
import { isLocalAddress } from './net.ts';

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
