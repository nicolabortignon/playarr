import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { tempDir } from '../catalog/testFixtures.ts';

/**
 * docker/update.sh and docker/updater.sh, run for real by every POSIX shell found here (sh, dash, and busybox's sh with
 * busybox's own tools, as in the updater's Alpine image, when busybox is installed), on a deploy folder in a temporary
 * directory. curl, wget, docker, tar and sleep are stubs that log their calls and answer from files; jq is the real
 * one (the updater's tests need it). Nothing reaches GitHub or Docker: the scripts see only the stubs and a few tools.
 */

const DOCKER_DIR = fileURLToPath(new URL('../../../../docker/', import.meta.url));
const REPO = 'test/playarr';
const API = `https://api.github.com/repos/${REPO}`;
const HEALTH_URL = 'http://playarr.test/api/health';
const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const RELEASED = 'c'.repeat(40);
const checksOf = (sha: string) => `${API}/commits/${sha}/check-runs?check_name=Server%20and%20web`;
const tarballOf = (sha: string) => `https://codeload.github.com/${REPO}/tar.gz/${sha}`;

/** Playarr answering with its database working, while Lidarr is down (so `ok` is false). */
const HEALTHY =
  '{"ok":false,"lidarr":{"ok":false,"error":"connect ECONNREFUSED"},"media":{"source":"local","ok":true},"requests":false,"database":{"ok":true}}';
/** Answering, but with a database that doesn't. */
const NO_DATABASE = '{"ok":true,"media":{"source":"local","ok":true},"requests":false,"database":{"ok":false,"error":"disk I/O error"}}';
/** A version from before the database field. */
const OLD_HEALTHY = '{"ok":true,"lidarr":{"ok":true,"version":"2.9"},"media":{"source":"local","ok":true},"requests":true}';

/** A check run as GitHub's API returns it (pretty-printed, with "status" also among the app's events). */
function checkRun(status: string, conclusion: string | null) {
  return {
    id: 128403538400,
    name: 'Server and web',
    head_sha: NEW,
    status,
    conclusion,
    started_at: '2026-11-07T12:27:37Z',
    completed_at: status === 'completed' ? '2026-11-07T12:35:40Z' : null,
    // Text with the keys in it, escaped as JSON strings are: never read as the run's own.
    output: { title: conclusion === 'failure' ? 'Tests failed' : null, summary: 'Not "status": "completed", nor "conclusion": "success"', text: null },
    check_suite: { id: 114800056535 },
    app: { id: 15368, slug: 'github-actions', name: 'GitHub Actions', events: ['check_run', 'status', 'push'] },
    pull_requests: [],
  };
}
const checkRuns = (...runs: ReturnType<typeof checkRun>[]) => JSON.stringify({ total_count: runs.length, check_runs: runs }, null, 2);
const release = (tag: string) =>
  JSON.stringify({ id: 1, tag_name: tag, name: `Playarr ${tag}`, body: 'Notes, with "tag_name": "evil" in them', draft: false, prerelease: false, assets: [] }, null, 2);

// ── The stubs ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Sourced by curl and wget: the next answer to a URL (the last one again once they run out), from $STUB/http. */
const RESPOND = `
# respond URL: sets code (000: nothing answered) and body, the file holding the answer. Builtins where it can: health
# is asked many times.
respond() {
  if [ "$1" = "$PLAYARR_HEALTH_URL" ]; then
    running=false
    [ ! -f "$STUB/docker/running" ] || read -r running < "$STUB/docker/running"
    if [ "$running" != true ]; then code=000; return 0; fi
    read -r image < "$STUB/docker/container"
    key="health-$image"
  else
    key="$(printf '%s' "$1" | sed 's#^[a-z]*://##; s#[^A-Za-z0-9._-]#_#g')"
  fi
  n=0
  [ ! -f "$STUB/count.$key" ] || read -r n < "$STUB/count.$key"
  n=$((n + 1))
  echo "$n" > "$STUB/count.$key"
  if [ ! -d "$STUB/http/$key" ]; then echo "UNEXPECTED $1" >> "$STUB/calls"; code=000; return 0; fi
  read -r last < "$STUB/http/$key/last"
  [ "$n" -le "$last" ] || n="$last"
  read -r code < "$STUB/http/$key/$n.code"
  body="$STUB/http/$key/$n.body"
}
`;

const CURL = `#!/bin/sh
. "$STUB/respond"
out=""; fmt=""; url=""; fail=0
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    -w) fmt="$2"; shift ;;
    -H) echo "curl header $2" >> "$STUB/calls"; shift ;;
    -m | --connect-timeout) shift ;;
    --*) ;;
    -*) case "$1" in *f*) fail=1 ;; esac ;;
    *) url="$1" ;;
  esac
  shift
done
echo "curl $url" >> "$STUB/calls"
respond "$url"
if [ "$code" = 000 ]; then [ -z "$fmt" ] || printf 000; exit 7; fi
if [ "$fail" = 1 ] && [ "$code" -ge 400 ]; then exit 22; fi
if [ -n "$out" ]; then cat "$body" > "$out"; else cat "$body"; fi
[ -z "$fmt" ] || printf '%s' "$code"
`;

const WGET = `#!/bin/sh
. "$STUB/respond"
out=-; url=""; headers=0
while [ $# -gt 0 ]; do
  case "$1" in
    -O) out="$2"; shift ;;
    -T) shift ;;
    -S) headers=1 ;;
    -q | --header=*) ;;
    *) url="$1" ;;
  esac
  shift
done
echo "wget $url" >> "$STUB/calls"
respond "$url"
if [ "$code" = 000 ]; then echo "wget: can't connect to remote host" >&2; exit 1; fi
[ "$headers" = 0 ] || echo "  HTTP/1.1 $code Answer" >&2
if [ "$code" -ge 400 ]; then [ "$out" = - ] || : > "$out"; echo "wget: server returned error: HTTP/1.1 $code" >&2; exit 1; fi
if [ "$out" = - ]; then cat "$body"; else cat "$body" > "$out"; fi
`;

