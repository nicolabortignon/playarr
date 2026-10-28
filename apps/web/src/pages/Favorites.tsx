import { Heart, Play, Shuffle } from 'lucide-react';
import { ErrorState, Skeleton } from '../components/Section';
import { TrackList } from '../components/TrackList';
import { formatDuration, plural } from '../lib/format';
import { useFavorites } from '../lib/queries';
import { usePlayer } from '../player/store';
import { PageTitle } from './Albums';

export function FavoritesPage() {
  const { data: favorites, error, isPending } = useFavorites();
  const playTracks = usePlayer((s) => s.playTracks);
  const total = favorites?.reduce((sum, t) => sum + t.duration, 0) ?? 0;

  return (
    <div className="max-w-5xl px-5 pt-8 md:px-10 md:pt-14">
      <PageTitle title="Favorites" count={favorites?.length} />
      {error && <ErrorState error={error} />}
      {isPending && (
        <div className="space-y-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-14" />
          ))}
        </div>
      )}
      {favorites && favorites.length === 0 && (
        <div className="mt-16 max-w-md">
          <Heart className="size-10 text-ink-600" strokeWidth={1.5} />
          <p className="mt-4 font-display text-3xl text-paper">Nothing hearted yet.</p>
          <p className="mt-2 text-sm text-muted">
            Tap the heart next to any song: in an album, the queue, the player or Now Playing. It shows up here, on every
            device.
          </p>
        </div>
      )}
      {favorites && favorites.length > 0 && (
        <>
          <div className="-mt-4 mb-8 flex flex-wrap items-center gap-3 md:-mt-6">
            <button
              type="button"
              onClick={() => playTracks(favorites, 0, { shuffle: false })}
              className="inline-flex h-12 items-center gap-2 rounded-full bg-accent pr-6 pl-5 font-medium text-accent-ink shadow-[0_10px_40px_-12px_var(--accent)] transition hover:brightness-110 active:scale-[0.98]"
            >
              <Play className="size-5 fill-current" /> Play
            </button>
            <button
              type="button"
              onClick={() => playTracks(favorites, 0, { shuffle: true })}
              className="inline-flex h-12 items-center gap-2 rounded-full border border-paper/15 px-5 text-paper transition hover:border-paper/35 hover:bg-paper/5"
            >
              <Shuffle className="size-[18px]" /> Shuffle
            </button>
            <span className="ml-1 font-mono text-[12px] text-muted">
              {plural(favorites.length, 'song')} · {formatDuration(total)}
            </span>
          </div>
          <div className="-mx-3">
            <TrackList tracks={favorites} variant="mixed" />
          </div>
        </>
      )}
    </div>
  );
}
