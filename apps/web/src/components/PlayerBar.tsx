import { ListMusic, Maximize2, Play, Quote, SkipForward, Volume1, Volume2, VolumeX } from 'lucide-react';
import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { cn } from '../lib/cn';
import { useRecentAlbums } from '../lib/queries';
import { toast } from '../lib/toast';
import { useUI, type SideColumnView } from '../lib/ui';
import { useColumnLayout } from '../lib/useMediaQuery';
import { playAlbum } from '../player/actions';
import { useClock, useCurrentTrack, usePlayer } from '../player/store';
import { Button } from './Button';
import { Cover } from './Cover';
import { FavoriteButton } from './FavoriteButton';
import { FormatBadge } from './FormatBadge';
import { LuckyButton } from './LuckyButton';
import { Slider } from './Slider';
import { PlayPauseButton, SeekBar, Transport } from './Transport';

/**
 * Desktop/tablet bottom bar: the song (its cover opens Now Playing), the transport and the seek bar, then the format,
 * Queue and Lyrics, and the volume. With nothing playing, what to play instead: Resume and Feeling lucky.
 */
export function PlayerBar() {
  const track = useCurrentTrack();
  const open = useUI((s) => s.setNowPlaying);

  return (
    <footer className="fixed inset-x-0 bottom-0 z-40 hidden h-[88px] border-t border-line bg-ink-950/85 backdrop-blur-2xl md:block">
      {/* Accent glow bleeding up from the bar, tinted by the current cover. */}
      <div className="pointer-events-none absolute inset-x-0 -top-px h-px bg-gradient-to-r from-transparent via-accent/50 to-transparent" />
      <div className="grid h-full grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)] items-center gap-6 px-5">
        {track ? (
          <>
            <div className="flex min-w-0 items-center gap-3.5">
              <button type="button" onClick={() => open(true)} aria-label="Open now playing" className="group relative shrink-0">
                <Cover src={track.coverUrl} size={56} alt={track.albumTitle} className="size-14 rounded-cover shadow-lg ring-1 ring-paper/5" />
                <span className="absolute inset-0 grid place-items-center rounded-cover bg-black/50 opacity-0 transition group-hover:opacity-100">
                  <Maximize2 className="size-4" />
                </span>
              </button>
              <div className="min-w-0">
                <Link to={`/albums/${track.albumId}`} className="block truncate type-body text-paper hover:underline">
                  {track.title}
                </Link>
                <Link to={`/artists/${track.artistId}`} className="block truncate type-small text-muted hover:text-paper-dim hover:underline">
                  {track.artistName}
                </Link>
              </div>
              <FavoriteButton track={track} size="md" />
            </div>

            <div className="flex flex-col items-center gap-1">
              <Transport />
              <SeekBar compact className="w-full max-w-[640px]" />
            </div>
          </>
        ) : (
          <Idle />
        )}

        <div className="flex items-center justify-end gap-2">
          {track && <FormatBadge format={track.format} className="mr-2 hidden lg:inline-flex" />}
          <ColumnButton view="queue" />
          <ColumnButton view="lyrics" />
          <Volume />
        </div>
      </div>
    </footer>
  );
}

/**
 * Nothing playing (a device that hasn't played anything yet): instead of controls that do nothing, the album heard
 * last, on any device, with Resume to play it again, and Feeling lucky. Without a history, just Feeling lucky.
 */
