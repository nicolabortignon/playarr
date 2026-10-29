import '@fontsource/gloock/400.css';
import '@fontsource-variable/schibsted-grotesk/wght.css';
import '@fontsource/dm-mono/400.css';
import '@fontsource/dm-mono/500.css';
import './index.css';

import { QueryClientProvider } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { persistOptions, queryClient } from './lib/queryClient';
import { routes } from './routes';

const router = createBrowserRouter(routes);

const app = <RouterProvider router={router} />;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {persistOptions ? (
      <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
        {app}
      </PersistQueryClientProvider>
    ) : (
      <QueryClientProvider client={queryClient}>{app}</QueryClientProvider>
    )}
  </StrictMode>,
);
