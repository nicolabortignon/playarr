import type { AlbumRequest } from '@playarr/shared';
import { describe, expect, it } from 'vitest';
import { requestChanges, requestNewsCount, waitingMessage } from './queries';

const request = (mbid: string, patch: Partial<AlbumRequest> = {}): AlbumRequest => ({
  mbid,
  title: mbid,
  artistName: 'Massive Attack',
  requestedAt: '2026-11-07T10:00:00Z',
  availability: { state: 'searching' },
  ...patch,
});
const byMbid = (requests: AlbumRequest[]) => new Map(requests.map((r) => [r.mbid, r]));

describe('what changed in the requests', () => {
  it('says nothing at the first look, so albums already in aren’t announced', () => {
    expect(requestChanges(undefined, [request('Mezzanine', { availability: { state: 'available' } })])).toEqual({ landed: [], waiting: [] });
  });

  it('finds the requests that became playable, and those first seen already in', () => {
    const before = byMbid([request('Mezzanine'), request('Protection', { availability: { state: 'available' } })]);
    const now = [
      request('Mezzanine', { availability: { state: 'available' } }),
      request('Protection', { availability: { state: 'available' } }),
      request('Heligoland', { availability: { state: 'available' } }),
    ];
    expect(requestChanges(before, now).landed.map((r) => r.mbid)).toEqual(['Mezzanine', 'Heligoland']);
  });

  it('finds others’ requests newly waiting for an admin, never the account’s own', () => {
    const before = byMbid([request('Mezzanine', { approval: 'waiting', mine: false })]);
    const now = [
      request('Mezzanine', { approval: 'waiting', mine: false }),
      request('Heligoland', { approval: 'waiting', mine: false }),
      request('Protection', { approval: 'waiting', mine: true }),
    ];
    // An empty list before is a look too: the first request to wait is news.
    expect(requestChanges(new Map(), now).waiting.map((r) => r.mbid)).toEqual(['Mezzanine', 'Heligoland']);
    expect(requestChanges(before, now).waiting.map((r) => r.mbid)).toEqual(['Heligoland']);
  });

  it('says who asked, or how many wait', () => {
    expect(waitingMessage([])).toBeUndefined();
    expect(waitingMessage([request('Heligoland', { askedBy: ['Sam', 'Zoe'] })])).toBe('Sam asked for “Heligoland”');
    expect(waitingMessage([request('Heligoland')])).toBe('“Heligoland” is waiting for your approval');
    expect(waitingMessage([request('Heligoland'), request('Protection')])).toBe('2 albums are waiting for your approval');
  });
});

describe('the news on Requests', () => {
  it('counts the account’s own arrived or declined since it last looked, and others’ waiting for an answer', () => {
    expect(
      requestNewsCount([
        request('arrived', { unseen: true, mine: true }),
        request('declined', { approval: 'declined', unseen: true, mine: true }),
        request('seen', { unseen: false, mine: true }),
        request('sams', { approval: 'waiting', mine: false }),
        request('mine waiting', { approval: 'waiting', mine: true, unseen: false }),
      ]),
    ).toBe(3);
    // A server that predates ownership says nothing is news.
    expect(requestNewsCount([request('old', { availability: { state: 'available' } })])).toBe(0);
    expect(requestNewsCount(undefined)).toBe(0);
  });
});
