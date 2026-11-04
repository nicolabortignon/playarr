import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickShots, seedPlays, statusBarArgs, statusBarTime } from './screenshots.mjs';

test('statusBarTime is 9:41 on 13 January 2026 here, in ISO 8601 with this zone’s offset', () => {
  const time = statusBarTime();
  assert.match(time, /^2026-01-13T09:41:00[+-]\d\d:\d\d$/);
  const parsed = new Date(time);
  assert.deepEqual([parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), parsed.getHours(), parsed.getMinutes()], [2026, 0, 13, 9, 41]);
});

test('statusBarArgs fixes the clock, full bars and a full battery', () => {
  assert.deepEqual(statusBarArgs('UDID', '2026-01-13T09:41:00+00:00'), [
    'status_bar', 'UDID', 'override', '--time', '2026-01-13T09:41:00+00:00', '--dataNetwork', 'wifi', '--wifiMode', 'active', '--wifiBars', '3',
    '--cellularMode', 'active', '--cellularBars', '4', '--operatorName', '', '--batteryState', 'charged', '--batteryLevel', '100',
  ]);
});

test('pickShots names the screenshots by their NN-name, keeping the last of a repeated one', () => {
  const manifest = [{
    testIdentifier: 'StoreScreenshots/testStoreScreenshots()',
    attachments: [
      { exportedFileName: 'A.png', suggestedHumanReadableName: '02-home_0_6F1C.png', timestamp: 1 },
      { exportedFileName: 'B.png', suggestedHumanReadableName: '01-now-playing_0_77AA.png', timestamp: 2 },
      { exportedFileName: 'C.png', suggestedHumanReadableName: 'Debug description_0_1.txt', timestamp: 3 },
      { exportedFileName: 'D.png', suggestedHumanReadableName: '02-home_1_8B2D.png', timestamp: 4 },
    ],
  }];
  assert.deepEqual(pickShots(manifest), [{ name: '01-now-playing', file: 'B.png' }, { name: '02-home', file: 'D.png' }]);
});

test('seedPlays plays one album a day back from now, every song, in order', () => {
  const albums = [
    { tracks: [{ id: 1, recordingId: 'r1', duration: 200.4 }, { id: 2, recordingId: 'r2', duration: 100 }] },
    { tracks: [{ id: 3, recordingId: 'r3', duration: 300 }] },
  ];
  const now = new Date(2026, 10, 3, 12, 0);
  const plays = seedPlays(albums, now);
  assert.deepEqual(plays.map((p) => [p.trackId, p.recordingId, p.seconds, p.skipped, p.hour]), [[1, 'r1', 200, false, 20], [2, 'r2', 100, false, 20], [3, 'r3', 300, false, 20]]);
  assert.equal(new Date(plays[0].at).getDate(), 2);
  assert.equal(new Date(plays[1].at) - new Date(plays[0].at), 200_000);
  assert.equal(new Date(plays[2].at).getDate(), 1);
  assert.equal(plays[0].weekday, new Date(2026, 10, 2).getDay());
});
