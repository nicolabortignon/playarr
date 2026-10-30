import type { ReviewCandidate, ReviewGroup } from '@playarr/shared';
import { Check, Disc3, ExternalLink, Search } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { cn } from '../lib/cn';
import { formatTime } from '../lib/format';
import { useReview, useReviewAction } from '../lib/queries';
import { Dialog } from './Dialog';

/** Settings → Sources → "N to review": confirm, pick or search the album for doubtful matches. */
export function ReviewDialog({ sourceId, onClose }: { sourceId: number | null; onClose: () => void }) {
  const { data: groups } = useReview(sourceId);
  const group = groups?.[0];
  return (
    <Dialog open={sourceId !== null} onClose={onClose} title="Review matches" wide>
      {!groups ? (
        <div className="m-5 h-40 animate-pulse rounded-lg bg-paper/5" />
      ) : !group ? (
        <p className="p-5 text-[15px] text-paper-dim">Nothing left to review.</p>
      ) : (
        <ReviewGroupView key={group.groupKey} sourceId={sourceId!} group={group} remaining={groups.length} />
      )}
    </Dialog>
  );
}

function ReviewGroupView({ sourceId, group, remaining }: { sourceId: number; group: ReviewGroup; remaining: number }) {
  const action = useReviewAction(sourceId);
  const [chosen, setChosen] = useState(group.candidates[0]?.releaseId);
  const [artist, setArtist] = useState(group.artistName);
  const [album, setAlbum] = useState(group.albumTitle ?? '');
  useEffect(() => setChosen(group.candidates[0]?.releaseId), [group.candidates]);
  const candidate = group.candidates.find((c) => c.releaseId === chosen);

  const search = (e: FormEvent) => {
    e.preventDefault();
    action.mutate({ groupKey: group.groupKey, search: { artist, album } });
  };

  return (
    <div className="space-y-6 p-5">
      <div className="flex items-baseline justify-between gap-4">
        <div className="min-w-0">
          <div className="font-mono text-[11px] tracking-[0.2em] text-muted uppercase">Your files say</div>
          <div className="truncate text-[17px] text-paper">
            {group.albumTitle ?? 'No album'} <span className="text-muted">· {group.artistName}</span>
          </div>
        </div>
        <span className="shrink-0 font-mono text-[12px] text-muted">{remaining} to review</span>
      </div>

      {group.candidates.length > 0 ? (
        <div role="radiogroup" aria-label="Albums on MusicBrainz" className="space-y-1">
          {group.candidates.map((c) => (
            <button
              key={c.releaseId}
              type="button"
              role="radio"
              aria-checked={c.releaseId === chosen}
              onClick={() => setChosen(c.releaseId)}
              className={cn(
                'flex w-full items-start gap-3 rounded-lg border px-3 py-2 text-left transition',
                c.releaseId === chosen ? 'border-accent bg-accent/5' : 'border-line hover:bg-paper/[0.03]',
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] text-paper">
                  {c.title}
                  {c.disambiguation && <span className="text-muted"> ({c.disambiguation})</span>}
                </span>
                <span className="block text-[13px] text-muted">{summary(c).join(' · ')}</span>
              </span>
              <span className="shrink-0 pt-0.5 font-mono text-[12px] text-muted tabular">{Math.round(c.score * 100)}%</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted">No albums found on MusicBrainz for these names. Try other names below.</p>
      )}

      {candidate && <CandidateDetails candidate={candidate} />}

      {candidate && (
        <table className="w-full text-[14px]">
          <thead>
            <tr className="font-mono text-[11px] tracking-[0.15em] text-muted uppercase">
              <th className="pb-2 text-left font-normal">Your file</th>
              <th className="pb-2 text-left font-normal">On MusicBrainz</th>
            </tr>
          </thead>
          <tbody>
            {group.files.map((f) => {
              const t = candidate.tracks[candidate.matches[f.rel] ?? -1];
              return (
                <tr key={f.rel} className="border-t border-line">
                  <td className="py-1.5 pr-3 text-paper-dim">
                    {f.title} <span className="font-mono text-[12px] text-muted">{formatTime(f.duration)}</span>
                  </td>
                  <td className="py-1.5 text-paper">
                    {t ? (
                      <>
                        {t.position}. {t.title} <span className="font-mono text-[12px] text-muted">{formatTime(t.duration)}</span>
                      </>
                    ) : (
                      <span className="text-muted">not on this album</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <form onSubmit={search} className="flex flex-wrap items-end gap-2">
        <input value={artist} onChange={(e) => setArtist(e.target.value)} aria-label="Artist" placeholder="Artist" className="h-10 min-w-0 flex-1 rounded-lg border border-line bg-ink-900 px-3 text-[14px] text-paper outline-none focus:border-accent" />
        <input value={album} onChange={(e) => setAlbum(e.target.value)} aria-label="Album" placeholder="Album" className="h-10 min-w-0 flex-1 rounded-lg border border-line bg-ink-900 px-3 text-[14px] text-paper outline-none focus:border-accent" />
        <button type="submit" disabled={action.isPending || !artist || !album} className="inline-flex h-10 items-center gap-2 rounded-full border border-line px-4 text-[14px] text-paper hover:bg-paper/5 disabled:opacity-50">
          <Search className="size-4" /> Search
        </button>
      </form>

      <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
        <button
          type="button"
          disabled={action.isPending}
          onClick={() => action.mutate({ groupKey: group.groupKey, releaseId: null })}
          className="inline-flex h-10 items-center rounded-full border border-line px-5 text-[14px] text-paper hover:bg-paper/5 disabled:opacity-50"
        >
          Leave unmatched
        </button>
        <button
          type="button"
          disabled={action.isPending || !chosen}
          onClick={() => chosen && action.mutate({ groupKey: group.groupKey, releaseId: chosen })}
          className="inline-flex h-10 items-center gap-2 rounded-full bg-accent px-5 text-[14px] font-medium text-accent-ink disabled:opacity-50"
        >
          <Check className="size-4" /> Use this album
        </button>
      </div>
    </div>
  );
}

const regions = (() => {
  try {
    return new Intl.DisplayNames(undefined, { type: 'region' });
  } catch {
    return undefined;
  }
})();

/** MusicBrainz country codes, including its own XE (Europe) and XW (worldwide). */
function countryName(code: string | undefined): string | undefined {
  if (!code) return undefined;
  if (code === 'XE') return 'Europe';
  if (code === 'XW') return 'Worldwide';
  if (code === 'XU') return undefined;
  try {
    return regions?.of(code) ?? code;
  } catch {
    return code;
  }
}

/** "1998-04-20" → "20 Apr 1998", "1998-04" → "Apr 1998", "1998" stays. */
function releaseDate(date: string | undefined): string | undefined {
  if (!date) return undefined;
  const [y, m, d] = date.split('-').map(Number);
  if (!y) return date;
  if (!m) return String(y);
  const value = new Date(Date.UTC(y, m - 1, d || 1));
  return value.toLocaleDateString(undefined, { timeZone: 'UTC', year: 'numeric', month: 'short', ...(d ? { day: 'numeric' } : {}) });
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The second line of a candidate: who, when, where, on what. */
function summary(c: ReviewCandidate): string[] {
  const label = c.labels?.find((l) => l.name)?.name;
  return [
    c.artistName,
    releaseDate(c.date) ?? (c.year ? String(c.year) : undefined),
    countryName(c.country),
    label,
    c.format,
    c.type,
    plural(c.tracks.length, 'track'),
    c.status && c.status !== 'Official' ? c.status : undefined,
  ].filter((x): x is string => !!x);
}

/** Everything MusicBrainz says about the chosen edition, with a link to check it there. */
function CandidateDetails({ candidate: c }: { candidate: ReviewCandidate }) {
  const [coverFailed, setCoverFailed] = useState(false);
  useEffect(() => setCoverFailed(false), [c.coverUrl]);
  const firstYear = c.year && releaseDate(c.date)?.slice(-4) !== String(c.year) ? String(c.year) : undefined;
  const rows: [string, string | undefined][] = [
    ['Artist', c.artistName],
    ['Album', c.title],
    ['Edition', [c.releaseTitle, c.disambiguation].filter(Boolean).join(' · ') || undefined],
    ['Released', releaseDate(c.date)],
    ['First released', firstYear ?? (c.date ? undefined : c.year ? String(c.year) : undefined)],
    ['Country', countryName(c.country)],
    ['Label', c.labels?.map((l) => [l.name, l.catalogNumber].filter(Boolean).join(' · ')).join(', ') || undefined],
    ['Format', c.format],
    ['Type', c.type],
    ['Status', c.status],
    ['Tracks', String(c.tracks.length)],
    ['Barcode', c.barcode],
  ];
  return (
    <div className="flex gap-4 rounded-lg border border-line p-3">
      <div className="grid size-24 shrink-0 place-items-center overflow-hidden rounded-md bg-ink-800 text-muted">
        {c.coverUrl && !coverFailed ? (
          <img src={c.coverUrl} alt="" loading="lazy" className="size-full object-cover" onError={() => setCoverFailed(true)} />
        ) : (
          <Disc3 className="size-8" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
          {rows
            .filter(([, value]) => value)
            .map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="font-mono text-[11px] leading-5 tracking-[0.12em] text-muted uppercase">{label}</dt>
                <dd className="min-w-0 break-words text-paper-dim">{value}</dd>
              </div>
            ))}
        </dl>
        <a
          href={`https://musicbrainz.org/release/${encodeURIComponent(c.releaseId)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex items-center gap-1.5 text-[13px] text-accent hover:underline"
        >
          Open on MusicBrainz <ExternalLink className="size-3.5" />
        </a>
      </div>
    </div>
  );
}
