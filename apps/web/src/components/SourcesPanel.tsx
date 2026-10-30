import type { FolderAccessKind, FolderBrowseRequest, SourceInfo, SourceTestResult } from '@playarr/shared';
import {
  Check,
  Folder,
  FolderOpen,
  FolderTree,
  GripVertical,
  Loader2,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  RotateCw,
  Server,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { Reorder, useDragControls } from 'motion/react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../lib/api';
import { cn } from '../lib/cn';
import { plural, formatWait } from '../lib/format';
import { useFolderAccess, useFolderListing, useMatching, useSaveMatching, useSourceActions, useSources } from '../lib/queries';
import { Dialog } from './Dialog';
import { OrganizeDialog } from './OrganizeDialog';
import { ReviewDialog } from './ReviewDialog';
import { AwayNotice, Field } from './SettingsControls';

const INPUT =
  'h-11 w-full rounded-lg border border-line bg-ink-900 px-3 text-[15px] text-paper outline-none transition focus:border-accent';
const PRIMARY =
  'inline-flex h-10 items-center justify-center rounded-full bg-accent px-5 text-[14px] font-medium text-accent-ink transition disabled:opacity-50';
const SECONDARY =
  'inline-flex h-10 items-center justify-center gap-2 rounded-full border border-line px-5 text-[14px] text-paper transition hover:bg-paper/5 disabled:opacity-50';

/** Settings → Sources: where the library comes from, in priority order. */
export function SourcesPanel() {
  const { data, error } = useSources();
  const actions = useSourceActions();
  const [order, setOrder] = useState<SourceInfo[]>([]);
  const [editing, setEditing] = useState<SourceInfo | 'new' | null>(null);
  const [reviewing, setReviewing] = useState<number | null>(null);
  const [organizing, setOrganizing] = useState<number | null>(null);

  useEffect(() => {
    if (data) setOrder(data.sources);
  }, [data]);

  if (error) return <p className="text-sm text-red-300/80">{(error as Error).message}</p>;
  if (!data) return <div className="h-24 animate-pulse rounded-lg bg-paper/5" />;

  const { canEdit } = data;
  const commitOrder = () => {
    const ids = order.map((s) => s.id);
    if (ids.join() !== data.sources.map((s) => s.id).join()) actions.reorder.mutate(ids);
  };

  return (
    <section>
      <p className="mb-6 max-w-prose text-sm text-muted">
        Where your music comes from. When a song is in more than one place, Playarr plays the best-quality copy; between equal
        copies, the source higher in this list wins.
      </p>
      {!canEdit && (
        <AwayNotice />
      )}
      {data.sources.length === 0 && (
        <p className="mb-6 text-[15px] text-paper-dim">No sources yet. Add Lidarr or a folder to start your library.</p>
      )}

      <Reorder.Group axis="y" values={order} onReorder={setOrder} as="ol" className="-mx-2">
        {order.map((s) => (
          <SourceRow
            key={s.id}
            source={s}
            canEdit={canEdit}
            onDragEnd={commitOrder}
            onEdit={() => setEditing(s)}
            onReview={() => setReviewing(s.id)}
            onOrganize={() => setOrganizing(s.id)}
          />
        ))}
      </Reorder.Group>

      {canEdit && (
        <button type="button" onClick={() => setEditing('new')} className={cn(SECONDARY, 'mt-6')}>
          <Plus className="size-4" /> Add source
        </button>
      )}

      {canEdit && data.sources.some((s) => s.kind === 'folder') && <MatchingSection />}

      <SourceDialog
        target={editing}
        hasLidarr={data.sources.some((s) => s.kind === 'lidarr')}
        onClose={() => setEditing(null)}
      />
      <ReviewDialog sourceId={reviewing} onClose={() => setReviewing(null)} />
      <OrganizeDialog sourceId={organizing} onClose={() => setOrganizing(null)} />
    </section>
  );
}

function SourceRow({
  source: s,
  canEdit,
  onDragEnd,
  onEdit,
  onReview,
  onOrganize,
}: {
  source: SourceInfo;
  canEdit: boolean;
  onDragEnd: () => void;
  onEdit: () => void;
  onReview: () => void;
  onOrganize: () => void;
}) {
  const controls = useDragControls();
  const actions = useSourceActions();
  const remove = () => {
    if (window.confirm(`Remove “${s.name}”? Its songs leave your library; favorites and playlists keep them, greyed out.`)) {
      actions.remove.mutate(s.id);
    }
  };
  const remote = s.kind === 'folder' && !!s.settings?.access && s.settings.access !== 'local';
  const where = !remote
    ? (s.settings?.url ?? s.settings?.path)
    : s.settings!.access === 'smb'
      ? `smb://${s.settings!.user}@${s.settings!.host}${s.settings!.path}`
      : `${s.settings!.user}@${s.settings!.host}:${s.settings!.path}`;
  const details = [where, `${plural(s.songs, 'song')} · ${plural(s.albums, 'album')}`].filter(Boolean).join(' · ');

  return (
    <Reorder.Item
      value={s}
      dragListener={false}
      dragControls={controls}
      onDragEnd={onDragEnd}
      as="li"
      className="flex items-center gap-3 rounded-lg bg-ink-900 px-2 py-3"
    >
      {canEdit && (
        <span
          role="button"
          aria-label={`Drag to reorder ${s.name}`}
          onPointerDown={(e) => controls.start(e)}
          className="grid h-9 cursor-grab touch-none place-items-center text-muted active:cursor-grabbing"
        >
          <GripVertical className="size-4" />
        </span>
      )}
      <span className="grid size-11 shrink-0 place-items-center rounded-md bg-ink-800 text-accent">
        {remote ? <Network className="size-5" /> : s.kind === 'folder' ? <FolderOpen className="size-5" /> : <Server className="size-5" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[17px] text-paper">{s.name}</span>
          {!s.enabled && <span className="font-mono text-[10px] tracking-wider text-muted uppercase">Off</span>}
        </div>
        <div className="truncate font-mono text-[12px] text-muted">{details}</div>
        <SourceStatus source={s} />
        {s.kind === 'folder' && s.review > 0 && canEdit && (
          <button type="button" onClick={onReview} className="mt-1 text-[13px] text-accent hover:underline">
            {plural(s.review, 'album')} to review
          </button>
        )}
      </div>
      {canEdit && (
        <div className="flex items-center gap-1">
          <IconButton label="Rescan" onClick={() => actions.rescan.mutate(s.id)} disabled={s.syncing}>
            {s.syncing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          </IconButton>
          {s.kind === 'folder' && (
            <IconButton label="Match again" onClick={() => actions.rematch.mutate(s.id)} disabled={actions.rematch.isPending}>
              <RotateCw className="size-4" />
            </IconButton>
          )}
          {s.kind === 'folder' && (
            // Shown even when the folder isn't writable: the dialog explains why nothing can move.
            <IconButton label="Organize files" onClick={onOrganize}>
              <FolderTree className="size-4" />
            </IconButton>
          )}
          <IconButton label="Edit" onClick={onEdit}>
            <Pencil className="size-4" />
          </IconButton>
          <IconButton label="Remove" onClick={remove}>
            <Trash2 className="size-4" />
          </IconButton>
        </div>
      )}
    </Reorder.Item>
  );
}

function SourceStatus({ source: s }: { source: SourceInfo }) {
  const [text, tone] = s.syncing
    ? ['Syncing…', 'text-accent']
    : s.matching > 0
      ? // Each album takes a few MusicBrainz lookups at about one per second.
        [`Matching… ${plural(s.matching, 'album')} left · about ${formatWait(s.matching * 3.3)}`, 'text-accent']
      : s.error
        ? [s.error, 'text-red-300/80']
        : !s.enabled
          ? ['Turned off', 'text-muted']
          : s.lastSyncAt
            ? [`Synced ${new Date(s.lastSyncAt).toLocaleString()}`, 'text-muted']
            : ['Not synced yet', 'text-muted'];
  return (
    <div className={cn('mt-0.5 truncate text-[12px]', tone)} title={text}>
      {text}
    </div>
  );
}

/** The AcoustID key, for identifying songs by their sound. */
function MatchingSection() {
  const { data } = useMatching();
  const save = useSaveMatching();
  const [replacing, setReplacing] = useState(false);
  const [key, setKey] = useState('');
  if (!data) return null;
  const editing = replacing || !data.acoustid;
  return (
    <section className="mt-12 max-w-prose">
      <h2 className="mb-2 font-mono text-[11px] tracking-[0.2em] text-muted uppercase">Identifying songs</h2>
      <p className="mb-4 text-sm text-muted">
        Playarr matches folder albums on MusicBrainz by their names, track titles and lengths. For songs whose names don’t help,
        it can identify them by their sound with AcoustID. A free key comes from{' '}
        <a href="https://acoustid.org/new-application" target="_blank" rel="noreferrer" className="text-accent hover:underline">
          acoustid.org
        </a>
        .
      </p>
      {!data.fingerprints && (
        <p className="mb-4 text-sm text-paper-dim">Fingerprints need fpcalc (Chromaprint) on the server. The Docker image includes it.</p>
      )}
      {editing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(key, {
              onSuccess: () => {
                setReplacing(false);
                setKey('');
              },
            });
          }}
          className="flex gap-2"
        >
          <input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            aria-label="AcoustID key"
            placeholder="AcoustID application key"
            autoComplete="off"
            spellCheck={false}
            className={cn(INPUT, 'font-mono')}
          />
          <button type="submit" disabled={!key || save.isPending} className={PRIMARY}>
            Save
          </button>
        </form>
      ) : (
        <div className="flex items-center gap-3 text-[14px]">
          <span className="font-mono text-paper-dim">AcoustID key saved</span>
          <button type="button" onClick={() => setReplacing(true)} className="text-accent hover:underline">
            Replace
          </button>
        </div>
      )}
    </section>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="grid size-9 place-items-center rounded-full text-muted transition hover:bg-paper/8 hover:text-paper disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function SourceDialog({
  target,
  hasLidarr,
  onClose,
}: {
  target: SourceInfo | 'new' | null;
  hasLidarr: boolean;
  onClose: () => void;
}) {
  const editing = target && target !== 'new' ? target : undefined;
  const [kind, setKind] = useState<'lidarr' | 'folder' | null>(null);
  useEffect(() => setKind(null), [target]);
  const formKind = editing?.kind ?? kind;

  return (
    <Dialog open={target !== null} onClose={onClose} title={editing ? `Edit ${editing.name}` : 'Add source'}>
      {formKind === 'lidarr' ? (
        <LidarrForm key={editing?.id ?? 'new'} source={editing} onDone={onClose} />
      ) : formKind === 'folder' ? (
        <FolderForm key={editing?.id ?? 'new'} source={editing} onDone={onClose} />
      ) : (
        <div className="space-y-2 p-5">
          <KindOption
            icon={<Server className="size-5" />}
            title="Lidarr"
            detail={hasLidarr ? 'Playarr connects to one Lidarr, and it’s already added.' : 'Your Lidarr library, with requests.'}
            disabled={hasLidarr}
            onClick={() => setKind('lidarr')}
          />
          <KindOption
            icon={<FolderOpen className="size-5" />}
            title="Folder"
            detail="Music in a folder: on this server, another machine over SSH or SFTP, or an SMB share. Playarr only reads it."
            onClick={() => setKind('folder')}
          />
        </div>
      )}
    </Dialog>
  );
}

