import { useState, type ReactNode } from 'react';
import { ApiError, type AnalysisKind, type AnalysisProgress } from '../lib/api';
import { useAnalysisProgress, useMixSettings, useRunAnalysis, useSaveMixSettings } from '../lib/queries';
import { Dialog } from './Dialog';
import { AwayNotice, SettingsSection, Switch } from './SettingsControls';

/** 5678 → "5,678": the rest of the panel is in English, so its numbers are too. */
const count = (n: number) => n.toLocaleString('en');
const songs = (n: number) => `${count(n)} ${n === 1 ? 'song' : 'songs'}`;

const AUDIO_OFF = 'Audio analysis is off on this server (set ANALYSIS=on in its .env).';

const SECONDARY_BUTTON =
  'inline-flex h-10 items-center justify-center rounded-full border border-line px-5 text-[14px] text-paper transition hover:bg-paper/5 disabled:opacity-50';

/** What's under way: the songs being analysed and waiting, for each queue. */
function queueText(p: AnalysisProgress): string | null {
  const working = p.working + p.loudnessWorking;
  const parts = [
    working > 0 ? `analysing ${songs(working)}` : '',
    p.waiting > 0 ? `${count(p.waiting)} waiting for beat or sound analysis` : '',
    p.loudnessWaiting > 0 ? `${count(p.loudnessWaiting)} waiting for loudness analysis` : '',
    p.tagsWaiting > 0 ? `${count(p.tagsWaiting)} waiting for a tag lookup` : '',
  ].filter(Boolean);
  return parts.length ? `Now: ${parts.join(' · ')}.` : null;
}

function beatsText(p: AnalysisProgress): string {
  const { ready, beatModel, failed } = p.beats;
  const withoutModel = ready > beatModel ? ` (${count(ready - beatModel)} without the beat model)` : '';
  if (ready >= p.songs) {
    return p.songs === 1 ? `The library’s one song is ready for DJ mix${withoutModel}.` : `All ${songs(p.songs)} are ready for DJ mix${withoutModel}.`;
  }
  const failures = failed > 0 ? ` · ${count(failed)} couldn’t be analysed` : '';
  const rest = p.libraryScan ? '' : ' Others are analysed as they come up to play.';
  return `Ready for DJ mix: ${count(ready)} of ${songs(p.songs)}${withoutModel}${failures}.${rest}`;
}

function soundText(p: AnalysisProgress): string {
  const { ready, failed } = p.sound;
  if (ready >= p.songs) return p.songs === 1 ? 'The library’s one song is measured.' : `All ${songs(p.songs)} are measured.`;
  const failures = failed > 0 ? ` · ${count(failed)} couldn’t be measured` : '';
  return `Measured: ${count(ready)} of ${songs(p.songs)}${failures}.`;
}

function loudnessText(p: AnalysisProgress): string {
  const { ready, failed } = p.loudness;
  if (ready >= p.songs) return p.songs === 1 ? 'The library’s one song is measured.' : `All ${songs(p.songs)} are measured.`;
  const failures = failed > 0 ? ` · ${count(failed)} couldn’t be measured` : '';
  return `Measured: ${count(ready)} of ${songs(p.songs)}${failures}. The others play at their own volume until they are.`;
}

function tagsText(p: AnalysisProgress): string {
  const { ready, songs: taggable } = p.tags;
  if (!taggable) return 'No song is matched on MusicBrainz yet, so there are no tags to look up.';
  const unmatched = p.songs - taggable;
  const others = unmatched > 0 ? ` (${count(unmatched)} more aren’t matched on MusicBrainz)` : '';
  if (ready >= taggable) return `All ${songs(taggable)} matched on MusicBrainz are looked up${others}.`;
  return `Looked up: ${count(ready)} of ${songs(taggable)} matched on MusicBrainz${others}.`;
}

/**
 * How much of the library one analysis has done: a line, a bar, a button for the songs it has left
 * (while it's not busy with songs already), and one to do the entire collection again, after asking.
 */
