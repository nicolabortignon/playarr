import { BookmarkPlus, ListEnd, ListPlus, Loader2, Play, RefreshCw, Shuffle } from 'lucide-react';
import { useParams } from 'react-router';
import { Menu } from '../components/Menu';
import { MixCover } from '../components/Mixes';
import { ErrorState, Skeleton } from '../components/Section';
import { TrackList } from '../components/TrackList';
import { formatDuration, plural } from '../lib/format';
import { useMix, useRegenerateMix, useSaveMix } from '../lib/queries';
import { queueTracks } from '../player/actions';
import { usePlayer } from '../player/store';

/** A generated mix: why these songs, when it changes, and the songs. */
export function MixPage() {
  const key = useParams().key ?? '';
  const { data: mix, error, isPending } = useMix(key);
  const regenerate = useRegenerateMix(key);
  const save = useSaveMix(key);
  const playTracks = usePlayer((s) => s.playTracks);

  if (error) return <ErrorState error={error} />;
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

  return (
    <div className="px-5 pt-6 md:px-10 md:pt-14">
      <header className="flex flex-col gap-6 md:flex-row md:items-end md:gap-10">
        <MixCover
          mix={mix}
          size={256}
          className="mx-auto w-[min(64vw,256px)] shrink-0 animate-rise rounded-[4px] shadow-[0_30px_70px_-20px_rgb(0_0_0/0.9)] ring-1 ring-paper/10 md:mx-0 md:w-56 lg:w-64"
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

      <div className="mt-8 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={!mix.tracks.length}
          onClick={() => playTracks(mix.tracks, 0, { shuffle: false })}
          aria-label={`Play ${mix.title}`}
          className="inline-flex h-12 items-center gap-2 rounded-full bg-accent pr-6 pl-5 font-medium text-accent-ink shadow-[0_10px_40px_-12px_var(--accent)] transition hover:brightness-110 active:scale-[0.98] disabled:opacity-40"
        >
          <Play className="size-5 fill-current" /> Play
        </button>
        <button
          type="button"
          disabled={!mix.tracks.length}
          onClick={() => playTracks(mix.tracks, 0, { shuffle: true })}
          aria-label={`Shuffle ${mix.title}`}
          className="inline-flex h-12 items-center gap-2 rounded-full border border-paper/15 px-5 text-paper transition hover:border-paper/35 hover:bg-paper/5 disabled:opacity-40"
        >
          <Shuffle className="size-[18px]" /> Shuffle
        </button>
        <button
          type="button"
          disabled={regenerate.isPending}
          onClick={() => regenerate.mutate()}
          className="inline-flex h-12 items-center gap-2 rounded-full border border-paper/15 px-5 text-paper transition hover:border-paper/35 hover:bg-paper/5 disabled:opacity-60"
        >
          {regenerate.isPending ? <Loader2 className="size-[18px] animate-spin" /> : <RefreshCw className="size-[18px]" />}
          {regenerate.isPending ? 'Mixing…' : 'New mix'}
        </button>
        <Menu
          className="size-12 border border-paper/15 text-paper"
          label="Mix actions"
          items={[
            { label: save.isPending ? 'Saving…' : 'Save as playlist', icon: BookmarkPlus, onSelect: () => save.mutate() },
            { label: 'Play next', icon: ListPlus, onSelect: () => queueTracks(mix.tracks, 'next') },
            { label: 'Add to queue', icon: ListEnd, onSelect: () => queueTracks(mix.tracks, 'end') },
          ]}
        />
      </div>

      <div className="mt-8 -mx-3 max-w-5xl">
        <TrackList tracks={mix.tracks} variant="mixed" />
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
