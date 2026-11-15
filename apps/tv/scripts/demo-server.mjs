#!/usr/bin/env node
// A local Playarr for the TV app on an emulator (`make -C apps/tv demo`): the repo's server on port 4620 with empty
// data and a made-up library of short silent songs with covers of their own, claimed by an owner account. The emulator
// reaches it at http://10.0.2.2:4620 (the host's loopback). Runs until stopped.
//
//   node scripts/demo-server.mjs             start it (the library is made the first time, in build/demo-library)
//   node scripts/demo-server.mjs approve ABCD2345   approve a TV's sign-in code as the owner
//
// Nothing here is real music: the albums and artists are invented, the songs three seconds of silence, so it needs no
// ffmpeg and no music on the Mac.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const here = dirname(fileURLToPath(import.meta.url));
const TV = join(here, '..');
const SERVER = join(TV, '../server');
const LIBRARY = join(TV, 'build/demo-library');
const OWNER = join(TV, 'build/demo-owner.json');
const PORT = 4620;
const BASE = `http://127.0.0.1:${PORT}`;

/** Invented albums: artist, title, year, cover colors, songs. */
const ALBUMS = [
  ['The Quiet Hours', 'Lantern Season', 2021, ['#c2410c', '#1c1917'], ['Low Tide', 'Paper Boats', 'Ember']],
  ['Mira Okafor', 'Blue Arithmetic', 2019, ['#1d4ed8', '#0f172a'], ['Counting Rooms', 'Division', 'Remainder']],
  ['Halden Street', 'Night Ferry', 2023, ['#0f766e', '#042f2e'], ['Harbor Lights', 'Crossing', 'Last Call']],
  ['Saffron Wire', 'Copper & Salt', 2018, ['#b45309', '#292524'], ['Patina', 'Salt Flats', 'Wire Song']],
  ['Juniper Vale', 'Small Weather', 2022, ['#4d7c0f', '#1a2e05'], ['Drizzle', 'Front', 'Clearing']],
  ['Oskar Lind', 'Glass Garden', 2020, ['#7e22ce', '#1e1b4b'], ['Greenhouse', 'Shards', 'Bloom']],
  ['Cassette Moons', 'Rewind', 2017, ['#be123c', '#1f1013'], ['Side A', 'Hiss', 'Side B']],
  ['Delta Parade', 'Brass for Strangers', 2024, ['#ca8a04', '#1c1917'], ['Overture', 'Street Corner', 'Encore']],
  ['Noor & the Tide', 'Saltwater Hymns', 2016, ['#0369a1', '#082f49'], ['Undertow', 'Psalm', 'Shoreline']],
  ['Field Recordings Co.', 'Birdsong at Six', 2021, ['#65a30d', '#14532d'], ['Dawn', 'Thrush', 'Morning']],
  ['Velvet Static', 'Late Broadcast', 2015, ['#db2777', '#2e1065'], ['Sign Off', 'Test Card', 'Snow']],
  ['Ada Moreau', 'Rooms Without Doors', 2023, ['#57534e', '#0c0a09'], ['Hallway', 'Window', 'Stair']],
];

