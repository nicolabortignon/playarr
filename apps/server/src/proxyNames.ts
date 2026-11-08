import { lookup } from 'node:dns/promises';
import { CADDY, isProxyName, type TrustProxy } from './config.ts';
import { isLocalAddress } from './net.ts';

/** Every address a name has. */
export type LookupAll = (name: string) => Promise<string[]>;

/** How often the names are looked up anyway, and how soon again when a request suggests they've moved. */
const REFRESH_MS = 30_000;
const AGAIN_MS = 5_000;
/** How long a name may not resolve before the log says so (Caddy can start after Playarr). */
const WARN_AFTER_MS = 60_000;

const systemLookup: LookupAll = async (name) => (await lookup(name, { all: true })).map((a) => a.address);

/** 192.168.1.2 for ::ffff:192.168.1.2, as a dual-stack socket reports an IPv4 visitor. */
const unmapped = (address: string) => address.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');

/**
 * The proxies TRUST_PROXY names, such as playarr-caddy, the https profile's Caddy on the compose network, believed at the
 * addresses their names have now, and only there. Pinning Caddy's address instead would need a network with a fixed
 * subnet that Playarr joins in every deployment (compose can't join one only with a profile), which could clash with
 * an owner's own networks. Docker gives a container a new address when it's made again, so the names are looked up
 * every 30 s, and again at once (at most every 5 s) when a request with forwarded headers comes from a home address
 * that isn't theirs.
 *
 * Names are looked up as absolute names (playarr-caddy.), so a resolver's search domain can't turn a stopped Caddy into
 * some other machine of that name on the home network; and only home addresses count, as a container's are.
 */
export class ProxyNames {
  private addresses = new Set<string>();
  private lastLookup = Number.NEGATIVE_INFINITY;
  private started = 0;
  private resolvedOnce = false;
  private warned = false;
  private pending?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private log: (message: string) => void = () => {};

  constructor(
    readonly names: readonly string[],
    private readonly options: { lookup?: LookupAll; now?: () => number } = {},
  ) {}

  /**
   * Fastify's trustProxy. Fastify asks only about requests that carry forwarded headers, with hop 0 for the socket's
   * own address: the one proxy in front.
   */
  readonly trusts = (address: string, hop: number): boolean => {
    if (hop !== 0 || !address) return false;
    const plain = unmapped(address);
    if (this.addresses.has(plain)) return true;
    if (isLocalAddress(plain) && this.now() - this.lastLookup >= AGAIN_MS) void this.refresh();
    return false;
  };

  /** The addresses believed now. */
  get believed(): string[] {
    return [...this.addresses];
  }

  /** Looks the names up again (once for everyone asking meanwhile). */
  refresh(): Promise<void> {
    this.pending ??= this.lookUp().finally(() => (this.pending = undefined));
    return this.pending;
  }

  /** Looks the names up now and every 30 s; `log` hears about a name that still doesn't resolve after a minute. */
  start(log?: (message: string) => void): this {
    if (log) this.log = log;
    this.started = this.now();
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    this.timer.unref();
    return this;
  }

  stop() {
    clearInterval(this.timer);
  }

  private now() {
    return (this.options.now ?? Date.now)();
  }

  private async lookUp() {
    this.lastLookup = this.now();
    const found = new Set<string>();
    const missing: string[] = [];
    for (const name of this.names) {
      let addresses: string[] = [];
      try {
        addresses = await (this.options.lookup ?? systemLookup)(name.endsWith('.') ? name : `${name}.`);
      } catch {
        // Not running (yet): believed nowhere until it is.
      }
      const local = addresses.map(unmapped).filter(isLocalAddress);
      if (!local.length) missing.push(name);
      for (const address of local) found.add(address);
    }
    this.addresses = found;
    if (found.size) this.resolvedOnce = true;
    if (missing.length && !this.resolvedOnce && !this.warned && this.now() - this.started >= WARN_AFTER_MS) {
      this.warned = true;
      const hint = missing.includes(CADDY) ? ' Is Caddy running? It needs COMPOSE_PROFILES=https in .env.' : '';
      this.log(`TRUST_PROXY: ${missing.join(', ')} doesn’t resolve to a home address, so no proxy is believed.${hint}`);
    }
  }
}

/** The lookups TRUST_PROXY needs, when it names its proxies; undefined when Fastify can take it as it is. */
export function proxyNamesOf(trust: TrustProxy, options?: { lookup?: LookupAll; now?: () => number }): ProxyNames | undefined {
  if (!Array.isArray(trust) || !trust.some(isProxyName)) return undefined;
  return new ProxyNames(trust, options);
}
