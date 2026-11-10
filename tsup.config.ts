import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { server: 'src/talk_to_figma_mcp/server.ts', socket: 'src/socket.ts' },
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  outDir: 'dist',
  target: 'node18',
  sourcemap: true,
  minify: false,
  splitting: false,
  bundle: true,
  // The relay runs under Bun only — leave its runtime import untouched
  external: ['bun'],
});