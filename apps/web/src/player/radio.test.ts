import type { Track } from '@playarr/shared';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { usePrefs } from '../lib/prefs';
import { useAutoplay } from './radio';
import { usePlayer } from './store';

const song = (id: number) => ({ id, fileId: id, recordingId: `rec-${id}`, title: `Song ${id}`, albumId: 1 }) as Track;

beforeEach(() => {
  usePrefs.setState({ autoplay: true });
  usePlayer.setState({ repeat: 'off' });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('autoplay', () => {
  it('carries on with songs like the last ones when the last song of the queue starts', async () => {
    const radio = vi.spyOn(api, 'radio').mockResolvedValue([song(10), song(11)]);
    usePlayer.getState().playTracks([song(1), song(2)], 0, { shuffle: false });
    renderHook(() => useAutoplay());
    expect(radio).not.toHaveBeenCalled(); // more to play yet
    usePlayer.getState().jumpTo(1);
    await waitFor(() => expect(usePlayer.getState().queue).toHaveLength(4));
    expect(radio).toHaveBeenCalledWith(['rec-1', 'rec-2'], ['rec-1', 'rec-2']);
  });

  it('stays quiet when turned off or when the queue repeats', () => {
    const radio = vi.spyOn(api, 'radio').mockResolvedValue([]);
    usePrefs.setState({ autoplay: false });
    usePlayer.getState().playTracks([song(1)], 0, { shuffle: false });
    renderHook(() => useAutoplay());
    usePrefs.setState({ autoplay: true });
    usePlayer.setState({ repeat: 'all' });
    usePlayer.getState().playTracks([song(2)], 0, { shuffle: false });
    expect(radio).not.toHaveBeenCalled();
  });
});
