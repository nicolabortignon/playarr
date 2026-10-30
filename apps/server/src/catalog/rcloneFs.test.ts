import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Rclone } from '../media/rclone.ts';
import { RcloneFolderFs } from './folderFs.ts';
import { flacBytes, tempDir } from './testFixtures.ts';

const bin = process.env.RCLONE_BIN ?? 'rclone';
const available = (() => {
  try {
    execFileSync(bin, ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

let cleanup: () => void = () => {};
afterEach(() => cleanup());

describe('RcloneFolderFs', () => {
  it('says rclone is needed when it isn’t installed', async () => {
    await expect(new RcloneFolderFs(new Rclone('/nonexistent/rclone', {}), ':smb:').listAudio('/share')).rejects.toThrow(/need rclone/);
  });
});

describe.skipIf(!available)('RcloneFolderFs (local backend standing in for SMB)', () => {
  function setup() {
    const t = tempDir();
    mkdirSync(join(t.dir, 'share/Massive Attack/Mezzanine'), { recursive: true });
    mkdirSync(join(t.dir, 'share/.trash'), { recursive: true });
    writeFileSync(join(t.dir, 'share/Massive Attack/Mezzanine/01 Angel.flac'), flacBytes({ TITLE: 'Angel', MUSICBRAINZ_TRACKID: 'rec-1' }));
    writeFileSync(join(t.dir, 'share/Massive Attack/Mezzanine/cover.jpg'), Buffer.from([1, 2, 3]));
    writeFileSync(join(t.dir, 'share/.trash/old.flac'), flacBytes({ TITLE: 'Old' }));
    const fs = new RcloneFolderFs(new Rclone(bin, {}), `:local:${t.dir}/`);
    cleanup = () => {
      void fs.close();
      t.cleanup();
    };
    return fs;
  }

  it('lists audio files under a folder, skipping hidden ones', async () => {
    const fs = setup();
    const found = await fs.listAudio('/share');
    expect(found.map((f) => f.path)).toEqual(['/share/Massive Attack/Mezzanine/01 Angel.flac']);
    expect(found[0]).toMatchObject({ rel: 'Massive Attack/Mezzanine/01 Angel.flac' });
    expect(found[0]!.size).toBeGreaterThan(0);
    expect(found[0]!.mtimeMs).toBeGreaterThan(0);
  });

  it('stats and lists folders, with shares at the root', async () => {
    const fs = setup();
    expect(await fs.stat('/')).toMatchObject({ dir: true });
    expect(await fs.stat('/share/Massive Attack')).toMatchObject({ dir: true });
    expect(await fs.stat('/share/Massive Attack/Mezzanine/cover.jpg')).toMatchObject({ dir: false, size: 3 });
    expect(await fs.stat('/share/nope')).toBeNull();
    expect((await fs.readdir('/')).map((e) => e.name)).toContain('share');
    expect(await fs.readdir('/share/Massive Attack/Mezzanine')).toEqual(
      expect.arrayContaining([{ name: 'cover.jpg', dir: false, file: true }, { name: '01 Angel.flac', dir: false, file: true }]),
    );
  });

  it('reads tags through byte ranges and whole small files', async () => {
    const fs = setup();
    const path = '/share/Massive Attack/Mezzanine/01 Angel.flac';
    const size = (await fs.stat(path))!.size;
    expect(await fs.readTags(path, size)).toMatchObject({ title: 'Angel', recordingMbid: 'rec-1' });
    expect(await fs.readFile('/share/Massive Attack/Mezzanine/cover.jpg')).toEqual(Buffer.from([1, 2, 3]));
  });
});
