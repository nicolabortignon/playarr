import type { SetupCode } from '@playarr/shared';
import { createHash, randomInt } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/** No 0/O or 1/I/L: read aloud or typed on a phone without mistakes. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const LENGTH = 8;
const VALID_MS = 7 * 86_400_000;

/** A code as typed: any case, with spaces or dashes. */
export const normalizeCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');
const hashCode = (code: string) => createHash('sha256').update(normalizeCode(code)).digest('hex');

/** One-time codes for choosing a first password, so admins never choose anyone's. */
export class SetupCodes {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}

  /** A new code for the account (any earlier one stops working), with its link on `origin`. */
  issue(accountId: number, origin: string): SetupCode {
    const code = Array.from({ length: LENGTH }, () => ALPHABET.charAt(randomInt(ALPHABET.length))).join('');
    const expiresAt = new Date(this.now() + VALID_MS).toISOString();
    this.db.prepare('DELETE FROM setup_codes WHERE account_id = ?').run(accountId);
    this.db
      .prepare('INSERT INTO setup_codes (code_hash, account_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run(hashCode(code), accountId, expiresAt, new Date(this.now()).toISOString());
    return { code, link: `${origin}/redeem?code=${code}`, expiresAt };
  }

  /** The account a code is for; undefined when it's wrong, used or expired. */
  accountFor(code: string): number | undefined {
    const row = this.db.prepare('SELECT account_id, expires_at FROM setup_codes WHERE code_hash = ?').get(hashCode(code)) as
      | { account_id: number; expires_at: string }
      | undefined;
    return row && Date.parse(row.expires_at) > this.now() ? row.account_id : undefined;
  }

  use(code: string) {
    this.db.prepare('DELETE FROM setup_codes WHERE code_hash = ?').run(hashCode(code));
  }
}
