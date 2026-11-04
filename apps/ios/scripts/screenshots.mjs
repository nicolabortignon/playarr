// The App Store screenshots, taken by the StoreScreenshots UI test on simulators signed in to a local Playarr
// server that holds only Creative Commons albums, so they come out the same every time and need no network.
//
//   node scripts/screenshots.mjs [iphone-6.9 ipad-13 iphone-6.3]   (all three when none is named)
//
// Run through `make screenshots`. SCREENSHOT_LIBRARY is the folder of Creative Commons albums (default
// ~/Music/Playarr Creative Commons: the same albums as the App Review account's folder on the real server);
// SCREENSHOT_ALBUM is the album to feature (default: the first by artist). For each device it erases a simulator
// of its own ("Playarr Screenshots …"), fixes the status bar at 9:41 with full battery, runs the test, exports
// its screenshots from the result bundle, removes their alpha channel and writes them to
// store/screenshots/<folder>/, replacing what was there.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readScreenshots, SCREENSHOT_SETS, STORE, validateScreenshots } from './store.mjs';

const IOS = fileURLToPath(new URL('..', import.meta.url));
const SERVER = join(IOS, '../server');
const PORT = 4610;
const BASE = `http://localhost:${PORT}`;

/** The status bar's clock: 9:41 on 13 January 2026 in this Mac's time zone, as simctl wants it (ISO 8601). */
export function statusBarTime(at = new Date(2026, 0, 13, 9, 41)) {
  const offset = -at.getTimezoneOffset();
  const pad = (n) => String(Math.abs(n)).padStart(2, '0');
  const zone = `${offset < 0 ? '-' : '+'}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}:00${zone}`;
}

/** `simctl status_bar … override` arguments: Apple's 9:41, full Wi-Fi and signal, a full battery, no carrier. */
export const statusBarArgs = (udid, time = statusBarTime()) => [
  'status_bar', udid, 'override', '--time', time, '--dataNetwork', 'wifi', '--wifiMode', 'active', '--wifiBars', '3',
  '--cellularMode', 'active', '--cellularBars', '4', '--operatorName', '', '--batteryState', 'charged', '--batteryLevel', '100',
];

/** The screenshots in an exported manifest.json: "NN-name" → exported file, the last one when a test ran twice. */
export function pickShots(manifest) {
  const shots = new Map();
  for (const test of manifest) {
    for (const a of [...test.attachments].sort((x, y) => (x.timestamp ?? 0) - (y.timestamp ?? 0))) {
      const name = a.suggestedHumanReadableName.match(/^(\d\d-[a-z0-9-]+)/)?.[1];
      if (name) shots.set(name, a.exportedFileName);
    }
  }
  return [...shots].sort(([a], [b]) => a.localeCompare(b)).map(([name, file]) => ({ name, file }));
}

/**
 * Two weeks of listening for the screenshot account, so Home has Jump back in and mixes: every song of the
 * first `count` albums, one album a day going back from `now`, at 8 pm local time.
 */
