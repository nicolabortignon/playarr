import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcoustId } from './acoustid.ts';

afterEach(() => vi.restoreAllMocks());

describe('AcoustId', () => {
  it('is off without a key', () => {
    expect(new AcoustId(() => undefined).enabled).toBe(false);
  });

  it('returns the best recording with its release groups', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'ok',
          results: [
            { score: 0.4, recordings: [{ id: 'rec-x' }] },
            {
              score: 0.93,
              recordings: [
                {
                  id: 'rec-1',
                  title: 'Angel',
                  artists: [{ id: 'art-1', name: 'Massive Attack' }],
                  releasegroups: [{ id: 'rg-1', title: 'Mezzanine', type: 'Album' }, { id: 'rg-9', title: 'Collected', type: 'Album', secondarytypes: ['Compilation'] }],
                },
              ],
            },
          ],
        }),
      ),
    );
    const match = await new AcoustId(() => 'KEY').lookup({ duration: 379.6, fingerprint: 'AQAA' });
    expect(match).toEqual({
      score: 0.93,
      recordingId: 'rec-1',
      title: 'Angel',
      artistName: 'Massive Attack',
      artistId: 'art-1',
      releaseGroups: [
        { id: 'rg-1', title: 'Mezzanine', type: 'Album', secondaryTypes: [] },
        { id: 'rg-9', title: 'Collected', type: 'Album', secondaryTypes: ['Compilation'] },
      ],
    });
    const body = String(fetchMock.mock.calls[0]![1]!.body);
    expect(body).toContain('client=KEY');
    expect(body).toContain('duration=380');
    expect(body).toContain('meta=recordings+releasegroups');
  });

  it('reports API errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ status: 'error', error: { message: 'invalid API key' } })));
    await expect(new AcoustId(() => 'BAD').lookup({ duration: 1, fingerprint: 'x' })).rejects.toThrow(/invalid API key/);
  });
});
