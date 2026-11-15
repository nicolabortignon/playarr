import type { DeviceCodeInfo } from '@playarr/shared';
import { Check, Tv } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link as RouterLink, useSearchParams } from 'react-router';
import { Button } from '../components/Button';
import { PageHeader } from '../components/PageHeader';
import { InlineError } from '../components/States';
import { TextField } from '../components/TextField';
import { switchTo, useAccounts } from '../lib/accounts';
import { normalizeDeviceCode } from '../lib/deviceCode';
import { api } from '../lib/api';
import { useMe } from '../lib/queries';

/**
 * Signing in a TV (plan 9 §3): the TV shows a code and a QR code for this page with it. Signed in here, you see which
 * device it is and sign it in as the account listening here, or switch to another account on this browser first.
 * Signed out, the shell's sign-in comes first and brings you back.
 */
export function LinkPage() {
  const [params, setParams] = useSearchParams();
  const code = normalizeDeviceCode(params.get('code') ?? '');
  const { data: me } = useMe();
  const stored = useAccounts((s) => s.accounts);
  const [typed, setTyped] = useState('');
  const [device, setDevice] = useState<DeviceCodeInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDevice(null);
    setError(null);
    setApproved(false);
    if (code.length !== 8) return;
    let current = true;
    api.deviceLookup(code).then(
      (info) => current && setDevice(info),
      (err: Error) => current && setError(err.message),
    );
    return () => {
      current = false;
    };
  }, [code]);

  const enter = (event: FormEvent) => {
    event.preventDefault();
    setParams({ code: normalizeDeviceCode(typed) }, { replace: true });
  };

  const approve = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.deviceApprove(code);
      setApproved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const others = stored.filter((a) => a.accountId !== me?.id);
  const name = device?.device ?? 'the TV';

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader kicker="Sign in a TV" title={approved ? `${name} is signed in` : 'Sign in a TV'} />
      {approved ? (
        <p className="flex items-start gap-3 type-body text-paper-dim">
          <Check aria-hidden className="mt-1 shrink-0 text-accent" />
          <span>
            It listens as {me?.name} from now on. You can sign it out in Settings → Accounts, under your devices.
          </span>
        </p>
      ) : code.length !== 8 ? (
        <form onSubmit={enter} className="space-y-4">
          <p className="type-body text-paper-dim">Type the code the TV shows.</p>
          <TextField label="Code" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} />
          <Button type="submit" disabled={normalizeDeviceCode(typed).length !== 8}>
            Continue
          </Button>
        </form>
      ) : (
        <div className="space-y-6">
          <p className="flex items-center gap-3 type-body text-paper">
            <Tv aria-hidden className="shrink-0 text-paper-dim" />
            <span>
              {device ? device.device : 'Looking up the code…'} <span className="type-meta text-muted">{formatDeviceCode(code)}</span>
            </span>
          </p>
          {error && <InlineError>{error}</InlineError>}
          {device && me && (
            <>
              <Button variant="primary" onClick={() => void approve()} disabled={busy}>
                {busy ? 'Signing in…' : `Sign in ${name} as ${me.name}`}
              </Button>
              <div className="flex flex-wrap gap-x-3 gap-y-1 type-small text-muted">
                <span>As someone else?</span>
                {others.map((a) => (
                  <button key={a.accountId} type="button" className="text-paper-dim underline-offset-2 hover:text-paper hover:underline" onClick={() => void switchTo(a.accountId)}>
                    {a.name}
                  </button>
                ))}
                <RouterLink to={`/sign-in?add=1&next=${encodeURIComponent(`/link?code=${code}`)}`} className="text-paper-dim underline-offset-2 hover:text-paper hover:underline">
                  Another account
                </RouterLink>
              </div>
            </>
          )}
          {error && (
            <Button variant="ghost" onClick={() => setParams({}, { replace: true })}>
              Type another code
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** Two groups of four, as the TV shows it. */
const formatDeviceCode = (code: string) => `${code.slice(0, 4)} ${code.slice(4)}`;
