import type { PlaylistSummary } from '@playarr/shared';
import { Play, Plus } from 'lucide-react';
import type { CSSProperties } from 'react';
import { Link } from 'react-router';
import { PlaylistCover } from '../components/PlaylistCover';
import { ErrorState, Skeleton } from '../components/Section';
import { api } from '../lib/api';
import { cn } from '../lib/cn';
import { plural } from '../lib/format';
import { queryClient } from '../lib/queryClient';
import { usePlaylists } from '../lib/queries';
import { useUI } from '../lib/ui';
import { usePlayer } from '../player/store';
import { GRID, PageTitle } from './Albums';

export async function playPlaylist(id: number, opts?: { shuffle?: boolean }) {
  const p = await queryClient.fetchQuery({ queryKey: ['playlist', id], queryFn: () => api.playlist(id) });
  const tracks = p.items.flatMap((i) => (i.track ? [i.track] : []));
  usePlayer.getState().playTracks(tracks, 0, opts);
}

export function PlaylistsPage() {
  const { data: playlists, error, isPending } = usePlaylists();
  const openPicker = useUI((s) => s.openPlaylistPicker);

  return (
    <div className="px-5 pt-8 md:px-10 md:pt-14">
      <PageTitle title="Playlists" count={playlists?.length} />
      {error && <ErrorState error={error} />}
      <div className={GRID}>
        <button
          type="button"
          onClick={() => openPicker([])}
          className="group flex aspect-square animate-rise flex-col items-center justify-center gap-3 rounded-[4px] border border-dashed border-paper/20 text-paper-dim transition hover:border-accent hover:text-paper"
        >
          <span className="grid size-12 place-items-center rounded-full bg-accent text-accent-ink transition group-hover:scale-105">
            <Plus className="size-6" />
          </span>
          New playlist
        </button>
        {isPending && Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="aspect-square" />)}
        {playlists?.map((p, i) => (
          <PlaylistCard key={p.id} playlist={p} style={{ animationDelay: `${(i + 1) * 35}ms` }} />
        ))}
      </div>
    </div>
  );
}

export function PlaylistCard({ playlist: p, style, className }: { playlist: PlaylistSummary; style?: CSSProperties; className?: string }) {
  return (
    <div className={cn('group relative animate-rise', className)} style={style}>
      <Link to={`/playlists/${p.id}`} className="block">
        <PlaylistCover
          cover={p.cover}
          size={220}
          name={p.name}
          className="rounded-[4px] shadow-[0_12px_32px_-12px_rgb(0_0_0/0.8)] ring-1 ring-paper/5 transition duration-500 ease-out-expo group-hover:-translate-y-1"
        />
        <div className="mt-3 truncate text-[15px] text-paper">{p.name}</div>
        <div className="truncate font-mono text-[12px] text-muted">{plural(p.trackCount, 'song')}</div>
      </Link>
      {p.trackCount > 0 && (
        <button
          type="button"
          aria-label={`Play ${p.name}`}
          onClick={() => void playPlaylist(p.id)}
          className="absolute right-2.5 bottom-[4.25rem] grid size-11 translate-y-2 place-items-center rounded-full bg-accent text-accent-ink opacity-0 shadow-xl shadow-black/40 transition duration-300 ease-out-expo group-hover:translate-y-0 group-hover:opacity-100 hover:scale-105 focus-visible:translate-y-0 focus-visible:opacity-100 max-md:hidden"
        >
          <Play className="ml-0.5 size-5 fill-current" />
        </button>
      )}
    </div>
  );
}
