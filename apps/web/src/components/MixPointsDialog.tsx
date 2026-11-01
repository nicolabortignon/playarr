import type { CuePoints, MixMap } from '@playarr/mix';
import type { Track } from '@playarr/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AudioWaveform, Play } from 'lucide-react';
import { useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { api } from '../lib/api';
import { cn } from '../lib/cn';
import { formatTime } from '../lib/format';
import { usePrefs } from '../lib/prefs';
import { useMixMaps } from '../lib/queries';
import { toast } from '../lib/toast';
import { useUI } from '../lib/ui';
import { currentTrack, useClock, usePlayer } from '../player/store';
import { BarTicks, beatGrid, EnergyNumbers, PhraseColumns, PhraseReadout, phrasesAndBars } from './EnergyStrip';
import { Dialog } from './Dialog';
import type { MenuItem } from './Menu';

/** Hand-set points: null is the detected point (nothing set by hand). */
interface Points {
  mixIn: number | null;
  mixOut: number | null;
}
type Which = keyof Points;

/** Lines the markers snap to: every bar, or every second when no beat was found. */
interface Grid {
  origin: number;
  step: number;
  /** Steps that Shift moves: a phrase (4 bars), or 10 seconds. */
  big: number;
}

/** Without a beat, Shift+arrows move this many seconds. */
const SECONDS_WITHOUT_BEAT = 10;
/** Float slack when deciding whether a time sits on a grid line. */
const EPSILON = 1e-6;

function gridOf(map: MixMap): Grid {
  const grid = beatGrid(map);
  return grid ? { origin: grid.firstBar, step: 4 * grid.beat, big: 4 } : { origin: 0, step: 1, big: SECONDS_WITHOUT_BEAT };
}

/** Milliseconds are plenty, and keep 0.5 + 9 × 2 from becoming 18.499999. */
const tidy = (t: number) => Math.round(t * 1000) / 1000;
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** The grid line `index` (or the nearest one that's within [min, max]). */
function lineWithin(grid: Grid, index: number, min: number, max: number, fallback: number): number {
  const lo = Math.ceil((min - grid.origin) / grid.step - EPSILON);
  const hi = Math.floor((max - grid.origin) / grid.step + EPSILON);
  if (lo > hi) return clamp(fallback, min, max);
  return tidy(grid.origin + clamp(index, lo, hi) * grid.step);
}

/** The grid line nearest `t`, within [min, max]. */
const snap = (grid: Grid, t: number, min: number, max: number) => lineWithin(grid, Math.round((t - grid.origin) / grid.step), min, max, t);

/** `n` lines on from `t` (back for a negative `n`); from between two lines, the first step lands on the next one. */
function stepFrom(grid: Grid, t: number, n: number, min: number, max: number) {
  const at = (t - grid.origin) / grid.step;
  const from = n > 0 ? Math.floor(at + EPSILON) : Math.ceil(at - EPSILON);
  return lineWithin(grid, from + n, min, max, t);
}

const finiteOr = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback);

/**
 * Plays `song` from `time` in the main player. The song playing now just jumps there; another one
 * goes in right after it and plays, so the queue isn't lost.
 */
function playFrom(song: Track, time: number) {
  const player = usePlayer.getState();
  if (currentTrack(player)?.fileId === song.fileId) {
    useClock.getState().seek(time);
    player.setPlaying(true);
    return;
  }
  if (player.pos < 0) player.playTracks([song]);
  else {
    player.playNext([song]);
    player.jumpTo(player.pos + 1);
  }
  // The engine loads the new song in an effect once React has drawn the change: seeking before that
  // would move the song that was playing, then the new one would start from the top.
  setTimeout(() => useClock.getState().seek(time), 0);
}

/** The song menus' "Edit mix points", only with DJ mix on (the only setting that uses them). */
export function useMixPointsItem(track: Track): MenuItem[] {
  const dj = usePrefs((s) => s.transitions === 'dj');
  const edit = useUI((s) => s.editMixPoints);
  return dj && track.recordingId ? [{ label: 'Edit mix points', icon: AudioWaveform, onSelect: () => edit(track) }] : [];
}

/**
 * Song menu → Edit mix points: the song's energy over its bars, with a mix-in and a mix-out marker
 * to drag (or move with the keys) where the detection got them wrong. Saved per recording on the
 * server; Reset goes back to the detected points.
 */
export function MixPointsDialog() {
  const song = useUI((s) => s.mixPointsTrack);
  const close = useUI((s) => s.closeMixPoints);
  return (
    <Dialog open={song !== null} onClose={close} title="Edit mix points" wide>
      {song && <Loader key={song.recordingId} song={song} onSaved={close} />}
    </Dialog>
  );
}

function Loader({ song, onSaved }: { song: Track; onSaved: () => void }) {
  const { data, error, isPending } = useMixMaps([song.recordingId]);
  const map = data?.[song.recordingId];
  if (error) {
    return (
      <p role="alert" className="p-5 text-[15px] text-red-300/90">
        Couldn’t load this song’s mix points: {(error as Error).message}
      </p>
    );
  }
  if (isPending) {
    return (
      <div className="space-y-3 p-5" aria-busy="true" aria-label="Loading mix points">
        <div className="h-6 w-1/2 animate-pulse rounded bg-paper/5" />
        <div className="h-24 animate-pulse rounded-lg bg-paper/5" />
      </div>
    );
  }
  if (!map) {
    return (
      <div className="space-y-2 p-5">
        <SongTitle song={song} />
        <p className="text-sm text-paper-dim">
          This song hasn’t been analysed yet, so there are no mix points to move. Playarr measures songs in the background: try again later.
        </p>
      </div>
    );
  }
  return <Editor song={song} map={map} onSaved={onSaved} />;
}

function SongTitle({ song }: { song: Track }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[19px] text-paper">{song.title}</div>
      <div className="truncate text-[14px] text-muted">{song.artistName}</div>
    </div>
  );
}

