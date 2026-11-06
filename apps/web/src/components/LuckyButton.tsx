import type { Account, Album, LuckyMix, Track } from '@playarr/shared';
import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { api, sized } from '../lib/api';
import { cn } from '../lib/cn';
import { reduceMotionNow } from '../lib/motion';
import { queryClient } from '../lib/queryClient';
import { toast } from '../lib/toast';
import { feelingLucky } from '../player/actions';
import { Button } from './Button';

/**
 * Feeling lucky: 15 songs put together now, a new set at every press. While they're picked the sparkles twinkle, and
 * covers come out from behind the button, fanning open clockwise like a hand of cards, the first song's dealt last and
 * on top; then the others gather under it and the stack slips back behind the button (plan 7 §5). The songs are asked
 * for as a press looks likely, so that card goes out in the same rhythm as the rest. On Home, as the action that fills
 * an empty queue, Made for you or Your listening, and in the player bar while nothing plays.
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
  const [deal, setDeal] = useState<Deal | null>(null);
  // Each press deals afresh.
  const [presses, setPresses] = useState(0);
  const press = async () => {
    // Still under Reduce Motion: the sparkles say it's picking, and the music starting says what it found.
    const still = reduceMotionNow();
    const { answer, hand } = takeNext();
    // A place in the fan for each cover at hand, and one for the first song's, dealt once it's known.
    const cards = still ? [] : hand.slice(0, IN_HAND);
    const atHand: Deal | null = cards.length ? { cards, spares: hand.slice(IN_HAND), slots: cards.length + 1 } : null;
    setPicking(true);
    setPresses((n) => n + 1);
    setDeal(null);
    // The fan waits a moment for the songs, so every card goes out in one rhythm; past that the covers at hand go out,
    // and the first song's follows once it's known.
    const wait = atHand ? setTimeout(() => setDeal(atHand), WAIT_MS) : undefined;
    try {
      const covers = fanCovers(await feelingLucky(answer));
      const landing = covers.at(-1);
      // Its picture first, so it doesn't come out blank.
      if (landing && !still) await pictureOf(landing, PICTURE_WAIT_MS);
      clearTimeout(wait);
      // It found nothing (and has said so): the cards out go back.
      if (!landing) return setDeal(allDealt);
      // Without covers at hand (nothing loaded yet), a few of the songs it found are dealt instead.
      setDeal((d) => (still ? null : withLanding(d ?? atHand ?? { cards: covers.slice(0, -1), spares: [], slots: covers.length }, landing)));
    } catch (err) {
      clearTimeout(wait);
      setDeal(allDealt);
      toast((err as Error).message, 'error');
    } finally {
      setPicking(false);
    }
  };
  return (
    // The fan sits behind the button: one stacking context for the two, the button on top.
    <span className="relative isolate inline-flex items-center">
      {deal && <CoverFan key={presses} {...deal} small={size !== 'large'} onDone={() => setDeal(null)} />}
      <Button
        variant={variant}
        size={size}
        icon={<Twinkle on={picking} small={size !== 'large'} />}
        onClick={() => void press()}
        onPointerEnter={() => void getNext()}
        onFocus={() => void getNext()}
        disabled={picking}
        aria-busy={picking}
        // While the songs are picked the sparkles say so; the button stays lit rather than dimming.
        className={cn('z-10 disabled:cursor-progress disabled:opacity-100', className)}
      >
        Feeling lucky
      </Button>
    </span>
  );
}

/** A cover in the fan: its picture, and its color while that loads. */
export interface FanCover {
  key: string;
  url?: string;
  color?: string;
}

/**
 * The covers being dealt: those at hand while it picks (with spares), then the first song's once it's known, last and
 * on top; `slots`, how many in all, so each card's place in the fan is known from the start. `done` once nothing more
 * is coming (it found nothing, or failed), so the cards out go back.
 */
interface Deal {
  cards: FanCover[];
  spares: FanCover[];
  slots: number;
  landing?: FanCover;
  done?: boolean;
}

const allDealt = (deal: Deal | null): Deal | null => deal && { ...deal, done: true };

/** The first song's cover joins the deal; a card at hand showing the same album gives way to a spare. */
function withLanding(deal: Deal, landing: FanCover): Deal {
  const twin = deal.cards.findIndex((c) => c.key === landing.key);
  const spare = deal.spares[0];
  if (twin < 0 || !spare) return { ...deal, landing };
  return { ...deal, cards: deal.cards.map((c, i) => (i === twin ? spare : c)), spares: deal.spares.slice(1), landing };
}

const coverOf = (t: Pick<Track, 'coverUrl' | 'coverColor' | 'albumId'>): FanCover => ({
  key: t.coverUrl ?? `album:${t.albumId}`,
  url: t.coverUrl,
  color: t.coverColor,
});

/** Covers at hand to look through, and how many of them are dealt before the first song's. */
const AT_HAND = 8;
const IN_HAND = 4;

/**
 * The next press, made ready once one looks likely (the pointer comes over the button, a finger touches it, or it takes
 * the focus): its songs asked for and the covers it will deal loading, so the fan can deal the first song's in the same
 * rhythm as the others, and the music starts at once. Kept two minutes, for the account it was asked for; a press
 * takes it, and the one after asks afresh.
 */
interface Next {
  at: number;
  account?: number;
  answer: Promise<LuckyMix>;
  hand: FanCover[];
}
let next: Next | null = null;
const NEXT_KEPT_MS = 2 * 60_000;

