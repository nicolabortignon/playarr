import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'happy-dom',
      environmentOptions: {
        // Relative /api, /art and /stream URLs resolve against the real Playarr server.
        happyDOM: { url: process.env.PLAYARR_SERVER ?? 'http://localhost:4000' },
      },
      testTimeout: 20_000,
    },
  }),
);
