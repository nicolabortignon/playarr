import { BookmarkPlus, ListEnd, ListPlus, RefreshCw } from 'lucide-react';
import { useNavigate, useParams } from 'react-router';
import { ActionRow, RowAction, usePlayState } from '../components/ActionRow';
import { DetailHeader, DetailHeaderSkeleton, joinMeta } from '../components/DetailHeader';
import { MixCover } from '../components/Mixes';
import { BackButton, ErrorState } from '../components/Section';
import { TrackList } from '../components/TrackList';
import { formatDuration, plural } from '../lib/format';
import { useMix, useRegenerateMix, useSaveMix } from '../lib/queries';
import { queueTracks } from '../player/actions';
import { usePlayer } from '../player/store';

/** A generated mix: why these songs, when it changes, and the songs. */
export function MixPage() {
  const key = useParams().key ?? '';
  const { data: mix, error, isPending, refetch } = useMix(key);
  const regenerate = useRegenerateMix(key);
  const save = useSaveMix(key);
  const playTracks = usePlayer((s) => s.playTracks);
  const toggle = usePlayer((s) => s.toggle);
  const playState = usePlayState(`/mixes/${key}`);
  const navigate = useNavigate();

  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (isPending || !mix) {
    return (
      <div className="px-5 pt-6 md:px-10 md:pt-14">
        <DetailHeaderSkeleton />
      </div>
    );
  }

  const source = { label: mix.title, href: `/mixes/${mix.key}` };
  return (
    <div className="relative px-5 pt-6 md:px-10 md:pt-14">
      <BackButton fallback="/" className="absolute top-3 left-3 z-20" />
      <DetailHeader
        cover={<MixCover mix={mix} size={288} titled={false} className="w-full rounded-cover shadow-cover-hero ring-1 ring-paper/10" />}
        kicker="Made for you"
        title={mix.title}
        meta={joinMeta(plural(mix.trackCount, 'song'), formatDuration(mix.duration), changesLabel(mix.refreshesAt))}
      >
        <ActionRow
          title={mix.title}
          disabled={!mix.tracks.length}
          state={playState}
          onPlay={() => (playState !== 'idle' ? toggle() : playTracks(mix.tracks, 0, { shuffle: false, source }))}
          onShuffle={() => playTracks(mix.tracks, 0, { shuffle: true, source })}
          action={
            <RowAction icon={<RefreshCw />} pending={regenerate.isPending} pendingLabel="Mixing…" onClick={() => regenerate.mutate()}>
              New mix
            </RowAction>
          }
          download={{
            item: { key: `mix:${mix.key}`, title: mix.title, subtitle: 'Mix', coverUrl: mix.covers[0], href: `/mixes/${mix.key}` },
            tracks: mix.tracks,
          }}
          menu={{
            label: 'Mix actions',
            items: [
              {
                label: 'Save as playlist',
                icon: BookmarkPlus,
                // Opens the new playlist, so it's clear what was made and where it lives.
                onSelect: () => !save.isPending && save.mutate(undefined, { onSuccess: (playlist) => navigate(`/playlists/${playlist.id}`) }),
              },
              { label: 'Play next', icon: ListPlus, onSelect: () => queueTracks(mix.tracks, 'next') },
              { label: 'Add to queue', icon: ListEnd, onSelect: () => queueTracks(mix.tracks, 'end') },
            ],
          }}
        />
      </DetailHeader>
      {/* Why these songs: after the row, so Play comes first on a phone. */}
      {mix.description && <p className="mt-6 max-w-2xl type-body text-paper-dim">{mix.description}</p>}

      <div className="mt-6 -mx-3 max-w-5xl md:mt-8">
        <TrackList tracks={mix.tracks} variant="mixed" source={source} />
      </div>
    </div>
  );
}

/** "Changes in 40 min", "Changes in 9 h", "Changes on Monday". */
export function changesLabel(iso: string, now = Date.now()): string {
  const minutes = Math.max(1, Math.round((Date.parse(iso) - now) / 60_000));
  if (minutes < 90) return `Changes in ${minutes} min`;
  if (minutes < 24 * 60) return `Changes in ${Math.round(minutes / 60)} h`;
  return `Changes on ${new Date(iso).toLocaleDateString(undefined, { weekday: 'long' })}`;
}
