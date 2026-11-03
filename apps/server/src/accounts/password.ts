import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/** scrypt's cost: 16 MiB and tens of milliseconds a try: slow for guessing, quick for signing in. */
const COST = { N: 16384, r: 8, p: 1 };
const KEY_BYTES = 64;
const SALT_BYTES = 16;

type Cost = typeof COST;

function derive(password: string, salt: Buffer, cost: Cost): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, KEY_BYTES, { ...cost, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

/** `scrypt$N$r$p$salt$hash` (base64), with a salt of its own. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, COST);
  return ['scrypt', COST.N, COST.r, COST.p, salt.toString('base64'), key.toString('base64')].join('$');
}

/** Whether `password` is the one hashed in `stored`, compared in constant time; false for anything unreadable. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const cost = { N: Number(n), r: Number(r), p: Number(p) };
  const expected = Buffer.from(hash, 'base64');
  if (![cost.N, cost.r, cost.p].every(Number.isInteger) || expected.length !== KEY_BYTES) return false;
  const key = await derive(password, Buffer.from(salt, 'base64'), cost).catch(() => null);
  return !!key && timingSafeEqual(key, expected);
}
