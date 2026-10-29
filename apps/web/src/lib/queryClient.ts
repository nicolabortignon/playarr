import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { QueryClient, type Query } from '@tanstack/react-query';
import type { PersistQueryClientOptions } from '@tanstack/react-query-persist-client';
import { del, get, set } from 'idb-keyval';

const DAY = 24 * 60 * 60_000;
/** Library data kept between visits: the app opens with it on screen and refreshes it in the background. */
const KEPT = ['health', 'artists', 'artist', 'albums', 'album', 'favorites', 'playlists', 'playlist'];
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

/** How the cache is kept in IndexedDB between visits; undefined where there's no IndexedDB. */
export const persistOptions: Omit<PersistQueryClientOptions, 'queryClient'> | undefined =
  typeof indexedDB === 'undefined'
    ? undefined
    : {
        persister: createAsyncStoragePersister({ storage: { getItem: get, setItem: set, removeItem: del }, key: 'playarr.queries' }),
        maxAge: KEEP_FOR,
        buster: __BUILD_ID__,
        dehydrateOptions: { shouldDehydrateQuery: shouldKeep },
      };
