import { describe, expect, it } from 'vitest';
import { elsewhere } from './publicAddress';

describe('elsewhere', () => {
  it('is the public address when this page is served from another origin', () => {
    expect(elsewhere('https://tracklist.me', 'http://192.168.1.103:4000')?.host).toBe('tracklist.me');
    expect(elsewhere('https://tracklist.me', 'http://tracklist.me')?.host).toBe('tracklist.me');
  });

  it('is null on the public address itself, without one, or for one that isn’t a URL', () => {
    expect(elsewhere('https://tracklist.me', 'https://tracklist.me')).toBeNull();
    expect(elsewhere(undefined, 'http://192.168.1.103:4000')).toBeNull();
    expect(elsewhere('tracklist.me', 'http://192.168.1.103:4000')).toBeNull();
  });
});
