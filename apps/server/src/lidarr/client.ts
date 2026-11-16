import type {
  LidarrAlbum,
  LidarrArtist,
  LidarrCommand,
  LidarrLookupAlbum,
  LidarrLookupArtist,
  LidarrProfile,
  LidarrQueueItem,
  LidarrRootFolder,
  LidarrSearchHit,
  LidarrSystemStatus,
  LidarrTrack,
  LidarrTrackFile,
} from './types.ts';

export class LidarrError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Lidarr's answers that mean "not now" (restarting, or a proxy in front of it that can't reach it yet). */
const NOT_NOW = new Set([502, 503, 504]);

/** How long a call to Lidarr may take: a question or a change. */
const QUESTION_TIMEOUT_MS = 30_000;
/**
 * How long a whole list may take (every artist, every album, an artist's tracks and files, the queue). A large library
 * on a NAS takes Lidarr well over 30 s to list, and a catalog sync can't go on without the answer.
 */
const LIST_TIMEOUT_MS = 5 * 60_000;

export class LidarrClient {
  private baseUrl = '';
  private apiKey = '';

  constructor(
    baseUrl = '',
    apiKey = '',
    /** A question that didn't reach Lidarr, or that it couldn't answer just then, is asked once more after this long. */
    private readonly retryMs = 1000,
  ) {
    this.configure(baseUrl, apiKey);
  }

  /** Point the client at a Lidarr. Empty values leave it unconfigured. */
  configure(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.trim().replace(/\/+$/, '');
    this.apiKey = apiKey;
  }

  get configured(): boolean {
    return !!this.baseUrl && !!this.apiKey;
  }

  /**
   * A call to Lidarr's API. A question (a GET) that didn't get there, or got "not now", is asked once more after a
   * moment; one that ran out of time isn't (the caller's time is up), nor a change (it may have been made).
   */
  private async request(
    path: string,
    init: { method?: string; body?: unknown; timeoutMs?: number } = {},
    again = (init.method ?? 'GET') === 'GET',
  ): Promise<Response> {
    if (!this.configured) throw new LidarrError('No Lidarr source is set up. Add one in Settings → Sources.', 503);
    const retry = async () => {
      await new Promise((resolve) => setTimeout(resolve, this.retryMs));
      return this.request(path, init, false);
    };
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          'X-Api-Key': this.apiKey,
          Accept: 'application/json',
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(init.timeoutMs ?? QUESTION_TIMEOUT_MS),
      });
    } catch (err) {
      if (again && (err as Error).name !== 'TimeoutError') return retry();
      throw new LidarrError(`Cannot reach Lidarr at ${this.baseUrl}: ${(err as Error).message}`);
    }
    if (again && NOT_NOW.has(res.status)) {
      void res.body?.cancel();
      return retry();
    }
    if (res.status === 401) throw new LidarrError('Lidarr rejected the API key', 401);
    if (!res.ok) {
      // Lidarr returns { message } or a list of validation errors; surface them.
      const body = (await res.json().catch(() => null)) as
        | { message?: string }
        | { errorMessage?: string }[]
        | null;
      const detail = Array.isArray(body) ? body.map((e) => e.errorMessage).join('; ') : body?.message;
      throw new LidarrError(detail || `Lidarr ${path} → HTTP ${res.status}`, res.status);
    }
    return res;
  }

  private async get<T>(path: string, timeoutMs?: number): Promise<T> {
    return (await this.request(path, { timeoutMs })).json() as Promise<T>;
  }

  private async send<T>(method: 'POST' | 'PUT', path: string, body: unknown): Promise<T> {
    return (await this.request(path, { method, body })).json() as Promise<T>;
  }

  systemStatus() {
    return this.get<LidarrSystemStatus>('/api/v1/system/status');
  }

  rootFolders(timeoutMs?: number) {
    return this.get<LidarrRootFolder[]>('/api/v1/rootfolder', timeoutMs);
  }

  qualityProfiles(timeoutMs?: number) {
    return this.get<LidarrProfile[]>('/api/v1/qualityprofile', timeoutMs);
  }

  metadataProfiles(timeoutMs?: number) {
    return this.get<LidarrProfile[]>('/api/v1/metadataprofile', timeoutMs);
  }

  artists() {
    return this.get<LidarrArtist[]>('/api/v1/artist', LIST_TIMEOUT_MS);
  }

  albums() {
    return this.get<LidarrAlbum[]>('/api/v1/album', LIST_TIMEOUT_MS);
  }

  tracksForArtist(artistId: number) {
    return this.get<LidarrTrack[]>(`/api/v1/track?artistId=${artistId}`, LIST_TIMEOUT_MS);
  }

  trackFilesForArtist(artistId: number) {
    return this.get<LidarrTrackFile[]>(`/api/v1/trackfile?artistId=${artistId}`, LIST_TIMEOUT_MS);
  }

  albumsByIds(ids: number[]) {
    if (!ids.length) return Promise.resolve([] as LidarrAlbum[]);
    return this.get<LidarrAlbum[]>(`/api/v1/album?${ids.map((id) => `albumIds=${id}`).join('&')}`, LIST_TIMEOUT_MS);
  }

  /** Metadata search (artists + albums) via Lidarr's MusicBrainz-backed metadata server. */
  search(term: string) {
    return this.get<LidarrSearchHit[]>(`/api/v1/search?term=${encodeURIComponent(term)}`);
  }

  /** Exact lookup by MusicBrainz release-group id. */
  async albumByMbid(mbid: string): Promise<LidarrLookupAlbum | undefined> {
    const hits = await this.get<LidarrLookupAlbum[]>(`/api/v1/album/lookup?term=lidarr:${encodeURIComponent(mbid)}`);
    return hits.find((a) => a.foreignAlbumId === mbid) ?? hits[0];
  }

  async artistByMbid(mbid: string): Promise<LidarrLookupArtist | undefined> {
    const hits = await this.get<LidarrLookupArtist[]>(`/api/v1/artist/lookup?term=lidarr:${encodeURIComponent(mbid)}`);
    return hits.find((a) => a.foreignArtistId === mbid) ?? hits[0];
  }

  addAlbum(album: LidarrLookupAlbum) {
    return this.send<LidarrAlbum>('POST', '/api/v1/album', album);
  }

  monitorAlbums(albumIds: number[], monitored: boolean) {
    return this.send<unknown>('PUT', '/api/v1/album/monitor', { albumIds, monitored });
  }

  command(name: string, body: Record<string, unknown> = {}) {
    return this.send<LidarrCommand>('POST', '/api/v1/command', { name, ...body });
  }

  /** One track file, with the tags Lidarr reads from it (`audioTags`, which the list leaves out). */
  trackFile(id: number) {
    return this.get<LidarrTrackFile>(`/api/v1/trackfile/${id}`);
  }

  commandStatus(id: number) {
    return this.get<LidarrCommand>(`/api/v1/command/${id}`);
  }

  async queue(): Promise<LidarrQueueItem[]> {
    const page = await this.get<{ records: LidarrQueueItem[] }>('/api/v1/queue?page=1&pageSize=500', LIST_TIMEOUT_MS);
    return page.records;
  }

  /** Raw artwork response (image bytes). `filename` e.g. "poster.jpg", "cover.jpg". */
  mediaCover(kind: 'artist' | 'album', id: number, filename: string) {
    return this.request(`/api/v1/mediacover/${kind}/${id}/${encodeURIComponent(filename)}`);
  }
}
