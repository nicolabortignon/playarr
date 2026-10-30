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
