import { ListMusic, Maximize2, SkipForward, Volume1, Volume2, VolumeX } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router';
import { cn } from '../lib/cn';
import { useUI } from '../lib/ui';
import { useClock, useCurrentTrack, usePlayer } from '../player/store';
import { Cover } from './Cover';
import { FavoriteButton } from './FavoriteButton';
import { FormatBadge } from './FormatBadge';
import { Slider } from './Slider';
import { PlayPauseButton, SeekBar, Transport } from './Transport';

/** Desktop/tablet bottom bar. */
export function PlayerBar() {
  const track = useCurrentTrack();
  const open = useUI((s) => s.setNowPlaying);
  const navigate = useNavigate();
  const location = useLocation();
  const onQueue = location.pathname === '/queue';

  return (
    <footer className="fixed inset-x-0 bottom-0 z-40 hidden h-[88px] border-t border-line bg-ink-950/85 backdrop-blur-2xl md:block">
      {/* Accent glow bleeding up from the bar, tinted by the current cover. */}
      <div className="pointer-events-none absolute inset-x-0 -top-px h-px bg-gradient-to-r from-transparent via-accent/50 to-transparent" />
      <div className="grid h-full grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)] items-center gap-6 px-5">
        <div className="flex min-w-0 items-center gap-3.5">
          {track ? (
            <>
              <button type="button" onClick={() => open(true)} aria-label="Open now playing" className="group relative shrink-0">
                <Cover src={track.coverUrl} size={56} alt={track.albumTitle} className="size-14 rounded-[3px] shadow-lg ring-1 ring-paper/5" />
                <span className="absolute inset-0 grid place-items-center rounded-[3px] bg-black/50 opacity-0 transition group-hover:opacity-100">
                  <Maximize2 className="size-4" />
                </span>
              </button>
              <div className="min-w-0">
                <Link to={`/albums/${track.albumId}`} className="block truncate text-[15px] text-paper hover:underline">
                  {track.title}
                </Link>
                <Link to={`/artists/${track.artistId}`} className="block truncate text-[13px] text-muted hover:text-paper-dim hover:underline">
                  {track.artistName}
                </Link>
              </div>
              <FavoriteButton track={track} size="md" />
            </>
          ) : (
            <span className="font-mono text-[11px] tracking-[0.2em] text-muted uppercase">Nothing playing</span>
          )}
        </div>

        <div className="flex flex-col items-center gap-1">
          <Transport />
          <SeekBar compact className="w-full max-w-[640px]" />
        </div>

        <div className="flex items-center justify-end gap-2">
          {track && <FormatBadge format={track.format} className="mr-2 hidden lg:inline-flex" />}
          <button
            type="button"
            aria-label="Queue"
            aria-pressed={onQueue}
            onClick={() => (onQueue ? navigate(-1) : navigate('/queue'))}
            className={cn('grid size-9 place-items-center rounded-full transition hover:text-paper', onQueue ? 'text-accent' : 'text-muted')}
          >
            <ListMusic className="size-[18px]" />
          </button>
          <Volume />
        </div>
      </div>
    </footer>
  );
}

function Volume() {
  const volume = usePlayer((s) => s.volume);
  const muted = usePlayer((s) => s.muted);
  const setVolume = usePlayer((s) => s.setVolume);
  const toggleMute = usePlayer((s) => s.toggleMute);
  const Icon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  return (
    <div className="flex w-36 items-center gap-2">
      <button type="button" aria-label={muted ? 'Unmute' : 'Mute'} onClick={toggleMute} className="grid size-9 shrink-0 place-items-center rounded-full text-muted transition hover:text-paper">
        <Icon className="size-[18px]" />
      </button>
      <Slider
        label="Volume"
        value={muted ? 0 : volume}
        max={1}
        step={0.05}
        live
        onChange={setVolume}
        valueText={(v) => `${Math.round(v * 100)}%`}
        className="flex-1"
      />
    </div>
  );
}

/** Mobile mini player, sits above the bottom tab bar. */
export function MiniPlayer() {
  const track = useCurrentTrack();
  const open = useUI((s) => s.setNowPlaying);
  const next = usePlayer((s) => s.next);
  const time = useClock((s) => s.time);
  const duration = useClock((s) => s.duration);
  if (!track) return null;
  const pct = duration > 0 ? (time / duration) * 100 : 0;

  return (
    <div className="fixed inset-x-2 bottom-[calc(60px+env(safe-area-inset-bottom)+6px)] z-40 md:hidden">
      <div
        role="button"
        tabIndex={0}
        aria-label="Open now playing"
        onClick={() => open(true)}
        onKeyDown={(e) => e.key === 'Enter' && open(true)}
        className="relative flex h-[60px] items-center gap-3 overflow-hidden rounded-xl border border-paper/[0.07] bg-ink-800 pr-2 pl-2 shadow-2xl shadow-black/60"
      >
        {/* Tinted wash from the accent color. */}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-accent/15 to-transparent" />
        <Cover src={track.coverUrl} size={44} alt="" className="relative size-11 shrink-0 rounded-md" />
        <div className="relative min-w-0 flex-1">
          <div className="truncate text-[14px] text-paper">{track.title}</div>
          <div className="truncate text-[12px] text-muted">{track.artistName}</div>
        </div>
        <div className="relative flex items-center" onClick={(e) => e.stopPropagation()}>
          <FavoriteButton track={track} size="md" />
          <PlayPauseButton size="sm" className="bg-transparent text-paper hover:scale-100" />
          <button type="button" aria-label="Next" onClick={() => next()} className="grid size-10 place-items-center text-paper">
            <SkipForward className="size-5 fill-current" />
          </button>
        </div>
        <div className="absolute inset-x-3 bottom-0 h-[2px] rounded-full bg-paper/10">
          <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
        </div>
      </div>
    </div>
  );
}
