import type { AlbumRequest } from '@playarr/shared';
import { useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { Link } from 'react-router';
import { Cover } from '../components/Cover';
import { RequestButton } from '../components/Discover';
import { ErrorState, Skeleton } from '../components/Section';
import { api } from '../lib/api';
import { useRequests } from '../lib/queries';
import { toast } from '../lib/toast';
import { PageTitle } from './Albums';

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

export function RequestsPage() {
  const { data, error, isPending } = useRequests();

  return (
    <div className="max-w-4xl px-5 pt-8 md:px-10 md:pt-14">
      <PageTitle title="Requests" count={data?.length} />
      <p className="-mt-4 mb-8 max-w-xl text-sm text-muted md:-mt-6">
        Albums you asked Lidarr to find. Progress updates live; finished albums land in your library automatically.
      </p>
      {error && <ErrorState error={error} />}
      {isPending && (
        <div className="space-y-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      )}
      {data && !data.length && (
        <p className="text-muted">
          No requests yet. <Link to="/search" className="text-accent hover:underline">Search</Link> for something that isn’t in
          your library and hit Request.
        </p>
      )}
      <ol className="space-y-2">
        {data?.map((r) => (
          <RequestRow key={r.mbid} request={r} />
        ))}
      </ol>
    </div>
  );
}

function RequestRow({ request: r }: { request: AlbumRequest }) {
  const client = useQueryClient();
  const { state, progress, message, albumId } = r.availability;
  const remove = async () => {
    await api.removeRequest(r.mbid).catch((err: Error) => toast(err.message, 'error'));
    void client.invalidateQueries({ queryKey: ['requests'] });
  };
  const body = (
    <>
      <Cover src={r.coverUrl} size={64} alt="" label={r.title} className="size-16 shrink-0 rounded-[4px]" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] text-paper">{r.title}</div>
        <div className="truncate text-[13px] text-muted">{r.artistName}</div>
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
      <RequestButton album={{ mbid: r.mbid, artistName: r.artistName, albumTitle: r.title }} availability={r.availability} size="sm" />
      <button
        type="button"
        aria-label={`Remove ${r.title} from this list`}
        title="Remove from this list (doesn’t change Lidarr)"
        onClick={remove}
        className="grid size-8 shrink-0 place-items-center rounded-full text-muted transition hover:bg-paper/8 hover:text-paper md:opacity-0 md:group-hover:opacity-100"
      >
        <X className="size-4" />
      </button>
    </li>
  );
}