const json = (res) => (res.ok ? (res.status === 204 ? null : res.json()) : res.text().then((t) => Promise.reject(new Error(`${res.status} ${t}`))));
const call = (method, path, { token, body } = {}) =>
  fetch(BASE + path, {
    method,
    headers: { 'x-playarr': '1', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then(json);

/** Three seconds of silence: a 44.1 kHz, 16-bit stereo WAV. */
function silence(seconds = 3) {
  const frames = 44100 * seconds;
  const data = frames * 4;
  const wav = Buffer.alloc(44 + data);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + data, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(44100, 24);
  wav.writeUInt32LE(44100 * 4, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(data, 40);
  return wav;
}

const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** The made-up library: Artist/Album (year)/NN Title.wav, with a cover.jpg drawn by sharp. */
async function makeLibrary() {
  if (existsSync(join(LIBRARY, '.done'))) return;
  // sharp is the server's dependency: resolved from there.
  const sharp = createRequire(join(SERVER, 'package.json'))('sharp');
  rmSync(LIBRARY, { recursive: true, force: true });
  const wav = silence();
  for (const [artist, title, year, [from, to], songs] of ALBUMS) {
    const folder = join(LIBRARY, artist, `${title} (${year})`);
    mkdirSync(folder, { recursive: true });
    songs.forEach((song, i) => writeFileSync(join(folder, `${String(i + 1).padStart(2, '0')} ${song}.wav`), wav));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>
      <rect width="600" height="600" fill="url(#g)"/>
      <circle cx="430" cy="190" r="120" fill="#ece6dc" fill-opacity="0.12"/>
      <text x="44" y="500" font-family="Georgia, serif" font-size="54" fill="#ece6dc">${escape(title)}</text>
      <text x="46" y="552" font-family="Helvetica, sans-serif" font-size="26" fill="#ece6dc" fill-opacity="0.7">${escape(artist)}</text>
    </svg>`;
    await sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toFile(join(folder, 'cover.jpg'));
  }
  writeFileSync(join(LIBRARY, '.done'), '');
}

async function start() {
  await makeLibrary();
  const data = mkdtempSync(join(tmpdir(), 'playarr-tv-demo-'));
  // A clean environment: the repo's .env may point at Lidarr or a real music folder.
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(PORT), HOST: '0.0.0.0', DATA_DIR: join(data, 'data'),
    CACHE_DIR: join(data, 'cache'), ANALYSIS: 'off', BONJOUR: 'off', SERVER_NAME: 'Playarr demo', FOLDER_ROOTS: LIBRARY,
  };
  const server = spawn('corepack', ['pnpm', 'exec', 'tsx', '--disable-warning=ExperimentalWarning', 'src/index.ts'], { cwd: SERVER, env, stdio: ['ignore', 'ignore', 'inherit'] });
  const stop = () => {
    server.kill();
    rmSync(data, { recursive: true, force: true });
  };
  process.on('SIGINT', () => (stop(), process.exit(0)));
  process.on('SIGTERM', () => (stop(), process.exit(0)));
  let up = false;
  for (const deadline = Date.now() + 90_000; !up && Date.now() < deadline; await sleep(1000)) {
    if (server.exitCode !== null) break;
    up = !!(await call('GET', '/api/server').catch(() => null));
  }
  if (!up) {
    stop();
    throw new Error(`The server didn't start on ${BASE} (corepack pnpm install, then try again).`);
  }
  const owner = await call('POST', '/api/auth/setup', { body: { username: 'owner', name: 'Owner', password: randomBytes(12).toString('base64url'), device: 'demo', platform: 'script' } });
  await call('POST', '/api/settings/sources', { token: owner.token, body: { kind: 'folder', name: 'Demo', settings: { path: LIBRARY, access: 'local' } } });
  let albums = [];
  for (let stable = 0, deadline = Date.now() + 120_000; stable < 3 && Date.now() < deadline; await sleep(2000)) {
    const now = await call('GET', '/api/albums', { token: owner.token });
    stable = now.length && now.length === albums.length ? stable + 1 : 0;
    albums = now;
  }
  writeFileSync(OWNER, JSON.stringify({ token: owner.token }));
  console.log(`▸ Playarr demo on ${BASE} (the emulator: http://10.0.2.2:${PORT}), ${albums.length} albums. Approve a TV's code with:`);
  console.log(`  node apps/tv/scripts/demo-server.mjs approve CODE`);
  await new Promise(() => {});
}

async function approve(code) {
  const { token } = JSON.parse(readFileSync(OWNER, 'utf8'));
  const info = await call('POST', '/api/auth/device/approve', { token, body: { code } });
  console.log(`Signed in ${info.device} as Owner.`);
}

if (process.argv[2] === 'approve') await approve(process.argv[3] ?? '');
else await start();
