import type { Album, Track } from '@playarr/shared';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { sized } from '../lib/api';
import { cn } from '../lib/cn';
import { reduceMotionNow } from '../lib/motion';
import { queryClient } from '../lib/queryClient';
import { toast } from '../lib/toast';
import { feelingLucky } from '../player/actions';
import { Button } from './Button';

/**
 * Feeling lucky: 15 songs put together now, a new set at every press. While they're picked the sparkles twinkle, and
 * covers flick past where its words were, like a hand flipping through a crate, landing on the first song's (plan 7 §5).
 * On Home, as the action that fills an empty queue, Made for you or Your listening, and in the player bar while nothing
 * plays.
 */
export function LuckyButton({
  variant = 'primary',
  size = 'large',
  className,
}: {
  /** Primary and large on a page; secondary and regular in the idle player bar, beside Resume. */
  variant?: 'primary' | 'secondary';
  size?: 'large' | 'regular';
  className?: string;
}) {
  const [picking, setPicking] = useState(false);
  const [flick, setFlick] = useState<Flick | null>(null);
  // Each press flicks afresh.
  const [presses, setPresses] = useState(0);
  const press = async () => {
    // Still under Reduce Motion: the sparkles say it's picking, and the music starting says what it found.
    const still = reduceMotionNow();
    const atHand = still ? [] : coversAtHand();
    setPicking(true);
    setPresses((n) => n + 1);
    setFlick(atHand.length ? { passing: atHand } : null);
    try {
      const covers = flickCovers(await feelingLucky());
      if (still || !covers.length) return setFlick(null);
      const landing = covers.at(-1)!;
      // Without covers at hand (nothing loaded yet), a few of the songs it found flick past instead.
      setFlick((f) => ({ passing: f?.passing ?? covers.slice(0, -1), landing }));
    } catch (err) {
      setFlick(null);
      toast((err as Error).message, 'error');
    } finally {
      setPicking(false);
    }
  };
  return (
    // While the songs are picked the sparkles say so; the button stays lit rather than dimming.
    <Button
      variant={variant}
      size={size}
      icon={<Twinkle on={picking} small={size !== 'large'} />}
      onClick={() => void press()}
      disabled={picking}
      aria-busy={picking}
      className={cn('disabled:cursor-progress disabled:opacity-100', className)}
      labelClassName="relative"
    >
      {/* Faded rather than hidden while the covers flick, so it still names the button. */}
      <span className={cn('transition-opacity duration-150', flick && 'opacity-0')}>Feeling lucky</span>
      {flick && <CoverFlick key={presses} {...flick} small={size !== 'large'} onDone={() => setFlick(null)} />}
    </Button>
  );
}

/** A cover Feeling lucky flicks past: its picture, and its color while that loads. */
export interface FlickCover {
  key: string;
  url?: string;
  color?: string;
}

/** What the button flicks through while it picks, and where it lands once it knows (the first song's cover). */
interface Flick {
  passing: FlickCover[];
  landing?: FlickCover;
}

const coverOf = (t: Pick<Track, 'coverUrl' | 'coverColor' | 'albumId'>): FlickCover => ({
  key: t.coverUrl ?? `album:${t.albumId}`,
  url: t.coverUrl,
  color: t.coverColor,
});

/** How many covers at hand to flick through while it picks. */
const AT_HAND = 8;

/**
 * Covers at hand to flick through while it picks: albums already loaded (Home's shelves, Albums, Jump back in, kept
 * from the last visit), shuffled; none when nothing is loaded yet.
 */
export function coversAtHand(): FlickCover[] {
  const lists = [...queryClient.getQueriesData<Album[]>({ queryKey: ['albums'] }), ...queryClient.getQueriesData<Album[]>({ queryKey: ['recent-albums'] })];
  const covers = new Map<string, FlickCover>();
  for (const [, albums] of lists) {
    for (const a of Array.isArray(albums) ? albums : []) if (a.coverUrl && !covers.has(a.coverUrl)) covers.set(a.coverUrl, coverOf({ ...a, albumId: a.id }));
  }
  const all = [...covers.values()];
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j]!, all[i]!];
  }
  return all.slice(0, AT_HAND);
}