/** One container, playarr, and image tags, in $STUB/docker. A build makes the image in next-image; on-up runs then. */
const DOCKER = `#!/bin/sh
d="$STUB/docker"
echo "docker $*" >> "$STUB/calls"
case "$1" in
  info | image | run) ;;
  container)
    [ -f "$d/container" ] || { echo "Error: No such container: playarr" >&2; exit 1; }
    case "$4" in
      '{{.Image}}') cat "$d/container" ;;
      *) echo "$(cat "$d/container") $(cat "$d/running")" ;;
    esac
    ;;
  tag)
    if [ -f "$d/tags/$2" ]; then cp "$d/tags/$2" "$d/tags/$3"; else echo "$2" > "$d/tags/$3"; fi
    ;;
  logs) echo "Playarr on $(cat "$d/container"): could not start" ;;
  stop) echo false > "$d/running" ;;
  compose)
    case "$2" in
      stop) echo false > "$d/running" ;;
      up)
        case " $* " in
          *" --build "*)
            if [ -f "$d/build-fails" ]; then echo "failed to solve: exit code 1" >&2; exit 1; fi
            cp "$d/next-image" "$d/tags/playarr:latest"
            if [ -f "$d/start-fails" ]; then rm -f "$d/container"; echo false > "$d/running"; exit 1; fi
            cp "$d/tags/playarr:latest" "$d/container"; echo true > "$d/running"
            if [ -f "$d/on-up" ]; then sh "$d/on-up"; fi
            ;;
          *) cp "$d/tags/playarr:latest" "$d/container"; echo true > "$d/running" ;;
        esac
        ;;
    esac
    ;;
esac
exit 0
`;

/** "Extracts" $STUB/source into the folder after -C. */
const TAR = `#!/bin/sh
echo "tar $*" >> "$STUB/calls"
dest=""
while [ $# -gt 0 ]; do
  if [ "$1" = -C ]; then dest="$2"; shift; fi
  shift
done
[ -d "$STUB/source" ] && [ -n "$dest" ] || exit 2
cp -R "$STUB/source/." "$dest/"
`;

/** Stands in for update.sh in the updater's own tests: says what it was given, prints and answers as told. */
const FAKE_UPDATE = `#!/bin/sh
echo "$*" >> "$STUB/update-args"
if [ -f "$STUB/update-out" ]; then cat "$STUB/update-out"; fi
exit "$(cat "$STUB/update-exit" 2>/dev/null || echo 0)"
`;

// ── Shells and tools ────────────────────────────────────────────────────────────────────────────────────────────────

function which(name: string): string | undefined {
  const found = spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
  return found.startsWith('/') ? found : undefined;
}

/** What the scripts and the stubs run besides the shell's builtins. */
const TOOLS = ['basename', 'cat', 'chmod', 'chown', 'cp', 'cut', 'date', 'dd', 'dirname', 'grep', 'head', 'id', 'ls', 'mkdir', 'mv', 'rm', 'sed', 'sort', 'stat', 'tail', 'tr'];

type Shell = { name: string; path: string; busybox?: boolean };
/** Each tool's own path, looked up once. */
const TOOL_PATHS = new Map(TOOLS.map((name) => [name, which(name)]));
const sh = which('sh')!;
const dash = which('dash');
const busybox = which('busybox');
/** The tools this busybox has (a distribution's build may leave some out: the system's stand in for those). */
const APPLETS = new Set(busybox ? spawnSync(busybox, ['--list'], { encoding: 'utf8' }).stdout.split('\n') : []);
const SHELLS: Shell[] = [
  { name: 'sh', path: sh },
  ...(dash && realpathSync(dash) !== realpathSync(sh) ? [{ name: 'dash', path: dash }] : []),
  ...(busybox && APPLETS.has('sh') ? [{ name: 'busybox sh', path: busybox, busybox: true }] : []),
];
const JQ = which('jq');

// ── A deploy folder ─────────────────────────────────────────────────────────────────────────────────────────────────

// One folder for them all, so tests can run side by side.
const scratch = tempDir();
afterAll(scratch.cleanup);

