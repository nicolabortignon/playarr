import type { MixMap, MixMode, TransitionPlan } from '@playarr/mix';
import type { Track } from '@playarr/shared';
import { Blend } from 'lucide-react';
import { useId, useState } from 'react';
import { cn } from '../lib/cn';
import { formatTime } from '../lib/format';
import { usePrefs } from '../lib/prefs';
import { useMixMaps } from '../lib/queries';
import { upNext } from '../player/decks';
import { useCurrentTrack, usePlayer } from '../player/store';
import { useTransition, type UpcomingResult } from '../player/transitions';
import { Dialog } from './Dialog';
import { PillGroup } from './SettingsControls';

/** Keys this unsure aren't worth showing: they'd be a guess. */
const MIN_KEY_CONFIDENCE = 0.3;
/** Seconds shown either side of the mix in the energy picture (more for a long mix). */
const PAD_S = 24;

const MIX_MODES: readonly { value: MixMode; label: string; hint: string }[] = [
  { value: 'auto', label: 'Auto', hint: 'Songs are blended when they suit it, and mixed quickly when they don’t.' },
  { value: 'party', label: 'Party', hint: 'Longer blends, more often: for a party that shouldn’t stop.' },
  { value: 'off', label: 'No mixing', hint: 'Songs follow each other straight on, without a gap.' },
];

/** What's known of the next transition, in words. */
interface Upcoming {
  /** "32-beat blend", "straight on"… (lower case: it follows "Next:"). */
  style: string;
  /** Why it's that: the plan's reason, or why there's no mix. */
  why: string;
  /** The server's plan, once it has one. */
  plan?: TransitionPlan;
  /** Planned, but the mix is still being made. */
  preparing?: boolean;
}

function styleName(plan: TransitionPlan): string {
  switch (plan.style) {
    case 'long':
      return plan.beats > 0 ? `${plan.beats}-beat blend` : 'blend';
    case 'quick':
      return plan.beats > 0 ? `${plan.beats}-beat quick mix` : 'quick mix';
    case 'fade':
      return 'crossfade';
    case 'straight':
      return 'straight on';
  }
}

/** Without a mix (unavailable, too late, mixing off) DJ mix plays the next song straight on, without a gap. */
function describe(result: UpcomingResult | null, mixMode: MixMode): Upcoming {
  if (mixMode === 'off') return { style: 'no mixing', why: 'Mixing is off for this queue, so the next song follows straight on.' };
  if (!result) return { style: 'planning the mix', why: 'Working out how these two songs go together…' };
  switch (result.status) {
    case 'ready':
    case 'straight':
      return { style: styleName(result.plan), why: result.plan.reason, plan: result.plan };
    case 'pending':
      return { style: styleName(result.plan), why: result.plan.reason, plan: result.plan, preparing: true };
    case 'unavailable':
      return { style: 'straight on', why: `${result.reason}, so the next song follows straight on.` };
    case 'gave up':
      return { style: 'straight on', why: 'The mix wasn’t ready in time, so the next song follows straight on.' };
  }
}

const bpmOf = (map: MixMap | undefined) => (map && map.bpm > 0 ? Math.round(map.bpm) : undefined);
const keyOf = (map: MixMap | undefined) => (map?.key && map.key.confidence >= MIN_KEY_CONFIDENCE ? map.key.camelot : undefined);

/** "124 → 126 BPM" and "8A → 9A", each only when known for both songs. */
function pairFacts(a: MixMap | undefined, b: MixMap | undefined): string[] {
  const facts: string[] = [];
  const [bpmA, bpmB] = [bpmOf(a), bpmOf(b)];
  if (bpmA && bpmB) facts.push(`${bpmA} → ${bpmB} BPM`);
  const [keyA, keyB] = [keyOf(a), keyOf(b)];
  if (keyA && keyB) facts.push(`${keyA} → ${keyB}`);
  return facts;
}

