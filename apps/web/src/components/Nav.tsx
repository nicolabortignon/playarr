import { Disc3, Home, Library, ListMusic, Search, type LucideIcon } from 'lucide-react';
import { NavLink } from 'react-router';
import { cn } from '../lib/cn';
import { formatDuration } from '../lib/format';
import { useHealth } from '../lib/queries';

const LINKS: { to: string; label: string; icon: LucideIcon }[] = [
  { to: '/', label: 'Home', icon: Home },
  { to: '/search', label: 'Search', icon: Search },
  { to: '/artists', label: 'Artists', icon: Library },
  { to: '/albums', label: 'Albums', icon: Disc3 },
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

export function Sidebar() {
  const { data: health } = useHealth();
  const lib = health?.library;
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-line bg-ink-900/80 px-4 pt-6 pb-[calc(88px+1.5rem)] backdrop-blur-xl md:flex">
      <div className="px-3">
        <Wordmark />
      </div>
      <nav className="mt-10 flex flex-col gap-0.5" aria-label="Main">
        {LINKS.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
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
        ))}
      </nav>

      <div className="mt-auto space-y-3 px-3">
        {lib && (
          <dl className="grid grid-cols-2 gap-x-3 gap-y-2 border-t border-line pt-4 font-mono text-[11px] text-muted">
            <div>
              <dt className="tracking-[0.15em] uppercase opacity-60">Tracks</dt>
              <dd className="text-paper-dim">{lib.tracks}</dd>
            </div>
            <div>
              <dt className="tracking-[0.15em] uppercase opacity-60">Albums</dt>
              <dd className="text-paper-dim">{lib.albums}</dd>
            </div>
            <div>
              <dt className="tracking-[0.15em] uppercase opacity-60">Runtime</dt>
              <dd className="text-paper-dim">{formatDuration(lib.durationSeconds)}</dd>
            </div>
            <div>
              <dt className="tracking-[0.15em] uppercase opacity-60">Size</dt>
              <dd className="text-paper-dim">{(lib.sizeBytes / 1e9).toFixed(1)} GB</dd>
            </div>
          </dl>
        )}
        <ConnectionStatus />
      </div>
    </aside>
  );
}

function ConnectionStatus() {
  const { data, isError } = useHealth();
  const items = [
    { label: 'Lidarr', ok: !isError && data?.lidarr.ok, detail: data?.lidarr.ok ? `v${data.lidarr.version}` : data?.lidarr.error },
    { label: 'Streaming', ok: !isError && data?.media.ok, detail: data?.media.ok ? data.media.source : data?.media.error },
  ];
  return (
    <div className="flex flex-col gap-1.5 font-mono text-[11px] text-muted">
      {items.map((i) => (
        <div key={i.label} className="flex items-center gap-2" title={i.detail}>
          <span
            className={cn(
              'size-1.5 rounded-full',
              data === undefined && !isError ? 'bg-muted' : i.ok ? 'bg-emerald-400 shadow-[0_0_8px_rgb(52_211_153/0.6)]' : 'bg-red-400',
            )}
          />
          {i.label}
          {!i.ok && data && <span className="truncate text-red-300/80">offline</span>}
        </div>
      ))}
    </div>
  );
}

export function BottomNav() {
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-ink-900/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden"
    >
      <div className="grid h-[60px] grid-cols-5">
        {LINKS.map(({ to, label, icon: Icon }) => (
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
