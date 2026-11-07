import type { MixKind, MixSettings } from '@playarr/shared';
import { Trash } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { ApiError } from '../lib/api';
import { plural } from '../lib/format';
import { useClearHistory, useIsMember, useMixSettings, useSaveMixSettings } from '../lib/queries';
import { Button } from './Button';
import { ConfirmDialog } from './Dialog';
import { ListenBrainzSection } from './ListenBrainzSection';
import { Choice } from './Choice';
import { AwayNotice, SettingsSection, Switch } from './SettingsControls';
import { InlineError } from './States';

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
  { kind: 'energy', label: 'Energy boost', description: 'Songs with a driving beat, building to the peak.' },
  { kind: 'chill', label: 'Chill', description: 'Laid-back songs with an easy groove, warm and unhurried.' },
  { kind: 'focus', label: 'Deep focus', description: 'Steady, instrumental music that stays out of the way.' },
  { kind: 'winddown', label: 'Wind down', description: 'Soft, slow songs for the end of the day, settling down.' },
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

/** The household's clock for hourly, daily and Monday mixes, with a way to switch to this device's (for admins). */
function TimeZone({ current, onChange }: { current?: string; onChange?: (tz: string) => void }) {
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <div>
      <div className="mb-1.5 type-kicker text-muted">Time zone</div>
      <div className="flex flex-wrap items-center gap-3">
        <span className="type-body text-paper">{current ?? 'The server’s'}</span>
        {onChange && here && here !== current && (
          <Button onClick={() => onChange(here)}>Use this device’s ({here})</Button>
        )}
      </div>
      <p className="mt-1 type-small text-muted">When hours, days and Mondays begin for everyone’s mixes.</p>
    </div>
  );
}

/** Settings → Mixes: which mixes Home shows and how they're made, and the listening history behind them. */
export function MixesPanel() {
  const { data, error, refetch, isFetching } = useMixSettings();
  const save = useSaveMixSettings();
  const clear = useClearHistory();
  const [confirmClear, setConfirmClear] = useState(false);
  // How mixes are made is the server's: a member sees it but can't change it (their history and ListenBrainz are theirs).
  const readOnly = useIsMember();
  const change = (patch: Partial<MixSettings>) => save.mutate(patch);

  if (error instanceof ApiError && error.status === 403) {
    return <AwayNotice />;
  }
  if (error && !data) return <InlineError error={error} onRetry={() => void refetch()} retrying={isFetching} />;
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
      {readOnly && <AwayNotice>Only an admin can change how mixes are made.</AwayNotice>}
      <SettingsSection title="Your mixes" description="Made for you from your library and what you play, at the top of Home.">
        <div className="divide-y divide-line">
          {KINDS.map(({ kind, label, description }) => (
            <Switch
              key={kind}
              label={label}
              description={description}
              checked={data.enabled[kind] !== false}
              onChange={(on) => change({ enabled: { [kind]: on } })}
              disabled={readOnly}
            />
          ))}
        </div>
      </SettingsSection>

      <SettingsSection title="How they’re made">
        <div className="space-y-6">
          <TimeZone current={data.timeZone} onChange={readOnly ? undefined : (timeZone) => change({ timeZone })} />
          <Choice
            label="Songs per mix"
            options={LENGTHS}
            value={data.length}
            onChange={(length) => change({ length: length as MixSettings['length'] })}
            disabled={readOnly}
          />
          <Choice label="Discovery Weekly" options={ADVENTURE} value={adventure.value} onChange={(adventurous) => change({ adventurous })} disabled={readOnly} />
          <Choice
            label="Blast from the past: not heard for"
            options={BLAST}
            value={data.blastDays}
            onChange={(blastDays) => change({ blastDays: blastDays as MixSettings['blastDays'] })}
            disabled={readOnly}
          />
          <Choice label="Genre mixes" options={COUNTS} value={data.genreMixes} onChange={(genreMixes) => change({ genreMixes })} disabled={readOnly} />
          <Choice label="Decade mixes" options={COUNTS} value={data.decadeMixes} onChange={(decadeMixes) => change({ decadeMixes })} disabled={readOnly} />
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
            disabled={readOnly}
          />
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line px-4 py-3">
          <p className="text-sm text-paper-dim">
            {data.history.plays ? `${plural(data.history.plays, 'song')} played${since ? ` since ${since}` : ''}` : 'Nothing played yet'}
          </p>
          <Button icon={<Trash />} disabled={!data.history.plays || clear.isPending} onClick={() => setConfirmClear(true)}>
            Clear history
          </Button>
        </div>
      </SettingsSection>

      <ListenBrainzSection />

      <SettingsSection title="Sound">
        <p className="text-sm text-muted">
          Energy boost, Chill, Deep focus, Wind down and Vibes of the hour are better once Playarr has measured how songs sound
          (tempo, loudness, energy); until then they go by genre. Measure every song in{' '}
          <Link to="/settings/analysis" className="text-paper-dim underline underline-offset-2 hover:text-paper">
            Settings → Analysis
          </Link>
          .
        </p>
      </SettingsSection>

      <ConfirmDialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        title="Clear listening history?"
        confirmLabel="Clear history"
        pendingLabel="Clearing…"
        pending={clear.isPending}
        onConfirm={() => clear.mutate(undefined, { onSettled: () => setConfirmClear(false) })}
      >
        <p>
          {data.history.plays > 1 ? `All ${plural(data.history.plays, 'song')} played are` : 'Every song played is'} forgotten for good, and the mixes
          start learning again from scratch. Favorites and playlists stay.
        </p>
      </ConfirmDialog>
    </div>
  );
}
