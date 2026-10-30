import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkFolder, listFolders } from './paths.ts';
import { flacBytes, tempDir } from './testFixtures.ts';

let cleanup = () => {};
afterEach(() => cleanup());

function tree() {
  const t = tempDir();
  cleanup = t.cleanup;
  mkdirSync(join(t.dir, 'Music/Portishead'), { recursive: true });
  mkdirSync(join(t.dir, 'Music/.cache'));
  mkdirSync(join(t.dir, 'Other'));
  writeFileSync(join(t.dir, 'Music/a.flac'), flacBytes());
  writeFileSync(join(t.dir, 'Music/notes.txt'), 'x');
  return t.dir;
}

describe('checkFolder', () => {
  it('accepts an existing folder inside a root', () => {
    const dir = tree();
    expect(checkFolder(`${dir}/Music/`, [dir])).toBe(`${dir}/Music`);
  });
  it('rejects relative, missing, outside and file paths', () => {
    const dir = tree();
    expect(() => checkFolder('Music', [dir])).toThrow(/absolute/);
    expect(() => checkFolder(`${dir}/Nope`, [dir])).toThrow(/doesn’t exist/);
    expect(() => checkFolder(`${dir}/Other`, [`${dir}/Music`])).toThrow(/outside/);
    expect(() => checkFolder(`${dir}/Music/a.flac`, [dir])).toThrow(/not a folder/);
  });
});

describe('listFolders', () => {
  it('lists the roots when no path is given', async () => {
    expect(await listFolders(undefined, ['/a', '/b'])).toEqual({
      path: null,
      parent: null,
      folders: [
        { name: '/a', path: '/a' },
        { name: '/b', path: '/b' },
      ],
      audioFiles: 0,
    });
  });
  it('lists subfolders and counts audio files, skipping hidden folders', async () => {
    const dir = tree();
    expect(await listFolders(`${dir}/Music`, [dir])).toEqual({
      path: `${dir}/Music`,
      parent: dir,
      folders: [{ name: 'Portishead', path: `${dir}/Music/Portishead` }],
      audioFiles: 1,
    });
  });
  it('goes back to the roots list from a root', async () => {
    const dir = tree();
    expect((await listFolders(dir, [dir])).parent).toBeNull();
  });
  it('flags a root that is missing or empty, as in Docker with nothing mounted', async () => {
    const dir = tree();
    mkdirSync(join(dir, 'empty'));
    expect(await listFolders(`${dir}/empty`, [`${dir}/empty`])).toEqual({ path: `${dir}/empty`, parent: null, folders: [], audioFiles: 0, emptyRoot: true });
    expect(await listFolders(`${dir}/gone`, [`${dir}/gone`])).toEqual({ path: `${dir}/gone`, parent: null, folders: [], audioFiles: 0, emptyRoot: true });
    expect((await listFolders(`${dir}/Other`, [dir, `${dir}/Other`])).emptyRoot).toBe(true);
    expect((await listFolders(dir, [dir])).emptyRoot).toBeUndefined();
  });
  it('refuses folders outside the roots', async () => {
    const dir = tree();
    await expect(listFolders('/etc', [dir])).rejects.toThrow(/outside/);
  });
});
