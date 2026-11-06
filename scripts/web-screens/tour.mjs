// pnpm web:screens: screenshots of every page of the web app in Safari on an iPhone and an iPad simulator, the web's
// ios:screens. It builds the web app, starts the repo's server on a free port with an empty data folder and a
// generated library of 20 real albums (library.mjs), claims and seeds it (seed.mjs), walks the steps in steps.json
// on each simulator (walk.mjs) and stops the server. Screens land in screenshots/web/<device>/, replaced each run.
//
//   node scripts/web-screens/tour.mjs [phone] [tablet] [--shots album,queue] [--no-build]
//
// phone is the iPhone 17 Pro (the phone layout); tablet the iPad Pro 13-inch upright, 1032 px wide (the desktop
// layout). Both when none is named, or as SCREENS="phone" says, like the iOS Makefile's. --shots (or SHOTS=) takes
// only those shots, where "album" also takes "album-2", "album-playing"…, and walks only the pages they need; the
// other screens stay as they were. --no-build (or NO_BUILD=1) serves the last build. Needs Xcode's simulators. The
// first run fetches the library from MusicBrainz and the Cover Art Archive; it's kept in .cache/web-screens/, with
// the build and the server's log.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALBUMS, buildLibrary } from './library.mjs';
import { seed } from './seed.mjs';
import { checkSteps, walk, wanted } from './walk.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WEB = join(ROOT, 'apps', 'web');
const SERVER = join(ROOT, 'apps', 'server');
const CACHE = join(ROOT, '.cache', 'web-screens');
const OUT = join(ROOT, 'screenshots', 'web');

// Simulators of their own, so the tour never disturbs one in use (made when missing).
const DEVICES = {
  phone: { simulator: 'Playarr Web iPhone', type: 'iPhone 17 Pro' },
  tablet: { simulator: 'Playarr Web iPad', type: 'iPad Pro 13-inch (M5)' },
};
const USAGE = 'Usage: pnpm web:screens [phone] [tablet] [--shots name,…] [--no-build]';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shown = (path) => relative(ROOT, path);

function options(args, env) {
  const list = (s) => (s ?? '').split(/[\s,]+/).filter(Boolean);
  const devices = [];
  let shots = list(env.SHOTS);
  let build = !env.NO_BUILD || env.NO_BUILD === '0';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--no-build') build = false;
    else if (arg === '--shots') shots = list(args[++i]);
    else if (arg.startsWith('--shots=')) shots = list(arg.slice('--shots='.length));
    else if (DEVICES[arg]) devices.push(arg);
    else throw new Error(`Unknown argument “${arg}”. ${USAGE}`);
  }
  if (!devices.length) devices.push(...(list(env.SCREENS).length ? list(env.SCREENS) : Object.keys(DEVICES)));
  const unknown = devices.filter((d) => !DEVICES[d]);
  if (unknown.length) throw new Error(`No device ${unknown.join(', ')}: there are ${Object.keys(DEVICES).join(' and ')}`);
  return { devices: [...new Set(devices)], only: shots.length ? shots : undefined, build };
}

/** Build the web app into `dist` with Vite (no type check: a type error elsewhere shouldn't stop the screens). */
function buildWeb(dist) {
  const pkg = createRequire(join(WEB, 'package.json')).resolve('vite/package.json');
  const vite = join(dirname(pkg), JSON.parse(readFileSync(pkg, 'utf8')).bin.vite);
  execFileSync(process.execPath, [vite, 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'warn'], { cwd: WEB, stdio: 'inherit' });
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer().once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

/**
 * The repo's server on a free port, serving `dist`: a data folder made afresh, only the library's folder, no
 * analysis, Bonjour or Lidarr. Its output goes to .cache/web-screens/server.log.
 */
async function startServer(library, dist) {
  const dir = join(CACHE, 'server');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  // A clean environment: the repo's .env may point at Lidarr or a real music folder.
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: join(dir, 'data'),
    CACHE_DIR: join(dir, 'cache'), ANALYSIS: 'off', BONJOUR: 'off', SERVER_NAME: 'Playarr', FOLDER_ROOTS: library, WEB_DIST: dist,
  };
  const logFile = join(CACHE, 'server.log');
  const log = openSync(logFile, 'w');
  const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'src/index.ts'], { cwd: SERVER, env, stdio: ['ignore', log, log] });
  closeSync(log);
  const stop = () => server.exitCode === null && server.signalCode === null && server.kill();
  process.on('exit', stop);
  for (const deadline = Date.now() + 90_000; Date.now() < deadline && server.exitCode === null; await sleep(500)) {
    if (await fetch(`${base}/api/server`).then((res) => res.ok, () => false)) return { base, stop };
  }
  stop();
  const tail = readFileSync(logFile, 'utf8').trim().split('\n').slice(-15).join('\n');
  throw new Error(`The server didn't start on ${base} (corepack pnpm install, then try again). Its last words:\n${tail}`);
}

async function main() {
  const started = Date.now();
  const { devices, only, build } = options(process.argv.slice(2), process.env);
  const steps = JSON.parse(readFileSync(new URL('steps.json', import.meta.url), 'utf8'));
  const shotsOf = Object.fromEntries(devices.map((key) => [key, checkSteps(steps[key] ?? [], key)]));
  // With --shots, only the devices that have one of them.
  const walks = devices.filter((key) => shotsOf[key].some((name) => wanted(name, only)));
  if (!walks.length) {
    throw new Error(`No shot is called ${only.join(' or ')}. There are:\n${devices.map((key) => `  ${key}: ${shotsOf[key].join(', ')}`).join('\n')}`);
  }

  const dist = join(CACHE, 'web');
  if (build || !existsSync(join(dist, 'index.html'))) {
    console.log('▸ Building the web app');
    buildWeb(dist);
  }
  const library = join(CACHE, 'library');
  console.log(`▸ The library: ${ALBUMS.length} albums in ${shown(library)}`);
  const missing = await buildLibrary(library);
  if (missing.length === ALBUMS.length) throw new Error('No albums to play: MusicBrainz and the Cover Art Archive are needed the first time.');

  console.log('▸ Starting the server');
  const server = await startServer(library, dist);
  const failures = [];
  const done = [];
  try {
    const account = await seed(server.base, library);
    console.log(`  ${server.base}: ${account.albums} albums, ${account.songs} songs, seeded`);
    for (const key of walks) {
      const out = join(OUT, key);
      console.log(`▸ ${key}`);
      try {
        const { shots, failed } = await walk({ device: DEVICES[key], base: server.base, account, steps: steps[key], out, only });
        done.push(`${shots} screen${shots === 1 ? '' : 's'} in ${shown(out)}`);
        failures.push(...failed.map((f) => `${key}: ${f}`));
      } catch (err) {
        failures.push(`${key}: ${err.message}`);
      }
    }
  } finally {
    server.stop();
  }

  const took = Math.round((Date.now() - started) / 1000);
  for (const line of done) console.log(`✓ ${line}`);
  if (failures.length) console.log(`✗ Steps that didn't work:\n${failures.map((f) => `  ${f}`).join('\n')}`);
  console.log(`Took ${Math.floor(took / 60)} min ${took % 60} s.${missing.length ? ` Missing albums: ${missing.join(', ')}.` : ''}`);
  if (failures.length || missing.length) process.exitCode = 1;
}

// Stopping the tour stops its server too (through the exit handler).
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
