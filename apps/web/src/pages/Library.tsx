import { ArrowDownToLine, ChartColumn, Disc3, Download, Heart, Library as LibraryIcon, Plus, Settings, Sparkles, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router';
import { IconButton } from '../components/Button';
import { NavRow } from '../components/NavRow';
import { PageHeader } from '../components/PageHeader';
import { PlaylistCover } from '../components/PlaylistCover';
import { SectionHeader } from '../components/Section';
import { plural } from '../lib/format';
import { STATS_PATH } from '../lib/links';
import { useFavorites, useHealth, usePlaylists, useRequests } from '../lib/queries';
import { useUI } from '../lib/ui';
import { useOffline } from '../player/offline';

/** Everything that's "yours" in one place; the Library tab on phones. */
export function LibraryPage() {
  const { data: health } = useHealth();
  const { data: favorites } = useFavorites();
  const { data: playlists } = usePlaylists();
  const { data: requests } = useRequests();
  const openPicker = useUI((s) => s.openPlaylistPicker);
  const lib = health?.library;
  const downloads = useOffline((s) => Object.keys(s.pins).length);

  const rows: { to: string; label: string; icon: LucideIcon; detail?: string }[] = [
    { to: '/mixes', label: 'Made for you', icon: Sparkles },
    { to: STATS_PATH, label: 'Your listening', icon: ChartColumn },
    ...(downloads ? [{ to: '/downloads', label: 'Downloads', icon: ArrowDownToLine, detail: String(downloads) }] : []),
    { to: '/favorites', label: 'Favorites', icon: Heart, detail: favorites ? plural(favorites.length, 'song') : undefined },
    { to: '/artists', label: 'Artists', icon: LibraryIcon, detail: lib ? String(lib.artists) : undefined },
    { to: '/albums', label: 'Albums', icon: Disc3, detail: lib ? String(lib.albums) : undefined },
    ...(requests?.length ? [{ to: '/requests', label: 'Requests', icon: Download, detail: String(requests.length) }] : []),
    { to: '/settings', label: 'Settings', icon: Settings },
  ];

  return (
    <div className="max-w-3xl px-5 pt-8 md:px-10 md:pt-14">
      <PageHeader
        title="Library"
        actions={
          <IconButton to="/settings" label="Settings" className="md:hidden">
            <Settings className="size-5" />
          </IconButton>
        }
      />
      <nav className="-mx-2 mb-12">
        {rows.map((row) => (
          <NavRow key={row.to} {...row} />
        ))}
      </nav>

      <SectionHeader title="Playlists" to="/playlists" />
      <div className="-mx-2">
        <button
          type="button"
          onClick={() => openPicker([])}
          className="flex w-full items-center gap-4 rounded-lg px-2 py-2.5 text-left transition hover:bg-paper/[0.04]"
        >
          <span className="grid size-14 place-items-center rounded-cover border border-dashed border-paper/25 text-accent">
            <Plus className="size-5" />
          </span>
          <span className="type-body text-paper">New playlist</span>
        </button>
        {playlists?.map((p) => (
          <Link key={p.id} to={`/playlists/${p.id}`} className="flex items-center gap-4 rounded-lg px-2 py-2.5 transition hover:bg-paper/[0.04]">
            <PlaylistCover cover={p.cover} size={56} name={p.name} className="size-14 shrink-0 rounded-cover" />
            <span className="min-w-0 flex-1">
              <span className="block truncate type-body text-paper">{p.name}</span>
              <span className="block type-meta text-muted">{plural(p.trackCount, 'song')}</span>
            </span>
          </Link>
        ))}
      </div>

      <p className="mt-12 type-small text-muted">
        Songs kept on this device:{' '}
        <Link to="/settings/playback" className="text-accent hover:underline">
          Settings → Playback
        </Link>
      </p>
    </div>
  );
}
