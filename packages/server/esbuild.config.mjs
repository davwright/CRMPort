import { build } from 'esbuild';
import { rmSync, mkdirSync } from 'fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });

await build({
  entryPoints: ['src/main.ts', 'src/server.ts', 'src/plugin-worker.ts'],
  bundle: true,
  minify: true,
  sourcemap: true,
  platform: 'node',
  target: 'node20',
  outdir: 'dist',
  format: 'cjs',
  // systray2 ships a native .exe — can't be bundled
  // chokidar uses fsevents (optional native) — keep external for safety
  external: ['systray2', 'fsevents'],
  logLevel: 'info',
});
