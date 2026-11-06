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
import { ListRow } from './SongRow';

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
                    onClick={() => {
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

/** A suggestion in the one row: press it to play it (when it's in the library), its own Add or Request on the right. */
function Row({ rec, index, onPlay, action }: { rec: RecommendedTrack; index: number; onPlay?: () => void; action: ReactNode }) {
  const albumId =
    rec.track?.albumId ??
    (rec.availability?.state === 'available' || rec.availability?.have !== undefined ? rec.availability?.albumId : undefined);
  return (
    <ListRow
      className="animate-rise"
      style={{ animationDelay: `${Math.min(index, 10) * 30}ms` }}
      lead={
        <span className="relative size-11 shrink-0">
          <Cover src={rec.coverUrl} size={44} alt="" label={rec.albumTitle} className="size-11 rounded-cover" />
          {onPlay && (
            <span className="absolute inset-0 grid place-items-center rounded-cover bg-ink-950/55 opacity-0 transition pointer-fine:group-hover:opacity-100">
              <Play aria-hidden className="size-4 fill-paper text-paper" />
            </span>
          )}
        </span>
      }
      title={rec.title}
      main={onPlay && { label: `Play ${rec.title}`, onClick: onPlay }}
      subtitle={
        <>
          <InlineLink to={artistHref(rec)}>{rec.artistName}</InlineLink>
          {rec.albumTitle && (
            <>
              {' '}
              <span className="text-ink-600">·</span>{' '}
              <InlineLink to={albumHref({ ...rec, albumId })} title={albumId ? undefined : `Find it in ${rec.artistName}’s discography`}>
                {rec.albumTitle}
              </InlineLink>
            </>
          )}
        </>
      }
      trailing={
        <>
          <span className="hidden w-56 shrink-0 truncate type-small text-muted lg:block" title={rec.because && `Similar to ${rec.because}`}>
            {rec.because && (
              <>
                <span className="type-badge">like</span> <span className="text-paper-dim">{rec.because}</span>
              </>
            )}
          </span>
          <span className="relative z-10 shrink-0">{action}</span>
        </>
      }
    />
  );
}
