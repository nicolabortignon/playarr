import { Fragment } from 'react';
import { Link } from 'react-router';
import { useHasKeyboard } from '../lib/keyboard';
import { CROSSFADES, usePrefs, type Transitions } from '../lib/prefs';
import { useLocked } from '../lib/queries';
import { canSetVolume } from '../player/decks';
import { OfflineStorage } from './OfflineStorage';
import { Choice } from './Choice';
import { AwayNotice, SettingsSection, Switch } from './SettingsControls';
import { Keys, SHORTCUT_SIDES } from './Shortcuts';

/** Lengths offered once Crossfade is chosen: 0 seconds would just be Off. */
const CROSSFADE_LENGTHS = CROSSFADES.filter((s) => s > 0).map((s) => ({ value: s, label: `${s} s` }));

/** Settings → Playback: for this device, unless an admin has locked it for this account (then read-only). */
export function PlaybackPanel() {
  const locked = useLocked('playback');
  const recordPlays = usePrefs((s) => s.recordPlays);
  const setRecordPlays = usePrefs((s) => s.setRecordPlays);
  const autoplay = usePrefs((s) => s.autoplay);
  const setAutoplay = usePrefs((s) => s.setAutoplay);
  const transitions = usePrefs((s) => s.transitions);
  const setTransitions = usePrefs((s) => s.setTransitions);
  const crossfade = usePrefs((s) => s.crossfade);
  const setCrossfade = usePrefs((s) => s.setCrossfade);
  const levelVolume = usePrefs((s) => s.levelVolume);
  const setLevelVolume = usePrefs((s) => s.setLevelVolume);
  const settable = canSetVolume();
  // Only where there's a keyboard to press them on (lib/keyboard.ts): not on a phone, nor a tablet without one.
  const keyboard = useHasKeyboard();
  // A device that can't fade plays a saved Crossfade without a gap, so show it as Off there.
  // DJ mix stays: its transitions are mixed before they reach the device, no volume needed.
  const shown: Transitions = !settable && transitions === 'crossfade' ? 'off' : transitions;
  const transitionOptions: { value: Transitions; label: string; disabled?: boolean }[] = [
    { value: 'off', label: 'Off' },
    { value: 'crossfade', label: 'Crossfade', disabled: !settable },
    { value: 'dj', label: 'DJ mix' },
  ];
  return (
    <div>
      {locked && <AwayNotice>Only an admin can change Playback for your account.</AwayNotice>}
      <SettingsSection title="Playing">
        <div className="divide-y divide-line">
          <Switch
            label="Keep playing when the queue ends"
            description="Carries on with songs from your library like the last ones you heard."
            checked={autoplay}
            onChange={setAutoplay}
            disabled={locked}
          />
          <Switch
            label="Count what this device plays"
            description="Off for a party speaker or a guest’s phone: what plays here won’t shape everyone’s mixes."
            checked={recordPlays}
            onChange={setRecordPlays}
            disabled={locked}
          />
        </div>
      </SettingsSection>
      <SettingsSection
        title="Sound"
        description={
          settable
            ? 'Songs always follow each other without a gap.'
            : 'Songs always follow each other without a gap. This device sets the volume with its own buttons, so it can’t crossfade. DJ mix still works here, joining songs on the beat.'
        }
      >
        <div className="divide-y divide-line">
          <Switch
            label="Even out the volume"
            description="Every song plays as loud as the next (−14 LUFS, as streaming services do): loud ones turned down, quiet ones up as far as they can go. An album played in order keeps its own quiet and loud songs. Songs are leveled once Settings → Analysis has measured their loudness."
            checked={levelVolume}
            onChange={setLevelVolume}
            disabled={locked}
          />
          <div className="py-3">
            <div className="mb-3 type-body text-paper">Transitions</div>
            <Choice label="Transitions" options={transitionOptions} value={shown} onChange={setTransitions} disabled={locked} />
            {shown === 'crossfade' && (
              <>
                <p className="mt-3 mb-3 type-small text-muted">Fades each song into the next. Never between songs of an album played in order.</p>
                <Choice label="Crossfade length" options={CROSSFADE_LENGTHS} value={crossfade} onChange={setCrossfade} disabled={locked} />
              </>
            )}
            {shown === 'dj' && (
              <>
                <p className="mt-3 mb-3 type-small text-muted">
                  Songs are mixed like a DJ would, when their beats allow: long blends, quick mixes or straight on. Songs that can’t be
                  mixed on the beat fade into each other for this long:
                </p>
                <Choice label="Fade length" options={CROSSFADE_LENGTHS} value={crossfade} onChange={setCrossfade} disabled={locked} />
                <p className="mt-3 type-small text-muted">
                  How many songs are ready for DJ mix, and analyzing the rest now:{' '}
                  <Link to="/settings/analysis" className="text-paper-dim underline underline-offset-2 hover:text-paper">
                    Settings → Analysis
                  </Link>
                  .
                </p>
              </>
            )}
          </div>
        </div>
      </SettingsSection>
      <OfflineStorage />
      {keyboard && (
        <SettingsSection
          title="Keyboard shortcuts"
          description={
            <>
              They work anywhere in Playarr, except while you’re typing. Press <Keys keys={[['?']]} /> to see them over any page.
            </>
          }
        >
          <dl className="grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-3">
            {SHORTCUT_SIDES.flatMap(({ shortcuts }) => shortcuts).map(({ keys, action }) => (
              <Fragment key={action}>
                <dt>
                  <Keys keys={keys} />
                </dt>
                <dd className="type-small text-paper-dim">{action}</dd>
              </Fragment>
            ))}
          </dl>
        </SettingsSection>
      )}
    </div>
  );
}
