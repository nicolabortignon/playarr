import type { LastFmConnect } from '@playarr/shared';
import { useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { plural } from '../lib/format';
import { useIsMember, useLastFm, useLastFmAction } from '../lib/queries';
import { toast } from '../lib/toast';
import { Button } from './Button';
import { SettingsSection, Switch } from './SettingsControls';
import { TextField } from './TextField';

const link = 'text-accent hover:underline';

/**
 * Settings → Mixes → Last.fm: send what's played to a Last.fm account, as ListenBrainz does. The server needs its own
 * Last.fm API account first, which an admin adds here once; then each account connects by allowing Playarr on Last.fm.
 */
export function LastFmSection() {
  const { data } = useLastFm();
  const member = useIsMember();
  const [waiting, setWaiting] = useState<LastFmConnect | null>(null);
  const [connecting, setConnecting] = useState(false);
  const finish = useLastFmAction((token: string) => api.finishLastFm(token));
  const toggle = useLastFmAction((enabled: boolean) => api.saveLastFm(enabled));
  const disconnect = useLastFmAction(() => api.disconnectLastFm(), 'Last.fm disconnected');
  const earlier = useLastFmAction(() => api.sendEarlierToLastFm(), 'Sending your earlier plays to Last.fm');
  const removeApp = useLastFmAction(() => api.removeLastFmApp(), 'Last.fm removed from this server');
  if (!data) return null;

  const connect = async () => {
    setConnecting(true);
    try {
      setWaiting(await api.connectLastFm());
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setConnecting(false);
    }
  };

  return (
    <SettingsSection
      title="Last.fm"
      description={
        <>
          Send each song heard (for half its length, or four minutes) to your{' '}
          <a href="https://www.last.fm" target="_blank" rel="noreferrer" className={link}>
            Last.fm
          </a>{' '}
          profile, as ListenBrainz does.
        </>
      }
    >
      {!data.available ? (
        member ? (
          <p className="type-small text-muted">An admin can add Last.fm to this server.</p>
        ) : (
          <LastFmAppForm />
        )
      ) : !data.connected ? (
        waiting ? (
          <div className="space-y-3">
            <p className="type-body text-paper-dim">Allow Playarr on Last.fm, then come back here and finish.</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" to={waiting.url} target="_blank" rel="noreferrer">
                Allow Playarr on Last.fm
              </Button>
              <Button
                pending={finish.isPending}
                pendingLabel="Finishing…"
                onClick={() => finish.mutate(waiting.token, { onSuccess: () => setWaiting(null) })}
              >
                Finish connecting
              </Button>
              <Button variant="ghost" onClick={() => setWaiting(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="primary" pending={connecting} pendingLabel="Asking Last.fm…" onClick={() => void connect()}>
            Connect Last.fm
          </Button>
        )
      ) : (
        <>
          <div className="divide-y divide-line">
            <Switch
              label={`Send plays to ${data.user ?? 'Last.fm'}`}
              description={
                data.error ??
                [
                  plural(data.sent, 'scrobble') + ' sent',
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
      {data.available && data.apiKey && (
        <p className="mt-4 type-small text-muted">
          This server’s Last.fm API account: <span className="font-mono">…{data.apiKey.slice(-6)}</span>.{' '}
          <button type="button" className={link} disabled={removeApp.isPending} onClick={() => removeApp.mutate(undefined)}>
            Remove it
          </button>{' '}
          (every account here disconnects).
        </p>
      )}
    </SettingsSection>
  );
}

/** An admin, once: the server's Last.fm API account, its key and shared secret. */
function LastFmAppForm() {
  const [apiKey, setApiKey] = useState('');
  const [secret, setSecret] = useState('');
  const save = useLastFmAction((app: { apiKey: string; secret: string }) => api.saveLastFmApp(app), 'Last.fm added to this server');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (apiKey.trim() && secret.trim()) save.mutate({ apiKey: apiKey.trim(), secret: secret.trim() });
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="type-body text-paper-dim">
        This server needs a Last.fm API account first, once:{' '}
        <a href="https://www.last.fm/api/account/create" target="_blank" rel="noreferrer" className={link}>
          create one
        </a>{' '}
        (any name; the callback URL can stay empty), then give its API key and shared secret here. Everyone here then
        connects their own Last.fm.
      </p>
      <TextField label="API key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" spellCheck={false} />
      <TextField label="Shared secret" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" spellCheck={false} />
      <Button type="submit" variant="primary" disabled={!apiKey.trim() || !secret.trim()} pending={save.isPending} pendingLabel="Checking…">
        Add Last.fm
      </Button>
    </form>
  );
}
