import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../catalog/testFixtures.ts';
import { Transitions, type TransitionsOptions } from './transitions.ts';

const options = (cacheDir: string, track: (id: number) => object | undefined): TransitionsOptions => ({
  library: { track: async (id: number) => track(id) as never, file: async () => undefined },
  files: {
    resolve: () => {
      throw new Error('no files here');
    },
  },
  maps: { mixMaps: () => new Map(), cues: () => new Map() },
  dsp: {
    render: async () => {
      throw new Error('no renderer here');
    },
  },
  cacheDir,
  ffmpegPath: 'ffmpeg',
  log: { info: () => {}, warn: () => {} },
});

describe('who may hear a transition', () => {
  it('names the two songs a cached transition joins, for any of its files', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const key = 'b'.repeat(40);
      mkdirSync(join(dir, 'transitions'), { recursive: true });
      writeFileSync(join(dir, 'transitions', `${key}.flac`), 'audio');
      writeFileSync(join(dir, 'transitions', `${key}.rest.flac`), 'audio');
      writeFileSync(join(dir, 'transitions', `${key}.json`), JSON.stringify({ aRecording: 'rec-a', bRecording: 'rec-b', plan: { style: 'blend' }, audio: 'flac', continuation: 'flac', createdAt: 1 }));
      const transitions = new Transitions(options(dir, () => undefined));
      await transitions.load();
      expect(transitions.recordingsOf(`${key}.flac`)).toEqual(['rec-a', 'rec-b']);
      expect(transitions.recordingsOf(`${key}.rest.flac`)).toEqual(['rec-a', 'rec-b']);
      expect(transitions.recordingsOf(`${'d'.repeat(40)}.flac`)).toBeUndefined();
      expect(transitions.recordingsOf('../playarr.db')).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('looks the songs up in the library it’s given: the account’s view', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const transitions = new Transitions(options(dir, (id) => ({ id, recordingId: `rec-${id}`, fileId: id, title: 'Song' })));
      const answer = await transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto', library: { track: async () => undefined } });
      expect(answer).toEqual({ status: 'unavailable', reason: 'Unknown song' });
      const whole = await transitions.request({ fromTrackId: 1, toTrackId: 2, mode: 'auto' });
      expect(whole).toEqual({ status: 'unavailable', reason: 'No mix map yet for the song playing (“Song”)' });
    } finally {
      cleanup();
    }
  });
});
