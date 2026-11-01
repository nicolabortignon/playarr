import { isIP } from 'node:net';

/**
 * True for loopback, private (RFC 1918), link-local and unique-local addresses.
 * Pass the socket's address, never a forwarded header: a proxy header can be forged.
 */
export function isLocalAddress(address: string | undefined): boolean {
  if (!address) return false;
  let a = address.toLowerCase();
  if (a.startsWith('::ffff:') && isIP(a.slice(7)) === 4) a = a.slice(7);
  if (isIP(a) === 4) {
    const [p, q] = a.split('.').map(Number) as [number, number];
    return p === 127 || p === 10 || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || (p === 169 && q === 254);
  }
  if (isIP(a) === 6) return a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a);
  return false;
}

interface RequestLike {
  socket: { remoteAddress?: string };
  headers: Record<string, string | string[] | undefined>;
}

/**
 * A request from the home network, for settings and other local-only actions. All three must hold:
 * - from a local address (the socket's own, never a header);
 * - not through a proxy (behind one, the socket is the proxy's and the visitor could be anywhere);
 * - addressed to this server by IP or a local name, so a web page can't reach it through a domain of
 *   its own pointed at a home address (DNS rebinding). Other names: LOCAL_HOSTNAMES in .env.
 */
export function isLocalRequest(req: RequestLike, extraHosts = localHostnames()): boolean {
  if (!isLocalAddress(req.socket.remoteAddress)) return false;
  if (req.headers['x-forwarded-for'] || req.headers.forwarded || req.headers['x-real-ip']) return false;
  return isLocalHost(typeof req.headers.host === 'string' ? req.headers.host : undefined, extraHosts);
}

/** An IP address, localhost, a bare name ("nas") or a local domain (.local, .lan, .home.arpa). */
export function isLocalHost(host: string | undefined, extraHosts: string[] = []): boolean {
  if (!host) return false;
  const name = host.toLowerCase().replace(/^\[(.*)\](:\d+)?$/, '$1').replace(/:\d+$/, '');
  if (isIP(name)) return true;
  if (name === 'localhost' || !name.includes('.')) return true;
  if (/\.(local|lan|home\.arpa|internal)$/.test(name)) return true;
  return extraHosts.includes(name);
}

function localHostnames(): string[] {
  return (process.env.LOCAL_HOSTNAMES ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Changes must come from Playarr's own pages, which send this header. Other websites can't add it to
 * a request without the browser asking first (and Playarr never says yes), so a page someone opens
 * can't make the server rescan, rematch or update behind their back.
 */
export const APP_HEADER = 'x-playarr';

export function isFromApp(req: { method: string; headers: Record<string, string | string[] | undefined> }): boolean {
  return ['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.headers[APP_HEADER] === '1';
}