const capitalized = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * "Next: 32-beat blend · 124 → 126 BPM · 8A → 9A" under the transport (and the queue's current song),
 * opening a sheet with the why, both songs' energy around the mix, and this queue's mixing. Only for
 * DJ mix, and only when the next song is wanted mixed (not when the sleep timer stops after this one).
 */
export function TransitionView({ className }: { className?: string }) {
  const dj = usePrefs((s) => s.transitions === 'dj');
  const from = useCurrentTrack();
  const to = usePlayer(upNext);
  const mixMode = usePlayer((s) => s.mixMode);
  const fromFileId = useTransition((s) => s.fromFileId);
  const toFileId = useTransition((s) => s.toFileId);
  // With mixing on, the transition store names the pair it's working on; any other pair isn't mixed.
  const wanted = mixMode === 'off' || (fromFileId === from?.fileId && toFileId === to?.fileId);
  if (!dj || !from || !to || from.fileId === to.fileId || !wanted) return null;
  return <Line from={from} to={to} mixMode={mixMode} className={className} />;
}

function Line({ from, to, mixMode, className }: { from: Track; to: Track; mixMode: MixMode; className?: string }) {
  const [open, setOpen] = useState(false);
  const result = useTransition((s) => s.result);
  const maps = useMixMaps([from.recordingId, to.recordingId]).data;
  const a = maps?.[from.recordingId];
  const b = maps?.[to.recordingId];
  const upcoming = describe(result, mixMode);
  const text = ['Next: ' + upcoming.style, ...pairFacts(a, b)].join(' · ');
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className={cn(
          'inline-flex max-w-full min-w-0 items-center gap-2 rounded-full py-1 text-[13px] text-paper-dim transition hover:text-paper',
          className,
        )}
      >
        <Blend className="size-3.5 shrink-0 text-muted" aria-hidden />
        <span className="truncate tabular">{text}</span>
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Next transition">
        <Sheet from={from} to={to} a={a} b={b} upcoming={upcoming} mixMode={mixMode} />
      </Dialog>
    </>
  );
}

function Sheet({ from, to, a, b, upcoming, mixMode }: { from: Track; to: Track; a?: MixMap; b?: MixMap; upcoming: Upcoming; mixMode: MixMode }) {
  const setMixMode = usePlayer((s) => s.setMixMode);
  const { plan } = upcoming;
  return (
    <div className="space-y-6 px-5 py-5">
      <div>
        <p className="font-display text-2xl leading-tight text-paper">{capitalized(upcoming.style)}</p>
        {upcoming.preparing && <p className="mt-1 font-mono text-[11px] tracking-[0.15em] text-muted uppercase">Getting the mix ready…</p>}
        <p className="mt-2 text-sm text-paper-dim">{upcoming.why}</p>
      </div>

      <dl className="space-y-1.5 text-sm">
        <SongFacts label="Now" track={from} map={a} />
        <SongFacts label="Next" track={to} map={b} />
      </dl>

      {plan && a && b && <EnergyAroundTheMix plan={plan} a={{ track: from, map: a }} b={{ track: to, map: b }} />}

      <section>
        <h3 className="mb-2 font-mono text-[11px] tracking-[0.2em] text-muted uppercase">Mixing for this queue</h3>
        <PillGroup label="Mixing for this queue" options={MIX_MODES} value={mixMode} onChange={setMixMode} />
        <p className="mt-2 text-[13px] text-muted">{MIX_MODES.find((m) => m.value === mixMode)?.hint}</p>
      </section>
    </div>
  );
}

function SongFacts({ label, track, map }: { label: string; track: Track; map?: MixMap }) {
  const facts = [bpmOf(map) && `${bpmOf(map)} BPM`, keyOf(map)].filter(Boolean);
  return (
    <div className="flex min-w-0 items-baseline gap-3">
      <dt className="w-10 shrink-0 font-mono text-[11px] tracking-[0.15em] text-muted uppercase">{label}</dt>
      <dd className="min-w-0 flex-1 truncate text-paper">{track.title}</dd>
      {facts.length > 0 && <dd className="shrink-0 text-paper-dim tabular">{facts.join(' · ')}</dd>}
    </div>
  );
}

