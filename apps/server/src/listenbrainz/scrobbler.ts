import type { ListenBrainzInfo, Track } from '@playarr/shared';
import type { DatabaseSync } from 'node:sqlite';
import type { CatalogStore } from '../catalog/store.ts';
import type { Library } from '../library/library.ts';

/** Each account's ListenBrainz link (account 1's under the plain key, as before accounts). */
export const listenBrainzKey = (account: number) => (account === 1 ? 'listenbrainz' : `listenbrainz:${account}`);
const API = 'https://api.listenbrainz.org/1';
const BATCH = 100;
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SENT = 1;
const NOT_SENT = 2;

interface Saved {
  token?: string;
  user?: string;
  enabled: boolean;
  /** Plays from this time on are sent (earlier ones only when asked). */
  since?: string;
  lastSentAt?: string;
  error?: string;
}

export class ListenBrainzError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** A play counts as a listen once heard for half the song or four minutes, as ListenBrainz asks. */
export const isListen = (seconds: number, duration: number) => seconds >= Math.min(240, duration / 2) && seconds >= 1;

/**
 * Sends what's played to the household's ListenBrainz account ("scrobbling"): it keeps your listening
 * public profile up to date, and makes ListenBrainz's recommendations (used by radio, similar artists
 * and playlist suggestions) learn from it.
 */
export class Scrobbler {
  private timer: NodeJS.Timeout | undefined;
  private sending: Promise<void> | null = null;
  /** No sending before this (ListenBrainz asked to slow down, or it was unreachable). */
  private pauseUntil = 0;

  constructor(
    private readonly db: DatabaseSync,
    private readonly store: Pick<CatalogStore, 'appSetting' | 'setAppSetting'>,
    private readonly library: Pick<Library, 'tracksByRecordings'>,
    private readonly opts: { log: { warn: (obj: object, msg: string) => void }; fetch?: typeof fetch; accounts?: () => number[] },
  ) {}

  private get fetch() {
    return this.opts.fetch ?? fetch;
  }

  private saved(account: number): Saved {
    try {
      return { enabled: false, ...(JSON.parse(this.store.appSetting(listenBrainzKey(account)) ?? '{}') as Partial<Saved>) };
    } catch {
      return { enabled: false };
    }
  }

  private save(account: number, s: Saved) {
    this.store.setAppSetting(listenBrainzKey(account), JSON.stringify(s));
  }

  info(account = 1): ListenBrainzInfo {
    const s = this.saved(account);
    const count = (where: string, ...params: string[]) =>
      (this.db.prepare(`SELECT COUNT(*) AS n FROM plays WHERE account_id = ? AND ${where}`).get(account, ...params) as { n: number }).n;
    const since = s.since ?? new Date().toISOString();
    return {
      connected: !!s.token,
      ...(s.user ? { user: s.user } : {}),
      enabled: s.enabled && !!s.token,
      pending: s.token ? count('listenbrainz IS NULL AND skipped = 0 AND played_at >= ?', since) : 0,
      sent: count(`listenbrainz = ${SENT}`),
      earlier: s.token ? count('listenbrainz IS NULL AND skipped = 0 AND played_at < ?', since) : 0,
      ...(s.lastSentAt ? { lastSentAt: s.lastSentAt } : {}),
      ...(s.error ? { error: s.error } : {}),
    };
  }

