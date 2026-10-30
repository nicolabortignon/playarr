import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copyCover } from './folderArt.ts';
import { flacBytes, tempDir } from './testFixtures.ts';

let cleanup = () => {};
afterEach(() => cleanup());

describe('copyCover', () => {
  it('uses a cover image next to the file', async () => {
    const t = tempDir();
    cleanup = t.cleanup;
    writeFileSync(join(t.dir, '01.flac'), flacBytes());
    writeFileSync(join(t.dir, 'Folder.JPG'), Buffer.from([0xff, 0xd8, 0xff]));
    expect(await copyCover(join(t.dir, '01.flac'))).toEqual({ body: Buffer.from([0xff, 0xd8, 0xff]), mime: 'image/jpeg' });
  });

  it('prefers cover over folder images', async () => {
    const t = tempDir();
    cleanup = t.cleanup;
    writeFileSync(join(t.dir, '01.flac'), flacBytes());
    writeFileSync(join(t.dir, 'folder.jpg'), Buffer.from([1]));
    writeFileSync(join(t.dir, 'cover.png'), Buffer.from([2]));
    expect(await copyCover(join(t.dir, '01.flac'))).toEqual({ body: Buffer.from([2]), mime: 'image/png' });
  });

  it('returns null when there is no artwork', async () => {
    const t = tempDir();
    cleanup = t.cleanup;
    writeFileSync(join(t.dir, '01.flac'), flacBytes());
    expect(await copyCover(join(t.dir, '01.flac'))).toBeNull();
  });
});
