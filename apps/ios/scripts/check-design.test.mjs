import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/** The design check `make build` and `make test` run first (scripts/check-design.mjs, docs/design.md). */
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '../../../scripts/check-design.mjs');
const SOURCES = 'apps/ios/Packages/PlayarrUI/Sources/PlayarrUI';

/** Runs the check for iOS on a scratch tree holding `files` (paths under PlayarrUI's sources): its exit code and output. */
function check(files) {
  const root = mkdtempSync(join(tmpdir(), 'design-check-'));
  try {
    for (const [path, text] of Object.entries(files)) {
      const file = join(root, SOURCES, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
    return { code: 0, out: execFileSync(process.execPath, [SCRIPT, '--app', 'ios', '--root', root], { encoding: 'utf8' }) };
  } catch (err) {
    return { code: err.status, out: err.stdout };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('a page with a literal radius, a fixed system font or a raw color fails, naming the file, the line and the check', () => {
  const { code, out } = check({
    'Pages/Late.swift': 'let a = RoundedRectangle(cornerRadius: 10)\nlet b = Font.system(size: 13)\nlet c = Color(red: 1, green: 0, blue: 0)\n',
  });
  assert.equal(code, 1);
  assert.match(out, /Pages\/Late\.swift:1 {2}literal corner radius/);
  assert.match(out, /Pages\/Late\.swift:2 {2}\.system\(size:\)/);
  assert.match(out, /Pages\/Late\.swift:3 {2}Color\(red:\)/);
  assert.match(out, /Theme\/’s tokens/);
});

test('the tokens pass, and Theme/ may hold the raw values they stand for', () => {
  assert.equal(check({ 'Pages/Late.swift': 'let a = RoundedRectangle(cornerRadius: Radius.panel)\nlet b = Font.icon(.play)\n' }).code, 0);
  assert.equal(check({ 'Theme/Shape.swift': 'let panel = RoundedRectangle(cornerRadius: 12)\n' }).code, 0);
});

test('a raw value passes where the allow-list says why, and only there', () => {
  // The energy chart's bars may be rounded to their own scale; Stats for nerds only its one-point bars.
  assert.equal(check({ 'Transitions/EnergyAroundTheMix.swift': 'context.fill(Path(roundedRect: rect, cornerRadius: 3))\n' }).code, 0);
  assert.equal(check({ 'StatsForNerds/StatsForNerdsOverlay.swift': 'RoundedRectangle(cornerRadius: 1)\n' }).code, 0);
  assert.equal(check({ 'StatsForNerds/StatsForNerdsOverlay.swift': 'RoundedRectangle(cornerRadius: 10)\n' }).code, 1);
});
