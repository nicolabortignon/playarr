import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchRemoteImage, imageBody } from './art.ts';

afterEach(() => vi.restoreAllMocks());

/** A body that arrives in `chunks` pieces of `size` bytes, saying how many it read. */
function trickle(chunks: number, size: number) {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent++ < chunks) controller.enqueue(new Uint8Array(size));
      else controller.close();
    },
  });
  return { body, sent: () => sent };
}

describe('imageBody', () => {
  it('takes an image up to the limit', async () => {
    const res = new Response(trickle(4, 1000).body, { headers: { 'content-type': 'image/jpeg' } });
    expect((await imageBody(res, 4000)).length).toBe(4000);
  });

  it('refuses an image whose length is over the limit without reading it', async () => {
    const { body, sent } = trickle(10, 1000);
    const res = new Response(body, { headers: { 'content-length': '10000' } });
    await expect(imageBody(res, 4000)).rejects.toThrow('Image over 0 MB');
    expect(sent()).toBeLessThanOrEqual(1);
  });

  it('stops reading an image that doesn’t say its length once it’s past the limit', async () => {
    const { body, sent } = trickle(1000, 1024 * 1024);
    await expect(imageBody(new Response(body))).rejects.toThrow('Image over 20 MB');
    expect(sent()).toBeLessThan(30);
  });
});

describe('fetchRemoteImage', () => {
  it('refuses an image over 20 MB', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(trickle(40, 1024 * 1024).body, { headers: { 'content-type': 'image/png' } }));
    await expect(fetchRemoteImage('https://coverartarchive.org/release-group/x/front-250')).rejects.toThrow('Image over 20 MB');
  });
});
