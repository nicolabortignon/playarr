import type { Track } from '@playarr/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { takeNextPresses, usePlayer } from './store';

const song = (id: number) => ({ id, fileId: id, recordingId: `r${id}`, duration: 200 }) as Track;

beforeEach(() => {
  localStorage.clear();
  usePlayer.setState({ queue: [], order: [], pos: -1, playing: false, mixMode: 'auto' });
});

describe('mix mode for the queue', () => {
  it('starts on Auto, and keeps what is picked with the queue', () => {
    expect(usePlayer.getState().mixMode).toBe('auto');
    usePlayer.getState().playTracks([song(1), song(2)]);
    usePlayer.getState().setMixMode('party');
    expect(usePlayer.getState().mixMode).toBe('party');
    expect(JSON.parse(localStorage.getItem('playarr.player')!).state.mixMode).toBe('party');
  });

  it('goes back to Auto when something new is played', () => {
    usePlayer.getState().setMixMode('off');
    usePlayer.getState().playTracks([song(3)]);
    expect(usePlayer.getState().mixMode).toBe('auto');
  });

  it('stays as picked when songs are added to the queue', () => {
    usePlayer.getState().playTracks([song(1)]);
    usePlayer.getState().setMixMode('party');
    usePlayer.getState().addToQueue([song(2)]);
    usePlayer.getState().playNext([song(3)]);
    expect(usePlayer.getState().mixMode).toBe('party');
  });
});

describe('starting a song somewhere', () => {
  it('asks the engine once to start the song it loads at a time, never kept for a reload', () => {
    usePlayer.getState().playTracks([song(1), song(2)], 0, { at: 30 });
    expect(usePlayer.getState().startAt).toBe(30);
    usePlayer.getState().jumpTo(1, { at: 12 });
    expect(usePlayer.getState().startAt).toBe(12);
    expect(JSON.parse(localStorage.getItem('playarr.player')!).state.startAt).toBeUndefined();
    usePlayer.getState().jumpTo(0);
    expect(usePlayer.getState().startAt).toBeNull();
  });
});

describe('presses of Next', () => {
  it('go to the engine first, which can take one over and move on later', () => {
    usePlayer.getState().playTracks([song(1), song(2), song(3)]);
    let take = true;
    const undo = takeNextPresses(() => take);
    usePlayer.getState().next();
    expect(usePlayer.getState().pos).toBe(0); // taken over
    usePlayer.getState().next(true);
    expect(usePlayer.getState().pos).toBe(1); // the song ending (or the engine moving on) never is
    usePlayer.getState().nextNow();
    expect(usePlayer.getState().pos).toBe(2);
    take = false;
    usePlayer.getState().prev(0);
    usePlayer.getState().next();
    expect(usePlayer.getState().pos).toBe(2);
    undo();
  });
});