  /** Check a user token with ListenBrainz and save it; plays from now on are sent. */
  async connect(token: string, account = 1): Promise<ListenBrainzInfo> {
    const res = await this.fetch(`${API}/validate-token`, {
      headers: { Authorization: `Token ${token}` },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!res) throw new ListenBrainzError('Couldn’t reach ListenBrainz', 502);
    const body = (await res.json().catch(() => ({}))) as { valid?: boolean; user_name?: string };
    if (!res.ok || !body.valid) throw new ListenBrainzError('ListenBrainz doesn’t know this token');
    const before = this.saved(account);
    this.save(account, { token, user: body.user_name, enabled: true, since: before.since ?? new Date().toISOString() });
    this.kick();
    return this.info(account);
  }

  disconnect(account = 1): ListenBrainzInfo {
    const { since } = this.saved(account);
    this.save(account, { enabled: false, since });
    return this.info(account);
  }

  setEnabled(enabled: boolean, account = 1): ListenBrainzInfo {
    const s = this.saved(account);
    this.save(account, { ...s, enabled, error: enabled ? undefined : s.error });
    if (enabled) this.kick();
    return this.info(account);
  }

  /** Send the plays from before connecting too. */
  sendEarlier(account = 1): ListenBrainzInfo {
    const s = this.saved(account);
    this.save(account, { ...s, since: new Date(0).toISOString() });
    this.kick();
    return this.info(account);
  }

  start(everyMs = 60_000) {
    this.timer = setInterval(() => this.kick(), everyMs);
    this.timer.unref();
    this.kick();
  }

  stop() {
    clearInterval(this.timer);
  }

  /** Send what's waiting, soon. */
  kick(): Promise<void> {
    this.sending ??= this.sendAll()
      .catch((err) => this.opts.log.warn({ err }, 'ListenBrainz: sending listens failed'))
      .finally(() => (this.sending = null));
    return this.sending;
  }

  private async sendAll() {
    for (const account of this.opts.accounts?.() ?? [1]) await this.sendFor(account);
  }

  private async sendFor(account: number) {
    for (;;) {
      const s = this.saved(account);
      if (!s.enabled || !s.token || Date.now() < this.pauseUntil) return;
      const rows = this.db
        .prepare(
          `SELECT id, recording_id, played_at, seconds FROM plays
           WHERE account_id = ? AND listenbrainz IS NULL AND skipped = 0 AND played_at >= ? ORDER BY played_at LIMIT ?`,
        )
        .all(account, s.since ?? new Date().toISOString(), BATCH) as { id: number; recording_id: string; played_at: string; seconds: number }[];
      if (!rows.length) return;
      const tracks = new Map((await this.library.tracksByRecordings(rows.map((r) => r.recording_id))).map((t) => [t.recordingId, t]));
      const listens: { id: number; listen: object }[] = [];
      const skip: number[] = [];
      for (const r of rows) {
        const track = tracks.get(r.recording_id);
        if (track && isListen(r.seconds, track.duration)) listens.push({ id: r.id, listen: this.listen(track, r.played_at) });
        else skip.push(r.id);
      }
      this.mark(skip, NOT_SENT);
      if (listens.length && !(await this.submit(account, s.token, listens))) return;
      if (rows.length < BATCH) return;
    }
  }

  private listen(track: Track, playedAt: string) {
    return {
      listened_at: Math.floor(Date.parse(playedAt) / 1000),
      track_metadata: {
        artist_name: track.artistName,
        track_name: track.title,
        release_name: track.albumTitle,
        additional_info: {
          ...(MBID.test(track.recordingId) ? { recording_mbid: track.recordingId } : {}),
          duration_ms: Math.round(track.duration * 1000),
          tracknumber: track.trackNumber,
          media_player: 'Playarr',
          submission_client: 'Playarr',
        },
      },
    };
  }

  /** Returns whether to carry on. */
  private async submit(account: number, token: string, listens: { id: number; listen: object }[]): Promise<boolean> {
    const res = await this.fetch(`${API}/submit-listens`, {
      method: 'POST',
      headers: { Authorization: `Token ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ listen_type: listens.length === 1 ? 'single' : 'import', payload: listens.map((l) => l.listen) }),
      signal: AbortSignal.timeout(20_000),
    }).catch(() => null);
    if (res?.ok) {
      this.mark(
        listens.map((l) => l.id),
        SENT,
      );
      this.save(account, { ...this.saved(account), lastSentAt: new Date().toISOString(), error: undefined });
      return true;
    }
    if (res?.status === 401) {
      this.save(account, { ...this.saved(account), enabled: false, error: 'ListenBrainz no longer accepts the token: connect again with a new one.' });
      return false;
    }
    if (res?.status === 400) {
      // Something in this batch ListenBrainz won't take: don't send it again and again.
      this.opts.log.warn({ status: 400, body: await res.text().catch(() => '') }, 'ListenBrainz refused listens');
      this.mark(
        listens.map((l) => l.id),
        NOT_SENT,
      );
      return true;
    }
    // Busy, slow down or unreachable: try again later.
    const wait = Number(res?.headers.get('X-RateLimit-Reset-In'));
    this.pauseUntil = Date.now() + (Number.isFinite(wait) && wait > 0 ? wait * 1000 : 5 * 60_000);
    return false;
  }

  private mark(ids: number[], state: number) {
    if (!ids.length) return;
    this.db.prepare(`UPDATE plays SET listenbrainz = ? WHERE id IN (${ids.map(() => '?').join(',')})`).run(state, ...ids);
  }
}
