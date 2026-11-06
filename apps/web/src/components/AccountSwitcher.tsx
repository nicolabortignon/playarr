import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { switchTo, useAccounts } from '../lib/accounts';
import { ApiError } from '../lib/api';
import { cn } from '../lib/cn';
import { useMe } from '../lib/queries';
import { toast } from '../lib/toast';

const LINK = 'text-paper-dim underline-offset-2 hover:text-paper hover:underline disabled:opacity-50';

/** Who listens on this device, and the other accounts signed in on it, a tap away. Off Home's top for now; its new place is to be decided. */
export function AccountSwitcher({ className }: { className?: string }) {
  const { data: me } = useMe();
  const stored = useAccounts((s) => s.accounts);
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  if (!me) return null;

  const listenAs = async (accountId: number) => {
    setBusy(true);
    try {
      await switchTo(accountId);
    } catch (err) {
      toast((err as Error).message, 'error');
      if (err instanceof ApiError && err.status === 401) navigate('/sign-in?add=1');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cn('flex flex-wrap gap-x-3 gap-y-1 type-small text-muted', className)}>
      <span>Not {me.name}?</span>
      {stored
        .filter((a) => a.accountId !== me.id)
        .map((a) => (
          <button key={a.accountId} type="button" disabled={busy} onClick={() => void listenAs(a.accountId)} className={LINK}>
            Listen as {a.name}
          </button>
        ))}
      <Link to="/sign-in?add=1" className={LINK}>
        Add account
      </Link>
    </div>
  );
}
