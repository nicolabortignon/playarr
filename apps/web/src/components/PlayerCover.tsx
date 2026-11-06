import type { Track } from '@playarr/shared';
import { useEffect, useRef } from 'react';
import { cn } from '../lib/cn';
import { useReduceMotion } from '../lib/motion';
import { useUI } from '../lib/ui';
import { NOW_PLAYING_COVER } from '../lib/viewTransitions';
import { blendShares, useBlend } from '../player/blend';
import { onPulse, pulseNow, type PulseFrame } from '../player/pulse';
import { usePlayer } from '../player/store';
import { Cover } from './Cover';

/**
 * The player's cover: the mini player's and the player bar's. During a DJ blend it shows both songs' covers
 * overlapping, the one being left above and to the left, the one coming in below and to the right, each as present as
 * its song is in the mix (plan 7 §2): the second fades in as its song comes in, the first fades out as its song goes,
 * and the second grows back to the whole cover once the first has gone. Under Reduce Motion the two just sit together
 * for as long as the blend lasts. It's the cover that grows into Now Playing's (lib/viewTransitions.ts).
 */
export function PlayerCover({ track, size, className, coverClassName }: { track: Track; size: number; className?: string; coverClassName?: string }) {
  const blend = useBlend((s) => s.blend);
  const playing = usePlayer((s) => s.playing);
  const reduce = useReduceMotion();
  const named = useUI((s) => s.coverMorph === 'player');
  const layers = useRef(new Map<number, HTMLSpanElement>());
  const covers = blend ? [blend.from, blend.to] : [track];

  // The cross-fade follows the mix, frame by frame, while it plays; paused, the covers stay where the mix is.
  useEffect(() => {
    if (!blend || reduce) return;
    const show = ({ blend: heard }: PulseFrame) => {
      if (heard?.plan !== blend.plan) return;
      const shares = blendShares(blend.plan, Math.max(0, heard.time));
      const from = layers.current.get(blend.from.fileId);
      const to = layers.current.get(blend.to.fileId);
      if (from) from.style.opacity = String(shares.from);
      if (to) to.style.opacity = String(shares.to);
    };
    if (playing) return onPulse(show);
    const now = pulseNow();
    if (now) show(now);
  }, [blend, reduce, playing]);

  return (
    <span
      data-blend={blend ? '' : undefined}
      style={named ? { viewTransitionName: NOW_PLAYING_COVER } : undefined}
      className={cn('relative block', className)}
    >
      {covers.map((t) => {
        const role = !blend ? 'alone' : t === blend.from ? 'from' : 'to';
        return (
          <span
            key={t.fileId}
            ref={(el) => {
              if (el) layers.current.set(t.fileId, el);
              else layers.current.delete(t.fileId);
            }}
            data-cover={role}
            className={cn(
              'absolute inset-0 transition-transform duration-250 ease-out-expo',
              // Each keeps its corner as it shrinks or grows: the one being left the top left, the one coming in the bottom right.
              role === 'from' ? 'origin-top-left' : 'origin-bottom-right',
              role === 'alone' ? 'scale-100' : 'scale-[0.78]',
              role === 'to' && 'rounded-cover shadow-md shadow-black/50',
            )}
            // Coming in, it starts unseen (its song isn't heard yet); alone, or with motion reduced, it's there.
            style={role === 'to' && !reduce ? { opacity: 0 } : role === 'alone' ? { opacity: 1 } : undefined}
          >
            <Cover src={t.coverUrl} color={t.coverColor} size={size} alt="" className={cn('size-full rounded-cover', coverClassName)} />
          </span>
        );
      })}
    </span>
  );
}