export function seedPlays(albums, now, count = 4) {
  const plays = [];
  albums.slice(0, count).forEach((album, day) => {
    const start = new Date(now);
    start.setDate(start.getDate() - day - 1);
    start.setHours(20, 0, 0, 0);
    let at = start.getTime();
    for (const track of album.tracks) {
      const when = new Date(at);
      plays.push({ trackId: track.id, recordingId: track.recordingId, at: when.toISOString(), hour: when.getHours(), weekday: when.getDay(), seconds: Math.round(track.duration), skipped: false });
      at += Math.round(track.duration) * 1000;
    }
  });
  return plays;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const simctl = (...args) => execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8' }).trim();

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'X-Playarr': '1', ...(body && { 'Content-Type': 'application/json' }), ...(token && { Authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  const json = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}${json?.error ? `: ${json.error}` : ''}`);
  return json;
}

/** The repo's server on PORT with empty data, only the library folder, no analysis, Bonjour or Lidarr. */
async function startServer(library) {
  const data = mkdtempSync(join(tmpdir(), 'playarr-shots-data-'));
  // A clean environment: the repo's .env (loaded by make) may point at Lidarr or a real music folder.
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: join(data, 'data'),
    CACHE_DIR: join(data, 'cache'), ANALYSIS: 'off', BONJOUR: 'off', SERVER_NAME: 'Playarr', FOLDER_ROOTS: library,
  };
  const server = spawn('corepack', ['pnpm', 'exec', 'tsx', '--disable-warning=ExperimentalWarning', 'src/index.ts'], { cwd: SERVER, env, stdio: ['ignore', 'ignore', 'inherit'] });
  const stop = () => {
    server.kill();
    rmSync(data, { recursive: true, force: true });
  };
  for (const deadline = Date.now() + 90_000; Date.now() < deadline; await sleep(1000)) {
    if (server.exitCode !== null) break;
    if (await call('GET', '/api/server').catch(() => null)) return stop;
  }
  stop();
  throw new Error(`The local server didn't start on ${BASE} (corepack pnpm install, then try again).`);
}

/** Claim the server, add the folder, wait for its albums, and make the listener account with some history. */
async function seed(library, featured) {
  const owner = await call('POST', '/api/auth/setup', { body: { username: 'owner', name: 'Owner', password: randomBytes(12).toString('base64url'), device: 'screenshots', platform: 'script' } });
  const source = await call('POST', '/api/settings/sources', { token: owner.token, body: { kind: 'folder', name: 'Creative Commons', settings: { path: library, access: 'local' } } });
  let albums = [];
  for (let stable = 0, deadline = Date.now() + 180_000; stable < 3 && Date.now() < deadline; await sleep(2000)) {
    const now = await call('GET', '/api/albums', { token: owner.token });
    stable = now.length && now.length === albums.length ? stable + 1 : 0;
    albums = now;
  }
  if (!albums.length) throw new Error(`No albums in ${library}: it needs tagged audio files (Artist/Album/01 Title.flac also works).`);
  const password = randomBytes(12).toString('base64url');
  const created = await call('POST', '/api/accounts', { token: owner.token, body: { username: 'sam', name: 'Sam', role: 'member', canRequest: false, sources: [source.id] } });
  const listener = await call('POST', '/api/auth/redeem', { body: { code: created.setup.code, password, device: 'screenshots', platform: 'script' } });
  const feature = albums.find((a) => a.title === featured) ?? albums[0];
  const ordered = [feature, ...albums.filter((a) => a.id !== feature.id)];
  const details = [];
  for (const album of ordered.slice(0, 4)) details.push(await call('GET', `/api/albums/${album.id}`, { token: listener.token }));
  await call('POST', '/api/plays', { token: listener.token, body: { plays: seedPlays(details, new Date()) } });
  console.log(`  ${albums.length} albums; featuring "${feature.title}" by ${feature.artistName}`);
  return { username: 'sam', password, album: feature.title };
}

/** A simulator of our own for `folder`, erased and booted, with the status bar fixed. */
function prepareSimulator(folder) {
  const { simulator } = SCREENSHOT_SETS[folder];
  const name = `Playarr Screenshots ${folder}`;
  const { devices } = JSON.parse(simctl('list', 'devices', 'available', '-j'));
  let udid = Object.values(devices).flat().find((d) => d.name === name)?.udid;
  if (udid) {
    try {
      simctl('shutdown', udid);
    } catch {
      // already shut down
    }
    simctl('erase', udid);
  } else {
    udid = simctl('create', name, simulator);
  }
  simctl('boot', udid);
  simctl('bootstatus', udid, '-b');
  simctl('ui', udid, 'appearance', 'dark');
  simctl(...statusBarArgs(udid));
  return udid;
}

function capture(folder, udid, account) {
  const bundle = join(IOS, 'build', 'screenshots', `${folder}.xcresult`);
  rmSync(bundle, { recursive: true, force: true });
  execFileSync('xcodebuild', [
    'test', '-project', 'Playarr.xcodeproj', '-scheme', 'Playarr', '-derivedDataPath', 'build/DerivedData',
    '-IDEPackageSupportDisableManifestSandbox=YES', '-destination', `id=${udid}`, '-only-testing:PlayarrUITests/StoreScreenshots',
    '-resultBundlePath', bundle, '-testLanguage', 'en', '-testRegion', 'US', '-quiet',
    // As the Makefile's XCODEBUILD: the compiler can't sandbox its macro plugins inside Claude's sandbox.
    'OTHER_SWIFT_FLAGS=$(inherited) -Xfrontend -disable-sandbox',
  ], {
    cwd: IOS,
    stdio: 'inherit',
    // xcodebuild hands TEST_RUNNER_X to the UI test as X.
    env: {
      ...process.env, TEST_RUNNER_PLAYARR_SCREENSHOTS: '1', TEST_RUNNER_PLAYARR_SERVER: BASE, TEST_RUNNER_PLAYARR_USERNAME: account.username,
      TEST_RUNNER_PLAYARR_PASSWORD: account.password, TEST_RUNNER_PLAYARR_ALBUM: account.album, TEST_RUNNER_PLAYARR_LANDSCAPE: folder.startsWith('ipad') ? '1' : '0',
    },
  });
  const exported = mkdtempSync(join(tmpdir(), 'playarr-shots-export-'));
  try {
    execFileSync('xcrun', ['xcresulttool', 'export', 'attachments', '--path', bundle, '--output-path', exported], { stdio: 'ignore' });
    const shots = pickShots(JSON.parse(readFileSync(join(exported, 'manifest.json'), 'utf8')));
    if (!shots.length) throw new Error(`The test left no screenshots in ${bundle}.`);
    const out = join(STORE, 'screenshots', folder);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    for (const { name, file } of shots) {
      execFileSync('swift', [join(IOS, 'scripts', 'flatten-png.swift'), join(exported, file), join(out, `${name}.png`)], { stdio: 'inherit' });
    }
    console.log(`  ✓ ${shots.map((s) => s.name).join(', ')}`);
  } finally {
    rmSync(exported, { recursive: true, force: true });
  }
}

async function main(folders) {
  const unknown = folders.filter((f) => !SCREENSHOT_SETS[f]);
  if (unknown.length) throw new Error(`No screenshot set ${unknown.join(', ')}; there are ${Object.keys(SCREENSHOT_SETS).join(', ')}.`);
  const library = process.env.SCREENSHOT_LIBRARY || join(homedir(), 'Music', 'Playarr Creative Commons');
  if (!existsSync(library) || !readdirSync(library).length) {
    throw new Error(`Put the Creative Commons albums in ${library} (or set SCREENSHOT_LIBRARY): see the phase 11 plan, Task 1.`);
  }
  console.log(`▸ Starting a local Playarr server on ${BASE} with ${library}`);
  const stop = await startServer(library);
  try {
    const account = await seed(library, process.env.SCREENSHOT_ALBUM);
    for (const folder of folders) {
      console.log(`\n▸ ${folder} on ${SCREENSHOT_SETS[folder].simulator}`);
      const udid = prepareSimulator(folder);
      try {
        capture(folder, udid, account);
      } finally {
        simctl('status_bar', udid, 'clear');
        simctl('shutdown', udid);
      }
    }
  } finally {
    stop();
  }
  // Only the sets taken now: the others may be taken another time.
  const problems = validateScreenshots(readScreenshots()).filter((p) => folders.some((f) => p.includes(`screenshots/${f}`)));
  if (problems.length) throw new Error(`The screenshots aren't ready:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  console.log('\n✓ Screenshots are in apps/ios/store/screenshots. Look at them before committing.');
}

if (import.meta.main) {
  const folders = process.argv.slice(2);
  await main(folders.length ? folders : Object.keys(SCREENSHOT_SETS)).catch((err) => {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  });
}
