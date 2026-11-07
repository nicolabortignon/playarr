import type { AlbumRequest } from '@playarr/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Binoculars, Check, Search, Settings, X } from 'lucide-react';
import { Link } from 'react-router';
import { create } from 'zustand';
import { Button, IconButton } from '../components/Button';
import { Cover } from '../components/Cover';
import { RequestButton } from '../components/Discover';
import { PageHeader } from '../components/PageHeader';
import { EmptyState, ErrorState, Skeleton } from '../components/States';
import { api } from '../lib/api';
import { cn } from '../lib/cn';
import { useAnswerRequest, useHealth, useMe, useRequests, useRequestsEnabled, useSeeRequests } from '../lib/queries';
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

/** "Sam", "Sam and Zoe", "you, Sam and Zoe". */
function names(list: string[]): string {
  return list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : (list[0] ?? '');
}

/**
 * When it was asked for, and for an admin by whom: "requested 2 hours ago", "requested by Sam yesterday", "requested by
 * you and Sam just now". An admin's own, asked by nobody else, needs no name.
 */
function requestedLine(r: AlbumRequest): string {
  const others = r.askedBy ?? [];
  const who = others.length && r.mine ? ['you', ...others] : others;
  return who.length ? `requested by ${names(who)} ${ago(r.requestedAt)}` : `requested ${ago(r.requestedAt)}`;
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
  const { data: me } = useMe();
  const removing = useRemoving((s) => s.mbids);
  const requests = data?.filter((r) => !removing.has(r.mbid));
  // On screen, what arrived or was declined has been seen; it stays marked as new while the page is open.
  const fresh = useSeeRequests(requests);
  // What's possible is known once health has answered (unknown, as before: Lidarr is assumed).
  const known = !!health || noHealth;
  const lidarr = health ? health.lidarr !== undefined : noHealth;
  const admin = me?.role === 'admin';

  return (
    <div className="max-w-4xl px-5 pt-8 md:px-10 md:pt-14">
      <PageHeader
        title="Requests"
        count={requests?.length || undefined}
        description={
          lidarr &&
          (admin
            ? 'Albums anyone here asked Lidarr to find, those waiting for your approval first. Progress updates live; finished albums land in the library automatically.'
            : me?.requestAccess === 'ask'
              ? 'Albums you asked Lidarr to find. An admin approves each one first; progress updates live, and finished albums land in your library automatically.'
              : 'Albums you asked Lidarr to find. Progress updates live; finished albums land in your library automatically.')
        }
      />
      {error && <ErrorState error={error} onRetry={() => void refetch()} />}
      {(isPending || (requests && !requests.length && !known)) && <RequestSkeletons />}
      {requests && !requests.length && known && <NoRequests lidarr={lidarr} />}
      <ol className="space-y-2">
        {requests?.map((r) => (
          <RequestRow key={r.mbid} request={r} admin={admin} fresh={fresh.has(r.mbid)} />
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
        icon={Binoculars}
        title="Ask for an album you don’t have."
        hint={
          me?.requestAccess === 'ask'
            ? 'Search for it and press Request: once an admin approves it, it lands in your library when Lidarr finds it.'
            : 'Search for it and press Request: it lands in your library once Lidarr finds it.'
        }
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
        icon={Binoculars}
        title="Requests need a Lidarr source."
        hint="Add one, and you can ask Lidarr for albums you don’t have, right from Search."
        action={{ label: 'Add Lidarr', icon: <Settings />, to: '/settings/sources' }}
      />
    ) : (
      <EmptyState icon={Binoculars} title="Requests aren’t set up on this server." hint="They need a Lidarr source, which an admin can add." />
    );
  }
  if (me && !me.canRequest) {
    return <EmptyState icon={Binoculars} title="Your account can’t request albums." hint={admin ? 'Allow it for yourself in Settings → Accounts.' : 'An admin can allow it.'} />;
  }
  return admin ? (
    <EmptyState
      icon={Binoculars}
      title="Requests are turned off."
      hint="Nobody can ask Lidarr for albums until they’re on again."
      action={{ label: 'Turn them on', icon: <Settings />, to: '/settings/requests' }}
    />
  ) : (
    <EmptyState icon={Binoculars} title="Requests are turned off on this server." hint="An admin can turn them on." />
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

/**
 * One request: its cover, title (marked when it's news: arrived or declined since the last look), artist, how it's going
 * and when it was asked for (and by whom, for an admin). What it offers: for an admin, Approve and Decline while it waits
 * for an answer; once declined, Remove; otherwise the album's own control (Pending, Searching, In library…).
 */
function RequestRow({ request: r, admin, fresh }: { request: AlbumRequest; admin: boolean; fresh: boolean }) {
  const client = useQueryClient();
  // Removing needs the same permission as requesting: the server refuses it otherwise.
  const canRemove = useRequestsEnabled();
  const answer = useAnswerRequest();
  const { state, progress, message, albumId } = r.availability;
  const waiting = r.approval === 'waiting';
  const declined = r.approval === 'declined';
  // An admin's Approve and Decline: under the album on a phone, where the two don't fit beside it.
  const answers = admin && waiting;
  const answering = (yes: boolean) => answer.isPending && answer.variables?.yes === yes;
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
        <div className="flex items-center gap-2">
          {(r.unseen || fresh) && <span role="img" aria-label="New" className="size-2 shrink-0 rounded-full bg-accent" />}
          <span className="truncate type-body text-paper">{r.title}</span>
        </div>
        <div className="truncate type-small text-muted">{r.artistName}</div>
        <div className="mt-1 truncate type-meta text-muted">
          {message ?? (state === 'available' ? 'Ready to play' : state)} · {requestedLine(r)}
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
    <li className={cn('group flex items-center gap-4 rounded-lg border border-line bg-paper/[0.02] p-3 pr-4', answers && 'flex-wrap')}>
      {state === 'available' && albumId ? (
        <Link to={`/albums/${albumId}`} className="flex min-w-0 flex-1 items-center gap-4">
          {body}
        </Link>
      ) : (
        <div className={cn('flex min-w-0 flex-1 items-center gap-4', answers && 'basis-60')}>{body}</div>
      )}
      {answers ? (
        <span className="ml-auto flex shrink-0 gap-2">
          <Button
            size="small"
            variant="primary"
            icon={<Check />}
            aria-label={`Approve ${r.title}`}
            pending={answering(true)}
            pendingLabel="Approving…"
            disabled={answer.isPending}
            onClick={() => answer.mutate({ mbid: r.mbid, yes: true })}
          >
            Approve
          </Button>
          <Button
            size="small"
            icon={<X />}
            aria-label={`Decline ${r.title}`}
            pending={answering(false)}
            pendingLabel="Declining…"
            disabled={answer.isPending}
            onClick={() => answer.mutate({ mbid: r.mbid, yes: false })}
          >
            Decline
          </Button>
        </span>
      ) : declined ? (
        // Declined: nothing more will happen to it, so taking it off the list is the thing to do.
        canRemove && (
          <Button size="small" icon={<X />} aria-label={`Remove ${r.title} from this list`} onClick={remove} className="ml-auto">
            Remove
          </Button>
        )
      ) : (
        <RequestButton album={{ mbid: r.mbid, artistName: r.artistName, albumTitle: r.title }} availability={r.availability} />
      )}
      {/* An admin answers a request waiting for approval rather than making it vanish from whoever asked. */}
      {canRemove && !declined && !answers && (
        <IconButton
          label={`Remove ${r.title} from this list`}
          title="Remove from this list (doesn’t change Lidarr)"
          onClick={remove}
          className="pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:focus-visible:opacity-100"
        >
          <X className="size-4.5" />
        </IconButton>
      )}
    </li>
  );
}
