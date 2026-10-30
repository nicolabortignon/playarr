import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const server = process.env.PLAYARR_SERVER ?? 'http://localhost:4000';

const repo = new URL('../../', import.meta.url);
/** The app's version: the root package.json's, raised by every commit (.githooks/pre-commit). */
const version = (JSON.parse(readFileSync(new URL('package.json', repo), 'utf8')) as { version?: string }).version ?? '0.0.0';
/** The commit being built: REVISION (written by docker/update.sh into downloaded source), else git. */
function revision(): string {
  const file = new URL('REVISION', repo);
  if (existsSync(file)) return readFileSync(file, 'utf8').trim().slice(0, 7);
  try {
    return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

export default defineConfig({
  define: {
    // Changes with every build: persisted data from an older build is discarded, not misread.
    __BUILD_ID__: JSON.stringify(Date.now().toString(36)),
    __APP_VERSION__: JSON.stringify(version),
    __APP_REVISION__: JSON.stringify(revision()),
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
