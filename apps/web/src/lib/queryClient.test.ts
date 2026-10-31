import type { PersistedClient, Persister } from '@tanstack/react-query-persist-client';
import { describe, expect, it, vi } from 'vitest';
import { onlyWhenChanged } from './queryClient';

const client = (queries: [string, number][]): PersistedClient =>
  ({
    timestamp: Date.now(),
    buster: 'b',
    clientState: { mutations: [], queries: queries.map(([hash, at]) => ({ queryHash: hash, queryKey: [hash], state: { dataUpdatedAt: at } })) },
  }) as unknown as PersistedClient;

describe('onlyWhenChanged', () => {
  it('stores the cache only when kept data changed, not on every query update', async () => {
    const persistClient = vi.fn(async () => {});
    const persister = onlyWhenChanged({ persistClient, restoreClient: async () => undefined, removeClient: async () => {} } as Persister);
    await persister.persistClient(client([['albums', 1], ['album-70', 1]]));
    // A status poll elsewhere asks for a save, but nothing kept changed.
    await persister.persistClient(client([['albums', 1], ['album-70', 1]]));
    expect(persistClient).toHaveBeenCalledTimes(1);
    // An album was refetched: store again.
    await persister.persistClient(client([['albums', 1], ['album-70', 2]]));
    // A new album page was visited: store again.
    await persister.persistClient(client([['albums', 1], ['album-70', 2], ['album-71', 2]]));
    expect(persistClient).toHaveBeenCalledTimes(3);
  });
});
