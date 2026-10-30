import { execFile } from 'node:child_process';

export interface Fingerprint {
  duration: number;
  fingerprint: string;
}

export interface AcoustIdMatch {
  score: number;
  recordingId: string;
  title?: string;
  artistName?: string;
  artistId?: string;
  releaseGroups: { id: string; title: string; type?: string; secondaryTypes: string[] }[];
}

/** AcoustID lookups (https://acoustid.org/webservice): at most 3 requests per second. */
export class AcoustId {
  private last = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly key: () => string | undefined) {}

  get enabled(): boolean {
    return !!this.key();
  }

  lookup(fp: Fingerprint): Promise<AcoustIdMatch | null> {
    const run = async () => {
      const wait = this.last + 350 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
      const body = new URLSearchParams({
        client: this.key() ?? '',
        meta: 'recordings releasegroups',
        duration: String(Math.round(fp.duration)),
        fingerprint: fp.fingerprint,
      });
      const res = await fetch('https://api.acoustid.org/v2/lookup', { method: 'POST', body, signal: AbortSignal.timeout(15_000) });
      const data = (await res.json()) as {
        status: string;
        error?: { message: string };
        results?: {
          score: number;
          recordings?: {
            id: string;
            title?: string;
            artists?: { id: string; name: string }[];
            releasegroups?: { id: string; title: string; type?: string; secondarytypes?: string[] }[];
          }[];
        }[];
      };
      if (data.status !== 'ok') throw new Error(`AcoustID: ${data.error?.message ?? `HTTP ${res.status}`}`);
      const best = (data.results ?? []).filter((r) => r.recordings?.length).sort((a, b) => b.score - a.score)[0];
      const rec = best?.recordings?.[0];
      if (!best || !rec) return null;
      return {
        score: best.score,
        recordingId: rec.id,
        title: rec.title,
        artistName: rec.artists?.map((a) => a.name).join(', ') || undefined,
        artistId: rec.artists?.[0]?.id,
        releaseGroups: (rec.releasegroups ?? []).map((g) => ({ id: g.id, title: g.title, type: g.type, secondaryTypes: g.secondarytypes ?? [] })),
      };
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }
}

/** A Chromaprint fingerprint of a local file via fpcalc; null if it can't be computed. */
export function fpcalc(bin = 'fpcalc'): (path: string) => Promise<Fingerprint | null> {
  return (path) =>
    new Promise((resolve) => {
      execFile(bin, ['-json', path], { timeout: 60_000, maxBuffer: 1 << 20 }, (err, stdout) => {
        if (err) return resolve(null);
        try {
          const json = JSON.parse(stdout) as { duration?: number; fingerprint?: string };
          resolve(json.fingerprint && json.duration ? { duration: json.duration, fingerprint: json.fingerprint } : null);
        } catch {
          resolve(null);
        }
      });
    });
}

/** Whether fpcalc runs at all. */
export function hasFpcalc(bin = 'fpcalc'): Promise<boolean> {
  return new Promise((resolve) => execFile(bin, ['-version'], { timeout: 5000 }, (err) => resolve(!err)));
}
