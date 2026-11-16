// The repo's server for a tour or a check (pnpm web:screens, make -C apps/ios offline-check): a free port, a data
// folder made afresh, only the library's folder, no analysis, Bonjour or Lidarr.
import { closeSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../../apps/server/', import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer().once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

/**
 * Starts the server in `dir` (emptied first) with `library` as the only folder it may read, serving the web app from
 * `dist` when given. Its output goes to `logFile`. Resolves once it answers, with its address and a way to stop it
 * (it stops when this process exits too).
 */
export async function startServer({ library, dir, logFile, dist }) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  // A clean environment: the repo's .env may point at Lidarr or a real music folder.
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: join(dir, 'data'),
    CACHE_DIR: join(dir, 'cache'), ANALYSIS: 'off', BONJOUR: 'off', SERVER_NAME: 'Playarr', FOLDER_ROOTS: library,
    ...(dist ? { WEB_DIST: dist } : {}),
  };
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
