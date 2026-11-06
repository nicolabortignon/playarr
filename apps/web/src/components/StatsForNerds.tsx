import { DRIFT_LIMIT_MS, toCamelot, type Camelot, type CuePoints, type MixMap, type TransitionPlan } from '@playarr/mix';
import type { Track, TrackLevel } from '@playarr/shared';
import { Minus, Plus, X } from 'lucide-react';
import { motion, useDragControls } from 'motion/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { cn } from '../lib/cn';
import { formatTime } from '../lib/format';
import { crossfadeSeconds, usePrefs } from '../lib/prefs';
import { useMixMaps, useTrackMetadata } from '../lib/queries';
import { useToasts } from '../lib/toast';
import { soundingNow, type Sounding } from '../player/AudioEngine';
import { canSetVolume, levelDb, upNext, type QueueState } from '../player/decks';
import { useJoins, type JoinReport } from '../player/joins';
import { useLevels } from '../player/levels';
import { useOffline } from '../player/offline';
import { useClock, useCurrentTrack, usePlayer } from '../player/store';
import { useTransition, type UpcomingResult } from '../player/transitions';
import { beatGrid, heardHeight } from './EnergyStrip';
import { describeFormat } from './TrackMetadataDialog';

/** How often the panel follows the song while it plays: often enough for the beat counter… */
const TICK_MS = 100;
/** …and while it's paused, for the buffer. */
const PAUSED_TICK_MS = 1000;
/** The clock moves a few times a second; between its moves the time is carried on, at most this far. */
const MAX_CARRY_S = 0.5;
/** A rate this close to 1 shows as ×1.000: the next song plays at its own tempo. */
const SAME_RATE = 0.0005;

const MAJOR = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const MINOR = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'B♭', 'B'];
const KEY_NAMES = new Map<string, string>(
  MAJOR.flatMap((name, pc) => [
    [toCamelot(pc, false), `${name} major`],
    [toCamelot(pc, true), `${MINOR[pc]} minor`],
  ]),
);

/** "8A" → "A minor". */
export const keyName = (camelot: Camelot): string | undefined => KEY_NAMES.get(camelot);

export interface GridPosition {
  bar: number;
  /** 1–4 within the bar. */
  beat: number;
  phrase: number;
  /** 1–4 within the phrase. */
  barOfPhrase: number;
}

/** Where `time` falls on the song's grid, counted from its first bar (1.1); null before it, or without a beat. */
export function gridPosition(map: MixMap, time: number): GridPosition | null {
  const grid = beatGrid(map);
  if (!grid) return null;
  const beats = Math.floor((time - grid.firstBar) / grid.beat + 1e-6);
  if (beats < 0) return null;
  const bars = Math.floor(beats / 4);
  return { bar: bars + 1, beat: (beats % 4) + 1, phrase: Math.floor(bars / 4) + 1, barOfPhrase: (bars % 4) + 1 };
}

/** The part of the song `time` is in, by its mix map. */
export function sectionAt(map: MixMap, time: number): string {
  if (time < (map.soundStart ?? 0) || time >= map.soundEnd) return 'silence';
  if (time < map.introEnd) return 'intro';
  if (time >= map.outroStart) return 'outro';
  return map.firstDrop !== undefined && time >= map.firstDrop ? 'main, past the drop' : 'main';
}

/** 83.46 → "1:23.4". */
const at = (s: number) => `${formatTime(s)}.${Math.floor((Math.max(0, s) % 1) * 10)}`;
/** −5.25 → "−5.3 dB". */
const dB = (db: number) => `${db > 0 ? '+' : db < 0 ? '−' : '±'}${Math.abs(db).toFixed(1)} dB`;
/** −9.04 → "−9.0", with a real minus sign. */
const signed = (x: number) => x.toFixed(1).replace('-', '−');
const pct = (x: number) => `${Math.round(Math.min(1, Math.max(0, x)) * 100)}%`;
const n2 = (x: number) => x.toFixed(2);

/** Settings → Appearance → Stats for nerds: everything known about the song playing, over the app. */
export function StatsForNerds() {
  const on = usePrefs((s) => s.statsForNerds);
  const track = useCurrentTrack();
  if (!on || !track) return null;
  return <Overlay track={track} />;
}

