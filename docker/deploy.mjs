// Deploy Playarr to the NAS as a standalone Docker service (docker/compose.yaml), from this machine.
//
//   pnpm deploy:nas              ship the last commit, build on the NAS, (re)start, report the URLs
//   pnpm deploy:nas --with-data  also copy this machine's favorites, playlists and song analysis,
//                                if the NAS has none yet (add --force-data to replace them)
//
// Uses the SSH settings in .env (SSH_HOST, SSH_USER, SSH_PASSWORD or SSH_PRIVATE_KEY_PATH); Docker on
// the NAS needs sudo, with NAS_SUDO_PASSWORD (default: SSH_PASSWORD). Secrets are never printed.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = new URL('..', import.meta.url).pathname;
const { Client } = createRequire(join(root, 'apps/server/package.json'))('ssh2');
const env = process.env;
const args = new Set(process.argv.slice(2));

const DIR = env.NAS_DIR || '/volume1/docker/playarr';
const MUSIC_DIR = env.NAS_MUSIC_DIR || '/volume2/data/media/music';
const LIDARR_URL = env.NAS_LIDARR_URL || env.LIDARR_URL;
const SUDO_PASSWORD = env.NAS_SUDO_PASSWORD || env.SSH_PASSWORD;
const COMPOSE = `docker compose --project-directory ${DIR} -f ${DIR}/compose.yaml`;

for (const [name, value] of Object.entries({ NAS_DIR: DIR, NAS_MUSIC_DIR: MUSIC_DIR })) {
  if (!/^\/[\w./-]+$/.test(value)) fail(`${name} must be a plain absolute path, got "${value}"`);
}
if (!env.SSH_HOST || !env.SSH_USER) fail('Set SSH_HOST and SSH_USER in .env');
if (!env.LIDARR_API_KEY || !LIDARR_URL) fail('Set LIDARR_URL (or NAS_LIDARR_URL) and LIDARR_API_KEY in .env');
if (!SUDO_PASSWORD) fail('Docker on the NAS needs sudo: set NAS_SUDO_PASSWORD (or SSH_PASSWORD) in .env');

const git = (...a) => execFileSync('git', a, { cwd: root, maxBuffer: 1 << 30 });
if (git('status', '--porcelain').length) console.warn('! Uncommitted changes are not deployed: this ships the last commit.');
const revision = git('rev-parse', '--short', 'HEAD').toString().trim();

const conn = await connect();
try {
  step(`Shipping ${revision} to ${env.SSH_HOST}:${DIR}`);
  await run(
    `mkdir -p ${DIR}/config ${DIR}/cache ${DIR}/tailscale && rm -rf ${DIR}/src.new && mkdir ${DIR}/src.new` +
      ` && tar -x -C ${DIR}/src.new && echo ${revision} > ${DIR}/src.new/REVISION` +
      ` && rm -rf ${DIR}/src && mv ${DIR}/src.new ${DIR}/src && cp ${DIR}/src/docker/compose.yaml ${DIR}/src/docker/serve.json ${DIR}/`,
    { stdin: git('archive', '--format=tar', 'HEAD') },
  );
  const settings = [
    `LIDARR_URL=${LIDARR_URL}`,
    `LIDARR_API_KEY=${env.LIDARR_API_KEY}`,
    `MUSIC_DIR=${MUSIC_DIR}`,
    ...(env.TS_AUTHKEY ? [`TS_AUTHKEY=${env.TS_AUTHKEY}`] : []),
    ...(env.TS_HOSTNAME ? [`TS_HOSTNAME=${env.TS_HOSTNAME}`] : []),
  ];
  await run(`umask 077 && cat > ${DIR}/.env`, { stdin: `${settings.join('\n')}\n` });

  if (args.has('--with-data') || args.has('--force-data')) await copyData();

  step('Building and starting (the first build takes a few minutes)');
  await run(`${COMPOSE} up -d --build --remove-orphans`, { sudo: true });
  await run(`docker image prune -f --filter label=com.docker.compose.project=playarr > /dev/null`, { sudo: true, quiet: true });

  step('Checking');
  const health = await waitForHealth();
  console.log(`  Lidarr ${health.lidarr?.ok ? 'ok' : 'NOT reachable'} · music ${health.media?.ok ? 'ok' : 'NOT readable'} · ${health.library?.tracks ?? 0} tracks`);
  console.log(`  LAN:       http://${env.SSH_HOST}:4000`);
  await reportTailscale();
} finally {
  conn.end();
}

