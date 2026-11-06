import type { MixMap, MixMode, TransitionPlan } from '@playarr/mix';
import type { Track } from '@playarr/shared';
import { Blend } from 'lucide-react';
import { useId, useState } from 'react';
import { cn } from '../lib/cn';
import { formatTime } from '../lib/format';
import { usePrefs } from '../lib/prefs';
import { useMixMaps } from '../lib/queries';
import { upNext } from '../player/decks';
import { useSleep } from '../player/sleep';
import { useCurrentTrack, usePlayer } from '../player/store';
import { useTransition, type UpcomingResult } from '../player/transitions';
import { Dialog } from './Dialog';
import { BarTicks, EnergyNumbers, PhraseColumns, PhraseReadout, phrasesAndBars, type BarTick, type PhraseColumn } from './EnergyStrip';
import { Choice } from './Choice';

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

/**
 * The server's reasons for having no mix, in the listener's words (they're written for the logs, and
 * name things like mix maps). Anything not known here gets a plain catch-all.
 */
function plainReason(reason: string): string {
  if (reason.startsWith('No mix map yet for the song playing')) return 'This song hasn’t been analyzed yet';
  if (reason.startsWith('No mix map yet for the next song')) return 'The next song hasn’t been analyzed yet';
  if (reason === 'Mixed transitions need audio analysis') return 'Mixing needs audio analysis, which is off on this server';
  if (reason.startsWith('The transition couldn’t be')) return 'The mix couldn’t be made';
  return 'There’s no mix for these two songs';
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
      return { style: 'straight on', why: `${plainReason(result.reason)}, so the next song follows straight on.` };
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

/** The line as a screen reader should say it: "124 to 126 BPM", pauses for the dots. */
const spoken = (text: string) => text.replaceAll(' → ', ' to ').replaceAll(' · ', ', ');

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
  const sleepEnd = useSleep((s) => s.endOfSong);
  const fromFileId = useTransition((s) => s.fromFileId);
  const toFileId = useTransition((s) => s.toFileId);
  // With mixing on, the transition store names the pair it's working on; any other pair isn't mixed.
  const wanted = mixMode === 'off' || (fromFileId === from?.fileId && toFileId === to?.fileId);
  // The sleep timer stops after this song: nothing follows it, mixed or not.
  if (!dj || sleepEnd || !from || !to || from.fileId === to.fileId || !wanted) return null;
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
        aria-label={spoken(text)}
        onClick={() => setOpen(true)}
        // 44 px tall to tap, without pushing the transport away.
        className={cn(
          '-my-2 inline-flex min-h-11 max-w-full min-w-0 items-center gap-2 rounded-full text-[13px] text-paper-dim transition hover:text-paper',
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
        <Choice label="Mixing for this queue" options={MIX_MODES} value={mixMode} onChange={setMixMode} />
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

interface Phrase extends PhraseColumn {
  inMix: boolean;
}

interface Strip {
  title: string;
  /** "mixes out from 3:20"… */
  note: string;
  phrases: Phrase[];
  bars: BarTick[];
  /** The mix, 0–1 (zero width for a straight cut). */
  mix: { left: number; width: number };
}

/**
 * How long both songs sound together, from the start of the mix: until the song playing has faded
 * out (its gain's last step down to silence), else the plan's beats at its tempo. The rest of the
 * plan is the next song easing back to its own tempo, alone.
 */
export function overlapOf(plan: TransitionPlan, bpmA: number): number {
  const lastHeard = plan.aGain.findLastIndex((p) => p.value > 0);
  if (lastHeard >= 0) return Math.min(plan.aGain[lastHeard + 1]?.at ?? plan.length, plan.length);
  return bpmA > 0 && plan.beats > 0 ? Math.min((plan.beats * 60) / bpmA, plan.length) : plan.length;
}

/**
 * Where the next song's moments fall on the picture's clock (0: the start of the mix). During the mix
 * it's stretched to the playing song's tempo, so its seconds there run at the average rate.
 */
export function nextSongClock(plan: TransitionPlan): (songTime: number) => number {
  const span = plan.bResume - plan.bStart;
  const rate = plan.length > 0 && span > 0 ? span / plan.length : 1;
  return (t) => (t < plan.bStart ? t - plan.bStart : t <= plan.bStart + span ? (t - plan.bStart) / rate : plan.length + (t - plan.bStart - span));
}

/**
 * One song's phrases and bars between `from` and `to` seconds of the picture's clock, where 0 is
 * the start of the mix. `clock` turns a time in the song into that clock; `mixLength` is how long
 * the two songs overlap.
 */
function strip(title: string, note: string, map: MixMap, clock: (songTime: number) => number, from: number, to: number, mixLength: number): Strip {
  const span = to - from;
  const place = (t: number) => (Math.min(Math.max(t, from), to) - from) / span;
  const mixEnd = clock(map.duration);
  const mix = { left: place(0), width: place(Math.min(mixLength, mixEnd)) - place(0) };
  const { phrases, bars } = phrasesAndBars(map, clock, from, to);
  const inMix = (p: PhraseColumn) => (mixLength > 0 ? p.start < mixLength && p.end > 0 : p.start <= 0 && p.end > 0);
  return { title, note, phrases: phrases.map((p) => ({ ...p, inMix: inMix(p) })), bars, mix };
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
  const overlap = overlapOf(plan, a.map.bpm);
  const strips = [
    strip(a.track.title, `mixes out from ${formatTime(plan.aStart)}`, a.map, (t) => t - plan.aStart, from, to, overlap),
    strip(b.track.title, `comes in from ${formatTime(plan.bStart)}`, b.map, nextSongClock(plan), from, to, overlap),
  ];
  const hovered = hover && strips[hover.strip]!.phrases[hover.phrase];
  return (
    <figure aria-labelledby={id} className="min-w-0">
      <figcaption id={id} className="mb-3 flex items-baseline justify-between gap-3">
        <span className="font-mono text-[11px] tracking-[0.2em] text-muted uppercase">Energy around the mix</span>
        {hovered && <PhraseReadout phrase={hovered} />}
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
                // Edges as lines strong enough to see: the shading alone is too faint to read.
                className={cn('absolute inset-y-0', s.mix.width > 0 ? 'border-x border-paper/45 bg-paper/[0.08]' : 'w-px bg-paper/50')}
                style={{ left: `${s.mix.left * 100}%`, width: s.mix.width > 0 ? `${s.mix.width * 100}%` : undefined }}
              >
                {i === 0 && s.mix.width > 0 && <span className="absolute top-0.5 left-1 font-mono text-[10px] text-paper-dim">mix</span>}
              </div>
              <PhraseColumns
                phrases={s.phrases}
                hovered={hover ? (hover.strip === i ? hover.phrase : -1) : null}
                onHover={(phrase) => setHover({ strip: i, phrase })}
              />
            </div>
            <BarTicks bars={s.bars} />
          </div>
        ))}
      </div>
      <EnergyNumbers
        caption="Energy per phrase (16 beats) near the mix"
        extraHeader="In the mix"
        rows={strips.flatMap((s) => s.phrases.map((p) => ({ song: s.title, at: p.at, energy: p.energy, extra: p.inMix ? 'Yes' : '' })))}
      />
    </figure>
  );
}
