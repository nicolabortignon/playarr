import type { SourceInfo, SourceTestResult } from '@playarr/shared';
import { Check, Folder, FolderOpen, GripVertical, Loader2, Pencil, Plus, RefreshCw, Server, Trash2, TriangleAlert } from 'lucide-react';
import { Reorder, useDragControls } from 'motion/react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../lib/api';
import { cn } from '../lib/cn';
import { plural } from '../lib/format';
import { useFolders, useSourceActions, useSources } from '../lib/queries';
import { Dialog } from './Dialog';

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
        <p className="mb-6 rounded-lg border border-line px-4 py-3 text-sm text-paper-dim">
          You’re using Playarr from outside your home network, so settings are read-only.
        </p>
      )}
      {data.sources.length === 0 && (
        <p className="mb-6 text-[15px] text-paper-dim">No sources yet. Add Lidarr or a folder to start your library.</p>
      )}

      <Reorder.Group axis="y" values={order} onReorder={setOrder} as="ol" className="-mx-2">
        {order.map((s) => (
          <SourceRow key={s.id} source={s} canEdit={canEdit} onDragEnd={commitOrder} onEdit={() => setEditing(s)} />
        ))}
      </Reorder.Group>

      {canEdit && (
        <button type="button" onClick={() => setEditing('new')} className={cn(SECONDARY, 'mt-6')}>
          <Plus className="size-4" /> Add source
        </button>
      )}

      <SourceDialog
        target={editing}
        hasLidarr={data.sources.some((s) => s.kind === 'lidarr')}
        onClose={() => setEditing(null)}
      />
    </section>
  );
}

function SourceRow({
  source: s,
  canEdit,
  onDragEnd,
  onEdit,
}: {
  source: SourceInfo;
  canEdit: boolean;
  onDragEnd: () => void;
  onEdit: () => void;
}) {
  const controls = useDragControls();
  const actions = useSourceActions();
  const remove = () => {
    if (window.confirm(`Remove “${s.name}”? Its songs leave your library; favorites and playlists keep them, greyed out.`)) {
      actions.remove.mutate(s.id);
    }
  };
  const details = [s.settings?.url ?? s.settings?.path, `${plural(s.songs, 'song')} · ${plural(s.albums, 'album')}`].filter(Boolean).join(' · ');

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
        {s.kind === 'folder' ? <FolderOpen className="size-5" /> : <Server className="size-5" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[17px] text-paper">{s.name}</span>
          {!s.enabled && <span className="font-mono text-[10px] tracking-wider text-muted uppercase">Off</span>}
        </div>
        <div className="truncate font-mono text-[12px] text-muted">{details}</div>
        <SourceStatus source={s} />
      </div>
      {canEdit && (
        <div className="flex items-center gap-1">
          <IconButton label="Rescan" onClick={() => actions.rescan.mutate(s.id)} disabled={s.syncing}>
            {s.syncing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          </IconButton>
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
            detail="Music in a folder on this server. Playarr only reads it."
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

function FolderForm({ source, onDone }: { source?: SourceInfo; onDone: () => void }) {
  const actions = useSourceActions();
  const [name, setName] = useState(source?.name ?? '');
  const [path, setPath] = useState<string | undefined>(source?.settings?.path);
  const [enabled, setEnabled] = useState(source?.enabled ?? true);
  const pending = actions.add.isPending || actions.update.isPending;

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!path) return;
    const input = { name: name.trim() || undefined, enabled, settings: { path } };
    if (source) actions.update.mutate({ id: source.id, input }, { onSuccess: onDone });
    else actions.add.mutate({ kind: 'folder', ...input }, { onSuccess: onDone });
  };

  return (
    <form onSubmit={save} className="space-y-4 p-5">
      <div>
        <span className="mb-1.5 block font-mono text-[11px] tracking-[0.2em] text-muted uppercase">Folder</span>
        <FolderBrowser value={path} onChange={setPath} />
      </div>
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
        <button type="submit" disabled={!path || pending} className={PRIMARY}>
          {pending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

function FolderBrowser({ value, onChange }: { value?: string; onChange: (path: string) => void }) {
  const [at, setAt] = useState<string | undefined>(value);
  const { data, error } = useFolders(at);
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2 font-mono text-[12px] text-paper-dim">
        {data && data.path !== null && (
          <button
            type="button"
            onClick={() => setAt(data.parent ?? undefined)}
            className="rounded px-1.5 text-muted hover:bg-paper/8 hover:text-paper"
            aria-label="Up one folder"
          >
            ..
          </button>
        )}
        <span className="truncate">{data?.path ?? 'Folders Playarr may use'}</span>
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
        {data && data.folders.length === 0 && <li className="px-3 py-2 text-[13px] text-muted">No folders inside.</li>}
      </ul>
      {error && <p className="px-3 py-2 text-[13px] text-red-300/80">{(error as Error).message}</p>}
      {data?.path && (
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

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block font-mono text-[11px] tracking-[0.2em] text-muted uppercase">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[12px] text-muted">{hint}</span>}
    </label>
  );
}
