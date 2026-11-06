import { Play, Trash2 } from 'lucide-react';
import { Link } from 'react-router';
import { IconButton } from '../components/Button';
import { Cover } from '../components/Cover';
import { NameAndNumbers } from '../components/NameAndNumbers';
import { PageHeader } from '../components/PageHeader';
import { formatBytes, plural } from '../lib/format';
import { useDownloadState } from '../player/downloads';
import { canKeepOffline, downloadProgress, removeDownload, useOffline, type Download } from '../player/offline';
import { usePlayer } from '../player/store';

/** Library → Downloads: albums, playlists and mixes on this device, playable without a connection. */
export function DownloadsPage() {
  const pins = useOffline((s) => s.pins);
  const downloads = Object.values(pins).sort((a, b) => b.addedAt - a.addedAt);
  return (
    <div className="px-5 pt-8 pb-16 md:px-10 md:pt-14">
      <PageHeader title="Downloads" count={downloads.length || undefined} />
      {!canKeepOffline ? (
        <p className="max-w-md type-body text-paper-dim">
          Browsers only let Playarr keep music on a device over a secure connection. Open Playarr over HTTPS (for example through a reverse proxy with a
          certificate) to download albums and playlists.
        </p>
      ) : !downloads.length ? (
        <p className="max-w-md type-body text-paper-dim">
          Nothing downloaded yet. Tap the download button on an album, playlist, mix or Favorites to keep it on this device and play it without a
          connection.
        </p>
      ) : (
        <ul className="max-w-3xl divide-y divide-line">
          {downloads.map((d) => (
            <Row key={d.key} download={d} />
          ))}
        </ul>
      )}
    </div>
  );
}

function Row({ download: d }: { download: Download }) {
  const progress = useOffline((s) => downloadProgress(d, s.songs));
  const failed = useDownloadState((s) => d.tracks.filter((t) => t.fileId in s.failed).length);
  const playTracks = usePlayer((s) => s.playTracks);
  const done = progress.done === progress.total;
  return (
    <li className="flex items-center gap-4 py-3">
      <Link to={d.href} className="shrink-0">
        <Cover src={d.coverUrl} size={64} alt="" className="size-14 rounded-cover" />
      </Link>
      <div className="min-w-0 flex-1">
        <Link to={d.href} className="block truncate type-body text-paper hover:underline">
          {d.title}
        </Link>
        {/* How far along it is goes under what it is when both don't fit, rather than being cut off. */}
        <NameAndNumbers
          className="type-small text-muted"
          name={d.subtitle}
          numbers={
            <>
              {done ? plural(progress.total, 'song') : `${progress.done} of ${plural(progress.total, 'song')}`} · {formatBytes(progress.bytes)}
              {failed > 0 && <span className="text-danger"> · {failed} couldn’t download</span>}
            </>
          }
        />
        {!done && (
          <div className="mt-1.5 h-1 max-w-48 overflow-hidden rounded-full bg-paper/10">
            <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
          </div>
        )}
      </div>
      <button
        type="button"
        aria-label={`Play ${d.title}`}
        onClick={() => playTracks(d.tracks, 0, { shuffle: false, source: { label: d.title, href: d.href } })}
        className="relative grid size-10 shrink-0 place-items-center rounded-full bg-accent text-accent-ink transition tap-target hover:brightness-110"
      >
        <Play className="size-4 fill-current" />
      </button>
      <IconButton label={`Remove ${d.title} from this device`} onClick={() => void removeDownload(d.key)}>
        <Trash2 className="size-4" />
      </IconButton>
    </li>
  );
}
