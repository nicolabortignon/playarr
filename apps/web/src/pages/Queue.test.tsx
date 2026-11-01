import type { Track } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useToasts } from '../lib/toast';
import { usePlayer } from '../player/store';
import { QueuePage } from './Queue';

// happy-dom's Animation.cancel() throws where browsers reject a promise; make motion use JS animations.
Reflect.deleteProperty(Element.prototype, 'animate');

const track = (id: number) =>
  ({ id, recordingId: `rec-${id}`, fileId: id, albumId: id, artistId: id, title: `Song ${id}`, artistName: `Artist ${id}`, albumTitle: 'A', duration: 200, streamUrl: `/s/${id}` }) as Track;

const upcomingTitles = () => {
  const s = usePlayer.getState();
  return s.order.slice(s.pos + 1).map((i) => s.queue[i]!.title);
};

function renderQueue() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <QueuePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  usePlayer.setState({ queue: [1, 2, 3, 4].map(track), order: [0, 1, 2, 3], pos: 0, playing: false });
  useToasts.setState({ toasts: [] });
});
afterEach(cleanup);

describe('Queue', () => {
  it('moves a song to play next from its menu', () => {
    renderQueue();
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Song 4' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Play next' }));
    expect(upcomingTitles()).toEqual(['Song 4', 'Song 2', 'Song 3']);
  });

  it('clears what comes up next, with Undo', () => {
    renderQueue();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(upcomingTitles()).toEqual([]);
    act(() => useToasts.getState().toasts[0]!.action!.run());
    expect(upcomingTitles()).toEqual(['Song 2', 'Song 3', 'Song 4']);
  });
});
