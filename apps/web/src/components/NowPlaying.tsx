import type { Track } from '@playarr/shared';
import { Blend, ChevronDown, Ellipsis, List, Moon, Quote } from 'lucide-react';
import { AnimatePresence, motion, useDragControls, useMotionTemplate, useMotionValue, useSpring } from 'motion/react';
import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { useNavigate } from 'react-router';
import { useShallow } from 'zustand/react/shallow';
import { sized } from '../lib/api';
import { cn } from '../lib/cn';
import { useReduceMotion } from '../lib/motion';
import { useOverlay } from '../lib/overlays';
import { useSongMap, useTempos } from '../lib/queries';
import { useUI } from '../lib/ui';
import { useColumnLayout, useMediaQuery } from '../lib/useMediaQuery';
import { closeNowPlaying, NOW_PLAYING, NOW_PLAYING_COVER } from '../lib/viewTransitions';
import { playUpcoming } from '../player/actions';
import { useBlend } from '../player/blend';
import { breath, energyAt, onPulse, songBeat } from '../player/pulse';
import { useSleep } from '../player/sleep';
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
  const track = useCurrentTrack();
  // Closed at once, its cover shrinking back into the player's (lib/viewTransitions.ts): a new presence, so the sheet
  // goes with the old one rather than sliding away in the transition's picture.
  const cut = useUI((s) => s.nowPlayingCut);
  // Escape closes it when it's on top: a menu or a dialog opened from it (Edit mix points, the next transition) first.
  useOverlay(open && !!track, closeNowPlaying);
  return <AnimatePresence key={cut}>{open && track && <Sheet />}</AnimatePresence>;
}

