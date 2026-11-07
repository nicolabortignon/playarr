import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { LidarrClient } from '../lidarr/client.ts';
import { newHostKey, startSshServer, type SshTestServer } from '../testing/sshServer.ts';
import { FolderAccess, type FolderSettings, type HostKeyHandling } from './folderAccess.ts';
import { SourceError, SourceManager } from './sources.ts';
import { CatalogStore } from './store.ts';
import { freshDb, mezzanine, tempDir } from './testFixtures.ts';

const ENV = { url: 'http://lidarr:8686', apiKey: 'secret-key' };

function setup() {
  const store = new CatalogStore(freshDb());
  const lidarr = new LidarrClient();
  return { store, lidarr, manager: new SourceManager(store, lidarr, { info: () => {} }) };
}

afterEach(() => vi.restoreAllMocks());

describe('SourceManager', () => {
  it('seeds a Lidarr source from .env, once', () => {
    const { store, manager } = setup();
    manager.seedFromEnv(ENV);
    const [source] = store.listSources();
    expect(source).toMatchObject({ kind: 'lidarr', settings: ENV });
    store.removeSource(source!.id);
    manager.seedFromEnv(ENV); // a restart after the user removed it
    expect(store.listSources()).toEqual([]);
  });

  it('fills the Lidarr row Phase 1 created, keeping its id', () => {
    const { store, manager } = setup();
    const id = store.ensureSource('lidarr', 'Lidarr');
    manager.seedFromEnv(ENV);
    expect(store.listSources().map((s) => [s.id, s.settings])).toEqual([[id, ENV]]);
  });

  it('adds no source when .env has no Lidarr', () => {
    const { store, manager } = setup();
    manager.seedFromEnv({});
    expect(store.listSources()).toEqual([]);
  });

  it('points the shared Lidarr client at the enabled Lidarr source', () => {
    const { store, lidarr, manager } = setup();
    manager.seedFromEnv(ENV);
    expect(manager.active()).toHaveLength(1);
    expect(lidarr.configured).toBe(true);
    store.updateSource(store.listSources()[0]!.id, { enabled: false });
    expect(manager.active()).toEqual([]);
    expect(lidarr.configured).toBe(false);
  });

  it('keeps a source’s adapter from refresh to refresh until its settings change, so what it remembers lasts', () => {
    const { store, manager } = setup();
    manager.seedFromEnv(ENV);
    const id = store.listSources()[0]!.id;
    const [first] = manager.active();
    expect(manager.active()[0]!.source).toBe(first!.source);
    manager.update(id, { settings: { url: 'http://nas:8686', apiKey: 'another-key' } });
    expect(manager.active()[0]!.source).not.toBe(first!.source);
  });

  it('never sends secrets, and hides settings from remote visitors', () => {
    const { manager } = setup();
    manager.seedFromEnv(ENV);
    const [local] = manager.list({ includeSettings: true, syncing: false });
    expect(local).toMatchObject({ settings: { url: ENV.url }, secrets: ['apiKey'] });
    expect(JSON.stringify(local)).not.toContain(ENV.apiKey);
    const [remote] = manager.list({ includeSettings: false, syncing: false });
    expect(remote!.settings).toBeUndefined();
  });

  it('keeps the saved API key when an update leaves it out', () => {
    const { store, manager } = setup();
    manager.seedFromEnv(ENV);
    const id = store.listSources()[0]!.id;
    manager.update(id, { name: 'Home Lidarr', settings: { url: 'http://lidarr:8686/' } });
    expect(store.source(id)).toMatchObject({
      name: 'Home Lidarr',
      settings: { url: 'http://lidarr:8686', apiKey: ENV.apiKey },
    });
  });

  it('unsets the Lidarr client when its source is removed', () => {
    const { store, lidarr, manager } = setup();
    manager.seedFromEnv(ENV);
    manager.active();
    manager.remove(store.listSources()[0]!.id);
    expect(lidarr.configured).toBe(false);
  });

  it('allows one Lidarr source, with a URL and a key', () => {
    const { manager } = setup();
    expect(() => manager.add({ settings: { url: ENV.url } })).toThrow(/URL and an API key/);
    manager.add({ kind: 'lidarr', settings: ENV });
    expect(() => manager.add({ kind: 'lidarr', settings: ENV })).toThrow(SourceError);
  });

  it('rejects unknown kinds', () => {
    expect(() => setup().manager.add({ kind: 'cloud' as never })).toThrow(/Unknown source kind/);
  });

  it('rejects an order that misses a source', () => {
    const { manager } = setup();
    manager.seedFromEnv(ENV);
    expect(() => manager.reorder([])).toThrow(SourceError);
  });

  it('tests a connection with the saved key', async () => {
    const { store, manager } = setup();
    manager.seedFromEnv(ENV);
    const id = store.listSources()[0]!.id;
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ version: '3.1.6' }), { status: 200 }));
    await expect(manager.test({ id, url: 'http://lidarr:8686/' })).resolves.toEqual({ ok: true, version: '3.1.6' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('http://lidarr:8686/api/v1/system/status');
    expect((init!.headers as Record<string, string>)['X-Api-Key']).toBe(ENV.apiKey);
  });

  it('never sends the saved key to another address', async () => {
    const { store, manager } = setup();
    manager.seedFromEnv(ENV);
    const id = store.listSources()[0]!.id;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    await expect(manager.test({ id, url: 'http://attacker:8686' })).resolves.toEqual({ ok: false, error: 'Enter the API key for this address' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(() => manager.update(id, { settings: { url: 'http://elsewhere:8686' } })).toThrow(/API key/);
    expect(() => manager.update(id, { settings: { url: `${ENV.url}/` } })).not.toThrow(); // same server
  });

  it('reports a failed connection test', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }));
    await expect(setup().manager.test({ url: ENV.url, apiKey: 'wrong' })).resolves.toEqual({
      ok: false,
      error: 'Lidarr rejected the API key',
    });
  });

  describe('folders', () => {
    function withFolders() {
      const t = tempDir();
      mkdirSync(join(t.dir, 'Music'));
      mkdirSync(join(t.dir, 'More'));
      const store = new CatalogStore(freshDb());
      const lidarr = new LidarrClient();
      const manager = new SourceManager(store, lidarr, { info: () => {} }, [t.dir]);
      return { ...t, store, lidarr, manager };
    }

    function fakeRemote(dirs: Record<string, string[]>) {
      const fs = {
        kind: 'ssh',
        media: { check: async () => {} },
        stat: async (p: string) => (dirs[p] ? { size: 0, mtimeMs: 0, dir: true } : null),
        readdir: async (p: string) => (dirs[p] ?? []).map((name) => ({ name, dir: !name.includes('.'), file: name.includes('.') })),
        close: async () => {},
      };
      return { create: vi.fn((_settings: FolderSettings, _hostKeys?: HostKeyHandling) => fs), get: () => fs as never, release: () => {} };
    }

    it('adds a remote folder after checking it over the connection, keeping the password secret', async () => {
      const { store, manager, cleanup } = withFolders();
      onTestFinished(cleanup);
      const access = fakeRemote({ '/volume1/music': [] });
      manager.useFolderAccess(access as never);
      const input = { kind: 'folder' as const, settings: { access: 'ssh' as const, host: 'nas', user: 'me', password: 'pw', path: '/volume1/music' } };
      await manager.verify(input);
      const info = manager.add(input);
      expect(info).toMatchObject({ name: 'music', settings: { access: 'ssh', host: 'nas', user: 'me', path: '/volume1/music', port: 22 }, secrets: ['password'] });
      expect(JSON.stringify(info)).not.toContain('pw');
      expect(info.writable).toBeUndefined();
      expect(store.source(info.id)!.settings).toMatchObject({ password: 'pw' });
    });

    it('rejects a remote folder that isn’t there, or has no host', async () => {
      const { manager, cleanup } = withFolders();
      onTestFinished(cleanup);
      manager.useFolderAccess(fakeRemote({}) as never);
      await expect(manager.verify({ kind: 'folder', settings: { access: 'ssh', host: 'nas', user: 'me', path: '/nope' } })).rejects.toThrow(SourceError);
      expect(() => manager.add({ kind: 'folder', settings: { access: 'ssh', path: '/m' } })).toThrow(/host and a user/);
    });

    it('browses a remote connection, reusing a saved password', async () => {
      const { manager, store, cleanup } = withFolders();
      onTestFinished(cleanup);
      const access = fakeRemote({ '/': ['volume1', 'etc'], '/volume1': ['music', 'notes.txt'] });
      manager.useFolderAccess(access as never);
      const id = store.addSource('folder', 'NAS', { access: 'sftp', host: 'nas', user: 'me', password: 'pw', path: '/volume1' });
      const listing = await manager.browse({ id, path: '/volume1' });
      expect(listing).toEqual({ path: '/volume1', parent: '/', folders: [{ name: 'music', path: '/volume1/music' }], audioFiles: 0 });
      expect(access.create).toHaveBeenCalledWith(expect.objectContaining({ password: 'pw', host: 'nas' }), undefined);
      expect((await manager.browse({ connection: { access: 'ssh', host: 'nas', user: 'me' } })).path).toBe('/');
    });

    it('adds a folder on an SMB share, keeping the password secret', async () => {
      const { store, manager, cleanup } = withFolders();
      onTestFinished(cleanup);
      manager.useFolderAccess(fakeRemote({ '/music/Albums': [] }) as never);
      const input = {
        kind: 'folder' as const,
        settings: { access: 'smb' as const, host: 'nas', user: 'me', password: 'pw', domain: 'HOME', path: '/music/Albums/', privateKeyPath: '/k' },
      };
      await manager.verify(input);
      const info = manager.add(input);
      expect(info).toMatchObject({
        name: 'Albums',
        settings: { access: 'smb', host: 'nas', user: 'me', port: 445, path: '/music/Albums', domain: 'HOME' },
        secrets: ['password'],
      });
      expect(info.settings).not.toHaveProperty('privateKeyPath');
      expect(JSON.stringify(info)).not.toContain('pw');
      expect(store.source(info.id)!.settings).toMatchObject({ password: 'pw' });
      expect(store.source(info.id)!.settings).not.toHaveProperty('privateKeyPath');
    });

    it('needs a share for an SMB folder', () => {
      const { manager, cleanup } = withFolders();
      onTestFinished(cleanup);
      manager.useFolderAccess(fakeRemote({}) as never);
      expect(() => manager.add({ kind: 'folder', settings: { access: 'smb', host: 'nas', user: 'me', path: '/' } })).toThrow(/Choose a share/);
    });

    it('browses the shares of an SMB server', async () => {
      const { manager, cleanup } = withFolders();
      onTestFinished(cleanup);
      const access = fakeRemote({ '/': ['music', 'photos'] });
      manager.useFolderAccess(access as never);
      const listing = await manager.browse({ connection: { access: 'smb', host: 'nas', user: 'me' } });
      expect(listing).toEqual({
        path: '/',
        parent: null,
        folders: [
          { name: 'music', path: '/music' },
          { name: 'photos', path: '/photos' },
        ],
        audioFiles: 0,
      });
      expect(access.create).toHaveBeenCalledWith(expect.objectContaining({ access: 'smb', host: 'nas', user: 'me', port: 445 }), undefined);
    });

    it('sends a saved password only to the host, port and user it was saved for, asking for it again elsewhere', async () => {
      const { manager, store, cleanup } = withFolders();
      onTestFinished(cleanup);
      const access = fakeRemote({ '/': [], '/music': [] });
      manager.useFolderAccess(access as never);
      const saved = { access: 'sftp', host: 'nas', port: 22, user: 'me', password: 'pw', path: '/music' };
      const id = store.addSource('folder', 'NAS', saved);
      const browse = (connection: Record<string, unknown>) => manager.browse({ id, connection: { access: 'sftp', host: 'nas', user: 'me', ...connection } });
      await expect(browse({ host: 'elsewhere' })).rejects.toThrow('Enter the password again for the new address');
      await expect(browse({ port: 2222 })).rejects.toThrow('Enter the password again for the new address');
      await expect(browse({ user: 'you' })).rejects.toThrow('Enter the password again for the new user');
      await expect(manager.verify({ settings: { port: 2222 } }, id)).rejects.toThrow('Enter the password again for the new address');
      expect(() => manager.update(id, { settings: { host: 'elsewhere' } })).toThrow('Enter the password again for the new address');
      expect(access.create).not.toHaveBeenCalled();
      expect(store.source(id)!.settings).toEqual(saved);
      // The same host (in any case) and port: the saved password; a password typed: that one; a key file: none.
      await browse({ host: 'NAS' });
      expect(access.create).toHaveBeenLastCalledWith(expect.objectContaining({ host: 'NAS', password: 'pw' }), undefined);
      await browse({ host: 'elsewhere', password: 'other' });
      expect(access.create).toHaveBeenLastCalledWith(expect.objectContaining({ host: 'elsewhere', password: 'other' }), undefined);
      await browse({ host: 'elsewhere', privateKeyPath: '/keys/id' });
      expect(access.create.mock.lastCall?.[0]).toMatchObject({ host: 'elsewhere', privateKeyPath: '/keys/id' });
      expect(access.create.mock.lastCall?.[0]).not.toHaveProperty('password');
      manager.update(id, { settings: { host: 'elsewhere', privateKeyPath: '/keys/id' } });
      expect(store.source(id)!.settings).not.toHaveProperty('password');
    });

    it('doesn’t ask for a password again for SMB’s guest', () => {
      const { manager, store, cleanup } = withFolders();
      onTestFinished(cleanup);
      manager.useFolderAccess(fakeRemote({}) as never);
      const id = store.addSource('folder', 'Share', { access: 'smb', host: 'nas', port: 445, user: 'me', password: 'pw', path: '/music' });
      manager.update(id, { settings: { user: 'guest' } });
      expect(store.source(id)!.settings).toEqual({ access: 'smb', host: 'nas', port: 445, user: 'guest', path: '/music' });
    });

    it('adds folders inside the allowed roots, several of them', () => {
      const { dir, manager, cleanup } = withFolders();
      try {
        expect(manager.add({ kind: 'folder', settings: { path: join(dir, 'Music') } })).toMatchObject({
          kind: 'folder',
          name: 'Music',
          settings: { path: join(dir, 'Music') },
          writable: true,
        });
        expect(manager.add({ kind: 'folder', name: 'Extra', settings: { path: join(dir, 'More') } }).name).toBe('Extra');
      } finally {
        cleanup();
      }
    });

    it('rejects folders that are missing or outside the roots', () => {
      const { dir, manager, cleanup } = withFolders();
      try {
        expect(() => manager.add({ kind: 'folder', settings: { path: join(dir, 'Nope') } })).toThrow(SourceError);
        expect(() => manager.add({ kind: 'folder', settings: { path: '/etc' } })).toThrow(/outside/);
        expect(() => manager.add({ kind: 'folder' })).toThrow(/needs a folder/);
      } finally {
        cleanup();
      }
    });

    it('turns enabled sources into adapters in Settings order', () => {
      const { dir, store, manager, cleanup } = withFolders();
      try {
        const music = manager.add({ kind: 'folder', settings: { path: join(dir, 'Music') } });
        manager.add({ kind: 'lidarr', settings: { url: 'http://lidarr:8686', apiKey: 'k' } });
        expect(manager.active().map((a) => a.source.kind)).toEqual(['folder', 'lidarr']);
        store.updateSource(music.id, { enabled: false });
        expect(manager.active().map((a) => a.source.kind)).toEqual(['lidarr']);
      } finally {
        cleanup();
      }
    });

    it('browses only inside the roots', async () => {
      const { dir, manager, cleanup } = withFolders();
      try {
        expect((await manager.listFolders(dir)).folders.map((f) => f.name)).toEqual(['More', 'Music']);
        await expect(manager.listFolders('/etc')).rejects.toThrow(SourceError);
      } finally {
        cleanup();
      }
    });

    it('reports review and matching progress for folder sources', () => {
      const { dir, store, manager, cleanup } = withFolders();
      try {
        const music = manager.add({ kind: 'folder', settings: { path: join(dir, 'Music') } });
        const sync = mezzanine();
        sync.copies = [{ ...sync.copies[0]!, ref: 'a.flac' }];
        store.applySync(music.id, sync);
        store.saveMatches(music.id, [{ rel: 'a.flac', groupKey: 'g', state: 'review', candidates: [], size: 1, mtimeMs: 1 }]);
        manager.useMatcher({ pendingGroups: () => 3, enqueue: () => {} });
        expect(manager.list({ includeSettings: true, syncing: false })[0]).toMatchObject({ review: 1, matching: 3 });
      } finally {
        cleanup();
      }
    });
  });
});

