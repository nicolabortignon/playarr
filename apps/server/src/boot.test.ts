import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const serverDir = fileURLToPath(new URL('..', import.meta.url));

/** The server as `pnpm dev` runs it, on a port of its own, with empty folders and nothing from this machine's .env. */
function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'playarr-boot-'));
  const child = spawn(join(serverDir, 'node_modules/.bin/tsx'), ['--disable-warning=ExperimentalWarning', 'src/index.ts'], {
    cwd: serverDir,
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      DATA_DIR: join(dir, 'data'),
      CACHE_DIR: join(dir, 'cache'),
      PORT: '0',
      HOST: '127.0.0.1',
      BONJOUR: 'off',
      MEDIA_SOURCE: 'local',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout!.on('data', (d: Buffer) => (output += d));
  child.stderr!.on('data', (d: Buffer) => (output += d));
  const lines = () =>
    output.split('\n').flatMap((line) => {
      try {
        return [JSON.parse(line) as { msg?: string; level?: number }];
      } catch {
        return [];
      }
    });
  return { child, dir, lines, output: () => output };
}

/** What `read` finds, once it finds something; fails with the server's log after `ms`. */
async function until<T>(read: () => T | undefined, ms: number, log: () => string): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = read();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`Timed out; the server said:\n${log()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const exited = (child: ChildProcess) =>
  new Promise<number | null>((resolve) => (child.exitCode !== null ? resolve(child.exitCode) : child.once('exit', (code) => resolve(code))));

let running: ReturnType<typeof boot> | undefined;
afterEach(() => {
  if (running && running.child.exitCode === null) running.child.kill('SIGKILL');
  if (running) rmSync(running.dir, { recursive: true, force: true });
  running = undefined;
});

describe('the server', () => {
  it('starts, answers, and closes cleanly on SIGTERM', { timeout: 60_000 }, async () => {
    const server = (running = boot());
    const address = await until(
      () => server.lines().map((l) => /^Server listening at (http:\/\/127\.0\.0\.1:\d+)$/.exec(l.msg ?? '')?.[1]).find(Boolean),
      45_000,
      server.output,
    );

    const res = await fetch(`${address}/api/health`, { headers: { 'x-request-id': 'boot-test' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ database: { ok: true } });
    expect(res.headers.get('x-request-id')).toBe('boot-test');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');

    server.child.kill('SIGTERM');
    expect(await exited(server.child)).toBe(0);
    // Nothing logged at error or worse on the way: a crash, a failed promise, a migration gone wrong.
    expect(server.lines().filter((l) => (l.level ?? 0) >= 50)).toEqual([]);
  });
});