function KindOption({
  icon,
  title,
  detail,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-4 rounded-lg px-3 py-3 text-left transition hover:bg-paper/[0.04] disabled:opacity-50 disabled:hover:bg-transparent"
    >
      <span className="grid size-11 shrink-0 place-items-center rounded-md bg-ink-800 text-accent">{icon}</span>
      <span>
        <span className="block text-[16px] text-paper">{title}</span>
        <span className="block text-[13px] text-muted">{detail}</span>
      </span>
    </button>
  );
}

function LidarrForm({ source, onDone }: { source?: SourceInfo; onDone: () => void }) {
  const actions = useSourceActions();
  const keySaved = !!source?.secrets.includes('apiKey');
  const [name, setName] = useState(source?.name ?? 'Lidarr');
  const [url, setUrl] = useState(source?.settings?.url ?? '');
  const [apiKey, setApiKey] = useState('');
  const [replacingKey, setReplacingKey] = useState(!keySaved);
  const [enabled, setEnabled] = useState(source?.enabled ?? true);
  const [test, setTest] = useState<SourceTestResult | 'running' | null>(null);
  const settings = { url, ...(replacingKey && apiKey ? { apiKey } : {}) };
  const pending = actions.add.isPending || actions.update.isPending;

  const runTest = async () => {
    setTest('running');
    try {
      setTest(await api.testSource({ id: source?.id, ...settings }));
    } catch (err) {
      setTest({ ok: false, error: (err as Error).message });
    }
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    const input = { name, enabled, settings };
    if (source) actions.update.mutate({ id: source.id, input }, { onSuccess: onDone });
    else actions.add.mutate({ kind: 'lidarr', ...input }, { onSuccess: onDone });
  };

  return (
    <form onSubmit={save} className="space-y-4 p-5">
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} className={INPUT} required maxLength={80} />
      </Field>
      <Field label="URL">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="http://192.168.1.10:8686"
          className={INPUT}
          required
        />
      </Field>
      <Field label="API key" hint="In Lidarr: Settings → General → Security">
        {replacingKey ? (
          <input
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className={cn(INPUT, 'font-mono')}
            autoComplete="off"
            spellCheck={false}
            required={!keySaved}
            placeholder={keySaved ? 'New API key' : undefined}
          />
        ) : (
          <div className="flex h-11 items-center gap-3">
            <span className="font-mono text-[13px] text-paper-dim">Saved</span>
            <button type="button" onClick={() => setReplacingKey(true)} className="text-[13px] text-accent hover:underline">
              Replace
            </button>
          </div>
        )}
      </Field>
      {source && (
        <label className="flex items-center gap-2 text-sm text-paper-dim">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Use this source
        </label>
      )}
      {test === 'running' && (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Loader2 className="size-4 animate-spin" /> Connecting…
        </p>
      )}
      {test && test !== 'running' && (
        <p className={cn('flex items-center gap-2 text-sm', test.ok ? 'text-emerald-300' : 'text-red-300/80')}>
          {test.ok ? <Check className="size-4" /> : <TriangleAlert className="size-4" />}
          {test.ok ? `Connected to Lidarr ${test.version ?? ''}` : test.error}
        </p>
      )}
      <div className="flex justify-end gap-2 pt-2">
        <button type="button" onClick={runTest} disabled={test === 'running' || !url} className={SECONDARY}>
          Test
        </button>
        <button type="submit" disabled={pending} className={PRIMARY}>
          {pending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

const ACCESS: { id: FolderAccessKind; label: string }[] = [
  { id: 'local', label: 'This server' },
  { id: 'ssh', label: 'SSH' },
  { id: 'sftp', label: 'SFTP' },
  { id: 'smb', label: 'SMB share' },
];

const SMB_OFF = 'SMB shares need rclone on the server';
/** SMB listens on 445, SSH and SFTP on 22. */
const defaultPort = (access: FolderAccessKind) => (access === 'smb' ? 445 : 22);

function FolderForm({ source, onDone }: { source?: SourceInfo; onDone: () => void }) {
  const actions = useSourceActions();
  const saved = source?.settings;
  const savedAccess = saved?.access ?? 'local';
  const passwordSaved = !!source?.secrets.includes('password');
  const [name, setName] = useState(source?.name ?? '');
  const [access, setAccess] = useState<FolderAccessKind>(savedAccess);
  const [path, setPath] = useState<string | undefined>(saved?.path);
  const [host, setHost] = useState(saved?.host ?? '');
  const [port, setPort] = useState(saved?.port ?? defaultPort(savedAccess));
  const [user, setUser] = useState(saved?.user ?? '');
  const [password, setPassword] = useState('');
  const [replacingPassword, setReplacingPassword] = useState(!passwordSaved);
  const [keyPath, setKeyPath] = useState(saved?.privateKeyPath ?? '');
  const [domain, setDomain] = useState(saved?.domain ?? '');
  const [enabled, setEnabled] = useState(source?.enabled ?? true);
  const remote = access !== 'local';
  const smb = access === 'smb';
  // Without rclone on the server, SMB can't be chosen for a new folder (a saved one stays editable).
  const smbOff = useFolderAccess().data?.smb === false;
  // What the folder browser connects with: taken when Connect is pressed, so typing doesn't open connections.
  const connectionNow = (): FolderBrowseRequest => ({
    id: source?.id,
    connection: {
      access,
      host: host.trim(),
      port,
      user: user.trim(),
      password: replacingPassword ? password || undefined : undefined,
      ...(access === 'smb' ? { domain: domain.trim() || undefined } : { privateKeyPath: keyPath.trim() || undefined }),
    },
  });
  const [browsing, setBrowsing] = useState<{ request: FolderBrowseRequest; attempt: number } | null>(() =>
    savedAccess !== 'local' && source ? { request: connectionNow(), attempt: 0 } : null,
  );
  const pending = actions.add.isPending || actions.update.isPending;

  const chooseAccess = (next: FolderAccessKind) => {
    if (next === access) return;
    setAccess(next);
    // SMB and SSH listen on different ports: swap the default, keep a port the user chose.
    if (next === 'smb' && port === 22) setPort(445);
    if (access === 'smb' && next !== 'smb' && port === 445) setPort(22);
    // A path on one machine means nothing on another.
    setPath(next === savedAccess ? saved?.path : undefined);
    setBrowsing(null);
  };

  const connect = () => setBrowsing((b) => ({ request: connectionNow(), attempt: (b?.attempt ?? 0) + 1 }));

  // An SMB folder lives on a share: the list of shares itself can't be chosen.
  const pathOk = !!path && !(smb && path === '/');

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!path || !pathOk) return;
    const settings = {
      path,
      access,
      ...(remote
        ? {
            host: host.trim(),
            port,
            user: user.trim(),
            // An empty value clears the saved one.
            ...(smb ? { domain: domain.trim() } : { privateKeyPath: keyPath.trim() }),
            ...(replacingPassword && password ? { password } : {}),
          }
        : {}),
    };
    const input = { name: name.trim() || undefined, enabled, settings };
    if (source) actions.update.mutate({ id: source.id, input }, { onSuccess: onDone });
    else actions.add.mutate({ kind: 'folder', ...input }, { onSuccess: onDone });
  };

  return (
    <form onSubmit={save} className="space-y-4 p-5">
      <div role="radiogroup" aria-label="Where the folder is" className="flex gap-6 border-b border-line">
        {ACCESS.map((a) => {
          const off = a.id === 'smb' && smbOff && savedAccess !== 'smb';
          return (
            <button
              key={a.id}
              type="button"
              role="radio"
              aria-checked={access === a.id}
              disabled={off}
              title={off ? SMB_OFF : undefined}
              onClick={() => chooseAccess(a.id)}
              className={cn(
                '-mb-px border-b-2 pb-2.5 text-[15px] whitespace-nowrap transition-colors disabled:opacity-40 disabled:hover:text-paper-dim/70',
                access === a.id ? 'border-accent text-paper' : 'border-transparent text-paper-dim/70 hover:text-paper',
              )}
            >
              {a.label}
            </button>
          );
        })}
      </div>
      {smb && smbOff && <p className="text-[13px] text-red-300/80">{SMB_OFF}.</p>}
      {remote && (
        <div className="space-y-4">
          <div className="flex gap-3">
            <div className="min-w-0 flex-1">
              <Field label="Host">
                <input
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="192.168.1.10"
                  className={INPUT}
                  autoComplete="off"
                  spellCheck={false}
                  required
                />
              </Field>
            </div>
            <div className="w-28 shrink-0">
              <Field label="Port">
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={port}
                  onChange={(e) => setPort(Number(e.target.value) || defaultPort(access))}
                  className={INPUT}
                  required
                />
              </Field>
            </div>
          </div>
          <Field label="User" hint={smb ? 'guest for guest access' : undefined}>
            <input value={user} onChange={(e) => setUser(e.target.value)} className={INPUT} autoComplete="off" spellCheck={false} required />
          </Field>
          <Field label="Password" hint={smb ? 'Leave empty for guest access' : 'Optional with a key file or ssh-agent'}>
            {replacingPassword ? (
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={INPUT}
                autoComplete="new-password"
                placeholder={passwordSaved ? 'New password' : undefined}
              />
            ) : (
              <div className="flex h-11 items-center gap-3">
                <span className="font-mono text-[13px] text-paper-dim">Saved</span>
                <button type="button" onClick={() => setReplacingPassword(true)} className="text-[13px] text-accent hover:underline">
                  Replace
                </button>
              </div>
            )}
          </Field>
          {smb ? (
            <Field label="Domain" hint="Optional">
              <input
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="WORKGROUP"
                className={INPUT}
                autoComplete="off"
                spellCheck={false}
                maxLength={100}
              />
            </Field>
          ) : (
            <Field label="Key file on the server" hint="Optional: a private key on the Playarr server">
              <input
                value={keyPath}
                onChange={(e) => setKeyPath(e.target.value)}
                placeholder="~/.ssh/id_ed25519"
                className={cn(INPUT, 'font-mono')}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
          )}
          <div className="flex items-center justify-between gap-3">
            <p className="text-[13px] text-muted">
              {smb
                ? 'Playarr reads the share with rclone. Song analysis and fingerprints run on this server.'
                : 'SSH also runs song analysis and fingerprints on that machine. SFTP only reads files.'}
            </p>
            <button type="button" onClick={connect} disabled={!host.trim() || !user.trim()} className={cn(SECONDARY, 'shrink-0')}>
              Connect
            </button>
          </div>
        </div>
      )}
      {(!remote || browsing) && (
        <div>
          <span className="mb-1.5 block font-mono text-[11px] tracking-[0.2em] text-muted uppercase">Folder</span>
          {remote ? (
            <FolderBrowser
              key={browsing!.attempt}
              value={path}
              onChange={setPath}
              request={browsing!.request}
              rootLabel={smb ? `Shares on ${browsing!.request.connection?.host || saved?.host || ''}` : undefined}
            />
          ) : (
            <FolderBrowser value={path} onChange={setPath} request={{}} />
          )}
        </div>
      )}
      <Field label="Name">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={path?.split('/').pop() || 'Music'}
          className={INPUT}
          maxLength={80}
        />
      </Field>
      {source && (
        <label className="flex items-center gap-2 text-sm text-paper-dim">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Use this source
        </label>
      )}
      <p className="text-[13px] text-muted">Playarr only reads this folder. Songs appear after the first scan.</p>
      <div className="flex justify-end pt-2">
        <button type="submit" disabled={!pathOk || pending} className={PRIMARY}>
          {pending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

function FolderBrowser({
  value,
  onChange,
  request,
  rootLabel,
}: {
  value?: string;
  onChange: (path: string) => void;
  /** The connection and/or saved source to browse; empty for this server. */
  request: Omit<FolderBrowseRequest, 'path'>;
  /** What "/" is called, when it isn't a folder you can choose (an SMB server's list of shares). */
  rootLabel?: string;
}) {
  const [at, setAt] = useState<string | undefined>(value);
  const { data, error, isFetching } = useFolderListing({ ...request, path: at });
  const remote = !!request.connection && request.connection.access !== 'local';
  // On this server, "up" from a root goes back to the list of roots; on another machine, "/" is the top.
  const canGoUp = data && data.path !== null && (data.parent !== null || !remote);
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2 font-mono text-[12px] text-paper-dim">
        {canGoUp && (
          <button
            type="button"
            onClick={() => setAt(data.parent ?? undefined)}
            className="rounded px-1.5 text-muted hover:bg-paper/8 hover:text-paper"
            aria-label="Up one folder"
          >
            ..
          </button>
        )}
        <span className="truncate">
          {data?.path === '/' && rootLabel ? rootLabel : (data?.path ?? (remote ? (isFetching ? 'Connecting…' : '') : 'Folders Playarr may use'))}
        </span>
      </div>
      <ul className="max-h-60 overflow-y-auto py-1">
        {data?.folders.map((f) => (
          <li key={f.path}>
            <button
              type="button"
              onClick={() => setAt(f.path)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[14px] text-paper hover:bg-paper/5"
            >
              <Folder className="size-4 shrink-0 text-muted" />
              <span className="truncate">{f.name}</span>
            </button>
          </li>
        ))}
        {data && data.folders.length === 0 && !data.emptyRoot && (
          <li className="px-3 py-2 text-[13px] text-muted">{rootLabel && data.path === '/' ? 'No shares found.' : 'No folders inside.'}</li>
        )}
        {data?.emptyRoot && (
          <li className="space-y-1.5 px-3 py-2 text-[13px] text-muted">
            <p className="text-paper-dim">Nothing is shared with Playarr at {data.path} yet.</p>
            <p>
              In Docker, Playarr only sees the host folders you mount inside {data.path}. Mount them read-only in a compose.override.yaml
              next to compose.yaml, for example <code className="font-mono text-[12px] text-paper-dim">/volume2:{data.path}/volume2:ro</code>,
              then restart Playarr.
            </p>
          </li>
        )}
      </ul>
      {error && <p className="px-3 py-2 text-[13px] text-red-300/80">{(error as Error).message}</p>}
      {data?.path && !(rootLabel && data.path === '/') && (
        <div className="flex items-center justify-between gap-3 border-t border-line px-3 py-2">
          <span className="text-[12px] text-muted">
            {plural(data.audioFiles, 'audio file')} here{value === data.path ? ' · selected' : ''}
          </span>
          <button type="button" onClick={() => onChange(data.path!)} className="text-[13px] text-accent hover:underline">
            Use this folder
          </button>
        </div>
      )}
    </div>
  );
}
