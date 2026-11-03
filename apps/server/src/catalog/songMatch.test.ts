import { describe, expect, it } from 'vitest';
import type { MbRecordingHit } from '../discover/musicbrainz.ts';
import { bareTitle, leadArtist, songMatch } from './songMatch.ts';

const rhcp = [{ name: 'Red Hot Chili Peppers', artist: { id: 'art-rhcp', name: 'Red Hot Chili Peppers' } }];
type Release = NonNullable<MbRecordingHit['releases']>[number];
const on = (id: string, title: string, date: string, type: string, secondary: string[] = [], extra: Partial<Release> = {}): Release => ({
  id,
  title,
  status: 'Official',
  date,
  'release-group': { id: `rg-${id}`, title, 'primary-type': type, 'secondary-types': secondary },
  media: [{ position: 1, 'track-offset': 1, track: [{ id: `t-${id}`, number: '2' }] }],
  'track-count': 12,
  ...extra,
});
const recording = (id: string, seconds: number, releases: Release[], title = 'Can’t Stop', credit = rhcp): MbRecordingHit => ({
  id,
  score: 100,
  title,
  length: seconds * 1000,
  'artist-credit': credit,
  releases,
});

describe('songMatch', () => {
  const file = { artist: 'Red Hot Chili Peppers', title: 'Can’t Stop', duration: 269 };

  it('files a hit under the studio album it came from, not the single, compilation or live album', () => {
    const m = songMatch(file, [
      recording('rec-single', 268, [on('single', 'Can’t Stop', '2003-02-10', 'Single')]),
      recording('rec-live', 266, [on('live', 'Niigata, Japan', '2006-07-29', 'Album', ['Live'])]),
      recording('rec-album', 269, [
        on('promo', 'Promo Only: Modern Rock Radio', '2002', 'Album', ['Compilation']),
        on('btw', 'By the Way', '2002-07-09', 'Album'),
      ]),
    ]);
    expect(m).toEqual({
      overlay: {
        recordingMbid: 'rec-album',
        title: 'Can’t Stop',
        album: 'By the Way',
        albumArtist: 'Red Hot Chili Peppers',
        albumArtistMbid: 'art-rhcp',
        releaseGroupMbid: 'rg-btw',
        trackNumber: 2,
        discNumber: 1,
        trackTotal: 12,
        year: 2002,
      },
      score: 1,
      rank: 0,
    });
  });

  it('skips takes of another length, other songs and other artists', () => {
    const coldplay = [{ name: 'Coldplay', artist: { id: 'art-c', name: 'Coldplay' } }];
    expect(
      songMatch(file, [
        recording('rec-long', 316, [on('a', 'Live at Slane Castle', '2003', 'Album')]),
        recording('rec-other', 269, [on('b', 'Other', '2003', 'Album')], 'Dani California'),
        recording('rec-cover', 269, [on('c', 'Covers', '2003', 'Album')], 'Can’t Stop', coldplay),
      ]),
    ).toBeNull();
  });

  it('sees past guests in the title and the credit, and files the song under the album’s own artist', () => {
    const credit = [
      { name: 'Madonna', joinphrase: ' feat. ', artist: { id: 'art-m', name: 'Madonna' } },
      { name: 'Justin Timberlake', artist: { id: 'art-jt', name: 'Justin Timberlake' } },
    ];
    const album = on('hc', 'Hard Candy', '2008-04-25', 'Album', [], { 'artist-credit': [{ name: 'Madonna', artist: { id: 'art-m', name: 'Madonna' } }] });
    const m = songMatch({ artist: 'Madonna', title: '4 Minutes (feat. Justin Timberlake & Timbaland)', duration: 189 }, [
      recording('rec-4m', 189, [album], '4 Minutes', credit),
    ]);
    expect(m?.overlay).toMatchObject({ album: 'Hard Candy', albumArtist: 'Madonna', albumArtistMbid: 'art-m', title: '4 Minutes' });
  });

  it('never files a song under another various-artists compilation, and takes a radio edit for the same song', () => {
    const va = [{ name: 'Various Artists', artist: { id: 'art-va', name: 'Various Artists' } }];
    const gch = [{ name: 'Gym Class Heroes', artist: { id: 'art-gch', name: 'Gym Class Heroes' } }];
    const edit = { artist: 'Gym Class Heroes', title: 'Cupid’s Chokehold / Breakfast in America', duration: 236 };
    const onCompilation = recording('rec-va', 236, [on('this', 'THIS is the 00’s', '2023-05-17', 'Album', [], { 'artist-credit': va })], edit.title, gch);
    expect(songMatch(edit, [onCompilation])).toBeNull();
    const single = recording('rec-single', 237, [on('single', 'Cupid’s Chokehold / Breakfast in America', '2008', 'Single')], 'Cupid’s Chokehold / Breakfast In America (Radio Mix)', gch);
    expect(songMatch(edit, [onCompilation, single])?.overlay).toMatchObject({ recordingMbid: 'rec-single', albumArtist: 'Gym Class Heroes' });
  });
});

describe('song names', () => {
  it('drops guests and radio edits from a title, not remixes', () => {
    expect(bareTitle('Replay (feat. Flo Rida)')).toBe('Replay');
    expect(bareTitle('Low [ft. T-Pain]')).toBe('Low');
    expect(bareTitle('Sexy Bitch feat. Akon')).toBe('Sexy Bitch');
    expect(bareTitle('Bad Day (Radio Edit)')).toBe('Bad Day');
    expect(bareTitle('Die Another Day (From "Die Another Day")')).toBe('Die Another Day');
    expect(bareTitle('Feel Good Inc (Stanton Warriors Remix)')).toBe('Feel Good Inc (Stanton Warriors Remix)');
    expect(bareTitle('Feel Good Inc')).toBe('Feel Good Inc');
  });

  it('finds the lead artist', () => {
    expect(leadArtist('Flo Rida feat. T-Pain')).toBe('Flo Rida');
    expect(leadArtist('Jay-Z & Linkin Park')).toBe('Jay-Z');
    expect(leadArtist('Coldplay')).toBe('Coldplay');
  });
});