function Overlay({ track }: { track: Track }) {
  const [open, setOpen] = useState(true);
  const bounds = useRef<HTMLDivElement>(null);
  const controls = useDragControls();
  const playing = usePlayer((s) => s.playing);
  const time = useSongTime(playing);
  const map = useMixMaps([track.recordingId]).data?.[track.recordingId];
  const level = useLevels((s) => s.levels[track.recordingId]);
  const grid = map ? gridPosition(map, time) : null;

  const turnOff = () => {
    usePrefs.getState().setStatsForNerds(false);
    useToasts.getState().push('Stats for nerds is off: it’s in Settings → Appearance.', 'info', {
      label: 'Undo',
      run: () => usePrefs.getState().setStatsForNerds(true),
    });
  };
  const summary = [
    map && map.bpm > 0 ? `${map.bpm.toFixed(1)} BPM` : undefined,
    map?.key?.camelot,
    grid ? `${grid.bar}.${grid.beat}` : undefined,
    level?.lufs !== undefined ? `${signed(level.lufs)} LUFS` : undefined,
  ].filter(Boolean);

  return (
    <div ref={bounds} className="pointer-events-none fixed inset-0 z-[130]">
      <motion.aside
        aria-label="Stats for nerds"
        drag
        dragControls={controls}
        dragListener={false}
        dragMomentum={false}
        dragElastic={0}
        dragConstraints={bounds}
        className={cn(
          'pointer-events-auto absolute right-2 w-[min(calc(100vw-1rem),360px)] overflow-hidden rounded-lg border border-paper/10 bg-ink-950/85 font-mono text-[11px] leading-[1.5] text-paper-dim shadow-2xl shadow-black/60 backdrop-blur-xl',
          // Below Now Playing's header on phones; above the player bar on desktop.
          'top-[calc(max(env(safe-area-inset-top),1rem)+3.75rem)] md:top-auto md:right-4 md:bottom-[104px]',
        )}
      >
        <header
          onPointerDown={(e) => controls.start(e)}
          className="flex h-8 cursor-grab touch-none items-center gap-2 pr-1 pl-2.5 select-none active:cursor-grabbing"
        >
          <span className="shrink-0 text-[10px] tracking-[0.2em] text-paper uppercase">Stats for nerds</span>
          <BeatDots beat={grid?.beat} />
          <span className="min-w-0 flex-1 truncate text-right text-muted tabular">{open ? '' : summary.join(' · ')}</span>
          <HeaderButton label={open ? 'Collapse' : 'Expand'} expanded={open} onClick={() => setOpen(!open)}>
            {open ? <Minus className="size-3.5" /> : <Plus className="size-3.5" />}
          </HeaderButton>
          <HeaderButton label="Turn off stats for nerds" onClick={turnOff}>
            <X className="size-3.5" />
          </HeaderButton>
        </header>
        {open && <Details track={track} time={time} map={map} grid={grid} level={level} />}
      </motion.aside>
    </div>
  );
}

function HeaderButton({ label, expanded, onClick, children }: { label: string; expanded?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-expanded={expanded}
      // Not the start of a drag.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onClick}
      className="grid size-7 shrink-0 place-items-center rounded text-muted transition hover:bg-paper/10 hover:text-paper"
    >
      {children}
    </button>
  );
}

/** The four beats of the bar, the one playing lit (the downbeat in the accent color). */
function BeatDots({ beat }: { beat: number | undefined }) {
  if (beat === undefined) return null;
  return (
    <span aria-hidden className="flex shrink-0 items-center gap-1">
      {[1, 2, 3, 4].map((b) => (
        <span key={b} className={cn('size-1.5 rounded-full', b !== beat ? 'bg-paper/15' : b === 1 ? 'bg-accent' : 'bg-paper')} />
      ))}
    </span>
  );
}

/** The song's time, carried on between the clock's few moves a second so the beat counter keeps up. */
function useSongTime(playing: boolean): number {
  const [time, setTime] = useState(() => useClock.getState().time);
  useEffect(() => {
    let last = { time: useClock.getState().time, ms: performance.now() };
    const off = useClock.subscribe((s) => {
      if (s.time !== last.time) last = { time: s.time, ms: performance.now() };
    });
    const tick = () => {
      const moving = playing && !useClock.getState().loading;
      setTime(moving ? last.time + Math.min(MAX_CARRY_S, (performance.now() - last.ms) / 1000) : last.time);
    };
    tick();
    const id = setInterval(tick, playing ? TICK_MS : PAUSED_TICK_MS);
    return () => {
      off();
      clearInterval(id);
    };
  }, [playing]);
  return time;
}

