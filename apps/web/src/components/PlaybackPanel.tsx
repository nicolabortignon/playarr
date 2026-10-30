import { Fragment } from 'react';
import { OfflineStorage } from './OfflineStorage';
import { SettingsSection } from './SettingsControls';

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
  return (
    <div>
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
