import type { ReachabilityCheck, ServerInfo } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AwayFromHomePanel, HTTPS_GUIDE } from './AwayFromHomePanel';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SERVER: ServerInfo = { id: 'id', name: 'NAS', version: '0.7.0', minAppVersion: '1.0.0', setup: false, publicUrl: 'https://music.example.com' };

/** What the server says when its router doesn't loop back. */
const UNCONFIRMED: ReachabilityCheck = {
  verdict: 'unconfirmed',
  summary: 'This server couldn’t confirm it from inside your home: open https://music.example.com on a phone on mobile data to be sure.',
  publicUrl: 'https://music.example.com',
  checkedAt: '2026-11-07T18:30:00.000Z',
  steps: [
    { id: 'address', label: 'Public address', status: 'ok', detail: 'https://music.example.com' },
    { id: 'dns', label: 'Name lookup', status: 'ok', detail: 'music.example.com is 203.0.113.7.' },
    { id: 'connect', label: 'Connection', status: 'fail', detail: 'No answer from 203.0.113.7 on port 443 within 5 s.', fix: 'Many home routers don’t let a machine reach the home’s own public address from inside.' },
    { id: 'certificate', label: 'Certificate', status: 'skipped' },
    { id: 'playarr', label: 'This server answers', status: 'skipped' },
  ],
};

/** The panel against a fake server: GET /api/server answers `server`, the check `answer` (or fails with it). */
function show(server: ServerInfo, answer: ReachabilityCheck | { status: number; error: string }) {
  const calls: { url: string; method?: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method });
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (url === '/api/server') return json(server);
      if ('status' in answer) return json({ error: answer.error }, answer.status);
      return json(answer);
    }),
  );
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AwayFromHomePanel />
    </QueryClientProvider>,
  );
  return calls;
}

describe('AwayFromHomePanel', () => {
  it('checks the public address from the server and shows each step, with what to fix', async () => {
    const calls = show(SERVER, UNCONFIRMED);
    expect(await screen.findByText('https://music.example.com')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Not checked yet.');
    // Nothing is checked until asked: it's the server knocking on its own door.
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByText(UNCONFIRMED.summary)).toBeTruthy();
    // The verdict is the one line read out; the steps are there to read on.
    expect(screen.getByRole('status').textContent).toBe(UNCONFIRMED.summary);
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual(['/api/settings/reachability/check']);

    const steps = within(screen.getByRole('list', { name: 'Steps' })).getAllByRole('listitem');
    expect(steps.map((s) => s.querySelector('p')?.textContent)).toEqual([
      'Public address: passed',
      'Name lookup: passed',
      'Connection: failed',
      'Certificate: not checked',
      'This server answers: not checked',
    ]);
    expect(within(steps[2]!).getByText('No answer from 203.0.113.7 on port 443 within 5 s.')).toBeTruthy();
    expect(within(steps[2]!).getByText(/don’t let a machine reach the home’s own public address/)).toBeTruthy();
  });

  it('says when there’s no public address yet, and links to the guide', async () => {
    show({ ...SERVER, publicUrl: undefined }, { ...UNCONFIRMED, verdict: 'unreachable', summary: 'Phones away from home can’t reach this server yet.', publicUrl: undefined });
    expect(await screen.findByText('Not set yet')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Read the guide' }).getAttribute('href')).toBe(HTTPS_GUIDE);
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByText('Phones away from home can’t reach this server yet.')).toBeTruthy();
  });

  it('says why it couldn’t check', async () => {
    show(SERVER, { status: 403, error: 'Settings can only be changed from your home network' });
    fireEvent.click(await screen.findByRole('button', { name: 'Check now' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Couldn’t check: Settings can only be changed from your home network');
  });
});
