import { afterEach, describe, expect, it, vi } from 'vitest';
import { LidarrClient } from './client.ts';

afterEach(() => vi.restoreAllMocks());

describe('LidarrClient', () => {
  it('fails fast with a 503 when no Lidarr is set up', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const client = new LidarrClient();
    expect(client.configured).toBe(false);
    await expect(client.artists()).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('can be pointed at a Lidarr later', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ version: '3.1.6' }), { status: 200 }));
    const client = new LidarrClient();
    client.configure('http://lidarr:8686/', 'key');
    expect(client.configured).toBe(true);
    await expect(client.systemStatus()).resolves.toEqual({ version: '3.1.6' });
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://lidarr:8686/api/v1/system/status');
  });
});

describe('LidarrClient profiles', () => {
  it('lists quality and metadata profiles', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify([{ id: 1, name: 'Lossless' }]), { status: 200 }));
    const client = new LidarrClient('http://lidarr:8686', 'key');
    await expect(client.qualityProfiles()).resolves.toEqual([{ id: 1, name: 'Lossless' }]);
    await expect(client.metadataProfiles()).resolves.toEqual([{ id: 1, name: 'Lossless' }]);
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([
      'http://lidarr:8686/api/v1/qualityprofile',
      'http://lidarr:8686/api/v1/metadataprofile',
    ]);
  });
});

describe('LidarrClient retries', () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it('asks a question that didn’t reach Lidarr once more, after a moment', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(json({ version: '3.1.6' }));
    const client = new LidarrClient('http://lidarr:8686', 'key', 10);
    await expect(client.systemStatus()).resolves.toEqual({ version: '3.1.6' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('asks once more when Lidarr can’t answer just then, and says so if it still can’t', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ message: 'Lidarr is starting' }, 503));
    const client = new LidarrClient('http://lidarr:8686', 'key', 10);
    await expect(client.artists()).rejects.toMatchObject({ status: 503, message: 'Lidarr is starting' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never makes a change twice, and doesn’t ask again when the time ran out', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const client = new LidarrClient('http://lidarr:8686', 'key', 10);
    await expect(client.command('RefreshArtist')).rejects.toThrow('Cannot reach Lidarr at http://lidarr:8686: fetch failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockReset().mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    await expect(client.artists()).rejects.toThrow(/Cannot reach Lidarr/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