function Sheet() {
  const setOpen = useUI((s) => s.setNowPlaying);
  const lyricsOpen = useUI((s) => s.lyricsOpen);
  const setLyrics = useUI((s) => s.setLyrics);
  // Named while its cover grows out of the player's, or shrinks back into it (lib/viewTransitions.ts).
  const morph = useUI((s) => s.coverMorph === 'sheet');
  const track = useCurrentTrack()!;
  // Opened by growing the player's cover into it: in place at once, rather than sliding up, its cover already there.
  const [grewWith] = useState(() => (useUI.getState().nowPlayingGrown ? track.albumId : null));
  const source = usePlayer((s) => s.source);
  const playing = usePlayer((s) => s.playing);
  const controls = useDragControls();
  const navigate = useNavigate();
  const columnFits = useColumnLayout();
  // Dragged down, it slides away under the finger; leaving for a page, it slides away as the page changes.
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
      style={morph ? { viewTransitionName: NOW_PLAYING } : undefined}
      initial={grewWith !== null ? false : { y: '100%' }}
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
      <Backdrop coverUrl={track.coverUrl} />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,transparent_0%,color-mix(in_oklab,var(--color-ink-950)_50%,transparent)_55%,color-mix(in_oklab,var(--color-ink-950)_92%,transparent)_100%)]" />
      {/* The art fades into the ink of the bars around it: Safari's status bar and toolbar, or the installed app's. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[calc(env(safe-area-inset-top)+3rem)] bg-gradient-to-b from-ink-950 to-transparent md:hidden" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[calc(env(safe-area-inset-bottom)+3rem)] bg-gradient-to-t from-ink-950 to-transparent md:hidden" />

      <div className="relative mx-auto flex h-full max-w-6xl flex-col px-6 pt-[max(env(safe-area-inset-top),1rem)] pb-[max(env(safe-area-inset-bottom),1.5rem)] md:px-12">
        <header className="flex h-14 shrink-0 touch-none items-center justify-between" onPointerDown={(e) => controls.start(e)}>
          <IconButton label="Close now playing" onClick={closeNowPlaying} className="text-paper">
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
                initial={grewWith === track.albumId ? false : { opacity: 0, scale: 0.92 }}
                // Paused, the cover settles back (smaller, its shadow softer); playing lifts it again (plan 7 §3).
                animate={{ opacity: 1, scale: playing ? 1 : PAUSED_SCALE }}
                transition={{ type: 'spring', damping: 22, stiffness: 180 }}
                className="relative aspect-square w-[min(100cqw,100cqh,560px)]"
              >
                <BeatGlow track={track} playing={playing} />
                <CoverObject track={track} playing={playing} named={morph} />
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
            <SeekBar energy />
            <div className="flex flex-col gap-2">
              <Transport size="lg" />
              <MixLine />
            </div>
            <UpNext go={go} onOpenQueue={openQueue} />
          </div>
        </div>
      </div>
      <SleepWell />
    </motion.div>
  );
}

/** How far the cover settles back while the music is paused (as iOS's). */
const PAUSED_SCALE = 0.86;
/** The most the cover tilts towards the pointer, in degrees. */
const MAX_TILT = 2;

/**
 * Atmosphere: the cover itself, blown up and blurred, drifting slowly through its own colors (plan 7 §3), still under
 * Reduce Motion. A new cover fades in over the last.
 */
function Backdrop({ coverUrl }: { coverUrl?: string }) {
  const reduce = useReduceMotion();
  return (
    <div aria-hidden data-drift={!reduce || undefined} className={cn('pointer-events-none absolute inset-0', !reduce && 'animate-drift will-change-transform')}>
      <AnimatePresence>
        <motion.img
          key={coverUrl ?? 'none'}
          src={sized(coverUrl, 300)}
          alt=""
          initial={{ opacity: 0 }}
          animate={{ opacity: 0.55 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduce ? 0 : 1.2 }}
          className="absolute inset-0 h-full w-full scale-150 object-cover blur-[90px] saturate-150"
        />
      </AnimatePresence>
    </div>
  );
}

/** The glow's opacity at rest between breaths, and how much more a breath adds in the loudest phrases: barely there. */
const GLOW_REST = 0.08;
const GLOW_BREATH = 0.16;
/** How much a breath swells the glow. */
const GLOW_SWELL = 0.04;
/** The glow comes in over this long as the music plays (Now Playing opened, Play pressed), and goes as slowly paused. */
const GLOW_FADE_MS = 700;

/**
 * A soft glow of the accent behind the cover, breathing on each bar's downbeat (plan 7 §2): in over the end of a bar,
 * out from its downbeat, deeper in the loud phrases than the quiet ones (the song's energy, from its mix map). Only for
 * a song with a beat grid, never a flash, gone while paused, and not there at all under Reduce Motion.
 */
function BeatGlow({ track, playing }: { track: Track; playing: boolean }) {
  const reduce = useReduceMotion();
  const map = useSongMap(track, !reduce);
  const beat = useMemo(() => songBeat(map), [map]);
  const glow = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = glow.current;
    if (!el || !beat) return;
    if (!playing) {
      // Eased out from wherever its breath was; while playing, it's set every frame with nothing easing it.
      el.style.transition = `opacity ${GLOW_FADE_MS}ms ease-out`;
      el.style.opacity = '0';
      return;
    }
    el.style.transition = '';
    const from = performance.now();
    return onPulse(({ time }) => {
      const b = breath(beat, time);
      const coming = Math.min(1, (performance.now() - from) / GLOW_FADE_MS);
      el.style.opacity = String(coming * (GLOW_REST + GLOW_BREATH * (0.5 + 0.5 * energyAt(beat, time)) * b));
      el.style.transform = `scale(${1 + GLOW_SWELL * b})`;
    });
  }, [beat, playing]);

  if (reduce || !beat) return null;
  return (
    <div
      ref={glow}
      aria-hidden
      data-glow
      className="pointer-events-none absolute -inset-[7%] rounded-panel bg-accent opacity-0 blur-3xl will-change-[opacity,transform]"
    />
  );
}

/**
 * Under the transport: during a DJ blend, "Mixing into Teardrop", from its start until the song being left has faded
 * out of it (plan 7 §2); else what the next transition will be (TransitionView).
 */
function MixLine() {
  const blend = useBlend((s) => s.blend);
  if (!blend) return <TransitionView className="self-center" />;
  return (
    <p className="-my-2 inline-flex min-h-11 max-w-full min-w-0 items-center gap-2 self-center type-small text-paper-dim">
      <Blend className="size-3.5 shrink-0 text-muted" aria-hidden />
      <span className="truncate">Mixing into {blend.to.title}</span>
    </p>
  );
}

/**
 * Now Playing's cover, as an object (plan 7 §3): its shadow lifts while the music plays and softens when it's paused,
 * and with a mouse it tilts a degree or two towards the pointer, catching a faint sheen. Never on touch, and still under
 * Reduce Motion. `named` while it grows out of the player's cover or shrinks back into it.
 */
