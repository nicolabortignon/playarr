import type { SessionInfo } from '@playarr/shared';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/** last_seen_at is written at most this often per session: sessions are read on every request. */
const TOUCH_EVERY_MS = 60_000;

/** 256 random bits. */
export const newToken = () => randomBytes(32).toString('base64url');
/** Tokens are stored as their SHA-256, so a copy of the database signs nobody in. */
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** What the home-address proof (GET /api/auth/proof) authenticates, each followed by the app's nonce: its question and the answer. */
export const PROOF_ID = 'playarr-home-id:';
export const PROOF_ANSWER = 'playarr-home-proof:';
/** HMAC-SHA256 keyed by a token's SHA-256 (the stored hash, as bytes), of `message`. */
export const proofMac = (tokenHash: Buffer, message: string) => createHmac('sha256', tokenHash).update(message).digest();

interface Row {
  id: number;
  device: string;
  platform: string;
  created_at: string;
  last_seen_at: string;
}

/** Devices signed in to an account: the iOS app sends the token as a Bearer, the web as a cookie. */
export class Sessions {
  /** When each session was last written as seen, so most requests write nothing. */
  private readonly touched = new Map<number, number>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}

  create(accountId: number, device: string, platform: string): { id: number; token: string } {
    const token = newToken();
    const at = new Date(this.now()).toISOString();
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO sessions (account_id, token_hash, device, platform, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(accountId, hashToken(token), device.trim().slice(0, 80) || 'Unknown device', platform.trim().slice(0, 20) || 'web', at, at);
    const id = Number(lastInsertRowid);
    this.touched.set(id, this.now());
    return { id, token };
  }

  /** The session a token belongs to, noting that it was seen. */
  resolve(token: string): { id: number; accountId: number } | undefined {
    if (!token) return undefined;
    const row = this.db.prepare('SELECT id, account_id, last_seen_at FROM sessions WHERE token_hash = ?').get(hashToken(token)) as
      | { id: number; account_id: number; last_seen_at: string }
      | undefined;
    if (!row) return undefined;
    const now = this.now();
    if (now - (this.touched.get(row.id) ?? Date.parse(row.last_seen_at)) >= TOUCH_EVERY_MS) {
      this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(new Date(now).toISOString(), row.id);
      this.touched.set(row.id, now);
    }
    return { id: row.id, accountId: row.account_id };
  }

  /**
   * The answer to an app about to send its token to this server's home address (GET /api/auth/proof), proving the
   * server holds the session. The app names it by `id`, HMAC-SHA256(key: the token's SHA-256, PROOF_ID + nonce):
   * the server works that out for each session from the hash it stores, and nobody without the hash can work it out,
   * or back from it to the hash. The answer is HMAC-SHA256(the same key, PROOF_ANSWER + nonce). An id that's no
   * session's, or a question that didn't come straight from the home network (`fromHome` false: it could be an
   * impostor at that address passing the app's question on through the public one), is answered the same way from a
   * random key: the same shape after the same work, every session looked at either way, so the answer says nothing
   * about which sessions exist.
   */
  proof(id: string, nonce: string, fromHome: boolean): string {
    const wanted = Buffer.from(id, 'base64url');
    let key = randomBytes(32);
    const rows = this.db.prepare('SELECT token_hash FROM sessions').all() as unknown as { token_hash: string }[];
    for (const { token_hash } of rows) {
      const stored = Buffer.from(token_hash, 'hex');
      const named = proofMac(stored, PROOF_ID + nonce);
      if (named.length === wanted.length && timingSafeEqual(named, wanted) && fromHome) key = stored;
    }
    return proofMac(key, PROOF_ANSWER + nonce).toString('base64url');
  }

  list(accountId: number, currentId?: number): SessionInfo[] {
    const rows = this.db
      .prepare('SELECT id, device, platform, created_at, last_seen_at FROM sessions WHERE account_id = ? ORDER BY last_seen_at DESC, id DESC')
      .all(accountId) as unknown as Row[];
    return rows.map((r) => ({ id: r.id, device: r.device, platform: r.platform, createdAt: r.created_at, lastSeenAt: r.last_seen_at, current: r.id === currentId }));
  }

  /** Sign one device out; false when the account has no such session. */
  remove(accountId: number, sessionId: number): boolean {
    this.touched.delete(sessionId);
    return Number(this.db.prepare('DELETE FROM sessions WHERE id = ? AND account_id = ?').run(sessionId, accountId).changes) > 0;
  }

  removeAll(accountId: number) {
    this.db.prepare('DELETE FROM sessions WHERE account_id = ?').run(accountId);
  }
}
