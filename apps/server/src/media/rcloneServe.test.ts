import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
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

describe('RcloneMediaSource ffmpeg streams', () => {
  const ENCODE = { codec: 'aac', kbps: 128, skipSamples: 0, leadSamples: 1088, samples: 2000 } as const;

  /** A source whose share is being served (`serve` hands out the file's address), and an ffmpeg that notes it ran. */
  function setup() {
    const t = tempDir();
    cleanup = t.cleanup;
    const ran = join(t.dir, 'ran');
    const ffmpeg = join(t.dir, 'ffmpeg');
    writeFileSync(ffmpeg, `#!/bin/sh\ntouch '${ran}'\nprintf 'adts frames'\n`);
    chmodSync(ffmpeg, 0o755);
    const media = new RcloneMediaSource(new Rclone(bin, {}), ':smb:', { ffmpeg });
    let serve!: (url: string) => void;
    media.urlFor = () => new Promise((resolve) => (serve = resolve));
    return { media, serve: (url: string) => serve(url), ran: () => existsSync(ran) };
  }

  it('hands on what ffmpeg makes of the file, once rclone serves it', async () => {
    const { media, serve, ran } = setup();
    const stream = media.encodedStream('/share/a.flac', ENCODE);
    serve('http://127.0.0.1:1/a.flac');
    expect(await text(stream)).toBe('adts frames');
    expect(ran()).toBe(true);
  });

  it('starts no ffmpeg for a stream closed while rclone was starting', async () => {
    const { media, serve, ran } = setup();
    const stream = media.encodedStream('/share/a.flac', ENCODE);
    stream.destroy();
    await new Promise((resolve) => stream.once('close', resolve));
    serve('http://127.0.0.1:1/a.flac');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(ran()).toBe(false);
  });
});
