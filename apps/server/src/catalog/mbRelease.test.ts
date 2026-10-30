import { describe, expect, it } from 'vitest';
import { toReleaseInfo, type MbReleaseRaw } from './mbRelease.ts';

const raw: MbReleaseRaw = {
  id: '0d33ef7a-1f5d-4365-b807-b412271b99c3',
  title: 'Mezzanine',
  date: '1998-05-12',
  'artist-credit': [{ name: 'Massive Attack', artist: { id: '10adbe5e-a2c0-4bf3-8249-2b4cbf6e6ca8', name: 'Massive Attack' } }],
  'release-group': { id: '6f9f6899-c0d3-311d-ae87-a10ae6bc53a9', title: 'Mezzanine', 'primary-type': 'Album', 'secondary-types': null, 'first-release-date': '1998-04-17' },
  media: [
    {
      position: 1,
      tracks: [
        { position: 1, title: 'Angel', length: 380533, recording: { id: '8e74dd9d-e5a3-4acd-918a-c36a0f8cda84', title: 'Angel', length: 378866 } },
        { position: 2, title: 'Risingson', length: null, recording: { id: '02011500-814c-461c-b3a6-f24fe68ee5a1', title: 'Risingson', length: 298800 } },
      ],
    },
  ],
};

describe('toReleaseInfo', () => {
  it('flattens a release with its tracks', () => {
    expect(toReleaseInfo(raw)).toEqual({
      id: raw.id,
      title: 'Mezzanine',
      date: '1998-05-12',
      artistName: 'Massive Attack',
      artistId: '10adbe5e-a2c0-4bf3-8249-2b4cbf6e6ca8',
      releaseGroup: { id: '6f9f6899-c0d3-311d-ae87-a10ae6bc53a9', title: 'Mezzanine', primaryType: 'Album', secondaryTypes: [], firstReleaseDate: '1998-04-17' },
      tracks: [
        { disc: 1, position: 1, title: 'Angel', length: 381, recordingId: '8e74dd9d-e5a3-4acd-918a-c36a0f8cda84' },
        { disc: 1, position: 2, title: 'Risingson', length: 299, recordingId: '02011500-814c-461c-b3a6-f24fe68ee5a1' },
      ],
    });
  });
});
