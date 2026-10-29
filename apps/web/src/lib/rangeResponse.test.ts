import { describe, expect, it } from 'vitest';
import { rangeResponse } from './rangeResponse';

const bytes = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);
const stored = () => new Response(new Blob([bytes]), { headers: { 'Content-Type': 'audio/flac', 'Content-Length': '1000', ETag: '"x"' } });
const ask = (range?: string) => rangeResponse(new Request('http://localhost/stream/1', { headers: range ? { Range: range } : {} }), stored());

describe('playing a kept song', () => {
  it('returns the whole file without a range', async () => {
    const res = await ask();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/flac');
    expect((await res.arrayBuffer()).byteLength).toBe(1000);
  });

  it.each([
    ['bytes=0-', 0, 999],
    ['bytes=100-199', 100, 199],
    ['bytes=-50', 950, 999],
    ['bytes=990-5000', 990, 999], // clamped to the end, as the server does
  ])('answers %s with the right slice', async (range, start, end) => {
    const res = await ask(range);
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes ${start}-${end}/1000`);
    expect(res.headers.get('content-length')).toBe(String(end - start + 1));
    expect(res.headers.get('etag')).toBe('"x"');
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...bytes.slice(start, end + 1)]);
  });

  it('refuses a range past the end', async () => {
    const res = await ask('bytes=2000-');
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */1000');
  });
});
