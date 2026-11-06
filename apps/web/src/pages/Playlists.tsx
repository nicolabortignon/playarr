import type { PlaylistSummary } from '@playarr/shared';
import { ListMusic, Play, Plus } from 'lucide-react';
import { useRef, type CSSProperties } from 'react';
import { Link } from 'react-router';
import { useCardMenu, type CardMenuAt } from '../components/Cards';
import { ContextMenu } from '../components/Menu';
import { usePlaylistMenu } from '../components/menus';
import { PageHeader } from '../components/PageHeader';
import { PlaylistCover } from '../components/PlaylistCover';
import { CardSkeleton, EmptyState, ErrorState } from '../components/States';
import { cn } from '../lib/cn';
import { plural } from '../lib/format';
import { usePlaylists } from '../lib/queries';
import { useUI } from '../lib/ui';
import { playPlaylist } from '../player/actions';
import { GRID } from './Albums';

export function PlaylistsPage() {
  const { data: playlists, error, isPending, refetch } = usePlaylists();
  const openPicker = useUI((s) => s.openPlaylistPicker);

  return (
    <div className="px-5 pt-8 md:px-10 md:pt-14">
      <PageHeader title="Playlists" count={playlists?.length || undefined} />
      {error && <ErrorState error={error} onRetry={() => void refetch()} />}
      {playlists && !playlists.length ? (
        <EmptyState
          icon={ListMusic}
          title="Make a playlist for a mood, a trip or a friend."
          action={{ label: 'New playlist', icon: <Plus />, onClick: () => openPicker([]) }}
        />
      ) : (
        <div className={GRID}>
          <button
            type="button"
            onClick={() => openPicker([])}
            className="group flex aspect-square animate-rise flex-col items-center justify-center gap-3 rounded-cover border border-dashed border-paper/20 text-paper-dim transition hover:border-accent hover:text-paper"
          >
            <span className="grid size-12 place-items-center rounded-full bg-accent text-accent-ink transition group-hover:scale-105">
              <Plus className="size-5" />
            </span>
            New playlist
          </button>
          {isPending && Array.from({ length: 11 }, (_, i) => <CardSkeleton key={i} />)}
          {playlists?.map((p, i) => (
            <PlaylistCard key={p.id} playlist={p} style={{ animationDelay: `${(i + 1) * 35}ms` }} />
          ))}
        </div>
      )}
    </div>
  );
}

export function PlaylistCard({ playlist: p, style, className }: { playlist: PlaylistSummary; style?: CSSProperties; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const menu = useCardMenu(ref);
  // An empty playlist has nothing to queue: the browser's own menu stays.
  const hasMenu = p.trackCount > 0;
  return (
    <div ref={ref} className={cn('group relative animate-rise', hasMenu && 'long-press', className)} style={style} {...(hasMenu ? menu.events : {})}>
      <Link to={`/playlists/${p.id}`} className="block">
        <PlaylistCover
          cover={p.cover}
          size={220}
          name={p.name}
          className="rounded-cover shadow-cover ring-1 ring-paper/5"
        />
        <div className="mt-3 truncate type-body leading-snug text-paper">{p.name}</div>
        <div className="truncate type-meta text-muted">
          {plural(p.trackCount, 'song')}
          {p.mine ? '' : ` · ${p.owner}`}
        </div>
      </Link>
      {/* On the cover (a square as wide as the card), as on an album card, whatever the text below it. */}
      {hasMenu && (
        <div className="pointer-events-none absolute inset-x-0 top-0 aspect-square">
          <button
            type="button"
            aria-label={`Play ${p.name}`}
            onClick={() => void playPlaylist(p.id)}
            className="pointer-events-auto absolute right-2.5 bottom-2.5 grid size-11 translate-y-2 place-items-center rounded-full bg-accent text-accent-ink opacity-0 shadow-xl shadow-black/40 transition duration-300 ease-out-expo group-hover:translate-y-0 group-hover:opacity-100 hover:scale-105 focus-visible:translate-y-0 focus-visible:opacity-100 pointer-coarse:hidden"
          >
            <Play className="ml-0.5 size-5 fill-current" />
          </button>
        </div>
      )}
      {menu.menuAt && hasMenu && <PlaylistCardMenu playlist={p} at={menu.menuAt} onClose={menu.close} />}
    </div>
  );
}

/** The playlist's one menu (components/menus.ts), with Play and Shuffle first; its owner's actions are on its page. */
function PlaylistCardMenu({ playlist, at, onClose }: { playlist: PlaylistSummary; at: NonNullable<CardMenuAt>; onClose: () => void }) {
  const items = usePlaylistMenu(playlist, { card: true });
  return <ContextMenu items={items} label={`More for “${playlist.name}”`} at={at.at} keyboard={at.keyboard} onClose={onClose} />;
}