function Details({ track, time, map, grid, level }: { track: Track; time: number; map?: MixMap & { cues?: CuePoints }; grid: GridPosition | null; level?: TrackLevel }) {
  const meta = useTrackMetadata(track.id).data;
  const clock = useClock(useShallow((s) => ({ duration: s.duration, buffered: s.buffered, loading: s.loading, error: s.error })));
  const joins = useJoins((s) => s.byJoin);
  const queue = usePlayer(useShallow((s) => ({ queue: s.queue, order: s.order, pos: s.pos, repeat: s.repeat })));
  const { playing, mixMode } = usePlayer(useShallow((s) => ({ playing: s.playing, mixMode: s.mixMode })));
  const prefs = usePrefs(useShallow((s) => ({ transitions: s.transitions, crossfade: s.crossfade, levelVolume: s.levelVolume })));
  const loadedDb = useLevels((s) => s.loaded[track.fileId]);
  const kept = useOffline((s) => track.fileId in s.songs);
  const transition = useTransition(useShallow((s) => ({ fromFileId: s.fromFileId, result: s.result })));
  const sound = soundingNow();
  const element = sound?.element ?? undefined;
  const copy = meta?.copies.find((c) => c.playing);
  const next = upNext(queue);
  const cues = map?.cues;

  return (
    <div className="max-h-[min(60dvh,520px)] overflow-y-auto overscroll-contain border-t border-paper/10 px-2.5 pt-1 pb-2.5">
      <Group title="Song">
        <Row label="Title" value={`${track.title} — ${track.artistName}`} />
        <Row label="Ids" value={`track ${track.id} · file ${track.fileId}`} />
        <Row label="Recording" value={<span className="break-all">{track.recordingId}</span>} />
        <Row label="Source" value={copy && [copy.source.name, copy.path].filter(Boolean).join(' · ')} />
      </Group>

      <Group title="Playback">
        <Row label="Position" value={`${at(time)} / ${at(clock.duration)} · ${clock.loading ? 'loading' : playing ? 'playing' : 'paused'}`} />
        <Row label="Buffer" value={clock.buffered > time ? `${(clock.buffered - time).toFixed(1)} s ahead` : 'none ahead'} />
        <Row label="Stream" value={streamOf(sound, loadedDb, kept)} />
        <Row label="Element" value={element && elementState(element)} />
        <Row label="URL" value={element?.currentSrc && <span className="break-all">{shortUrl(element.currentSrc)}</span>} />
        <Row label="Format" value={track.format && describeFormat(track.format)} />
        <Row
          label="Transitions"
          value={prefs.transitions === 'dj' ? `DJ mix · ${mixMode}` : prefs.transitions === 'crossfade' ? `crossfade ${crossfadeSeconds(prefs)} s` : 'gapless'}
        />
        <Row label="Mix in" value={joins['mix in'] ? joinOf(joins['mix in']) : 'none yet'} />
        <Row label="Mix out" value={joins['mix out'] ? joinOf(joins['mix out']) : 'none yet'} />
        {clock.error && <Row label="Error" value={<span className="text-danger">{clock.error}</span>} />}
      </Group>

      <Group title="Rhythm">
        {map && map.bpm > 0 ? (
          <>
            <Row label="Tempo" value={`${n2(map.bpm)} BPM · ${Math.round(60_000 / map.bpm)} ms a beat`} />
            <Row
              label="Beat"
              value={[
                `${pct(map.beatConfidence)} sure`,
                map.gridStable ? 'steady' : 'wandering',
                map.edgesStable !== undefined ? (map.edgesStable ? 'holds where mixed' : 'drifts where mixed') : undefined,
                map.beatsFrom === 'onsets' ? 'onsets' : 'beat model',
              ]
                .filter(Boolean)
                .join(' · ')}
            />
            <Row label="Bars" value={`${pct(map.downbeatConfidence ?? 1)} sure · first beat ${at(map.firstBeat)} +${map.downbeatOffset}`} />
            <Row
              label="Now"
              value={grid ? `bar ${grid.bar}.${grid.beat} · phrase ${grid.phrase} (bar ${grid.barOfPhrase}/4)` : time < map.firstBeat ? 'before the first beat' : 'pickup'}
            />
            <Row label="Drift" value={map.phraseDrift && driftOf(map.phraseDrift, grid)} />
          </>
        ) : (
          <Row label="Tempo" value={map ? 'no steady beat' : 'not analysed yet'} />
        )}
        {map?.key && <Row label="Key" value={`${map.key.camelot} · ${keyName(map.key.camelot) ?? '?'} · ${pct(map.key.confidence)} sure`} />}
      </Group>

      {map && (
        <Group title="Structure">
          <Row label="Section" value={sectionAt(map, time)} />
          <Row label="Audible" value={`${at(map.soundStart ?? 0)} → ${at(map.soundEnd)}`} />
          <Row label="Intro" value={`to ${at(map.introEnd)} · ${map.coldStart ? 'cold start' : 'eases in'}`} />
          <Row label="Outro" value={`from ${at(map.outroStart)} · ${map.coldEnd ? 'cold end' : 'fades out'}`} />
          <Row label="First drop" value={map.firstDrop !== undefined ? at(map.firstDrop) : 'none'} />
          {cues && (cues.mixIn !== undefined || cues.mixOut !== undefined) && (
            <Row
              label="Mix points"
              value={`${cues.mixIn !== undefined ? `in ${at(cues.mixIn)}` : 'in: detected'} · ${cues.mixOut !== undefined ? `out ${at(cues.mixOut)}` : 'out: detected'} (set by hand)`}
            />
          )}
          <Energy map={map} time={time} />
          <Row label="Mix map" value={`version ${map.version}`} />
        </Group>
      )}

      <Group title="Loudness">
        <Loudness track={track} level={level} loadedDb={loadedDb} levelVolume={prefs.levelVolume} queue={queue} />
      </Group>

      {meta?.analysis && (
        <Group title="Sound">
          <Row label="Energy" value={`level ${n2(meta.analysis.loudness)} · dynamics ${n2(meta.analysis.dynamics)}`} />
          <Row label="Texture" value={`bright ${n2(meta.analysis.brightness)} · busy ${n2(meta.analysis.busyness)} · bass ${n2(meta.analysis.bass)}`} />
          <Row label="Genres" value={meta.genres.join(', ') || undefined} />
        </Group>
      )}

      {next && (
        <Group title="Next">
          <Row label="Song" value={`${next.title} — ${next.artistName}`} />
          {prefs.transitions === 'dj' && mixMode !== 'off' && transition.fromFileId === track.fileId ? (
            <Upcoming result={transition.result} time={time} />
          ) : (
            <Row label="How" value={prefs.transitions === 'crossfade' ? `crossfade ${crossfadeSeconds(prefs)} s` : 'straight on, gapless'} />
          )}
        </Group>
      )}
    </div>
  );
}

