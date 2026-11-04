import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exportOptions, marketingVersionIn, reviewerProblems, uploadNeeded, whatsNew, withMarketingVersion } from './release.mjs';

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

test('uploadNeeded uploads a newer build only: one already there, or older than the last, is nothing to do', () => {
  assert.equal(uploadNeeded(519, 518), true);
  assert.equal(uploadNeeded(518, 518), false);
  // A run queued behind a newer build (uploaded from this Mac, or by a later run) skips rather than fails.
  assert.equal(uploadNeeded(515, 518), false);
});

test('marketingVersionIn and withMarketingVersion read and set MARKETING_VERSION only', () => {
  const xcconfig = '// Settings\nMARKETING_VERSION = 1.0.0\nCURRENT_PROJECT_VERSION = 1\n';
  assert.equal(marketingVersionIn(xcconfig), '1.0.0');
  assert.equal(withMarketingVersion(xcconfig, '1.1.0'), '// Settings\nMARKETING_VERSION = 1.1.0\nCURRENT_PROJECT_VERSION = 1\n');
  assert.throws(() => marketingVersionIn('CURRENT_PROJECT_VERSION = 1\n'), /no MARKETING_VERSION/);
});

test('reviewerProblems wants a member with no requests, one source and some albums', () => {
  const server = { setup: false };
  const reviewer = { username: 'reviewer', role: 'member', canRequest: false, sources: [2] };
  assert.deepEqual(reviewerProblems(server, reviewer, [{ id: 1 }]), []);
  assert.deepEqual(reviewerProblems({ setup: true }, { ...reviewer, role: 'admin', canRequest: true, sources: null }, []), [
    'the server is still in setup mode',
    'the demo account is an admin; it must be a member',
    'the demo account may request albums; turn that off in Settings → Accounts',
    'the demo account hears every source; give it only the Creative Commons folder',
    'the demo account sees no albums',
  ]);
});
