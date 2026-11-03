import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../catalog/testFixtures.ts';
import { FIXTURES_DIR, writeFixture } from './recordFixture.ts';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

const answer = (body: unknown, statusCode = 200) => ({ statusCode, json: () => body });

describe('writeFixture', () => {
  it('saves the answer as pretty JSON, timestamps pinned', () => {
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    writeFixture(dir, 'favorites', answer([{ id: 1, favoritedAt: '2026-10-01T09:30:12.345Z', title: '2026-10-01 is a date, not a timestamp' }]));
    expect(readFileSync(join(dir, 'favorites.json'), 'utf8')).toBe(
      '[\n  {\n    "id": 1,\n    "favoritedAt": "2026-11-03T12:00:00.000Z",\n    "title": "2026-10-01 is a date, not a timestamp"\n  }\n]\n',
    );
  });

  it('tidies what changes on every run', () => {
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    writeFixture(dir, 'auth-sign-in', answer({ token: 'r4nd0m' }), (body) => ({ ...body, token: 'token' }));
    expect(JSON.parse(readFileSync(join(dir, 'auth-sign-in.json'), 'utf8'))).toEqual({ token: 'token' });
  });

  it('refuses an error answer', () => {
    expect(() => writeFixture('/nonexistent', 'album', answer({ error: 'Album not found' }, 404))).toThrow('the route answered 404');
  });

  it('writes into the iOS package', () => {
    expect(FIXTURES_DIR).toMatch(/apps\/ios\/Packages\/PlayarrAPI\/Tests\/PlayarrAPITests\/Fixtures\/$/);
  });
});
