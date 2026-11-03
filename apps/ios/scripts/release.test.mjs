import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exportOptions, whatsNew } from './release.mjs';

test('whatsNew lists the commit subjects, without merges', () => {
  assert.equal(
    whatsNew(['Show the version on the first screen', "Merge branch 'main' of https://github.com/nicolabortignon/playarr", 'Upload builds to TestFlight']),
    '- Show the version on the first screen\n- Upload builds to TestFlight',
  );
});

test('whatsNew keeps to 25 lines and says how many it left out', () => {
  const notes = whatsNew(Array.from({ length: 30 }, (_, i) => `Change ${i + 1}`));
  assert.equal(notes.split('\n').length, 26);
  assert.ok(notes.endsWith('- Change 25\n…and 5 more'));
});

test('whatsNew stays under App Store Connect’s 4000 characters', () => {
  assert.ok(whatsNew(Array.from({ length: 25 }, () => 'x'.repeat(300))).length <= 4000);
});

test('whatsNew says so when only merges came in', () => {
  assert.equal(whatsNew(["Merge branch 'main'"]), 'No changes since the last build.');
});

test('exportOptions signs for the App Store and writes an .ipa, keeping our build number', () => {
  const plist = exportOptions('TEAM123');
  for (const [key, value] of [['method', 'app-store-connect'], ['destination', 'export'], ['signingStyle', 'automatic'], ['teamID', 'TEAM123']]) {
    assert.ok(plist.includes(`<key>${key}</key><string>${value}</string>`), `${key} = ${value}`);
  }
  assert.ok(plist.includes('<key>manageAppVersionAndBuildNumber</key><false/>'));
});
