import type { TransitionPlan } from '@playarr/mix';
import type { Track } from '@playarr/shared';
import { crossfadeSeconds, usePrefs } from '../lib/prefs';
import { useBlend } from './blend';
import { fadeSeconds, upNext } from './decks';
import { mixMapOf } from './mixMaps';
import { useSleep } from './sleep';
import { currentTrack, useClock, usePlayer } from './store';
import { useTransition } from './transitions';

/** How long before a song gives way the player's subtitle says what comes next. */
export const NEXT_LEAD_S = 10;
/** A bar of the song playing when its tempo isn't known: four beats at 120 BPM. */
const BAR_S = 2;

export interface SongEnding {
  /** Where the song playing is, and how long it is (seconds). */
  time: number;
  duration: number;
  /** The song that follows it on its own, if any. */
  next?: Pick<Track, 'title'>;
  /**
   * With DJ mix, the server's plan for the transition into it (when it has one), and whether its file is ready: the
   * song gives way where the plan's mix starts, blended when it's a blend that's ready.
   */
  plan?: Pick<TransitionPlan, 'style' | 'aStart'>;
  ready?: boolean;
  /** Seconds a bar of the song playing lasts (four beats at its tempo), when its tempo is known. */
  bar?: number;
  /** Seconds the two songs overlap with Crossfade (none within an album). */
  fade?: number;
}

/**
 * What the player's subtitle says as a song ends (plan 7 §5), else undefined: from ten seconds before it gives way,
 * "Next: Teardrop". With DJ mix blending the two on the beat: "Mixing into Teardrop on the next bar" through the last bar
 * before the blend, then "Mixing into Teardrop" while it plays, until the next song takes over the player.
 */
export function endOfSongLine({ time, duration, next, plan, ready, bar, fade = 0 }: SongEnding): string | undefined {
  if (!next || !(duration > 0)) return undefined;
  const blend = !!plan && !!ready && (plan.style === 'long' || plan.style === 'quick');
  // Where the song gives way: the planned mix point, else its end, less the fade into the next.
  const handoff = plan ? Math.min(plan.aStart, duration) : duration - fade;
  const left = handoff - time;
  if (blend && left <= 0) return `Mixing into ${next.title}`;
  if (blend && left <= (bar && bar > 0 ? bar : BAR_S)) return `Mixing into ${next.title} on the next bar`;
  return left <= NEXT_LEAD_S ? `Next: ${next.title}` : undefined;
}

/**
 * `endOfSongLine` for the song playing, re-rendering only when the words change. Nothing when the sleep timer stops
 * the music after this song: nothing follows it. Once a blend out of it is heard (player/blend.ts), "Mixing into
 * Teardrop" for as long as it's the song shown: the engine knows the blend is playing, whatever the transitions store
 * has made of the pair meanwhile (it can let its answer go at the mix point, taking the start as a seek).
 */
export function useEndOfSongLine(): string | undefined {
  const current = usePlayer(currentTrack);
  const next = usePlayer(upNext);
  const sleepEnd = useSleep((s) => s.endOfSong);
  // Crossfade's overlap (DJ mix fades only where its plan says so).
  const fade = usePrefs((s) => fadeSeconds(current, next, crossfadeSeconds(s)));
  const dj = usePrefs((s) => s.transitions === 'dj');
  const mixed = usePlayer((s) => s.mixMode !== 'off');
  // The transition store names the pair it's working on; any other pair isn't mixed.
  const result = useTransition((s) => (s.fromFileId === current?.fileId && s.toFileId === next?.fileId ? s.result : null));
  const plan = dj && mixed && result && 'plan' in result ? result.plan : undefined;
  const bpm = (current && mixMapOf(current.recordingId)?.bpm) || 0;
  const blendingInto = useBlend((s) => (s.blend && s.blend.from.fileId === current?.fileId ? s.blend.to.title : undefined));
  return useClock((c) =>
    sleepEnd
      ? undefined
      : blendingInto !== undefined
        ? `Mixing into ${blendingInto}`
        : endOfSongLine({
            time: c.time,
            duration: c.duration,
            next,
            plan,
            ready: result?.status === 'ready',
            bar: bpm > 0 ? (4 * 60) / bpm : undefined,
            fade,
          }),
  );
}
