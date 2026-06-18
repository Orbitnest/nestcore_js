import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  // ESM + CJS for bundlers/Node, plus an IIFE global build for <script> / CDN.
  format: ['esm', 'cjs', 'iife'],
  globalName: 'OrbitNest',
  target: 'es2020',
  platform: 'browser',
  dts: true,
  clean: true,
  sourcemap: true,
  minify: true,
});