interface Phrase {
  /** Seconds into the song. */
  at: number;
  energy: number;
  /** Position and width in the picture, 0–1. */
  left: number;
  width: number;
  inMix: boolean;
}

interface Strip {
  title: string;
  /** "mixes out from 3:20"… */
  note: string;
  phrases: Phrase[];
  /** Bar lines in the picture, 0–1; `phrase` marks every fourth (a phrase start). */
  bars: { left: number; phrase: boolean }[];
  /** The mix, 0–1 (zero width for a straight cut). */
  mix: { left: number; width: number };
}

/**
 * One song's phrases and bars between `from` and `to` seconds of the picture's clock, where 0 is
 * the start of the mix. `clock` turns a time in the song into that clock.
 */
function strip(title: string, note: string, map: MixMap, clock: (songTime: number) => number, from: number, to: number, mixLength: number): Strip {
  const span = to - from;
  const place = (t: number) => (Math.min(Math.max(t, from), to) - from) / span;
  const mixEnd = clock(map.duration);
  const mix = { left: place(0), width: place(Math.min(mixLength, mixEnd)) - place(0) };
  const phrases: Phrase[] = [];
  const bars: Strip['bars'] = [];
  if (map.bpm > 0) {
    const beat = 60 / map.bpm;
    const firstBar = map.firstBeat + map.downbeatOffset * beat;
    map.phraseEnergy.forEach((energy, k) => {
      const at = firstBar + k * 16 * beat;
      const start = clock(at);
      const end = clock(Math.min(at + 16 * beat, map.duration));
      if (end <= from || start >= to) return;
      const inMix = mixLength > 0 ? start < mixLength && end > 0 : start <= 0 && end > 0;
      phrases.push({ at, energy, left: place(start), width: place(end) - place(start), inMix });
    });
    for (let n = Math.max(0, Math.ceil(-firstBar / (4 * beat))); ; n++) {
      const at = firstBar + n * 4 * beat;
      if (at > map.duration) break;
      const t = clock(at);
      if (t > to) break;
      if (t >= from) bars.push({ left: place(t), phrase: n % 4 === 0 });
    }
  }
  return { title, note, phrases, bars, mix };
}

/**
 * Both songs' energy per phrase around the mix, on one clock: the next song is lined up where it
 * comes in, so the shaded mix is the same stretch in both. One color, bar ticks underneath, and the
 * numbers in a table.
 */
