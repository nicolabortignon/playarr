import { Check } from 'lucide-react';
import { cn } from '../lib/cn';
import { ACCENTS, usePrefs, type AccentPref, type MotionPref } from '../lib/prefs';
import { useLocked } from '../lib/queries';
import { Choice, radioKeys } from './Choice';
import { AwayNotice, SettingsSection, Switch } from './SettingsControls';

const ACCENT_NAMES: Record<(typeof ACCENTS)[number], string> = {
  '#ff7a1a': 'Orange',
  '#f43f5e': 'Rose',
  '#a78bfa': 'Violet',
  '#38bdf8': 'Sky',
  '#34d399': 'Green',
  '#facc15': 'Yellow',
};
const ACCENT_CHOICES: readonly AccentPref[] = ['album', ...ACCENTS];
const accentName = (a: AccentPref) => (a === 'album' ? 'From the album art' : ACCENT_NAMES[a]);

const MOTION_OPTIONS: { value: MotionPref; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'reduce', label: 'Reduced' },
  { value: 'full', label: 'Full' },
];

/** Settings → Appearance: for this device, unless an admin has locked it for this account (then read-only). */
export function AppearancePanel() {
  const { accent, motion, formatBadges, statsForNerds, setAccent, setMotion, setFormatBadges, setStatsForNerds } = usePrefs();
  const locked = useLocked('appearance');
  return (
    <div>
      {locked && <AwayNotice>Only an admin can change Appearance for your account.</AwayNotice>}
      <SettingsSection title="Accent color">
        <AccentPicker value={accent} onChange={setAccent} disabled={locked} />
        <p className="mt-3 type-small text-muted">
          {accent === 'album'
            ? 'From the album art: the color follows the song playing.'
            : `${accentName(accent)}, whatever is playing.`}
        </p>
      </SettingsSection>

      <SettingsSection title="Motion" description="System follows this device’s setting for reduced motion. Reduced keeps animations to a minimum; Full always plays them.">
        <Choice label="Motion" options={MOTION_OPTIONS} value={motion} onChange={setMotion} disabled={locked} />
      </SettingsSection>

      <SettingsSection title="Audio format">
        <Switch
          label="Show audio format badges"
          description="The FLAC, MP3 and Hi-Res labels in the player, Now Playing, the queue and on albums."
          checked={formatBadges}
          onChange={setFormatBadges}
          disabled={locked}
        />
      </SettingsSection>

      <SettingsSection title="For the curious">
        <Switch
          label="Stats for nerds"
          description="An overlay with everything Playarr knows about the song playing: its tempo, key and beat grid as it plays, intro, outro and drop, loudness and the gain applied, the stream and its buffer, and the next transition."
          checked={statsForNerds}
          onChange={setStatsForNerds}
          disabled={locked}
        />
      </SettingsSection>
    </div>
  );
}

function AccentPicker({ value, onChange, disabled }: { value: AccentPref; onChange: (a: AccentPref) => void; disabled?: boolean }) {
  const keys = radioKeys(ACCENT_CHOICES, value, onChange);
  return (
    <div role="radiogroup" aria-label="Accent color" aria-disabled={disabled} onKeyDown={disabled ? undefined : keys.onKeyDown} className="flex flex-wrap items-center gap-3">
      {ACCENT_CHOICES.map((a, i) => {
        const checked = a === value;
        return (
          <button
            key={a}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={accentName(a)}
            title={accentName(a)}
            tabIndex={keys.tabIndexFor(i)}
            onClick={() => onChange(a)}
            disabled={disabled}
            style={
              a === 'album'
                ? { background: 'linear-gradient(135deg, #ff7a1a 0%, #f43f5e 35%, #a78bfa 68%, #38bdf8 100%)' }
                : { background: a }
            }
            className={cn(
              'grid size-10 place-items-center ring-offset-2 ring-offset-ink-900 transition',
              // The album art choice looks like a little cover; the fixed colors are round.
              a === 'album' ? 'rounded-md' : 'rounded-full',
              checked ? 'ring-2 ring-paper' : !disabled && 'hover:scale-105',
              disabled && !checked && 'opacity-40',
            )}
          >
            {checked && <Check aria-hidden className="size-4 text-ink-900" />}
          </button>
        );
      })}
    </div>
  );
}
