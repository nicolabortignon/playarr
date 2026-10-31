import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Shell } from '../media/ssh.ts';
import { LocalFolderFs, parseFindListing, type FolderFs, parseStat, SftpFolderFs, SshFolderFs } from './folderFs.ts';
import { flacBytes, tempDir } from './testFixtures.ts';

let cleanup = () => {};
afterEach(() => cleanup());

describe('parsers', () => {
  it('reads GNU find listings, skipping non-audio files', () => {
    expect(parseFindListing('/music', '1200\t1700000000.5\tA/B/01.flac\n10\t1700000001\tA/B/cover.jpg\n')).toEqual([
      { rel: 'A/B/01.flac', path: '/music/A/B/01.flac', size: 1200, mtimeMs: 1700000000500 },
    ]);
  });
  it('reads stat output', () => {
    expect(parseStat('123 1700000000 regular file\n')).toEqual({ size: 123, mtimeMs: 1700000000000, dir: false });
    expect(parseStat('4096 1700000000 directory\n')).toEqual({ size: 4096, mtimeMs: 1700000000000, dir: true });
  });
});

describe('LocalFolderFs', () => {
  it('lists, stats and reads files on this server', async () => {
    const t = tempDir();
    cleanup = t.cleanup;
    mkdirSync(join(t.dir, 'A'));
    writeFileSync(join(t.dir, 'A/01.flac'), flacBytes({ TITLE: 'Angel' }));
    writeFileSync(join(t.dir, 'A/cover.jpg'), Buffer.from([1]));
    const fs = new LocalFolderFs();
    expect((await fs.listAudio(t.dir)).map((f) => f.rel)).toEqual(['A/01.flac']);
    // Where the filesystem records birth times (APFS, ext4, btrfs…), the listing carries them.
    const [found] = await fs.listAudio(t.dir);
    if (found!.createdMs !== undefined) expect(Math.abs(found!.createdMs - Date.now())).toBeLessThan(60_000);
    expect((await fs.stat(join(t.dir, 'A')))!.dir).toBe(true);
    expect(await fs.stat(join(t.dir, 'nope'))).toBeNull();
    expect((await fs.readdir(join(t.dir, 'A'))).map((e) => e.name).sort()).toEqual(['01.flac', 'cover.jpg']);
    expect(await fs.readFile(join(t.dir, 'A/cover.jpg'))).toEqual(Buffer.from([1]));
    expect((await fs.readTags(join(t.dir, 'A/01.flac'), 0))!.title).toBe('Angel');
  });
});

function fakeShell(outputs: Record<string, string>): Shell & { commands: string[] } {
  const commands: string[] = [];
  const answer = async (command: string) => {
    commands.push(command);
    const hit = Object.entries(outputs).find(([prefix]) => command.startsWith(prefix));
    if (!hit) throw new Error(`No such file: ${command}`);
    return hit[1];
  };
  return { commands, run: answer, runBuffer: async (c) => Buffer.from(await answer(c)) };
}

describe('SshFolderFs', () => {
  it('lists audio files with one find command, skipping hidden folders', async () => {
    const shell = fakeShell({ find: '1200\t1700000000\tA/01.flac\n' });
    const fs = new SshFolderFs(shell, { kind: 'ssh' } as never, 'fpcalc');
    expect(await fs.listAudio('/music')).toEqual([{ rel: 'A/01.flac', path: '/music/A/01.flac', size: 1200, mtimeMs: 1700000000000 }]);
    expect(shell.commands[0]).toContain("'/music'");
    expect(shell.commands[0]).toContain('-prune');
  });

  it('explains a host without GNU find', async () => {
    const shell: Shell = { run: async () => Promise.reject(new Error('find: unrecognized: -printf')), runBuffer: async () => Buffer.alloc(0) };
    const fs = new SshFolderFs(shell, { kind: 'ssh' } as never, 'fpcalc');
    await expect(fs.listAudio('/music')).rejects.toThrow(/GNU find/);
  });

  it('stats, lists folders and fingerprints over the shell', async () => {
    const shell = fakeShell({
      stat: '4096 1700000000 directory\n',
      'find ': 'd\tAlbums\nf\tnotes.txt\n',
      'nice -n 10 ': '{"duration": 379.5, "fingerprint": "AQAA"}',
    });
    const fs = new SshFolderFs(shell, { kind: 'ssh' } as never, 'fpcalc');
    expect(await fs.stat('/music')).toEqual({ size: 4096, mtimeMs: 1700000000000, dir: true });
    expect(await fs.readdir('/music')).toEqual([
      { name: 'Albums', dir: true, file: false },
      { name: 'notes.txt', dir: false, file: true },
    ]);
    expect(await fs.fingerprint!('/music/a.flac')).toEqual({ duration: 379.5, fingerprint: 'AQAA' });
  });

  it('treats a failed stat as missing', async () => {
    const fs = new SshFolderFs(fakeShell({}), { kind: 'ssh' } as never, 'fpcalc');
    expect(await fs.stat('/nope')).toBeNull();
  });
});

describe('SftpFolderFs', () => {
  const attrs = (dir: boolean, size = 10) => ({ size, mtime: 1700000000, isDirectory: () => dir, isFile: () => !dir });
  const tree: Record<string, { filename: string; attrs: ReturnType<typeof attrs> }[]> = {
    '/music': [
      { filename: 'A', attrs: attrs(true) },
      { filename: '.hidden', attrs: attrs(true) },
    ],
    '/music/A': [
      { filename: '01.flac', attrs: attrs(false, 1200) },
      { filename: 'cover.jpg', attrs: attrs(false) },
    ],
  };
  const session = {
    readdir: (p: string, cb: (err: Error | null, list?: unknown) => void) => (tree[p] ? cb(null, tree[p]) : cb(new Error('No such file'))),
    stat: (p: string, cb: (err: Error | null, s?: unknown) => void) => (tree[p] ? cb(null, attrs(true)) : cb(new Error('No such file'))),
    readFile: (_p: string, cb: (err: Error | null, b?: Buffer) => void) => cb(null, Buffer.from([7])),
  };
  const media = { kind: 'sftp', session: async () => session } as never;

  it('walks folders, skipping hidden ones', async () => {
    const fs = new SftpFolderFs(media);
    expect(await fs.listAudio('/music')).toEqual([{ rel: 'A/01.flac', path: '/music/A/01.flac', size: 1200, mtimeMs: 1700000000000 }]);
    expect((fs as FolderFs).fingerprint).toBeUndefined();
  });

  it('stats, lists and reads', async () => {
    const fs = new SftpFolderFs(media);
    expect((await fs.stat('/music'))!.dir).toBe(true);
    expect(await fs.stat('/nope')).toBeNull();
    expect((await fs.readdir('/music/A')).map((e) => e.name)).toEqual(['01.flac', 'cover.jpg']);
    expect(await fs.readFile('/music/A/cover.jpg')).toEqual(Buffer.from([7]));
  });
});
