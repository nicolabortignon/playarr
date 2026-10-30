import type { ReviewGroup } from '@playarr/shared';
import { Check, Search } from 'lucide-react';
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
                'flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition',
                c.releaseId === chosen ? 'border-accent bg-accent/5' : 'border-line hover:bg-paper/[0.03]',
              )}
            >
              <span className="min-w-0 flex-1 truncate text-[15px] text-paper">
                {c.title} <span className="text-muted">· {c.artistName}{c.year ? ` · ${c.year}` : ''}</span>
              </span>
              <span className="font-mono text-[12px] text-muted">{Math.round(c.score * 100)}% · {c.tracks.length} tracks</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted">No albums found on MusicBrainz for these names. Try other names below.</p>
      )}

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
