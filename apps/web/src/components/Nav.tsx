import { ArrowDownToLine, Disc3, Download, Heart, Home, Library, LibraryBig, ListMusic, Plus, Search, Settings, Sparkles, type LucideIcon } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router';
import { cn } from '../lib/cn';
import { activeRequestCount, usePlaylists, useRequests } from '../lib/queries';
import { useUI } from '../lib/ui';

type NavItem = { to: string; label: string; icon: LucideIcon };

const LINKS: NavItem[] = [
  { to: '/', label: 'Home', icon: Home },
  { to: '/search', label: 'Search', icon: Search },
  { to: '/mixes', label: 'Made for you', icon: Sparkles },
  { to: '/artists', label: 'Artists', icon: Library },
  { to: '/albums', label: 'Albums', icon: Disc3 },
  { to: '/favorites', label: 'Favorites', icon: Heart },
  { to: '/downloads', label: 'Downloads', icon: ArrowDownToLine },
  { to: '/queue', label: 'Queue', icon: ListMusic },
];

/** Phones get four roomy tabs; Library gathers playlists, favorites, artists and albums. */
const MOBILE_LINKS: NavItem[] = [
  { to: '/', label: 'Home', icon: Home },
  { to: '/search', label: 'Search', icon: Search },
  { to: '/library', label: 'Library', icon: LibraryBig },
  { to: '/queue', label: 'Queue', icon: ListMusic },
];

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <span className="relative grid size-7 place-items-center rounded-full bg-[repeating-radial-gradient(circle,#2a2823_0_1px,#161512_1px_3px)] ring-1 ring-paper/10">
        <span className="size-2.5 rounded-full bg-accent shadow-[0_0_12px_var(--accent)]" />
      </span>
      <span className="font-display text-[1.6rem] leading-none tracking-tight text-paper">
        Playarr<span className="text-accent">.</span>
      </span>
    </span>
  );
}

/** The link a path belongs to ("/albums/12" → Albums): the one left showing when the links fold. */
export function activeLink(pathname: string, links: NavItem[] = LINKS): NavItem | undefined {
  return links.find(({ to }) => (to === '/' ? pathname === '/' : pathname === to || pathname.startsWith(`${to}/`)));
}

/**
 * The desktop sidebar: the wordmark, the links, Requests while there are some, and your playlists, all in one column
 * that scrolls, with Settings kept at the foot. As soon as the playlists scroll, the links fold up to the one you're on, held at the
 * top, so the playlists get the room; back at the top, they all open again.
 */
export function Sidebar() {
  const { data: requests } = useRequests();
  const active = activeRequestCount(requests);
  const { pathname } = useLocation();
  const current = activeLink(pathname);
  const onRequests = pathname === '/requests' || pathname.startsWith('/requests/');
  const nav = useRef<HTMLElement>(null);
  // While folded: the room left under the playlists so the column still scrolls (see onScroll).
  const [spare, setSpare] = useState<number>();
  const folded = spare !== undefined;
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const column = e.currentTarget;
    if (column.scrollTop <= 0) return setSpare(undefined);
    const links = nav.current;
    if (folded || !links) return;
    // Folding takes the links' height out from above the playlists. A list that overflows by less would stop
    // scrolling, with no way back up to open them again: room at the foot keeps it scrolling from where it is.
    const kept = links.querySelector<HTMLElement>('[aria-current="page"]')?.offsetHeight ?? 0;
    const overflow = column.scrollHeight - column.clientHeight;
    setSpare(Math.max(0, links.offsetHeight - kept - overflow + column.scrollTop));
  };
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-line bg-ink-900/80 px-4 pt-6 pb-[calc(88px+1rem)] backdrop-blur-xl md:flex">
      {/* No scroll anchoring: the links folding above the playlists mustn't scroll the column back to the top. */}
      <div onScroll={onScroll} className="scrollbar-none -mx-1 min-h-0 flex-1 overflow-y-auto px-1 [overflow-anchor:none]">
        {/* The wordmark scrolls away with the rest: the playlists get its room too. */}
        <div className="mb-8 px-3">
          <Wordmark />
        </div>
        <nav
          ref={nav}
          className={cn('flex flex-col', folded && 'sticky top-0 z-10 bg-ink-900 pb-2')}
          aria-label="Main"
          data-folded={folded}
        >
          {LINKS.map((item) => (
            <Fold key={item.to} open={!folded || item === current}>
              <SidebarLink item={item} />
            </Fold>
          ))}
          {(requests?.length ?? 0) > 0 && (
            <Fold open={!folded || onRequests}>
              <NavLink
                to="/requests"
                className={({ isActive }) =>
                  cn(
                    'relative flex h-10 items-center gap-3.5 rounded-md px-3 text-[15px] transition-colors',
                    !folded && 'mt-4',
                    isActive ? 'bg-paper/[0.06] text-paper' : 'text-paper-dim/70 hover:text-paper',
                  )
                }
              >
                <Download className="size-[18px]" strokeWidth={1.75} />
                Requests
                {active > 0 && (
                  <span className="ml-auto grid min-w-5 place-items-center rounded-full bg-accent px-1.5 font-mono text-[10px] leading-5 text-accent-ink">
                    {active}
                  </span>
                )}
              </NavLink>
            </Fold>
          )}
        </nav>
        <SidebarPlaylists />
        {!!spare && <div style={{ height: spare }} aria-hidden />}
      </div>

      <div className="mt-3 border-t border-line px-3 pt-3">
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            cn(
              '-mx-3 flex h-9 items-center gap-3 rounded-md px-3 text-[14px] transition-colors',
              isActive ? 'bg-paper/[0.06] text-paper' : 'text-paper-dim/70 hover:text-paper',
            )
          }
        >
          <Settings className="size-[17px]" strokeWidth={1.75} />
          Settings
        </NavLink>
      </div>
    </aside>
  );
}

