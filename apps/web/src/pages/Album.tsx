import { Link, useParams } from 'react-router';
import { ActionRow } from '../components/ActionRow';
import { AlbumCard } from '../components/Cards';
import { Cover } from '../components/Cover';
import { DetailHeader, DetailHeaderSkeleton, joinMeta } from '../components/DetailHeader';
import { RequestButton, useRestRequest } from '../components/Discover';
import { FormatBadge } from '../components/FormatBadge';
import { useAlbumMenu } from '../components/menus';
import { BackButton, SectionHeader, SHELF_CARD, Shelf } from '../components/Section';
import { ErrorState, SongRowsSkeleton } from '../components/States';
import { TrackList } from '../components/TrackList';
import { useCoverAccent } from '../lib/color';
import { formatDuration, plural, releaseKind } from '../lib/format';
import { useAlbum, useArtist } from '../lib/queries';
import { useCurrentTrack, usePlayer } from '../player/store';
import { artistPhoto } from './Artist';

export function AlbumPage() {
  const id = Number(useParams().id);
  const { data: album, error, isPending, refetch } = useAlbum(id);
  const { data: artist } = useArtist(album?.artistId ?? Number.NaN);
  const accent = useCoverAccent(album?.coverUrl);
  const current = useCurrentTrack();
  const playing = usePlayer((s) => s.playing);
  const playTracks = usePlayer((s) => s.playTracks);
  const toggle = usePlayer((s) => s.toggle);
  const rest = useRestRequest(album);
  const menu = useAlbumMenu({ id, artistId: album?.artistId ?? Number.NaN }, { tracks: album?.tracks });

  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (isPending || !album) return <AlbumSkeleton />;

  const isCurrent = current?.albumId === album.id;
  const more = artist?.albums.filter((a) => a.id !== album.id) ?? [];
  const photo = artist && artistPhoto(artist);

  return (
    <div className="relative">
      <BackButton fallback={`/artists/${album.artistId}`} className="absolute top-3 left-3 z-20" />
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
        <DetailHeader
          cover={
            <Cover
              src={album.coverUrl}
              size={288}
              alt={album.title}
              eager
              className="w-full rounded-cover shadow-cover-hero ring-1 ring-paper/10"
            />
          }
          kicker={releaseKind(album.albumType, album.secondaryTypes)}
          title={album.title}
          // Who, when, how many, how long: missing songs show greyed in the list, and the row offers the rest.
          meta={
            <>
              {joinMeta(
                <Link to={`/artists/${album.artistId}`} className="inline-flex items-center gap-2 font-sans type-body text-paper hover:underline">
                  {photo && <Cover src={photo} size={24} alt="" className="size-6 shrink-0 rounded-full" />}
                  {album.artistName}
                </Link>,
                album.year,
                plural(album.trackCount, 'song'),
                formatDuration(album.duration),
              )}
              <FormatBadge format={album.format} className="ml-1" />
            </>
          }
          overArt
        >
          <ActionRow
            title={album.title}
            state={isCurrent ? (playing ? 'playing' : 'paused') : 'idle'}
            onPlay={() => (isCurrent ? toggle() : playTracks(album.tracks, 0, { shuffle: false, source: albumSource(album) }))}
            onShuffle={() => playTracks(album.tracks, 0, { shuffle: true, source: albumSource(album) })}
            action={rest && <RequestButton size="large" album={rest.album} availability={rest.availability} />}
            download={{
              item: { key: `album:${album.id}`, title: album.title, subtitle: album.artistName, coverUrl: album.coverUrl, href: `/albums/${album.id}` },
              tracks: album.tracks,
            }}
            menu={{ items: menu }}
          />
        </DetailHeader>

        <div className="mt-8 -mx-3 max-w-5xl md:mt-10">
          <TrackList tracks={album.tracks} missing={album.missingTracks} showDiscs={album.discCount > 1} source={albumSource(album)} />
        </div>

        {album.overview && (
          <section className="mt-14 max-w-2xl">
            <div className="mb-3 type-kicker text-muted">Liner notes</div>
            <p className="type-body leading-relaxed whitespace-pre-line text-paper-dim">{album.overview}</p>
          </section>
        )}

        {more.length > 0 && (
          <section className="mt-16">
            <SectionHeader kicker="Discography" title={`More by ${album.artistName}`} to={`/artists/${album.artistId}`} />
            <Shelf>
              {more.map((a) => (
                <AlbumCard key={a.id} album={a} className={SHELF_CARD} />
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
      <DetailHeaderSkeleton />
      <SongRowsSkeleton lead="number" className="mt-8 -mx-3 max-w-5xl md:mt-10" />
    </div>
  );
}

const albumSource = (album: { id: number; title: string }) => ({ label: album.title, href: `/albums/${album.id}` });
