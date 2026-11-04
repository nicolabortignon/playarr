import type { Account, AccountRole, ListedAccount, SetupCode } from '@playarr/shared';
import { Copy, KeyRound, LogOut, Pencil, Smartphone, Trash2, UserPlus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { signOut } from '../lib/accounts';
import { api, type AccountInput } from '../lib/api';
import { cn } from '../lib/cn';
import { plural } from '../lib/format';
import { useAccountAction, useAccountList, useAccountSessions, useMe, useServerInfo, useSources } from '../lib/queries';
import { toast } from '../lib/toast';
import { Dialog } from './Dialog';
import { SettingsSection } from './SettingsControls';

const INPUT =
  'h-10 w-full rounded-lg border border-line bg-ink-900 px-3 text-[15px] text-paper outline-none transition focus:border-accent';
const BUTTON =
  'inline-flex h-10 items-center gap-2 rounded-full border border-line px-4 text-[14px] text-paper transition hover:bg-paper/5 disabled:opacity-40';
const ICON = 'grid size-9 shrink-0 place-items-center rounded-full text-muted transition hover:bg-paper/8 hover:text-paper';
const LOADING = <div aria-busy="true" className="h-40 max-w-prose animate-pulse rounded-lg bg-paper/5" />;

/** Settings → Accounts: who signs in to this server and what each may hear and change; your name and devices. */
export function AccountsPanel() {
  const { data: server } = useServerInfo();
  const { data: me, error, isPending } = useMe();
  if (!server) return LOADING;
  if (server.setup) return <ClaimServer />;
  if (isPending) return LOADING;
  if (!me) return <p className="text-sm text-red-300/80">{error?.message ?? 'Sign in to see your account.'}</p>;
  return (
    <div>
      <You me={me} />
      {me.role === 'admin' && <Everyone me={me} />}
    </div>
  );
}

function ClaimServer() {
  return (
    <SettingsSection
      title="Set up this server"
      description="Nobody has a password here yet, so anyone on your home network can listen and change settings. Choose the owner’s username and password to turn sign-in on; then add an account for everyone else."
    >
      <Link to="/setup" className={BUTTON}>
        Set up the owner’s account
      </Link>
    </SettingsSection>
  );
}

function You({ me }: { me: Account }) {
  const navigate = useNavigate();
  const [name, setName] = useState(me.name);
  const rename = useAccountAction((n: string) => api.updateAccount(me.id, { name: n }), () => toast('Name saved'));
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() && name.trim() !== me.name) rename.mutate(name.trim());
  };
  return (
    <SettingsSection title="You" description={`Signed in as ${me.username}${me.role === 'admin' ? ', an admin' : ''}.`}>
      <form onSubmit={save} className="flex max-w-md gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Your name" maxLength={40} className={INPUT} />
        <button type="submit" disabled={!name.trim() || name.trim() === me.name || rename.isPending} className={cn(BUTTON, 'shrink-0')}>
          Save
        </button>
      </form>
      <h3 className="mt-6 mb-1 text-[13px] text-muted">Signed in on</h3>
      <Devices accountId={me.id} />
      <button type="button" onClick={() => void signOut().then(() => navigate('/sign-in', { replace: true }))} className={cn(BUTTON, 'mt-5')}>
        <LogOut className="size-4" /> Sign out on this device
      </button>
    </SettingsSection>
  );
}

