import { ArrowDownToLine, Disc3, Lock, Play, X } from 'lucide-react';
import { IconButton } from '../components/Button';
import { Cover } from '../components/Cover';
import { removeDownloadWithUndo } from '../components/DownloadButton';
import { NameAndNumbers } from '../components/NameAndNumbers';
import { PageHeader } from '../components/PageHeader';
import { ListRow } from '../components/SongRow';
import { EmptyState } from '../components/States';
import { formatBytes, plural } from '../lib/format';
import { useDownloadState } from '../player/downloads';
import { canKeepOffline, downloadProgress, useOffline, type Download } from '../player/offline';
import { usePlayer } from '../player/store';

/** Library → Downloads: albums, playlists and mixes on this device, playable without a connection. */
export function DownloadsPage() {
  const pins = useOffline((s) => s.pins);
  const downloads = Object.values(pins).sort((a, b) => b.addedAt - a.addedAt);
  return (
    <div className="px-5 pt-8 pb-16 md:px-10 md:pt-14">
      <PageHeader title="Downloads" count={downloads.length || undefined} />
      {!canKeepOffline ? (
        <EmptyState
          icon={Lock}
          title="Downloads need a secure connection."
          hint="Browsers only let Playarr keep music on a device over HTTPS. Open it through a reverse proxy with a certificate, for example."
        />
      ) : !downloads.length ? (
        <EmptyState
          icon={ArrowDownToLine}
          title="Take your music with you."
          hint="Download an album, playlist or mix and it plays here, with or without a connection."
          action={{ label: 'Browse albums', icon: <Disc3 />, to: '/albums' }}
        />
      ) : (
        <ul className="-mx-3 max-w-3xl">
          {downloads.map((d) => (
            <Row key={d.key} download={d} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** A download in the list's one row: the row opens its page, Play plays it, × takes it off the device (with Undo). */
function Row({ download: d }: { download: Download }) {
  const progress = useOffline((s) => downloadProgress(d, s.songs));
  const failed = useDownloadState((s) => d.tracks.filter((t) => t.fileId in s.failed).length);
  const playTracks = usePlayer((s) => s.playTracks);
  const done = progress.done === progress.total;
  return (
    <ListRow
      lead={<Cover src={d.coverUrl} size={44} alt="" label={d.title} className="size-11 shrink-0 rounded-cover" />}
      title={d.title}
      main={{ label: d.title, to: d.href }}
      // How far along it is goes under what it is when both don't fit, rather than being cut off.
      subtitle={
        <NameAndNumbers
          name={d.subtitle}
          numbers={
            <>
              {done ? plural(progress.total, 'song') : `${progress.done} of ${plural(progress.total, 'song')}`} · {formatBytes(progress.bytes)}
              {failed > 0 && <span className="text-danger"> · {failed} couldn’t download</span>}
            </>
          }
        />
      }
      trailing={
        <>
          <button
            type="button"
            aria-label={`Play ${d.title}`}
            onClick={() => playTracks(d.tracks, 0, { shuffle: false, source: { label: d.title, href: d.href } })}
            className="relative z-10 grid size-10 shrink-0 place-items-center rounded-full bg-accent text-accent-ink transition tap-target hover:brightness-110"
          >
            <Play className="size-4.5 fill-current" />
          </button>
          <IconButton label={`Remove ${d.title} from this device`} title="Remove from this device" onClick={() => removeDownloadWithUndo(d)} className="relative z-10">
            <X className="size-4.5" />
          </IconButton>
        </>
      }
      // Along the row's bottom edge, so a download in progress is no taller than one that's done.
      overlay={
        !done && (
          <div className="pointer-events-none absolute inset-x-3 bottom-0.5 h-0.5 overflow-hidden rounded-full bg-paper/10">
            <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
          </div>
        )
      }
    />
  );
}
