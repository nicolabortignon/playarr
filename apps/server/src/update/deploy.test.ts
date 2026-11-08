// docker/compose.yaml with the https profile: Caddy is there only when COMPOSE_PROFILES=https. update.sh starting it
// then, and only then, is in scripts.test.ts.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../catalog/testFixtures.ts';

const DOCKER_DIR = new URL('../../../../docker/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, DOCKER_DIR), 'utf8');

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
const temp = () => {
  const { dir, cleanup } = tempDir();
  cleanups.push(cleanup);
  return dir;
};

/** compose.yaml's services and the lines under each, comments left out (two-space YAML: services at 2, keys at 4). */
function services(yaml: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  let inServices = false;
  let current: string[] | undefined;
  for (const line of yaml.split('\n')) {
    if (/^\S/.test(line)) {
      inServices = line.startsWith('services:');
      current = undefined;
    } else if (inServices && /^ {2}[\w-]+:\s*$/.test(line)) {
      current = [];
      found.set(line.trim().slice(0, -1), current);
    } else if (current && line.trim() && !line.trim().startsWith('#')) {
      current.push(line.replace(/\s+#.*$/, ''));
    }
  }
  return found;
}

const hasDocker = (() => {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('compose.yaml', () => {
  const compose = services(read('compose.yaml'));

  it('has Caddy only under the https profile, and nothing else depending on it', () => {
    expect([...compose.keys()].sort()).toEqual(['playarr', 'playarr-caddy', 'updater']);
    expect(compose.get('playarr-caddy')).toContain('    profiles: ["https"]');
    for (const name of ['playarr', 'updater']) {
      const lines = compose.get(name)!;
      expect(lines.some((l) => /^\s{4}profiles:/.test(l)), name).toBe(false);
      expect(lines.some((l) => /caddy/i.test(l)), name).toBe(false);
    }
    // Playarr's port is as it was; Caddy takes 80 and 443.
    expect(compose.get('playarr')).toContain('      - "4000:4000"');
    expect(compose.get('playarr-caddy')!.filter((l) => /^\s+- "\d+:\d+"$/.test(l)).map((l) => l.trim())).toEqual(['- "80:80"', '- "443:443"']);
  });

  it('hands Caddy the domain and the Caddyfile that proxies to Playarr', () => {
    expect(compose.get('playarr-caddy')).toContain('      PLAYARR_DOMAIN: ${PLAYARR_DOMAIN:-}');
    expect(compose.get('playarr')).toContain('      PLAYARR_DOMAIN: ${PLAYARR_DOMAIN:-}');
    expect(compose.get('playarr-caddy')).toContain('      - ./src/docker/Caddyfile:/etc/caddy/Caddyfile:ro');
    const caddyfile = read('Caddyfile').replace(/#.*$/gm, '');
    expect(caddyfile).toMatch(/\{\$PLAYARR_DOMAIN\}\s*\{\s*reverse_proxy playarr:4000\s*\}/);
  });

  it.skipIf(!hasDocker)('makes docker compose see Caddy only with the profile', () => {
    const dir = temp();
    copyFileSync(new URL('compose.yaml', DOCKER_DIR), join(dir, 'compose.yaml'));
    mkdirSync(join(dir, 'src', 'docker'), { recursive: true });
    writeFileSync(join(dir, '.env'), `MUSIC_DIR=${dir}\nLIDARR_URL=http://lidarr:8686\nLIDARR_API_KEY=x\n`);
    const listed = (profiles: string) =>
      execFileSync('docker', ['compose', 'config', '--services'], { cwd: dir, env: { ...process.env, COMPOSE_PROFILES: profiles } })
        .toString()
        .trim()
        .split('\n')
        .sort();
    expect(listed('')).toEqual(['playarr', 'updater']);
    expect(listed('https')).toEqual(['playarr', 'playarr-caddy', 'updater']);
  });
});
