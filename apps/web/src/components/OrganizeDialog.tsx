import type { OrganizeMove } from '@playarr/shared';
import { ArrowRight, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { plural } from '../lib/format';
import { useOrganizeActions, useOrganizePlan } from '../lib/queries';
import { Dialog } from './Dialog';

/** Settings → Sources → Organize files: review proposed moves, apply some or all, undo. */
export function OrganizeDialog({ sourceId, onClose }: { sourceId: number | null; onClose: () => void }) {
  const { data: plan, isPending } = useOrganizePlan(sourceId);
  return (
    <Dialog open={sourceId !== null} onClose={onClose} title="Organize files" wide>
      {isPending || !plan ? (
        <div className="m-5 h-40 animate-pulse rounded-lg bg-paper/5" />
      ) : (
        <OrganizeBody key={sourceId} sourceId={sourceId!} moves={plan.moves} skipped={plan.skipped} writable={plan.writable} lastBatch={plan.lastBatch} />
      )}
    </Dialog>
  );
}

function OrganizeBody({
  sourceId,
  moves,
  skipped,
  writable,
  lastBatch,
}: {
  sourceId: number;
  moves: OrganizeMove[];
  skipped: { from: string; to?: string; reason: string }[];
  writable: boolean;
  lastBatch?: { id: number; files: number; at: string };
}) {
  const actions = useOrganizeActions(sourceId);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  useEffect(() => setChosen(new Set(moves.filter((m) => m.confident).map((m) => m.from))), [moves]);
  const albums = useMemo(() => {
    const groups = new Map<string, OrganizeMove[]>();
    for (const m of moves) {
      const key = `${m.artist} · ${m.album ?? 'No album'}`;
      groups.set(key, [...(groups.get(key) ?? []), m]);
    }
    return [...groups];
  }, [moves]);
  const toggle = (from: string) =>
    setChosen((s) => {
      const next = new Set(s);
      if (next.has(from)) next.delete(from);
      else next.add(from);
      return next;
    });

  if (!writable) {
    return (
      <p className="p-5 text-[15px] text-paper-dim">
        Playarr can’t write to this folder, so it can’t move files. In Docker, mount the folder you want organized read-write
        (the broad /host mount stays read-only).
      </p>
    );
  }

  return (
    <div className="space-y-5 p-5">
      <p className="text-sm text-muted">
        Files move into Artist/Album/NN Title, inside this folder only. Nothing is overwritten, tags aren’t changed, and you can
        undo. Moves Playarr is less sure about start unchecked.
      </p>
      {lastBatch && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-line px-4 py-3 text-sm">
          <span className="text-paper-dim">
            Last change: {plural(lastBatch.files, 'file')} moved {new Date(lastBatch.at).toLocaleString()}
          </span>
          <button
            type="button"
            disabled={actions.undo.isPending}
            onClick={() => actions.undo.mutate(lastBatch.id)}
            className="inline-flex items-center gap-1.5 text-accent hover:underline disabled:opacity-50"
          >
            <Undo2 className="size-4" /> Undo
          </button>
        </div>
      )}
      {moves.length === 0 ? (
        <p className="text-[15px] text-paper-dim">Everything is already where it belongs.</p>
      ) : (
        <>
          <div className="flex items-center justify-between text-[13px] text-muted">
            <span>
              {chosen.size} of {plural(moves.length, 'move')} selected
            </span>
            <span className="flex gap-3">
              <button type="button" onClick={() => setChosen(new Set(moves.map((m) => m.from)))} className="text-accent hover:underline">
                All
              </button>
              <button type="button" onClick={() => setChosen(new Set())} className="text-accent hover:underline">
                None
              </button>
            </span>
          </div>
          <div className="max-h-[50dvh] space-y-5 overflow-y-auto pr-1">
            {albums.map(([title, list]) => (
              <section key={title}>
                <h3 className="mb-1.5 font-mono text-[11px] tracking-[0.15em] text-muted uppercase">{title}</h3>
                <ul className="space-y-0.5">
                  {list.map((m) => (
                    <li key={m.from}>
                      <label className="flex cursor-pointer items-start gap-3 rounded-md px-2 py-1.5 hover:bg-paper/[0.03]">
                        <input type="checkbox" checked={chosen.has(m.from)} onChange={() => toggle(m.from)} className="mt-1" />
                        <span className="min-w-0 flex-1 font-mono text-[12px] leading-relaxed">
                          <span className="block truncate text-muted" title={m.from}>{m.from}</span>
                          <span className="flex items-center gap-1.5 truncate text-paper" title={m.to}>
                            <ArrowRight className="size-3 shrink-0 text-accent" />
                            {m.to}
                          </span>
                        </span>
                        {!m.confident && <span className="shrink-0 font-mono text-[10px] tracking-wider text-muted uppercase">Guess</span>}
                      </label>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </>
      )}
      {skipped.length > 0 && (
        <details className="text-[13px] text-muted">
          <summary className="cursor-pointer">{plural(skipped.length, 'file')} can’t move</summary>
          <ul className="mt-2 space-y-1 font-mono text-[12px]">
            {skipped.map((s) => (
              <li key={s.from}>
                {s.from} · <span className="text-paper-dim">{s.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {moves.length > 0 && (
        <div className="flex justify-end border-t border-line pt-4">
          <button
            type="button"
            disabled={chosen.size === 0 || actions.apply.isPending}
            onClick={() => actions.apply.mutate([...chosen])}
            className="inline-flex h-10 items-center rounded-full bg-accent px-5 text-[14px] font-medium text-accent-ink disabled:opacity-50"
          >
            {actions.apply.isPending ? 'Moving…' : `Move ${plural(chosen.size, 'file')}`}
          </button>
        </div>
      )}
    </div>
  );
}