/** The covers to flick past: up to three of the other songs' albums, each once, then the first song's, where it lands. */
export function flickCovers(tracks: Track[]): FlickCover[] {
  const [first, ...rest] = tracks;
  if (!first) return [];
  const landing = coverOf(first);
  const passing: FlickCover[] = [];
  for (const t of rest) {
    const c = coverOf(t);
    if (c.key !== landing.key && !passing.some((p) => p.key === c.key)) passing.push(c);
    if (passing.length === 3) break;
  }
  return [...passing, landing];
}

/** How long each cover shows as they flick past, how many pass at least, and how long the one it lands on stays. */
const FLICK_MS = 140;
const MIN_FLICKS = 3;
const LANDED_MS = 900;

/**
 * The covers flicking past in the button, each tipping forward off the front of the crate to show the next, for as long
 * as it picks (three at least), until it settles on the first song's.
 */
function CoverFlick({ passing, landing, small, onDone }: Flick & { small: boolean; onDone: () => void }) {
  const [step, setStep] = useState(0);
  const others = landing ? passing.filter((c) => c.key !== landing.key) : passing;
  const landed = !!landing && step >= Math.min(MIN_FLICKS, others.length);
  useEffect(() => {
    if (landing?.url) new Image().src = sized(landing.url, 64)!;
  }, [landing?.url]);
  useEffect(() => {
    const id = landed ? setTimeout(onDone, LANDED_MS) : setTimeout(() => setStep((n) => n + 1), FLICK_MS);
    return () => clearTimeout(id);
  }, [step, landed]);
  const c = landed ? landing : others[step % others.length]!;
  return (
    <span
      aria-hidden
      data-flick={landed ? 'landed' : 'flicking'}
      className={cn('pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 perspective-near', small ? 'size-7' : 'size-8')}
    >
      <AnimatePresence initial={false}>
        <motion.span
          key={landed ? 'landed' : step}
          data-cover={c.key}
          initial={{ opacity: 0.5, scale: 0.86 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ rotateX: 80, opacity: 0, transition: { duration: 0.16, ease: 'easeIn' } }}
          transition={landed ? { type: 'spring', stiffness: 520, damping: 18 } : { duration: 0.1 }}
          style={{ transformOrigin: '50% 100%', backgroundColor: c.color, backgroundImage: c.url ? `url(${sized(c.url, 64)})` : undefined }}
          className="absolute inset-0 rounded-cover bg-ink-700 bg-cover bg-center shadow-cover"
        />
      </AnimatePresence>
    </span>
  );
}

/** A four-pointed star with curved sides, centered on 0,0, reaching 1 out. */
const STAR = 'M0-1C.2-.2.2-.2 1 0 .2.2.2.2 0 1-.2.2-.2.2-1 0-.2-.2-.2-.2 0-1Z';
/** Where Feeling lucky's three stars sit in its 24-unit icon, how big, and when each twinkles. */
const STARS = [
  { x: 10, y: 13.5, r: 8.5, low: 0.45, delay: 0 },
  { x: 19, y: 5, r: 4, low: 0, delay: 0.35 },
  { x: 19.5, y: 19, r: 2.75, low: 0, delay: 0.7 },
];

/**
 * Feeling lucky's sparkles: still at rest; while the songs are picked, each star in turn swells, turns a little and
 * shrinks away (the big one only dims), then comes back, like light catching glitter.
 */
function Twinkle({ on, small }: { on: boolean; small?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className={cn('overflow-visible', small ? 'size-4.5' : 'size-5')} aria-hidden>
      {STARS.map((s, i) => (
        <g key={i} transform={`translate(${s.x} ${s.y}) scale(${s.r})`}>
          <motion.path
            d={STAR}
            fill="currentColor"
            animate={on ? { scale: [1, 1.2, s.low, 1], rotate: [0, 0, 45, 90], opacity: [1, 1, s.low ? 0.7 : 0, 1] } : { scale: 1, rotate: 0, opacity: 1 }}
            transition={on ? { duration: 1.2, times: [0, 0.2, 0.6, 1], ease: 'easeInOut', repeat: Infinity, delay: s.delay } : { duration: 0.25 }}
          />
        </g>
      ))}
    </svg>
  );
}
