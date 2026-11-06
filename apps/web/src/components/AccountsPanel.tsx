import type { Account, AccountRole, DeviceSetting, ListedAccount, SessionInfo, SetupCode } from '@playarr/shared';
import { Copy, KeyRound, LogOut, Pencil, Smartphone, Trash, UserPlus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { signOut } from '../lib/accounts';
import { forgetInvite, inviteFor, rememberInvite } from '../lib/invites';
import { api, type AccountInput } from '../lib/api';
import { plural } from '../lib/format';
import { useAccountAction, useAccountList, useAccountSessions, useMe, useServerInfo, useSources } from '../lib/queries';
import { toast } from '../lib/toast';
import { Button } from './Button';
import { ConfirmDialog, Dialog } from './Dialog';
import { DIVIDER, Menu, type MenuEntry } from './Menu';
import { InlineError } from './States';
import { SettingsSection } from './SettingsControls';
import { TextField } from './TextField';
const LOADING = <div aria-busy="true" className="h-40 max-w-prose animate-pulse rounded-lg bg-paper/5" />;

/** Settings → Accounts: who signs in to this server and what each may hear and change; your name and devices. */
export function AccountsPanel() {
  const { data: server } = useServerInfo();
  const { data: me, error, isPending } = useMe();
  if (!server) return LOADING;
  if (server.setup) return <ClaimServer />;
  if (isPending) return LOADING;
  if (!me) return <InlineError error={error ?? 'Sign in to see your account.'} />;
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
      <Button to="/setup">Set up the owner’s account</Button>
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
      <form onSubmit={save} className="flex max-w-md items-center gap-2">
        <TextField label="Your name" hideLabel value={name} onChange={(e) => setName(e.target.value)} maxLength={40} className="min-w-0 flex-1" />
        <Button type="submit" variant="primary" disabled={!name.trim() || name.trim() === me.name} pending={rename.isPending} pendingLabel="Saving…">
          Save
        </Button>
      </form>
      <h3 className="mt-6 mb-1 type-small text-muted">Signed in on</h3>
      <Devices accountId={me.id} />
      <Button icon={<LogOut />} onClick={() => void signOut().then(() => navigate('/sign-in', { replace: true }))} className="mt-5">
        Sign out on this device
      </Button>
    </SettingsSection>
  );
}