describe('SSH host keys', () => {
  const servers: SshTestServer[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  async function nas(opts: { port?: number; authorizedKey?: string } = {}) {
    const s = await startSshServer({ user: 'me', password: 'pw', dirs: ['/music'], ...opts });
    servers.push(s);
    return s;
  }

  /** The machine at the same address, reinstalled: a new host key. */
  async function reinstall(s: SshTestServer, opts: { authorizedKey?: string } = {}) {
    await s.close();
    servers.splice(servers.indexOf(s), 1);
    return nas({ port: s.port, ...opts });
  }

  function setup() {
    const store = new CatalogStore(freshDb());
    const manager = new SourceManager(store, new LidarrClient(), { info: () => {} });
    const folders = new FolderAccess(store, { ffmpeg: 'ffmpeg', fpcalc: 'fpcalc', localFingerprints: false });
    manager.useFolderAccess(folders);
    onTestFinished(() => folders.closeAll());
    const hostKey = (id: number) => (store.source(id)!.settings as FolderSettings).hostKey?.fingerprint;
    return { store, manager, folders, hostKey };
  }

  const folderOn = (s: SshTestServer, settings: Record<string, unknown> = {}) => ({
    kind: 'folder' as const,
    settings: { access: 'ssh' as const, host: '127.0.0.1', port: s.port, user: 'me', path: '/music', ...settings },
  });
  const passwordsSent = (s: SshTestServer) => s.logins.filter((l) => l.method === 'password').map((l) => l.password);

  /** A folder added with its password, as Settings adds it: checked, then saved with what the check found. */
  async function added(manager: SourceManager, s: SshTestServer) {
    const input = folderOn(s, { password: 'pw' });
    return manager.add(input, await manager.verify(input));
  }

  it('records the host’s key when a remote folder is added, and shows it to admins', async () => {
    const s = await nas();
    const { manager, hostKey } = setup();
    const info = await added(manager, s);
    expect(hostKey(info.id)).toBe(s.fingerprint);
    expect(info.settings?.hostKey).toEqual({ type: 'ssh-ed25519', fingerprint: s.fingerprint });
  });

  it('records the key of a source saved before keys were checked, on its next connection', async () => {
    const s = await nas();
    const { store, folders, hostKey } = setup();
    const id = store.addSource('folder', 'NAS', folderOn(s, { password: 'pw' }).settings);
    const fs = folders.get(id)!;
    await fs.media.check();
    expect(hostKey(id)).toBe(s.fingerprint);
    expect(folders.get(id)).toBe(fs); // the same connection: recording its key isn't a change of settings
  });

  it('records a first key only into the settings its connection was made with', async () => {
    const s = await nas();
    const { store, folders, hostKey } = setup();
    const settings = folderOn(s, { password: 'pw' }).settings;
    const id = store.addSource('folder', 'NAS', settings);
    const fs = folders.get(id)!;
    store.updateSource(id, { settings: { ...settings, host: 'elsewhere' } }); // edited meanwhile
    await fs.media.check();
    expect(hostKey(id)).toBeUndefined();
  });

  it('refuses a changed key before logging in, and the sync says why', async () => {
    const before = await nas();
    const { store, manager, hostKey } = setup();
    const { id } = await added(manager, before);
    const after = await reinstall(before);
    const sync = manager.active().find((a) => a.id === id)!.source.sync();
    await expect(sync).rejects.toThrow(
      `The SSH host’s key has changed since Playarr first connected (it was ${before.fingerprint}, now ${after.fingerprint}). ` +
        'If you reinstalled or replaced that machine, edit the source in Settings → Sources, enter its password again and save it to trust the new key; ' +
        'if not, something may be pretending to be it.',
    );
    expect(after.logins).toEqual([]);
    // Browsing doesn't trust it either: only saving does.
    const browse = manager.browse({ id, path: '/music', connection: { access: 'ssh', host: '127.0.0.1', port: after.port, user: 'me' } });
    await expect(browse).rejects.toThrow(/key has changed/);
    expect(after.logins).toEqual([]);
    expect(hostKey(id)).toBe(before.fingerprint);
    expect(store.source(id)!.settings).toMatchObject({ password: 'pw' });
  });

  it('trusts the new key when an admin saves the source with its password typed again', async () => {
    const before = await nas();
    const { manager, folders, hostKey } = setup();
    const { id } = await added(manager, before);
    const after = await reinstall(before);
    // Saved as it was, the saved password isn't sent to the new key: saving asks for it.
    const unchanged = { name: 'NAS', settings: { path: '/music' } };
    await expect(manager.verify(unchanged, id)).rejects.toThrow(/enter its password again and save it to trust the new key/);
    expect(after.logins).toEqual([]);
    const typed = { name: 'NAS', settings: { path: '/music', password: 'pw' } };
    manager.update(id, typed, await manager.verify(typed, id));
    expect(hostKey(id)).toBe(after.fingerprint);
    await folders.get(id)!.media.check();
    expect(passwordsSent(after)).toEqual(['pw', 'pw']);
  });

  it('trusts the new key on a save when the source logs in with a key file', async () => {
    const t = tempDir();
    onTestFinished(t.cleanup);
    const login = newHostKey(); // any key pair will do to log in with
    const keyFile = join(t.dir, 'id_ed25519');
    writeFileSync(keyFile, login.private);
    const before = await nas({ authorizedKey: login.public });
    const { store, manager, hostKey } = setup();
    const settings = { ...folderOn(before).settings, privateKeyPath: keyFile, hostKey: { type: 'ssh-ed25519', fingerprint: before.fingerprint } };
    const id = store.addSource('folder', 'NAS', settings);
    const after = await reinstall(before, { authorizedKey: login.public });
    const edit = { settings: { path: '/music' } };
    manager.update(id, edit, await manager.verify(edit, id));
    expect(hostKey(id)).toBe(after.fingerprint);
    expect(after.logins.map((l) => l.method)).toContain('publickey');
    expect(passwordsSent(after)).toEqual([]);
  });

  it('keeps using the saved password and key for the same host and port', async () => {
    const s = await nas();
    const { manager, hostKey } = setup();
    const { id } = await added(manager, s);
    const edit = { name: 'Music on the NAS', settings: { path: '/music', user: 'me' } };
    manager.update(id, edit, await manager.verify(edit, id));
    expect(passwordsSent(s)).toEqual(['pw', 'pw']);
    expect(hostKey(id)).toBe(s.fingerprint);
  });

  it('starts over at a new address: the password typed for it, and its own key', async () => {
    const first = await nas();
    const second = await nas();
    const { manager, hostKey } = setup();
    const { id } = await added(manager, first);
    await expect(manager.verify({ settings: { port: second.port } }, id)).rejects.toThrow('Enter the password again for the new address');
    expect(second.connections).toBe(0);
    const moved = { settings: { port: second.port, password: 'pw' } };
    manager.update(id, moved, await manager.verify(moved, id));
    expect(hostKey(id)).toBe(second.fingerprint);
  });
});