/** One of the links, which shuts to nothing (out of reach of the keyboard too) while the links are folded. */
function Fold({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div
      inert={!open}
      className={cn(
        'grid transition-[grid-template-rows,opacity] duration-300 ease-out-expo',
        open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
      )}
    >
      <div className="min-h-0 overflow-hidden pb-0.5">{children}</div>
    </div>
  );
}

function SidebarLink({ item: { to, label, icon: Icon } }: { item: NavItem }) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className={({ isActive }) =>
        cn(
          'group relative flex h-10 items-center gap-3.5 rounded-md px-3 text-[15px] transition-colors',
          isActive ? 'bg-paper/[0.06] text-paper' : 'text-paper-dim/70 hover:text-paper',
        )
      }
    >
      {({ isActive }) => (
        <>
          <span
            className={cn(
              'absolute top-2 bottom-2 left-0 w-[3px] rounded-full bg-accent transition-transform duration-300 ease-out-expo',
              isActive ? 'scale-y-100' : 'scale-y-0',
            )}
          />
          <Icon className="size-[18px]" strokeWidth={isActive ? 2.25 : 1.75} />
          {label}
        </>
      )}
    </NavLink>
  );
}

function SidebarPlaylists() {
  const { data: playlists } = usePlaylists();
  const openPicker = useUI((s) => s.openPlaylistPicker);
  return (
    <div className="mt-6 flex flex-col">
      <div className="flex items-center justify-between px-3 pb-2">
        <NavLink
          to="/playlists"
          end
          className={({ isActive }) =>
            cn('font-mono text-[11px] tracking-[0.2em] uppercase transition', isActive ? 'text-paper' : 'text-muted hover:text-paper')
          }
        >
          Playlists
        </NavLink>
        <button
          type="button"
          aria-label="New playlist"
          title="New playlist"
          onClick={() => openPicker([])}
          className="grid size-7 place-items-center rounded-full text-muted transition hover:bg-paper/8 hover:text-paper"
        >
          <Plus className="size-4" />
        </button>
      </div>
      {playlists?.map((p) => (
        <NavLink
          key={p.id}
          to={`/playlists/${p.id}`}
          className={({ isActive }) =>
            cn(
              'block truncate rounded-md px-3 py-1.5 text-[14px] transition-colors',
              isActive ? 'bg-paper/[0.06] text-paper' : 'text-paper-dim/70 hover:text-paper',
            )
          }
        >
          {p.name}
        </NavLink>
      ))}
      {playlists?.length === 0 && <p className="px-3 text-[13px] text-muted">No playlists yet.</p>}
    </div>
  );
}

export function BottomNav() {
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-ink-900/[0.97] pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <div className="grid h-[60px] grid-cols-4">
        {MOBILE_LINKS.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              cn('flex flex-col items-center justify-center gap-1 text-[10px] tracking-wide transition-colors', isActive ? 'text-paper' : 'text-muted')
            }
          >
            {({ isActive }) => (
              <>
                <Icon className={cn('size-[22px]', isActive && 'text-accent')} strokeWidth={isActive ? 2.25 : 1.75} />
                {label}
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