function EnergyAroundTheMix({ plan, a, b }: { plan: TransitionPlan; a: { track: Track; map: MixMap }; b: { track: Track; map: MixMap } }) {
  const id = useId();
  const [hover, setHover] = useState<{ strip: number; phrase: number } | null>(null);
  const pad = Math.max(PAD_S, plan.length / 2);
  const from = -pad;
  const to = plan.length + pad;
  // The next song is stretched to the tempo during the mix: its seconds there run at the average rate.
  const bSpan = plan.bResume - plan.bStart;
  const rate = plan.length > 0 && bSpan > 0 ? bSpan / plan.length : 1;
  const bClock = (t: number) =>
    t < plan.bStart ? t - plan.bStart : t <= plan.bStart + bSpan ? (t - plan.bStart) / rate : plan.length + (t - plan.bStart - bSpan);
  const strips = [
    strip(a.track.title, `mixes out from ${formatTime(plan.aStart)}`, a.map, (t) => t - plan.aStart, from, to, plan.length),
    strip(b.track.title, `comes in from ${formatTime(plan.bStart)}`, b.map, bClock, from, to, plan.length),
  ];
  const hovered = hover && strips[hover.strip]!.phrases[hover.phrase];
  return (
    <figure aria-labelledby={id} className="min-w-0">
      <figcaption id={id} className="mb-3 flex items-baseline justify-between gap-3">
        <span className="font-mono text-[11px] tracking-[0.2em] text-muted uppercase">Energy around the mix</span>
        {hovered && (
          <span className="text-[13px] text-paper-dim tabular" aria-live="polite">
            <span className="text-paper">{formatTime(hovered.at)}</span> · {Math.round(hovered.energy * 100)}%
          </span>
        )}
      </figcaption>
      <div className="space-y-3" onPointerLeave={() => setHover(null)}>
        {strips.map((s, i) => (
          <div key={i}>
            <div className="mb-1 flex items-baseline justify-between gap-3 text-[12px]">
              <span className="min-w-0 truncate text-paper-dim">{s.title}</span>
              <span className="shrink-0 text-muted tabular">{s.note}</span>
            </div>
            <div className="relative h-12" aria-hidden>
              <div
                className={cn('absolute inset-y-0 rounded-[2px]', s.mix.width > 0 ? 'bg-paper/[0.08]' : 'w-px bg-paper/50')}
                style={{ left: `${s.mix.left * 100}%`, width: s.mix.width > 0 ? `${s.mix.width * 100}%` : undefined }}
              >
                {i === 0 && s.mix.width > 0 && <span className="absolute top-0.5 left-1 font-mono text-[10px] text-muted">mix</span>}
              </div>
              <div className="absolute inset-x-0 bottom-0 h-px bg-line" />
              {s.phrases.map((p, k) => (
                // The whole phrase's height is the hover target, however low its energy.
                <div
                  key={k}
                  className="absolute inset-y-0 flex items-end"
                  style={{ left: `${p.left * 100}%`, width: `calc(${p.width * 100}% - 2px)` }}
                  onPointerEnter={() => setHover({ strip: i, phrase: k })}
                >
                  <div
                    className={cn(
                      'w-full rounded-t-[4px] bg-accent transition-opacity duration-150',
                      hover && (hover.strip !== i || hover.phrase !== k) && 'opacity-45',
                    )}
                    style={{ height: `max(${p.energy * 100}%, 2px)` }}
                  />
                </div>
              ))}
            </div>
            <div className="relative mt-0.5 h-1.5" aria-hidden>
              {s.bars.map((bar, k) => (
                <div
                  key={k}
                  className={cn('absolute top-0 w-px', bar.phrase ? 'h-1.5 bg-paper/40' : 'h-1 bg-paper/15')}
                  style={{ left: `${bar.left * 100}%` }}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      <details className="mt-3">
        <summary className="cursor-pointer font-mono text-[10px] tracking-[0.15em] text-muted uppercase hover:text-paper">Numbers</summary>
        <table className="mt-2 w-full text-[13px]">
          <caption className="sr-only">Energy per phrase (16 beats) near the mix</caption>
          <thead>
            <tr className="border-b border-line text-left font-mono text-[10px] tracking-[0.15em] text-muted uppercase">
              <th scope="col" className="py-1 font-normal">Song</th>
              <th scope="col" className="py-1 text-right font-normal">From</th>
              <th scope="col" className="py-1 text-right font-normal">Energy</th>
              <th scope="col" className="py-1 text-right font-normal">In the mix</th>
            </tr>
          </thead>
          <tbody>
            {strips.flatMap((s, i) =>
              s.phrases.map((p, k) => (
                <tr key={`${i}-${k}`} className="border-b border-line/60">
                  <th scope="row" className="max-w-0 truncate py-1 text-left font-normal text-paper-dim">
                    {s.title}
                  </th>
                  <td className="py-1 text-right text-paper tabular">{formatTime(p.at)}</td>
                  <td className="py-1 text-right text-paper tabular">{Math.round(p.energy * 100)}%</td>
                  <td className="py-1 text-right text-paper-dim">{p.inMix ? 'Yes' : ''}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
