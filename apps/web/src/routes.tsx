import type { RouteObject } from 'react-router';
import { AppShell } from './components/AppShell';
import { AlbumPage } from './pages/Album';
import { AlbumsPage } from './pages/Albums';
import { ArtistPage } from './pages/Artist';
import { ArtistsPage } from './pages/Artists';
import { DiscoverArtistPage } from './pages/DiscoverArtist';
import { FavoritesPage } from './pages/Favorites';
import { HomePage } from './pages/Home';
import { NotFoundPage } from './pages/NotFound';
import { QueuePage } from './pages/Queue';
import { RequestsPage } from './pages/Requests';
import { SearchPage } from './pages/Search';

export const routes: RouteObject[] = [
  {
    element: <AppShell />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'search', element: <SearchPage /> },
      { path: 'artists', element: <ArtistsPage /> },
      { path: 'artists/:id', element: <ArtistPage /> },
      { path: 'albums', element: <AlbumsPage /> },
      { path: 'albums/:id', element: <AlbumPage /> },
      { path: 'favorites', element: <FavoritesPage /> },
      { path: 'queue', element: <QueuePage /> },
      { path: 'requests', element: <RequestsPage /> },
      { path: 'discover/artists/:mbid', element: <DiscoverArtistPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
