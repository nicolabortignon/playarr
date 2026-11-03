import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('the Swift mix fixtures are what the TypeScript rules answer today', () => {
  const run = spawnSync(process.execPath, [new URL('./mix-fixtures.mjs', import.meta.url).pathname, '--check'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
});
