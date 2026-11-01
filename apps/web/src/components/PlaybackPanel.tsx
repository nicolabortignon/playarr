import { Fragment } from 'react';
import { CROSSFADES, usePrefs } from '../lib/prefs';
import { canSetVolume } from '../player/decks';
import { OfflineStorage } from './OfflineStorage';
import { PillGroup, SettingsSection, Switch } from './SettingsControls';

/** What player/useKeyboardShortcuts.ts does. */
const SHORTCUTS: { keys: string[][]; action: string }[] = [
  { keys: [['Space']], action: 'Play or pause' },
  { keys: [['←'], ['→']], action: 'Back or ahead 10 seconds' },
  { keys: [['Shift', '←'], ['Shift', '→']], action: 'Previous or next song' },
  { keys: [['↑'], ['↓']], action: 'Volume up or down' },
  { keys: [['M']], action: 'Mute or unmute' },
  { keys: [['S']], action: 'Shuffle on or off' },
  { keys: [['L']], action: 'Add the song playing to Favorites, or remove it' },
  { keys: [['/']], action: 'Search' },
];

const KBD =
  'inline-flex h-6 min-w-6 items-center justify-center rounded border border-line bg-ink-800 px-1.5 font-mono text-[11px] tracking-wider text-paper-dim uppercase';

/** Settings → Playback: for this device. */
export function PlaybackPanel() {
  const recordPlays = usePrefs((s) => s.recordPlays);
  const setRecordPlays = usePrefs((s) => s.setRecordPlays);
  const autoplay = usePrefs((s) => s.autoplay);
  const setAutoplay = usePrefs((s) => s.setAutoplay);
  const crossfade = usePrefs((s) => s.crossfade);
  const setCrossfade = usePrefs((s) => s.setCrossfade);
  const levelVolume = usePrefs((s) => s.levelVolume);
  const setLevelVolume = usePrefs((s) => s.setLevelVolume);
  const settable = canSetVolume();
  return (
    <div>
      <SettingsSection title="Playing">
        <div className="divide-y divide-line">
          <Switch
            label="Keep playing when the queue ends"
            description="Carries on with songs from your library like the last ones you heard."
            checked={autoplay}
            onChange={setAutoplay}
          />
          <Switch
            label="Count what this device plays"
            description="Off for a party speaker or a guest’s phone: what plays here won’t shape everyone’s mixes."
            checked={recordPlays}
            onChange={setRecordPlays}
          />
        </div>
      </SettingsSection>
      <SettingsSection
        title="Sound"
        description={
          settable
            ? 'Songs always follow each other without a gap.'
            : 'Songs always follow each other without a gap. This device sets the volume with its own buttons, so it can’t fade or even out songs.'
        }
      >
        <div className="divide-y divide-line">
          <Switch
            label="Even out the volume"
            description="Loud songs are turned down to match the rest; an album played in order keeps its own quiet and loud songs."
            checked={settable && levelVolume}
            onChange={setLevelVolume}
            disabled={!settable}
          />
          <div className="py-3">
            <div className="text-[15px] text-paper">Crossfade</div>
            <p className="mt-0.5 mb-3 text-[13px] text-muted">Fades each song into the next. Never between songs of an album played in order.</p>
            <PillGroup
              label="Crossfade"
              options={CROSSFADES.map((s) => ({ value: s, label: s ? `${s} s` : 'Off' }))}
              value={settable ? crossfade : 0}
              onChange={setCrossfade}
              disabled={!settable}
            />
          </div>
        </div>
      </SettingsSection>
      <OfflineStorage />
      <SettingsSection title="Keyboard shortcuts" description="They work anywhere in Playarr, except while you’re typing.">
        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-3">
          {SHORTCUTS.map(({ keys, action }) => (
            <Fragment key={action}>
              <dt className="flex flex-wrap items-center gap-1.5">
                {keys.map((combo, i) => (
                  <Fragment key={combo.join('+')}>
                    {i > 0 && <span className="text-[12px] text-muted">or</span>}
                    {combo.map((key, j) => (
                      <Fragment key={key}>
                        {j > 0 && <span className="text-[12px] text-muted">+</span>}
                        <kbd className={KBD}>{key}</kbd>
                      </Fragment>
                    ))}
                  </Fragment>
                ))}
              </dt>
              <dd className="text-[14px] text-paper-dim">{action}</dd>
            </Fragment>
          ))}
        </dl>
      </SettingsSection>
    </div>
  );
}
