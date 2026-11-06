import { ChevronDown, Ellipsis, List, Quote } from 'lucide-react';
import { AnimatePresence, motion, useDragControls } from 'motion/react';
import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { useShallow } from 'zustand/react/shallow';
import { sized } from '../lib/api';
import { useOverlay } from '../lib/overlays';
import { useTempos } from '../lib/queries';
import { useUI } from '../lib/ui';
import { useColumnLayout } from '../lib/useMediaQuery';
import { playUpcoming } from '../player/actions';
import { useCurrentTrack, usePlayer } from '../player/store';
import { IconButton } from './Button';
import { Cover } from './Cover';
import { FavoriteButton } from './FavoriteButton';
import { FormatBadge } from './FormatBadge';
import { LyricsView } from './LyricsView';
import { Menu } from './Menu';
import { upNextMenu, useSongMenu } from './menus';
import { SeekBar, Transport } from './Transport';
import { SleepTimer } from './SleepTimer';
import { SongRow } from './SongRow';
import { TransitionView } from './TransitionView';

export function NowPlaying() {
  const open = useUI((s) => s.nowPlayingOpen);
  const setOpen = useUI((s) => s.setNowPlaying);
  const track = useCurrentTrack();
  // Escape closes it when it's on top: a menu or a dialog opened from it (Edit mix points, the next transition) first.
  useOverlay(open && !!track, () => setOpen(false));
  return <AnimatePresence>{open && track && <Sheet />}</AnimatePresence>;
}

function Sheet() {
  const setOpen = useUI((s) => s.setNowPlaying);
  const lyricsOpen = useUI((s) => s.lyricsOpen);
  const setLyrics = useUI((s) => s.setLyrics);
  const track = useCurrentTrack()!;
  const source = usePlayer((s) => s.source);
  const playing = usePlayer((s) => s.playing);
  const controls = useDragControls();
  const navigate = useNavigate();
  const columnFits = useColumnLayout();
  const close = () => setOpen(false);
  const go = (to: string) => {
    close();
    void navigate(to);
  };
  // The queue beside the page where there's room for it (as the iPad app does), else the Queue page.
  const openQueue = () => {
    if (!columnFits) return go('/queue');
    close();
    useUI.getState().setSideColumn('queue');
  };
  // The one song menu, for the song playing: no Play next or Add to queue; Open queue is this place's own.
  const menu = useSongMenu(track, { playing: true, go, own: [{ label: 'Open queue', icon: List, onSelect: openQueue }] });

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, []);

  return (
    <motion.div
      role="dialog"
      aria-modal
      aria-label="Now playing"
      // iPhone Safari 26 draws its translucent status bar and toolbar in this background color, as the topmost fixed
      // element at those edges (the film grain sits below it, index.css), rather than letting the page show through.
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
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,transparent_0%,color-mix(in_oklab,var(--color-ink-950)_50%,transparent)_55%,color-mix(in_oklab,var(--color-ink-950)_92%,transparent)_100%)]" />
      {/* The art fades into the ink of the bars around it: Safari's status bar and toolbar, or the installed app's. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[calc(env(safe-area-inset-top)+3rem)] bg-gradient-to-b from-ink-950 to-transparent md:hidden" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[calc(env(safe-area-inset-bottom)+3rem)] bg-gradient-to-t from-ink-950 to-transparent md:hidden" />

      <div className="relative mx-auto flex h-full max-w-6xl flex-col px-6 pt-[max(env(safe-area-inset-top),1rem)] pb-[max(env(safe-area-inset-bottom),1.5rem)] md:px-12">
        <header className="flex h-14 shrink-0 touch-none items-center justify-between" onPointerDown={(e) => controls.start(e)}>
          <IconButton label="Close now playing" onClick={close} className="text-paper">
            <ChevronDown className="size-5" />
          </IconButton>
          <div className="min-w-0 px-4 text-center">
            {/* Over the cover's blur, where muted would sink into the art: paper-dim (docs/design.md, Color). */}
            <div className="type-kicker text-paper-dim">Playing from</div>
            <button type="button" onClick={() => go(source?.href ?? `/albums/${track.albumId}`)} className="block max-w-full truncate type-small text-paper hover:underline">
              {source?.label ?? track.albumTitle}
            </button>
          </div>
          <div className="flex items-center">
            <SleepTimer />
            <IconButton label="Lyrics" aria-pressed={lyricsOpen} onClick={() => setLyrics(!lyricsOpen)} className={lyricsOpen ? 'text-accent' : 'text-paper'}>
              <Quote className="size-5" />
            </IconButton>
            {/* An icon button of the header, as Close and Lyrics: 20. */}
            <Menu label={`More for “${track.title}”`} className="text-paper" trigger={<Ellipsis className="size-5" />} items={menu} />
          </div>
        </header>

        <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto] items-center gap-6 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] md:grid-rows-1 md:gap-16">
          {lyricsOpen ? (
            <LyricsView key={track.id} track={track} className="py-4" />
          ) : (
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
                  className="w-full rounded-lg shadow-cover-hero ring-1 ring-paper/10"
                />
              </motion.div>
            </div>
          )}

          <div className="flex flex-col gap-6 md:gap-8">
            <div className="flex items-start gap-4">
              <div className="min-w-0 flex-1">
                <motion.h2
                  key={track.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="font-display text-3xl leading-[1.1] text-balance text-paper md:text-5xl"
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
            <div className="flex flex-col gap-2">
              <Transport size="lg" />
              <TransitionView className="self-center" />
            </div>
            <UpNext go={go} onOpenQueue={openQueue} />
          </div>
        </div>
      </div>
    </motion.div>
  );
}

/** The next few songs, on wide screens: the queue's rows, compact, with the same menu. */
function UpNext({ go, onOpenQueue }: { go: (to: string) => void; onOpenQueue: () => void }) {
  const ids = usePlayer(useShallow((s) => s.order.slice(s.pos + 1)));
  const queue = usePlayer((s) => s.queue);
  const shown = ids.slice(0, 4);
  const tempos = useTempos(shown.map((i) => queue[i]));
  if (!shown.length) return null;
  return (
    <div className="hidden md:block">
      <div className="mb-2 flex items-center justify-between">
        <span className="type-kicker text-muted">Up next</span>
        <button type="button" onClick={onOpenQueue} className="type-kicker text-muted hover:text-paper">
          Queue
        </button>
      </div>
      <ol className="-mx-2">
        {shown.map((queueIndex, i) => {
          const t = queue[queueIndex]!;
          return (
            <SongRow
              key={queueIndex}
              track={t}
              compact
              markCurrent={false}
              // Plain text: a link would open its page behind the sheet.
              subtitle={t.artistName}
              onPlay={() => playUpcoming(i)}
              bpm={tempos[t.recordingId]}
              menu={{ ...upNextMenu(i, ids.length), go }}
            />
          );
        })}
      </ol>
    </div>
  );
}
