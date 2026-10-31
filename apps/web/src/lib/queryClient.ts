import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { QueryClient, type Query } from '@tanstack/react-query';
import type { PersistedClient, Persister, PersistQueryClientOptions } from '@tanstack/react-query-persist-client';
import { del, get, set } from 'idb-keyval';

const DAY = 24 * 60 * 60_000;
/**
 * Library data kept between visits: the app opens with it on screen and refreshes it in the background.
 * Not polled status (health, MusicBrainz queue, requests): those change every few seconds and are cheap
 * to fetch, and keeping them would rewrite the whole stored library each time.
 */
const KEPT = ['artists', 'artist', 'albums', 'album', 'favorites', 'playlists', 'playlist'];
/** Write the stored library at most this often: serialising it is heavy on phones. */
const PERSIST_EVERY_MS = 10_000;
const KEEP_FOR = 7 * DAY;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});
// Kept queries must stay in memory as long as in storage, or going unused would drop them from both.
for (const key of KEPT) queryClient.setQueryDefaults([key], { gcTime: KEEP_FOR });

const shouldKeep = (q: Query) =>
  q.state.status === 'success' && KEPT.includes(q.queryKey[0] as string) && q.queryKey[1] !== 'random'; // a fresh shuffle each visit

/**
 * Store the cache only when kept data actually changed. Any query update (a status poll, say) asks for a
 * save; without this check every one of them would serialise and write the whole library again.
 */
export function onlyWhenChanged(persister: Persister): Persister {
  let last = '';
  return {
    ...persister,
    persistClient: (client: PersistedClient) => {
      const signature = client.clientState.queries.map((q) => `${q.queryHash}:${q.state.dataUpdatedAt}`).join('|');
      if (signature === last) return;
      last = signature;
      return persister.persistClient(client);
    },
  };
}

/** How the cache is kept in IndexedDB between visits; undefined where there's no IndexedDB. */
export const persistOptions: Omit<PersistQueryClientOptions, 'queryClient'> | undefined =
  typeof indexedDB === 'undefined'
    ? undefined
    : {
        persister: onlyWhenChanged(
          createAsyncStoragePersister({
            storage: { getItem: get, setItem: set, removeItem: del },
            key: 'playarr.queries',
            throttleTime: PERSIST_EVERY_MS,
          }),
        ),
        maxAge: KEEP_FOR,
        buster: __BUILD_ID__,
        dehydrateOptions: { shouldDehydrateQuery: shouldKeep },
      };
