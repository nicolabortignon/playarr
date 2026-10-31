import type { RouteObject } from 'react-router';
import { AppShell } from './components/AppShell';
import { AlbumPage } from './pages/Album';
import { AlbumsPage } from './pages/Albums';
import { ArtistPage } from './pages/Artist';
import { ArtistsPage } from './pages/Artists';
import { FavoritesPage } from './pages/Favorites';
import { HomePage } from './pages/Home';
import { LibraryPage } from './pages/Library';
import { PlaylistsPage } from './pages/Playlists';

/*
 * The pages used every day load with the app. The rest (search, a playlist with its cover editor, the queue,
 * requests, discovery, settings) are fetched the first time they're opened, so phones download and parse
 * less before anything shows. The service worker keeps those files cached, so later opens are instant.
 */
export const routes: RouteObject[] = [
  {
    element: <AppShell />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'search', lazy: () => import('./pages/Search').then((m) => ({ Component: m.SearchPage })) },
      { path: 'artists', element: <ArtistsPage /> },
      { path: 'artists/:id', element: <ArtistPage /> },
      { path: 'albums', element: <AlbumsPage /> },
      { path: 'albums/:id', element: <AlbumPage /> },
      { path: 'favorites', element: <FavoritesPage /> },
      { path: 'library', element: <LibraryPage /> },
      { path: 'playlists', element: <PlaylistsPage /> },
      { path: 'playlists/:id', lazy: () => import('./pages/Playlist').then((m) => ({ Component: m.PlaylistPage })) },
      { path: 'queue', lazy: () => import('./pages/Queue').then((m) => ({ Component: m.QueuePage })) },
      { path: 'requests', lazy: () => import('./pages/Requests').then((m) => ({ Component: m.RequestsPage })) },
      { path: 'discover/artists/:mbid', lazy: () => import('./pages/DiscoverArtist').then((m) => ({ Component: m.DiscoverArtistPage })) },
      { path: 'discover/artist', lazy: () => import('./pages/FindArtist').then((m) => ({ Component: m.FindArtistPage })) },
      { path: 'settings/:panel?', lazy: () => import('./pages/Settings').then((m) => ({ Component: m.SettingsPage })) },
      { path: '*', lazy: () => import('./pages/NotFound').then((m) => ({ Component: m.NotFoundPage })) },
    ],
  },
];