/** Copy this machine's database (a consistent snapshot, even while the local server runs). */
async function copyData() {
  const local = join(root, 'apps/server', env.DATA_DIR || 'data', 'playarr.db');
  if (!existsSync(local)) return console.log(`  No local database at ${local}; skipping data.`);
  const remote = `${DIR}/config/playarr.db`;
  const exists = (await run(`test -e ${remote} && echo yes || true`, { quiet: true })).trim() === 'yes';
  if (exists && !args.has('--force-data')) return console.log('  The NAS already has its own data; keeping it (use --force-data to replace it).');

  step(exists ? 'Replacing the data on the NAS' : 'Copying favorites, playlists and song analysis');
  const tmp = mkdtempSync(join(tmpdir(), 'playarr-'));
  try {
    const snapshot = join(tmp, 'playarr.db');
    const db = new DatabaseSync(local, { readOnly: true });
    db.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`);
    db.close();
    if (exists) await run(`${COMPOSE} stop playarr`, { sudo: true });
    await run(`cat > ${remote}.new && rm -f ${remote}-wal ${remote}-shm && mv ${remote}.new ${remote}`, { stdin: readFileSync(snapshot) });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function waitForHealth() {
  for (let i = 0; i < 40; i++) {
    const out = await run('wget -q -O - http://127.0.0.1:4000/api/health 2>/dev/null || true', { quiet: true });
    if (out.trim().startsWith('{')) return JSON.parse(out);
    await new Promise((r) => setTimeout(r, 3000));
  }
  fail(`Playarr didn't come up. Logs: ssh to the NAS and run: sudo ${COMPOSE} logs playarr`);
}

async function reportTailscale() {
  for (let i = 0; i < 20; i++) {
    const out = await run('docker exec playarr-tailscale tailscale status --json 2>/dev/null || true', { sudo: true, quiet: true });
    const status = out.trim().startsWith('{') ? JSON.parse(out) : undefined;
    if (status?.BackendState === 'Running') {
      return console.log(`  Tailscale: https://${status.Self.DNSName.replace(/\.$/, '')}  (from any device on your tailnet)`);
    }
    if (status?.BackendState === 'NeedsLogin') {
      const logs = await run('docker logs playarr-tailscale 2>&1 | tail -50', { sudo: true, quiet: true });
      const link = logs.match(/https:\/\/login\.tailscale\.com\/\S+/g)?.at(-1);
      if (link) return console.log(`  Tailscale: open ${link} to add this node to your tailnet, then run this again.`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log(`  Tailscale isn't up yet. Check: sudo docker logs playarr-tailscale`);
}

function connect() {
  return new Promise((resolve, reject) => {
    const c = new Client();
    c.on('ready', () => resolve(c)).on('error', reject);
    c.connect({
      host: env.SSH_HOST,
      port: Number(env.SSH_PORT || 22),
      username: env.SSH_USER,
      ...(env.SSH_PRIVATE_KEY_PATH ? { privateKey: readFileSync(env.SSH_PRIVATE_KEY_PATH) } : { password: env.SSH_PASSWORD }),
    });
  });
}

/** Run a command on the NAS; streams its output unless quiet, and resolves to its stdout. */
function run(command, { stdin, sudo = false, quiet = false } = {}) {
  const full = sudo ? `sudo -S -p '' sh -c '${command.replaceAll("'", `'\\''`)}'` : command;
  return new Promise((resolve, reject) => {
    conn.exec(full, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      let errOut = '';
      stream.on('data', (d) => {
        out += d;
        if (!quiet) process.stdout.write(d);
      });
      stream.stderr.on('data', (d) => {
        errOut += d;
        if (!quiet && !/Could not chdir to home directory/.test(d)) process.stderr.write(d);
      });
      stream.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`"${command.slice(0, 80)}" failed (${code}) ${quiet ? errOut.trim() : ''}`))));
      if (sudo) stream.write(`${SUDO_PASSWORD}\n`);
      if (stdin !== undefined) stream.write(stdin);
      stream.end();
    });
  });
}

function step(message) {
  console.log(`\n▸ ${message}`);
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}