function CoverObject({ track, playing, named }: { track: Track; playing: boolean; named?: boolean }) {
  const reduce = useReduceMotion();
  const mouse = useMediaQuery('(hover: hover) and (pointer: fine)');
  const tilts = mouse && !reduce;
  const spring = { stiffness: 160, damping: 18, mass: 0.6 };
  const rotateX = useSpring(0, spring);
  const rotateY = useSpring(0, spring);
  const sheen = useSpring(0, spring);
  const x = useMotionValue(50);
  const y = useMotionValue(50);
  const light = useMotionTemplate`radial-gradient(circle at ${x}% ${y}%, color-mix(in oklab, var(--color-paper) 22%, transparent), transparent 62%)`;

  const follow = (e: PointerEvent<HTMLDivElement>) => {
    if (!tilts || e.pointerType !== 'mouse') return;
    const box = e.currentTarget.getBoundingClientRect();
    const px = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    const py = Math.min(1, Math.max(0, (e.clientY - box.top) / box.height));
    rotateY.set((px - 0.5) * 2 * MAX_TILT);
    rotateX.set(-(py - 0.5) * 2 * MAX_TILT);
    x.set(px * 100);
    y.set(py * 100);
    sheen.set(1);
  };
  const rest = () => {
    rotateX.set(0);
    rotateY.set(0);
    sheen.set(0);
  };
  useEffect(() => {
    if (!tilts) rest();
  }, [tilts]);

  return (
    <motion.div
      onPointerMove={follow}
      onPointerLeave={rest}
      style={{ ...(tilts ? { rotateX, rotateY, transformPerspective: 900 } : {}), ...(named ? { viewTransitionName: NOW_PLAYING_COVER } : {}) }}
      data-tilt={tilts || undefined}
      className="relative"
    >
      <Cover
        src={track.coverUrl}
        color={track.coverColor}
        size={560}
        alt={track.albumTitle}
        eager
        className={cn('w-full rounded-lg ring-1 ring-paper/10 transition-shadow duration-500', playing ? 'shadow-cover-hero' : 'shadow-cover')}
      />
      {tilts && <motion.div aria-hidden style={{ background: light, opacity: sheen }} className="pointer-events-none absolute inset-0 rounded-lg" />}
    </motion.div>
  );
}

/** How long the moon and "Sleep well" stay before the screen rests. */
const MOON_MS = 4000;
/** A goodnight older than this isn't said: Now Playing opened long after the music stopped. */
const SLEPT_LATELY_MS = 2000;

/**
 * The sleep timer's end (plan 7 §5): Now Playing dims to a moon and "Sleep well" for a moment, then the screen rests,
 * dark, until a touch, a key or the music playing again wakes it.
 */
function SleepWell() {
  const sleptAt = useSleep((s) => s.sleptAt);
  const playing = usePlayer((s) => s.playing);
  const reduce = useReduceMotion();
  const [moon, setMoon] = useState(false);
  // Said as it happens, not to Now Playing opened long after the music stopped.
  const [stale] = useState(() => (sleptAt !== null && Date.now() - sleptAt > SLEPT_LATELY_MS ? sleptAt : null));
  const resting = sleptAt !== null && sleptAt !== stale && !playing;

  useEffect(() => {
    if (stale !== null) useSleep.getState().wake();
  }, [stale]);
  // The moon and the words for a moment, then the screen rests.
  useEffect(() => {
    if (!resting) return setMoon(false);
    setMoon(true);
    const id = setTimeout(() => setMoon(false), MOON_MS);
    return () => clearTimeout(id);
  }, [resting, sleptAt]);
  // A key wakes it (a touch too, below), and so does the music playing again.
  useEffect(() => {
    if (!resting) return;
    const wake = () => useSleep.getState().wake();
    window.addEventListener('keydown', wake, true);
    return () => window.removeEventListener('keydown', wake, true);
  }, [resting]);
  useEffect(() => {
    if (playing) useSleep.getState().wake();
  }, [playing]);

  const fade = (seconds: number) => ({ duration: reduce ? 0 : seconds });
  return (
    <AnimatePresence>
      {resting && (
        <motion.div
          key="resting"
          role="status"
          aria-label="Sleep well"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={fade(1.2)}
          onPointerDown={(e) => {
            e.stopPropagation();
            useSleep.getState().wake();
          }}
          className="absolute inset-0 z-20 grid place-items-center bg-ink-950/90"
        >
          <AnimatePresence>
            {moon && (
              <motion.div key="moon" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade(1.5)} className="flex flex-col items-center text-center">
                <span className="grid size-14 place-items-center rounded-full bg-ink-800 text-paper-dim ring-1 ring-line">
                  <Moon className="size-6" />
                </span>
                <p className="mt-5 type-section-title text-paper">Sleep well</p>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
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
