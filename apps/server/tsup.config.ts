import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

/** The repository's version (raised by every commit), built into the server for GET /api/server and Bonjour. */
const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  // The analysis workers are their own files next to index.js (see analysis/dspThread.ts, beatModelThread.ts);
  // cli.js is the server host's own commands (reset-password).
  entry: { index: 'src/index.ts', cli: 'src/cli.ts', dspWorker: 'src/analysis/dspWorker.ts', beatModelWorker: 'src/analysis/beatModelWorker.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  // Keep `node:` prefixes: node:sqlite only exists under its prefixed name.
  removeNodeProtocol: false,
  // Bundle the workspace packages (shipped as TypeScript source); keep real npm deps external.
  noExternal: ['@playarr/shared', '@playarr/mix'],
  define: { __APP_VERSION__: JSON.stringify(version) },
});
