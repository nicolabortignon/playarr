import { motion } from 'motion/react';
import { useState } from 'react';
import { cn } from '../lib/cn';
import { toast } from '../lib/toast';
import { feelingLucky } from '../player/actions';
import { Button } from './Button';

/**
 * Feeling lucky: 15 songs put together now, a new set at every press. The sparkles twinkle while they're picked. On
 * Home, and as the action that fills an empty queue, Made for you or Your listening.
 */
export function LuckyButton({ className }: { className?: string }) {
  const [picking, setPicking] = useState(false);
  const press = async () => {
    setPicking(true);
    try {
      await feelingLucky();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setPicking(false);
    }
  };
  return (
    // While the songs are picked the sparkles say so; the button stays lit rather than dimming.
    <Button
      variant="primary"
      size="large"
      icon={<Twinkle on={picking} />}
      onClick={() => void press()}
      disabled={picking}
      aria-busy={picking}
      className={cn('disabled:cursor-progress disabled:opacity-100', className)}
    >
      Feeling lucky
    </Button>
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
function Twinkle({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="size-5 overflow-visible" aria-hidden>
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