function Analysis({
  kind,
  text,
  done,
  failed,
  of,
  canRun,
  verb,
  meter,
  again,
  away,
}: {
  kind: AnalysisKind;
  text: string;
  done: number;
  /** Failed lately: those wait a day before another try, so they aren't left to start. */
  failed: number;
  of: number;
  canRun: boolean;
  /** "Analyse", "Look up". */
  verb: string;
  meter: string;
  /** Doing the entire collection again: its button, and what the question before it says. */
  again: { label: string; explain: string };
  away: boolean;
}) {
  const run = useRunAnalysis();
  const left = Math.max(0, of - done - failed);
  const allowed = canRun && !away && of > 0;
  return (
    <div>
      <p className="text-[13px] text-paper-dim">{text}</p>
      {canRun && of > 0 && done < of && (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-paper/10" role="meter" aria-label={meter} aria-valuenow={done} aria-valuemax={of}>
          <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${(done / of) * 100}%` }} />
        </div>
      )}
      {allowed && (
        <div className="mt-3 flex flex-wrap gap-2">
          {/* Also while songs are under way: the server queues only those not waiting already. */}
          {left > 0 && (
            <button type="button" className={SECONDARY_BUTTON} disabled={run.isPending} onClick={() => run.mutate({ kind })}>
              {`${verb} the ${count(left)} of ${songs(of)} left`}
            </button>
          )}
          <AskFirst
            label={again.label}
            question={`${again.label}?`}
            explain={again.explain}
            onConfirm={(done) => run.mutate({ kind, again: true }, { onSettled: done })}
            busy={run.isPending}
          />
        </div>
      )}
    </div>
  );
}

/** A button that asks before it goes ahead: for work that takes hours, or undoes what's done. */
function AskFirst({
  label,
  question,
  explain,
  onConfirm,
  busy,
}: {
  label: string;
  question: string;
  explain: string;
  /** Goes ahead; calls `done` once it has, to close the question. */
  onConfirm: (done: () => void) => void;
  busy: boolean;
}) {
  const [asking, setAsking] = useState(false);
  return (
    <>
      <button type="button" className={SECONDARY_BUTTON} disabled={busy} onClick={() => setAsking(true)}>
        {label}
      </button>
      <Dialog open={asking} onClose={() => setAsking(false)} title={question}>
        <div className="space-y-5 p-5">
          <p className="text-[15px] text-paper-dim">{explain}</p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setAsking(false)} className={SECONDARY_BUTTON}>
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onConfirm(() => setAsking(false))}
              className="inline-flex h-10 items-center rounded-full bg-accent px-5 text-[14px] font-medium text-accent-ink transition hover:brightness-110 disabled:opacity-50"
            >
              {label}
            </button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

/** Every analysis on every song again, after asking: beat analysis alone takes hours over a big library. */
function EverythingAgain({ audio }: { audio: boolean }) {
  const run = useRunAnalysis();
  return (
    <div className="mt-3">
      <AskFirst
        label="Reanalyse everything"
        question="Reanalyse every song with every analysis?"
        explain={
          audio
            ? 'Beat, sound and loudness analysis and a tag lookup for every song, from scratch, at low priority. Each song keeps what it has until its turn. On a small server this takes many hours: beat analysis alone can take a minute a song.'
            : 'A tag lookup for every song matched on MusicBrainz, from scratch. Each song keeps its tags until its turn.'
        }
        onConfirm={(done) => run.mutate({ kind: 'all', again: true }, { onSettled: done })}
        busy={run.isPending}
      />
    </div>
  );
}

function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading" className="max-w-prose space-y-3">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-14 animate-pulse rounded-lg bg-paper/5" />
      ))}
    </div>
  );
}

/**
 * Settings → Analysis: what Playarr works out about the songs, how far each analysis has got over the
 * library, and a button to run each on the songs it has left. Each does one job: beat analysis for DJ
 * mix, sound analysis for mood mixes and covers, loudness analysis for even volume, tag lookup for
 * genre and decade mixes.
 */
export function AnalysisPanel() {
  const { data: p, error } = useAnalysisProgress();
  const settings = useMixSettings();
  const save = useSaveMixSettings();
  if (error && !p) return <p className="text-sm text-red-300/80">{error.message}</p>;
  if (!p) return <Loading />;

  const away = settings.error instanceof ApiError && settings.error.status === 403;
  const queue = queueText(p);
  let switchRow: ReactNode = null;
  if (settings.data) {
    switchRow = (
      <Switch
        label="Analyse every song in the library"
        description={
          p.enabled
            ? 'At low priority: beat, sound and loudness analysis and a tag lookup, once for each song. Off, songs are analysed as they come up to play. Takes a while on a big library: beat analysis can take a minute a song on a small server.'
            : `Tags are still looked up as songs come up. ${AUDIO_OFF}`
        }
        checked={settings.data.analyzeLibrary && p.enabled}
        disabled={!p.enabled}
        onChange={(analyzeLibrary) => save.mutate({ analyzeLibrary })}
      />
    );
  }

  return (
    <div>
      {away && <AwayNotice>Analyses can be started by an admin.</AwayNotice>}
      <SettingsSection title="In the background">
        {switchRow && <div className="divide-y divide-line">{switchRow}</div>}
        <p className="mt-2 text-[13px] text-paper-dim">{queue ?? 'Nothing is being analysed right now.'}</p>
        {!away && p.songs > 0 && <EverythingAgain audio={p.enabled} />}
      </SettingsSection>

      <SettingsSection
        title="Beat analysis"
        description="Each song’s tempo, beat grid and bars, key, intro and outro, and where its sound starts and ends: what DJ mix needs to join songs on the beat, and the tempo mixes and covers go by. The heaviest analysis: up to a minute a song on a small server."
      >
        <Analysis
          kind="beats"
          text={p.enabled ? beatsText(p) : `DJ mix needs it. ${AUDIO_OFF}`}
          done={p.beats.ready}
          failed={p.beats.failed}
          of={p.songs}
          canRun={p.enabled}
          verb="Analyse"
          meter="Songs ready for DJ mix"
          again={{
            label: 'Reanalyse the entire collection',
            explain:
              'Beat analysis for every song, from scratch, at low priority. Each song mixes as it does now until its turn. On a small server this takes many hours: up to a minute a song.',
          }}
          away={away}
        />
      </SettingsSection>

      <SettingsSection
        title="Sound analysis"
        description="What each song feels like: its energy, brightness, bass and how busy it is. For Energy boost, Wind down, Deep focus, Vibes of the hour, radio and playlist covers."
      >
        <Analysis
          kind="sound"
          text={p.enabled ? soundText(p) : AUDIO_OFF}
          done={p.sound.ready}
          failed={p.sound.failed}
          of={p.songs}
          canRun={p.enabled}
          verb="Analyse"
          meter="Songs measured for their sound"
          again={{
            label: 'Reanalyse the entire collection',
            explain: 'Sound analysis for every song, from scratch, at low priority. Each song keeps what it has until its turn.',
          }}
          away={away}
        />
      </SettingsSection>

      <SettingsSection
        title="Loudness analysis"
        description="How loud each song sounds (EBU R128) and its peak, for Even out the volume in Settings → Playback. A second or two a song."
      >
        <Analysis
          kind="loudness"
          text={p.enabled ? loudnessText(p) : `Even volume needs it. ${AUDIO_OFF}`}
          done={p.loudness.ready}
          failed={p.loudness.failed}
          of={p.songs}
          canRun={p.enabled}
          verb="Analyse"
          meter="Songs measured for their loudness"
          again={{
            label: 'Reanalyse the entire collection',
            explain: 'Loudness analysis for every song, from scratch, a second or two a song. Each song keeps its level until its turn.',
          }}
          away={away}
        />
      </SettingsSection>

      <SettingsSection
        title="Tag lookup"
        description="Each song’s genres and year from ListenBrainz, for genre and decade mixes. Only songs matched on MusicBrainz can be looked up; tags are looked up again after a month."
      >
        <Analysis
          kind="tags"
          text={tagsText(p)}
          done={p.tags.ready}
          failed={0}
          of={p.tags.songs}
          canRun
          verb="Look up"
          meter="Songs looked up"
          again={{
            label: 'Look up the entire collection again',
            explain: 'A tag lookup for every song matched on MusicBrainz, from scratch. Each song keeps its tags until its turn.',
          }}
          away={away}
        />
      </SettingsSection>
    </div>
  );
}