function Editor({ song, map, onSaved }: { song: Track; map: MixMap & { cues?: CuePoints }; onSaved: () => void }) {
  const saved: Points = { mixIn: map.cues?.mixIn ?? null, mixOut: map.cues?.mixOut ?? null };
  const [points, setPoints] = useState<Points>(saved);
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: (cues: Points) => api.setCues(song.recordingId, cues),
    // The transition view and the planner's inputs both come from the mix maps.
    onSuccess: () => client.invalidateQueries({ queryKey: ['mix-maps'] }),
  });

  const duration = map.duration;
  const grid = gridOf(map);
  const detected = { mixIn: clamp(finiteOr(map.introEnd, 0), 0, duration), mixOut: clamp(finiteOr(map.outroStart, duration), 0, duration) };
  const shown = { mixIn: points.mixIn ?? detected.mixIn, mixOut: points.mixOut ?? detected.mixOut };
  // Mix in stays at least one line before mix out (the server wants it strictly before).
  const bounds = (which: Which): [number, number] =>
    which === 'mixIn' ? [0, shown.mixOut - grid.step] : [shown.mixIn + grid.step, duration];
  const move = (which: Which, to: number) => setPoints((p) => ({ ...p, [which]: to }));
  const changed = points.mixIn !== saved.mixIn || points.mixOut !== saved.mixOut;
  const anySet = [points.mixIn, points.mixOut, saved.mixIn, saved.mixOut].some((t) => t !== null);

  return (
    <div className="space-y-6 p-5">
      <div className="space-y-2">
        <SongTitle song={song} />
        <p className="text-sm text-paper-dim">
          {map.bpm > 0
            ? `${Math.round(map.bpm)} BPM. The markers snap to bars: the arrow keys move one bar, with Shift one phrase.`
            : `No steady beat was found in this song, so the markers move by whole seconds (with Shift, ${SECONDS_WITHOUT_BEAT}).`}
        </p>
      </div>

      <Strip map={map} grid={grid} shown={shown} detected={detected} bounds={bounds} onMove={move} />

      <div className="grid gap-3 sm:grid-cols-2">
        <PointCard
          label="Mix in"
          hint="Where the song is fully in"
          time={shown.mixIn}
          byHand={points.mixIn !== null}
          onPlay={() => playFrom(song, shown.mixIn)}
        />
        <PointCard
          label="Mix out"
          hint="Where the song starts to give way"
          time={shown.mixOut}
          byHand={points.mixOut !== null}
          onPlay={() => playFrom(song, shown.mixOut)}
        />
      </div>

      {save.error && (
        <p role="alert" className="text-[14px] text-red-300/90">
          Couldn’t save the mix points: {(save.error as Error).message}
        </p>
      )}

      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          disabled={!anySet || save.isPending}
          onClick={() => save.mutate({ mixIn: null, mixOut: null }, { onSuccess: () => setPoints({ mixIn: null, mixOut: null }) })}
          className="h-11 rounded-lg px-4 text-paper-dim transition hover:bg-paper/[0.06] hover:text-paper disabled:opacity-40"
        >
          Reset
        </button>
        <button
          type="button"
          disabled={!changed || save.isPending}
          onClick={() =>
            save.mutate(points, {
              onSuccess: () => {
                toast('Mix points saved');
                onSaved();
              },
            })
          }
          className="h-11 rounded-lg bg-accent px-5 font-medium text-accent-ink transition hover:brightness-110 disabled:opacity-40"
        >
          Save
        </button>
      </div>
    </div>
  );
}

