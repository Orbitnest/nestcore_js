import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  // ESM + CJS for bundlers/Node, plus an IIFE global build for <script> / CDN.
  format: ['esm', 'cjs', 'iife'],
  globalName: 'NestCore',
  // The CDN global used to be `OrbitNest`; keep it as a deprecated alias.
  footer: ({ format }) => (format === 'iife' ? { js: 'var OrbitNest=NestCore;' } : undefined),
  target: 'es2020',
  platform: 'browser',
  dts: true,
  clean: true,
  sourcemap: true,
  minify: true,
});
