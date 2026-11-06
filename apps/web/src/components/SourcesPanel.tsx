import type { FolderAccessKind, FolderBrowseRequest, SourceInfo, SourceTestResult } from '@playarr/shared';
import {
  ArrowDown,
  ArrowUp,
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
  ScanSearch,
  Server,
  TriangleAlert,
  X,
} from 'lucide-react';
import { Reorder, useDragControls } from 'motion/react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../lib/api';
import { cn } from '../lib/cn';
import { plural, formatWait } from '../lib/format';
import { useFolderAccess, useFolderListing, useMatching, useSaveMatching, useSourceActions, useSources } from '../lib/queries';
import { Button } from './Button';
import { Choice } from './Choice';
import { ConfirmDialog, Dialog } from './Dialog';
import { OrganizeDialog } from './OrganizeDialog';
import { ReviewDialog } from './ReviewDialog';
import { AwayNotice } from './SettingsControls';
import { DIVIDER, Menu, type MenuEntry } from './Menu';
import { InlineError } from './States';
import { TextField } from './TextField';

/** Settings → Sources: where the library comes from, in priority order. */
export function SourcesPanel() {
  const { data, error, refetch, isFetching } = useSources();
  const actions = useSourceActions();
  const [order, setOrder] = useState<SourceInfo[]>([]);
  const [editing, setEditing] = useState<SourceInfo | 'new' | null>(null);
  const [reviewing, setReviewing] = useState<number | null>(null);
  const [organizing, setOrganizing] = useState<number | null>(null);

  useEffect(() => {
    if (data) setOrder(data.sources);
  }, [data]);

  if (error && !data) return <InlineError error={error} onRetry={() => void refetch()} retrying={isFetching} />;
  if (!data) return <div className="h-24 animate-pulse rounded-lg bg-paper/5" />;

  const { canEdit } = data;
  const commitOrder = () => {
    const ids = order.map((s) => s.id);
    if (ids.join() !== data.sources.map((s) => s.id).join()) actions.reorder.mutate(ids);
  };
  /** Move up or Move down, from a source's ⋯: one place, as dragging it there would. */
  const move = (from: number, by: -1 | 1) => {
    const next = [...order];
    const [moved] = next.splice(from, 1);
    next.splice(from + by, 0, moved!);
    setOrder(next);
    actions.reorder.mutate(next.map((s) => s.id));
  };

  return (
    <section>
      <p className="mb-6 max-w-prose type-small text-muted">
        Where your music comes from. When a song is in more than one place, Playarr plays the best-quality copy; between equal
        copies, the source higher in this list wins.
      </p>
      {!canEdit && <AwayNotice />}
      {data.sources.length === 0 && (
        <p className="mb-6 type-body text-paper-dim">No sources yet. Add Lidarr or a folder to start your library.</p>
      )}

      <Reorder.Group axis="y" values={order} onReorder={setOrder} as="ol" className="-mx-2">
        {order.map((s, i) => (
          <SourceRow
            key={s.id}
            source={s}
            canEdit={canEdit}
            onDragEnd={commitOrder}
            onMove={i > 0 || i < order.length - 1 ? (by) => move(i, by) : undefined}
            first={i === 0}
            last={i === order.length - 1}
            onEdit={() => setEditing(s)}
            onReview={() => setReviewing(s.id)}
            onOrganize={() => setOrganizing(s.id)}
          />
        ))}
      </Reorder.Group>

      {canEdit && (
        <Button icon={<Plus />} onClick={() => setEditing('new')} className="mt-6">
          Add source
        </Button>
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

/**
 * A source, stacked so nothing is cut short on a phone: its name, where it is (wrapping, however long), how many songs
 * and albums, how complete they are, how it's doing, and how its songs were matched. What can be done with it is in its
 * ⋯, in words: Sync now, Match again, Organize files, Edit, Move up or down, Remove. Dragged by its handle with a
 * pointer; the menu moves it from the keyboard.
 */
function SourceRow({
  source: s,
  canEdit,
  onDragEnd,
  onMove,
  first,
  last,
  onEdit,
  onReview,
  onOrganize,
}: {
  source: SourceInfo;
  canEdit: boolean;
  onDragEnd: () => void;
  onMove?: (by: -1 | 1) => void;
  first: boolean;
  last: boolean;
  onEdit: () => void;
  onReview: () => void;
  onOrganize: () => void;
}) {
  const controls = useDragControls();
  const actions = useSourceActions();
  const [removing, setRemoving] = useState(false);
  const remote = s.kind === 'folder' && !!s.settings?.access && s.settings.access !== 'local';
  const where = !remote
    ? (s.settings?.url ?? s.settings?.path)
    : s.settings!.access === 'smb'
      ? `smb://${s.settings!.user}@${s.settings!.host}${s.settings!.path}`
      : `${s.settings!.user}@${s.settings!.host}:${s.settings!.path}`;
  const menu: MenuEntry[] = [
    // While it syncs, the line under it says so.
    ...(s.syncing ? [] : [{ label: 'Sync now', icon: RefreshCw, onSelect: () => actions.rescan.mutate(s.id) }]),
    ...(s.kind === 'folder'
      ? [
          { label: 'Match again', icon: ScanSearch, onSelect: () => actions.rematch.mutate(s.id) },
          // Offered even when the folder isn't writable: the dialog explains why nothing can move.
          { label: 'Organize files', icon: FolderTree, onSelect: onOrganize },
        ]
      : []),
    { label: 'Edit', icon: Pencil, onSelect: onEdit },
    DIVIDER,
    ...(onMove && !first ? [{ label: 'Move up', icon: ArrowUp, onSelect: () => onMove(-1) }] : []),
    ...(onMove && !last ? [{ label: 'Move down', icon: ArrowDown, onSelect: () => onMove(1) }] : []),
    DIVIDER,
    { label: 'Remove', icon: X, onSelect: () => setRemoving(true) },
  ];

  return (
    <Reorder.Item
      value={s}
      dragListener={false}
      dragControls={controls}
      onDragEnd={onDragEnd}
      as="li"
      className="flex items-start gap-3 rounded-lg bg-ink-900 px-2 py-3"
    >
      {canEdit && (
        // For a pointer only: Move up and Move down in ⋯ do the same from the keyboard.
        <span
          aria-hidden
          title="Drag to reorder"
          onPointerDown={(e) => controls.start(e)}
          className="-mr-1 grid h-11 w-6 shrink-0 cursor-grab touch-none place-items-center text-muted active:cursor-grabbing"
        >
          <GripVertical className="size-4" />
        </span>
      )}
      <span className="grid size-11 shrink-0 place-items-center rounded-md bg-ink-800 text-accent">
        {remote ? <Network className="size-5" /> : s.kind === 'folder' ? <FolderOpen className="size-5" /> : <Server className="size-5" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1 pt-0.5">
            <span className="type-body break-words text-paper">{s.name}</span>
            {!s.enabled && <span className="ml-2 type-badge text-muted">Off</span>}
          </div>
          {canEdit && <Menu label={`More for ${s.name}`} items={menu} className="-my-1.5 -mr-1" />}
        </div>
        {where && <div className="type-meta break-all text-muted">{where}</div>}
        <div className="mt-0.5 type-small text-paper-dim">
          {plural(s.songs, 'song')} · {plural(s.albums, 'album')}
        </div>
        <AlbumSummary source={s} />
        <SourceStatus source={s} />
        {s.kind === 'folder' && <MatchSummary source={s} canEdit={canEdit} onReview={onReview} />}
      </div>
      <ConfirmDialog
        open={removing}
        onClose={() => setRemoving(false)}
        title={`Remove “${s.name}”?`}
        confirmLabel="Remove"
        pendingLabel="Removing…"
        pending={actions.remove.isPending}
        onConfirm={() => actions.remove.mutate(s.id, { onSettled: () => setRemoving(false) })}
      >
        <p>
          {s.songs === 1 ? 'Its song leaves' : `Its ${plural(s.songs, 'song')} leave`} your library; playlists and Favorites keep them in their place,
          grayed out. The files themselves aren’t touched, and adding the source again brings them back.
        </p>
      </ConfirmDialog>
    </Reorder.Item>
  );
}

/**
 * How much of its albums a source has: complete, incomplete, or unidentified (their length unknown). Lidarr
 * counts albums; a folder counts its songs, adding up to all of them, its songs not matched yet unidentified.
 */
export function AlbumSummary({ source: s }: { source: SourceInfo }) {
  if (!s.albums) return null;
  const counters =
    s.kind === 'folder'
      ? ([
          [s.songsComplete, 'On complete albums', 'On complete albums'],
          [s.songsIncomplete, 'On incomplete albums', 'On incomplete albums'],
          [s.songsUnknown, 'Unidentified', 'Unidentified'],
        ] as const)
      : ([
          [s.albumsComplete, 'Complete album', 'Complete albums'],
          [s.albumsIncomplete, 'Incomplete album', 'Incomplete albums'],
          [s.albumsUnknown, 'Unidentified', 'Unidentified'],
        ] as const);
  return (
    // One line that wraps between counters, never inside one: "On complete albums" doesn't break word by word.
    <ul className="mt-2 flex flex-wrap gap-2" aria-label={s.kind === 'folder' ? 'Songs' : 'Albums'}>
      {counters.map(([n, one, many]) => (
        <li key={one} className="flex items-baseline gap-1.5 rounded-md bg-ink-800 px-2 py-1 whitespace-nowrap">
          <span className="type-meta text-paper">{n}</span>
          <span className="type-small text-paper-dim">{n === 1 ? one : many}</span>
        </li>
      ))}
    </ul>
  );
}

/** How a folder's songs were matched: those not matched open the review, to match them by hand. */
export function MatchSummary({ source: s, canEdit, onReview }: { source: SourceInfo; canEdit: boolean; onReview: () => void }) {
  if (!s.matched && !s.review && !s.ignored) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 type-small text-paper-dim">
      <span>{plural(s.matched, 'song')} matched</span>
      {s.review > 0 && (
        <>
          <span aria-hidden="true">·</span>
          {canEdit ? (
            <button type="button" onClick={onReview} className="text-accent hover:underline" title="Match them by hand">
              {s.review} not matched
            </button>
          ) : (
            <span>{s.review} not matched</span>
          )}
        </>
      )}
      {s.ignored > 0 && (
        <>
          <span aria-hidden="true">·</span>
          <span>{s.ignored} left as tagged</span>
        </>
      )}
    </div>
  );
}

function SourceStatus({ source: s }: { source: SourceInfo }) {
  const [text, tone] = s.syncing
    ? ['Syncing…', 'text-accent']
    : s.matching > 0
      ? // Each album takes a few MusicBrainz lookups at about one per second.
        [`Matching… ${plural(s.matching, 'album')} left · about ${formatWait(s.matching * 3.3)}`, 'text-accent']
      : s.error
        ? [s.error, 'text-danger']
        : !s.enabled
          ? ['Turned off', 'text-muted']
          : s.lastSyncAt
            ? [`Synced ${new Date(s.lastSyncAt).toLocaleString()}`, 'text-muted']
            : ['Not synced yet', 'text-muted'];
  return (
    <div className={cn('mt-1 type-small break-words', tone)}>{text}</div>
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
      <h2 className="mb-2 type-kicker text-muted">Identifying songs</h2>
      <p className="mb-4 type-small text-muted">
        Playarr matches folder albums on MusicBrainz by their names, song titles and lengths. For songs whose names don’t help,
        it can identify them by their sound with AcoustID. A free key comes from{' '}
        <a href="https://acoustid.org/new-application" target="_blank" rel="noreferrer" className="text-accent hover:underline">
          acoustid.org
        </a>
        .
      </p>
      {!data.fingerprints && (
        <p className="mb-4 type-small text-paper-dim">Fingerprints need fpcalc (Chromaprint) on the server. The Docker image includes it.</p>
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
          className="flex items-center gap-2"
        >
          <TextField
            label="AcoustID key"
            hideLabel
            mono
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="AcoustID application key"
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1"
          />
          <Button type="submit" variant="primary" disabled={!key} pending={save.isPending} pendingLabel="Saving…">
            Save
          </Button>
        </form>
      ) : (
        <div className="flex items-center gap-3 type-body">
          <span className="font-mono text-paper-dim">AcoustID key saved</span>
          <button type="button" onClick={() => setReplacing(true)} className="text-accent hover:underline">
            Replace
          </button>
        </div>
      )}
    </section>
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
        <span className="block type-body text-paper">{title}</span>
        <span className="block type-small text-muted">{detail}</span>
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
      <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
      <TextField label="URL" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://192.168.1.10:8686" required />
      {replacingKey ? (
        <TextField
          label="API key"
          hint="In Lidarr: Settings → General → Security"
          mono
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          required={!keySaved}
          placeholder={keySaved ? 'New API key' : undefined}
        />
      ) : (
        <Saved label="API key" hint="In Lidarr: Settings → General → Security" onReplace={() => setReplacingKey(true)} />
      )}
      {source && (
        <label className="flex items-center gap-2 type-small text-paper-dim">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Use this source
        </label>
      )}
      {test === 'running' && (
        <p className="flex items-center gap-2 type-small text-muted">
          <Loader2 className="size-4 animate-spin" /> Connecting…
        </p>
      )}
      {test && test !== 'running' && (
        <p className={cn('flex items-center gap-2 type-small', test.ok ? 'text-success' : 'text-danger')}>
          {test.ok ? <Check className="size-4" /> : <TriangleAlert className="size-4" />}
          {test.ok ? `Connected to Lidarr ${test.version ?? ''}` : test.error}
        </p>
      )}
      <div className="flex justify-end gap-2 pt-2">
        <Button onClick={runTest} disabled={!url} pending={test === 'running'} pendingLabel="Testing…">
          Test
        </Button>
        <Button type="submit" variant="primary" pending={pending} pendingLabel="Saving…">
          Save
        </Button>
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
      <Choice
        label="Where the folder is"
        options={ACCESS.map((a) => {
          const off = a.id === 'smb' && smbOff && savedAccess !== 'smb';
          return { value: a.id, label: a.label, disabled: off, title: off ? SMB_OFF : undefined };
        })}
        value={access}
        onChange={chooseAccess}
      />
      {smb && smbOff && <InlineError error={`${SMB_OFF}.`} />}
      {remote && (
        <div className="space-y-4">
          <div className="flex gap-3">
            <TextField
              label="Host"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="192.168.1.10"
              autoComplete="off"
              spellCheck={false}
              required
              className="min-w-0 flex-1"
            />
            <TextField
              label="Port"
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={(e) => setPort(Number(e.target.value) || defaultPort(access))}
              required
              className="w-28 shrink-0"
            />
          </div>
          <TextField
            label="User"
            hint={smb ? 'guest for guest access' : undefined}
            value={user}
            onChange={(e) => setUser(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
          />
          {replacingPassword ? (
            <TextField
              label="Password"
              hint={smb ? 'Leave empty for guest access' : 'Optional with a key file or ssh-agent'}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              placeholder={passwordSaved ? 'New password' : undefined}
            />
          ) : (
            <Saved
              label="Password"
              hint={smb ? 'Leave empty for guest access' : 'Optional with a key file or ssh-agent'}
              onReplace={() => setReplacingPassword(true)}
            />
          )}
          {smb ? (
            <TextField
              label="Domain"
              hint="Optional"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="WORKGROUP"
              autoComplete="off"
              spellCheck={false}
              maxLength={100}
            />
          ) : (
            <TextField
              label="Key file on the server"
              hint="Optional: a private key on the Playarr server"
              mono
              value={keyPath}
              onChange={(e) => setKeyPath(e.target.value)}
              placeholder="~/.ssh/id_ed25519"
              autoComplete="off"
              spellCheck={false}
            />
          )}
          <div className="flex items-center justify-between gap-3">
            <p className="type-small text-muted">
              {smb
                ? 'Playarr reads the share with rclone. Song analysis and fingerprints run on this server.'
                : 'SSH also runs song analysis and fingerprints on that machine. SFTP only reads files.'}
            </p>
            <Button onClick={connect} disabled={!host.trim() || !user.trim()}>
              Connect
            </Button>
          </div>
        </div>
      )}
      {(!remote || browsing) && (
        <div>
          <span className="mb-1.5 block type-small text-muted">Folder</span>
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
      <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder={path?.split('/').pop() || 'Music'} maxLength={80} />
      {source && (
        <label className="flex items-center gap-2 type-small text-paper-dim">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Use this source
        </label>
      )}
      <p className="type-small text-muted">Playarr only reads this folder. Songs appear after the first scan.</p>
      <div className="flex justify-end pt-2">
        <Button type="submit" variant="primary" disabled={!pathOk} pending={pending} pendingLabel="Saving…">
          Save
        </Button>
      </div>
    </form>
  );
}

/** A secret the server keeps (an API key, a password): never shown, only replaced. */
function Saved({ label, hint, onReplace }: { label: string; hint?: string; onReplace: () => void }) {
  return (
    <div>
      <span className="mb-1.5 block type-small text-muted">{label}</span>
      <div className="flex h-11 items-center gap-3">
        <span className="type-meta text-paper-dim">Saved</span>
        <button type="button" onClick={onReplace} className="type-small text-accent hover:underline">
          Replace
        </button>
      </div>
      {hint && <span className="mt-1.5 block type-small text-muted">{hint}</span>}
    </div>
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
  const { data, error, isFetching, refetch } = useFolderListing({ ...request, path: at });
  const remote = !!request.connection && request.connection.access !== 'local';
  // On this server, "up" from a root goes back to the list of roots; on another machine, "/" is the top.
  const canGoUp = data && data.path !== null && (data.parent !== null || !remote);
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2 type-meta text-paper-dim">
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
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left type-body text-paper hover:bg-paper/5"
            >
              <Folder className="size-4 shrink-0 text-muted" />
              <span className="truncate">{f.name}</span>
            </button>
          </li>
        ))}
        {data && data.folders.length === 0 && !data.emptyRoot && (
          <li className="px-3 py-2 type-small text-muted">{rootLabel && data.path === '/' ? 'No shares found.' : 'No folders inside.'}</li>
        )}
        {data?.emptyRoot && (
          <li className="space-y-1.5 px-3 py-2 type-small text-muted">
            <p className="text-paper-dim">Nothing is shared with Playarr at {data.path} yet.</p>
            <p>
              In Docker, Playarr only sees the host folders you mount inside {data.path}. Mount them read-only in a compose.override.yaml
              next to compose.yaml, for example <code className="type-meta text-paper-dim">/volume2:{data.path}/volume2:ro</code>,
              then restart Playarr.
            </p>
          </li>
        )}
      </ul>
      {error && <InlineError error={error} onRetry={() => void refetch()} retrying={isFetching} className="px-3 py-2" />}
      {data?.path && !(rootLabel && data.path === '/') && (
        <div className="flex items-center justify-between gap-3 border-t border-line px-3 py-2">
          <span className="type-small text-muted">
            {plural(data.audioFiles, 'audio file')} here{value === data.path ? ' · selected' : ''}
          </span>
          <button type="button" onClick={() => onChange(data.path!)} className="type-small text-accent hover:underline">
            Use this folder
          </button>
        </div>
      )}
    </div>
  );
}