function getNext(): Next {
  const account = queryClient.getQueryData<Account>(['me'])?.id;
  if (next && next.account === account && Date.now() - next.at < NEXT_KEPT_MS) return next;
  const ready: Next = { at: Date.now(), account, answer: api.lucky(), hand: reduceMotionNow() ? [] : coversAtHand() };
  next = ready;
  // The spare too, in case it stands in for a card showing the first song's album.
  for (const c of ready.hand.slice(0, IN_HAND + 1)) void pictureOf(c);
  ready.answer.then(
    ({ tracks }) => fanCovers(tracks).forEach((c) => void pictureOf(c)),
    // Failed: the press asks again.
    () => {
      if (next === ready) next = null;
    },
  );
  return ready;
}

function takeNext(): Next {
  const taken = getNext();
  next = null;
  return taken;
}

/** The size the fan asks its covers at (they're 60 points, or 44). */
const FAN_ART = 96;

/** Load a cover's picture as the fan shows it; resolves once it's there (or failed), or after `ms`. */
function pictureOf(c: FanCover, ms = Infinity): Promise<void> {
  const url = sized(c.url, FAN_ART);
  return new Promise((resolve) => {
    if (!url) return resolve();
    const img = new Image();
    img.onload = img.onerror = () => resolve();
    img.src = url;
    if (img.complete) resolve();
    if (ms < Infinity) setTimeout(resolve, ms);
  });
}

/**
 * Covers at hand to deal while it picks: albums already loaded (Home's shelves, Albums, Jump back in, kept from the
 * last visit), shuffled; none when nothing is loaded yet.
 */
export function coversAtHand(): FanCover[] {
  const lists = [...queryClient.getQueriesData<Album[]>({ queryKey: ['albums'] }), ...queryClient.getQueriesData<Album[]>({ queryKey: ['recent-albums'] })];
  const covers = new Map<string, FanCover>();
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

/** The covers to deal from the songs it found: up to three of the others' albums, each once, then the first song's. */
export function fanCovers(tracks: Track[]): FanCover[] {
  const [first, ...rest] = tracks;
  if (!first) return [];
  const landing = coverOf(first);
  const others: FanCover[] = [];
  for (const t of rest) {
    const c = coverOf(t);
    if (c.key !== landing.key && !others.some((o) => o.key === c.key)) others.push(c);
    if (others.length === 3) break;
  }
  return [...others, landing];
}

/**
 * The fan's timing: how long it waits for the songs before dealing the covers at hand, and for the first song's
 * picture; between one card and the next as it opens, a card's spring into its place, the fan held open once the last
 * card is out, and its going back (the others gathering under the last card, then the stack slipping down).
 */
const WAIT_MS = 300;
const PICTURE_WAIT_MS = 300;
const DEAL_MS = 70;
const OPEN_MS = 450;
const HOLD_MS = 300;
const BACK_MS = 460;
/** Degrees between one card and the next; five cards open to 64. */
const STEP = 16;

/**
 * Covers coming out from behind the button, each dealt a little further clockwise than the one before and on top of it,
 * the first song's last. Each turns about a point near the button's middle, so together they open like a hand of cards.
 * Once the last is out and has been seen a moment, the others turn on under it, and the stack slips back down behind
 * the button and is gone.
 */
function CoverFan({ cards, slots, landing, done, small, onDone }: Deal & { small: boolean; onDone: () => void }) {
  const all = landing ? [...cards, landing] : cards;
  const last = all.length - 1;
  const started = useRef(Date.now());
  // When each card joined the fan (ms from the press): the first song's may come after its turn has passed.
  const joined = useRef<number[]>([]);
  all.forEach((_, i) => (joined.current[i] ??= Date.now() - started.current));
  const delay = (i: number) => Math.max(0, i * DEAL_MS - joined.current[i]!);
  const [back, setBack] = useState(false);
  useEffect(() => {
    if (back) {
      const id = setTimeout(onDone, BACK_MS);
      return () => clearTimeout(id);
    }
    if (!landing && !done) return;
    // Back once the last card is open and has been seen a moment.
    const out = joined.current[last]! + delay(last) + OPEN_MS + HOLD_MS - (Date.now() - started.current);
    const id = setTimeout(() => setBack(true), Math.max(0, out));
    return () => clearTimeout(id);
  }, [back, landing, done]);
  const side = small ? 44 : 60;
  // Half the button's height (regular 40, large 48): nothing of the fan shows below its top edge, so the cards come
  // out from behind it even where it's see-through (secondary).
  const edge = small ? 20 : 24;
  const angle = (i: number) => (i - (slots - 1) / 2) * STEP;
  const up = -side * 0.95;
  // Below the edge, out of sight.
  const down = side / 4;
  return (
    <span
      aria-hidden
      data-fan={back ? 'back' : 'open'}
      className="pointer-events-none absolute top-1/2 left-1/2"
      style={{ clipPath: `inset(${-side * 4}px ${-side * 4}px ${edge}px)` }}
    >
      {all.map((c, i) => (
        <motion.span
          key={i}
          data-cover={c.key}
          initial={{ rotate: angle(0), y: down }}
          animate={
            back
              ? { rotate: [null, angle(last), angle(last)], y: [null, up, down], scale: [null, i === last ? 1.05 : 1, 1] }
              : { rotate: angle(i), y: up }
          }
          transition={
            back
              ? { duration: BACK_MS / 1000, times: [0, 0.5, 1], ease: ['easeInOut', 'easeIn'] }
              : { delay: delay(i) / 1000, type: 'spring', stiffness: 380, damping: 24 }
          }
          style={{
            width: side,
            height: side,
            left: -side / 2,
            top: -side / 2,
            zIndex: i,
            transformOrigin: '50% 160%',
            backgroundColor: c.color,
            backgroundImage: c.url ? `url(${sized(c.url, FAN_ART)})` : undefined,
          }}
          className="absolute rounded-cover bg-ink-700 bg-cover bg-center shadow-cover"
        />
      ))}
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