function PointCard({ label, hint, time, byHand, onPlay }: { label: string; hint: string; time: number; byHand: boolean; onPlay: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-line p-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[11px] tracking-[0.15em] text-muted uppercase">{label}</span>
          <span className="text-[11px] text-muted">{byHand ? 'Set by hand' : 'Detected'}</span>
        </div>
        <div className="text-xl text-paper tabular">{formatTime(time)}</div>
        <div className="truncate text-[12px] text-muted">{hint}</div>
      </div>
      <button
        type="button"
        onClick={onPlay}
        className="flex h-10 shrink-0 items-center gap-2 rounded-full border border-line px-3 text-[13px] text-paper-dim transition hover:bg-paper/[0.06] hover:text-paper"
      >
        <Play className="size-3.5 fill-current" aria-hidden />
        Play from {label.toLowerCase()}
      </button>
    </div>
  );
}

/**
 * The whole song's energy per phrase with its bars underneath, the stretches either end where it
 * overlaps its neighbours shaded, the detected points as faint dashed lines, and the two markers.
 */
function Strip({
  map,
  grid,
  shown,
  detected,
  bounds,
  onMove,
}: {
  map: MixMap;
  grid: Grid;
  shown: Record<Which, number>;
  detected: Record<Which, number>;
  bounds: (which: Which) => [number, number];
  onMove: (which: Which, to: number) => void;
}) {
  const id = useId();
  const track = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const duration = map.duration;
  const { phrases, bars } = phrasesAndBars(map, (t) => t, 0, duration);
  const at = (t: number) => `${(clamp(t, 0, duration) / duration) * 100}%`;
  const hovered = hover !== null ? phrases[hover] : undefined;

  /** Seconds into the song under the pointer. */
  const timeAt = (clientX: number) => {
    const box = track.current?.getBoundingClientRect();
    return box && box.width > 0 ? ((clientX - box.left) / box.width) * duration : 0;
  };

  return (
    <figure aria-labelledby={id} className="min-w-0">
      <figcaption id={id} className="mb-2 flex items-baseline justify-between gap-3">
        <span className="font-mono text-[11px] tracking-[0.2em] text-muted uppercase">Energy through the song</span>
        {hovered && <PhraseReadout phrase={hovered} />}
      </figcaption>
      <div className="relative select-none" onPointerLeave={() => setHover(null)}>
        {/* Rows for the markers' handles: mix in above the strip, mix out below, so they never collide. */}
        <div className="h-6" />
        <div ref={track} className="relative h-16" aria-hidden>
          <div className="absolute inset-y-0 left-0 rounded-[2px] bg-paper/[0.08]" style={{ width: at(shown.mixIn) }} />
          <div className="absolute inset-y-0 right-0 rounded-[2px] bg-paper/[0.08]" style={{ left: at(shown.mixOut) }} />
          <PhraseColumns phrases={phrases} hovered={hover} onHover={setHover} />
          {(['mixIn', 'mixOut'] as const).map((which) => (
            <div key={which} className="absolute inset-y-0 border-l border-dashed border-paper/35" style={{ left: at(detected[which]) }} />
          ))}
        </div>
        <BarTicks bars={bars} />
        <div className="h-6" />
        <Marker which="mixIn" label="Mix in" handle="In" time={shown.mixIn} left={at(shown.mixIn)} grid={grid} bounds={bounds} timeAt={timeAt} onMove={onMove} />
        <Marker which="mixOut" label="Mix out" handle="Out" time={shown.mixOut} left={at(shown.mixOut)} grid={grid} bounds={bounds} timeAt={timeAt} onMove={onMove} />
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-muted tabular" aria-hidden>
        <span>0:00</span>
        <span>{formatTime(duration)}</span>
      </div>
      <p className="mt-2 text-[12px] text-muted">
        The shaded ends are where this song can overlap the songs before and after it; the dashed lines are the points Playarr found on its own.
      </p>
      {phrases.length > 0 && (
        <EnergyNumbers caption="Energy per phrase (16 beats) through the song" rows={phrases.map((p) => ({ at: p.at, energy: p.energy }))} />
      )}
    </figure>
  );
}

