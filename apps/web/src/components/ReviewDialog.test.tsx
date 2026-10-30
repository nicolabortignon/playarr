import type { ReviewCandidate, ReviewGroup } from '@playarr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import { ReviewDialog } from './ReviewDialog';

// happy-dom's Animation.cancel() throws where browsers reject a promise; make motion use JS animations.
Reflect.deleteProperty(Element.prototype, 'animate');

const candidate = (releaseId: string, title: string, extra: Partial<ReviewCandidate> = {}): ReviewCandidate => ({
  releaseId,
  releaseGroupId: `rg-${releaseId}`,
  title,
  artistName: 'Massive Attack',
  year: 1998,
  score: 0.7,
  tracks: [{ disc: 1, position: 1, title: 'Angel', duration: 379 }],
  matches: { 'a.flac': 0 },
  detailed: true,
  ...extra,
});

const group = (key: string, album: string, candidates: ReviewCandidate[]): ReviewGroup => ({
  groupKey: key,
  artistName: 'Massive Attack',
  albumTitle: album,
  files: [{ rel: 'a.flac', title: 'Angel', trackNumber: 1, discNumber: 1, duration: 380 }],
  candidates,
});

let groups: ReviewGroup[];
let client: QueryClient;

beforeEach(() => {
  groups = [
    group('g1', 'Mezzanine', [candidate('r1', 'Mezzanine'), candidate('r2', 'Mezzanine', { disambiguation: 'deluxe', country: 'GB' })]),
    group('g2', 'Protection', [candidate('r3', 'Protection')]),
  ];
  vi.spyOn(api, 'review').mockImplementation(async () => structuredClone(groups));
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const renderDialog = () =>
  render(
    <QueryClientProvider client={client}>
      <ReviewDialog sourceId={1} onClose={() => {}} />
    </QueryClientProvider>,
  );

describe('ReviewDialog', () => {
  it('keeps the chosen album when the list refreshes in the background', async () => {
    renderDialog();
    const deluxe = await screen.findByRole('radio', { name: /deluxe/ });
    fireEvent.click(deluxe);
    expect(deluxe.getAttribute('aria-checked')).toBe('true');
    await act(() => client.refetchQueries({ queryKey: ['review', 1] }));
    expect(screen.getByRole('radio', { name: /deluxe/ }).getAttribute('aria-checked')).toBe('true');
  });

  it('moves to the next album at once and says when the choice is saved', async () => {
    let finish: () => void = () => {};
    vi.spyOn(api, 'reviewAction').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            groups = groups.slice(1);
            resolve();
          };
        }),
    );
    renderDialog();
    fireEvent.click(await screen.findByRole('button', { name: /use this album/i }));
    // The next album is there before the server has answered.
    expect(await screen.findByText('Protection', { selector: 'div' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/Saving: Mezzanine/);
    await act(async () => finish());
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/Saved: Mezzanine/));
  });

  it('puts the album back and explains when saving fails', async () => {
    vi.spyOn(api, 'reviewAction').mockRejectedValue(new Error('MusicBrainz is down'));
    renderDialog();
    fireEvent.click(await screen.findByRole('button', { name: /use this album/i }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/Couldn’t save Mezzanine.*MusicBrainz is down/));
    expect(screen.getByText('Mezzanine', { selector: 'div' })).toBeTruthy();
  });

  it('shows a search in progress and keeps the buttons from being pressed twice', async () => {
    let finish: () => void = () => {};
    vi.spyOn(api, 'reviewAction').mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
    renderDialog();
    fireEvent.submit((await screen.findByRole('button', { name: /^search$/i })).closest('form')!);
    expect(await screen.findByRole('button', { name: /searching/i })).toHaveProperty('disabled', true);
    expect((screen.getByRole('button', { name: /use this album/i }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish());
    await waitFor(() => expect(screen.getByRole('button', { name: /^search$/i })).toBeTruthy());
  });

  it('shows placeholders while an edition’s details are still coming', async () => {
    groups = [group('g1', 'Mezzanine', [candidate('r1', 'Mezzanine', { detailed: false })])];
    renderDialog();
    expect(await screen.findByText(/Getting this edition’s details/)).toBeTruthy();
  });
});
