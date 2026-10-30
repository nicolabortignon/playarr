import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../catalog/testFixtures.ts';
import { Rclone } from './rclone.ts';
import { RcloneMediaSource } from './rcloneServe.ts';

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

describe.skipIf(!available)('RcloneMediaSource (local backend standing in for SMB)', () => {
  function setup() {
    const t = tempDir();
    mkdirSync(join(t.dir, 'share/A'), { recursive: true });
    writeFileSync(join(t.dir, 'share/A/01 it’s.flac'), 'abcdefghijklmnopqrstuvwxyz');
    const media = new RcloneMediaSource(new Rclone(bin, {}), `:local:${t.dir}/`);
    cleanup = () => {
      void media.close();
      t.cleanup();
    };
    return media;
  }

  it('reads whole files and byte ranges over loopback HTTP', async () => {
    const media = setup();
    expect(await text(await media.open('/share/A/01 it’s.flac'))).toBe('abcdefghijklmnopqrstuvwxyz');
    expect(await text(await media.open('/share/A/01 it’s.flac', { start: 2, end: 4 }))).toBe('cde');
    expect((await media.stat('/share/A/01 it’s.flac')).size).toBe(26);
  });

  it('fails clearly for missing files and paths outside a share', async () => {
    const media = setup();
    await expect(media.open('/share/nope.flac')).rejects.toThrow(/404|not found/i);
    await expect(media.open('/')).rejects.toThrow(/share/);
  });

  it('restarts its server after close', async () => {
    const media = setup();
    await media.open('/share/A/01 it’s.flac');
    await media.close();
    expect(await text(await media.open('/share/A/01 it’s.flac', { start: 0, end: 0 }))).toBe('a');
  });
});
