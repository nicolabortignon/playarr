import type { RecommendedTrack } from '@playarr/shared';
import { Dices, Play, Plus } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { albumHref, artistHref } from '../lib/links';
import { usePlaylistMutations, usePlaylistRecommendations } from '../lib/queries';
import { usePlayer } from '../player/store';
import { Button } from './Button';
import { Cover } from './Cover';
import { RequestButton } from './Discover';
import { InlineLink } from './InlineLink';
import { SectionHeader, Skeleton } from './Section';

const MISSING_PREVIEW = 8;

/** "Songs like these" under a playlist: ListenBrainz neighbours, split into owned (add) and missing (request). */
export function PlaylistRecommendations({ playlistId, enabled }: { playlistId: number; enabled: boolean }) {
  const [variant, setVariant] = useState(0);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const { data, error, isPending, isFetching, refetch } = usePlaylistRecommendations(playlistId, variant, enabled);
  const { add } = usePlaylistMutations();
  const playTracks = usePlayer((s) => s.playTracks);

  if (!enabled || data?.seedCount === 0) return null;

  const owned = data?.owned.filter((r) => !added.has(r.recordingId)) ?? [];
  const missing = data?.missing ?? [];
  const shownMissing = showAll ? missing : missing.slice(0, MISSING_PREVIEW);
  const newMix = () => {
    setVariant((v) => v + 1);
    setShowAll(false);
  };

  return (
    <section className="mt-16 max-w-5xl" aria-label="Songs like these">
      <SectionHeader
        kicker="From ListenBrainz"
        title="Songs like these"
        action={
          <Button size="small" icon={<Dices className={cn(isFetching && 'animate-spin')} />} onClick={newMix} disabled={isFetching}>
            New mix
          </Button>
        }
      />

      {isPending && (
        <div className="space-y-2">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-14" />
          ))}
        </div>
      )}

      {error && !data && (
        <p className="text-sm text-muted">
          Couldn’t reach ListenBrainz. {(error as Error).message}{' '}
          <button type="button" onClick={() => void refetch()} className="text-accent hover:underline">
            Try again
          </button>
        </p>
      )}

      {data && !owned.length && !missing.length && (
        <p className="max-w-md text-sm text-muted">
          ListenBrainz doesn’t know these songs well enough to suggest anything yet. Try a new mix or add a few more songs.
        </p>
      )}

      <div className={cn('transition-opacity', isFetching && !isPending && 'opacity-60')}>
        {owned.length > 0 && (
          <Group title="Already in your library">
            {owned.map((rec, i) => (
              <Row
                key={rec.recordingId}
                rec={rec}
                index={i}
                onPlay={() => rec.track && playTracks([rec.track], 0, { shuffle: false })}
                action={
                  <Button
                    size="small"
                    icon={<Plus />}
                    aria-label={`Add ${rec.title} to playlist`}
                    disabled={add.isPending}
                    onClick={(e) => {
                      e.stopPropagation();
                      add.mutate(
                        { id: playlistId, tracks: [rec.track!] },
                        { onSuccess: () => setAdded((s) => new Set(s).add(rec.recordingId)) },
                      );
                    }}
                  >
                    Add
                  </Button>
                }
              />
            ))}
          </Group>
        )}

        {missing.length > 0 && (
          <Group title="Not in your library yet">
            {shownMissing.map((rec, i) => (
              <Row
                key={rec.recordingId}
                rec={rec}
                index={i}
                action={rec.album && rec.availability && <RequestButton album={rec.album} availability={rec.availability} />}
              />
            ))}
            {missing.length > MISSING_PREVIEW && (
              <li>
                <Button variant="ghost" size="small" onClick={() => setShowAll((s) => !s)} className="mt-1">
                  {showAll ? 'Show fewer' : `Show all ${missing.length}`}
                </Button>
              </li>
            )}
          </Group>
        )}
      </div>
    </section>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-6 first:mt-0">
      <h3 className="mb-2 type-kicker text-muted">{title}</h3>
      <ol className="-mx-3">{children}</ol>
    </div>
  );
}

function Row({ rec, index, onPlay, action }: { rec: RecommendedTrack; index: number; onPlay?: () => void; action: ReactNode }) {
  const albumId =
    rec.track?.albumId ??
    (rec.availability?.state === 'available' || rec.availability?.have !== undefined ? rec.availability?.albumId : undefined);
  return (
    <li
      className={cn(
        'group grid animate-rise grid-cols-[2.75rem_1fr_auto] items-center gap-3 rounded-md px-3 py-2 transition hover:bg-paper/[0.045] lg:grid-cols-[2.75rem_1fr_14rem_auto] lg:gap-4',
        onPlay && 'cursor-pointer',
      )}
      style={{ animationDelay: `${Math.min(index, 10) * 30}ms` }}
      onClick={onPlay}
    >
      <div className="relative">
        <Cover src={rec.coverUrl} size={44} alt="" label={rec.albumTitle} className="size-11 rounded-cover" />
        {onPlay && (
          <div className="absolute inset-0 grid place-items-center rounded-cover bg-black/50 opacity-0 transition group-hover:opacity-100">
            <Play className="size-4 fill-paper" />
          </div>
        )}
      </div>
      <div className="min-w-0">
        <div className="truncate text-[15px] text-paper">{rec.title}</div>
        <div className="truncate text-[13px] text-muted">
          <InlineLink to={artistHref(rec)}>{rec.artistName}</InlineLink>
          {rec.albumTitle && (
            <>
              {' '}
              <span className="text-ink-600">·</span>{' '}
              <InlineLink
                to={albumHref({ ...rec, albumId })}
                title={albumId ? undefined : `Find it in ${rec.artistName}’s discography`}
              >
                {rec.albumTitle}
              </InlineLink>
            </>
          )}
        </div>
      </div>
      <div className="hidden truncate text-[12px] text-muted lg:block" title={rec.because && `Similar to ${rec.because}`}>
        {rec.because && (
          <>
            <span className="font-mono text-[10px] tracking-wider uppercase">like</span>{' '}
            <span className="text-paper-dim">{rec.because}</span>
          </>
        )}
      </div>
      {action}
    </li>
  );
}
