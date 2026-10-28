import { ChevronDown, Disc3, ListMusic, ListPlus, Mic2 } from 'lucide-react';
import { AnimatePresence, motion, useDragControls } from 'motion/react';
import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router';
import { sized } from '../lib/api';
import { formatTime } from '../lib/format';
import { useUI } from '../lib/ui';
import { useShallow } from 'zustand/react/shallow';
import { useCurrentTrack, usePlayer } from '../player/store';
import { Cover } from './Cover';
import { FavoriteButton } from './FavoriteButton';
import { FormatBadge } from './FormatBadge';
import { Menu } from './Menu';
import { SeekBar, Transport } from './Transport';

export function NowPlaying() {
  const open = useUI((s) => s.nowPlayingOpen);
  const track = useCurrentTrack();
  return <AnimatePresence>{open && track && <Sheet />}</AnimatePresence>;
}

function Sheet() {
  const setOpen = useUI((s) => s.setNowPlaying);
  const openPicker = useUI((s) => s.openPlaylistPicker);
  const track = useCurrentTrack()!;
  const playing = usePlayer((s) => s.playing);
  const controls = useDragControls();
  const navigate = useNavigate();
  const close = () => setOpen(false);
  const go = (to: string) => {
    close();
    navigate(to);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, []);

  return (
    <motion.div
      role="dialog"
      aria-modal
      aria-label="Now playing"
      className="fixed inset-0 z-50 overflow-hidden bg-ink-950"
      initial={{ y: '100%' }}
      animate={{ y: 0 }}
      exit={{ y: '100%' }}
      transition={{ type: 'spring', damping: 34, stiffness: 320, mass: 0.9 }}
      drag="y"
      dragControls={controls}
      dragListener={false}
      dragConstraints={{ top: 0, bottom: 0 }}
      dragElastic={{ top: 0, bottom: 0.6 }}
      onDragEnd={(_, info) => (info.offset.y > 120 || info.velocity.y > 600) && close()}
    >
      {/* Atmosphere: the cover itself, blown up and blurred. */}
      <AnimatePresence>
        <motion.img
          key={track.coverUrl ?? 'none'}
          src={sized(track.coverUrl, 300)}
          alt=""
          aria-hidden
          initial={{ opacity: 0 }}
          animate={{ opacity: 0.55 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 1.2 }}
          className="pointer-events-none absolute inset-0 h-full w-full scale-150 object-cover blur-[90px] saturate-150"
        />
      </AnimatePresence>
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,transparent_0%,rgb(10_9_8/0.5)_55%,rgb(10_9_8/0.92)_100%)]" />

      <div className="relative mx-auto flex h-full max-w-6xl flex-col px-6 pt-[max(env(safe-area-inset-top),1rem)] pb-[max(env(safe-area-inset-bottom),1.5rem)] md:px-12">
        <header className="flex h-14 shrink-0 touch-none items-center justify-between" onPointerDown={(e) => controls.start(e)}>
          <button type="button" aria-label="Close now playing" onClick={close} className="grid size-10 place-items-center rounded-full text-paper transition hover:bg-paper/10">
            <ChevronDown className="size-6" />
          </button>
          <div className="min-w-0 px-4 text-center">
            <div className="font-mono text-[10px] tracking-[0.25em] text-paper-dim/70 uppercase">Playing from</div>
            <button type="button" onClick={() => go(`/albums/${track.albumId}`)} className="block max-w-full truncate text-[13px] text-paper hover:underline">
              {track.albumTitle}
            </button>
          </div>
          <Menu
            className="text-paper"
            items={[
              { label: 'Add to playlist…', icon: ListPlus, onSelect: () => openPicker([track]) },
              { label: 'Go to album', icon: Disc3, onSelect: () => go(`/albums/${track.albumId}`) },
              { label: 'Go to artist', icon: Mic2, onSelect: () => go(`/artists/${track.artistId}`) },
              { label: 'Open queue', icon: ListMusic, onSelect: () => go('/queue') },
            ]}
          />
        </header>

        <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto] items-center gap-6 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] md:grid-rows-1 md:gap-16">
          <div
            className="flex h-full min-h-0 w-full touch-none items-center justify-center py-4 [container-type:size]"
            onPointerDown={(e) => controls.start(e)}
          >
            <motion.div
              key={track.albumId}
              initial={{ opacity: 0, scale: 0.92 }}
              animate={{ opacity: 1, scale: playing ? 1 : 0.86 }}
              transition={{ type: 'spring', damping: 22, stiffness: 180 }}
              className="aspect-square w-[min(100cqw,100cqh,560px)]"
            >
              <Cover
                src={track.coverUrl}
                size={560}
                alt={track.albumTitle}
                eager
                className="w-full rounded-lg shadow-[0_40px_80px_-20px_rgb(0_0_0/0.85)] ring-1 ring-paper/10"
              />
            </motion.div>
          </div>

          <div className="flex flex-col gap-6 md:gap-8">
            <div className="flex items-start gap-4">
              <div className="min-w-0 flex-1">
                <motion.h2
                  key={track.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="font-display text-[1.75rem] leading-[1.1] text-balance text-paper md:text-5xl"
                >
                  {track.title}
                </motion.h2>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
                  <button type="button" onClick={() => go(`/artists/${track.artistId}`)} className="text-lg text-paper-dim hover:text-paper hover:underline">
                    {track.artistName}
                  </button>
                  <FormatBadge format={track.format} />
                </div>
              </div>
              <FavoriteButton track={track} size="lg" className="-mr-2" />
            </div>
            <SeekBar />
            <Transport size="lg" />
            <UpNext onNavigate={close} />
          </div>
        </div>
      </div>
    </motion.div>
  );
}

function UpNext({ onNavigate }: { onNavigate: () => void }) {
  const upcoming = usePlayer(useShallow((s) => s.order.slice(s.pos + 1, s.pos + 5).map((i) => s.queue[i]!)));
  const pos = usePlayer((s) => s.pos);
  const jumpTo = usePlayer((s) => s.jumpTo);
  if (!upcoming.length) return null;
  return (
    <div className="hidden md:block">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-mono text-[11px] tracking-[0.2em] text-muted uppercase">Up next</span>
        <Link to="/queue" onClick={onNavigate} className="font-mono text-[11px] tracking-[0.15em] text-muted uppercase hover:text-paper">
          Queue
        </Link>
      </div>
      <ol>
        {upcoming.map((t, i) => (
          <li
            key={`${t.id}-${i}`}
            role="button"
            tabIndex={0}
            onClick={() => jumpTo(pos + 1 + i)}
            onKeyDown={(e) => e.key === 'Enter' && jumpTo(pos + 1 + i)}
            className="group flex w-full cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-left transition hover:bg-paper/[0.06]"
          >
            <Cover src={t.coverUrl} size={36} alt="" className="size-9 shrink-0 rounded-[3px]" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-paper">{t.title}</span>
              <span className="block truncate text-xs text-muted">{t.artistName}</span>
            </span>
            <FavoriteButton track={t} reveal />
            <span className="font-mono text-xs text-muted tabular">{formatTime(t.duration)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
