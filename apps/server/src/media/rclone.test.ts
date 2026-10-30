import { describe, expect, it } from 'vitest';
import { cleanRcloneError, obscure, parseLsjson, reveal, smbEnv } from './rclone.ts';

describe('obscure', () => {
  it('matches rclone', () => {
    expect(reveal('rCT8g9glnAwjqSXuumvcrycJ')).toBe('pw');
    expect(reveal(obscure(`pä ss'"$x`))).toBe(`pä ss'"$x`);
    expect(obscure('pw')).not.toBe(obscure('pw'));
  });
});

describe('cleanRcloneError', () => {
  it('keeps the useful part of the last line', () => {
    const stderr =
      '2026/10/30 18:33:42 NOTICE: Config file not found\n' +
      '2026/10/30 18:33:42 CRITICAL: Failed to create file system for ":smb:share/x": couldn\'t connect SMB: dial tcp 127.0.0.1:1: connect: connection refused\n';
    expect(cleanRcloneError(stderr)).toBe("couldn't connect SMB: dial tcp 127.0.0.1:1: connect: connection refused");
    expect(cleanRcloneError('2026/10/30 18:33:37 NOTICE: Failed to lsjson: directory not found\n')).toBe('directory not found');
    expect(cleanRcloneError('')).toBe('');
  });
});

describe('parseLsjson', () => {
  it('reads entries', () => {
    expect(
      parseLsjson('[{"Path":"A/01.flac","Name":"01.flac","Size":12,"ModTime":"2026-10-30T18:32:22.5Z","IsDir":false},{"Path":"B","Name":"B","Size":-1,"ModTime":"","IsDir":true}]'),
    ).toEqual([
      { path: 'A/01.flac', name: '01.flac', size: 12, mtimeMs: Date.parse('2026-10-30T18:32:22.5Z'), dir: false },
      { path: 'B', name: 'B', size: 0, mtimeMs: 0, dir: true },
    ]);
  });
});

describe('smbEnv', () => {
  it('puts the connection in rclone environment variables, the password obscured', () => {
    const env = smbEnv({ host: 'nas', port: 445, user: 'me', password: 'pw', domain: 'HOME' });
    expect(env).toMatchObject({ RCLONE_SMB_HOST: 'nas', RCLONE_SMB_PORT: '445', RCLONE_SMB_USER: 'me', RCLONE_SMB_DOMAIN: 'HOME' });
    expect(reveal(env.RCLONE_SMB_PASS!)).toBe('pw');
    expect(smbEnv({ host: 'nas', user: 'guest' })).not.toHaveProperty('RCLONE_SMB_PASS');
  });
});
