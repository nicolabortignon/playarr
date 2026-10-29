import { ChevronRight, Disc3, Download, Heart, Library as LibraryIcon, Plus, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router';
import { PlaylistCover } from '../components/PlaylistCover';
import { SectionHeader } from '../components/Section';
import { plural } from '../lib/format';
import { useFavorites, useHealth, usePlaylists, useRequests } from '../lib/queries';
import { useUI } from '../lib/ui';
import { PageTitle } from './Albums';

/** Everything that's "yours" in one place; the Library tab on phones. */
export function LibraryPage() {
  const { data: health } = useHealth();
  const { data: favorites } = useFavorites();
  const { data: playlists } = usePlaylists();
  const { data: requests } = useRequests();
  const openPicker = useUI((s) => s.openPlaylistPicker);
  const lib = health?.library;

  const rows: { to: string; label: string; icon: LucideIcon; detail?: string }[] = [
    { to: '/favorites', label: 'Favorites', icon: Heart, detail: favorites ? plural(favorites.length, 'song') : undefined },
    { to: '/artists', label: 'Artists', icon: LibraryIcon, detail: lib ? String(lib.artists) : undefined },
    { to: '/albums', label: 'Albums', icon: Disc3, detail: lib ? String(lib.albums) : undefined },
    ...(requests?.length ? [{ to: '/requests', label: 'Requests', icon: Download, detail: String(requests.length) }] : []),
  ];

  return (
    <div className="max-w-3xl px-5 pt-8 md:px-10 md:pt-14">
      <PageTitle title="Library" />
      <nav className="-mx-2 mb-12">
        {rows.map(({ to, label, icon: Icon, detail }) => (
          <Link key={to} to={to} className="flex items-center gap-4 rounded-lg px-2 py-3 transition hover:bg-paper/[0.04]">
            <span className="grid size-11 place-items-center rounded-md bg-ink-800 text-accent">
              <Icon className="size-5" />
            </span>
            <span className="flex-1 text-[17px] text-paper">{label}</span>
            {detail && <span className="font-mono text-[12px] text-muted">{detail}</span>}
            <ChevronRight className="size-4 text-muted" />
          </Link>
        ))}
      </nav>

      <SectionHeader title="Playlists" to="/playlists" />
      <div className="-mx-2">
        <button
          type="button"
          onClick={() => openPicker([])}
          className="flex w-full items-center gap-4 rounded-lg px-2 py-2.5 text-left transition hover:bg-paper/[0.04]"
        >
          <span className="grid size-14 place-items-center rounded-md border border-dashed border-paper/25 text-accent">
            <Plus className="size-5" />
          </span>
          <span className="text-[16px] text-paper">New playlist</span>
        </button>
        {playlists?.map((p) => (
          <Link key={p.id} to={`/playlists/${p.id}`} className="flex items-center gap-4 rounded-lg px-2 py-2.5 transition hover:bg-paper/[0.04]">
            <PlaylistCover cover={p.cover} size={56} name={p.name} className="size-14 shrink-0 rounded-md" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[16px] text-paper">{p.name}</span>
              <span className="block font-mono text-[12px] text-muted">{plural(p.trackCount, 'song')}</span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
