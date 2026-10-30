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
