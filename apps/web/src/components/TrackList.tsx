import type { MissingTrack, Track } from '@playarr/shared';
import { Disc3, ListEnd, ListMusic, ListPlus, Mic2, Play } from 'lucide-react';
import { Fragment } from 'react';
import { useNavigate } from 'react-router';
import { cn } from '../lib/cn';
import { useUI } from '../lib/ui';
import { formatTime } from '../lib/format';
import { queueTracks } from '../player/actions';
import { useCurrentTrack, usePlayer } from '../player/store';
import { Cover } from './Cover';
import { Equalizer } from './Equalizer';
import { FavoriteButton } from './FavoriteButton';
import { OfflineMark } from './OfflineMark';
import { InlineLink } from './InlineLink';
import { Menu } from './Menu';

interface TrackListProps {
  tracks: Track[];
  /** Show cover + artist for mixed lists (search, random); album pages show numbers instead. */
  variant?: 'album' | 'mixed';
  showDiscs?: boolean;
  /** Songs on the album that aren't in the library, shown greyed out in their place. */
  missing?: MissingTrack[];
}

type Row = { track: Track; index: number } | { missing: MissingTrack };
const disc = (r: Row) => ('track' in r ? r.track.discNumber : r.missing.discNumber);
const num = (r: Row) => ('track' in r ? r.track.trackNumber : r.missing.trackNumber);

export function TrackList({ tracks, variant = 'album', showDiscs, missing }: TrackListProps) {
  const current = useCurrentTrack();
  const playing = usePlayer((s) => s.playing);
  const playTracks = usePlayer((s) => s.playTracks);
  const toggle = usePlayer((s) => s.toggle);
  const navigate = useNavigate();
  const openPicker = useUI((s) => s.openPlaylistPicker);

  const rows: Row[] = tracks.map((track, index) => ({ track, index }));
  if (missing?.length) {
    rows.push(...missing.map((m) => ({ missing: m })));
    rows.sort((a, b) => disc(a) - disc(b) || num(a) - num(b));
  }

  return (
    <ol className="flex flex-col">
      {rows.map((row, r) => {
        const discStart = showDiscs && (r === 0 || disc(rows[r - 1]!) !== disc(row));
        const discHeader = discStart && (
          <li className="mt-6 mb-2 flex items-center gap-2 px-3 font-mono text-[11px] tracking-[0.2em] text-muted uppercase first:mt-0">
            <Disc3 className="size-3.5" /> Disc {disc(row)}
          </li>
        );
        if ('missing' in row) {
          return (
            <Fragment key={`missing-${row.missing.recordingId}-${r}`}>
              {discHeader}
              <li
                className="grid grid-cols-[2rem_1fr_auto] items-center gap-3 rounded-md px-3 py-2 opacity-40 md:gap-4"
                title="Not in your library"
              >
                <span className="text-center font-mono text-sm text-muted tabular">{row.missing.trackNumber}</span>
                <span className="truncate text-[15px] text-paper">{row.missing.title}</span>
                <span className="font-mono text-[13px] text-muted tabular">{formatTime(row.missing.duration)}</span>
              </li>
            </Fragment>
          );
        }
        const t = row.track;
        const i = row.index;
        const isCurrent = current?.fileId === t.fileId;
        return (
          <Fragment key={`${t.id}-${i}`}>
            {discHeader}
            <li
              className={cn(
                'group grid cursor-pointer items-center gap-3 rounded-md px-3 py-2 transition-colors hover:bg-paper/[0.045] md:gap-4',
                variant === 'album' ? 'grid-cols-[2rem_1fr_auto_auto_auto]' : 'grid-cols-[2.75rem_1fr_auto_auto_auto]',
                isCurrent && 'bg-paper/[0.035]',
              )}
              onClick={() => (isCurrent ? toggle() : playTracks(tracks, i))}
            >
              <div className="relative grid h-full place-items-center">
                {variant === 'mixed' ? (
                  <div className="relative">
                    <Cover src={t.coverUrl} size={44} alt="" label={t.albumTitle} className="size-11 rounded-[3px]" />
                    <div
                      className={cn(
                        'absolute inset-0 grid place-items-center rounded-[3px] bg-black/50 opacity-0 transition group-hover:opacity-100',
                        isCurrent && 'opacity-100',
                      )}
                    >
                      {isCurrent ? <Equalizer playing={playing} /> : <Play className="size-4 fill-paper" />}
                    </div>
                  </div>
                ) : isCurrent ? (
                  <Equalizer playing={playing} />
                ) : (
                  <>
                    <span className="font-mono text-sm text-muted tabular group-hover:invisible">{t.trackNumber}</span>
                    <Play className="invisible absolute size-3.5 fill-paper text-paper group-hover:visible" />
                  </>
                )}
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className={cn('truncate text-[15px]', isCurrent ? 'text-accent' : 'text-paper')}>{t.title}</span>
                  <OfflineMark fileId={t.fileId} />
                </div>
                {variant === 'mixed' && (
                  <div className="truncate text-[13px] text-muted">
                    <InlineLink to={`/artists/${t.artistId}`}>{t.artistName}</InlineLink> <span className="text-ink-600">·</span>{' '}
                    <InlineLink to={`/albums/${t.albumId}`}>{t.albumTitle}</InlineLink>
                  </div>
                )}
              </div>
              <FavoriteButton track={t} reveal />
              <span className="font-mono text-[13px] text-muted tabular">{formatTime(t.duration)}</span>
              <div onClick={(e) => e.stopPropagation()} className="opacity-100 transition md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
                <Menu
                  items={[
                    { label: 'Play next', icon: ListPlus, onSelect: () => queueTracks([t], 'next') },
                    { label: 'Add to queue', icon: ListEnd, onSelect: () => queueTracks([t], 'end') },
                    { label: 'Add to playlist…', icon: ListMusic, onSelect: () => openPicker([t]) },
                    ...(variant === 'mixed'
                      ? [{ label: 'Go to album', icon: Disc3, onSelect: () => navigate(`/albums/${t.albumId}`) }]
                      : []),
                    { label: 'Go to artist', icon: Mic2, onSelect: () => navigate(`/artists/${t.artistId}`) },
                  ]}
                />
              </div>
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}
