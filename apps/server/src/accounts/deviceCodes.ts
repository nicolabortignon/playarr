import type { DeviceCodeInfo, DeviceCodeStart } from '@playarr/shared';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { normalizeCode } from './setupCodes.ts';

/** The setup codes' alphabet: no 0/O or 1/I/L, typed from a TV screen without mistakes. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const LENGTH = 8;
export const DEVICE_CODE_SECONDS = 600;
export const DEVICE_POLL_SECONDS = 5;
/** Codes waiting at once: plenty for a household; past it, the oldest go. */
const MAX_WAITING = 200;

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

interface Waiting {
  pollHash: string;
  device: string;
  platform: string;
  expiresAt: number;
  /** The account that approved it, until the device collects its session. */
  approvedBy?: number;
}

/**
 * Signing in a device without a keyboard (plan 9 §3), as TVs do: the device shows a short code, someone signed in
 * elsewhere approves it for their account, and the device, polling with a token only it has, collects a session of its
 * own. Kept in memory and only as hashes, like every code: a restart drops the codes waiting, which the TV shows as
 * expired and starts again.
 */
export class DeviceCodes {
  private readonly waiting = new Map<string, Waiting>();

  constructor(private readonly now: () => number = Date.now) {}

  start(device: string, platform: string, origin: string): DeviceCodeStart {
    this.purge();
    let code: string;
    do code = Array.from({ length: LENGTH }, () => ALPHABET.charAt(randomInt(ALPHABET.length))).join('');
    while (this.waiting.has(hash(code)));
    const pollToken = randomBytes(32).toString('base64url');
    while (this.waiting.size >= MAX_WAITING) this.waiting.delete(this.waiting.keys().next().value!);
    this.waiting.set(hash(code), { pollHash: hash(pollToken), device, platform, expiresAt: this.now() + DEVICE_CODE_SECONDS * 1000 });
    return { code, verifyUrl: `${origin}/link?code=${code}`, pollToken, expiresIn: DEVICE_CODE_SECONDS, interval: DEVICE_POLL_SECONDS };
  }

  /** Which device a code is for; undefined when it's wrong, expired or already approved. */
  lookup(code: string): DeviceCodeInfo | undefined {
    const entry = this.live(code);
    if (!entry || entry.approvedBy !== undefined) return undefined;
    return { device: entry.device, platform: entry.platform, expiresAt: new Date(entry.expiresAt).toISOString() };
  }

  /** Approves a code for `accountId`: the device it's for, or undefined when it's wrong, expired or already approved. */
  approve(code: string, accountId: number): DeviceCodeInfo | undefined {
    const info = this.lookup(code);
    if (info) this.live(code)!.approvedBy = accountId;
    return info;
  }

  /**
   * What the device polling with `pollToken` gets: still pending, expired (or never started), or, once, the approving
   * account with the device's name and platform for its session.
   */
  poll(pollToken: string): { status: 'pending' } | { status: 'expired' } | { status: 'approved'; accountId: number; device: string; platform: string } {
    const pollHash = hash(pollToken);
    for (const [key, entry] of this.waiting) {
      if (entry.pollHash !== pollHash) continue;
      if (entry.expiresAt <= this.now()) {
        this.waiting.delete(key);
        return { status: 'expired' };
      }
      if (entry.approvedBy === undefined) return { status: 'pending' };
      this.waiting.delete(key);
      return { status: 'approved', accountId: entry.approvedBy, device: entry.device, platform: entry.platform };
    }
    return { status: 'expired' };
  }

  private live(code: string): Waiting | undefined {
    const entry = this.waiting.get(hash(normalizeCode(code)));
    return entry && entry.expiresAt > this.now() ? entry : undefined;
  }

  private purge() {
    const now = this.now();
    for (const [key, entry] of this.waiting) if (entry.expiresAt <= now) this.waiting.delete(key);
  }
}
