// make offline-check: OfflineTests (downloads and songs kept as you listen) on a simulator of its own, against a
// server of its own with the web tour's library of 20 real albums (scripts/web-screens: library.mjs, seed.mjs,
// server.mjs), then the test's screenshots in build/offline-check/. The first run fetches the library from
// MusicBrainz and the Cover Art Archive; it's kept in .cache/web-screens/library, and the server's log in
// .cache/ios-offline/server.log.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALBUMS, buildLibrary } from '../../../scripts/web-screens/library.mjs';
import { seed } from '../../../scripts/web-screens/seed.mjs';
import { startServer } from '../../../scripts/web-screens/server.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const IOS = join(ROOT, 'apps', 'ios');
const CACHE = join(ROOT, '.cache', 'ios-offline');
const RESULT = join(IOS, 'build', 'offline-check.xcresult');
const SHOTS = join(IOS, 'build', 'offline-check');
const SIMULATOR = { name: 'Playarr Offline iPhone', type: 'iPhone 17 Pro' };
/** One album downloaded, one played, each with its artist (both in library.mjs's ALBUMS). */
const CHECKED = [
  ['Air', 'Moon Safari'],
  ['Portishead', 'Dummy'],
];

function simulator({ name, type }) {
  const listed = execFileSync('xcrun', ['simctl', 'list', 'devices', 'available'], { encoding: 'utf8' });
  if (!listed.includes(`    ${name} (`)) execFileSync('xcrun', ['simctl', 'create', name, type], { stdio: 'ignore' });
  return name;
}

async function main() {
  for (const [artist, title] of CHECKED) if (!ALBUMS.some(([a, t]) => a === artist && t === title)) throw new Error(`${title} isn't in the web tour's library`);
  const library = join(ROOT, '.cache', 'web-screens', 'library');
  console.log('▸ The library');
  const missing = await buildLibrary(library);
  for (const [artist, title] of CHECKED) if (missing.includes(`${artist} – ${title}`)) throw new Error(`${title} couldn't be made: MusicBrainz is needed the first time`);

  console.log('▸ Starting the server');
  mkdirSync(CACHE, { recursive: true });
  const server = await startServer({ library, dir: join(CACHE, 'server'), logFile: join(CACHE, 'server.log') });
  let status = 1;
  try {
    const account = await seed(server.base, library);
    console.log(`  ${server.base}: ${account.albums} albums, ${account.songs} songs`);
    rmSync(RESULT, { recursive: true, force: true });
    console.log(`▸ OfflineTests on ${SIMULATOR.name}`);
    const run = spawnSync('make', ['--no-print-directory', `SIMULATOR=${simulator(SIMULATOR)}`, `RESULT=${RESULT}`, 'offline-run'], {
      cwd: IOS,
      stdio: 'inherit',
      env: {
        ...process.env,
        TEST_RUNNER_PLAYARR_UITEST_SERVER: server.base,
        TEST_RUNNER_PLAYARR_UITEST_ADMIN: account.username,
        TEST_RUNNER_PLAYARR_UITEST_PASSWORD: account.password,
        TEST_RUNNER_PLAYARR_UITEST_ALBUMS: CHECKED.map((pair) => pair.join(':')).join('|'),
      },
    });
    status = run.status ?? 1;
  } finally {
    server.stop();
  }
  rmSync(SHOTS, { recursive: true, force: true });
  const exported = spawnSync('xcrun', ['xcresulttool', 'export', 'attachments', '--path', RESULT, '--output-path', SHOTS], { stdio: 'ignore' });
  if (exported.status === 0) console.log(`Screenshots in ${SHOTS}`);
  console.log(status === 0 ? '✓ OfflineTests passed' : '✗ OfflineTests failed');
  process.exitCode = status;
}

process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));
main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
