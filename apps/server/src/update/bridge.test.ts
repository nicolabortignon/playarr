import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../catalog/testFixtures.ts';
import { UpdateBridge, UpdateError } from './bridge.ts';

const NOW = 1_800_000_000_000;
const SHA = 'a'.repeat(40);
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function setup(files: Record<string, string> = {}) {
  const { dir, cleanup } = tempDir();
  cleanups.push(() => {
    chmodSync(dir, 0o755);
    cleanup();
  });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return { dir, bridge: new UpdateBridge(dir, () => NOW) };
}

const status = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ state: 'idle', heartbeat: NOW / 1000 - 10, lastCheck: 100, lastUpdate: 50, deployed: SHA, latest: SHA, ...over });

describe('UpdateBridge', () => {
  it('needs the Docker setup', async () => {
    const bridge = new UpdateBridge(undefined, () => NOW);
    expect(await bridge.info()).toEqual({
      available: false,
      reason: 'Automatic updates need the Docker setup (docker/compose.yaml)',
      enabled: false,
      intervalMinutes: 60,
      requested: false,
    });
    await expect(bridge.save({ enabled: true })).rejects.toThrow(UpdateError);
    await expect(bridge.requestCheck()).rejects.toMatchObject({ status: 409 });
  });

  it('says the updater is not running without a status, or with an old heartbeat', async () => {
    const reason = "The updater isn't running. Run update.sh on the server once to start it.";
    expect(await setup().bridge.info()).toMatchObject({ available: false, reason, enabled: false, intervalMinutes: 60 });
    const stale = await setup({ 'status.json': status({ heartbeat: NOW / 1000 - 181 }) }).bridge.info();
    expect(stale).toMatchObject({ available: false, reason, status: { lastCheck: 100 } });
  });

  it('is available with a fresh heartbeat, and passes the status on', async () => {
    const info = await setup({ 'status.json': status({ state: 'failed', error: 'Download failed' }) }).bridge.info();
    expect(info).toEqual({
      available: true,
      enabled: false,
      intervalMinutes: 60,
      requested: false,
      status: { state: 'failed', lastCheck: 100, lastUpdate: 50, deployed: SHA, latest: SHA, error: 'Download failed' },
    });
  });

  it('treats a damaged status as missing and drops odd fields', async () => {
    expect((await setup({ 'status.json': '{not json' }).bridge.info()).status).toBeUndefined();
    const odd = await setup({ 'status.json': status({ state: 'hacked', deployed: 'rm -rf /', lastCheck: 'x' }) }).bridge.info();
    expect(odd.status).toEqual({ state: 'idle', lastCheck: 0, lastUpdate: 50, latest: SHA });
  });

  it("says so when it can't write to the folder", async () => {
    if (process.getuid?.() === 0) return; // root writes anywhere
    const { dir, bridge } = setup({ 'status.json': status() });
    chmodSync(dir, 0o555);
    expect(await bridge.info()).toMatchObject({ available: false, reason: "Playarr can't write to its update folder" });
    await expect(bridge.save({ enabled: true })).rejects.toMatchObject({ status: 409 });
  });

  it('saves settings, merged, and rejects a bad interval', async () => {
    const { dir, bridge } = setup({ 'status.json': status() });
    await bridge.save({ enabled: true });
    await bridge.save({ intervalMinutes: 1440 });
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).toEqual({ enabled: true, intervalMinutes: 1440 });
    expect(existsSync(join(dir, 'settings.json.new'))).toBe(false);
    expect(await bridge.info()).toMatchObject({ enabled: true, intervalMinutes: 1440 });
    await expect(bridge.save({ intervalMinutes: 7 as never })).rejects.toMatchObject({ status: 400 });
    await expect(bridge.save({ enabled: 'yes' as never })).rejects.toMatchObject({ status: 400 });
    expect(await bridge.info()).toMatchObject({ enabled: true, intervalMinutes: 1440 });
  });

  it('reads damaged settings as the defaults', async () => {
    const info = await setup({ 'settings.json': '{"enabled":"true","intervalMinutes":5}' }).bridge.info();
    expect(info).toMatchObject({ enabled: false, intervalMinutes: 60 });
  });

  it('asks the updater to check now', async () => {
    const { dir, bridge } = setup({ 'status.json': status() });
    await bridge.requestCheck();
    expect(readFileSync(join(dir, 'request'), 'utf8')).toBe(new Date(NOW).toISOString());
    expect((await bridge.info()).requested).toBe(true);
  });

  it("returns the last 60 lines of the last run's log", async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    const { bridge } = setup({ 'status.json': status(), 'last.log': `${lines.join('\n')}\n` });
    const log = (await bridge.info()).log!;
    expect(log.split('\n')).toEqual(lines.slice(40));
    expect((await setup({ 'last.log': '' }).bridge.info()).log).toBeUndefined();
  });
});
