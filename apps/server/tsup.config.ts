import { defineConfig } from 'tsup';

export default defineConfig({
  // The analysis workers are their own files next to index.js (see analysis/dspThread.ts, beatModelThread.ts).
  entry: { index: 'src/index.ts', dspWorker: 'src/analysis/dspWorker.ts', beatModelWorker: 'src/analysis/beatModelWorker.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  // Keep `node:` prefixes: node:sqlite only exists under its prefixed name.
  removeNodeProtocol: false,
  // Bundle the workspace packages (shipped as TypeScript source); keep real npm deps external.
  noExternal: ['@playarr/shared', '@playarr/mix'],
});
