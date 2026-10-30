import { describe, expect, it } from 'vitest';
import { FolderAccess } from './folderAccess.ts';
import { CatalogStore } from './store.ts';
import { freshDb } from './testFixtures.ts';

describe('FolderAccess', () => {
  it('gives each folder source its filesystem, cached until its settings change', async () => {
    const store = new CatalogStore(freshDb());
    const local = store.addSource('folder', 'Here', { path: '/music' });
    const remote = store.addSource('folder', 'NAS', { path: '/volume1/music', access: 'sftp', host: 'nas', user: 'me' });
    const lidarr = store.addSource('lidarr', 'Lidarr', { url: 'http://x', apiKey: 'k' });
    const access = new FolderAccess(store, { ffmpeg: 'ffmpeg', fpcalc: 'fpcalc', localFingerprints: false });
    expect(access.get(local)!.kind).toBe('local');
    expect(access.get(remote)!.kind).toBe('sftp');
    expect(access.get(remote)).toBe(access.get(remote));
    expect(access.get(lidarr)).toBeUndefined();
    const before = access.get(remote);
    store.updateSource(remote, { settings: { path: '/volume1/music', access: 'ssh', host: 'nas', user: 'me' } });
    expect(access.get(remote)).not.toBe(before);
    expect(access.get(remote)!.kind).toBe('ssh');
    await access.closeAll();
  });

  it('needs a host and a user for remote folders', () => {
    const access = new FolderAccess(new CatalogStore(freshDb()), { ffmpeg: 'ffmpeg', fpcalc: 'fpcalc', localFingerprints: false });
    expect(() => access.create({ path: '/m', access: 'ssh' })).toThrow(/host and a user/);
  });

  it('reads SMB shares through rclone, when it is there', async () => {
    const store = new CatalogStore(freshDb());
    const share = store.addSource('folder', 'Share', { path: '/music', access: 'smb', host: 'nas', user: 'guest' });
    const withRclone = new FolderAccess(store, { ffmpeg: 'ffmpeg', fpcalc: 'fpcalc', localFingerprints: false, rclone: 'rclone' });
    expect(withRclone.get(share)!.kind).toBe('smb');
    await withRclone.closeAll();
    const without = new FolderAccess(store, { ffmpeg: 'ffmpeg', fpcalc: 'fpcalc', localFingerprints: false });
    expect(() => without.get(share)).toThrow(/need rclone/);
    expect(() => without.create({ path: '/music', access: 'smb', host: 'nas', user: 'me' })).toThrow(/need rclone/);
  });
});
