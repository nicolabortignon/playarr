import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.ts';
import { ProxyNames, proxyNamesOf } from './proxyNames.ts';

const CADDY = '172.18.0.3';
const GATEWAY = '172.18.0.1';
const VISITOR = '203.0.113.50';

/** Names resolving as `table` says (changeable), at a clock the test moves. */
function names(table: Record<string, string[]>, list = ['playarr-caddy']) {
  let now = 1_000_000;
  const lookup = vi.fn(async (name: string) => {
    const found = table[name];
    if (!found) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${name}`), { code: 'ENOTFOUND' });
    return found;
  });
  const proxies = new ProxyNames(list, { lookup, now: () => now });
  return { proxies, lookup, tick: (ms: number) => (now += ms) };
}

describe('proxies believed by name', () => {
  it('believes exactly the addresses the names have, as the one proxy in front', async () => {
    const { proxies, lookup } = names({ 'playarr-caddy.': [CADDY] });
    await proxies.refresh();
    // Looked up as an absolute name: no search domain turns a stopped Caddy into some machine of that name.
    expect(lookup).toHaveBeenCalledWith('playarr-caddy.');
    expect(proxies.trusts(CADDY, 0)).toBe(true);
    expect(proxies.trusts(`::ffff:${CADDY}`, 0)).toBe(true);
    // Not the Docker gateway, which visitors through the published port can come from; not a hop further out.
    expect(proxies.trusts(GATEWAY, 0)).toBe(false);
    expect(proxies.trusts(CADDY, 1)).toBe(false);
  });

  it('counts only home addresses, as a container’s are', async () => {
    const { proxies } = names({ 'playarr-caddy.': [VISITOR, CADDY] });
    await proxies.refresh();
    expect(proxies.believed).toEqual([CADDY]);
  });

  it('follows Caddy to a new address when it’s made again, looking again at most every 5 s', async () => {
    const table: Record<string, string[]> = { 'playarr-caddy.': [CADDY] };
    const { proxies, lookup, tick } = names(table);
    await proxies.refresh();
    table['playarr-caddy.'] = ['172.18.0.7'];
    tick(6000);
    // The first request from the new address isn't believed, but sends the lookup off…
    expect(proxies.trusts('172.18.0.7', 0)).toBe(false);
    await vi.waitFor(() => expect(proxies.believed).toEqual(['172.18.0.7']));
    expect(proxies.trusts('172.18.0.7', 0)).toBe(true);
    expect(proxies.trusts(CADDY, 0)).toBe(false);
    // …and a stream of them from elsewhere doesn't keep looking.
    for (let i = 0; i < 5; i++) proxies.trusts(GATEWAY, 0);
    expect(lookup).toHaveBeenCalledTimes(2);
    // An address outside the home never sends one off.
    tick(6000);
    proxies.trusts(VISITOR, 0);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('believes nobody while the name doesn’t resolve, and says so once after a minute', async () => {
    const { proxies, tick } = names({});
    const log = vi.fn();
    proxies.start(log);
    await proxies.refresh();
    expect(proxies.trusts(CADDY, 0)).toBe(false);
    expect(log).not.toHaveBeenCalled();
    tick(61_000);
    await proxies.refresh();
    await proxies.refresh();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatch(/playarr-caddy doesn’t resolve.*COMPOSE_PROFILES=https/);
    proxies.stop();
  });

  it('is only needed when TRUST_PROXY names its proxies', () => {
    expect(proxyNamesOf(loadConfig({}).trustProxy)).toBeUndefined();
    expect(proxyNamesOf(loadConfig({ TRUST_PROXY: 'true' }).trustProxy)).toBeUndefined();
    expect(proxyNamesOf(loadConfig({ TRUST_PROXY: '172.18.0.1,loopback' }).trustProxy)).toBeUndefined();
    expect(proxyNamesOf(loadConfig({ PLAYARR_DOMAIN: 'music.example.com' }).trustProxy)?.names).toEqual(['playarr-caddy']);
  });

  it('gives Fastify the visitor behind Caddy, and nobody’s word but Caddy’s', async () => {
    const { proxies } = names({ 'playarr-caddy.': [CADDY] });
    await proxies.refresh();
    const app = Fastify({ trustProxy: proxies.trusts });
    app.get('/who', (req) => ({ ip: req.ip, protocol: req.protocol, host: req.host }));
    const forwarded = { 'x-forwarded-for': VISITOR, 'x-forwarded-proto': 'https', 'x-forwarded-host': 'music.example.com', host: 'playarr:4000' };
    const viaCaddy = await app.inject({ url: '/who', headers: forwarded, remoteAddress: CADDY });
    expect(viaCaddy.json()).toEqual({ ip: VISITOR, protocol: 'https', host: 'music.example.com' });
    // The same headers from anyone else (here the gateway, as a visitor through port 4000 may appear) are ignored.
    const forged = await app.inject({ url: '/who', headers: forwarded, remoteAddress: GATEWAY });
    expect(forged.json()).toEqual({ ip: GATEWAY, protocol: 'http', host: 'playarr:4000' });
  });
});
