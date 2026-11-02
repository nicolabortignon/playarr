import type { MixKind, MixSettings } from '@playarr/shared';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { ApiError } from '../lib/api';
import { plural } from '../lib/format';
import { useClearHistory, useMixSettings, useSaveMixSettings } from '../lib/queries';
import { Dialog } from './Dialog';
import { ListenBrainzSection } from './ListenBrainzSection';
import { AwayNotice, PillGroup, SettingsSection, Switch } from './SettingsControls';

/** Every kind of mix, as Settings names and explains it. */
const KINDS: { kind: MixKind; label: string; description: string }[] = [
  { kind: 'vibes', label: 'Vibes of the hour', description: 'What you play around this time of day. A new one every hour.' },
  { kind: 'discovery', label: 'Discovery Weekly', description: 'Songs in your library you haven’t played yet, picked for you. New every Monday.' },
  { kind: 'repeat', label: 'On Repeat', description: 'Your most played songs of the last 30 days.' },
  { kind: 'blast', label: 'Blast from the past', description: 'Songs you played a lot, then not for a while.' },
  { kind: 'genre', label: 'Genre mixes', description: 'One for each style you listen to most.' },
  { kind: 'deepcuts', label: 'Deep cuts', description: 'The songs you’ve barely played by the artists you love.' },
  { kind: 'fresh', label: 'Fresh arrivals', description: 'Songs from albums added in the last 30 days.' },
  { kind: 'decade', label: 'Time machine', description: 'One for each decade you have the most music from.' },
  { kind: 'energy', label: 'Energy boost', description: 'Loud, fast songs, building up.' },
  { kind: 'focus', label: 'Deep focus', description: 'Steady, mostly instrumental music to work to.' },
  { kind: 'winddown', label: 'Wind down', description: 'Calm, soft songs, slowing down.' },
  { kind: 'onthisday', label: 'On this day', description: 'Songs from albums released this week in years past.' },
];

const LENGTHS = [25, 50, 75, 100].map((n) => ({ value: n, label: String(n) }));
const ADVENTURE = [
  { value: 0, label: 'Familiar' },
  { value: 0.5, label: 'Balanced' },
  { value: 1, label: 'Adventurous' },
];
const BLAST = [
  { value: 30, label: 'A month' },
  { value: 90, label: '3 months' },
  { value: 180, label: '6 months' },
  { value: 365, label: 'A year' },
];
const COUNTS = [0, 1, 2, 3, 4].map((n) => ({ value: n, label: String(n) }));

/** The household's clock for hourly, daily and Monday mixes, with a way to switch to this device's. */
function TimeZone({ current, onChange }: { current?: string; onChange: (tz: string) => void }) {
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <div>
      <div className="mb-1.5 font-mono text-[11px] tracking-[0.2em] text-muted uppercase">Time zone</div>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[15px] text-paper">{current ?? 'The server’s'}</span>
        {here && here !== current && (
          <button
            type="button"
            onClick={() => onChange(here)}
            className="inline-flex h-9 items-center rounded-full border border-line px-4 text-[13px] text-paper transition hover:bg-paper/5"
          >
            Use this device’s ({here})
          </button>
        )}
      </div>
      <p className="mt-1 text-[13px] text-muted">When hours, days and Mondays begin for everyone’s mixes.</p>
    </div>
  );
}

