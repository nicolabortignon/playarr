import type { LastFmConnect, LastFmInfo, Track } from '@playarr/shared';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { CatalogStore } from '../catalog/store.ts';
import type { Library } from '../library/library.ts';
import { isListen } from '../listenbrainz/scrobbler.ts';

const API = 'https://ws.audioscrobbler.com/2.0/';
const AUTH_PAGE = 'https://www.last.fm/api/auth/';
/** The server's Last.fm API account: its key and shared secret. */
const APP_KEY = 'lastfm-app';
/** Each account's Last.fm link. */
export const lastFmKey = (account: number) => `lastfm:${account}`;
/** Last.fm takes up to 50 scrobbles at a time. */
const BATCH = 50;
/** Last.fm ignores plays from more than two weeks ago. */
const OLDEST_MS = 14 * 24 * 3600_000;
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SENT = 1;
const NOT_SENT = 2;

interface App {
  apiKey: string;
  secret: string;
}

interface Saved {
  session?: string;
  user?: string;
  enabled: boolean;
  /** Plays from this time on are sent (earlier ones only when asked). */
  since?: string;
  lastSentAt?: string;
  error?: string;
}

export class LastFmError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** What Last.fm answered with an error: its code (https://www.last.fm/api/errorcodes) and its words. */
class LastFmRefusal extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** Last.fm's own rule: a song longer than 30 seconds, heard for half its length or four minutes. */
export const isScrobble = (seconds: number, duration: number) => duration > 30 && isListen(seconds, duration);

/**
 * The signature Last.fm asks of every call it's to trust: the parameters but `format` and `callback`, sorted by name
 * (in ASCII order, so artist[10] comes before artist[1]), each name then its value, then the shared secret; its MD5.
 */
export function signature(params: Record<string, string>, secret: string): string {
  const text = Object.keys(params)
    .filter((name) => name !== 'format' && name !== 'callback')
    .sort()
    .map((name) => `${name}${params[name]}`)
    .join('');
  return createHash('md5').update(text + secret, 'utf8').digest('hex');
}

/**
 * Sends what's played to each account's Last.fm ("scrobbling"), as Scrobbler does to ListenBrainz. Accounts connect
 * through the server's own Last.fm API account, which an admin adds once: Last.fm gives one to anyone who asks
 * (last.fm/api/account/create), and a self-hosted server can't share one key's secret with every other.
 */
export class LastFm {
  private timer: NodeJS.Timeout | undefined;
  private sending: Promise<void> | null = null;
  /** No sending before this (Last.fm asked to slow down, or it was unreachable). */
  private pauseUntil = 0;

  constructor(
    private readonly db: DatabaseSync,
    private readonly store: Pick<CatalogStore, 'appSetting' | 'setAppSetting'>,
    private readonly library: Pick<Library, 'tracksByRecordings'>,
    private readonly opts: { log: { warn: (obj: object, msg: string) => void }; fetch?: typeof fetch; accounts?: () => number[]; now?: () => number },
  ) {}

  private get fetch() {
    return this.opts.fetch ?? fetch;
  }

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  private app(): App | undefined {
    try {
      const app = JSON.parse(this.store.appSetting(APP_KEY) || 'null') as App | null;
      return app?.apiKey && app.secret ? app : undefined;
    } catch {
      return undefined;
    }
  }

  private saved(account: number): Saved {
    try {
      return { enabled: false, ...(JSON.parse(this.store.appSetting(lastFmKey(account)) ?? '{}') as Partial<Saved>) };
    } catch {
      return { enabled: false };
    }
  }

  private save(account: number, s: Saved) {
    this.store.setAppSetting(lastFmKey(account), JSON.stringify(s));
  }

  /** The account's link; `admin` adds the server's API key. */
  info(account = 1, admin = false): LastFmInfo {
    const app = this.app();
    const s = this.saved(account);
    const count = (where: string, ...params: string[]) =>
      (this.db.prepare(`SELECT COUNT(*) AS n FROM plays WHERE account_id = ? AND ${where}`).get(account, ...params) as { n: number }).n;
    const since = s.since ?? new Date(this.now()).toISOString();
    const oldest = new Date(this.now() - OLDEST_MS).toISOString();
    return {
      available: !!app,
      ...(admin && app ? { apiKey: app.apiKey } : {}),
      connected: !!s.session,
      ...(s.user ? { user: s.user } : {}),
      enabled: s.enabled && !!s.session && !!app,
      pending: s.session ? count('lastfm IS NULL AND skipped = 0 AND played_at >= ?', since) : 0,
      sent: count(`lastfm = ${SENT}`),
      // Only the last two weeks': Last.fm ignores older plays.
      earlier: s.session ? count('lastfm IS NULL AND skipped = 0 AND played_at < ? AND played_at >= ?', since, oldest) : 0,
      ...(s.lastSentAt ? { lastSentAt: s.lastSentAt } : {}),
      ...(s.error ? { error: s.error } : {}),
    };
  }

  /**
   * The server's Last.fm API account, checked with Last.fm (a token asked for with it). A new key voids the sessions
   * made with the old one: their accounts connect again.
   */
  async setApp(apiKey: string, secret: string, account = 1): Promise<LastFmInfo> {
    try {
      await this.call({ method: 'auth.getToken' }, { apiKey, secret });
    } catch (err) {
      if (err instanceof LastFmRefusal) {
        if (err.code === 10) throw new LastFmError('Last.fm doesn’t know this API key');
        if (err.code === 13) throw new LastFmError('That shared secret isn’t this API key’s');
        if (err.code === 26) throw new LastFmError('Last.fm has suspended this API key');
        throw new LastFmError(`Last.fm refused it: ${err.message}`);
      }
      throw err;
    }
    const before = this.app();
    this.store.setAppSetting(APP_KEY, JSON.stringify({ apiKey, secret } satisfies App));
    if (before && before.apiKey !== apiKey) this.forgetSessions('The server’s Last.fm API account changed: connect again.');
    return this.info(account, true);
  }

  /** No Last.fm on this server any more: every account's session goes with it. */
  removeApp(account = 1): LastFmInfo {
    this.store.setAppSetting(APP_KEY, '');
    this.forgetSessions();
    return this.info(account, true);
  }

  private forgetSessions(error?: string) {
    for (const id of this.opts.accounts?.() ?? [1]) {
      const s = this.saved(id);
      if (s.session) this.save(id, { enabled: false, since: s.since, ...(error ? { error } : {}) });
    }
  }

  /** The first half of connecting: a token, and the Last.fm page where the account allows Playarr with it. */
  async connect(): Promise<LastFmConnect> {
    const app = this.requireApp();
    const { token } = (await this.call({ method: 'auth.getToken' })) as { token?: string };
    if (!token) throw new LastFmError('Last.fm gave no token', 502);
    return { url: `${AUTH_PAGE}?${new URLSearchParams({ api_key: app.apiKey, token })}`, token };
  }

  /** The second half, once the account has allowed Playarr on Last.fm: its session, saved; plays from now on are sent. */
  async finish(token: string, account = 1): Promise<LastFmInfo> {
    let session: { key?: string; name?: string } | undefined;
    try {
      ({ session } = (await this.call({ method: 'auth.getSession', token })) as { session?: { key?: string; name?: string } });
    } catch (err) {
      if (err instanceof LastFmRefusal) {
        if (err.code === 14) throw new LastFmError('Allow Playarr on Last.fm first, then come back here', 409);
        if (err.code === 15) throw new LastFmError('That took more than an hour: connect again');
        throw new LastFmError(`Last.fm refused it: ${err.message}`);
      }
      throw err;
    }
    if (!session?.key) throw new LastFmError('Last.fm gave no session', 502);
    const before = this.saved(account);
    this.save(account, { session: session.key, user: session.name, enabled: true, since: before.since ?? new Date(this.now()).toISOString() });
    void this.kick();
    return this.info(account);
  }

  disconnect(account = 1): LastFmInfo {
    const { since } = this.saved(account);
    this.save(account, { enabled: false, since });
    return this.info(account);
  }

  setEnabled(enabled: boolean, account = 1): LastFmInfo {
    const s = this.saved(account);
    this.save(account, { ...s, enabled, error: enabled ? undefined : s.error });
    if (enabled) void this.kick();
    return this.info(account);
  }

  /** Send the last two weeks' plays from before connecting too (Last.fm ignores older ones). */
  sendEarlier(account = 1): LastFmInfo {
    const s = this.saved(account);
    this.save(account, { ...s, since: new Date(this.now() - OLDEST_MS).toISOString() });
    void this.kick();
    return this.info(account);
  }

  start(everyMs = 60_000) {
    this.timer = setInterval(() => void this.kick(), everyMs);
    this.timer.unref();
    void this.kick();
  }

  stop() {
    clearInterval(this.timer);
  }

  /** Send what's waiting, soon. */
  kick(): Promise<void> {
    this.sending ??= this.sendAll()
      .catch((err) => this.opts.log.warn({ err }, 'Last.fm: sending plays failed'))
      .finally(() => (this.sending = null));
    return this.sending;
  }

  private requireApp(): App {
    const app = this.app();
    if (!app) throw new LastFmError('Last.fm isn’t set up on this server: an admin adds its API account first', 409);
    return app;
  }

  /** A signed call, its JSON; a LastFmRefusal for an error Last.fm answers, a LastFmError when it can't be reached. */
  private async call(params: Record<string, string>, app: App = this.requireApp()): Promise<unknown> {
    const signed: Record<string, string> = { ...params, api_key: app.apiKey };
    signed.api_sig = signature(signed, app.secret);
    signed.format = 'json';
    const res = await this.fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Playarr' },
      body: new URLSearchParams(signed).toString(),
      signal: AbortSignal.timeout(20_000),
    }).catch(() => null);
    if (!res) throw new LastFmError('Couldn’t reach Last.fm', 502);
    const body = (await res.json().catch(() => ({}))) as { error?: number; message?: string };
    if (typeof body.error === 'number') throw new LastFmRefusal(body.error, body.message ?? `error ${body.error}`);
    if (!res.ok) throw new LastFmError(`Last.fm answered ${res.status}`, 502);
    return body;
  }

  private async sendAll() {
    if (!this.app()) return;
    for (const account of this.opts.accounts?.() ?? [1]) await this.sendFor(account);
  }

  private async sendFor(account: number) {
    for (;;) {
      const s = this.saved(account);
      if (!s.enabled || !s.session || this.now() < this.pauseUntil) return;
      const rows = this.db
        .prepare(
          `SELECT id, recording_id, played_at, seconds FROM plays
           WHERE account_id = ? AND lastfm IS NULL AND skipped = 0 AND played_at >= ? ORDER BY played_at LIMIT ?`,
        )
        .all(account, s.since ?? new Date(this.now()).toISOString(), BATCH) as { id: number; recording_id: string; played_at: string; seconds: number }[];
      if (!rows.length) return;
      const tracks = new Map((await this.library.tracksByRecordings(rows.map((r) => r.recording_id))).map((t) => [t.recordingId, t]));
      const scrobbles: { id: number; track: Track; at: number }[] = [];
      const skip: number[] = [];
      const oldest = this.now() - OLDEST_MS;
      for (const r of rows) {
        const track = tracks.get(r.recording_id);
        const at = Date.parse(r.played_at);
        if (track && isScrobble(r.seconds, track.duration) && at >= oldest) scrobbles.push({ id: r.id, track, at });
        else skip.push(r.id);
      }
      this.mark(skip, NOT_SENT);
      if (scrobbles.length && !(await this.submit(account, s.session, scrobbles))) return;
      if (rows.length < BATCH) return;
    }
  }

  /** Returns whether to carry on. */
  private async submit(account: number, session: string, scrobbles: { id: number; track: Track; at: number }[]): Promise<boolean> {
    const params: Record<string, string> = { method: 'track.scrobble', sk: session };
    scrobbles.forEach(({ track, at }, i) => {
      params[`artist[${i}]`] = track.artistName;
      params[`track[${i}]`] = track.title;
      params[`timestamp[${i}]`] = String(Math.floor(at / 1000));
      params[`album[${i}]`] = track.albumTitle;
      params[`duration[${i}]`] = String(Math.round(track.duration));
      if (track.trackNumber) params[`trackNumber[${i}]`] = String(track.trackNumber);
      if (MBID.test(track.recordingId)) params[`mbid[${i}]`] = track.recordingId;
    });
    try {
      const answer = (await this.call(params)) as { scrobbles?: { scrobble?: Scrobbled | Scrobbled[] } };
      const each = answer.scrobbles?.scrobble;
      const results = Array.isArray(each) ? each : each ? [each] : [];
      // Each one Last.fm ignored (an artist or song it won't take, too old, the day's limit) isn't sent again.
      const ignored = new Set(results.flatMap((r, i) => (r.ignoredMessage?.code && r.ignoredMessage.code !== '0' ? [i] : [])));
      this.mark(scrobbles.filter((_, i) => !ignored.has(i)).map((s) => s.id), SENT);
      this.mark(scrobbles.filter((_, i) => ignored.has(i)).map((s) => s.id), NOT_SENT);
      this.save(account, { ...this.saved(account), lastSentAt: new Date(this.now()).toISOString(), error: undefined });
      return true;
    } catch (err) {
      if (err instanceof LastFmRefusal) {
        if (err.code === 9 || err.code === 4) {
          this.save(account, { ...this.saved(account), enabled: false, error: 'Last.fm no longer accepts Playarr for this account: connect again.' });
          return false;
        }
        if (err.code === 10 || err.code === 26) {
          // The server's API key: no account can send until an admin sees to it.
          this.opts.log.warn({ code: err.code }, `Last.fm refused the server’s API key: ${err.message}`);
          this.pauseUntil = this.now() + 3600_000;
          return false;
        }
        if (err.code === 11 || err.code === 16 || err.code === 29) {
          this.pauseUntil = this.now() + (err.code === 29 ? 10 : 5) * 60_000;
          return false;
        }
        // Something in this batch Last.fm won't take: don't send it again and again.
        this.opts.log.warn({ code: err.code }, `Last.fm refused plays: ${err.message}`);
        this.mark(
          scrobbles.map((s) => s.id),
          NOT_SENT,
        );
        return true;
      }
      // Unreachable: try again later.
      this.pauseUntil = this.now() + 5 * 60_000;
      return false;
    }
  }

  private mark(ids: number[], state: number) {
    if (!ids.length) return;
    this.db.prepare(`UPDATE plays SET lastfm = ? WHERE id IN (${ids.map(() => '?').join(',')})`).run(state, ...ids);
  }
}

interface Scrobbled {
  ignoredMessage?: { code?: string };
}
