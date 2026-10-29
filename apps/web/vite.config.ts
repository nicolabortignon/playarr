import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const server = process.env.PLAYARR_SERVER ?? 'http://localhost:4000';

export default defineConfig({
  define: {
    // Changes with every build: persisted data from an older build is discarded, not misread.
    __BUILD_ID__: JSON.stringify(Date.now().toString(36)),
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'Playarr',
        short_name: 'Playarr',
        description: 'Music player for your Lidarr library',
        theme_color: '#0f0e0c',
        background_color: '#0f0e0c',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      // Our own service worker (src/sw.ts): it plays kept songs from disk with byte-range support.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectManifest: { globPatterns: ['**/*.{js,css,html,svg,png,woff2}'] },
    }),
  ],
  server: {
    host: true, // reachable from phones on the LAN
    port: 5180,
    strictPort: true,
    proxy: {
      '/api': server,
      '/stream': server,
      '/art': server,
    },
  },
});
