import type { Track } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ListStart } from 'lucide-react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { usePrefs } from '../lib/prefs';
import { useUI } from '../lib/ui';
import { usePlayer } from '../player/store';
import { ConfirmDialog, Dialog } from './Dialog';
import { Menu } from './Menu';
import { NowPlaying } from './NowPlaying';

const track = (id: number) =>
  ({ id, recordingId: `rec-${id}`, fileId: id, albumId: id, artistId: id, title: `Song ${id}`, artistName: `Artist ${id}`, albumTitle: 'A', duration: 200, streamUrl: `/s/${id}` }) as Track;

/** A dialog that opens later, over whatever is open, with a ⋯ in it and a dialog of its own to ask something. */
let openOver: (open: boolean) => void = () => {};
function Over() {
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  openOver = setOpen;
  return (
    <Dialog open={open} onClose={() => setOpen(false)} title="Over Now Playing">
      <Menu label="More for “Late night”" items={[{ label: 'Play next', icon: ListStart, onSelect: () => {} }]} />
      <button type="button" onClick={() => setAsking(true)}>
        Ask
      </button>
      <input aria-label="A field that keeps its Escape" onKeyDown={(e) => e.key === 'Escape' && e.preventDefault()} />
      <ConfirmDialog open={asking} onClose={() => setAsking(false)} title="Delete “Song 2”?" confirmLabel="Delete" onConfirm={() => {}}>
        <p>It goes for good.</p>
      </ConfirmDialog>
    </Dialog>
  );
}

function wrap() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <NowPlaying />
        <Over />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const escape = (on: Element = document.activeElement ?? document.body) => act(() => void fireEvent.keyDown(on, { key: 'Escape' }));
const dialog = (name: string) => screen.queryByRole('dialog', { name });

beforeEach(() => {
  vi.spyOn(api, 'favorites').mockResolvedValue([]);
  vi.spyOn(api, 'mixMaps').mockResolvedValue({});
  vi.spyOn(api, 'lyrics').mockResolvedValue(null);
  usePrefs.setState({ transitions: 'off' });
  usePlayer.setState({ queue: [1, 2].map(track), order: [0, 1], pos: 0, playing: true });
  useUI.setState({ nowPlayingOpen: true, lyricsOpen: false });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Escape closes what’s on top, one at a time', () => {
  it('a menu, then the dialog it was opened in, then Now Playing under them', async () => {
    wrap();
    act(() => openOver(true));
    fireEvent.click(await screen.findByRole('button', { name: 'More for “Late night”' }), { detail: 1 });
    expect(screen.getByRole('menu')).toBeTruthy();

    escape();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(dialog('Over Now Playing')).not.toBeNull();
    expect(useUI.getState().nowPlayingOpen).toBe(true);

    escape();
    await waitFor(() => expect(dialog('Over Now Playing')).toBeNull());
    expect(useUI.getState().nowPlayingOpen).toBe(true);

    escape(document.body);
    expect(useUI.getState().nowPlayingOpen).toBe(false);
  });

  it('a dialog opened over another closes alone', async () => {
    wrap();
    act(() => openOver(true));
    fireEvent.click(await screen.findByRole('button', { name: 'Ask' }));
    expect(await screen.findByRole('dialog', { name: 'Delete “Song 2”?' })).toBeTruthy();
    escape();
    await waitFor(() => expect(dialog('Delete “Song 2”?')).toBeNull());
    expect(dialog('Over Now Playing')).not.toBeNull();
  });

  it('leaves Escape to a field that takes it for itself', async () => {
    wrap();
    act(() => openOver(true));
    escape(await screen.findByRole('textbox', { name: 'A field that keeps its Escape' }));
    expect(dialog('Over Now Playing')).not.toBeNull();
    expect(useUI.getState().nowPlayingOpen).toBe(true);
  });
});