function Idle() {
  const { data: recent } = useRecentAlbums();
  const last = recent?.[0];
  const [starting, setStarting] = useState(false);
  const resume = async () => {
    if (!last) return;
    setStarting(true);
    try {
      await playAlbum(last.id);
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setStarting(false);
    }
  };
  return (
    <>
      <div className="flex min-w-0 items-center gap-3.5">
        {last ? (
          <>
            <Cover src={last.coverUrl} size={56} alt="" className="size-14 shrink-0 rounded-cover shadow-lg ring-1 ring-paper/5" />
            <div className="min-w-0">
              <div className="type-kicker text-muted">Heard last</div>
              <Link to={`/albums/${last.id}`} className="block truncate type-body text-paper hover:underline">
                {last.title}
              </Link>
              <div className="truncate type-small text-muted">{last.artistName}</div>
            </div>
          </>
        ) : (
          <span className="type-kicker text-muted">Nothing playing</span>
        )}
      </div>
      <div className="flex items-center justify-center gap-3">
        {last && (
          <Button
            variant="primary"
            icon={<Play className="fill-current" />}
            onClick={() => void resume()}
            pending={starting}
            pendingLabel="Resuming…"
            aria-label={`Resume ${last.title}`}
          >
            Resume
          </Button>
        )}
        <LuckyButton variant={last ? 'secondary' : 'primary'} size="regular" />
      </div>
    </>
  );
}

/**
 * Queue or Lyrics: where there's room, they open and close the column beside the page (components/SideColumn.tsx),
 * as on the iPad app; narrower, Queue opens the Queue page and Lyrics Now Playing's words.
 */
function ColumnButton({ view }: { view: SideColumnView }) {
  const fits = useColumnLayout();
  const column = useUI((s) => s.sideColumn);
  const setColumn = useUI((s) => s.setSideColumn);
  const navigate = useNavigate();
  const onQueue = useLocation().pathname === '/queue';
  const hasTrack = usePlayer((s) => s.pos >= 0);
  const queue = view === 'queue';
  const pressed = fits ? column === view : queue && onQueue;
  const press = () => {
    if (fits) return setColumn(column === view ? null : view);
    if (queue) return onQueue ? navigate(-1) : navigate('/queue');
    useUI.getState().setLyrics(true);
    useUI.getState().setNowPlaying(true);
  };
  const Icon = queue ? ListMusic : Quote;
  return (
    <button
      type="button"
      aria-label={queue ? 'Queue' : 'Lyrics'}
      // A switch where it opens and closes something beside the page; narrower, Lyrics just opens Now Playing.
      aria-pressed={fits || queue ? pressed : undefined}
      disabled={!queue && !hasTrack}
      onClick={press}
      className={cn(
        'grid size-9 place-items-center rounded-full transition enabled:hover:text-paper disabled:opacity-40',
        pressed ? 'text-accent' : 'text-muted',
      )}
    >
      <Icon className="size-4.5" />
    </button>
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

/**
 * Mobile mini player, above the bottom tab bar: "Open now playing" (the cover and the song) beside its own controls,
 * buttons side by side rather than inside one another. The heart stays; Play and Next are 44 to tap.
 */
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
      <div className="relative flex h-[60px] items-center overflow-hidden rounded-xl border border-paper/[0.07] bg-ink-800 pr-1 shadow-2xl shadow-black/60">
        {/* Tinted wash from the accent color. */}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-accent/15 to-transparent" />
        <button
          type="button"
          aria-label="Open now playing"
          onClick={() => open(true)}
          // Its focus ring inside: the bar clips what's outside it.
          className="relative flex min-w-0 flex-1 items-center gap-3 self-stretch pr-1 pl-2 text-left focus-visible:-outline-offset-2"
        >
          <Cover src={track.coverUrl} size={44} alt="" className="size-11 shrink-0 rounded-cover" />
          <span className="min-w-0">
            <span className="block truncate type-body text-paper">{track.title}</span>
            <span className="block truncate type-small text-muted">{track.artistName}</span>
          </span>
        </button>
        <FavoriteButton track={track} size="md" className="relative" />
        <PlayPauseButton size="md" className="bg-transparent text-paper hover:scale-100" />
        <button type="button" aria-label="Next" onClick={() => next()} className="relative grid size-11 shrink-0 place-items-center text-paper">
          <SkipForward className="size-5 fill-current" />
        </button>
        <div className="pointer-events-none absolute inset-x-3 bottom-0 h-[2px] rounded-full bg-paper/10">
          <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
        </div>
      </div>
    </div>
  );
}
