import { Check } from 'lucide-react';
import { cn } from '../lib/cn';
import { ACCENTS, usePrefs, type AccentPref, type MotionPref } from '../lib/prefs';
import { PillGroup, radioKeys, SettingsSection, Switch } from './SettingsControls';

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

/** Settings → Appearance: for this device. */
export function AppearancePanel() {
  const { accent, motion, formatBadges, setAccent, setMotion, setFormatBadges } = usePrefs();
  return (
    <div>
      <SettingsSection title="Accent color">
        <AccentPicker value={accent} onChange={setAccent} />
        <p className="mt-3 text-[13px] text-muted">
          {accent === 'album'
            ? 'From the album art: the color follows the song playing.'
            : `${accentName(accent)}, whatever is playing.`}
        </p>
      </SettingsSection>

      <SettingsSection title="Motion" description="System follows this device’s setting for reduced motion. Reduced keeps animations to a minimum; Full always plays them.">
        <PillGroup label="Motion" options={MOTION_OPTIONS} value={motion} onChange={setMotion} />
      </SettingsSection>

      <SettingsSection title="Audio format">
        <Switch
          label="Show audio format badges"
          description="The FLAC, MP3 and Hi-Res labels in the player, Now Playing, the queue and on albums."
          checked={formatBadges}
          onChange={setFormatBadges}
        />
      </SettingsSection>
    </div>
  );
}

function AccentPicker({ value, onChange }: { value: AccentPref; onChange: (a: AccentPref) => void }) {
  const keys = radioKeys(ACCENT_CHOICES, value, onChange);
  return (
    <div role="radiogroup" aria-label="Accent color" onKeyDown={keys.onKeyDown} className="flex flex-wrap items-center gap-3">
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
            style={
              a === 'album'
                ? { background: 'linear-gradient(135deg, #ff7a1a 0%, #f43f5e 35%, #a78bfa 68%, #38bdf8 100%)' }
                : { background: a }
            }
            className={cn(
              'grid size-10 place-items-center ring-offset-2 ring-offset-ink-900 transition',
              // The album art choice looks like a little cover; the fixed colors are round.
              a === 'album' ? 'rounded-md' : 'rounded-full',
              checked ? 'ring-2 ring-paper' : 'hover:scale-105',
            )}
          >
            {checked && <Check aria-hidden className="size-4 text-ink-900" strokeWidth={3} />}
          </button>
        );
      })}
    </div>
  );
}
