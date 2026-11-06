import type { MissingTrack, Track } from '@playarr/shared';
import { Disc3 } from 'lucide-react';
import { Fragment } from 'react';
import { useTempos } from '../lib/queries';
import { usePlayer, type PlaySource } from '../player/store';
import { ControlGap, ListRow, SongRow, SongTime } from './SongRow';

interface TrackListProps {
  tracks: Track[];
  /** Show cover + artist for mixed lists (search, random); album pages show numbers instead. */
  variant?: 'album' | 'mixed';
  showDiscs?: boolean;
  /** Songs on the album that aren't in the library, shown greyed out in their place. */
  missing?: MissingTrack[];
  /** What playing from this list counts as playing from (an album, a mix…), for "Playing from". */
  source?: PlaySource;
}

type Row = { track: Track; index: number } | { missing: MissingTrack };
const disc = (r: Row) => ('track' in r ? r.track.discNumber : r.missing.discNumber);
const num = (r: Row) => ('track' in r ? r.track.trackNumber : r.missing.trackNumber);

export function TrackList({ tracks, variant = 'album', showDiscs, missing, source }: TrackListProps) {
  const playTracks = usePlayer((s) => s.playTracks);
  const tempos = useTempos(tracks);

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
          <li className="mt-6 mb-2 flex items-center gap-2 px-3 type-kicker text-muted first:mt-0">
            <Disc3 className="size-3.5" /> Disc {disc(row)}
          </li>
        );
        if ('missing' in row) {
          return (
            <Fragment key={`missing-${row.missing.recordingId}-${r}`}>
              {discHeader}
              <ListRow
                missing
                hint="Not in your library"
                lead={<span className="grid w-8 shrink-0 place-items-center type-meta text-muted">{row.missing.trackNumber}</span>}
                title={row.missing.title}
                trailing={
                  <>
                    <SongTime seconds={row.missing.duration} />
                    <ControlGap />
                    <ControlGap />
                  </>
                }
              />
            </Fragment>
          );
        }
        const t = row.track;
        return (
          <Fragment key={`${t.id}-${row.index}`}>
            {discHeader}
            <SongRow
              track={t}
              lead={variant === 'album' ? 'number' : 'cover'}
              onPlay={() => playTracks(tracks, row.index, { source })}
              bpm={tempos[t.recordingId]}
              menu={{ inAlbum: variant === 'album' }}
            />
          </Fragment>
        );
      })}
    </ol>
  );
}
