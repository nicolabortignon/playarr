import type { UpdateInfo } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useToasts } from '../lib/toast';
import { Toasts } from './Toasts';
import { UpdatesPanel } from './UpdatesPanel';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useToasts.setState({ toasts: [] });
});

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);

/** The panel against a fake server holding `info`; PUT merges into it. */
function show(info: UpdateInfo) {
  const calls: { url: string; method?: string; body?: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body === undefined ? undefined : String(init.body);
      calls.push({ url, method: init?.method, body });
      if (init?.method === 'PUT' && body) Object.assign(info, JSON.parse(body));
      return new Response(JSON.stringify(info), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <UpdatesPanel />
      <Toasts />
    </QueryClientProvider>,
  );
  return { calls, client };
}

describe('UpdatesPanel', () => {
  it('explains how to start the updater, and offers nothing else', async () => {
    show({
      available: false,
      reason: "The updater isn't running. Run update.sh on the server once to start it.",
      enabled: false,
      intervalMinutes: 60,
      requested: false,
    });
    expect(await screen.findByText('sudo sh update.sh')).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('button', { name: /Check now/ })).toBeNull();
  });

  it('turns automatic updates on, checks now, and offers a reload after an update', async () => {
    const lastCheck = Math.floor(Date.now() / 1000) - 300;
    const info: UpdateInfo = {
      available: true,
      enabled: false,
      intervalMinutes: 60,
      requested: false,
      log: '✗ Download failed',
      status: { state: 'failed', lastCheck, lastUpdate: 0, deployed: OLD, latest: NEW, error: 'Download failed' },
    };
    const { calls, client } = show(info);
    expect(await screen.findByText('Download failed')).toBeTruthy();
    expect(screen.getByText(/A newer version is available/)).toBeTruthy();
    // The interval waits for automatic updates to be on.
    expect(screen.getByRole('radio', { name: 'Day' }).matches(':disabled')).toBe(true);
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Day' }).matches(':disabled')).toBe(false));
    fireEvent.click(screen.getByRole('radio', { name: 'Day' }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual(['{"enabled":true}', '{"intervalMinutes":1440}']),
    );

    fireEvent.click(screen.getByRole('button', { name: /Check now/ }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/settings/updates/check')).toBe(true));
    client.setQueryData<UpdateInfo>(['updates'], { ...info, requested: true });
    expect((await screen.findByRole('button', { name: /Checking…/ })).matches(':disabled')).toBe(true);

    client.setQueryData<UpdateInfo>(['updates'], {
      ...info,
      status: { state: 'idle', lastCheck, lastUpdate: lastCheck, deployed: NEW, latest: NEW },
    });
    expect(await screen.findByText(/Updated to/)).toBeTruthy();
    expect(screen.getByText(/Up to date/)).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Reload' })).toBeTruthy();
  });

  it('chooses the channel, and says what the last check found', async () => {
    const lastCheck = Math.floor(Date.now() / 1000) - 120;
    const info: UpdateInfo = {
      available: true,
      enabled: true,
      intervalMinutes: 15,
      channel: 'edge',
      requested: false,
      status: { state: 'idle', lastCheck, lastUpdate: 0, deployed: OLD, latest: NEW, channel: 'edge', outcome: 'waiting' },
    };
    const { calls, client } = show(info);
    expect(await screen.findByText(/is waiting for its checks on GitHub/)).toBeTruthy();
    expect(screen.getByText(/Latest on main/).textContent).toBe('Latest on main: bbbbbbb · Waiting for its checks');
    expect(screen.getByText(/Every change to the main branch/)).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: 'Stable' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual(['{"channel":"stable"}']));
    expect(await screen.findByText(/Releases only/)).toBeTruthy();

    client.setQueryData<UpdateInfo>(['updates'], {
      ...info,
      channel: 'stable',
      status: { state: 'idle', lastCheck, lastUpdate: 0, deployed: OLD, channel: 'stable', outcome: 'noRelease' },
    });
    expect(await screen.findByText('No release yet: Playarr stays on this version until the first one')).toBeTruthy();
    expect(screen.getByText('Latest release: none yet')).toBeTruthy();

    const error = "v0.7.0 (bbbbbbb) didn't start, so Playarr went back to aaaaaaa (rolled back)";
    client.setQueryData<UpdateInfo>(['updates'], {
      ...info,
      channel: 'stable',
      status: { state: 'failed', lastCheck, lastUpdate: 0, deployed: OLD, latest: NEW, channel: 'stable', release: 'v0.7.0', outcome: 'rolledBack', error },
    });
    expect((await screen.findByText(error)).className).toContain('text-danger');
    expect(screen.getByText(/Latest release/).textContent).toBe('Latest release: v0.7.0 · bbbbbbb · It didn’t start');
  });

  it('says when the running version was installed and when the newest came out', async () => {
    const now = Math.floor(Date.now() / 1000);
    show({
      available: true,
      enabled: true,
      intervalMinutes: 15,
      channel: 'stable',
      requested: false,
      status: {
        state: 'idle',
        lastCheck: now - 60,
        lastUpdate: 0,
        deployed: OLD,
        latest: NEW,
        channel: 'stable',
        release: 'v0.7.0',
        deployedAt: now - 2 * 3600,
        latestAt: now - 3 * 86_400,
      },
    });
    const installed = await screen.findByText(/^Installed/);
    expect(installed.textContent).toBe('Installed 2 hours ago');
    expect(installed.querySelector('time')?.getAttribute('dateTime')).toBe(new Date((now - 2 * 3600) * 1000).toISOString());
    expect(screen.getByText(/Latest release/).textContent).toBe('Latest release: v0.7.0 · bbbbbbb, 3 days ago · A newer version is available');
  });

  it('says nothing of dates it doesn’t know', async () => {
    const lastCheck = Math.floor(Date.now() / 1000) - 60;
    show({
      available: true,
      enabled: true,
      intervalMinutes: 15,
      channel: 'edge',
      requested: false,
      status: { state: 'idle', lastCheck, lastUpdate: 0, deployed: NEW, latest: NEW, channel: 'edge' },
    });
    expect((await screen.findByText(/Latest on main/)).textContent).toBe('Latest on main: bbbbbbb · Up to date');
    expect(screen.queryByText(/^Installed/)).toBeNull();
  });
});