type Answer = [status: number, body: string];
const keyOf = (url: string) => url.replace(/^[a-z]*:\/\//, '').replace(/[^A-Za-z0-9._-]/g, '_');

/**
 * A NAS as the update.sh before channels left it: on OLD (Playarr 0.6.9, image img-old, healthy), its settings saved
 * before there were channels (so edge), main at NEW (0.7.0, which builds img-new), and nothing kept to go back to.
 * `fresh`: a new machine instead, with nothing installed and no settings.
 */
function nas(shell: Shell, { fresh = false, curl = true } = {}) {
  const root = mkdtempSync(join(scratch.dir, 'nas-'));
  const deploy = join(root, 'playarr');
  const stub = join(root, 'stub');
  const bin = join(root, 'bin');
  const tools = join(root, 'tools');
  const put = (path: string, content: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  const script = (path: string, content: string) => {
    put(path, content);
    chmodSync(path, 0o755);
  };

  mkdirSync(tools);
  for (const name of TOOLS) symlinkSync(shell.busybox && APPLETS.has(name) ? shell.path : TOOL_PATHS.get(name)!, join(tools, name));
  symlinkSync(shell.path, join(tools, 'sh'));
  if (JQ) symlinkSync(JQ, join(tools, 'jq'));
  put(join(stub, 'respond'), RESPOND);
  if (curl) script(join(bin, 'curl'), CURL);
  else script(join(bin, 'wget'), WGET);
  script(join(bin, 'docker'), DOCKER);
  script(join(bin, 'tar'), TAR);
  script(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
  put(join(stub, 'calls'), '');

  const update = readFileSync(join(DOCKER_DIR, 'update.sh'), 'utf8');
  put(join(deploy, 'update.sh'), update);
  // The commit the next update downloads.
  put(join(stub, 'source/package.json'), '{\n  "name": "playarr",\n  "version": "0.7.0",\n  "private": true\n}\n');
  put(join(stub, 'source/docker/Dockerfile'), 'FROM node:24-alpine\n');
  put(join(stub, 'source/docker/compose.yaml'), 'new compose\n');
  put(join(stub, 'source/docker/update.sh'), update);
  put(join(stub, 'docker/next-image'), 'img-new\n');
  mkdirSync(join(stub, 'docker/tags'), { recursive: true });
  mkdirSync(join(deploy, 'update'), { recursive: true });

  const w = {
    root,
    deploy,
    stub,
    /** The next answers to URL, in order (the last one repeats). */
    answer: (url: string, ...answers: Answer[]) => answer(keyOf(url), answers),
    /** What /api/health answers while the container runs `image`. */
    health: (image: string, ...answers: Answer[]) => answer(`health-${image}`, answers),
    put: (path: string, content: string) => put(join(deploy, path), content),
    read: (path: string) => (existsSync(join(deploy, path)) ? readFileSync(join(deploy, path), 'utf8') : undefined),
    has: (path: string) => existsSync(join(deploy, path)),
    docker: (name: string, content: string) => put(join(stub, 'docker', name), content),
    container: () => [readFileSync(join(stub, 'docker/container'), 'utf8').trim(), readFileSync(join(stub, 'docker/running'), 'utf8').trim()],
    calls: () => readFileSync(join(stub, 'calls'), 'utf8').split('\n').filter((line) => line && !line.startsWith('curl header')),
    /** The calls to GitHub's API, as paths after the repository. */
    github: () =>
      w
        .calls()
        .filter((line) => line.includes('api.github.com'))
        .map((line) => line.replace(/^(curl|wget) https:\/\/api\.github\.com\/repos\/test\/playarr/, '')),
    compose: () => w.calls().filter((line) => line.startsWith('docker compose ')),
    /** The deploy folder's update.sh, as by hand (or as the updater runs it, with PLAYARR_UPDATER=1). */
    update(args: string[] = [], env: Record<string, string> = {}) {
      return run(join(deploy, 'update.sh'), args, env);
    },
    /** One round of docker/updater.sh (the container's copy, running the deploy folder's update.sh). */
    updater(env: Record<string, string> = {}) {
      return run(join(DOCKER_DIR, 'updater.sh'), [], { PLAYARR_DIR: deploy, UPDATER_ONCE: '1', UPDATER_SLEEP: '0', ...env });
    },
    /** update.sh replaced by one that answers `exit`, for the updater's own tests. */
    fakeUpdate(exit: number, output = '') {
      script(join(deploy, 'update.sh'), FAKE_UPDATE);
      put(join(stub, 'update-exit'), String(exit));
      put(join(stub, 'update-out'), output);
    },
    updateArgs: () => (existsSync(join(stub, 'update-args')) ? readFileSync(join(stub, 'update-args'), 'utf8').trim().split('\n') : []),
    status: () => JSON.parse(readFileSync(join(deploy, 'update/status.json'), 'utf8')) as Record<string, unknown>,
  };

  function answer(key: string, answers: Answer[]) {
    const folder = join(stub, 'http', key);
    rmSync(folder, { recursive: true, force: true });
    answers.forEach(([status, body], i) => {
      put(join(folder, `${i + 1}.code`), `${status}\n`);
      put(join(folder, `${i + 1}.body`), body);
    });
    put(join(folder, 'last'), `${answers.length}\n`);
  }

  function run(file: string, args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string; err: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(join(tools, 'sh'), [file, ...args], {
        cwd: root,
        // Five tries to come up rather than a hundred.
        env: { PATH: `${bin}:${tools}`, HOME: root, STUB: stub, PLAYARR_REPO: REPO, PLAYARR_HEALTH_URL: HEALTH_URL, PLAYARR_HEALTH_WAIT: '15', ...env },
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, out, err }));
    });
  }

  w.answer(tarballOf(NEW), [200, 'a tarball']);
  w.answer(tarballOf(RELEASED), [200, 'a tarball']);
  if (!fresh) {
    w.put('.env', `LIDARR_URL=http://lidarr:8686\nPLAYARR_DIR=${deploy}\n`);
    w.put('DEPLOYED', `${OLD}\n`);
    w.put('LATEST', `${OLD}\n`);
    w.put('compose.yaml', 'old compose\n');
    w.put('src/REVISION', `${OLD}\n`);
    w.put('src/package.json', '{\n  "name": "playarr",\n  "version": "0.6.9"\n}\n');
    w.put('src/docker/compose.yaml', 'old compose\n');
    w.put('config/playarr.db', 'the live database\n');
    w.put('update/settings.json', '{"enabled":true,"intervalMinutes":15}\n');
    w.put('update/status.json', JSON.stringify({ state: 'idle', heartbeat: 1_800_000_000, lastCheck: 1_800_000_000, lastUpdate: 1_799_000_000, deployed: OLD, latest: OLD }));
    w.docker('container', 'img-old\n');
    w.docker('running', 'true\n');
    w.docker('tags/playarr:latest', 'img-old\n');
    w.health('img-old', [200, HEALTHY]);
  }
  w.answer(`${API}/commits/main`, [200, NEW]);
  return w;
}

