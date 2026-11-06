import { BookmarkPlus, ListEnd, ListPlus, RefreshCw } from 'lucide-react';
import { useNavigate, useParams } from 'react-router';
import { ActionRow, RowAction, usePlayState } from '../components/ActionRow';
import { MixCover } from '../components/Mixes';
import { BackButton, ErrorState, Skeleton } from '../components/Section';
import { TrackList } from '../components/TrackList';
import { formatDuration, plural } from '../lib/format';
import { useMix, useRegenerateMix, useSaveMix } from '../lib/queries';
import { queueTracks } from '../player/actions';
import { usePlayer } from '../player/store';

/** A generated mix: why these songs, when it changes, and the songs. */
export function MixPage() {
  const key = useParams().key ?? '';
  const { data: mix, error, isPending, refetch } = useMix(key);
  const regenerate = useRegenerateMix(key);
  const save = useSaveMix(key);
  const playTracks = usePlayer((s) => s.playTracks);
  const toggle = usePlayer((s) => s.toggle);
  const playState = usePlayState(`/mixes/${key}`);
  const navigate = useNavigate();

  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (isPending || !mix) {
    return (
      <div className="px-5 pt-6 md:px-10 md:pt-14" aria-busy="true">
        <div className="flex flex-col gap-6 md:flex-row md:items-end md:gap-10">
          <Skeleton className="mx-auto aspect-square w-[min(64vw,256px)] md:mx-0 md:w-56 lg:w-64" />
          <div className="flex-1 space-y-4">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-14 w-72" />
            <Skeleton className="h-4 w-96 max-w-full" />
          </div>
        </div>
      </div>
    );
  }

  const source = { label: mix.title, href: `/mixes/${mix.key}` };
  return (
    <div className="relative px-5 pt-6 md:px-10 md:pt-14">
      <BackButton fallback="/" className="absolute top-3 left-3 z-20" />
      <header className="flex flex-col gap-6 md:flex-row md:items-end md:gap-10">
        <MixCover
          mix={mix}
          size={256}
          className="mx-auto w-[min(64vw,256px)] shrink-0 animate-rise rounded-cover shadow-cover-hero ring-1 ring-paper/10 md:mx-0 md:w-56 lg:w-64"
        />
        <div className="min-w-0 flex-1 animate-rise [animation-delay:80ms]">
          <div className="font-mono text-[11px] tracking-[0.25em] text-paper-dim/70 uppercase">Made for you</div>
          <h1 className="mt-2 font-display text-[2.5rem] leading-[1.02] tracking-tight text-balance text-paper md:text-6xl lg:text-7xl">
            {mix.title}
          </h1>
          <p className="mt-3 max-w-2xl text-[15px] text-paper-dim/90">{mix.description}</p>
          <div className="mt-4 font-mono text-[12px] text-muted">
            {plural(mix.trackCount, 'song')} · {formatDuration(mix.duration)} · {changesLabel(mix.refreshesAt)}
          </div>
        </div>
      </header>

      <ActionRow
        className="mt-8"
        title={mix.title}
        disabled={!mix.tracks.length}
        state={playState}
        onPlay={() => (playState !== 'idle' ? toggle() : playTracks(mix.tracks, 0, { shuffle: false, source }))}
        onShuffle={() => playTracks(mix.tracks, 0, { shuffle: true, source })}
        action={
          <RowAction icon={<RefreshCw />} pending={regenerate.isPending} pendingLabel="Mixing…" onClick={() => regenerate.mutate()}>
            New mix
          </RowAction>
        }
        download={{
          item: { key: `mix:${mix.key}`, title: mix.title, subtitle: 'Mix', coverUrl: mix.covers[0], href: `/mixes/${mix.key}` },
          tracks: mix.tracks,
        }}
        menu={{
          label: 'Mix actions',
          items: [
            {
              label: 'Save as playlist',
              icon: BookmarkPlus,
              // Opens the new playlist, so it's clear what was made and where it lives.
              onSelect: () => !save.isPending && save.mutate(undefined, { onSuccess: (playlist) => navigate(`/playlists/${playlist.id}`) }),
            },
            { label: 'Play next', icon: ListPlus, onSelect: () => queueTracks(mix.tracks, 'next') },
            { label: 'Add to queue', icon: ListEnd, onSelect: () => queueTracks(mix.tracks, 'end') },
          ],
        }}
      />

      <div className="mt-8 -mx-3 max-w-5xl">
        <TrackList tracks={mix.tracks} variant="mixed" source={source} />
      </div>
    </div>
  );
}

/** "Changes in 40 min", "Changes in 9 h", "Changes on Monday". */
export function changesLabel(iso: string, now = Date.now()): string {
  const minutes = Math.max(1, Math.round((Date.parse(iso) - now) / 60_000));
  if (minutes < 90) return `Changes in ${minutes} min`;
  if (minutes < 24 * 60) return `Changes in ${Math.round(minutes / 60)} h`;
  return `Changes on ${new Date(iso).toLocaleDateString(undefined, { weekday: 'long' })}`;
}
