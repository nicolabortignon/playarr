import { useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { plural } from '../lib/format';
import { useListenBrainz, useListenBrainzAction } from '../lib/queries';
import { SettingsSection, Switch } from './SettingsControls';

const INPUT =
  'h-11 w-full rounded-lg border border-line bg-ink-900 px-3 text-[15px] text-paper outline-none transition focus:border-accent';
const BUTTON =
  'inline-flex h-9 items-center gap-2 rounded-full border border-line px-4 text-[13px] text-paper transition hover:bg-paper/5 disabled:opacity-40';

/** Settings → Mixes → ListenBrainz: send what's played to a ListenBrainz account. */
export function ListenBrainzSection() {
  const { data } = useListenBrainz();
  const [token, setToken] = useState('');
  const connect = useListenBrainzAction((t: string) => api.saveListenBrainz({ token: t }));
  const toggle = useListenBrainzAction((enabled: boolean) => api.saveListenBrainz({ enabled }));
  const disconnect = useListenBrainzAction(() => api.disconnectListenBrainz(), 'ListenBrainz disconnected');
  const earlier = useListenBrainzAction(() => api.sendEarlierListens(), 'Sending your earlier plays to ListenBrainz');
  if (!data) return null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (token.trim()) connect.mutate(token.trim(), { onSuccess: () => setToken('') });
  };

  return (
    <SettingsSection
      title="ListenBrainz"
      description={
        <>
          Send each song heard (for half its length, or four minutes) to your{' '}
          <a href="https://listenbrainz.org" target="_blank" rel="noreferrer" className="text-accent hover:underline">
            ListenBrainz
          </a>{' '}
          profile. Its recommendations, which radio and suggestions use, then learn from what you play.
        </>
      }
    >
      {!data.connected ? (
        <form onSubmit={submit} className="space-y-3">
          <label className="block">
            <span className="mb-1.5 block text-[13px] text-paper-dim">
              Your user token, from{' '}
              <a href="https://listenbrainz.org/settings/" target="_blank" rel="noreferrer" className="text-accent hover:underline">
                listenbrainz.org/settings
              </a>
            </span>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className={INPUT}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <button type="submit" disabled={!token.trim() || connect.isPending} className={BUTTON}>
            {connect.isPending ? 'Checking…' : 'Connect'}
          </button>
        </form>
      ) : (
        <>
          <div className="divide-y divide-line">
            <Switch
              label={`Send plays to ${data.user ?? 'ListenBrainz'}`}
              description={
                data.error ??
                [
                  plural(data.sent, 'listen') + ' sent',
                  data.pending ? `${data.pending} waiting` : undefined,
                  data.lastSentAt ? `last ${new Date(data.lastSentAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : undefined,
                ]
                  .filter(Boolean)
                  .join(' · ')
              }
              checked={data.enabled}
              onChange={(on) => toggle.mutate(on)}
            />
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {data.earlier > 0 && (
              <button type="button" disabled={earlier.isPending} onClick={() => earlier.mutate(undefined)} className={BUTTON}>
                Also send {plural(data.earlier, 'earlier play')}
              </button>
            )}
            <button type="button" disabled={disconnect.isPending} onClick={() => disconnect.mutate(undefined)} className={BUTTON}>
              Disconnect
            </button>
          </div>
        </>
      )}
    </SettingsSection>
  );
}