/** Settings → Mixes: which mixes Home shows and how they're made, and the listening history behind them. */
export function MixesPanel() {
  const { data, error } = useMixSettings();
  const save = useSaveMixSettings();
  const clear = useClearHistory();
  const [confirmClear, setConfirmClear] = useState(false);
  const change = (patch: Partial<MixSettings>) => save.mutate(patch);

  if (error instanceof ApiError && error.status === 403) {
    return <AwayNotice>Settings can be changed from your home network.</AwayNotice>;
  }
  if (error && !data) return <p className="text-sm text-red-300/80">{error.message}</p>;
  if (!data) {
    return (
      <div aria-busy="true" aria-label="Loading" className="max-w-prose space-y-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-14 animate-pulse rounded-lg bg-paper/5" />
        ))}
      </div>
    );
  }

  const adventure = ADVENTURE.reduce((best, o) => (Math.abs(o.value - data.adventurous) < Math.abs(best.value - data.adventurous) ? o : best));
  const since = data.history.since ? new Date(data.history.since).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : undefined;

  return (
    <div>
      <SettingsSection title="Your mixes" description="Made for you from your library and what you play, at the top of Home.">
        <div className="divide-y divide-line">
          {KINDS.map(({ kind, label, description }) => (
            <Switch
              key={kind}
              label={label}
              description={description}
              checked={data.enabled[kind] !== false}
              onChange={(on) => change({ enabled: { [kind]: on } })}
            />
          ))}
        </div>
      </SettingsSection>

      <SettingsSection title="How they’re made">
        <div className="space-y-6">
          <TimeZone current={data.timeZone} onChange={(timeZone) => change({ timeZone })} />
          <PillGroup label="Songs per mix" options={LENGTHS} value={data.length} onChange={(length) => change({ length: length as MixSettings['length'] })} />
          <PillGroup label="Discovery Weekly" options={ADVENTURE} value={adventure.value} onChange={(adventurous) => change({ adventurous })} />
          <PillGroup
            label="Blast from the past: not heard for"
            options={BLAST}
            value={data.blastDays}
            onChange={(blastDays) => change({ blastDays: blastDays as MixSettings['blastDays'] })}
          />
          <PillGroup label="Genre mixes" options={COUNTS} value={data.genreMixes} onChange={(genreMixes) => change({ genreMixes })} />
          <PillGroup label="Decade mixes" options={COUNTS} value={data.decadeMixes} onChange={(decadeMixes) => change({ decadeMixes })} />
        </div>
      </SettingsSection>

      <SettingsSection
        title="Listening history"
        description="What the mixes learn from: each song heard for 30 seconds, or skipped, and at what time of day. It stays on this server."
      >
        <div className="divide-y divide-line">
          <Switch
            label="Remember what’s played"
            description="Off stops recording; the mixes keep using what’s already there."
            checked={data.recordHistory}
            onChange={(recordHistory) => change({ recordHistory })}
          />
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line px-4 py-3">
          <p className="text-sm text-paper-dim">
            {data.history.plays ? `${plural(data.history.plays, 'song')} played${since ? ` since ${since}` : ''}` : 'Nothing played yet'}
          </p>
          <button
            type="button"
            disabled={!data.history.plays || clear.isPending}
            onClick={() => setConfirmClear(true)}
            className="inline-flex h-9 items-center gap-2 rounded-full border border-line px-4 text-[13px] text-paper transition hover:bg-paper/5 disabled:opacity-40"
          >
            <Trash2 className="size-4" /> Clear history
          </button>
        </div>
      </SettingsSection>

      <ListenBrainzSection />

      <SettingsSection title="Sound">
        <p className="text-sm text-muted">
          Energy boost, Wind down, Deep focus and Vibes of the hour are better once Playarr has measured how songs sound (tempo,
          loudness, energy); until then they go by genre. Measure every song in{' '}
          <Link to="/settings/analysis" className="text-paper-dim underline underline-offset-2 hover:text-paper">
            Settings → Analysis
          </Link>
          .
        </p>
      </SettingsSection>

      <Dialog open={confirmClear} onClose={() => setConfirmClear(false)} title="Clear listening history?">
        <div className="space-y-5 p-5">
          <p className="text-[15px] text-paper-dim">
            Every song played is forgotten, and the mixes start learning again from scratch. Favorites and playlists stay.
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirmClear(false)}
              className="inline-flex h-10 items-center rounded-full border border-line px-5 text-[14px] text-paper transition hover:bg-paper/5"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => clear.mutate(undefined, { onSettled: () => setConfirmClear(false) })}
              className="inline-flex h-10 items-center rounded-full bg-red-400/90 px-5 text-[14px] font-medium text-ink-950 transition hover:bg-red-400"
            >
              Clear history
            </button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