type Nas = ReturnType<typeof nas>;

/** The new version migrates the database when it starts, from schema 3, copying it first as the server does. */
function migratesOnStart(w: Nas) {
  w.docker(
    'on-up',
    [
      `cd '${w.deploy}/config'`,
      'mkdir -p backups',
      'cp playarr.db backups/playarr-0.7.0-schema-3.db',
      'echo migrated > playarr.db',
      'echo "the new version\'s log" > playarr.db-wal',
      'echo index > playarr.db-shm',
      '',
    ].join('\n'),
  );
}

const green = (): Answer => [200, checkRuns(checkRun('completed', 'success'))];

for (const shell of SHELLS) {
  describe(`update.sh, run by ${shell.name}`, { concurrent: true, timeout: 120_000 }, () => {
    it('installs the newest commit on main once its checks pass, keeping the running image as playarr:previous', async () => {
      const w = nas(shell);
      w.answer(checksOf(NEW), green());
      w.health('img-new', [200, HEALTHY]);
      const res = await w.update(['--quiet']);
      expect(res.err).toBe('');
      expect(res.code).toBe(0);
      expect(res.out).toContain('Playarr bbbbbbb is up on port 4000');
      expect(w.github()).toEqual(['/commits/main', `/commits/${NEW}/check-runs?check_name=Server%20and%20web`]);
      const calls = w.calls();
      expect(calls).toContain('docker tag img-old playarr:previous');
      expect(calls.indexOf('docker tag img-old playarr:previous')).toBeLessThan(calls.indexOf('docker compose up -d --build --remove-orphans'));
      expect(w.compose()).toEqual(['docker compose up -d --build --remove-orphans']);
      expect(w.container()).toEqual(['img-new', 'true']);
      expect([w.read('DEPLOYED'), w.read('LATEST'), w.read('src/REVISION')]).toEqual([`${NEW}\n`, `${NEW}\n`, `${NEW}\n`]);
      expect(w.read('compose.yaml')).toBe('new compose\n');
      expect(['src.previous', 'compose.yaml.previous', 'RELEASE', 'ROLLED_BACK', '.update.lock'].filter(w.has)).toEqual([]);
      expect(w.read('config/playarr.db')).toBe('the live database\n');
    });

    it('from the updater, brings Caddy up too while the https profile is on, reading it as compose does', async () => {
      // .env's last COMPOSE_PROFILES line, quotes, spaces and a comment dropped; the environment's over it, even empty.
      const cases: [env: string, profiles: string | undefined, services: string][] = [
        ['', undefined, 'playarr'],
        ['COMPOSE_PROFILES=https\n', undefined, 'playarr playarr-caddy'],
        ['COMPOSE_PROFILES="https,tools" # HTTPS\n', undefined, 'playarr playarr-caddy'],
        ['  COMPOSE_PROFILES = https\n', undefined, 'playarr playarr-caddy'],
        ['COMPOSE_PROFILES=https\nCOMPOSE_PROFILES=\n', undefined, 'playarr'],
        ['COMPOSE_PROFILES=httpsish\n', undefined, 'playarr'],
        ['', 'https', 'playarr playarr-caddy'],
        ['COMPOSE_PROFILES=https\n', '', 'playarr'],
      ];
      await Promise.all(
        cases.map(async ([env, profiles, services]) => {
          const w = nas(shell);
          w.put('.env', `LIDARR_URL=http://lidarr:8686\nPLAYARR_DIR=${w.deploy}\n${env}`);
          w.answer(checksOf(NEW), green());
          w.health('img-new', [200, HEALTHY]);
          const res = await w.update(['--quiet'], { PLAYARR_UPDATER: '1', ...(profiles === undefined ? {} : { COMPOSE_PROFILES: profiles }) });
          expect(res.code, `${env} ${profiles}`).toBe(0);
          expect(w.compose(), `${env} ${profiles}`).toEqual([`docker compose up -d --build --no-deps --remove-orphans ${services}`]);
        }),
      );
    });

    it('by hand, starts everything the profiles turn on, naming nothing', async () => {
      const w = nas(shell);
      w.put('.env', `LIDARR_URL=http://lidarr:8686\nPLAYARR_DIR=${w.deploy}\nCOMPOSE_PROFILES=https\n`);
      w.answer(checksOf(NEW), green());
      w.health('img-new', [200, HEALTHY]);
      expect((await w.update(['--quiet'])).code).toBe(0);
      expect(w.compose()).toEqual(['docker compose up -d --build --remove-orphans']);
    });

    it('stays on the running version while the checks are pending, and installs once they pass', async () => {
      const w = nas(shell);
      w.answer(checksOf(NEW), [200, checkRuns()], [200, checkRuns(checkRun('in_progress', null))], green());
      w.health('img-new', [200, HEALTHY]);
      for (let i = 0; i < 2; i++) {
        const res = await w.update(['--quiet'], { PLAYARR_UPDATER: '1' });
        expect(res.code).toBe(3);
        expect(res.out).toBe('bbbbbbb is waiting for its checks on GitHub, so Playarr stays on aaaaaaa until they pass.\n');
        expect(res.err).toBe('');
      }
      expect(w.calls().filter((line) => line.includes('codeload') || line.startsWith('docker compose') || line.startsWith('tar'))).toEqual([]);
      expect([w.read('DEPLOYED'), w.read('LATEST')]).toEqual([`${OLD}\n`, `${NEW}\n`]);
      expect((await w.update(['--quiet'], { PLAYARR_UPDATER: '1' })).code).toBe(0);
      expect(w.compose()).toEqual(['docker compose up -d --build --no-deps --remove-orphans playarr']);
      expect(w.read('DEPLOYED')).toBe(`${NEW}\n`);
    });

    it('stays when the checks failed, saying which commit', async () => {
      const failures = [
        [checkRun('completed', 'failure')],
        [checkRun('completed', 'success'), checkRun('completed', 'cancelled')],
        [checkRun('completed', 'skipped')],
      ];
      await Promise.all(
        failures.map(async (runs) => {
          const w = nas(shell);
          w.answer(checksOf(NEW), [200, checkRuns(...runs)]);
          const res = await w.update(['--quiet']);
          expect(res.code).toBe(4);
          expect(res.err).toBe('✗ bbbbbbb failed its checks on GitHub, so Playarr stays on aaaaaaa.\n');
          expect(w.calls().filter((line) => line.includes('codeload') || line.startsWith('docker compose'))).toEqual([]);
          expect(w.read('DEPLOYED')).toBe(`${OLD}\n`);
        }),
      );
    });

    it('goes back to the previous image, files and database when the new version doesn’t start', async () => {
      const w = nas(shell);
      w.answer(checksOf(NEW), green());
      // It answers, but its database doesn't: not up.
      w.health('img-new', [200, NO_DATABASE]);
      migratesOnStart(w);
      w.put('config/backups/playarr-0.6.9-schema-2.db', 'an older copy\n');
      const res = await w.update(['--quiet'], { PLAYARR_UPDATER: '1' });
      expect(res.code).toBe(6);
      expect(res.err).toBe("✗ bbbbbbb didn't start, so Playarr went back to aaaaaaa (rolled back)\n");
      expect(res.out).toContain('Playarr on img-new: could not start');
      expect(res.out).toContain('Put back the database from before Playarr 0.7.0 migrated it (config/backups/playarr-0.7.0-schema-3.db)');
      expect(w.compose()).toEqual([
        'docker compose up -d --build --no-deps --remove-orphans playarr',
        'docker compose stop playarr',
        'docker compose up -d --no-build --no-deps --force-recreate playarr',
      ]);
      expect(w.calls()).toContain('docker tag playarr:previous playarr:latest');
      expect(w.container()).toEqual(['img-old', 'true']);
      // The database as the old version left it, without the new one's log, and its copy used up.
      expect(w.read('config/playarr.db')).toBe('the live database\n');
      expect(['config/playarr.db-wal', 'config/playarr.db-shm', 'config/backups/playarr-0.7.0-schema-3.db'].filter(w.has)).toEqual([]);
      expect(w.read('config/backups/playarr-0.6.9-schema-2.db')).toBe('an older copy\n');
      expect([w.read('compose.yaml'), w.read('src/REVISION')]).toEqual(['old compose\n', `${OLD}\n`]);
      expect([w.read('DEPLOYED'), w.read('LATEST'), w.read('ROLLED_BACK')]).toEqual([`${OLD}\n`, `${NEW}\n`, `${NEW}\n`]);
      // The new update.sh stays: a fix to it can't be held back by the copy it replaced.
      expect(w.read('update.sh')).toBe(readFileSync(join(DOCKER_DIR, 'update.sh'), 'utf8'));
      expect(['src.previous', 'compose.yaml.previous'].filter(w.has)).toEqual([]);
    });

    it('leaves the database alone when the new version didn’t migrate it, even with a copy of its own from before', async () => {
      const w = nas(shell);
      w.answer(checksOf(NEW), green());
      w.health('img-new', [503, 'Service Unavailable']);
      w.put('config/playarr.db-wal', 'the live log\n');
      // Made by 0.7.0 in an earlier run: the database has moved on since.
      w.put('config/backups/playarr-0.7.0-schema-3.db', 'a stale copy\n');
      const res = await w.update(['--quiet']);
      expect(res.code).toBe(6);
      expect(res.out).not.toContain('Put back the database');
      expect([w.read('config/playarr.db'), w.read('config/playarr.db-wal')]).toEqual(['the live database\n', 'the live log\n']);
      expect(w.read('config/backups/playarr-0.7.0-schema-3.db')).toBe('a stale copy\n');
      expect(w.container()).toEqual(['img-old', 'true']);
    });

    it('doesn’t try a version that didn’t start again until a newer one, or --force', async () => {
      const w = nas(shell);
      w.put('ROLLED_BACK', `${NEW}\n`);
      w.answer(checksOf(NEW), green());
      w.health('img-new', [200, HEALTHY]);
      const res = await w.update(['--quiet']);
      expect(res.code).toBe(6);
      expect(res.err).toBe(
        "✗ bbbbbbb didn't start when it was installed, so Playarr stays on aaaaaaa until a newer version (sudo sh update.sh --force tries it again)\n",
      );
      expect(w.github()).toEqual(['/commits/main']);
      expect(w.compose()).toEqual([]);
      expect((await w.update(['--quiet', '--force'])).code).toBe(0);
      expect(w.read('DEPLOYED')).toBe(`${NEW}\n`);
      expect(w.has('ROLLED_BACK')).toBe(false);
    });

    it('installs the newest release on stable, by its tag', async () => {
      const w = nas(shell);
      w.put('update/settings.json', '{"enabled":true,"intervalMinutes":60,"channel":"stable"}\n');
      w.answer(`${API}/releases/latest`, [200, release('v0.7.0')]);
      w.answer(`${API}/commits/refs/tags/v0.7.0`, [200, RELEASED]);
      w.answer(checksOf(RELEASED), green());
      w.health('img-new', [200, HEALTHY]);
      const res = await w.update(['--quiet']);
      expect(res.code).toBe(0);
      expect(res.out).toContain('Playarr v0.7.0 (ccccccc) is up on port 4000');
      expect(w.github()).toEqual(['/releases/latest', '/commits/refs/tags/v0.7.0', `/commits/${RELEASED}/check-runs?check_name=Server%20and%20web`]);
      expect([w.read('DEPLOYED'), w.read('LATEST'), w.read('RELEASE')]).toEqual([`${RELEASED}\n`, `${RELEASED}\n`, 'v0.7.0\n']);
      expect(w.calls()).toContain(`curl ${tarballOf(RELEASED)}`);
    });

    it('never follows a release tag or a ref somewhere else in GitHub’s API', async () => {
      const w = nas(shell);
      w.answer(`${API}/releases/latest`, [200, release('../../../repos/someone/fork/commits/main')]);
      const tagged = await w.update(['--channel', 'stable']);
      expect(tagged.code).toBe(1);
      expect(tagged.err).toBe('✗ GitHub answered something unexpected for the latest release of test/playarr\n');
      const ref = await w.update(['--ref', 'main/../../../someone/fork/commits/main']);
      expect(ref.code).toBe(1);
      expect(ref.err).toBe('✗ Not a branch, tag or commit: main/../../../someone/fork/commits/main\n');
      expect(w.github()).toEqual(['/releases/latest']);
    });

    it('says plainly when stable has no release yet, and stays', async () => {
      const w = nas(shell);
      w.put('RELEASE', 'v0.0.1\n');
      w.answer(`${API}/releases/latest`, [404, '{"message":"Not Found","status":"404"}']);
      const res = await w.update(['--channel', 'stable']);
      expect(res.code).toBe(5);
      expect(res.out).toBe("There's no release of test/playarr yet, so Playarr stays on aaaaaaa until there is one.\n");
      expect(res.err).toBe('');
      expect(w.github()).toEqual(['/releases/latest']);
      expect([w.read('LATEST'), w.has('RELEASE'), w.read('DEPLOYED')]).toEqual(['', false, `${OLD}\n`]);
      expect(w.compose()).toEqual([]);
    });

    it('follows the channel in Settings → Updates when run by hand, as the updater reads it', async () => {
      const cases: [settings: string | undefined, asks: string][] = [
        // Saved before there were channels: main, as before.
        ['{"enabled":true,"intervalMinutes":15}', '/commits/main'],
        // Nothing saved yet: a new install, on stable.
        [undefined, '/releases/latest'],
        ['{"enabled":false,"intervalMinutes":60,"channel":"edge"}', '/commits/main'],
        ['{ "channel" : "stable" }', '/releases/latest'],
      ];
      await Promise.all(
        cases.map(async ([settings, asks]) => {
          const w = nas(shell);
          if (settings === undefined) rmSync(join(w.deploy, 'update/settings.json'));
          else w.put('update/settings.json', settings);
          w.answer(`${API}/commits/main`, [200, OLD]);
          w.answer(`${API}/releases/latest`, [404, '{"message":"Not Found"}']);
          await w.update(['--quiet']);
          expect(w.github()).toEqual([asks]);
        }),
      );
    });

    it('refuses a channel that isn’t stable or edge, asking GitHub nothing', async () => {
      const given = ['main', 'refs/heads/main', 'nicolabortignon/fork', 'Stable'].map(async (channel) => {
        const w = nas(shell);
        const res = await w.update(['--channel', channel]);
        expect(res.code).toBe(2);
        expect(res.err).toBe(`✗ Not a channel: ${channel} (stable or edge)\n`);
        expect(w.calls()).toEqual([]);
      });
      const saved = [
        '{"channel":"main"}',
        '{"channel":"v0.7.0"}',
        '{"channel":"stable ","enabled":true}',
        '{"channel":["edge"]}',
        '{"channel":null}',
        '{"channel":"edge","channel":"main"}',
        'not json',
      ].map(async (settings) => {
        const w = nas(shell);
        w.put('update/settings.json', settings);
        const res = await w.update([]);
        expect(res.code).toBe(2);
        expect(res.err).toBe("✗ Settings → Updates has a channel this script doesn't know: choose Stable or Edge there, or pass --channel\n");
        expect(w.calls()).toEqual([]);
      });
      await Promise.all([...given, ...saved]);
    });

    it('uses wget when there’s no curl, the status GitHub answers included', async () => {
      const w = nas(shell, { curl: false });
      w.answer(checksOf(NEW), green());
      w.health('img-new', [200, HEALTHY]);
      expect((await w.update(['--quiet'])).code).toBe(0);
      expect(w.read('DEPLOYED')).toBe(`${NEW}\n`);
      w.answer(`${API}/releases/latest`, [404, '{"message":"Not Found"}']);
      expect((await w.update(['--channel', 'stable'])).code).toBe(5);
      expect(w.calls().filter((line) => line.startsWith('curl'))).toEqual([]);
    });

    it('keeps the running container when the build fails, with its files', async () => {
      const w = nas(shell);
      w.answer(checksOf(NEW), green());
      w.docker('build-fails', '');
      const res = await w.update(['--quiet']);
      expect(res.code).toBe(1);
      expect(res.err).toContain('✗ Build or start failed; the previous container is still running');
      expect([w.read('compose.yaml'), w.read('src/REVISION'), w.read('DEPLOYED')]).toEqual(['old compose\n', `${OLD}\n`, `${OLD}\n`]);
      expect(w.has('ROLLED_BACK')).toBe(false);
      expect(w.container()).toEqual(['img-old', 'true']);
    });

    it('goes back when the new container can’t start after the old one was removed', async () => {
      const w = nas(shell);
      w.answer(checksOf(NEW), green());
      w.docker('start-fails', '');
      const res = await w.update(['--quiet']);
      expect(res.code).toBe(6);
      expect(w.container()).toEqual(['img-old', 'true']);
      expect(w.read('compose.yaml')).toBe('old compose\n');
    });

    it('says why when GitHub can’t be asked', async () => {
      const w = nas(shell);
      w.answer(`${API}/commits/main`, [403, '{"message":"API rate limit exceeded"}']);
      const limited = await w.update(['--quiet']);
      expect(limited.code).toBe(1);
      expect(limited.err).toContain("GitHub's limit of 60 requests an hour from this address is used up");
      w.answer(`${API}/commits/main`, [200, NEW]);
      w.answer(checksOf(NEW), [502, 'Bad Gateway']);
      const res = await w.update(['--quiet']);
      expect(res.code).toBe(1);
      expect(res.err).toBe("✗ Couldn't ask GitHub for the checks of bbbbbbb (GitHub answered 502)\n");
      expect(w.compose()).toEqual([]);
    });

    it('asks GitHub once when up to date', async () => {
      const w = nas(shell);
      w.answer(`${API}/commits/main`, [200, OLD]);
      const res = await w.update([]);
      expect(res.code).toBe(0);
      expect(res.out).toBe('Playarr is up to date (aaaaaaa).\n');
      expect(w.github()).toEqual(['/commits/main']);
    });

    it('counts a version from before the database field as up when it answers', async () => {
      const w = nas(shell);
      w.answer(checksOf(NEW), green());
      w.health('img-new', [200, OLD_HEALTHY]);
      expect((await w.update(['--quiet'])).code).toBe(0);
    });

    it('waits for a start that takes a while, and a start that falls over at once isn’t one', async () => {
      const w = nas(shell);
      w.answer(checksOf(NEW), green());
      // Migrating for a while, then up, then down again straight away, then up for good.
      w.health('img-new', [503, ''], [503, ''], [200, HEALTHY], [503, ''], [200, HEALTHY]);
      // Four tries and a 10 s second look: 15 s of real clock (sleep is a stub, date isn't) is too tight for a busy CI
      // machine, or a busybox whose sh runs its own sleep rather than the stub. A minute leaves the tries to decide.
      const res = await w.update(['--quiet'], { PLAYARR_HEALTH_WAIT: '60' });
      expect(res.code).toBe(0);
      expect(readFileSync(join(w.stub, 'count.health-img-new'), 'utf8').trim()).toBe('6');
    });

    it('installs a new machine from stable, with nothing to go back to', async () => {
      const machine = () => {
        const w = nas(shell, { fresh: true });
        w.answer(`${API}/releases/latest`, [200, release('v0.7.0')]);
        w.answer(`${API}/commits/refs/tags/v0.7.0`, [200, RELEASED]);
        w.answer(checksOf(RELEASED), green());
        return w;
      };
      const w = machine();
      w.health('img-new', [200, HEALTHY]);
      const broken = machine();
      broken.health('img-new', [200, NO_DATABASE]);
      const [res, failed] = await Promise.all([w.update([]), broken.update(['--quiet'])]);
      expect(res.code).toBe(0);
      expect(w.calls().filter((line) => line.startsWith('docker tag'))).toEqual([]);
      expect(w.read('DEPLOYED')).toBe(`${RELEASED}\n`);
      expect(w.read('.env')).toBe(`PLAYARR_DIR=${w.deploy}\n`);
      expect(failed.code).toBe(1);
      expect(failed.err).toContain("✗ Playarr didn't come up");
      expect(broken.has('DEPLOYED')).toBe(false);
    });
  });

  describe.skipIf(!JQ)(`updater.sh, run by ${shell.name}`, { concurrent: true, timeout: 120_000 }, () => {
    it('passes the channel: edge for settings saved before channels, stable for a new install, else the one chosen', async () => {
      const cases: [settings: string | undefined, channel: string][] = [
        ['{"enabled":false,"intervalMinutes":15}', 'edge'],
        [undefined, 'stable'],
        ['{"enabled":false,"intervalMinutes":15,"channel":"stable"}', 'stable'],
        ['{"channel":"edge"}', 'edge'],
      ];
      await Promise.all(
        cases.map(async ([settings, channel]) => {
          const w = nas(shell);
          if (settings === undefined) rmSync(join(w.deploy, 'update/settings.json'));
          else w.put('update/settings.json', settings);
          w.fakeUpdate(0, 'Playarr is up to date.\n');
          w.put('update/request', '2026-11-07T12:00:00.000Z');
          expect((await w.updater()).code).toBe(0);
          expect(w.updateArgs()).toEqual([`--quiet --channel ${channel}`]);
          expect(w.status()).toMatchObject({ state: 'idle', channel });
          expect(w.has('update/request')).toBe(false);
        }),
      );
    });

    it('refuses a channel that isn’t stable or edge, running nothing', async () => {
      const refused = ['{"channel":"main"}', '{"channel":"refs/tags/v1"}', '{"channel":"nicolabortignon/fork"}', '{"channel":1}', '[]', '{bad'];
      await Promise.all(
        refused.map(async (settings) => {
          const w = nas(shell);
          w.put('update/settings.json', settings);
          w.fakeUpdate(0);
          w.put('update/request', 'now');
          await w.updater();
          expect(w.updateArgs()).toEqual([]);
          expect(w.status()).toMatchObject({
            state: 'failed',
            error: "Settings → Updates has a channel this updater doesn't know: choose Stable or Edge again",
          });
          expect(w.read('update/last.log')).toContain('✗ Settings → Updates has a channel');
        }),
      );
    });

    it('records what update.sh found: waiting for checks and no release yet aren’t failures', async () => {
      const cases: [exit: number, output: string, status: Record<string, unknown>][] = [
        [3, 'bbbbbbb is waiting for its checks on GitHub, so Playarr stays on aaaaaaa until they pass.\n', { state: 'idle', outcome: 'waiting' }],
        [
          4,
          '✗ bbbbbbb failed its checks on GitHub, so Playarr stays on aaaaaaa.\n',
          { state: 'failed', outcome: 'checksFailed', error: 'bbbbbbb failed its checks on GitHub, so Playarr stays on aaaaaaa.' },
        ],
        [5, "There's no release of test/playarr yet, so Playarr stays on aaaaaaa until there is one.\n", { state: 'idle', outcome: 'noRelease' }],
        [
          6,
          "✗ bbbbbbb didn't start, so Playarr went back to aaaaaaa (rolled back)\n",
          { state: 'failed', outcome: 'rolledBack', error: "bbbbbbb didn't start, so Playarr went back to aaaaaaa (rolled back)" },
        ],
        [1, '✗ Download failed\n', { state: 'failed', error: 'Download failed' }],
      ];
      await Promise.all(
        cases.map(async ([exit, output, status]) => {
          const w = nas(shell);
          w.fakeUpdate(exit, output);
          w.put('update/request', 'now');
          await w.updater();
          expect(w.status()).toMatchObject({ ...status, channel: 'edge', deployed: OLD, lastUpdate: 1_799_000_000 });
          if (!('outcome' in status)) expect(w.status().outcome).toBeUndefined();
          if (status.state === 'idle') expect(w.status().error).toBeUndefined();
          expect(w.read('update/last.log')).toBe(output);
          expect(w.calls()).toEqual([]);
        }),
      );
    });

    it('keeps what the last check found across a restart, and passes the release on', async () => {
      const w = nas(shell);
      // The release and the newest commit come from update.sh's files beside it, never from status.json.
      w.put('RELEASE', 'v0.7.0\n');
      w.put('LATEST', `${NEW}\n`);
      w.put(
        'update/status.json',
        JSON.stringify({ state: 'idle', heartbeat: 1, lastCheck: 2, lastUpdate: 1, deployed: OLD, latest: OLD, outcome: 'waiting', channel: 'stable', release: 'evil' }),
      );
      w.put('update/settings.json', '{"enabled":false,"intervalMinutes":60,"channel":"stable"}');
      await w.updater();
      expect(w.status()).toMatchObject({ state: 'idle', lastCheck: 2, outcome: 'waiting', channel: 'stable', release: 'v0.7.0', latest: NEW });
      w.put('update/status.json', JSON.stringify({ state: 'idle', heartbeat: 1, lastCheck: 2, lastUpdate: 1, outcome: 'deployed; rm -rf /', channel: 'main' }));
      await w.updater();
      expect(w.status().outcome).toBeUndefined();
      expect(w.status().channel).toBeUndefined();
    });

    it('takes over from the update.sh before channels, from what it leaves behind', async () => {
      /**
       * The NAS's update.sh as it is today (frozen in fixtures/) installs NEW, the commit that brings the new scripts:
       * ungated, as it has no gate, and copying NEW's update.sh over itself. It leaves DEPLOYED, LATEST, a status
       * without outcome or channel, settings without a channel, an image never tagged playarr:previous and no
       * config/backups. Then main moves on to NEWER, and the updater (NEW's) runs the new update.sh on all that.
       */
      const NEWER = 'd'.repeat(40);
      const afterTheOldScript = async (newer: Answer) => {
        const w = nas(shell);
        w.put('update.sh', readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/update-before-channels.sh'), 'utf8'));
        w.health('img-new', [200, HEALTHY]);
        const old = await w.update(['--quiet'], { PLAYARR_UPDATER: '1' });
        expect(old.code).toBe(0);
        expect(w.read('update.sh')).toBe(readFileSync(join(DOCKER_DIR, 'update.sh'), 'utf8'));
        expect(w.calls().filter((line) => line.includes('check-runs') || line.startsWith('docker tag'))).toEqual([]);
        w.answer(`${API}/commits/main`, [200, NEWER]);
        w.answer(checksOf(NEWER), green());
        w.answer(tarballOf(NEWER), [200, 'a tarball']);
        w.docker('next-image', 'img-newer\n');
        w.health('img-newer', newer);
        w.put('update/request', 'now');
        const before = w.calls().length;
        const res = await w.updater();
        return { w, res, calls: w.calls().slice(before) };
      };
      // Its first update that doesn't start goes back, with no copies of the database to put back.
      const [{ w, res, calls }, failing] = await Promise.all([afterTheOldScript([200, HEALTHY]), afterTheOldScript([200, NO_DATABASE])]);

      expect(res.code).toBe(0);
      expect(calls.filter((line) => line.includes('api.github.com'))).toEqual([
        `curl ${API}/commits/main`,
        `curl ${API}/commits/${NEWER}/check-runs?check_name=Server%20and%20web`,
      ]);
      expect(calls).toContain('docker tag img-new playarr:previous');
      expect(w.container()).toEqual(['img-newer', 'true']);
      const status = w.status();
      expect(status).toMatchObject({ state: 'idle', channel: 'edge', deployed: NEWER, latest: NEWER });
      expect(status.lastUpdate).toBe(status.lastCheck);
      expect(status.outcome).toBeUndefined();
      // The updater refreshes itself after an update.
      expect(calls.some((line) => line.startsWith('docker run -d --rm --name playarr-updater-refresh'))).toBe(true);

      expect(failing.w.status()).toMatchObject({ state: 'failed', outcome: 'rolledBack', deployed: NEW, latest: NEWER });
      expect(failing.w.container()).toEqual(['img-new', 'true']);
      expect(failing.w.read('config/playarr.db')).toBe('the live database\n');
      expect(failing.w.has('config/backups')).toBe(false);
      expect(failing.calls.some((line) => line.startsWith('docker run'))).toBe(false);
    });
  });
}
