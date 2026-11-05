import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider, type RouteObject } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePlayer } from '../player/store';
import { routes } from '../routes';
import { AppShell } from './AppShell';
import { PageError } from './PageError';

const reload = vi.fn();
beforeEach(() => {
  sessionStorage.clear();
  reload.mockClear();
  vi.stubGlobal('location', { ...window.location, reload });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  usePlayer.setState({ playing: false });
});

const staleChunk = () => Promise.reject(new TypeError('Failed to fetch dynamically imported module: /assets/Queue-old.js'));

function Broken(): never {
  throw new Error('The queue fell over');
}

/** A shell (standing in for AppShell's player bar) with pages that fail, as routes.tsx wires them. */
function show(path: string) {
  const pages: RouteObject[] = [
    { path: 'queue', lazy: staleChunk },
    { path: 'broken', element: <Broken /> },
  ];
  const router = createMemoryRouter(
    [{ element: <><div>Player bar</div><Outlet /></>, children: [{ errorElement: <PageError />, children: pages }] }],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
}

describe('PageError', () => {
  it('reloads into the new build when a page’s file is gone and nothing is playing', async () => {
    show('/queue');
    expect(await screen.findByText('Playarr was updated.')).toBeTruthy();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('asks instead while music plays, and keeps the player bar', async () => {
    usePlayer.setState({ playing: true });
    show('/queue');
    expect(await screen.findByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(screen.getByText('Player bar')).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads once, not over and over when the page keeps failing', async () => {
    sessionStorage.setItem('playarr:stale-build-reload', '1');
    show('/queue');
    await screen.findByText('Playarr was updated.');
    expect(reload).not.toHaveBeenCalled();
  });

  it('shows any other page error in the page’s place, the player bar still there', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    show('/broken');
    expect(await screen.findByText('The queue fell over')).toBeTruthy();
    expect(screen.getByText('Player bar')).toBeTruthy();
  });
});

describe('routes', () => {
  it('catches every page’s errors inside the shell', () => {
    const shell = routes.find((r) => (r.element as { type?: unknown } | undefined)?.type === AppShell)!;
    expect(shell.errorElement).toBeTruthy();
    expect(shell.children).toHaveLength(1);
    expect(shell.children![0]!.errorElement).toBeTruthy();
    expect(shell.children![0]!.children!.length).toBeGreaterThan(10);
  });
});
