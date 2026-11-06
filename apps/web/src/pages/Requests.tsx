import type { AlbumRequest } from '@playarr/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Download, Search, Settings, X } from 'lucide-react';
import { Link } from 'react-router';
import { create } from 'zustand';
import { IconButton } from '../components/Button';
import { Cover } from '../components/Cover';
import { RequestButton } from '../components/Discover';
import { PageHeader } from '../components/PageHeader';
import { EmptyState, ErrorState, Skeleton } from '../components/States';
import { api } from '../lib/api';
import { useHealth, useMe, useRequests, useRequestsEnabled } from '../lib/queries';
import { toast, toastWithUndo } from '../lib/toast';

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

function ago(iso: string) {
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return 'just now';
}

/**
 * Requests taken off the list whose Undo hasn't gone yet: they're hidden, and forgotten by the server only once it
 * has. Asking Lidarr again couldn't bring one back (an album that has arrived can't be requested), so the removal waits.
 */
const useRemoving = create<{ mbids: ReadonlySet<string> }>()(() => ({ mbids: new Set() }));
const setRemoving = (mbid: string, removing: boolean) =>
  useRemoving.setState((s) => {
    const mbids = new Set(s.mbids);
    if (removing) mbids.add(mbid);
    else mbids.delete(mbid);
    return { mbids };
  });

export function RequestsPage() {
  const { data, error, isPending, refetch } = useRequests();
  const { data: health, isError: noHealth } = useHealth();
  const removing = useRemoving((s) => s.mbids);
  const requests = data?.filter((r) => !removing.has(r.mbid));
  // What's possible is known once health has answered (unknown, as before: Lidarr is assumed).
  const known = !!health || noHealth;
  const lidarr = health ? health.lidarr !== undefined : noHealth;

  return (
    <div className="max-w-4xl px-5 pt-8 md:px-10 md:pt-14">
      <PageHeader
        title="Requests"
        count={requests?.length || undefined}
        description={lidarr && 'Albums you asked Lidarr to find. Progress updates live; finished albums land in your library automatically.'}
      />
      {error && <ErrorState error={error} onRetry={() => void refetch()} />}
      {(isPending || (requests && !requests.length && !known)) && <RequestSkeletons />}
      {requests && !requests.length && known && <NoRequests lidarr={lidarr} />}
      <ol className="space-y-2">
        {requests?.map((r) => (
          <RequestRow key={r.mbid} request={r} />
        ))}
      </ol>
    </div>
  );
}

/**
 * Nothing requested: what's possible on this server. With Lidarr and requests on, how to ask for an album; without
 * Lidarr, or with requests off, why there's no Request button anywhere, and for an admin, where to change that.
 */
function NoRequests({ lidarr }: { lidarr: boolean }) {
  const enabled = useRequestsEnabled();
  const { data: me, isPending } = useMe();
  if (lidarr && enabled) {
    return (
      <EmptyState
        icon={Download}
        title="Ask for an album you don’t have."
        hint="Search for it and press Request: it lands in your library once Lidarr finds it."
        action={{ label: 'Search', icon: <Search />, to: '/search' }}
      />
    );
  }
  // Why there's no Request button depends on who's asking, and so does what to do about it: wait to know.
  if (isPending) return <RequestSkeletons />;
  // Before the server is set up there are no accounts: whoever is here can change its settings.
  const admin = me?.role !== 'member';
  if (!lidarr) {
    return admin ? (
      <EmptyState
        icon={Download}
        title="Requests need a Lidarr source."
        hint="Add one, and you can ask Lidarr for albums you don’t have, right from Search."
        action={{ label: 'Add Lidarr', icon: <Settings />, to: '/settings/sources' }}
      />
    ) : (
      <EmptyState icon={Download} title="Requests aren’t set up on this server." hint="They need a Lidarr source, which an admin can add." />
    );
  }
  if (me && !me.canRequest) {
    return <EmptyState icon={Download} title="Your account can’t request albums." hint={admin ? 'Allow it for yourself in Settings → Accounts.' : 'An admin can allow it.'} />;
  }
  return admin ? (
    <EmptyState
      icon={Download}
      title="Requests are turned off."
      hint="Nobody can ask Lidarr for albums until they’re on again."
      action={{ label: 'Turn them on', icon: <Settings />, to: '/settings/requests' }}
    />
  ) : (
    <EmptyState icon={Download} title="Requests are turned off on this server." hint="An admin can turn them on." />
  );
}

/** Rows shaped like requests (cover, title, artist, status) while the list, or what to say about an empty one, loads. */
function RequestSkeletons() {
  return (
    <div className="space-y-2" aria-busy aria-label="Loading requests">
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} aria-hidden className="flex items-center gap-4 rounded-lg border border-line p-3 pr-4">
          <Skeleton className="size-16 shrink-0 rounded-cover" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-2/5" />
            <Skeleton className="h-3 w-1/4" />
            <Skeleton className="h-2.5 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

function RequestRow({ request: r }: { request: AlbumRequest }) {
  const client = useQueryClient();
  // Removing needs the same permission as requesting: the server refuses it otherwise.
  const canRemove = useRequestsEnabled();
  const { state, progress, message, albumId } = r.availability;
  /** Off the list at once, with Undo; the server forgets it once the Undo has gone. */
  const remove = () => {
    setRemoving(r.mbid, true);
    toastWithUndo(
      `Removed “${r.title}” from Requests`,
      () => setRemoving(r.mbid, false),
      () =>
        void api
          .removeRequest(r.mbid)
          .catch((err: Error) => toast(err.message, 'error'))
          .finally(() => {
            void client.invalidateQueries({ queryKey: ['requests'] }).then(() => setRemoving(r.mbid, false));
          }),
    );
  };
  const body = (
    <>
      <Cover src={r.coverUrl} size={64} alt="" label={r.title} className="size-16 shrink-0 rounded-cover" />
      <div className="min-w-0 flex-1">
        <div className="truncate type-body text-paper">{r.title}</div>
        <div className="truncate type-small text-muted">{r.artistName}</div>
        <div className="mt-1 truncate font-mono text-[11px] text-muted">
          {message ?? (state === 'available' ? 'Ready to play' : state)} · requested {ago(r.requestedAt)}
        </div>
        {state === 'downloading' && (
          <div className="mt-2 h-[3px] w-full max-w-xs overflow-hidden rounded-full bg-paper/10">
            <div className="h-full rounded-full bg-accent transition-[width] duration-700" style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
          </div>
        )}
      </div>
    </>
  );

  return (
    <li className="group flex items-center gap-4 rounded-lg border border-line bg-paper/[0.02] p-3 pr-4">
      {state === 'available' && albumId ? (
        <Link to={`/albums/${albumId}`} className="flex min-w-0 flex-1 items-center gap-4">
          {body}
        </Link>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-4">{body}</div>
      )}
      <RequestButton album={{ mbid: r.mbid, artistName: r.artistName, albumTitle: r.title }} availability={r.availability} />
      {canRemove && (
        <IconButton
          label={`Remove ${r.title} from this list`}
          title="Remove from this list (doesn’t change Lidarr)"
          onClick={remove}
          className="pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:focus-visible:opacity-100"
        >
          <X className="size-4" />
        </IconButton>
      )}
    </li>
  );
}
