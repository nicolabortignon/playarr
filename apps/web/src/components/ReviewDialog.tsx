import type { ReviewAction, ReviewCandidate, ReviewGroup } from '@playarr/shared';
import { AlertCircle, Check, Disc3, ExternalLink, Loader2, Search } from 'lucide-react';
import { useMutationState } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { cn } from '../lib/cn';
import { formatTime } from '../lib/format';
import { useReview, useReviewAction } from '../lib/queries';
import { Dialog } from './Dialog';
import { SlowLookup } from './SlowLookup';

/** What happened to the last album the user decided on, shown above the next one. */
type Saved = { id: number; text: string; state: 'saving' | 'done' | 'error'; error?: string };

/** Settings → Sources → "N to review": confirm, pick or search the album for doubtful matches. */
export function ReviewDialog({ sourceId, onClose }: { sourceId: number | null; onClose: () => void }) {
  const { data: loaded, error, refetch, isFetching } = useReview(sourceId);
  // Albums being saved stay off the list even if a refresh lands before the server has saved them.
  const saving = useMutationState({
    filters: { mutationKey: ['review-action', sourceId ?? 0], status: 'pending' },
    select: (m) => m.state.variables as ReviewAction | undefined,
  });
  const hidden = new Set(saving.filter((a) => a && !a.search).map((a) => a!.groupKey));
  const groups = loaded?.filter((g) => !hidden.has(g.groupKey));
  // Lives here, not in the album view: that view is replaced as soon as an album is decided on.
  const action = useReviewAction(sourceId ?? 0);
  const [saved, setSaved] = useState<Saved | null>(null);
  const counter = useRef(0);
  useEffect(() => setSaved(null), [sourceId]);

  // Drop the "Matched" note after a moment; errors stay until the next action.
  useEffect(() => {
    if (saved?.state !== 'done') return;
    const timer = setTimeout(() => setSaved((s) => (s?.id === saved.id ? null : s)), 4000);
    return () => clearTimeout(timer);
  }, [saved]);

  /** Choose an album or leave it unmatched: the next album shows at once, saving carries on above it. */
  const decide = (_group: ReviewGroup, next: ReviewAction, text: string) => {
    const id = ++counter.current;
    setSaved({ id, text, state: 'saving' });
    action.mutate(next, {
      onSuccess: () => setSaved((s) => (s?.id === id ? { ...s, state: 'done' } : s)),
      onError: (err) => setSaved((s) => (s?.id === id ? { ...s, state: 'error', error: err.message } : s)),
    });
  };

  const group = groups?.[0];
  return (
    <Dialog open={sourceId !== null} onClose={onClose} title="Review matches" wide>
      <SavedNote saved={saved} />
      {error && !groups ? (
        <div className="space-y-3 p-5" role="alert">
          <p className="text-[15px] text-red-300/90">Couldn’t load the albums to review: {(error as Error).message}</p>
          <button type="button" onClick={() => void refetch()} disabled={isFetching} className={SECONDARY}>
            {isFetching && <Loader2 className="size-4 animate-spin" />} Try again
          </button>
        </div>
      ) : !groups ? (
        <div className="space-y-3 p-5" aria-busy="true" aria-label="Loading albums to review">
          <div className="h-12 animate-pulse rounded-lg bg-paper/5" />
          <div className="h-16 animate-pulse rounded-lg bg-paper/5" />
          <div className="h-16 animate-pulse rounded-lg bg-paper/5" />
          <div className="h-40 animate-pulse rounded-lg bg-paper/5" />
        </div>
      ) : !group ? (
        <div className="space-y-4 p-5">
          <p className="text-[15px] text-paper-dim">Nothing left to review.</p>
          <div className="flex justify-end">
            <button type="button" onClick={onClose} className={PRIMARY}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <ReviewGroupView key={group.groupKey} group={group} remaining={groups.length} action={action} decide={decide} />
      )}
    </Dialog>
  );
}

const PRIMARY =
  'inline-flex h-10 items-center gap-2 rounded-full bg-accent px-5 text-[14px] font-medium text-accent-ink transition disabled:opacity-50';
const SECONDARY =
  'inline-flex h-10 items-center gap-2 rounded-full border border-line px-5 text-[14px] text-paper transition hover:bg-paper/5 disabled:opacity-50';

function SavedNote({ saved }: { saved: Saved | null }) {
  if (!saved) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'flex items-center gap-2 border-b border-line px-5 py-2 text-[13px]',
        saved.state === 'error' ? 'bg-red-500/10 text-red-200' : 'text-paper-dim',
      )}
    >
      {saved.state === 'saving' && <Loader2 className="size-3.5 shrink-0 animate-spin text-muted" />}
      {saved.state === 'done' && <Check className="size-3.5 shrink-0 text-emerald-400" />}
      {saved.state === 'error' && <AlertCircle className="size-3.5 shrink-0" />}
      <span className="min-w-0 truncate">
        {saved.state === 'saving' && `Saving: ${saved.text}…`}
        {saved.state === 'done' && `Saved: ${saved.text}`}
        {saved.state === 'error' && `Couldn’t save ${saved.text}: ${saved.error}. It’s back in the list.`}
      </span>
    </div>
  );
}

