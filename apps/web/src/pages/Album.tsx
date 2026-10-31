import type { AlbumDetail } from '@playarr/shared';
import { ListEnd, ListMusic, ListPlus, Mic2, Pause, Play, Shuffle } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router';
import { AlbumCard } from '../components/Cards';
import { Cover } from '../components/Cover';
import { RequestButton } from '../components/Discover';
import { FormatBadge } from '../components/FormatBadge';
import { Menu } from '../components/Menu';
import { ErrorState, SectionHeader, Shelf, Skeleton } from '../components/Section';
import { TrackList } from '../components/TrackList';
import { useCoverAccent } from '../lib/color';
import { formatDuration, plural } from '../lib/format';
import { useAlbum, useArtist, useRequests } from '../lib/queries';
import { useUI } from '../lib/ui';
import { queueTracks } from '../player/actions';
import { useCurrentTrack, usePlayer } from '../player/store';

export function AlbumPage() {
  const id = Number(useParams().id);
  const { data: album, error, isPending } = useAlbum(id);
  const { data: artist } = useArtist(album?.artistId ?? Number.NaN);
  const accent = useCoverAccent(album?.coverUrl);
  const current = useCurrentTrack();
  const playing = usePlayer((s) => s.playing);
  const playTracks = usePlayer((s) => s.playTracks);
  const toggle = usePlayer((s) => s.toggle);
  const navigate = useNavigate();
  const openPicker = useUI((s) => s.openPlaylistPicker);

  if (error) return <ErrorState error={error} />;
  if (isPending || !album) return <AlbumSkeleton />;

  const isCurrent = current?.albumId === album.id;
  const more = artist?.albums.filter((a) => a.id !== album.id) ?? [];
  const kind = album.secondaryTypes[0] ?? album.albumType;

  return (
    <div className="relative">
      {/* Header wash tinted with this album's own color. */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-[520px] transition-[background] duration-700"
        style={{
          background: accent
            ? `linear-gradient(180deg, color-mix(in oklab, ${accent} 32%, transparent) 0%, color-mix(in oklab, ${accent} 8%, transparent) 55%, transparent 100%)`
            : undefined,
        }}
      />
      <div className="relative px-5 pt-6 md:px-10 md:pt-14">
        <header className="flex flex-col gap-6 md:flex-row md:items-end md:gap-10">
          <Cover
            src={album.coverUrl}
            size={320}
            alt={album.title}
            eager
            className="mx-auto w-[min(72vw,320px)] shrink-0 animate-rise rounded-[4px] shadow-[0_30px_70px_-20px_rgb(0_0_0/0.9)] ring-1 ring-paper/10 md:mx-0 md:w-64 lg:w-72"
          />
          <div className="min-w-0 animate-rise [animation-delay:80ms]">
            <div className="font-mono text-[11px] tracking-[0.25em] text-paper-dim/70 uppercase">
              {kind}
              {album.year && ` · ${album.year}`}
            </div>
            <h1 className="mt-2 font-display text-[2.5rem] leading-[1.02] tracking-tight text-balance text-paper md:text-6xl lg:text-7xl">
              {album.title}
            </h1>
            <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-[15px]">
              <Link to={`/artists/${album.artistId}`} className="inline-flex items-center gap-2 text-paper hover:underline">
                {artist?.imageUrl && <Cover src={artist.imageUrl} size={24} alt="" className="size-6 rounded-full" />}
                {album.artistName}
              </Link>
              <span className="font-mono text-[12px] text-muted">
                {plural(album.trackCount, 'track')} · {formatDuration(album.duration)}
                {album.trackCount < album.totalTrackCount && ` · ${album.totalTrackCount - album.trackCount} missing`}
                {album.addedAt && (
                  <span title={new Date(album.addedAt).toLocaleString()}> · added {addedAgo(album.addedAt)}</span>
                )}
              </span>
              <FormatBadge format={album.format} />
            </div>
          </div>
        </header>

        <div className="mt-8 flex items-center gap-3">
          <button
            type="button"
            aria-label={`${isCurrent && playing ? 'Pause' : isCurrent ? 'Resume' : 'Play'} ${album.title}`}
            onClick={() => (isCurrent ? toggle() : playTracks(album.tracks, 0, { shuffle: false }))}
            className="inline-flex h-12 items-center gap-2 rounded-full bg-accent pr-6 pl-5 font-medium text-accent-ink shadow-[0_10px_40px_-12px_var(--accent)] transition hover:brightness-110 active:scale-[0.98]"
          >
            {isCurrent && playing ? <Pause className="size-5 fill-current" /> : <Play className="size-5 fill-current" />}
            {isCurrent && playing ? 'Pause' : isCurrent ? 'Resume' : 'Play'}
          </button>
          <button
            type="button"
            aria-label={`Shuffle ${album.title}`}
            onClick={() => playTracks(album.tracks, 0, { shuffle: true })}
            className="inline-flex h-12 items-center gap-2 rounded-full border border-paper/15 px-5 text-paper transition hover:border-paper/35 hover:bg-paper/5"
          >
            <Shuffle className="size-[18px]" /> Shuffle
          </button>
          {album.mbid && album.trackCount < album.totalTrackCount && <RequestRest album={album} />}
          <Menu
            className="size-12 border border-paper/15 text-paper"
            items={[
              { label: 'Play next', icon: ListPlus, onSelect: () => queueTracks(album.tracks, 'next') },
              { label: 'Add to queue', icon: ListEnd, onSelect: () => queueTracks(album.tracks, 'end') },
              { label: 'Add to playlist…', icon: ListMusic, onSelect: () => openPicker(album.tracks) },
              { label: 'Go to artist', icon: Mic2, onSelect: () => navigate(`/artists/${album.artistId}`) },
            ]}
          />
        </div>

        <div className="mt-8 -mx-3 max-w-5xl md:mt-10">
          <TrackList tracks={album.tracks} missing={album.missingTracks} showDiscs={album.discCount > 1} />
        </div>

        {album.overview && (
          <section className="mt-14 max-w-2xl">
            <div className="mb-3 font-mono text-[11px] tracking-[0.25em] text-muted uppercase">Liner notes</div>
            <p className="text-[15px] leading-relaxed whitespace-pre-line text-paper-dim/90">{album.overview}</p>
          </section>
        )}

        {more.length > 0 && (
          <section className="mt-16">
            <SectionHeader kicker="Discography" title={`More by ${album.artistName}`} to={`/artists/${album.artistId}`} />
            <Shelf>
              {more.map((a) => (
                <AlbumCard key={a.id} album={a} size={180} className="w-[40vw] max-w-44 shrink-0 snap-start sm:w-40 md:w-44" />
              ))}
            </Shelf>
          </section>
        )}
      </div>
    </div>
  );
}

function AlbumSkeleton() {
  return (
    <div className="px-5 pt-6 md:px-10 md:pt-14">
      <div className="flex flex-col gap-6 md:flex-row md:items-end md:gap-10">
        <Skeleton className="mx-auto aspect-square w-[min(72vw,320px)] md:mx-0 md:w-64 lg:w-72" />
        <div className="flex-1 space-y-4">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-14 w-3/4" />
          <Skeleton className="h-4 w-60" />
        </div>
      </div>
      <div className="mt-12 space-y-3">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-10" />
        ))}
      </div>
    </div>
  );
}

/** Only some of the album is here: ask Lidarr for the whole of it, then show how that's going. */
function RequestRest({ album }: { album: AlbumDetail }) {
  const { data: requests } = useRequests();
  const availability = requests?.find((r) => r.mbid === album.mbid)?.availability ?? { state: 'none' as const };
  if (availability.state === 'available') return null;
  return (
    <RequestButton album={{ mbid: album.mbid, artistName: album.artistName, albumTitle: album.title }} availability={availability} />
  );
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** "today", "3 days ago", "2 months ago": when the album entered the library. */
function addedAgo(iso: string): string {
  const days = Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000);
  if (days > -1) return 'today';
  if (days > -30) return relative.format(days, 'day');
  if (days > -365) return relative.format(Math.round(days / 30), 'month');
  return relative.format(Math.round(days / 365), 'year');
}