/** An account's signed-in devices, each but this one signed out after asking. */
function Devices({ accountId }: { accountId: number }) {
  const { data: sessions } = useAccountSessions(accountId);
  const [ending, setEnding] = useState<SessionInfo | null>(null);
  const end = useAccountAction((sessionId: number) => api.endSession(accountId, sessionId), () => setEnding(null));
  if (!sessions) return <div aria-busy="true" className="h-16 animate-pulse rounded-lg bg-paper/5" />;
  if (!sessions.length) return <p className="text-sm text-muted">No devices are signed in.</p>;
  return (
    <>
      <ConfirmDialog
        open={!!ending}
        onClose={() => setEnding(null)}
        title={`Sign out ${ending?.device ?? ''}?`}
        confirmLabel="Sign out"
        pendingLabel="Signing out…"
        pending={end.isPending}
        onConfirm={() => ending && end.mutate(ending.id)}
      >
        <p>It stops listening at once, and needs the password to sign in again.</p>
      </ConfirmDialog>
      <ul className="divide-y divide-line">
        {sessions.map((s) => (
          <li key={s.id} className="flex items-center gap-3 py-2">
            <span className="min-w-0 flex-1">
              <span className="block truncate type-body text-paper">
                {s.device}
                {s.current && <span className="ml-2 type-small text-muted">this device</span>}
              </span>
              <span className="block type-small text-muted">Last used {new Date(s.lastSeenAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
            </span>
            {!s.current && (
              <Button size="small" variant="ghost" icon={<LogOut />} aria-label={`Sign out ${s.device}`} onClick={() => setEnding(s)}>
                Sign out
              </Button>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

/** The device settings an admin can stop a member from changing, as the form names them. */
const DEVICE_SETTINGS: { setting: DeviceSetting; label: string }[] = [
  { setting: 'playback', label: 'Playback' },
  { setting: 'appearance', label: 'Appearance' },
];

/** "sam · member · can request albums · Creative Commons · Playback locked" */
function summary(a: Account, sourceNames: Map<number, string>): string {
  const library = a.sources === null ? 'every source' : a.sources.length ? a.sources.map((id) => sourceNames.get(id) ?? `source ${id}`).join(', ') : 'no sources';
  const locked = DEVICE_SETTINGS.filter(({ setting }) => a.locked?.includes(setting)).map(({ label }) => label);
  return [a.username, a.role, a.canRequest ? 'can request albums' : '', library, locked.length ? `${locked.join(' and ')} locked` : '']
    .filter(Boolean)
    .join(' · ');
}

/** Put a setup link on the clipboard; where there's none to use (plain HTTP), or it says no, `fallback` shows it to copy by hand. */
function copyLink(link: string, done: string, fallback: () => void) {
  if (!navigator.clipboard) return fallback();
  navigator.clipboard.writeText(link).then(() => toast(done), fallback);
}

/** What removing an account takes with it, by name and number. */
function removedSummary(a: Account & Partial<Pick<ListedAccount, 'plays' | 'playlists'>>, self: boolean): string {
  const whose = self ? 'Your' : 'Their';
  const history = a.plays ? `listening history (${a.plays.toLocaleString('en')} ${a.plays === 1 ? 'song' : 'songs'} played)` : 'listening history';
  const playlists = a.playlists ? `${plural(a.playlists, 'playlist')}` : 'playlists';
  return `${whose} ${history}, mixes, Favorites and ${playlists} are deleted for good, and every device ${self ? 'you’re' : 'they’re'} signed in on is signed out.`;
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
  const [resetting, setResetting] = useState<Account | null>(null);
  // Copy invite link for an invite this device can't copy: a new one, after asking.
  const [inviting, setInviting] = useState<Account | null>(null);
  const create = useAccountAction((input: AccountInput) => api.createAccount(input), (created) => {
    rememberInvite(created.account.id, created.setup);
    setAdding(false);
    setCode(created);
  });
  const update = useAccountAction(({ id, input }: { id: number; input: AccountInput }) => api.updateAccount(id, input), () => setEditing(null));
  const reset = useAccountAction(
    (a: Account) => api.resetAccount(a.id).then((setup) => ({ account: a, setup })),
    (made) => {
      rememberInvite(made.account.id, made.setup);
      setResetting(null);
      setInviting(null);
      setCode(made);
    },
  );
  const remove = useAccountAction(
    (a: Account) => api.deleteAccount(a.id),
    () => {
      if (removing) forgetInvite(removing.id);
      if (removing?.id === me.id) void signOut().then(() => navigate('/sign-in', { replace: true }));
      setRemoving(null);
    },
  );
  /** The invite made on this device goes on the clipboard; without one, a new one is offered. */
  const copyInvite = (a: Account) => {
    const invite = inviteFor(a.id);
    if (!invite) return setInviting(a);
    copyLink(invite.link, `Copied ${a.name}’s invite link`, () => setCode({ account: a, setup: invite }));
  };
  /** An account's actions, in words (docs/design.md, Rows, menus and toasts): Remove last, after a line. */
  const actionsFor = (a: Account): MenuEntry[] => [
    { label: 'Edit', icon: Pencil, onSelect: () => setEditing(a) },
    // Someone invited who never set up has no devices; their new code is beside them.
    ...(a.hasPassword
      ? [
          { label: 'Devices', icon: Smartphone, onSelect: () => setDevices(a) },
          { label: 'New setup code', icon: KeyRound, onSelect: () => setResetting(a) },
        ]
      : []),
    DIVIDER,
    { label: 'Remove', icon: Trash, onSelect: () => setRemoving(a) },
  ];

  if (error) return <InlineError className="mt-12" error={error} />;
  if (!accounts) return LOADING;
  const sourceNames = new Map((sourceList?.sources ?? []).map((s) => [s.id, s.name]));

  return (
    <SettingsSection
      title="Everyone"
      description="Each account has its own history, mixes, favorites and playlists, and hears every source or only the ones you pick. Admins change settings, sources and accounts. You never choose anyone’s password: a new or reset account gets a setup code."
    >
      <ul className="divide-y divide-line">
        {accounts.map((a) => (
          <li key={a.id} className="py-3">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="type-body break-words text-paper">
                  {a.name}
                  {a.id === me.id && <span className="ml-2 type-small text-muted">you</span>}
                </div>
                {/* Never set up: an invite, not an account with nothing played yet. */}
                {!a.hasPassword && <div className="type-small text-paper-dim">Invited · not set up yet</div>}
                <div className="type-small break-words text-muted">{summary(a, sourceNames)}</div>
                {a.hasPassword && <div className="type-small text-muted">{activity(a)}</div>}
              </div>
              <Menu label={`More for ${a.name}`} items={actionsFor(a)} className="-my-1.5" />
            </div>
            {!a.hasPassword && (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="small" icon={<Copy />} onClick={() => copyInvite(a)}>
                  Copy invite link
                </Button>
                <Button size="small" variant="ghost" icon={<KeyRound />} onClick={() => setResetting(a)}>
                  New code
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <Button icon={<UserPlus />} onClick={() => setAdding(true)} className="mt-5">
        Add account
      </Button>

      <Dialog open={adding} onClose={() => setAdding(false)} title="Add account">
        {adding && <AccountForm submitLabel="Add" busy={create.isPending} onSubmit={(input) => create.mutate(input)} />}
      </Dialog>
      <Dialog open={!!editing} onClose={() => setEditing(null)} title={`Edit ${editing?.name ?? ''}`}>
        {editing && <AccountForm account={editing} submitLabel="Save" busy={update.isPending} onSubmit={(input) => update.mutate({ id: editing.id, input })} />}
      </Dialog>
      <Dialog open={!!devices} onClose={() => setDevices(null)} title={`${devices?.name ?? ''}’s devices`}>
        {devices && <Devices accountId={devices.id} />}
      </Dialog>
      <Dialog open={!!code} onClose={() => setCode(null)} title={`Setup code for ${code?.account.name ?? ''}`}>
        {code && <SetupCodeView setup={code.setup} />}
      </Dialog>
      <ConfirmDialog
        open={!!resetting}
        onClose={() => setResetting(null)}
        title={`New setup code for ${resetting?.name ?? ''}?`}
        confirmLabel="Make a new code"
        pendingLabel="Making one…"
        pending={reset.isPending}
        onConfirm={() => resetting && reset.mutate(resetting)}
      >
        {resetting?.hasPassword ? (
          <p>
            {resetting.id === me.id ? 'Your' : `${resetting.name}’s`} password stops working, and every device {resetting.id === me.id ? 'you’re' : 'they’re'}{' '}
            signed in on is signed out, until a new password is chosen with the new code.
          </p>
        ) : (
          <p>The code {resetting?.name} was given before stops working.</p>
        )}
      </ConfirmDialog>
      <ConfirmDialog
        open={!!inviting}
        onClose={() => setInviting(null)}
        title={`New invite link for ${inviting?.name ?? ''}?`}
        confirmLabel="Make a new link"
        pendingLabel="Making one…"
        pending={reset.isPending}
        onConfirm={() => inviting && reset.mutate(inviting)}
      >
        <p>
          Playarr keeps no copy of an invite once it’s made, and this device has none for {inviting?.name}: copying a link means making a new one, and
          the link or code {inviting?.name} has now stops working.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={`Remove ${removing?.name ?? ''}?`}
        confirmLabel="Remove"
        pendingLabel="Removing…"
        pending={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing)}
      >
        {removing && <p>{removedSummary(accounts.find((a) => a.id === removing.id) ?? removing, removing.id === me.id)}</p>}
      </ConfirmDialog>
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
  const [locked, setLocked] = useState<DeviceSetting[]>(account?.locked ?? []);
  const toggle = (id: number) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const allow = (setting: DeviceSetting, may: boolean) => setLocked((l) => (may ? l.filter((x) => x !== setting) : [...l, setting]));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit({ username: username.trim(), name: name.trim(), role, canRequest, sources: everySource ? null : picked, locked });
  };
  const check = 'size-4 accent-[var(--accent)]';
  return (
    <form onSubmit={submit} className="space-y-5">
      <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required />
      <TextField
        label="Username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        maxLength={32}
        required
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
      />
      <fieldset className="space-y-2">
        <legend className="mb-1 type-small text-muted">Role</legend>
        <label className="flex items-center gap-2 type-body text-paper">
          <input type="radio" name="role" checked={role === 'member'} onChange={() => setRole('member')} className={check} />
          Member: listens
        </label>
        <label className="flex items-center gap-2 type-body text-paper">
          <input type="radio" name="role" checked={role === 'admin'} onChange={() => setRole('admin')} className={check} />
          Admin: also changes settings, sources and accounts
        </label>
      </fieldset>
      <label className="flex items-center gap-2 type-body text-paper">
        <input type="checkbox" checked={canRequest} onChange={(e) => setCanRequest(e.target.checked)} className={check} />
        Can request albums
      </label>
      {role === 'member' && (
        <fieldset className="space-y-2">
          <legend className="mb-1 type-small text-muted">May change on their devices</legend>
          {DEVICE_SETTINGS.map(({ setting, label }) => (
            <label key={setting} className="flex items-center gap-2 type-body text-paper">
              <input type="checkbox" checked={!locked.includes(setting)} onChange={(e) => allow(setting, e.target.checked)} className={check} />
              {label}
            </label>
          ))}
        </fieldset>
      )}
      <fieldset className="space-y-2">
        <legend className="mb-1 type-small text-muted">Library</legend>
        <label className="flex items-center gap-2 type-body text-paper">
          <input type="radio" name="library" checked={everySource} onChange={() => setEverySource(true)} className={check} />
          Every source
        </label>
        <label className="flex items-center gap-2 type-body text-paper">
          <input type="radio" name="library" checked={!everySource} onChange={() => setEverySource(false)} className={check} />
          Only these sources
        </label>
        {!everySource && (
          <div className="ml-6 space-y-2">
            {(sourceList?.sources ?? []).map((s) => (
              <label key={s.id} className="flex items-center gap-2 type-body text-paper">
                <input type="checkbox" checked={picked.includes(s.id)} onChange={() => toggle(s.id)} className={check} />
                {s.name}
              </label>
            ))}
          </div>
        )}
      </fieldset>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={!name.trim() || !username.trim()} pending={busy} pendingLabel={account ? 'Saving…' : 'Adding…'}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** A new or reset account's one-time code, and the link that fills it in. */
function SetupCodeView({ setup }: { setup: SetupCode }) {
  const copy = () => copyLink(setup.link, 'Link copied', () => toast('Couldn’t copy: select the link instead', 'error'));
  return (
    <div className="space-y-4">
      <p className="type-body text-paper-dim">
        Give them this code or link: they choose their own password with it. It works once, until{' '}
        {new Date(setup.expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}.
      </p>
      <p className="font-mono text-3xl tracking-[0.3em] text-paper">{setup.code}</p>
      <div className="flex items-center gap-2">
        <TextField label="Setup link" hideLabel readOnly value={setup.link} onFocus={(e) => e.target.select()} className="min-w-0 flex-1" />
        <Button icon={<Copy />} onClick={copy}>
          Copy
        </Button>
      </div>
    </div>
  );
}
