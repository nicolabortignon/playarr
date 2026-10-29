import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  // Keep `node:` prefixes: node:sqlite only exists under its prefixed name.
  removeNodeProtocol: false,
  // Bundle the workspace types package; keep real npm deps external.
  noExternal: ['@playarr/shared'],
});