function ReviewGroupView({
  group,
  remaining,
  action,
  decide,
}: {
  group: ReviewGroup;
  remaining: number;
  action: ReturnType<typeof useReviewAction>;
  decide: (group: ReviewGroup, next: ReviewAction, text: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [chosen, setChosen] = useState(group.candidates[0]?.releaseId);
  const [artist, setArtist] = useState(group.artistName);
  const [album, setAlbum] = useState(group.albumTitle ?? '');
  // Background refreshes bring new arrays with the same albums: keep the choice unless it's gone (a search).
  useEffect(() => {
    if (!group.candidates.some((c) => c.releaseId === chosen)) setChosen(group.candidates[0]?.releaseId);
  }, [group.candidates, chosen]);
  const candidate = group.candidates.find((c) => c.releaseId === chosen);

  // A new album to decide on starts at the top of the dialog.
  useLayoutEffect(() => {
    root.current?.closest('[data-dialog-body]')?.scrollTo({ top: 0 });
  }, []);

  const searching = action.isPending && !!action.variables?.search && action.variables.groupKey === group.groupKey;
  const search = (e: FormEvent) => {
    e.preventDefault();
    if (searching || !artist.trim() || !album.trim()) return;
    action.mutate({ groupKey: group.groupKey, search: { artist: artist.trim(), album: album.trim() } });
  };
  const yourAlbum = `${group.albumTitle ?? 'No album'} · ${group.artistName}`;

  return (
    <motion.div
      ref={root}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="space-y-6 p-5"
    >
      <div className="flex items-baseline justify-between gap-4">
        <div className="min-w-0">
          <div className="font-mono text-[11px] tracking-[0.2em] text-muted uppercase">Your files say</div>
          <div className="truncate text-[17px] text-paper">
            {group.albumTitle ?? 'No album'} <span className="text-muted">· {group.artistName}</span>
          </div>
        </div>
        <span className="shrink-0 font-mono text-[12px] text-muted">{remaining} to review</span>
      </div>

      <div aria-busy={searching} className={cn('transition-opacity', searching && 'pointer-events-none opacity-50')}>
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
                  <span className="block text-[13px] text-muted">
                    {summary(c).join(' · ')}
                    {!c.detailed && <span className="ml-1.5 inline-block h-2.5 w-16 animate-pulse rounded-full bg-paper/10 align-middle" />}
                  </span>
                </span>
                <span className="shrink-0 pt-0.5 font-mono text-[12px] text-muted tabular">{Math.round(c.score * 100)}%</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted">No albums found on MusicBrainz for these names. Try other names below.</p>
        )}
      </div>

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

      <form onSubmit={search} className="space-y-2">
        <div className="flex flex-wrap items-end gap-2">
          <input value={artist} disabled={searching} onChange={(e) => setArtist(e.target.value)} aria-label="Artist" placeholder="Artist" className="h-10 min-w-0 flex-1 rounded-lg border border-line bg-ink-900 px-3 text-[14px] text-paper outline-none focus:border-accent disabled:opacity-60" />
          <input value={album} disabled={searching} onChange={(e) => setAlbum(e.target.value)} aria-label="Album" placeholder="Album" className="h-10 min-w-0 flex-1 rounded-lg border border-line bg-ink-900 px-3 text-[14px] text-paper outline-none focus:border-accent disabled:opacity-60" />
          <button type="submit" disabled={searching || !artist.trim() || !album.trim()} className={SECONDARY}>
            {searching ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
            {searching ? 'Searching…' : 'Search'}
          </button>
        </div>
        <SlowLookup active={searching} what="albums with these names" />
      </form>

      <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
        <button
          type="button"
          disabled={searching}
          onClick={() => decide(group, { groupKey: group.groupKey, releaseId: null }, `${yourAlbum} left unmatched`)}
          className={SECONDARY}
        >
          Leave unmatched
        </button>
        <button
          type="button"
          disabled={searching || !candidate}
          onClick={() =>
            candidate &&
            decide(group, { groupKey: group.groupKey, releaseId: candidate.releaseId }, `${candidate.title} · ${candidate.artistName}`)
          }
          className={PRIMARY}
        >
          <Check className="size-4" /> Use this album
        </button>
      </div>
    </motion.div>
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

/** Rows that only arrive with the edition details: shown as placeholders while those load. */
const DETAIL_ROWS = new Set(['Released', 'Country', 'Label', 'Format']);

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
            .filter(([label, value]) => value || (!c.detailed && DETAIL_ROWS.has(label)))
            .map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="font-mono text-[11px] leading-5 tracking-[0.12em] text-muted uppercase">{label}</dt>
                <dd className="min-w-0 break-words text-paper-dim">
                  {value ?? <span className="inline-block h-2.5 w-24 animate-pulse rounded-full bg-paper/10 align-middle" />}
                </dd>
              </div>
            ))}
        </dl>
        {!c.detailed && (
          <p role="status" className="mt-2 text-[12px] text-muted">
            Getting this edition’s details from MusicBrainz…
          </p>
        )}
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
