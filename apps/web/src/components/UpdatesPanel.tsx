import type { UpdateInfo, UpdateInterval } from '@playarr/shared';
import { Loader2, RotateCw } from 'lucide-react';
import { useEffect } from 'react';
import { ApiError } from '../lib/api';
import { cn } from '../lib/cn';
import { useCheckForUpdates, useSaveUpdates, useUpdates } from '../lib/queries';
import { toast } from '../lib/toast';
import { AwayNotice, PillGroup, SettingsSection, Switch } from './SettingsControls';

const INTERVALS: readonly { value: UpdateInterval; label: string }[] = [
  { value: 15, label: '15 minutes' },
  { value: 60, label: 'Hour' },
  { value: 360, label: '6 hours' },
  { value: 1440, label: 'Day' },
];

const CHECK_BUTTON =
  'mt-4 inline-flex h-9 items-center gap-2 rounded-full border border-line px-4 text-[13px] text-paper transition hover:bg-paper/5 disabled:opacity-50';
const LOG =
  'mt-3 max-h-80 overflow-auto rounded-lg border border-line bg-ink-900 p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-paper-dim';

const short = (sha: string) => sha.slice(0, 7);

/** The commit the server ran when this page loaded, to notice it being replaced (once per page load). */
let loadedDeployed: string | undefined;
let toldAboutUpdate = false;

/** Settings → Updates: rebuild Playarr from GitHub main, on a schedule or now. For everyone (Docker setup only). */
export function UpdatesPanel() {
  const { data, error } = useUpdates();
  const save = useSaveUpdates();
  const check = useCheckForUpdates();
  useReloadAfterUpdate(data?.status?.deployed);

  if (error instanceof ApiError && error.status === 403) {
    return <AwayNotice>Settings can be changed from your home network.</AwayNotice>;
  }
  if (error && !data) return <p className="text-sm text-red-300/80">{error.message}</p>;
  if (!data) return <div aria-busy="true" aria-label="Loading" className="h-40 max-w-prose animate-pulse rounded-lg bg-paper/5" />;

  const busy = data.requested || data.status?.state === 'checking';
  return (
    <div>
      <p className="mb-10 max-w-prose text-[15px] text-paper-dim">
        Playarr downloads the latest version from GitHub, rebuilds itself and restarts. The music keeps playing from your
        device’s cache, and a failed update leaves the running version alone.
      </p>

      <SettingsSection title="Version">
        <Version info={data} />
      </SettingsSection>

      {!data.available ? (
        <SettingsSection title="Automatic updates">
          <Unavailable reason={data.reason} />
        </SettingsSection>
      ) : (
        <>
          <SettingsSection title="Automatic updates">
            <Switch
              label="Update Playarr from GitHub automatically"
              description="Only the main branch of Playarr’s repository is ever installed."
              checked={data.enabled}
              onChange={(enabled) => save.mutate({ enabled })}
            />
            <div className="mt-2">
              <p className={cn('mb-2 text-[13px] text-muted', !data.enabled && 'opacity-50')}>Check every</p>
              <PillGroup
                label="Check every"
                options={INTERVALS}
                value={data.intervalMinutes}
                onChange={(intervalMinutes) => save.mutate({ intervalMinutes })}
                disabled={!data.enabled}
              />
            </div>
          </SettingsSection>

          <SettingsSection title="Last check">
            <LastCheck info={data} />
            <button
              type="button"
              onClick={() => check.mutate()}
              disabled={busy || check.isPending}
              className={CHECK_BUTTON}
            >
              {busy || check.isPending ? <Loader2 className="size-4 animate-spin" /> : <RotateCw className="size-4" />}
              {busy ? 'Checking…' : 'Check now'}
            </button>
            {data.log && (
              <details className="mt-6">
                <summary className="cursor-pointer text-[13px] text-muted hover:text-paper">Show log</summary>
                <pre className={LOG}>
                  {data.log}
                </pre>
              </details>
            )}
          </SettingsSection>
        </>
      )}
    </div>
  );
}

function Version({ info }: { info: UpdateInfo }) {
  const deployed = info.status?.deployed;
  const latest = info.status?.latest;
  const running = deployed ?? __APP_REVISION__;
  const upToDate = latest && running ? latest.startsWith(running) || running.startsWith(latest) : undefined;
  return (
    <div className="space-y-1 text-[15px]">
      <p className="text-paper">
        Playarr v{__APP_VERSION__}
        {__APP_REVISION__ && <span className="font-mono text-[13px] text-muted"> · {__APP_REVISION__}</span>}
      </p>
      {latest && (
        <p className="text-paper-dim">
          Latest on GitHub: <span className="font-mono text-[13px]">{short(latest)}</span>
          {upToDate !== undefined && (
            <span className={upToDate ? 'text-muted' : 'text-accent'}>
              {' · '}
              {upToDate ? 'Up to date' : 'A newer version is available'}
            </span>
          )}
        </p>
      )}
    </div>
  );
}

function Unavailable({ reason }: { reason?: string }) {
  const notRunning = reason?.includes('update.sh');
  return (
    <div className="max-w-prose text-[15px] text-paper-dim">
      <p>
        {notRunning
          ? 'The updater isn’t running yet. To start it, run this once in Playarr’s folder on the server:'
          : `${reason ?? 'Automatic updates aren’t available here'}.`}
      </p>
      {notRunning && (
        <pre className="mt-3 overflow-x-auto rounded-lg border border-line bg-ink-900 px-3 py-2 font-mono text-[13px] text-paper">
          sudo sh update.sh
        </pre>
      )}
    </div>
  );
}

function LastCheck({ info }: { info: UpdateInfo }) {
  const status = info.status;
  if (status?.state === 'checking' || (info.requested && !status?.lastCheck)) {
    return <p className="text-[15px] text-paper-dim">Checking for a new version…</p>;
  }
  if (!status?.lastCheck) return <p className="text-[15px] text-muted">Not checked yet.</p>;
  const outcome =
    status.state === 'failed' ? (
      <span className="text-red-300/80">{status.error ?? 'The update failed'}</span>
    ) : status.lastUpdate === status.lastCheck && status.deployed ? (
      <span className="text-paper">Updated to <span className="font-mono text-[13px]">{short(status.deployed)}</span></span>
    ) : (
      <span className="text-paper">Already up to date</span>
    );
  return (
    <p className="text-[15px] text-paper-dim">
      <time dateTime={new Date(status.lastCheck * 1000).toISOString()} title={new Date(status.lastCheck * 1000).toLocaleString()}>
        {ago(status.lastCheck)}
      </time>
      {' · '}
      {outcome}
    </p>
  );
}

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "2 minutes ago", "yesterday"… for a Unix time in seconds. */
function ago(seconds: number, now = Date.now()): string {
  const diff = Math.round(seconds - now / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(diff) >= size) return relative.format(Math.round(diff / size), unit);
  }
  return 'just now';
}

/** When the server is replaced by a new version, this page is still the old one: offer a reload, once. */
function useReloadAfterUpdate(deployed: string | undefined) {
  useEffect(() => {
    if (!deployed) return;
    if (loadedDeployed === undefined) {
      loadedDeployed = deployed;
      return;
    }
    if (deployed !== loadedDeployed && !toldAboutUpdate) {
      toldAboutUpdate = true;
      toast('Playarr was updated. Reload to use the new version.', 'info', { label: 'Reload', run: () => window.location.reload() });
    }
  }, [deployed]);
}
