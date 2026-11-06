import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accentGlide, useCoverAccent, usePlayerAccent } from './accent';
import { extractAccent } from './color';
import { usePrefs } from './prefs';

// The picture is read only where the server hasn't read the cover: the reading is watched, and answers at once.
vi.mock('./color', async (original) => ({ ...(await original<typeof import('./color')>()), extractAccent: vi.fn(async () => 'hsl(200 60% 60%)') }));
vi.mock('./favicon', () => ({ setFaviconAccent: vi.fn() }));

const accentNow = () => document.documentElement.style.getPropertyValue('--accent');

beforeEach(() => {
  usePrefs.setState({ accent: 'album' });
  document.documentElement.style.removeProperty('--accent');
});
afterEach(() => {
  cleanup();
  vi.mocked(extractAccent).mockClear();
});

describe('the player’s accent', () => {
  it('takes the song’s coverAccent at once, without waiting for its cover', () => {
    renderHook(() => usePlayerAccent({ coverUrl: '/art/album/1/cover', coverColor: '#10203a', coverAccent: '#5b8fd9' }));
    expect(accentNow()).toBe('#5b8fd9');
    expect(extractAccent).not.toHaveBeenCalled();
  });

  it('is Playarr’s orange for a cover the server read and found no color in', () => {
    renderHook(() => usePlayerAccent({ coverUrl: '/art/album/1/cover', coverColor: '#808080' }));
    expect(accentNow()).toBe('#ff7a1a');
    expect(extractAccent).not.toHaveBeenCalled();
  });

  it('reads the cover when the server hasn’t (an older server, a cover not read yet)', async () => {
    renderHook(() => usePlayerAccent({ coverUrl: '/art/album/1/cover' }));
    await waitFor(() => expect(accentNow()).toBe('hsl(200 60% 60%)'));
    expect(extractAccent).toHaveBeenCalledWith('/art/album/1/cover?size=96');
  });

  it('keeps the color Settings → Appearance fixes', () => {
    usePrefs.setState({ accent: '#a78bfa' });
    renderHook(() => usePlayerAccent({ coverUrl: '/art/album/1/cover', coverAccent: '#5b8fd9' }));
    expect(accentNow()).toBe('#a78bfa');
  });
});

describe('the accent’s glide to a new song’s color', () => {
  const glideNow = () => document.documentElement.style.getPropertyValue('--accent-glide');

  it('takes one beat of the song when its tempo is known, else 0.8 s', () => {
    expect(accentGlide(120)).toBe('500ms');
    expect(accentGlide(174)).toBe('345ms');
    expect(accentGlide(undefined)).toBe('800ms');
    expect(accentGlide(0)).toBe('800ms');
    // A misread tempo doesn't make it snap or crawl.
    expect(accentGlide(40)).toBe('1200ms');
    expect(accentGlide(400)).toBe('300ms');
  });

  it('is set before the color, so the color glides over the new song’s beat', () => {
    const set = vi.spyOn(document.documentElement.style, 'setProperty');
    const first = { coverUrl: '/art/album/1/cover', coverAccent: '#5b8fd9' };
    const { rerender } = renderHook(({ track, bpm }) => usePlayerAccent(track, bpm), { initialProps: { track: first, bpm: 96 } });
    expect(set.mock.calls.map(([name, value]) => `${name}: ${value}`)).toEqual(['--accent-glide: 625ms', '--accent: #5b8fd9']);
    // The next song, its tempo known as its color comes.
    set.mockClear();
    rerender({ track: { coverUrl: '/art/album/2/cover', coverAccent: '#d95b5b' }, bpm: 120 });
    expect(set.mock.calls.map(([name, value]) => `${name}: ${value}`)).toEqual(['--accent-glide: 500ms', '--accent: #d95b5b']);
    set.mockRestore();
  });

  it('isn’t set again for a tempo learned once the color has come', () => {
    const { rerender } = renderHook(({ bpm }) => usePlayerAccent({ coverUrl: '/art/album/1/cover', coverAccent: '#5b8fd9' }, bpm), {
      initialProps: { bpm: undefined as number | undefined },
    });
    expect(glideNow()).toBe('800ms');
    const set = vi.spyOn(document.documentElement.style, 'setProperty');
    rerender({ bpm: 120 });
    expect(set).not.toHaveBeenCalledWith('--accent', expect.anything());
    set.mockRestore();
  });
});

describe('a page’s accent', () => {
  it('is the album’s coverAccent at once, without reading the cover', () => {
    const { result } = renderHook(() => useCoverAccent('/art/album/1/cover', { coverColor: '#10203a', coverAccent: '#5b8fd9' }));
    expect(result.current).toBe('#5b8fd9');
    expect(extractAccent).not.toHaveBeenCalled();
  });

  it('falls back to reading the cover, and is none for a cover without color', async () => {
    const read = renderHook(() => useCoverAccent('/art/album/1/cover'));
    await waitFor(() => expect(read.result.current).toBe('hsl(200 60% 60%)'));
    const gray = renderHook(() => useCoverAccent('/art/album/2/cover', { coverColor: '#808080' }));
    expect(gray.result.current).toBeNull();
  });
});