/** An account's signed-in devices, each but this one signed out with a tap. */
function Devices({ accountId }: { accountId: number }) {
  const { data: sessions } = useAccountSessions(accountId);
  const end = useAccountAction((sessionId: number) => api.endSession(accountId, sessionId));
  if (!sessions) return <div aria-busy="true" className="h-16 animate-pulse rounded-lg bg-paper/5" />;
  if (!sessions.length) return <p className="text-sm text-muted">No devices are signed in.</p>;
  return (
    <ul className="divide-y divide-line">
      {sessions.map((s) => (
        <li key={s.id} className="flex items-center gap-3 py-2">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15px] text-paper">
              {s.device}
              {s.current && <span className="ml-2 text-[13px] text-muted">this device</span>}
            </span>
            <span className="block text-[12px] text-muted">Last used {new Date(s.lastSeenAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
          </span>
          {!s.current && (
            <button type="button" aria-label={`Sign out ${s.device}`} onClick={() => end.mutate(s.id)} className={ICON}>
              <LogOut className="size-4" />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** "sam · member · can request albums · Creative Commons" */
function summary(a: Account, sourceNames: Map<number, string>): string {
  const library = a.sources === null ? 'every source' : a.sources.length ? a.sources.map((id) => sourceNames.get(id) ?? `source ${id}`).join(', ') : 'no sources';
  return [a.username, a.role, a.canRequest ? 'can request albums' : '', library, a.hasPassword ? '' : 'not set up yet'].filter(Boolean).join(' · ');
}

/** "1,234 songs played · 3 playlists" */
function activity(a: ListedAccount): string {
  return `${a.plays.toLocaleString('en')} ${a.plays === 1 ? 'song' : 'songs'} played · ${plural(a.playlists, 'playlist')}`;
}

function Everyone({ me }: { me: Account }) {
  const navigate = useNavigate();
  const { data: accounts, error } = useAccountList();
  const { data: sourceList } = useSources();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [devices, setDevices] = useState<Account | null>(null);
  const [removing, setRemoving] = useState<Account | null>(null);
  const [code, setCode] = useState<{ account: Account; setup: SetupCode } | null>(null);
  const create = useAccountAction((input: AccountInput) => api.createAccount(input), (created) => {
    setAdding(false);
    setCode(created);
  });
  const update = useAccountAction(({ id, input }: { id: number; input: AccountInput }) => api.updateAccount(id, input), () => setEditing(null));
  const reset = useAccountAction((a: Account) => api.resetAccount(a.id).then((setup) => ({ account: a, setup })), setCode);
  const remove = useAccountAction(
    (a: Account) => api.deleteAccount(a.id),
    () => {
      if (removing?.id === me.id) void signOut().then(() => navigate('/sign-in', { replace: true }));
      setRemoving(null);
    },
  );

  if (error) return <p className="mt-12 text-sm text-red-300/80">{error.message}</p>;
  if (!accounts) return LOADING;
  const sourceNames = new Map((sourceList?.sources ?? []).map((s) => [s.id, s.name]));

  return (
    <SettingsSection
      title="Everyone"
      description="Each account has its own history, mixes, favorites and playlists, and hears every source or only the ones you pick. Admins change settings, sources and accounts. You never choose anyone’s password: a new or reset account gets a setup code."
    >
      <ul className="divide-y divide-line">
        {accounts.map((a) => (
          <li key={a.id} className="flex items-center gap-1 py-2">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] text-paper">
                {a.name}
                {a.id === me.id && <span className="ml-2 text-[13px] text-muted">you</span>}
              </span>
              <span className="block truncate text-[12px] text-muted">{summary(a, sourceNames)}</span>
              <span className="block truncate text-[12px] text-muted">{activity(a)}</span>
            </span>
            <button type="button" aria-label={`Edit ${a.name}`} onClick={() => setEditing(a)} className={ICON}>
              <Pencil className="size-4" />
            </button>
            <button type="button" aria-label={`Devices of ${a.name}`} onClick={() => setDevices(a)} className={ICON}>
              <Smartphone className="size-4" />
            </button>
            <button type="button" aria-label={`New setup code for ${a.name}`} onClick={() => reset.mutate(a)} className={ICON}>
              <KeyRound className="size-4" />
            </button>
            <button type="button" aria-label={`Remove ${a.name}`} onClick={() => setRemoving(a)} className={ICON}>
              <Trash2 className="size-4" />
            </button>
          </li>
        ))}
      </ul>
      <button type="button" onClick={() => setAdding(true)} className={cn(BUTTON, 'mt-5')}>
        <UserPlus className="size-4" /> Add account
      </button>

      <Dialog open={adding} onClose={() => setAdding(false)} title="Add account">
        {adding && <AccountForm submitLabel="Add" busy={create.isPending} onSubmit={(input) => create.mutate(input)} />}
      </Dialog>
      <Dialog open={!!editing} onClose={() => setEditing(null)} title={`Edit ${editing?.name ?? ''}`}>
        {editing && <AccountForm account={editing} submitLabel="Save" busy={update.isPending} onSubmit={(input) => update.mutate({ id: editing.id, input })} />}
      </Dialog>
      <Dialog open={!!devices} onClose={() => setDevices(null)} title={`${devices?.name ?? ''}’s devices`}>
        {devices && (
          <div className="p-5">
            <Devices accountId={devices.id} />
          </div>
        )}
      </Dialog>
      <Dialog open={!!code} onClose={() => setCode(null)} title={`Setup code for ${code?.account.name ?? ''}`}>
        {code && <SetupCodeView setup={code.setup} />}
      </Dialog>
      <Dialog open={!!removing} onClose={() => setRemoving(null)} title={`Remove ${removing?.name ?? ''}?`}>
        <div className="space-y-5 p-5">
          <p className="text-[15px] text-paper-dim">Their listening history, mixes, favorites and playlists are deleted, and every device they’re signed in on is signed out.</p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setRemoving(null)} className={BUTTON}>
              Cancel
            </button>
            <button
              type="button"
              disabled={remove.isPending}
              onClick={() => removing && remove.mutate(removing)}
              className="inline-flex h-10 items-center rounded-full bg-red-400/90 px-5 text-[14px] font-medium text-ink-950 transition hover:bg-red-400 disabled:opacity-40"
            >
              Remove
            </button>
          </div>
        </div>
      </Dialog>
    </SettingsSection>
  );
}

/** Name, username, role, requests and library: for a new account, or to change one. */
function AccountForm({ account, submitLabel, busy, onSubmit }: { account?: Account; submitLabel: string; busy: boolean; onSubmit: (input: AccountInput) => void }) {
  const { data: sourceList } = useSources();
  const [name, setName] = useState(account?.name ?? '');
  const [username, setUsername] = useState(account?.username ?? '');
  const [role, setRole] = useState<AccountRole>(account?.role ?? 'member');
  const [canRequest, setCanRequest] = useState(account?.canRequest ?? true);
  const [everySource, setEverySource] = useState(account ? account.sources === null : true);
  const [picked, setPicked] = useState<number[]>(account?.sources ?? []);
  const toggle = (id: number) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit({ username: username.trim(), name: name.trim(), role, canRequest, sources: everySource ? null : picked });
  };
  const check = 'size-4 accent-[var(--accent)]';
  return (
    <form onSubmit={submit} className="space-y-5 p-5">
      <label className="block text-[13px] text-muted">
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required className={cn(INPUT, 'mt-1')} />
      </label>
      <label className="block text-[13px] text-muted">
        Username
        <input value={username} onChange={(e) => setUsername(e.target.value)} maxLength={32} required autoCapitalize="none" autoCorrect="off" spellCheck={false} className={cn(INPUT, 'mt-1')} />
      </label>
      <fieldset className="space-y-2">
        <legend className="mb-1 text-[13px] text-muted">Role</legend>
        <label className="flex items-center gap-2 text-[15px] text-paper">
          <input type="radio" name="role" checked={role === 'member'} onChange={() => setRole('member')} className={check} />
          Member: listens
        </label>
        <label className="flex items-center gap-2 text-[15px] text-paper">
          <input type="radio" name="role" checked={role === 'admin'} onChange={() => setRole('admin')} className={check} />
          Admin: also changes settings, sources and accounts
        </label>
      </fieldset>
      <label className="flex items-center gap-2 text-[15px] text-paper">
        <input type="checkbox" checked={canRequest} onChange={(e) => setCanRequest(e.target.checked)} className={check} />
        Can request albums
      </label>
      <fieldset className="space-y-2">
        <legend className="mb-1 text-[13px] text-muted">Library</legend>
        <label className="flex items-center gap-2 text-[15px] text-paper">
          <input type="radio" name="library" checked={everySource} onChange={() => setEverySource(true)} className={check} />
          Every source
        </label>
        <label className="flex items-center gap-2 text-[15px] text-paper">
          <input type="radio" name="library" checked={!everySource} onChange={() => setEverySource(false)} className={check} />
          Only these sources
        </label>
        {!everySource && (
          <div className="ml-6 space-y-2">
            {(sourceList?.sources ?? []).map((s) => (
              <label key={s.id} className="flex items-center gap-2 text-[15px] text-paper">
                <input type="checkbox" checked={picked.includes(s.id)} onChange={() => toggle(s.id)} className={check} />
                {s.name}
              </label>
            ))}
          </div>
        )}
      </fieldset>
      <div className="flex justify-end">
        <button type="submit" disabled={busy || !name.trim() || !username.trim()} className="inline-flex h-10 items-center rounded-full bg-accent px-5 text-[14px] font-medium text-accent-ink transition hover:brightness-110 disabled:opacity-40">
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

/** A new or reset account's one-time code, and the link that fills it in. */
function SetupCodeView({ setup }: { setup: SetupCode }) {
  const copy = () =>
    void navigator.clipboard?.writeText(setup.link).then(
      () => toast('Link copied'),
      () => toast('Couldn’t copy: select the link instead', 'error'),
    );
  return (
    <div className="space-y-4 p-5">
      <p className="text-[15px] text-paper-dim">
        Give them this code or link: they choose their own password with it. It works once, until{' '}
        {new Date(setup.expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}.
      </p>
      <p className="font-mono text-3xl tracking-[0.3em] text-paper">{setup.code}</p>
      <div className="flex gap-2">
        <input readOnly value={setup.link} aria-label="Setup link" onFocus={(e) => e.target.select()} className={INPUT} />
        <button type="button" onClick={copy} className={cn(BUTTON, 'shrink-0')}>
          <Copy className="size-4" /> Copy
        </button>
      </div>
    </div>
  );
}
