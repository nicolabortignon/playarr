import { Fragment } from 'react';
import type { MixMapProgress } from '../lib/api';
import { CROSSFADES, usePrefs, type Transitions } from '../lib/prefs';
import { useAnalyzeForMixing, useMixMapProgress } from '../lib/queries';
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

/** Lengths offered once Crossfade is chosen: 0 seconds would just be Off. */
const CROSSFADE_LENGTHS = CROSSFADES.filter((s) => s > 0).map((s) => ({ value: s, label: `${s} s` }));

const KBD =
  'inline-flex h-6 min-w-6 items-center justify-center rounded border border-line bg-ink-800 px-1.5 font-mono text-[11px] tracking-wider text-paper-dim uppercase';

/** 5678 → "5,678": the rest of the panel is in English, so its numbers are too. */
const count = (n: number) => n.toLocaleString('en');
const songs = (n: number) => `${count(n)} ${n === 1 ? 'song' : 'songs'}`;

/**
 * What the line under DJ mix says about the library's songs: how many can be mixed, what's left to do,
 * and how many were analysed without the beat model (it couldn't run on the server).
 */
function mixProgressText(p: MixMapProgress): string {
  if (!p.enabled) return 'DJ mix needs audio analysis, which is off on this server (set ANALYSIS=on in its .env).';
  const withoutModel = p.ready > p.beatModel ? ` (${count(p.ready - p.beatModel)} without the beat model)` : '';
  if (p.ready >= p.songs) {
    return p.songs === 1 ? `The library’s one song is ready for DJ mix${withoutModel}.` : `All ${songs(p.songs)} are ready for DJ mix${withoutModel}.`;
  }
  const failed = p.failed > 0 ? `${count(p.failed)} couldn’t be analysed` : '';
  // Without the library-wide scan there's no backlog to count down: songs are measured when they're needed.
  if (!p.libraryScan) {
    return `${count(p.ready)} of ${songs(p.songs)} are ready for DJ mix${withoutModel}. Others are analysed as they come up to play${failed ? `; ${failed}` : ''}.`;
  }
  const waiting = p.waiting > 0 ? `${count(p.waiting)} waiting to be analysed` : '';
  return `${[`Ready for DJ mix: ${count(p.ready)} of ${songs(p.songs)}${withoutModel}`, waiting, failed].filter(Boolean).join(' · ')}.`;
}

const SECONDARY_BUTTON =
  'inline-flex h-10 items-center justify-center rounded-full border border-line px-5 text-[14px] text-paper transition hover:bg-paper/5 disabled:opacity-50';

/** Under the DJ mix choice: how much of the library can be mixed yet. Asked for only while it's shown. */
function MixProgress() {
  const { data } = useMixMapProgress();
  const analyze = useAnalyzeForMixing();
  if (!data || (data.enabled && data.songs === 0)) return null;
  // Only when there's something to start: songs left that aren't failed lately (those wait a day
  // before another try), and nothing under way already (the counts and the bar show that).
  const idle = data.enabled && data.waiting === 0 && data.working === 0;
  const startable = idle && data.ready + data.failed < data.songs;
  // Every song again (after the analysis improved): whenever nothing is under way and some are ready.
  const redoable = idle && data.ready > 0;
  // A bar only for a scan that will finish: songs analysed as they come up never all get there.
  const bar = data.enabled && data.libraryScan && data.ready < data.songs;
  return (
    <div className="mt-3">
      <p className="text-[13px] text-paper-dim">{mixProgressText(data)}</p>
      {bar && (
        <div
          className="mt-2 h-1 overflow-hidden rounded-full bg-paper/10"
          role="meter"
          aria-label="Songs ready for DJ mix"
          aria-valuenow={data.ready}
          aria-valuemax={data.songs}
        >
          <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${(data.ready / data.songs) * 100}%` }} />
        </div>
      )}
      {(startable || redoable) && (
        <div className="mt-3 flex flex-wrap gap-2">
          {startable && (
            <button type="button" className={SECONDARY_BUTTON} disabled={analyze.isPending} onClick={() => analyze.mutate(false)}>
              Analyse all songs now
            </button>
          )}
          {redoable && (
            <button
              type="button"
              className={SECONDARY_BUTTON}
              disabled={analyze.isPending}
              onClick={() => analyze.mutate(true)}
              title="Every song is analysed again with the current analysis, in the background; each mixes as before until its turn."
            >
              Analyse all again
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Settings → Playback: for this device. */
export function PlaybackPanel() {
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
            : 'Songs always follow each other without a gap. This device sets the volume with its own buttons, so it can’t crossfade or even out songs. DJ mix still works here, joining songs on the beat.'
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
            <div className="mb-3 text-[15px] text-paper">Transitions</div>
            <PillGroup label="Transitions" options={transitionOptions} value={shown} onChange={setTransitions} />
            {shown === 'crossfade' && (
              <>
                <p className="mt-3 mb-3 text-[13px] text-muted">Fades each song into the next. Never between songs of an album played in order.</p>
                <PillGroup label="Crossfade length" options={CROSSFADE_LENGTHS} value={crossfade} onChange={setCrossfade} />
              </>
            )}
            {shown === 'dj' && (
              <>
                <p className="mt-3 text-[13px] text-muted">
                  Songs are mixed like a DJ would, when their beats allow: long blends, quick mixes or straight on.
                </p>
                <MixProgress />
              </>
            )}
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
