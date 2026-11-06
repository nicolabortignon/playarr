import { useEffect, useMemo, useRef } from 'react';
import { cn } from '../lib/cn';
import { useReduceMotion } from '../lib/motion';
import { useSongMap } from '../lib/queries';
import { BAR_REST, barHeights, onPulse, songBeat, useMetered } from '../player/pulse';
import { useCurrentTrack } from '../player/store';

/** The bars' shape where they don't move (Reduce Motion), and where their loop starts. */
const SHAPE = [0.9, 0.5, 0.75];
const KEYFRAMES = '@keyframes eq{0%{transform:scaleY(.25)}100%{transform:scaleY(1)}}';
/** Paused, bars following the music settle this fast; while it plays they're set every frame, with nothing easing them. */
const SETTLE = 'transform 250ms ease-out';

/**
 * The bars marking the song playing (docs/design.md: the song playing). Where the player runs through Web Audio (a
 * desktop browser) and the song has a beat grid, they follow the music (plan 7 §2): the bass, the middle and the treble
 * of what's heard, landing on the beat. Elsewhere (a phone, a song not analyzed) they loop, as they always have. They
 * stop when the music does: following it, they settle; looping, they freeze. Under Reduce Motion they stand still.
 */
export function Equalizer({ playing, className }: { playing: boolean; className?: string }) {
  const reduce = useReduceMotion();
  const metered = useMetered((s) => s.metered);
  const track = useCurrentTrack();
  // Asked for only where the bars could follow it (often there already, asked for ahead as the next song's: AppShell).
  const map = useSongMap(track, metered && !reduce);
  const beat = useMemo(() => songBeat(map), [map]);
  const mode = reduce ? 'still' : metered && beat ? 'live' : 'loop';
  const bars = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    if (mode !== 'live' || !beat) return;
    const draw = (heights: readonly number[], settle: boolean) =>
      bars.current.forEach((bar, i) => {
        if (!bar) return;
        bar.style.transition = settle ? SETTLE : '';
        bar.style.transform = `scaleY(${heights[i] ?? BAR_REST})`;
      });
    const rest = [BAR_REST, BAR_REST, BAR_REST];
    if (!playing) return draw(rest, true);
    return onPulse(({ time, levels }) => draw(levels ? barHeights(beat, time, levels) : rest, false));
  }, [mode, playing, beat]);

  return (
    <span data-eq={mode} className={cn('inline-flex h-3.5 items-end gap-[2px]', className)} aria-hidden>
      {SHAPE.map((h, i) => (
        <span
          key={i}
          ref={(el) => {
            bars.current[i] = el;
          }}
          className="w-[3px] origin-bottom rounded-[1px] bg-accent"
          style={
            mode === 'live'
              ? { height: '100%', transform: `scaleY(${BAR_REST})` }
              : mode === 'loop'
                ? {
                    height: `${h * 100}%`,
                    animation: `eq 0.${7 + i}s ease-in-out ${i * 0.15}s infinite alternate`,
                    animationPlayState: playing ? 'running' : 'paused',
                  }
                : { height: `${h * 100}%` }
          }
        />
      ))}
      {mode === 'loop' && <style>{KEYFRAMES}</style>}
    </span>
  );
}
