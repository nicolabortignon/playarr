import { afterEach, describe, expect, it, vi } from 'vitest';
import { freshDb } from '../catalog/testFixtures.ts';
import type { FileResolver } from '../catalog/files.ts';
import type { Library } from '../library/library.ts';
import { Analyzer } from './analyzer.ts';

const MBID = '11111111-1111-1111-1111-111111111111';

afterEach(() => vi.restoreAllMocks());

describe('Analyzer tags', () => {
  it('waits when ListenBrainz says to slow down, then asks again for the same songs', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'X-RateLimit-Reset-In': '0' } }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ [MBID]: { tag: { recording: [{ tag: 'trip hop', count: 5 }] } } }), {
          headers: { 'X-RateLimit-Remaining': '10', 'X-RateLimit-Reset-In': '5' },
        }),
      );
    const analyzer = new Analyzer(freshDb(), {} as Library, {} as FileResolver, { enabled: false, log: { warn: () => {} } });
    analyzer.ensure([MBID, 'local:abc']);
    await vi.waitFor(() => expect(analyzer.meta([MBID]).get(MBID)?.tags).toEqual([['trip hop', 1]]), { timeout: 3000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Songs without a MusicBrainz id are never sent (one unknown id fails a whole batch).
    expect(String(fetchMock.mock.calls[1]![0])).not.toContain('local:');
  });
});