function Marker({
  which,
  label,
  handle,
  time,
  left,
  grid,
  bounds,
  timeAt,
  onMove,
}: {
  which: Which;
  label: string;
  handle: string;
  time: number;
  left: string;
  grid: Grid;
  bounds: (which: Which) => [number, number];
  timeAt: (clientX: number) => number;
  onMove: (which: Which, to: number) => void;
}) {
  const dragging = useRef(false);
  const [min, max] = bounds(which);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const steps = e.shiftKey ? grid.big : 1;
    const to = {
      ArrowRight: () => stepFrom(grid, time, steps, min, max),
      ArrowUp: () => stepFrom(grid, time, steps, min, max),
      ArrowLeft: () => stepFrom(grid, time, -steps, min, max),
      ArrowDown: () => stepFrom(grid, time, -steps, min, max),
      PageUp: () => stepFrom(grid, time, grid.big, min, max),
      PageDown: () => stepFrom(grid, time, -grid.big, min, max),
      Home: () => snap(grid, min, min, max),
      End: () => snap(grid, max, min, max),
    }[e.key];
    if (!to) return;
    // Handled here: the player's shortcuts (←/→ seek) leave keys a control has used alone.
    e.preventDefault();
    onMove(which, to());
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    // Keep getting the pointer's moves when it leaves the marker (a finger, a fast drag).
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.currentTarget.focus();
    // No text selection or page scroll while dragging.
    e.preventDefault();
    dragging.current = true;
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging.current) onMove(which, snap(grid, timeAt(e.clientX), min, max));
  };
  const stop = (e: PointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={tidy(min)}
      aria-valuemax={tidy(max)}
      aria-valuenow={time}
      aria-valuetext={formatTime(time)}
      aria-orientation="horizontal"
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      // Only the handle and a strip around the line catch the pointer, so two close markers stay reachable.
      className="group pointer-events-none absolute inset-y-0 w-11 -translate-x-1/2 touch-none outline-none"
      style={{ left }}
    >
      <div className="pointer-events-auto absolute inset-y-6 left-1/2 w-4 -translate-x-1/2 cursor-ew-resize">
        <div className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-paper" />
      </div>
      <div
        className={cn(
          'pointer-events-auto absolute left-1/2 grid h-6 min-w-10 -translate-x-1/2 cursor-ew-resize place-items-center rounded-full bg-paper px-2 font-mono text-[10px] tracking-[0.1em] text-ink-950 uppercase shadow-md shadow-black/40',
          'group-focus-visible:ring-2 group-focus-visible:ring-accent group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-ink-850',
          which === 'mixIn' ? 'top-0' : 'bottom-0',
        )}
      >
        {handle}
      </div>
    </div>
  );
}