/** "+34 ms, drifts · 12 of 58 phrases drift": the phrase playing's, and the song's. */
function driftOf(drift: (number | null)[], grid: GridPosition | null): string {
  const drifting = drift.filter((d) => d !== null && Math.abs(d) > DRIFT_LIMIT_MS).length;
  const d = grid ? drift[grid.phrase - 1] : undefined;
  const now =
    d === undefined ? undefined : d === null ? 'no beat to judge' : `${d > 0 ? '+' : d < 0 ? '−' : '±'}${Math.abs(d)} ms, ${Math.abs(d) > DRIFT_LIMIT_MS ? 'drifts' : 'holds'}`;
  return [now, `${drifting} of ${drift.length} phrases drift`].filter(Boolean).join(' · ');
}

const READY_STATES = ['nothing', 'metadata', 'current data', 'future data', 'enough data'];

function elementState(e: HTMLAudioElement): string {
  return [
    READY_STATES[e.readyState] ?? String(e.readyState),
    `volume ${pct(e.volume)}`,
    e.playbackRate !== 1 ? `rate ×${e.playbackRate.toFixed(3)}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** The address without this server's origin. */
function shortUrl(url: string): string {
  if (url.startsWith('data:')) return 'a silent clip';
  return url.startsWith(location.origin) ? url.slice(location.origin.length) : url;
}

function streamOf(sound: Sounding | undefined, loadedDb: number | null | undefined, kept: boolean): string {
  if (sound?.live) return 'live mix (Web Audio)';
  if (sound?.transition) return 'DJ transition, made on the server';
  const offset = Number(sound?.element?.dataset.offset ?? 0);
  if (offset > 0) return `the rest after the transition, from ${at(offset)}`;
  if (typeof loadedDb === 'number') return `levelled WAV at ${dB(loadedDb)}`;
  return kept ? 'its own file, kept on this device' : 'its own file';
}

function Loudness({
  track,
  level,
  loadedDb,
  levelVolume,
  queue,
}: {
  track: Track;
  level?: TrackLevel;
  loadedDb: number | null | undefined;
  levelVolume: boolean;
  queue: QueueState;
}) {
  if (!level) return <Row label="Measured" value="not measured yet" />;
  const which = (db: number) => (level.album !== undefined && db === level.album && db !== level.track ? 'album gain' : 'track gain');
  let applied: number | undefined;
  let how: string;
  if (!levelVolume) how = 'none: even volume is off';
  else if (typeof loadedDb === 'number') {
    applied = loadedDb;
    how = `${dB(loadedDb)} in the stream (${which(loadedDb)})`;
  } else if (canSetVolume()) {
    const db = levelDb(track, level, queue);
    applied = Math.min(0, db);
    how = `${dB(applied)} by volume (${which(db)}${db > 0 ? ', can’t turn up' : ''})`;
  } else how = 'none: its own file';
  return (
    <>
      <Row
        label="Measured"
        value={level.lufs !== undefined ? `${signed(level.lufs)} LUFS${level.peak !== undefined ? ` · peak ${signed(level.peak)} dBFS` : ''}` : undefined}
      />
      <Row label="Gains" value={`track ${dB(level.track)}${level.album !== undefined ? ` · album ${dB(level.album)}` : ''}`} />
      <Row label="Applied" value={how} />
      {applied !== undefined && level.lufs !== undefined && <Row label="Heard at" value={`≈ ${signed(level.lufs + applied)} LUFS`} />}
    </>
  );
}

const STATUS: Record<UpcomingResult['status'], string> = {
  ready: 'ready',
  pending: 'being made',
  straight: 'straight on',
  unavailable: 'unavailable',
  'gave up': 'gave up: not ready in time',
};

function Upcoming({ result, time }: { result: UpcomingResult | null; time: number }) {
  if (!result) return <Row label="Mix" value="planning" />;
  const plan: TransitionPlan | undefined = 'plan' in result ? result.plan : undefined;
  const rates = plan?.bRate.map((p) => p.value) ?? [];
  const [slowest, fastest] = [Math.min(...rates), Math.max(...rates)];
  return (
    <>
      <Row label="Mix" value={plan ? `${STATUS[result.status]} · ${plan.style}${plan.beats ? `, ${plan.beats} beats` : ''}` : STATUS[result.status]} />
      {result.status === 'pending' && result.render && <Row label="Making" value={makingOf(result.render)} />}
      {plan && (
        <>
          <Row label="Mix at" value={`${at(plan.aStart)}${plan.aStart > time ? ` (in ${formatTime(plan.aStart - time)})` : ''} → ${at(plan.bStart)} of the next`} />
          <Row label="Length" value={`${plan.length.toFixed(1)} s · next takes over at +${plan.switchAt.toFixed(1)} s · on from ${at(plan.bResume)}`} />
          {rates.some((r) => Math.abs(r - 1) >= SAME_RATE) && (
            <Row label="Next’s rate" value={slowest === fastest ? `×${slowest.toFixed(3)}` : `×${slowest.toFixed(3)} – ×${fastest.toFixed(3)}`} />
          )}
        </>
      )}
      {result.status === 'ready' && result.levels && <Row label="Levels" value={`${dB(result.levels.a)} → ${dB(result.levels.b)}`} />}
      <Row label="Why" value={plan?.reason ?? ('reason' in result ? result.reason : undefined)} />
    </>
  );
}

/**
 * Each phrase's energy over the whole song (drawn as loud as it sounds: see heardHeight), the one playing
 * in the accent color, with lines where the intro ends and the outro starts. A phrase that wasn't measured
 * (an older map of a long song, after its first 7 minutes) is left blank, so the outro still shows where it is.
 */
function Energy({ map, time }: { map: MixMap; time: number }) {
  const grid = beatGrid(map);
  if (!grid || !map.phraseEnergy.length) return null;
  const phrase = 16 * grid.beat;
  const total = Math.max(map.phraseEnergy.length, Math.ceil((map.soundEnd - grid.firstBar) / phrase));
  const now = Math.floor((time - grid.firstBar) / phrase);
  const energy = map.phraseEnergy[now];
  /** Where a time falls along the strip. */
  const place = (t: number) => `${Math.min(100, Math.max(0, ((t - grid.firstBar) / (phrase * total)) * 100))}%`;
  return (
    <Row
      label="Phrases"
      value={
        <span className="block">
          <span className="flex items-center gap-2">
            <span aria-hidden className="relative flex h-5 min-w-0 flex-1 items-end gap-px">
              {Array.from({ length: total }, (_, k) => {
                const e = map.phraseEnergy[k];
                return (
                  <span
                    key={k}
                    style={{ height: e == null ? '8%' : `${Math.max(8, heardHeight(e) * 100)}%` }}
                    className={cn(
                      'min-w-px flex-1 rounded-[1px]',
                      e == null ? 'bg-paper/5' : k === now ? 'bg-accent' : k < now ? 'bg-paper/35' : 'bg-paper/15',
                    )}
                  />
                );
              })}
              <span data-marker="intro" style={{ left: place(map.introEnd) }} className={cn(MARKER, 'bg-sky-300')} />
              <span data-marker="outro" style={{ left: place(map.outroStart) }} className={cn(MARKER, 'bg-rose-300')} />
            </span>
            <span className="shrink-0 tabular">{energy != null ? n2(energy) : '–'}</span>
          </span>
          <span className="mt-0.5 flex flex-wrap gap-x-3 text-[10px] text-muted">
            <span>
              <span aria-hidden className="mr-1 inline-block h-2 w-px bg-sky-300" />
              intro ends {at(map.introEnd)}
            </span>
            <span>
              <span aria-hidden className="mr-1 inline-block h-2 w-px bg-rose-300" />
              outro from {at(map.outroStart)}
            </span>
          </span>
        </span>
      }
    />
  );
}

/** A line across the phrase strip. */
const MARKER = 'absolute -top-0.5 -bottom-0.5 w-px';

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-2">
      <h3 className="mb-0.5 text-[9.5px] tracking-[0.2em] text-accent uppercase">{title}</h3>
      <dl className="grid grid-cols-[5.75rem_minmax(0,1fr)] gap-x-2">{children}</dl>
    </section>
  );
}

function Row({ label, value }: { label: string; value: ReactNode | undefined }) {
  if (value === undefined || value === '' || value === false) return null;
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-words tabular">{value}</dd>
    </>
  );
}

/**
 * How the last changeover of a kind went: which mix, how far apart the two files were when first measured,
 * and how close they ended up. "Into the Trees → Nanana · 23.4 ms apart, the new file ahead · in step to
 * 0.02 ms on the sound, after 640 ms"; or by the players' times and why.
 */
export function joinOf({ songs, foundMs, gapMs, tookMs, heard, fellBack }: JoinReport): string {
  const ms = (v: number) => `${v < 0.1 ? v.toFixed(2) : v < 10 ? v.toFixed(1) : Math.round(v)} ms`;
  const found = foundMs === undefined ? undefined : `${ms(Math.abs(foundMs))} apart, the new file ${foundMs >= 0 ? 'ahead' : 'behind'}`;
  const how = heard ? 'on the sound' : `by the players’ times${fellBack ? ` (${fellBack})` : ''}`;
  const result = `${gapMs === null ? 'not measured' : `in step to ${ms(gapMs)}`} ${how}, after ${Math.round(tookMs)} ms`;
  return [songs, found, result].filter(Boolean).join(' · ');
}

/** How far the server has got making the transition: "43% · mixing", "waiting · 2 ahead". */
export function makingOf({ step, done, ahead }: { step: string; done: number; ahead?: number }): string {
  if (step === 'waiting') return ahead ? `waiting · ${ahead} ahead` : 'waiting';
  return `${Math.floor(Math.min(1, Math.max(0, done)) * 100)}% · ${step}`;
}
