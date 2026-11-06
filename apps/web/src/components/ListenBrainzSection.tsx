import { useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { plural } from '../lib/format';
import { useListenBrainz, useListenBrainzAction } from '../lib/queries';
import { Button } from './Button';
import { SettingsSection, Switch } from './SettingsControls';
import { TextField } from './TextField';

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
          <TextField
            label={
              <>
                Your user token, from{' '}
                <a href="https://listenbrainz.org/settings/" target="_blank" rel="noreferrer" className="text-accent hover:underline">
                  listenbrainz.org/settings
                </a>
              </>
            }
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <Button type="submit" variant="primary" disabled={!token.trim()} pending={connect.isPending} pendingLabel="Checking…">
            Connect
          </Button>
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
              <Button disabled={earlier.isPending} onClick={() => earlier.mutate(undefined)}>
                Also send {plural(data.earlier, 'earlier play')}
              </Button>
            )}
            <Button disabled={disconnect.isPending} onClick={() => disconnect.mutate(undefined)}>
              Disconnect
            </Button>
          </div>
        </>
      )}
    </SettingsSection>
  );
}
